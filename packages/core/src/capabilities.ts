import { contentHash, validateModuleSource } from "./compiler.js";
import { invariant } from "./errors.js";
import { AccessPolicy } from "./policy.js";
import type {
  FunctionModule,
  Principal,
  RecordStore,
  SourceRef,
  ToolDefinition,
  WorkspaceSnapshot,
} from "./types.js";

export interface CapabilityProgram {
  entry: FunctionModule;
  modules: Record<string, FunctionModule>;
}
export interface CapabilityProtocol {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
  arguments(input: unknown): unknown[];
  cases: { id: string; input: unknown; expected: unknown }[];
  assess(output: unknown, expected: unknown): boolean;
}
export interface CapabilityRecord {
  id: string;
  name: string;
  spaceId: string;
  protocolId: string;
  program: CapabilityProgram;
  hash: string;
  lineage: SourceRef[];
  status: "proposed" | "evaluated" | "approved" | "published" | "revoked";
  baseRevision: number;
  revision: number;
  sourceId?: string;
  evaluation?: { hash: string; protocolHash: string; checks: { id: string; passed: boolean }[] };
}
export interface CapabilityExecutor {
  run(program: CapabilityProgram, args: unknown[]): Promise<unknown>;
}

/** Code approval and broader publication are independent, versioned decisions. */
export class Capabilities {
  private readonly policy: AccessPolicy;
  private readonly protocols: Map<string, CapabilityProtocol>;
  constructor(
    private readonly store: RecordStore,
    private readonly executor: CapabilityExecutor,
    protocols: CapabilityProtocol[],
  ) {
    this.policy = new AccessPolicy(store);
    this.protocols = new Map(protocols.map((protocol) => [protocol.id, protocol]));
    for (const protocol of protocols)
      invariant(
        protocol.cases.length > 0 && protocol.cases.length <= 20,
        "INVALID_INPUT",
        "Register 1–20 authoritative cases for each capability protocol.",
      );
  }
  async propose(
    principal: Principal,
    input: { spaceId: string; helperName: string; name: string; protocolId: string },
  ): Promise<CapabilityRecord> {
    this.policy.require(principal, input.spaceId, "write");
    invariant(
      /^[a-z][a-z0-9-]{0,60}$/.test(input.name),
      "INVALID_INPUT",
      "Use a short lowercase capability name with optional hyphens.",
    );
    this.protocol(input.protocolId);
    const workspace = this.store.get<WorkspaceSnapshot>("workspaces", input.spaceId);
    const entry = workspace?.functions[input.helperName];
    invariant(workspace && entry, "NOT_FOUND", "Choose a retained helper from this workspace.");
    this.policy.requireSources(principal, workspace.lineage);
    const archive = {
      ...workspace.modules,
      ...Object.fromEntries(
        Object.values(workspace.functions).map((module) => [module.version, module]),
      ),
    };
    const modules: Record<string, FunctionModule> = {};
    const visit = (module: FunctionModule) => {
      if (modules[module.version]) return;
      validateModuleSource(module, false);
      modules[module.version] = module;
      for (const version of Object.values(module.dependencies)) {
        invariant(archive[version], "NOT_FOUND", "A pinned helper dependency is unavailable.");
        visit(archive[version]);
      }
    };
    visit(entry);
    const program = { entry, modules };
    const hash = await contentHash(JSON.stringify(program));
    this.policy.require(principal, input.spaceId, "write");
    this.policy.requireSources(principal, workspace.lineage);
    const record: CapabilityRecord = {
      id: crypto.randomUUID(),
      name: input.name,
      spaceId: input.spaceId,
      protocolId: input.protocolId,
      program,
      hash,
      lineage: workspace.lineage,
      status: "proposed",
      baseRevision: this.current(input.spaceId, input.name)?.revision ?? 0,
      revision: 0,
    };
    this.store.put("capabilities", record.id, record);
    return record;
  }
  read(principal: Principal, id: string): CapabilityRecord {
    const record = this.store.get<CapabilityRecord>("capabilities", id);
    invariant(
      record && this.policy.visible(principal, record.spaceId, record.lineage),
      "NOT_FOUND",
      "No accessible capability exists with that reference.",
    );
    return record;
  }
  list(principal: Principal): CapabilityRecord[] {
    return this.store
      .list<CapabilityRecord>("capabilities")
      .filter((record) => this.policy.visible(principal, record.spaceId, record.lineage));
  }
  async evaluate(principal: Principal, id: string): Promise<CapabilityRecord> {
    const record = this.read(principal, id);
    this.policy.require(principal, record.spaceId, "write");
    invariant(
      record.status === "proposed" || record.status === "evaluated",
      "INVALID_INPUT",
      "This capability is already settled.",
    );
    const protocol = this.protocol(record.protocolId);
    const checks: { id: string; passed: boolean }[] = [];
    for (const testCase of protocol.cases) {
      this.policy.requireSources(principal, record.lineage);
      let passed = false;
      try {
        const output = await this.executor.run(record.program, protocol.arguments(testCase.input));
        passed = protocol.assess(output, testCase.expected);
      } catch {
        passed = false;
      }
      checks.push({ id: testCase.id, passed });
    }
    this.policy.require(principal, record.spaceId, "write");
    this.policy.requireSources(principal, record.lineage);
    const protocolHash = await this.protocolHash(protocol);
    return this.store.transaction(() => {
      const current = this.read(principal, id);
      invariant(
        (current.status === "proposed" || current.status === "evaluated") &&
          current.hash === record.hash,
        "STALE_REVISION",
        "This capability changed while its checks were running.",
      );
      const evaluated: CapabilityRecord = {
        ...record,
        status: "evaluated",
        evaluation: { hash: record.hash, protocolHash, checks },
      };
      this.store.put("capabilities", id, evaluated);
      return evaluated;
    });
  }
  async approve(principal: Principal, id: string): Promise<CapabilityRecord> {
    const record = this.read(principal, id);
    this.requireReviewer(principal, record.spaceId);
    const protocol = this.protocol(record.protocolId);
    invariant(
      record.status === "evaluated" &&
        record.evaluation?.hash === record.hash &&
        record.evaluation.protocolHash === (await this.protocolHash(protocol)) &&
        record.evaluation.checks.length > 0 &&
        record.evaluation.checks.every((check) => check.passed),
      "EVALUATION_REQUIRED",
      "This exact capability must pass the current protocol's checks before approval.",
    );
    return this.store.transaction(() => {
      this.requireReviewer(principal, record.spaceId);
      invariant(
        (this.current(record.spaceId, record.name)?.revision ?? 0) === record.baseRevision,
        "STALE_REVISION",
        "This capability name changed during review. Propose and evaluate against its current revision.",
      );
      const approved: CapabilityRecord = {
        ...record,
        status: "approved",
        revision: record.baseRevision + 1,
      };
      this.store.put("capabilities", id, approved);
      this.store.put("capability_heads", `${record.spaceId}:${record.name}`, { id });
      return approved;
    });
  }
  publish(
    principal: Principal,
    id: string,
    targetSpaceId: string,
    expectedRevision: number,
  ): CapabilityRecord {
    const record = this.read(principal, id);
    this.requireReviewer(principal, record.spaceId);
    this.requireReviewer(principal, targetSpaceId);
    invariant(
      record.status === "approved" || record.status === "published",
      "APPROVAL_REQUIRED",
      "Approve executable behavior before reviewing its broader publication.",
    );
    return this.store.transaction(() => {
      invariant(
        (this.current(targetSpaceId, record.name)?.revision ?? 0) === expectedRevision,
        "STALE_REVISION",
        "The shared capability changed. Review its current version before publishing.",
      );
      const published: CapabilityRecord = {
        ...record,
        id: crypto.randomUUID(),
        sourceId: record.id,
        spaceId: targetSpaceId,
        lineage: [],
        status: "published",
        baseRevision: expectedRevision,
        revision: expectedRevision + 1,
      };
      // Private provenance stays in an operator audit record, outside the shared artifact.
      const { sourceId, ...shared } = published;
      this.store.put("capability_publications", published.id, {
        id: published.id,
        sourceId,
        sourceSpaceId: record.spaceId,
        targetSpaceId,
        reviewerId: principal.id,
      });
      this.store.put("capabilities", published.id, shared);
      this.store.put("capability_heads", `${targetSpaceId}:${record.name}`, { id: published.id });
      return shared;
    });
  }
  definitions(): ToolDefinition[] {
    return this.store
      .list<CapabilityRecord>("capabilities")
      .sort((a, b) => b.revision - a.revision)
      .flatMap((record) => {
        if (!["approved", "published"].includes(record.status)) return [];
        const protocol = this.protocol(record.protocolId);
        return [
          {
            name: `capability.${record.spaceId}.${record.name}.v${record.revision}`,
            version: record.hash,
            spaceId: record.spaceId,
            description: protocol.description,
            inputSchema: protocol.inputSchema,
            effect: "read",
            publicActivity: "Applying a reviewed comparison capability",
            execute: async (input, context) => {
              const current = this.read(context.principal, record.id);
              invariant(
                current.status !== "revoked",
                "ACCESS_DENIED",
                "This capability was revoked.",
              );
              context.recordSources(current.lineage);
              const result = await this.executor.run(current.program, protocol.arguments(input));
              this.read(context.principal, current.id);
              invariant(
                this.store.get<CapabilityRecord>("capabilities", current.id)?.status !== "revoked",
                "ACCESS_DENIED",
                "Capability access changed during execution.",
              );
              return result;
            },
          } satisfies ToolDefinition,
        ];
      });
  }
  revoke(principal: Principal, id: string): void {
    const record = this.read(principal, id);
    this.requireReviewer(principal, record.spaceId);
    this.store.put("capabilities", id, { ...record, status: "revoked" });
  }
  private current(spaceId: string, name: string): CapabilityRecord | undefined {
    const head = this.store.get<{ id: string }>("capability_heads", `${spaceId}:${name}`);
    return head ? this.store.get<CapabilityRecord>("capabilities", head.id) : undefined;
  }
  private protocol(id: string): CapabilityProtocol {
    const protocol = this.protocols.get(id);
    invariant(protocol, "NOT_FOUND", "Choose a developer-registered capability protocol.");
    return protocol;
  }
  private protocolHash(protocol: CapabilityProtocol): Promise<string> {
    return contentHash(JSON.stringify([protocol.id, protocol.inputSchema, protocol.cases]));
  }
  private requireReviewer(principal: Principal, spaceId: string): void {
    invariant(
      principal.roles.includes("developer"),
      "ACCESS_DENIED",
      "Executable capability review requires a developer.",
    );
    this.policy.require(principal, spaceId, "publish");
  }
}
