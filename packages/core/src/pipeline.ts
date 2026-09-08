import { RunBudgets } from "./budget.js";
import { asFault, invariant } from "./errors.js";
import {
  Learning,
  type ChangeProposal,
  type EvaluationCase,
  type EvaluationReport,
  type FeedbackSignal,
} from "./learning.js";
import { AccessPolicy } from "./policy.js";
import type { Principal, RecordStore, SourceRef } from "./types.js";

export interface CandidateContext {
  workspaceId: string;
  target: string;
  baseRevision: number;
  baseline: unknown;
  evidence: FeedbackSignal[];
  adaptationCases: EvaluationCase[];
  previousEvaluations: EvaluationReport[];
}
export interface CandidateGenerator {
  /** Change this version when the generator implementation or prompt changes. */
  id: string;
  origin: ChangeProposal["origin"];
  maxCandidates?: 1 | 2 | 3;
  reserveTokens(context: CandidateContext): number;
  generate(
    context: CandidateContext,
    execution: {
      id: string;
      reservedTokens: number;
      signal: AbortSignal;
      /** Persist a known provider receipt even if later candidate parsing fails. */
      reportUsage?: (tokens: number) => void;
    },
  ): Promise<{ candidate: unknown; rationale: string; usedTokens?: number }>;
}
export interface LearningRun {
  id: string;
  workspaceId: string;
  principalId: string;
  target: string;
  baseRevision: number;
  evidenceIds: string[];
  lineage: SourceRef[];
  generatorId: string;
  rootId: string;
  ownsBudget: boolean;
  attempts: number;
  proposalIds: string[];
  currentProposalId?: string;
  status:
    | "ready"
    | "generating"
    | "evaluating"
    | "awaiting_review"
    | "promoted"
    | "exhausted"
    | "interrupted"
    | "stale";
  error?: { code: string; message: string };
}

