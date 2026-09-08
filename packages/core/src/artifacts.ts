import { invariant } from "./errors.js";
import { AccessPolicy } from "./policy.js";
import type { Principal, RecordStore, SourceRef } from "./types.js";

export interface ArtifactHandle {
  kind: "artifact";
  id: string;
  spaceId: string;
  name: string;
  size: number;
  contentType: string;
}
export interface ArtifactRecord extends ArtifactHandle {
  key: string;
  hash: string;
  lineage: SourceRef[];
  createdAt: string;
}
export interface ArtifactBackend {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string, offset: number, length: number): Promise<Uint8Array>;
}
export type ArtifactWrite = { spaceId: string; name: string; contentType?: string } & (
  { text: string; bytes?: never } | { bytes: Uint8Array; text?: never }
);

export class Artifacts {
  private readonly policy: AccessPolicy;
  constructor(
    private readonly store: RecordStore,
    private readonly backend: ArtifactBackend,
  ) {
    this.policy = new AccessPolicy(store);
  }

  async write(
    principal: Principal,
    input: ArtifactWrite,
    lineage: SourceRef[],
    operationId: string,
  ): Promise<ArtifactHandle> {
    this.policy.require(principal, input.spaceId, "write");
    this.policy.requireSources(principal, lineage);
    invariant(
      typeof input.name === "string" && input.name.length > 0 && input.name.length <= 160,
      "INVALID_INPUT",
      "Artifact names must contain 1–160 characters.",
    );
    invariant(
      typeof input.text === "string" || input.bytes instanceof Uint8Array,
      "INVALID_INPUT",
      "Supply artifact text or Uint8Array bytes.",
    );
    const bytes = input.bytes ? new Uint8Array(input.bytes) : new TextEncoder().encode(input.text);
    invariant(
      bytes.length <= 10_000_000,
      "BUDGET_EXCEEDED",
      "Artifacts are limited to 10 MB in this experimental release.",
    );
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    this.policy.require(principal, input.spaceId, "write");
    this.policy.requireSources(principal, lineage);
    let record = this.store.get<ArtifactRecord>("artifact_requests", operationId);
    if (record) {
      invariant(
        record.hash === hash &&
          record.spaceId === input.spaceId &&
          record.name === input.name &&
          record.contentType === (input.contentType ?? "application/octet-stream"),
        "REPLAY_DIVERGENCE",
        "This artifact operation already has different content or metadata.",
      );
      this.policy.requireSources(principal, record.lineage);
    } else {
      const id = crypto.randomUUID();
      record = {
        kind: "artifact",
        id,
        spaceId: input.spaceId,
        name: input.name,
        size: bytes.length,
        contentType: input.contentType ?? "application/octet-stream",
        hash,
        key: `${encodeURIComponent(input.spaceId)}/${hash}`,
        lineage: [...lineage],
        createdAt: new Date().toISOString(),
      };
      this.store.put("artifact_requests", operationId, record);
    }
    if (!this.store.get("artifacts", record.id)) {
      await this.backend.put(record.key, bytes);
      this.policy.require(principal, record.spaceId, "write");
      this.policy.requireSources(principal, record.lineage);
      this.store.put("artifacts", record.id, record);
    }
    const { key: _key, hash: _hash, lineage: _lineage, createdAt: _createdAt, ...handle } = record;
    return handle;
  }
  metadata(principal: Principal, id: string): ArtifactRecord {
    const record = this.store.get<ArtifactRecord>("artifacts", id);
    invariant(
      record && this.policy.visible(principal, record.spaceId, record.lineage),
      "NOT_FOUND",
      "No accessible artifact exists with that reference.",
    );
    return record;
  }
  async read(principal: Principal, id: string, options: { offset?: number; length?: number } = {}) {
    const record = this.metadata(principal, id);
    const offset = options.offset ?? 0;
    const length = options.length ?? 16_000;
    invariant(
      Number.isInteger(offset) &&
        offset >= 0 &&
        Number.isInteger(length) &&
        length > 0 &&
        length <= 64_000,
      "INVALID_INPUT",
      "Use a nonnegative byte offset and a length between 1 and 64,000.",
    );
    const bytes =
      offset >= record.size
        ? new Uint8Array()
        : await this.backend.get(record.key, offset, Math.min(length, record.size - offset));
    this.metadata(principal, id);
    return {
      id,
      name: record.name,
      size: record.size,
      offset,
      bytes,
      text: new TextDecoder().decode(bytes),
      nextOffset: offset + bytes.length < record.size ? offset + bytes.length : null,
      lineage: record.lineage,
      spaceId: record.spaceId,
    };
  }
}
