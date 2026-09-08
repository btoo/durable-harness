import { contentHash } from "./compiler.js";
import { invariant } from "./errors.js";
import { AccessPolicy } from "./policy.js";
import type { Principal, RecordStore, SourceRef } from "./types.js";

export type ChangeKind = "memory" | "instruction" | "business_rule" | "capability" | "schema" | "runtime";
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
  status: "proposed" | "evaluating" | "awaiting_review" | "eligible" | "promoted" | "rejected" | "rolled_back";
  origin: "customer_correction" | "model_generated" | "developer";
  createdAt: string;
  evaluationId?: string;
  promotedRevision?: number;
}
export interface ConfigurationVersion { target: string; workspaceId: string; revision: number; value: unknown; proposalId: string | null; createdAt: string }
export interface EvaluationCase { id: string; family: string; split: "adaptation" | "validation" | "heldout"; input: unknown; expected: unknown; critical?: boolean }
export interface CaseScore { caseId: string; passed: boolean; score: number; explanation: string; cost?: number; durationMs?: number }
export interface EvaluationReport {
  id: string;
  proposalId: string;
  evaluatorId: string;
  candidateHash: string;
  caseIds: string[];
  baseline: CaseScore[];
  candidate: CaseScore[];
  eligible: boolean;
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
  constructor(private readonly store: RecordStore, targets: LearningTarget[]) {
    this.access = new AccessPolicy(store);
    this.targets = new Map(targets.map(target => [target.name, target]));
    for (const target of targets) {
      const splits = new Map<string, EvaluationCase["split"]>();
      for (const testCase of target.cases) {
        invariant(!splits.has(testCase.family) || splits.get(testCase.family) === testCase.split, "INVALID_INPUT", "Related evaluation cases must remain in the same data split.");
        splits.set(testCase.family, testCase.split);
      }
    }
  }
  configuration(principal: Principal, workspaceId: string, target: string): ConfigurationVersion | undefined {
    this.access.require(principal, workspaceId, "read");
    return this.store.get<ConfigurationVersion>("configuration", `${workspaceId}:${target}`);
  }
  initialize(principal: Principal, workspaceId: string, target: string, value: unknown): ConfigurationVersion {
    invariant(principal.roles.includes("developer"), "ACCESS_DENIED", "A developer initializes configuration.");
    this.access.require(principal, workspaceId, "write");
    this.target(target).validate(value, value);
    const existing = this.configuration(principal, workspaceId, target);
    if (existing) return existing;
    const version: ConfigurationVersion = { workspaceId, target, revision: 1, value, proposalId: null, createdAt: new Date().toISOString() };
    this.store.transaction(() => { this.store.put("configuration", `${workspaceId}:${target}`, version); this.store.put("configuration_versions", `${workspaceId}:${target}:1`, version); });
    return version;
  }
  feedback(principal: Principal, signal: Omit<FeedbackSignal, "createdAt">): FeedbackSignal {
    this.access.require(principal, signal.workspaceId, "write");
    this.access.requireSources(principal, signal.lineage);
    const existing = this.store.get<FeedbackSignal>("feedback", signal.id);
    if (existing) { invariant(existing.workspaceId === signal.workspaceId, "INVALID_INPUT", "Feedback identity belongs to another workspace."); return existing; }
    const stored = { ...signal, createdAt: new Date().toISOString() };
    this.store.put("feedback", signal.id, stored);
    return stored;
  }
  listFeedback(principal: Principal, workspaceId: string): FeedbackSignal[] {
    this.access.require(principal, workspaceId, "read");
    return this.store.list<FeedbackSignal>("feedback").filter(signal => signal.workspaceId === workspaceId && this.access.visible(principal, workspaceId, signal.lineage));
  }
  clusters(principal: Principal, workspaceId: string): { id: string; agent: string; signals: FeedbackSignal[]; kind: FeedbackSignal["kind"] }[] {
    const clusters: { id: string; agent: string; signals: FeedbackSignal[]; kind: FeedbackSignal["kind"] }[] = [];
    for (const signal of this.listFeedback(principal, workspaceId)) {
      const cluster = clusters.find(cluster => cluster.agent === signal.agent && cluster.kind === signal.kind && (cluster.signals[0]!.text === signal.text || cosine(cluster.signals[0]!.embedding, signal.embedding) >= 0.88));
      if (cluster) cluster.signals.push(signal);
      else clusters.push({ id: signal.id, agent: signal.agent, kind: signal.kind, signals: [signal] });
    }
    return clusters;
  }
  propose(principal: Principal, input: Omit<ChangeProposal, "id" | "status" | "createdAt" | "evaluationId" | "promotedRevision">): ChangeProposal {
    this.access.require(principal, input.workspaceId, "write");
    this.access.requireSources(principal, input.lineage);
    const target = this.target(input.target);
    invariant(target.kind === input.kind, "INVALID_INPUT", "Proposal kind does not match the developer-owned target.");
    const configuration = this.configuration(principal, input.workspaceId, input.target);
    invariant(configuration && configuration.revision === input.baseRevision, "STALE_REVISION", "The proposal must target the current configuration revision.");
    invariant(input.evidenceIds.length > 0, "INVALID_INPUT", "A proposal needs source evidence.");
    const evidence = input.evidenceIds.map(id => this.store.get<FeedbackSignal>("feedback", id));
    invariant(evidence.every(signal => signal && signal.workspaceId === input.workspaceId && this.access.visible(principal, signal.workspaceId, signal.lineage)), "ACCESS_DENIED", "Proposal evidence must be accessible and belong to this workspace.");
    target.validate(input.candidate, configuration.value);
    const proposal: ChangeProposal = { ...input, lineage: [...input.lineage, ...evidence.flatMap(signal => signal!.lineage)], id: crypto.randomUUID(), status: "proposed", createdAt: new Date().toISOString() };
    this.store.put("proposals", proposal.id, proposal);
    return proposal;
  }
  read(principal: Principal, id: string): ChangeProposal {
    const proposal = this.store.get<ChangeProposal>("proposals", id);
    invariant(proposal && this.access.visible(principal, proposal.workspaceId, proposal.lineage), "NOT_FOUND", "No accessible proposal exists with that reference.");
    return proposal;
  }
  list(principal: Principal, workspaceId: string): ChangeProposal[] {
    this.access.require(principal, workspaceId, "read");
    return this.store.list<ChangeProposal>("proposals").filter(proposal => proposal.workspaceId === workspaceId && this.access.visible(principal, workspaceId, proposal.lineage));
  }
  async evaluate(principal: Principal, id: string): Promise<EvaluationReport> {
    const proposal = this.read(principal, id);
    this.access.require(principal, proposal.workspaceId, "write");
    const target = this.target(proposal.target);
    const baseline = this.configuration(principal, proposal.workspaceId, proposal.target)!;
    invariant(baseline.revision === proposal.baseRevision, "STALE_REVISION", "Rebase this proposal onto the current configuration before evaluating.");
    const cases = target.cases.filter(testCase => testCase.split === "validation");
    invariant(cases.length > 0, "EVALUATION_REQUIRED", "This target has no developer-owned validation cases.");
    invariant(proposal.status !== "evaluating" && proposal.status !== "promoted", "INVALID_INPUT", "This proposal is already evaluating or promoted.");
    this.store.put("proposals", id, { ...proposal, status: "evaluating" });
    const baselineScores: CaseScore[] = []; const candidateScores: CaseScore[] = [];
    try {
      for (const testCase of cases) {
        const baselineScore = await target.evaluator.evaluate({ configuration: baseline.value, testCase });
        const candidateScore = await target.evaluator.evaluate({ configuration: proposal.candidate, testCase });
        for (const score of [baselineScore, candidateScore]) invariant(score.caseId === testCase.id && Number.isFinite(score.score) && score.score >= 0 && score.score <= 1, "INVALID_INPUT", "The evaluator returned an invalid case identity or score.");
        baselineScores.push(baselineScore);
        candidateScores.push(candidateScore);
      }
      const eligible = cases.every((testCase, i) => (!testCase.critical || candidateScores[i]!.passed) && !(baselineScores[i]!.passed && !candidateScores[i]!.passed)) && candidateScores.reduce((sum, score) => sum + score.score, 0) > baselineScores.reduce((sum, score) => sum + score.score, 0);
      const report: EvaluationReport = { id: crypto.randomUUID(), proposalId: id, evaluatorId: target.evaluator.id, candidateHash: await contentHash(JSON.stringify(proposal.candidate)), caseIds: cases.map(testCase => testCase.id), baseline: baselineScores, candidate: candidateScores, eligible, createdAt: new Date().toISOString() };
      this.access.require(principal, proposal.workspaceId, "write");
      this.access.requireSources(principal, proposal.lineage);
      this.store.put("evaluations", report.id, report);
      this.store.put("proposals", id, { ...proposal, evaluationId: report.id, status: eligible ? (["memory", "instruction"].includes(proposal.kind) ? "eligible" : "awaiting_review") : "proposed" });
      return report;
    } catch (error) { this.store.put("proposals", id, { ...proposal, status: "proposed" }); throw error; }
  }
  async promote(principal: Principal, id: string, reviewed = false): Promise<ConfigurationVersion> {
    const proposal = this.read(principal, id);
    this.access.require(principal, proposal.workspaceId, "write");
    const automatic = proposal.kind === "memory" || proposal.kind === "instruction";
    const mayReview = principal.roles.includes("developer") || (proposal.kind === "business_rule" && principal.roles.includes("customer"));
    invariant(automatic || (reviewed && mayReview), "APPROVAL_REQUIRED", "An authorized reviewer must approve this kind of change before promotion.");
    const report = proposal.evaluationId && this.store.get<EvaluationReport>("evaluations", proposal.evaluationId);
    invariant(report && report.eligible && report.candidateHash === await contentHash(JSON.stringify(proposal.candidate)), "EVALUATION_REQUIRED", "The exact candidate must improve validation results without regressions before promotion.");
    return this.store.transaction(() => {
      const current = this.configuration(principal, proposal.workspaceId, proposal.target)!;
      invariant(current.revision === proposal.baseRevision, "STALE_REVISION", "The target changed after evaluation. Rebase and evaluate this proposal again.");
      this.target(proposal.target).validate(proposal.candidate, current.value);
      const version: ConfigurationVersion = { workspaceId: proposal.workspaceId, target: proposal.target, revision: current.revision + 1, value: proposal.candidate, proposalId: proposal.id, createdAt: new Date().toISOString() };
      this.store.put("configuration", `${version.workspaceId}:${version.target}`, version);
      this.store.put("configuration_versions", `${version.workspaceId}:${version.target}:${version.revision}`, version);
      this.store.put("proposals", proposal.id, { ...proposal, status: "promoted", promotedRevision: version.revision });
      return version;
    });
  }
  rollback(principal: Principal, workspaceId: string, targetName: string, revision: number): ConfigurationVersion {
    invariant(principal.roles.includes("developer"), "ACCESS_DENIED", "A developer must review a rollback.");
    this.access.require(principal, workspaceId, "write");
    return this.store.transaction(() => {
      const current = this.configuration(principal, workspaceId, targetName)!;
      const previous = this.store.get<ConfigurationVersion>("configuration_versions", `${workspaceId}:${targetName}:${revision}`);
      invariant(previous, "NOT_FOUND", "The selected configuration revision does not exist.");
      const restored = { ...previous, revision: current.revision + 1, createdAt: new Date().toISOString() };
      this.store.put("configuration", `${workspaceId}:${targetName}`, restored);
      this.store.put("configuration_versions", `${workspaceId}:${targetName}:${restored.revision}`, restored);
      if (current.proposalId) this.store.put("proposals", current.proposalId, { ...this.read(principal, current.proposalId), status: "rolled_back" });
      return restored;
    });
  }
  private target(name: string): LearningTarget {
    const target = this.targets.get(name);
    invariant(target, "NOT_FOUND", "No developer-owned optimization target is registered with that name.");
    return target;
  }
}

function cosine(a?: number[], b?: number[]): number {
  if (!a?.length || a.length !== b?.length) return -1;
  const dot = a.reduce((sum, x, i) => sum + x * b[i]!, 0);
  const norm = Math.sqrt(a.reduce((sum, x) => sum + x * x, 0) * b.reduce((sum, x) => sum + x * x, 0));
  return norm ? dot / norm : -1;
}
