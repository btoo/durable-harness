import { decodeGraph, emptyGraph, encodeGraph, type ValueGraph } from "./codec.js";
import { compileCell, contentHash } from "./compiler.js";
import { asFault, HarnessFault, invariant } from "./errors.js";
import { EventLog, History } from "./history.js";
import { AccessPolicy } from "./policy.js";
import { Memory, type MemoryWrite } from "./memory.js";
import type { Artifacts, ArtifactWrite } from "./artifacts.js";
import { Validator } from "@cfworker/json-schema";
import {
  DEFAULT_CELL_BUDGET,
  type Budget,
  type CellExecutor,
  type CellRecord,
  type OperationRecord,
  type Principal,
  type RecordStore,
  type SourceRef,
  type ToolDefinition,
  type WorkspaceSnapshot,
} from "./types.js";

export interface ExecuteCellOptions {
  id?: string;
  expectedRevision?: number;
  budget?: Partial<Budget>;
}
export interface CellResult {
  cell: CellRecord;
  workspace: WorkspaceSnapshot;
}

export class DurableWorkspace {
  readonly access: AccessPolicy;
  readonly history: History;
  readonly events: EventLog;
  private readonly toolDefinitions: () => ToolDefinition[];
  private get tools() {
    return new Map(this.toolDefinitions().map((tool) => [tool.name, tool]));
  }
  private readonly active = new Set<string>();

  constructor(
    readonly store: RecordStore,
    private readonly executor: CellExecutor,
    options: {
      tools?: ToolDefinition[] | (() => ToolDefinition[]);
      memory?: Memory;
      artifacts?: Artifacts;
      publish?: ConstructorParameters<typeof EventLog>[1];
      beforeOperation?: () => Promise<void>;
    } = {},
  ) {
    this.access = new AccessPolicy(store);
    this.history = new History(store);
    this.events = new EventLog(store, options.publish);
    this.beforeOperation = options.beforeOperation;
    this.memory = options.memory ?? new Memory(store);
    this.artifacts = options.artifacts;
    const tools = options.tools ?? [];
    this.toolDefinitions = typeof tools === "function" ? tools : () => tools;
  }
  private readonly beforeOperation: (() => Promise<void>) | undefined;
  private readonly memory: Memory;
  private readonly artifacts: Artifacts | undefined;

  snapshot(principal: Principal, workspaceId: string): WorkspaceSnapshot {
    this.access.require(principal, workspaceId, "read");
    const snapshot = this.store.get<WorkspaceSnapshot>("workspaces", workspaceId) ?? {
      revision: 0,
      graph: emptyGraph(),
      functions: {},
      lineage: [],
    };
    this.access.requireSources(principal, snapshot.lineage);
    return snapshot;
  }

  inspect(principal: Principal, workspaceId: string) {
    const snapshot = this.snapshot(principal, workspaceId);
    const data = decodeGraph(snapshot.graph);
    return {
      revision: snapshot.revision,
      bindings: Object.entries(data).map(([name, value]) => ({
        name,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        preview: describeValue(value),
      })),
      functions: Object.values(snapshot.functions).map(({ name, version, dependencies }) => ({
        name,
        version,
        dependencies,
      })),
    };
  }

  readBinding(
    principal: Principal,
    workspaceId: string,
    name: string,
    path: (string | number)[] = [],
  ): ValueGraph {
    const snapshot = this.snapshot(principal, workspaceId);
    const values = decodeGraph(snapshot.graph);
    invariant(
      Object.hasOwn(values, name),
      "NOT_FOUND",
      "No retained binding exists with that name.",
    );
    let value = values[name];
    for (const key of path) {
      invariant(
        value !== null && typeof value === "object" && Object.hasOwn(value, key),
        "NOT_FOUND",
        "This binding has no value at the requested path.",
      );
      value = (value as Record<string | number, unknown>)[key];
    }
    const graph = encodeGraph({ value });
    invariant(
      JSON.stringify(graph).length <= 16_000,
      "BUDGET_EXCEEDED",
      "This value is too large to inspect at once. Read a narrower path or retain a bounded projection in a cell.",
    );
    return graph;
  }

