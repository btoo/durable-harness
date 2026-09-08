import { AccessPolicy } from "./policy.js";
import { invariant } from "./errors.js";
import type { FeedbackSignal } from "./learning.js";
import type { Principal, RecordStore } from "./types.js";

export interface SignalCluster {
  id: string;
  workspaceId: string;
  agent: string;
  kind: FeedbackSignal["kind"];
  signalIds: string[];
  confirmed: boolean;
  reason: string;
  citations: string[];
}
/** Embeddings rank candidates; they never establish group membership by themselves. */
export class SignalClusters {
  private readonly access: AccessPolicy;
  constructor(private readonly store: RecordStore) {
    this.access = new AccessPolicy(store);
  }
  list(principal: Principal, workspaceId: string) {
    this.access.require(principal, workspaceId, "read");
    const signals = this.signals(principal, workspaceId);
    const records = this.store
      .list<SignalCluster>("signal_clusters")
      .filter(
        (cluster) =>
          cluster.workspaceId === workspaceId &&
          cluster.signalIds.every((id) => signals.some((signal) => signal.id === id)),
      );
    const grouped = new Set(records.flatMap((cluster) => cluster.signalIds));
    const unclassified = signals
      .filter((signal) => !grouped.has(signal.id))
      .map((signal) => ({
        id: signal.id,
        workspaceId,
        agent: signal.agent,
        kind: signal.kind,
        signalIds: [signal.id],
        confirmed: false,
        reason: "Awaiting evidence-based grouping",
        citations: [signal.id],
      }));
    return [...records, ...unclassified].map((cluster) => ({
      ...cluster,
      signals: cluster.signalIds.map((id) => signals.find((signal) => signal.id === id)!),
    }));
  }
  candidates(principal: Principal, signalId: string, limit = 5) {
    const signal = this.readSignal(principal, signalId);
    return this.list(principal, signal.workspaceId)
      .filter(
        (cluster) =>
          !cluster.signalIds.includes(signalId) &&
          cluster.agent === signal.agent &&
          cluster.kind === signal.kind,
      )
      .map((cluster) => ({
        cluster,
        similarity: Math.max(
          ...cluster.signals.map((other) =>
            signal.signature && signal.signature === other.signature
              ? 1
              : cosine(signal.embedding, other.embedding),
          ),
        ),
      }))
      .filter((value) => value.similarity >= 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, Math.max(1, Math.min(limit, 10)));
  }
  groupStructured(principal: Principal, signalId: string): void {
    const signal = this.readSignal(principal, signalId);
    if (!signal.signature) return;
    const clusters = this.list(principal, signal.workspaceId).filter(
      (cluster) =>
        cluster.confirmed &&
        cluster.agent === signal.agent &&
        cluster.kind === signal.kind &&
        cluster.signals[0]?.signature === signal.signature,
    );
    if (clusters.some((cluster) => cluster.signalIds.includes(signalId))) return;
    const available = clusters.find((cluster) => cluster.signalIds.length < 100);
    const signalIds = available ? [...available.signalIds, signalId] : [signalId];
    this.confirm(principal, {
      id: available?.id ?? crypto.randomUUID(),
      signalIds,
      citations: signalIds,
      reason: `Matched developer-defined signature: ${signal.signature}`,
    });
  }

  confirm(
    principal: Principal,
    input: { id: string; signalIds: string[]; citations: string[]; reason: string },
  ): SignalCluster {
    invariant(
      input.signalIds.length > 0 && input.signalIds.length <= 100 && input.reason.length > 0,
      "INVALID_INPUT",
      "Confirm 1–100 signals with a reason and citations.",
    );
    const signals = input.signalIds.map((id) => this.readSignal(principal, id));
    const first = signals[0]!;
    this.access.require(principal, first.workspaceId, "write");
    invariant(
      signals.every(
        (signal) =>
          signal.workspaceId === first.workspaceId &&
          signal.agent === first.agent &&
          signal.kind === first.kind,
      ),
      "INVALID_INPUT",
      "Keep signal meanings, agents and authorization scopes separate.",
    );
    invariant(
      input.signalIds.every((id) => input.citations.includes(id)) &&
        input.citations.every((id) => input.signalIds.includes(id)),
      "INVALID_INPUT",
      "Every cluster member needs an exact source citation.",
    );
    return this.store.transaction(() => {
      for (const cluster of this.store.list<SignalCluster>("signal_clusters"))
        invariant(
          cluster.id === input.id || !cluster.signalIds.some((id) => input.signalIds.includes(id)),
          "STALE_REVISION",
          "A signal already belongs to another confirmed cluster. Review its membership first.",
        );
      const previous = this.store.get<SignalCluster>("signal_clusters", input.id);
      invariant(
        !previous || previous.workspaceId === first.workspaceId,
        "ACCESS_DENIED",
        "This cluster identity belongs to another workspace.",
      );
      const cluster: SignalCluster = {
        ...input,
        workspaceId: first.workspaceId,
        agent: first.agent,
        kind: first.kind,
        confirmed: true,
      };
      this.store.put("signal_clusters", input.id, cluster);
      return cluster;
    });
  }
  private readSignal(principal: Principal, id: string): FeedbackSignal {
    const signal = this.store.get<FeedbackSignal>("feedback", id);
    invariant(
      signal && this.access.visible(principal, signal.workspaceId, signal.lineage),
      "NOT_FOUND",
      "No accessible signal exists with that reference.",
    );
    return signal;
  }
  private signals(principal: Principal, workspaceId: string): FeedbackSignal[] {
    return this.store
      .list<FeedbackSignal>("feedback")
      .filter(
        (signal) =>
          signal.workspaceId === workspaceId &&
          this.access.visible(principal, workspaceId, signal.lineage),
      );
  }
}
function cosine(a?: number[], b?: number[]): number {
  if (
    !a?.length ||
    a.length !== b?.length ||
    !a.every(Number.isFinite) ||
    !b.every(Number.isFinite)
  )
    return -1;
  const dot = a.reduce((sum, value, index) => sum + value * b[index]!, 0);
  const norm = Math.sqrt(
    a.reduce((sum, value) => sum + value * value, 0) *
      b.reduce((sum, value) => sum + value * value, 0),
  );
  return norm ? dot / norm : -1;
}
