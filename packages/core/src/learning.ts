import { contentHash } from "./compiler.js";
import { invariant } from "./errors.js";
import { SignalClusters } from "./clustering.js";
import { AccessPolicy } from "./policy.js";
import type { Principal, RecordStore, SourceRef } from "./types.js";

export type ChangeKind =
  "memory" | "instruction" | "business_rule" | "capability" | "schema" | "runtime";
export interface FeedbackSignal {
  id: string;
  workspaceId: string;
  agent: string;
  kind: "correction" | "approval" | "rejection" | "failure" | "outcome";
  text: string;
  sourceRunId: string;
  createdAt: string;
  lineage: SourceRef[];
  original?: unknown;
  corrected?: unknown;
  embedding?: number[];
  signature?: string;
}
export interface ChangeProposal {
  id: string;
  workspaceId: string;
  kind: ChangeKind;
  target: string;
  baseRevision: number;
  candidate: unknown;
  rationale: string;
  evidenceIds: string[];
  lineage: SourceRef[];
  status:
    | "proposed"
    | "evaluating"
    | "awaiting_review"
    | "eligible"
    | "promoted"
    | "rejected"
    | "rolled_back";
  origin: "customer_correction" | "model_generated" | "developer";
  createdAt: string;
  evaluationId?: string;
  promotedRevision?: number;
}
export interface ConfigurationVersion {
  lineage: SourceRef[];
  target: string;
  workspaceId: string;
  revision: number;
  value: unknown;
  proposalId: string | null;
  createdAt: string;
}
export interface EvaluationCase {
  id: string;
  family: string;
  split: "adaptation" | "validation" | "heldout";
  input: unknown;
  expected: unknown;
  critical?: boolean;
}
export interface CaseScore {
  caseId: string;
  passed: boolean;
  score: number;
  explanation: string;
  cost?: number;
  durationMs?: number;
}
export interface EvaluationReport {
  id: string;
  proposalId: string;
  evaluatorId: string;
  candidateHash: string;
  validationHash: string;
  caseIds: string[];
  baseline: CaseScore[];
  candidate: CaseScore[];
  eligible: boolean;
  createdAt: string;
}
export interface HeldoutAssessment {
  id: string;
  proposalId: string;
  evaluatorId: string;
  candidateHash: string;
  cases: number;
  passed: number;
  meanScore: number;
  createdAt: string;
}
export interface EvaluationAdapter {
  id: string;
  evaluate(input: { configuration: unknown; testCase: EvaluationCase }): Promise<CaseScore>;
}
export interface LearningTarget {
  name: string;
  kind: ChangeKind;
  /** Developer-owned validation. This callback is never supplied by a proposer. */
  validate(candidate: unknown, baseline: unknown): void;
  evaluator: EvaluationAdapter;
  cases: EvaluationCase[];
}