  operations(principal: Principal, workspaceId: string, cellId: string): OperationRecord[] {
    this.access.require(principal, workspaceId, "read");
    const cell = this.store.get<CellRecord>("cells", cellId);
    invariant(
      cell?.workspaceId === workspaceId,
      "NOT_FOUND",
      "No accessible cell exists with that ID.",
    );
    this.access.requireSources(principal, cell.starting.lineage);
    invariant(
      principal.roles.includes("developer"),
      "ACCESS_DENIED",
      "Operation diagnostics require developer access.",
    );
    const operations = this.store
      .list<OperationRecord>("operations")
      .filter((operation) => operation.cellId === cellId)
      .sort((a, b) => a.sequence - b.sequence);
    this.access.requireSources(
      principal,
      operations.flatMap((operation) => operation.lineage ?? []),
    );
    return operations;
  }

  async execute(
    principal: Principal,
    workspaceId: string,
    source: string,
    options: ExecuteCellOptions = {},
  ): Promise<CellResult> {
    await this.beforeOperation?.();
    this.access.require(principal, workspaceId, "write");
    const budget = { ...DEFAULT_CELL_BUDGET, ...options.budget };
    invariant(
      new TextEncoder().encode(source).length <= budget.maxSourceBytes,
      "BUDGET_EXCEEDED",
      "This cell is too large. Split it into smaller cells.",
    );
    const id = options.id ?? crypto.randomUUID();
    let cell = this.store.get<CellRecord>("cells", id);
    if (cell) {
      invariant(
        cell.workspaceId === workspaceId &&
          cell.principalId === principal.id &&
          cell.source === source,
        "INVALID_INPUT",
        "This cell ID already belongs to a different request.",
      );
      if (cell.status === "committed") {
        const workspace = this.store.get<WorkspaceSnapshot>(
          "workspace_revisions",
          `${workspaceId}:${cell.committedRevision}`,
        )!;
        this.access.requireSources(principal, workspace.lineage);
        return { cell, workspace };
      }
      invariant(
        !this.active.has(workspaceId),
        "WORKSPACE_BUSY",
        "A cell is currently executing in this workspace.",
      );
      invariant(
        cell.status !== "failed",
        "INVALID_CELL",
        "This cell failed terminally. Correct the source and submit a new cell.",
      );
      this.access.requireSources(principal, cell.starting.lineage);
    } else {
      const snapshot = this.snapshot(principal, workspaceId);
      invariant(
        options.expectedRevision === undefined || options.expectedRevision === snapshot.revision,
        "STALE_REVISION",
        "The workspace changed. Inspect its current revision before submitting this cell.",
      );
      const lock = this.store.get<string>("locks", workspaceId);
      invariant(
        !lock,
        "WORKSPACE_BUSY",
        "An unsettled cell owns this workspace. Resume or resolve it before starting another.",
      );
      const now = new Date().toISOString();
      cell = {
        id,
        workspaceId,
        principalId: principal.id,
        source,
        starting: snapshot,
        status: "running",
        createdAt: now,
        updatedAt: now,
        attempt: 0,
      };
      this.store.transaction(() => {
        this.store.put("cells", id, cell);
        this.store.put("locks", workspaceId, id);
      });
    }
    this.active.add(workspaceId);
    cell = {
      ...cell,
      status: "running",
      attempt: cell.attempt + 1,
      updatedAt: new Date().toISOString(),
    };
    delete cell.error;
    this.store.put("cells", id, cell);
    this.events.append({
      workspaceId,
      kind: cell.attempt > 1 ? "cell.resumed" : "cell.started",
      audience: "developer",
      text:
        cell.attempt > 1 ? "Resuming the interrupted code cell" : "Executing a durable code cell",
      data: { cellId: id, startingRevision: cell.starting.revision },
      lineage: cell.starting.lineage,
    });
    const lineage: SourceRef[] = [...cell.starting.lineage];
    let sequence = 0;
    try {
      const compiled = await compileCell(source, cell.starting);
      const result = await this.executor.execute(compiled.code, async (name, input) => {
        await this.beforeOperation?.();
        this.access.require(principal, workspaceId, "write");
        this.access.requireSources(principal, lineage);
        invariant(
          ++sequence <= budget.maxOperations,
          "BUDGET_EXCEEDED",
          "The cell reached its operation budget. Split the remaining work into another cell.",
        );
        const tool = this.resolveTool(name, principal, workspaceId, lineage);
        this.access.require(principal, tool.spaceId, "execute");
        const validation = new Validator(tool.inputSchema).validate(input ?? {});
        invariant(
          validation.valid,
          "INVALID_INPUT",
          `Invalid input for ${name}: ${validation.errors.map((error) => error.error).join("; ")}`,
        );
        const operationId = `${id}:${sequence}`;
        const encodedInput = encodeGraph({ input });
        let operation = this.store.get<OperationRecord>("operations", operationId);
        if (operation) {
          invariant(
            operation.tool === name &&
              operation.toolVersion === tool.version &&
              JSON.stringify(operation.input) === JSON.stringify(encodedInput),
            "REPLAY_DIVERGENCE",
            `Operation ${sequence} differs from the recorded execution. No new action was applied.`,
          );
          if (operation.status === "completed") {
            this.access.requireSources(principal, operation.lineage ?? []);
            lineage.push(...(operation.lineage ?? []));
            return decodeGraph(operation.result!).result;
          }
          if (operation.status === "failed")
            throw new HarnessFault(
              "INVALID_CELL",
              operation.error ?? "The recorded operation failed.",
            );
          if (
            (operation.status === "executing" || operation.status === "uncertain") &&
            tool.effect === "external"
          ) {
            const reconciled = await tool.reconcile?.(operationId, input);
            if (reconciled?.found) {
              lineage.push({ spaceId: tool.spaceId, itemId: operationId });
              operation = {
                ...operation,
                status: "completed",
                result: encodeGraph({ result: reconciled.result }),
                lineage: uniqueSources(lineage),
              };
              this.store.put("operations", operationId, operation);
              return reconciled.result;
            }
            this.store.put("operations", operationId, { ...operation, status: "uncertain" });
            throw new HarnessFault(
              "EFFECT_UNCERTAIN",
              "The previous action may have completed. Reconcile it before retrying.",
            );
          }
          if (operation.status === "pending_approval")
            throw new HarnessFault("APPROVAL_REQUIRED", "This action is waiting for approval.");
        } else {
          operation = {
            id: operationId,
            cellId: id,
            sequence,
            tool: name,
            toolVersion: tool.version,
            input: encodedInput,
            status: tool.requiresApproval ? "pending_approval" : "approved",
            lineage: uniqueSources(lineage),
          };
          this.store.put("operations", operationId, operation);
          if (tool.requiresApproval) {
            this.events.append({
              workspaceId,
              kind: "action.awaiting_approval",
              audience: "customer",
              text: "An action is ready for your approval",
              data: { operationId, tool: name },
              lineage: [...lineage],
            });
            throw new HarnessFault("APPROVAL_REQUIRED", "This action is waiting for approval.");
          }
        }
        if (tool.prepare)
          await tool.prepare(input, {
            principal,
            operationId,
            workspaceId,
            recordSources: (sources) => {
              this.access.requireSources(principal, sources);
              lineage.push(...sources);
            },
          });
        operation = { ...operation, status: "executing" };
        this.store.put("operations", operationId, operation);
        this.events.append({
          workspaceId,
          kind: "operation.started",
          audience: "customer",
          text: tool.publicActivity,
          data: { operationId },
          lineage: [...lineage],
        });
        try {
          const output = await tool.execute(input, {
            principal,
            operationId,
            workspaceId,
            recordSources: (sources) => {
              this.access.requireSources(principal, sources);
              lineage.push(...sources);
            },
          });
          if (tool.outputSchema) {
            const validation = new Validator(tool.outputSchema).validate(output);
            invariant(
              validation.valid,
              "INVALID_TOOL_RESULT",
              `The ${name} result does not match its declared schema.`,
            );
          }
          // Serialization failure after a write is an uncertain effect, never permission to retry it.
          const encoded = encodeGraph({ result: output });
          lineage.push({ spaceId: tool.spaceId, itemId: operationId });
          this.store.put("operations", operationId, {
            ...operation,
            status: "completed",
            result: encoded,
            lineage: uniqueSources(lineage),
          });
          await this.beforeOperation?.();
          this.access.require(principal, workspaceId, "read");
          this.access.requireSources(principal, lineage);
          this.events.append({
            workspaceId,
            kind: "operation.completed",
            audience: "customer",
            text: "Action completed",
            data: { operationId },
            lineage: [...lineage],
          });
          this.history.append({
            id: `operation:${operationId}`,
            workspaceId,
            role: "tool",
            text: JSON.stringify({ tool: name, input: encodedInput, result: encoded }),
            audience: "developer",
            lineage: [...lineage],
            metadata: { cellId: id, operationId },
          });
          return output;
        } catch (error) {
          const fault = asFault(error);
          // Delivery or diagnostics can fail after the result has settled. Never rewrite it.
          if (this.store.get<OperationRecord>("operations", operationId)?.status === "completed")
            throw fault;
          if (fault.code === "RECONNECTION_REQUIRED" && tool.effect !== "external") {
            this.store.put("operations", operationId, { ...operation, status: "approved" });
            throw fault;
          }
          const uncertain = tool.effect === "external";
          this.store.put("operations", operationId, {
            ...operation,
            status: uncertain ? "uncertain" : "failed",
            error: fault.message,
          });
          this.events.append({
            workspaceId,
            kind: uncertain ? "operation.uncertain" : "operation.failed",
            audience: "customer",
            text: uncertain
              ? "The action's outcome needs verification"
              : "The action could not be completed",
            data: { operationId },
            lineage: [...lineage],
          });
          if (uncertain)
            throw new HarnessFault(
              "EFFECT_UNCERTAIN",
              "The action may have completed. Its result must be reconciled.",
            );
          throw fault;
        }
      });
      invariant(
        !this.store
          .list<OperationRecord>("operations")
          .some((operation) => operation.cellId === id && operation.sequence > sequence),
        "REPLAY_DIVERGENCE",
        "This replay omitted a recorded operation. The workspace was not committed; inspect the execution journal.",
      );
      invariant(
        result && typeof result === "object" && "graph" in result,
        "INVALID_CELL",
        "The sandbox returned no valid commit result.",
      );
      const graph = (result as { graph: ValueGraph }).graph;
      decodeGraph(graph);
      invariant(
        JSON.stringify(graph).length <= budget.maxStateBytes,
        "BUDGET_EXCEEDED",
        "Retained state is too large. Write large data to an artifact and keep its handle.",
      );
      await this.beforeOperation?.();
      this.access.require(principal, workspaceId, "write");
      this.access.requireSources(principal, lineage);
      const workspace = this.store.transaction(() => {
        const current = this.store.get<WorkspaceSnapshot>("workspaces", workspaceId);
        invariant(
          (current?.revision ?? 0) === cell.starting.revision,
          "STALE_REVISION",
          "Workspace revision changed before commit.",
        );
        const snapshot: WorkspaceSnapshot = {
          revision: cell.starting.revision + 1,
          graph,
          functions: compiled.functions,
          modules: compiled.modules,
          lineage: uniqueSources(lineage),
        };
        const committed: CellRecord = {
          ...cell,
          status: "committed",
          committedRevision: snapshot.revision,
          updatedAt: new Date().toISOString(),
        };
        this.store.put("workspaces", workspaceId, snapshot);
        this.store.put("workspace_revisions", `${workspaceId}:${snapshot.revision}`, snapshot);
        this.store.put("cells", id, committed);
        this.store.delete("locks", workspaceId);
        return snapshot;
      });
      this.events.append({
        workspaceId,
        kind: "cell.committed",
        audience: "developer",
        text: `Workspace revision ${workspace.revision} committed`,
        data: { cellId: id, bindings: compiled.names },
        lineage: workspace.lineage,
      });
      return { cell: this.store.get<CellRecord>("cells", id)!, workspace };
    } catch (error) {
      const settled = this.store.get<CellRecord>("cells", id);
      if (settled?.status === "committed")
        return {
          cell: settled,
          workspace: this.store.get<WorkspaceSnapshot>(
            "workspace_revisions",
            `${workspaceId}:${settled.committedRevision}`,
          )!,
        };
      const fault = asFault(error);
      const status =
        fault.code === "APPROVAL_REQUIRED"
          ? "waiting_approval"
          : fault.code === "RECONNECTION_REQUIRED"
            ? "waiting_connection"
            : fault.code === "EFFECT_UNCERTAIN"
              ? "uncertain"
              : "failed";
      const failed: CellRecord = {
        ...cell,
        status,
        error: { code: fault.code, message: fault.message },
        updatedAt: new Date().toISOString(),
      };
      this.store.put("cells", id, failed);
      if (status === "failed") this.store.delete("locks", workspaceId);
      throw fault;
    } finally {
      this.active.delete(workspaceId);
    }
  }

