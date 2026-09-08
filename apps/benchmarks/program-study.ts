import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import {
  Learning,
  LearningPipeline,
  RunBudgets,
  asFault,
  contentHash,
  invariant,
  type CaseScore,
  type EvaluationCase,
  type Principal,
  type RecordStore,
} from "@durable-harness/core";
import {
  canonicalWorkersAI,
  workersAICandidateGenerator,
  modelCodeEditGenerator,
} from "@durable-harness/cloudflare";
import { corrections, procurementCases, seedTool, toolContract } from "./procurement-cases.js";

const candidateSchema = z.object({ source: z.string().min(1).max(16000) }).strict();
export type ProgramCandidate = z.infer<typeof candidateSchema>;
export const studyOwner: Principal = {
  id: "benchmark",
  deploymentId: "benchmark",
  roles: ["developer"],
};
export const studySpace = "program-study";

/** Candidate code sees its input only. Evaluators and held-out answers stay in the host. */
export async function evaluateProgram(
  executor: DynamicWorkerExecutor,
  candidate: ProgramCandidate,
  testCase: EvaluationCase,
): Promise<CaseScore & { actual?: unknown }> {
  const started = Date.now();
  try {
    const result = await executor.execute(
      `async()=>{
      const input = ${JSON.stringify(testCase.input)};
      const before = JSON.stringify(input);
      const run = async (input) => { ${candidate.source}\n return await rankOffers(input); };
      const actual = await run(input);
      return {actual, unchanged: JSON.stringify(input) === before};
    }`,
      [],
    );
    if (result.error) throw new Error(result.error);
    const output = result.result as { actual?: unknown; unchanged?: boolean };
    const actual = output.actual as Record<string, unknown> | undefined;
    const expected = testCase.expected as Record<string, unknown>;
    const passed =
      output.unchanged === true &&
      !!actual &&
      actual.supplier === expected.supplier &&
      actual.totalUsd === expected.totalUsd &&
      actual.approvalRequired === true;
    return {
      caseId: testCase.id,
      passed,
      score: Number(passed),
      actual: output.actual,
      explanation: JSON.stringify({
        input: testCase.input,
        expected,
        actual: output.actual,
        inputUnchanged: output.unchanged,
      }),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      caseId: testCase.id,
      passed: false,
      score: 0,
      explanation: JSON.stringify({
        input: testCase.input,
        expected: testCase.expected,
        error: asFault(error).message,
      }),
      durationMs: Date.now() - started,
    };
  }
}

