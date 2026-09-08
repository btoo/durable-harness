import { compareContext } from "./context.js";
import { z } from "zod";
import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import {
  Learning,
  LearningPipeline,
  RunBudgets,
  invariant,
  asFault,
  type CandidateContext,
} from "@durable-harness/core";
import { durableStore, workersAICandidateGenerator, modelData } from "@durable-harness/cloudflare";
import { initialPreferences, preferencesTarget } from "../demo/worker/domain.js";

interface Env {
  BENCHMARKS: DurableObjectNamespace;
  LOADER: WorkerLoader;
  AI: Ai;
  MODEL_ID: string;
  ADMIN_TOKEN: string;
}
const owner = { id: "benchmark", deploymentId: "benchmark", roles: ["developer"] as "developer"[] };
const scope = "synthetic-evaluation";
type Preferences = typeof initialPreferences;
function benchmarkTarget() {
  const target = preferencesTarget();
  return {
    ...target,
    cases: [
      ...target.cases,
      {
        id: "adapt-freight",
        family: "independent-adaptation-quote",
        split: "adaptation" as const,
        input: {
          offers: [
            { supplier: "Harbor Parts", unitPrice: 17, quantity: 10, freight: 0, leadDays: 3 },
            {
              supplier: "Meadow Components",
              unitPrice: 12,
              quantity: 10,
              freight: 100,
              leadDays: 3,
            },
          ],
        },
        expected: "Harbor Parts",
      },
      {
        id: "adapt-calendar",
        family: "independent-adaptation-calendar",
        split: "adaptation" as const,
        input: { date: "2026-09-03T10:00:00Z" },
        expected: "2026-09-07",
      },
    ],
  };
}