  approve(principal: Principal, workspaceId: string, operationId: string): void {
    this.access.require(principal, workspaceId, "write");
    const operation = this.store.get<OperationRecord>("operations", operationId);
    const cell = operation && this.store.get<CellRecord>("cells", operation.cellId);
    invariant(
      operation && cell?.workspaceId === workspaceId,
      "NOT_FOUND",
      "No accessible action exists with that reference.",
    );
    this.access.requireSources(principal, [...cell.starting.lineage, ...(operation.lineage ?? [])]);
    invariant(
      operation.status === "pending_approval",
      "INVALID_INPUT",
      "This action is no longer awaiting approval.",
    );
    this.store.put("operations", operationId, {
      ...operation,
      status: "approved",
      approvedBy: principal.id,
    });
  }

  reject(principal: Principal, workspaceId: string, operationId: string): void {
    this.access.require(principal, workspaceId, "write");
    const operation = this.store.get<OperationRecord>("operations", operationId);
    const cell = operation && this.store.get<CellRecord>("cells", operation.cellId);
    invariant(
      operation?.status === "pending_approval" && cell?.workspaceId === workspaceId,
      "INVALID_INPUT",
      "This action is no longer awaiting approval.",
    );
    this.access.requireSources(principal, [...cell.starting.lineage, ...(operation.lineage ?? [])]);
    this.store.transaction(() => {
      this.store.put("operations", operationId, {
        ...operation,
        status: "failed",
        error: "The reviewer rejected this action.",
      });
      this.store.put("cells", cell.id, {
        ...cell,
        status: "failed",
        error: { code: "APPROVAL_REQUIRED", message: "The reviewer rejected this action." },
      });
      this.store.delete("locks", workspaceId);
    });
    this.events.append({
      workspaceId,
      kind: "action.rejected",
      audience: "customer",
      text: "The proposed action was rejected",
      data: { operationId },
      lineage: cell.starting.lineage,
    });
  }