export class ProgramStudy {
  private readonly executor: DynamicWorkerExecutor;
  private readonly budgets: RunBudgets;
  constructor(
    private readonly store: RecordStore,
    private readonly env: { LOADER: WorkerLoader; AI: Ai; MODEL_ID: string },
  ) {
    this.executor = new DynamicWorkerExecutor({
      loader: env.LOADER,
      globalOutbound: null,
      timeout: 1000,
    });
    this.budgets = new RunBudgets(store);
    if (!store.get("spaces", studySpace))
      store.put("spaces", studySpace, {
        id: studySpace,
        deploymentId: "benchmark",
        kind: "tenant",
        label: "Synthetic procurement study",
        revision: 1,
        grants: [
          { principalId: studyOwner.id, permissions: ["read", "write", "execute", "publish"] },
        ],
      });
  }
  private learning(stage: 1 | 2) {
    return new Learning(this.store, [
      {
        name: "quote-tool",
        kind: "capability",
        validate: (candidate) => {
          candidateSchema.parse(candidate);
        },
        cases: procurementCases(stage),
        evaluator: {
          id: `quote-tool-v1-stage-${stage}`,
          evaluate: ({ configuration, testCase }) =>
            evaluateProgram(this.executor, candidateSchema.parse(configuration), testCase),
        },
      },
    ]);
  }
  private pipeline(learning: Learning, stage: 1 | 2, edits = false) {
    if (edits)
      return new LearningPipeline(this.store, learning, {
        ...modelCodeEditGenerator(
          () => createWorkersAI({ binding: canonicalWorkersAI(this.env.AI) })(this.env.MODEL_ID),
          { id: "source-edits-v1", instructions: toolContract(stage) },
        ),
        maxCandidates: 1,
      });
    const generator = workersAICandidateGenerator(this.env.AI, this.env.MODEL_ID, {
      version: `program-study-v1-stage-${stage}`,
      candidateSchema,
      instructions: toolContract(stage),
    });
    return new LearningPipeline(this.store, learning, generator);
  }
  async handle(input: {
    action: string;
    stage?: 1 | 2;
    candidate?: unknown;
    caseIds?: string[];
    prompt?: unknown;
    requestId?: string;
    reviewed?: boolean;
  }) {
    const stage = z.union([z.literal(1), z.literal(2)]).parse(input.stage ?? 1);
    const sealed = this.store.get<unknown>("program-study", "sealed");
    if (input.action === "program-status")
      return {
        run: this.store.get("learning_runs", `harness-program-${stage}`),
        harnessUsage: this.store.get("root_runs", `harness-program-${stage}`),
        gepaUsage: this.store.get("root_runs", `gepa-program-${stage}`),
        sealed: !!sealed,
      };
    if (input.action === "program-metadata")
      return {
        model: this.env.MODEL_ID,
        contract: toolContract(stage),
        corrections: corrections[stage],
        seed: { source: seedTool },
        cases: procurementCases(stage).filter((c) => c.split !== "heldout"),
        limits: { candidates: 3, tokens: 48000, activeMs: 120000, maxOutputTokens: 8192 },
      };
    if (input.action === "program-evaluate") {
      invariant(
        !sealed,
        "INVALID_INPUT",
        "This study has been sealed; start a new identity for another experiment.",
      );
      const candidate = candidateSchema.parse(input.candidate);
      const cases = procurementCases(stage).filter(
        (c) => c.split !== "heldout" && (input.caseIds?.includes(c.id) ?? c.split === "validation"),
      );
      invariant(
        cases.length > 0 && (!input.caseIds || cases.length === new Set(input.caseIds).size),
        "INVALID_INPUT",
        "Choose only registered adaptation or validation cases.",
      );
      const scores = [];
      for (const testCase of cases)
        scores.push(await evaluateProgram(this.executor, candidate, testCase));
      return { scores };
    }
    if (input.action === "program-reflect") {
      invariant(!sealed, "INVALID_INPUT", "Held-out assessment has already sealed this study.");
      const rootId = `gepa-program-${stage}`;
      const requestId = z.string().min(1).max(100).parse(input.requestId);
      const key = `${rootId}:${requestId}`;
      const prompt = typeof input.prompt === "string" ? input.prompt : JSON.stringify(input.prompt);
      invariant(
        prompt && prompt.length <= 40000,
        "INVALID_INPUT",
        "Reflection requires a bounded prompt.",
      );
      const requestHash = await contentHash(prompt);
      const previous = this.store.get<{ hash: string; result?: unknown }>(
        "program-reflections",
        key,
      );
      if (previous) {
        invariant(
          previous.hash === requestHash,
          "REPLAY_DIVERGENCE",
          "The reflection request changed during replay.",
        );
        invariant(
          previous.result,
          "EFFECT_UNCERTAIN",
          "This model request was interrupted; its reserved usage remains unresolved.",
        );
        return previous.result;
      }
      this.budgets.start(rootId, { steps: 3, tokens: 48000, activeMs: 120000, descendants: 1 });
      this.budgets.resume(rootId);
      const instructions = `${toolContract(stage)}\nCustomer corrections: ${JSON.stringify(corrections[stage])}\nFollow the requested GEPA output format exactly. Only modify the proposed source code.`;
      this.budgets.reserve(
        rootId,
        key,
        new TextEncoder().encode(instructions + prompt).byteLength + 8192,
      );
      this.store.put("program-reflections", key, { hash: requestHash });
      try {
        const response = await generateText({
          model: createWorkersAI({ binding: canonicalWorkersAI(this.env.AI) })(this.env.MODEL_ID),
          instructions,
          prompt,
          maxOutputTokens: 8192,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(Math.max(1, this.budgets.remainingActiveMs(rootId))),
        });
        if (response.usage.totalTokens !== undefined)
          this.budgets.settle(rootId, key, response.usage.totalTokens);
        this.budgets.pause(rootId);
        const result = {
          text: response.text,
          finishReason: response.finishReason,
          usage: this.budgets.read(rootId),
        };
        this.store.put("program-reflections", key, { hash: requestHash, result });
        return result;
      } finally {
        this.budgets.pause(rootId);
      }
    }
    if (input.action === "program-harness" || input.action === "program-edit") {
      invariant(!sealed, "INVALID_INPUT", "Held-out assessment has already sealed this study.");
      const learning = this.learning(stage);
      const edits = input.action === "program-edit";
      invariant(
        !edits || stage === 2,
        "INVALID_INPUT",
        "The bounded edit follow-up targets stage two.",
      );
      learning.initialize(
        studyOwner,
        studySpace,
        "quote-tool",
        edits ? candidateSchema.parse(input.candidate) : { source: seedTool },
      );
      for (const [index, text] of corrections[stage].entries())
        learning.feedback(studyOwner, {
          id: `stage-${stage}-${index}`,
          workspaceId: studySpace,
          agent: "quote-manager",
          kind: "correction",
          text,
          sourceRunId: `synthetic-stage-${stage}`,
          lineage: [],
        });
      const pipeline = this.pipeline(learning, stage, edits);
      if (edits)
        this.budgets.start("edit-supplement", {
          steps: 1,
          tokens: 24000,
          activeMs: 120000,
          descendants: 1,
        });
      const run = pipeline.start(studyOwner, {
        id: `harness-program-${stage}`,
        workspaceId: studySpace,
        target: "quote-tool",
        evidenceIds: corrections[stage].map((_, index) => `stage-${stage}-${index}`),
        ...(edits ? { rootId: "edit-supplement" } : {}),
      });
      let completed = run;
      try {
        completed = await pipeline.advance(studyOwner, run.id);
      } catch {
        completed = pipeline.read(studyOwner, run.id);
      }
      if (edits) this.budgets.pause(run.rootId);
      const proposal = completed.currentProposalId
        ? learning.read(studyOwner, completed.currentProposalId)
        : undefined;
      return {
        run: completed,
        candidate:
          proposal?.candidate ??
          learning.configuration(studyOwner, studySpace, "quote-tool")!.value,
        usage: this.budgets.read(run.rootId),
        reports: completed.proposalIds.map((id) => learning.report(studyOwner, id)),
      };
    }
    if (input.action === "program-review") {
      invariant(
        !sealed && input.reviewed === true,
        "APPROVAL_REQUIRED",
        "Explicit synthetic reviewer approval is required for executable changes.",
      );
      const learning = this.learning(stage);
      const run = this.store.get<{
        currentProposalId?: string;
        rootId: string;
        generatorId: string;
      }>("learning_runs", `harness-program-${stage}`);
      invariant(run?.currentProposalId, "NOT_FOUND", "No candidate awaits review.");
      const version = await learning.promote(studyOwner, run.currentProposalId, true);
      const edits = run.generatorId === "source-edits-v1";
      if (edits) this.budgets.resume(run.rootId);
      await this.pipeline(learning, stage, edits).advance(studyOwner, `harness-program-${stage}`);
      if (edits) this.budgets.complete(run.rootId);
      return {
        candidate: version.value,
        review: "synthetic automated reviewer; human effort not measured",
        revision: version.revision,
      };
    }
    if (input.action === "program-seal") {
      const candidate = candidateSchema.parse(input.candidate);
      const hash = await contentHash(JSON.stringify(candidate));
      if (sealed) {
        const previous = sealed as { hash: string; result?: unknown };
        invariant(previous.hash === hash, "STALE_REVISION", "The assessed candidate is immutable.");
        if (previous.result) return previous.result;
      }
      this.store.put("program-study", "sealed", { hash });
      const scores = [];
      for (const testCase of procurementCases(2).filter((c) => c.split === "heldout"))
        scores.push(await evaluateProgram(this.executor, candidate, testCase));
      const result = {
        hash,
        cases: scores.length,
        passed: scores.filter((s) => s.passed).length,
        failedCaseIds: scores.filter((s) => !s.passed).map((s) => s.caseId),
      };
      this.store.put("program-study", "sealed", { hash, result });
      return result;
    }
    throw new Error("Unknown program-study action");
  }
}