/** Resumable orchestration. Proposers receive adaptation examples and validation reports only. */
export class LearningPipeline {
  private readonly access: AccessPolicy;
  private readonly budgets: RunBudgets;
  private readonly active = new Set<string>();
  constructor(
    private readonly store: RecordStore,
    private readonly learning: Learning,
    private readonly generator: CandidateGenerator,
    private readonly options: { onTransition?: (run: LearningRun) => void } = {},
  ) {
    invariant(
      generator.maxCandidates === undefined || [1, 2, 3].includes(generator.maxCandidates),
      "INVALID_INPUT",
      "An improvement may attempt at most three candidates.",
    );
    this.access = new AccessPolicy(store);
    this.budgets = new RunBudgets(store);
  }
  start(
    principal: Principal,
    input: {
      id?: string;
      workspaceId: string;
      target: string;
      evidenceIds: string[];
      rootId?: string;
    },
  ): LearningRun {
    this.access.require(principal, input.workspaceId, "write");
    invariant(
      input.evidenceIds.length > 0 && input.evidenceIds.length <= 20,
      "INVALID_INPUT",
      "Choose 1–20 evidence items for one improvement.",
    );
    const id = input.id ?? crypto.randomUUID();
    const existing = this.store.get<LearningRun>("learning_runs", id);
    if (existing) {
      this.read(principal, id);
      invariant(
        existing.workspaceId === input.workspaceId &&
          existing.target === input.target &&
          existing.rootId === (input.rootId ?? id) &&
          JSON.stringify(existing.evidenceIds) === JSON.stringify(input.evidenceIds) &&
          existing.principalId === principal.id,
        "INVALID_INPUT",
        "This learning-run identity belongs to another improvement.",
      );
      return existing;
    }
    const context = this.learning.candidateContext(principal, input.workspaceId, input.target);
    const evidence = this.evidence(principal, input.workspaceId, input.evidenceIds);
    const rootId = input.rootId ?? id;
    const run: LearningRun = {
      id,
      workspaceId: input.workspaceId,
      principalId: principal.id,
      target: input.target,
      baseRevision: context.baseline.revision,
      evidenceIds: [...input.evidenceIds],
      lineage: [
        ...context.baseline.lineage,
        ...evidence.flatMap((item) => [
          { spaceId: item.workspaceId, itemId: item.id },
          ...item.lineage,
        ]),
      ],
      generatorId: this.generator.id,
      rootId,
      ownsBudget: !input.rootId,
      attempts: 0,
      proposalIds: [],
      status: "ready",
    };
    return this.store.transaction(() => {
      if (input.rootId) {
        this.budgets.requireActive(rootId);
        this.budgets.addDescendant(rootId);
      } else {
        this.budgets.start(rootId);
        this.budgets.pause(rootId);
      }
      this.save(run);
      return run;
    });
  }
  read(principal: Principal, id: string): LearningRun {
    const run = this.store.get<LearningRun>("learning_runs", id);
    invariant(
      run && this.access.visible(principal, run.workspaceId, run.lineage),
      "NOT_FOUND",
      "No accessible learning run exists with that reference.",
    );
    return run;
  }
  async advance(principal: Principal, id: string): Promise<LearningRun> {
    invariant(
      !this.active.has(id),
      "WORKSPACE_BUSY",
      "This improvement is already being processed.",
    );
    let run = this.read(principal, id);
    this.access.require(principal, run.workspaceId, "write");
    invariant(
      run.principalId === principal.id,
      "ACCESS_DENIED",
      "Resume an improvement with its original execution identity.",
    );
    invariant(
      run.generatorId === this.generator.id,
      "STALE_REVISION",
      "The proposal generator changed. Start a new improvement with the updated generator.",
    );
    if (["promoted", "exhausted", "stale"].includes(run.status)) return run;
    this.active.add(id);
    try {
      if (run.ownsBudget) this.budgets.resume(run.rootId);
      while (true) {
        this.access.requireSources(principal, run.lineage);
        let proposal = run.currentProposalId
          ? this.learning.read(principal, run.currentProposalId)
          : undefined;
        if (proposal?.status === "promoted") return this.finish({ ...run, status: "promoted" });
        if (run.status === "awaiting_review") return this.pause(run);
        const target = this.learning.candidateContext(principal, run.workspaceId, run.target);
        invariant(
          target.baseline.revision === run.baseRevision,
          "STALE_REVISION",
          "The learning target changed. Rebase this improvement before continuing.",
        );
        if (!proposal) {
          if (run.attempts >= (this.generator.maxCandidates ?? 3))
            return this.finish({ ...run, status: "exhausted" });
          const context: CandidateContext = {
            workspaceId: run.workspaceId,
            target: run.target,
            baseRevision: run.baseRevision,
            baseline: target.baseline.value,
            evidence: this.evidence(principal, run.workspaceId, run.evidenceIds),
            adaptationCases: target.adaptationCases,
            previousEvaluations: run.proposalIds.flatMap((id) => {
              const report = this.learning.report(principal, id);
              return report ? [report] : [];
            }),
          };
          const executionId = `${run.id}:candidate:${run.attempts + 1}`;
          const reservedTokens = this.generator.reserveTokens(context);
          invariant(
            Number.isSafeInteger(reservedTokens) && reservedTokens >= 0,
            "INVALID_INPUT",
            "Declare a finite token reservation; deterministic generators may use zero.",
          );
          if (reservedTokens > 0) this.budgets.reserve(run.rootId, executionId, reservedTokens);
          run = this.save({ ...run, status: "generating", attempts: run.attempts + 1 });
          const generated = await this.generator.generate(context, {
            id: executionId,
            reservedTokens,
            signal: AbortSignal.timeout(Math.max(1, this.budgets.remainingActiveMs(run.rootId))),
            ...(reservedTokens > 0
              ? {
                  reportUsage: (tokens: number) =>
                    this.budgets.settle(run.rootId, executionId, tokens),
                }
              : {}),
          });
          if (reservedTokens > 0 && generated.usedTokens !== undefined)
            this.budgets.settle(run.rootId, executionId, generated.usedTokens);
          else if (reservedTokens === 0)
            invariant(
              generated.usedTokens === 0,
              "BUDGET_EXCEEDED",
              "A generator without a token reservation cannot report model usage.",
            );
          this.budgets.requireActive(run.rootId);
          this.access.requireSources(principal, run.lineage);
          // A crash cannot create a proposal without retaining its identity in the pipeline.
          run = this.store.transaction(() => {
            const created = this.learning.propose(principal, {
              workspaceId: run.workspaceId,
              target: run.target,
              kind: target.kind,
              baseRevision: run.baseRevision,
              candidate: generated.candidate,
              rationale: generated.rationale,
              evidenceIds: run.evidenceIds,
              lineage: run.lineage,
              origin: this.generator.origin,
            });
            proposal = created;
            return this.save({
              ...run,
              currentProposalId: created.id,
              proposalIds: [...run.proposalIds, created.id],
              status: "evaluating",
            });
          });
        }
        this.budgets.requireActive(run.rootId);
        const report = await this.learning.evaluate(principal, proposal!.id);
        this.budgets.requireActive(run.rootId);
        if (report.eligible) {
          if (proposal!.kind !== "memory" && proposal!.kind !== "instruction")
            return this.pause(this.save({ ...run, status: "awaiting_review" }));
          await this.learning.promote(principal, proposal!.id);
          return this.finish({ ...run, status: "promoted" });
        }
        const { currentProposalId: _current, error: _error, ...next } = run;
        run = this.save({ ...next, status: "ready" });
      }
    } catch (error) {
      const fault = asFault(error);
      this.pause(
        this.save({
          ...run,
          status: fault.code === "STALE_REVISION" ? "stale" : "interrupted",
          error: fault.toJSON(),
        }),
      );
      throw error;
    } finally {
      this.active.delete(id);
    }
  }
  private evidence(principal: Principal, workspaceId: string, ids: string[]): FeedbackSignal[] {
    const accessible = this.learning.listFeedback(principal, workspaceId);
    const evidence = ids.map((id) => accessible.find((item) => item.id === id));
    invariant(
      evidence.every(Boolean),
      "NOT_FOUND",
      "Some improvement evidence is unavailable under the current grants.",
    );
    return evidence as FeedbackSignal[];
  }
  private save(run: LearningRun): LearningRun {
    return this.store.transaction(() => {
      const previous = this.store.get<LearningRun>("learning_runs", run.id);
      this.store.put("learning_runs", run.id, run);
      if (previous?.status !== run.status) this.options.onTransition?.(run);
      return run;
    });
  }
  private pause(run: LearningRun): LearningRun {
    if (run.ownsBudget) this.budgets.pause(run.rootId);
    return run;
  }
  private finish(run: LearningRun): LearningRun {
    return this.store.transaction(() => {
      if (run.ownsBudget) this.budgets.complete(run.rootId);
      return this.save(run);
    });
  }
}