/** Versioned configuration and measured promotion; no production destination is built in. */
export class Learning {
  private readonly access: AccessPolicy;
  private readonly targets: Map<string, LearningTarget>;
  private readonly evaluating = new Set<string>();
  constructor(
    private readonly store: RecordStore,
    targets: LearningTarget[],
  ) {
    this.access = new AccessPolicy(store);
    this.targets = new Map(targets.map((target) => [target.name, target]));
    for (const target of targets) {
      invariant(
        new Set(target.cases.map((testCase) => testCase.id)).size === target.cases.length,
        "INVALID_INPUT",
        "Evaluation case identities must be unique within a target.",
      );
      const splits = new Map<string, EvaluationCase["split"]>();
      for (const testCase of target.cases) {
        invariant(
          !splits.has(testCase.family) || splits.get(testCase.family) === testCase.split,
          "INVALID_INPUT",
          "Related evaluation cases must remain in the same data split.",
        );
        splits.set(testCase.family, testCase.split);
      }
    }
  }
  candidateContext(principal: Principal, workspaceId: string, targetName: string) {
    const baseline = this.configuration(principal, workspaceId, targetName);
    invariant(
      baseline,
      "NOT_FOUND",
      "Initialize this learning target before generating a proposal.",
    );
    const target = this.target(targetName);
    return {
      baseline,
      kind: target.kind,
      adaptationCases: target.cases.filter((testCase) => testCase.split === "adaptation"),
    };
  }
  report(principal: Principal, proposalId: string): EvaluationReport | undefined {
    const proposal = this.read(principal, proposalId);
    return proposal.evaluationId
      ? this.store.get<EvaluationReport>("evaluations", proposal.evaluationId)
      : undefined;
  }
  configuration(
    principal: Principal,
    workspaceId: string,
    target: string,
  ): ConfigurationVersion | undefined {
    this.access.require(principal, workspaceId, "read");
    const version = this.store.get<ConfigurationVersion>(
      "configuration",
      `${workspaceId}:${target}`,
    );
    if (!version) return undefined;
    const lineage = this.configurationSources(version);
    this.access.requireSources(principal, lineage);
    return { ...version, lineage };
  }
  initialize(
    principal: Principal,
    workspaceId: string,
    target: string,
    value: unknown,
    lineage: SourceRef[] = [],
  ): ConfigurationVersion {
    invariant(
      principal.roles.includes("developer"),
      "ACCESS_DENIED",
      "A developer initializes configuration.",
    );
    this.access.require(principal, workspaceId, "write");
    this.access.requireSources(principal, lineage);
    this.target(target).validate(value, value);
    const existing = this.configuration(principal, workspaceId, target);
    if (existing) return existing;
    const version: ConfigurationVersion = {
      workspaceId,
      target,
      revision: 1,
      value,
      proposalId: null,
      lineage: [...lineage],
      createdAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      this.store.put("configuration", `${workspaceId}:${target}`, version);
      this.store.put("configuration_versions", `${workspaceId}:${target}:1`, version);
    });
    return version;
  }
  feedback(principal: Principal, signal: Omit<FeedbackSignal, "createdAt">): FeedbackSignal {
    this.access.require(principal, signal.workspaceId, "write");
    this.access.requireSources(principal, signal.lineage);
    const existing = this.store.get<FeedbackSignal>("feedback", signal.id);
    if (existing) {
      const { createdAt: _createdAt, ...original } = existing;
      invariant(
        JSON.stringify(original) === JSON.stringify(signal),
        "INVALID_INPUT",
        "This feedback identity already has different evidence. Record a new signal version instead.",
      );
      return existing;
    }
    const stored = { ...signal, createdAt: new Date().toISOString() };
    this.store.put("feedback", signal.id, stored);
    new SignalClusters(this.store).groupStructured(principal, signal.id);
    return stored;
  }
  listFeedback(principal: Principal, workspaceId: string): FeedbackSignal[] {
    this.access.require(principal, workspaceId, "read");
    return this.store
      .list<FeedbackSignal>("feedback")
      .filter(
        (signal) =>
          signal.workspaceId === workspaceId &&
          this.access.visible(principal, workspaceId, signal.lineage),
      );
  }
  clusters(principal: Principal, workspaceId: string) {
    return new SignalClusters(this.store).list(principal, workspaceId);
  }

  propose(
    principal: Principal,
    input: Omit<
      ChangeProposal,
      "id" | "status" | "createdAt" | "evaluationId" | "promotedRevision"
    >,
  ): ChangeProposal {
    this.access.require(principal, input.workspaceId, "write");
    this.access.requireSources(principal, input.lineage);
    const target = this.target(input.target);
    invariant(
      target.kind === input.kind,
      "INVALID_INPUT",
      "Proposal kind does not match the developer-owned target.",
    );
    const configuration = this.configuration(principal, input.workspaceId, input.target);
    invariant(
      configuration && configuration.revision === input.baseRevision,
      "STALE_REVISION",
      "The proposal must target the current configuration revision.",
    );
    invariant(input.evidenceIds.length > 0, "INVALID_INPUT", "A proposal needs source evidence.");
    const evidence = input.evidenceIds.map((id) => this.store.get<FeedbackSignal>("feedback", id));
    invariant(
      evidence.every(
        (signal) =>
          signal &&
          signal.workspaceId === input.workspaceId &&
          this.access.visible(principal, signal.workspaceId, signal.lineage),
      ),
      "ACCESS_DENIED",
      "Proposal evidence must be accessible and belong to this workspace.",
    );
    target.validate(input.candidate, configuration.value);
    const proposal: ChangeProposal = {
      ...input,
      lineage: [
        ...configuration.lineage,
        ...input.lineage,
        ...evidence.flatMap((signal) => signal!.lineage),
      ],
      id: crypto.randomUUID(),
      status: "proposed",
      createdAt: new Date().toISOString(),
    };
    this.store.put("proposals", proposal.id, proposal);
    return proposal;
  }
  read(principal: Principal, id: string): ChangeProposal {
    const proposal = this.store.get<ChangeProposal>("proposals", id);
    invariant(
      proposal && this.access.visible(principal, proposal.workspaceId, proposal.lineage),
      "NOT_FOUND",
      "No accessible proposal exists with that reference.",
    );
    return proposal;
  }
  list(principal: Principal, workspaceId: string): ChangeProposal[] {
    this.access.require(principal, workspaceId, "read");
    return this.store
      .list<ChangeProposal>("proposals")
      .filter(
        (proposal) =>
          proposal.workspaceId === workspaceId &&
          this.access.visible(principal, workspaceId, proposal.lineage),
      );
  }
  async evaluate(principal: Principal, id: string): Promise<EvaluationReport> {
    invariant(
      !this.evaluating.has(id),
      "WORKSPACE_BUSY",
      "This proposal is currently evaluating. Inspect its progress before resuming.",
    );
    this.evaluating.add(id);
    try {
      const proposal = this.read(principal, id);
      this.access.require(principal, proposal.workspaceId, "write");
      invariant(
        !["promoted", "rejected", "rolled_back"].includes(proposal.status),
        "INVALID_INPUT",
        "This proposal is already settled.",
      );
      const target = this.target(proposal.target);
      const baseline = this.configuration(principal, proposal.workspaceId, proposal.target)!;
      invariant(
        baseline.revision === proposal.baseRevision,
        "STALE_REVISION",
        "Rebase this proposal onto the current configuration before evaluating.",
      );
      target.validate(proposal.candidate, baseline.value);
      const cases = target.cases.filter((testCase) => testCase.split === "validation");
      invariant(
        cases.length > 0,
        "EVALUATION_REQUIRED",
        "This target has no developer-owned validation cases.",
      );
      const candidateHash = await contentHash(JSON.stringify(proposal.candidate));
      const validationHash = await contentHash(JSON.stringify([target.evaluator.id, cases]));
      const signature = await contentHash(
        JSON.stringify([candidateHash, validationHash, baseline.revision, baseline.value]),
      );
      type Progress = {
        id: string;
        signature: string;
        baseline: CaseScore[];
        candidate: CaseScore[];
        createdAt: string;
      };
      let progress = this.store.get<Progress>("evaluation_progress", id);
      if (!progress || progress.signature !== signature)
        progress = {
          id: crypto.randomUUID(),
          signature,
          baseline: [],
          candidate: [],
          createdAt: new Date().toISOString(),
        };
      this.store.put("evaluation_progress", id, progress);
      this.store.put("proposals", id, { ...proposal, status: "evaluating" });
      for (const testCase of cases)
        for (const side of ["baseline", "candidate"] as const) {
          if (progress[side].some((score) => score.caseId === testCase.id)) continue;
          this.access.require(principal, proposal.workspaceId, "write");
          this.access.requireSources(principal, proposal.lineage);
          const score = await target.evaluator.evaluate({
            configuration: side === "baseline" ? baseline.value : proposal.candidate,
            testCase,
          });
          invariant(
            score.caseId === testCase.id &&
              Number.isFinite(score.score) &&
              score.score >= 0 &&
              score.score <= 1,
            "INVALID_INPUT",
            "The evaluator returned an invalid case identity or score.",
          );
          this.access.require(principal, proposal.workspaceId, "write");
          this.access.requireSources(principal, proposal.lineage);
          progress[side].push(score);
          this.store.put("evaluation_progress", id, progress);
        }
      const eligible =
        cases.every(
          (testCase, i) =>
            (!testCase.critical || progress.candidate[i]!.passed) &&
            !(progress.baseline[i]!.passed && !progress.candidate[i]!.passed),
        ) &&
        progress.candidate.reduce((sum, score) => sum + score.score, 0) >
          progress.baseline.reduce((sum, score) => sum + score.score, 0);
      const report: EvaluationReport = {
        id: progress.id,
        proposalId: id,
        evaluatorId: target.evaluator.id,
        candidateHash,
        validationHash,
        caseIds: cases.map((testCase) => testCase.id),
        baseline: progress.baseline,
        candidate: progress.candidate,
        eligible,
        createdAt: progress.createdAt,
      };
      return this.store.transaction(() => {
        this.access.require(principal, proposal.workspaceId, "write");
        this.access.requireSources(principal, proposal.lineage);
        invariant(
          this.configuration(principal, proposal.workspaceId, proposal.target)?.revision ===
            proposal.baseRevision,
          "STALE_REVISION",
          "The configuration changed during evaluation. Rebase the proposal before continuing.",
        );
        const current = this.read(principal, id);
        invariant(
          current.status === "evaluating",
          "STALE_REVISION",
          "This proposal changed while its evaluation was running.",
        );
        this.store.put("evaluations", report.id, report);
        this.store.put("proposals", id, {
          ...proposal,
          evaluationId: report.id,
          status: eligible
            ? ["memory", "instruction"].includes(proposal.kind)
              ? "eligible"
              : "awaiting_review"
            : "proposed",
        });
        return report;
      });
    } finally {
      this.evaluating.delete(id);
    }
  }

  async assess(principal: Principal, id: string): Promise<HeldoutAssessment> {
    invariant(
      principal.roles.includes("developer"),
      "ACCESS_DENIED",
      "Held-out assessment is a developer-controlled operation.",
    );
    const proposal = this.read(principal, id);
    invariant(
      proposal.promotedRevision !== undefined,
      "EVALUATION_REQUIRED",
      "Assess a promoted candidate; held-out feedback does not drive refinement.",
    );
    const target = this.target(proposal.target);
    const candidateHash = await contentHash(JSON.stringify(proposal.candidate));
    const key = `${id}:${target.evaluator.id}:${candidateHash}`;
    const previous = this.store.get<HeldoutAssessment>("heldout_assessments", key);
    if (previous) return previous;
    const cases = target.cases.filter((testCase) => testCase.split === "heldout");
    invariant(
      cases.length > 0,
      "EVALUATION_REQUIRED",
      "This target has no held-out assessment cases.",
    );
    const scores: CaseScore[] = [];
    for (const testCase of cases) {
      this.access.requireSources(principal, proposal.lineage);
      const score = await target.evaluator.evaluate({
        configuration: proposal.candidate,
        testCase,
      });
      invariant(
        score.caseId === testCase.id &&
          Number.isFinite(score.score) &&
          score.score >= 0 &&
          score.score <= 1,
        "INVALID_INPUT",
        "The assessor returned an invalid result.",
      );
      scores.push(score);
    }
    this.access.requireSources(principal, proposal.lineage);
    const assessment: HeldoutAssessment = {
      id: key,
      proposalId: id,
      evaluatorId: target.evaluator.id,
      candidateHash,
      cases: scores.length,
      passed: scores.filter((score) => score.passed).length,
      meanScore: scores.reduce((sum, score) => sum + score.score, 0) / scores.length,
      createdAt: new Date().toISOString(),
    };
    this.store.put("heldout_assessments", key, assessment);
    return assessment;
  }
  async promote(principal: Principal, id: string, reviewed = false): Promise<ConfigurationVersion> {
    const proposal = this.read(principal, id);
    this.access.require(principal, proposal.workspaceId, "write");
    const automatic = proposal.kind === "memory" || proposal.kind === "instruction";
    const mayReview =
      principal.roles.includes("developer") ||
      (proposal.kind === "business_rule" && principal.roles.includes("customer"));
    invariant(
      automatic || (reviewed && mayReview),
      "APPROVAL_REQUIRED",
      "An authorized reviewer must approve this kind of change before promotion.",
    );
    const report =
      proposal.evaluationId &&
      this.store.get<EvaluationReport>("evaluations", proposal.evaluationId);
    invariant(
      report &&
        report.eligible &&
        report.candidateHash === (await contentHash(JSON.stringify(proposal.candidate))) &&
        report.validationHash ===
          (await contentHash(
            JSON.stringify([
              this.target(proposal.target).evaluator.id,
              this.target(proposal.target).cases.filter(
                (testCase) => testCase.split === "validation",
              ),
            ]),
          )),
      "EVALUATION_REQUIRED",
      "The exact candidate must improve validation results without regressions before promotion.",
    );
    return this.store.transaction(() => {
      this.access.require(principal, proposal.workspaceId, "write");
      this.access.requireSources(principal, proposal.lineage);
      const current = this.configuration(principal, proposal.workspaceId, proposal.target)!;
      invariant(
        current.revision === proposal.baseRevision,
        "STALE_REVISION",
        "The target changed after evaluation. Rebase and evaluate this proposal again.",
      );
      this.target(proposal.target).validate(proposal.candidate, current.value);
      const version: ConfigurationVersion = {
        workspaceId: proposal.workspaceId,
        target: proposal.target,
        revision: current.revision + 1,
        value: proposal.candidate,
        proposalId: proposal.id,
        lineage: [...proposal.lineage],
        createdAt: new Date().toISOString(),
      };
      this.store.put("configuration", `${version.workspaceId}:${version.target}`, version);
      this.store.put(
        "configuration_versions",
        `${version.workspaceId}:${version.target}:${version.revision}`,
        version,
      );
      this.store.put("proposals", proposal.id, {
        ...proposal,
        status: "promoted",
        promotedRevision: version.revision,
      });
      return version;
    });
  }
  rollback(
    principal: Principal,
    workspaceId: string,
    targetName: string,
    revision: number,
  ): ConfigurationVersion {
    invariant(
      principal.roles.includes("developer"),
      "ACCESS_DENIED",
      "A developer must review a rollback.",
    );
    this.access.require(principal, workspaceId, "write");
    return this.store.transaction(() => {
      const current = this.configuration(principal, workspaceId, targetName)!;
      const previous = this.store.get<ConfigurationVersion>(
        "configuration_versions",
        `${workspaceId}:${targetName}:${revision}`,
      );
      invariant(previous, "NOT_FOUND", "The selected configuration revision does not exist.");
      const lineage = this.configurationSources(previous);
      this.access.requireSources(principal, lineage);
      const restored = {
        ...previous,
        lineage,
        revision: current.revision + 1,
        createdAt: new Date().toISOString(),
      };
      this.store.put("configuration", `${workspaceId}:${targetName}`, restored);
      this.store.put(
        "configuration_versions",
        `${workspaceId}:${targetName}:${restored.revision}`,
        restored,
      );
      if (current.proposalId)
        this.store.put("proposals", current.proposalId, {
          ...this.read(principal, current.proposalId),
          status: "rolled_back",
        });
      return restored;
    });
  }
  private configurationSources(version: ConfigurationVersion): SourceRef[] {
    if (version.lineage) return version.lineage;
    if (!version.proposalId) return [];
    const proposal = this.store.get<ChangeProposal>("proposals", version.proposalId);
    invariant(
      proposal,
      "NOT_FOUND",
      "This configuration's provenance is unavailable; restore its proposal before using it.",
    );
    return proposal.lineage;
  }
  private target(name: string): LearningTarget {
    const target = this.targets.get(name);
    invariant(
      target,
      "NOT_FOUND",
      "No developer-owned optimization target is registered with that name.",
    );
    return target;
  }
}