  private resolveTool(
    name: string,
    principal: Principal,
    workspaceId: string,
    lineage: SourceRef[],
  ): ToolDefinition {
    const builtin = (
      execute: ToolDefinition["execute"],
      effect: ToolDefinition["effect"] = "read",
    ): ToolDefinition => ({
      name,
      version: "1",
      spaceId: workspaceId,
      description: name,
      publicActivity: "Working with task context",
      inputSchema: {},
      effect,
      execute,
    });
    if (name === "@runtime.now") return builtin(async () => new Date().toISOString());
    if (name === "@runtime.uuid") return builtin(async () => crypto.randomUUID());
    if (name === "@runtime.random") return builtin(async () => Math.random());
    if (name === "@runtime.progress")
      return builtin(async (input, context) => {
        const text = String((input as { text?: unknown })?.text ?? "").slice(0, 2000);
        // A progress message uses its operation identity so replay cannot publish it twice.
        this.store.transaction(() => {
          if (!this.store.get("progress", context.operationId)) {
            this.events.append({
              workspaceId,
              kind: "message.completed",
              audience: "customer",
              text,
              data: { operationId: context.operationId },
              lineage: [...lineage],
            });
            this.store.put("progress", context.operationId, true);
          }
        });
        return { recorded: true };
      }, "idempotent");
    if (name === "@history.search")
      return builtin(async (input) => {
        const items = this.history.search(principal, String((input as { query: unknown }).query), [
          workspaceId,
        ]);
        for (const item of items)
          lineage.push({ spaceId: item.workspaceId, itemId: item.id }, ...item.lineage);
        return items;
      });
    if (name === "@history.read" || name === "@history.around")
      return builtin(async (input) => {
        const id = String((input as { id: unknown }).id);
        const item = this.history.read(principal, id);
        const items = name.endsWith("around") ? this.history.around(principal, id) : [item];
        for (const entry of items)
          lineage.push({ spaceId: entry.workspaceId, itemId: entry.id }, ...entry.lineage);
        return name.endsWith("around") ? items : item;
      });
    if (name === "@memory.read")
      return builtin(async (input) => {
        const entry = this.memory.read(principal, String((input as { id: unknown }).id));
        lineage.push({ spaceId: entry.spaceId, itemId: entry.id }, ...entry.lineage);
        return { ...entry, value: decodeGraph(entry.value).value };
      });
    if (name === "@memory.write")
      return builtin(async (input, context) => {
        // The mutation receipt and memory revision settle in the same transaction.
        return this.store.transaction(() => {
          const previous = this.store.get("memory_operations", context.operationId);
          if (previous) return previous;
          const entry = this.memory.write(
            principal,
            { ...(input as MemoryWrite), spaceId: workspaceId },
            lineage,
          );
          this.store.put("memory_operations", context.operationId, entry);
          return entry;
        });
      }, "idempotent");
    if (name === "@artifacts.read")
      return builtin(async (input) => {
        invariant(
          this.artifacts,
          "NOT_CONFIGURED",
          "Configure an artifact backend to read large retained values.",
        );
        const options = input as { id: string; offset?: number; length?: number };
        const result = await this.artifacts.read(principal, options.id, options);
        lineage.push({ spaceId: result.spaceId, itemId: result.id }, ...result.lineage);
        return result;
      });
    if (name === "@artifacts.write")
      return builtin(async (input, context) => {
        invariant(
          this.artifacts,
          "NOT_CONFIGURED",
          "Configure an artifact backend to retain large values.",
        );
        return this.artifacts.write(
          principal,
          { ...(input as ArtifactWrite), spaceId: workspaceId },
          lineage,
          context.operationId,
        );
      }, "idempotent");
    if (name === "@tools.search")
      return builtin(async (input) => {
        const query = String((input as { query: unknown }).query).toLowerCase();
        return [...this.tools.values()]
          .filter(
            (tool) =>
              this.access.permits(principal, tool.spaceId, "execute") &&
              `${tool.name} ${tool.description}`.toLowerCase().includes(query),
          )
          .slice(0, 10)
          .map(({ name, description, version, effect }) => ({
            name,
            description,
            version,
            effect,
          }));
      });
    if (name === "@tools.describe")
      return builtin(async (input) => {
        const tool = this.tools.get(String((input as { name: unknown }).name));
        invariant(
          tool && this.access.permits(principal, tool.spaceId, "execute"),
          "NOT_FOUND",
          "No accessible tool exists with that name.",
        );
        const {
          execute: _execute,
          reconcile: _reconcile,
          prepare: _prepare,
          ...description
        } = tool;
        return description;
      });
    const tool = this.tools.get(name);
    invariant(
      tool,
      "NOT_FOUND",
      `Unknown capability ${name}. Search or describe available tools first.`,
    );
    return tool;
  }
}

function uniqueSources(sources: SourceRef[]): SourceRef[] {
  return [
    ...new Map(sources.map((source) => [`${source.spaceId}:${source.itemId}`, source])).values(),
  ];
}

function describeValue(value: unknown): string {
  if (value instanceof Uint8Array) return `${value.byteLength} bytes`;
  if (value instanceof Map || value instanceof Set)
    return `${value.constructor.name} (${value.size})`;
  if (Array.isArray(value)) return `Array (${value.length})`;
  if (value && typeof value === "object") return `{ ${Object.keys(value).slice(0, 8).join(", ")} }`;
  return String(value).slice(0, 160);
}
