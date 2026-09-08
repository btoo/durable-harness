import { decodeGraph, encodeGraph, type ValueGraph } from "./codec.js";
import { invariant } from "./errors.js";
import { AccessPolicy } from "./policy.js";
import type { Principal, RecordStore, SourceRef } from "./types.js";

export interface MemoryEntry {
  id: string;
  spaceId: string;
  title: string;
  kind: "fact" | "preference" | "instruction" | "procedure";
  value: ValueGraph;
  revision: number;
  lineage: SourceRef[];
  authorId: string;
  updatedAt: string;
  publicationId?: string;
}
export interface SharingRule {
  id: string;
  sourceSpaceId: string;
  targetSpaceId: string;
  fields: string[];
}
export interface MemoryWrite {
  id?: string;
  spaceId: string;
  title: string;
  kind: MemoryEntry["kind"];
  value: unknown;
  expectedRevision?: number;
}

export class Memory {
  private readonly policy: AccessPolicy;
  constructor(
    private readonly store: RecordStore,
    private readonly sharingRules: readonly SharingRule[] = [],
  ) {
    this.policy = new AccessPolicy(store);
  }

  read(principal: Principal, id: string): MemoryEntry {
    const entry = this.store.get<MemoryEntry>("memories", id);
    invariant(
      entry && this.policy.visible(principal, entry.spaceId, entry.lineage),
      "NOT_FOUND",
      "No accessible memory exists with that reference.",
    );
    return entry;
  }
  list(principal: Principal, spaceId: string): MemoryEntry[] {
    this.policy.require(principal, spaceId, "read");
    return this.store
      .list<MemoryEntry>("memories")
      .filter(
        (entry) =>
          entry.spaceId === spaceId && this.policy.visible(principal, spaceId, entry.lineage),
      );
  }
  write(principal: Principal, input: MemoryWrite, lineage: SourceRef[]): MemoryEntry {
    this.policy.require(principal, input.spaceId, "write");
    this.policy.requireSources(principal, lineage);
    invariant(
      input.title.length > 0 && input.title.length <= 160,
      "INVALID_INPUT",
      "Memory titles must contain 1–160 characters.",
    );
    const value = encodeGraph({ value: input.value });
    invariant(
      JSON.stringify(value).length <= 64_000,
      "BUDGET_EXCEEDED",
      "This memory is too large. Keep an artifact reference instead.",
    );
    return this.store.transaction(() => {
      const id = input.id ?? crypto.randomUUID();
      const previous = this.store.get<MemoryEntry>("memories", id);
      if (previous) {
        this.read(principal, id);
        invariant(
          previous.spaceId === input.spaceId,
          "INVALID_INPUT",
          "Use publication to create a memory in another space.",
        );
        invariant(
          input.expectedRevision === previous.revision,
          "STALE_REVISION",
          "This memory changed. Read its latest revision before editing.",
        );
      } else
        invariant(
          input.expectedRevision === undefined || input.expectedRevision === 0,
          "STALE_REVISION",
          "The expected memory revision does not exist.",
        );
      const inherited = [
        ...new Map(
          [...(previous?.lineage ?? []), ...lineage].map((source) => [
            `${source.spaceId}:${source.itemId}`,
            source,
          ]),
        ).values(),
      ];
      const entry: MemoryEntry = {
        id,
        spaceId: input.spaceId,
        title: input.title,
        kind: input.kind,
        value,
        revision: (previous?.revision ?? 0) + 1,
        lineage: inherited,
        authorId: principal.id,
        updatedAt: new Date().toISOString(),
      };
      this.store.put("memories", id, entry);
      this.store.put("memory_versions", `${id}:${entry.revision}`, entry);
      return entry;
    });
  }

  /** A developer-authored structured projection is the only automatic declassification path. */
  publish(
    principal: Principal,
    memoryId: string,
    targetSpaceId: string,
    options: { ruleId?: string; reviewed?: boolean } = {},
  ): MemoryEntry {
    const source = this.read(principal, memoryId);
    this.policy.require(principal, source.spaceId, "publish");
    for (const dependency of source.lineage)
      this.policy.require(principal, dependency.spaceId, "publish");
    this.policy.require(principal, targetSpaceId, "write");
    const rule = this.sharingRules.find(
      (rule) =>
        rule.id === options.ruleId &&
        rule.sourceSpaceId === source.spaceId &&
        rule.targetSpaceId === targetSpaceId,
    );
    if (rule)
      invariant(
        source.lineage.every((dependency) => dependency.spaceId === rule.sourceSpaceId),
        "SHARING_REVIEW_REQUIRED",
        "This memory contains evidence from additional spaces and needs a publication review.",
      );
    invariant(
      rule || (options.reviewed && principal.roles.includes("developer")),
      "SHARING_REVIEW_REQUIRED",
      "Publishing this knowledge requires a matching developer policy or developer review.",
    );
    const original = decodeGraph(source.value).value;
    let projection = original;
    if (rule) {
      invariant(
        original && typeof original === "object" && !Array.isArray(original),
        "INVALID_INPUT",
        "This sharing rule requires structured data.",
      );
      projection = Object.fromEntries(
        rule.fields
          .filter((field) => Object.hasOwn(original, field))
          .map((field) => [field, (original as Record<string, unknown>)[field]]),
      );
    }
    return this.store.transaction(() => {
      const receiptId = crypto.randomUUID();
      const entry = this.write(
        principal,
        { spaceId: targetSpaceId, title: source.title, kind: source.kind, value: projection },
        [],
      );
      const published = { ...entry, publicationId: receiptId };
      this.store.put("memories", entry.id, published);
      this.store.put("memory_versions", `${entry.id}:${entry.revision}`, published);
      this.store.put("publications", receiptId, {
        id: receiptId,
        source: { spaceId: source.spaceId, itemId: source.id, revision: source.revision },
        sourceLineage: source.lineage,
        targetSpaceId,
        targetId: entry.id,
        ruleId: rule?.id ?? null,
        reviewedBy: rule ? null : principal.id,
        publisherId: principal.id,
        createdAt: new Date().toISOString(),
      });
      return published;
    });
  }
}