export class BenchmarkRun extends DurableObject<Env> {
  private readonly records = durableStore(this.ctx);
  private readonly files = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "baseline",
    name: () => this.ctx.id.toString(),
  });
  private readonly executor = new DynamicWorkerExecutor({
    loader: this.env.LOADER,
    globalOutbound: null,
    timeout: 1000,
  });
  private readonly learning = new Learning(this.records, [benchmarkTarget()]);
  private readonly budgets = new RunBudgets(this.records);
  private readonly generator = workersAICandidateGenerator(this.env.AI, this.env.MODEL_ID, {
    version: "comparison-v2",
    candidateSchema: z
      .object({
        includeFreight: z.boolean(),
        businessDaysOnly: z.boolean(),
        approvalRequired: z.literal(true),
      })
      .strict(),
    instructions:
      "Apply only the two customer corrections. Preserve approvalRequired true and all unrelated configuration.",
  });
  private readonly pipeline = new LearningPipeline(this.records, this.learning, this.generator);
  private initialize() {
    if (this.records.get("metadata", "initialized")) return;
    this.records.put("spaces", scope, {
      id: scope,
      deploymentId: "benchmark",
      kind: "tenant",
      label: "Synthetic benchmark",
      revision: 1,
      grants: [{ principalId: owner.id, permissions: ["read", "write", "execute", "publish"] }],
    });
    this.learning.initialize(owner, scope, "procurement-preferences", initialPreferences);
    for (const [id, text, corrected] of [
      ["freight-correction", "Include freight in quote comparison.", { includeFreight: true }],
      [
        "calendar-correction",
        "Move weekend follow-ups to the next business day.",
        { businessDaysOnly: true },
      ],
    ] as const)
      this.learning.feedback(owner, {
        id,
        workspaceId: scope,
        agent: "procurement",
        kind: "correction",
        text,
        corrected,
        sourceRunId: "synthetic",
        lineage: [],
      });
    this.records.put("metadata", "initialized", true);
  }
  async fetch(request: Request): Promise<Response> {
    try {
      this.initialize();
      const input = (await request.json()) as {
        action: string;
        candidate?: Preferences;
        caseIds?: string[];
        strategy?: "extractive" | "generic-summary" | "recent-window";
      };
      if (input.action === "context")
        return Response.json(
          await compareContext(
            this.records,
            this.env.AI,
            this.env.MODEL_ID,
            owner,
            scope,
            input.strategy ?? "extractive",
          ),
        );
      if (input.action === "metadata")
        return Response.json({
          model: this.env.MODEL_ID,
          seed: initialPreferences,
          caseIds: benchmarkTarget()
            .cases.filter((value) => value.split === "validation")
            .map((value) => value.id),
          adaptationIds: benchmarkTarget()
            .cases.filter((value) => value.split === "adaptation")
            .map((value) => value.id),
          limits: { steps: 8, tokens: 48000, activeMs: 120000, descendants: 12 },
        });
      if (input.action === "evaluate") {
        preferencesTarget().validate(input.candidate, initialPreferences);
        const start = Date.now();
        // Stock Codemode + Shell performs the baseline persistence and readback.
        const result = await this.executor.execute(
          `async()=>{await state.writeJson("/preferences.json",${JSON.stringify(input.candidate)});return await state.readJson("/preferences.json");}`,
          [resolveProvider(stateTools(this.files))],
        );
        invariant(!result.error, "INVALID_CELL", result.error ?? "Filesystem baseline failed.");
        const cases = benchmarkTarget().cases.filter(
          (value) =>
            value.split !== "heldout" &&
            (input.caseIds ? input.caseIds.includes(value.id) : value.split === "validation"),
        );
        invariant(cases.length > 0, "INVALID_INPUT", "Choose registered validation cases.");
        const scores = [];
        for (const testCase of cases)
          scores.push(
            await preferencesTarget().evaluator.evaluate({
              configuration: result.result,
              testCase,
            }),
          );
        return Response.json({ scores, filesystemMs: Date.now() - start });
      }
      if (input.action === "propose") {
        preferencesTarget().validate(input.candidate, initialPreferences);
        const rootId = "gepa-reflection";
        this.budgets.start(rootId);
        this.budgets.resume(rootId);
        const attempt = (this.records.get<number>("metadata", "gepa-attempts") ?? 0) + 1;
        invariant(
          attempt <= 3,
          "BUDGET_EXCEEDED",
          "The comparison permits at most three reflection attempts.",
        );
        const context: CandidateContext = {
          workspaceId: scope,
          target: "procurement-preferences",
          baseRevision: 1,
          baseline: input.candidate,
          evidence: this.learning.listFeedback(owner, scope),
          adaptationCases: benchmarkTarget().cases.filter((value) => value.split === "adaptation"),
          previousEvaluations: [],
        };
        const reservation = this.generator.reserveTokens(context);
        const id = `reflection:${attempt}`;
        this.budgets.reserve(rootId, id, reservation);
        this.records.put("metadata", "gepa-attempts", attempt);
        const generated = await this.generator.generate(context, {
          id,
          reservedTokens: reservation,
          signal: AbortSignal.timeout(Math.max(1, this.budgets.remainingActiveMs(rootId))),
        });
        if (generated.usedTokens !== undefined)
          this.budgets.settle(rootId, id, generated.usedTokens);
        this.budgets.pause(rootId);
        return Response.json(
          modelData({ candidate: generated.candidate, usage: this.budgets.read(rootId) }),
        );
      }
      if (input.action === "harness") {
        const run = this.pipeline.start(owner, {
          id: "harness-learning",
          workspaceId: scope,
          target: "procurement-preferences",
          evidenceIds: ["calendar-correction", "freight-correction"],
        });
        const completed = await this.pipeline.advance(owner, run.id);
        return Response.json(
          modelData({
            run: completed,
            candidate: this.learning.configuration(owner, scope, "procurement-preferences")!.value,
            usage: this.budgets.read(run.rootId),
          }),
        );
      }
      if (input.action === "heldout") {
        preferencesTarget().validate(input.candidate, initialPreferences);
        const scores = [];
        for (const testCase of preferencesTarget().cases.filter(
          (value) => value.split === "heldout",
        ))
          scores.push(
            await preferencesTarget().evaluator.evaluate({
              configuration: input.candidate,
              testCase,
            }),
          );
        return Response.json({
          cases: scores.length,
          passed: scores.filter((value) => value.passed).length,
        });
      }
      return Response.json({ error: "Unknown benchmark action" }, { status: 400 });
    } catch (error) {
      return Response.json({ error: asFault(error).toJSON() }, { status: 400 });
    }
  }
}
export default {
  async fetch(request: Request, env: Env) {
    if (!env.ADMIN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`)
      return new Response("Forbidden", { status: 403 });
    const id = new URL(request.url).pathname.slice(1);
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id))
      return new Response("Choose a benchmark identity", { status: 400 });
    return env.BENCHMARKS.getByName(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
