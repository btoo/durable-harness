import type { ValueGraph } from "./codec.js";

export interface Principal {
  id: string;
  deploymentId: string;
  roles: ("customer" | "developer")[];
}
export type Permission = "read" | "write" | "publish" | "execute";
export interface Grant {
  principalId: string;
  permissions: Permission[];
}
export interface KnowledgeSpace {
  id: string;
  deploymentId: string;
  kind: "session" | "tenant" | "shared" | "library";
  label: string;
  grants: Grant[];
  revision: number;
}
export interface SourceRef {
  spaceId: string;
  itemId: string;
}
export interface FunctionModule {
  name: string;
  version: string;
  source: string;
  dependencies: Record<string, string>;
}
export interface WorkspaceSnapshot {
  revision: number;
  graph: ValueGraph;
  functions: Record<string, FunctionModule>;
  modules?: Record<string, FunctionModule>;
  lineage: SourceRef[];
}
export type CellStatus =
  | "running"
  | "interrupted"
  | "committed"
  | "failed"
  | "waiting_approval"
  | "waiting_connection"
  | "uncertain";
export interface CellRecord {
  id: string;
  workspaceId: string;
  principalId: string;
  source: string;
  starting: WorkspaceSnapshot;
  status: CellStatus;
  createdAt: string;
  updatedAt: string;
  attempt: number;
  error?: { code: string; message: string };
  committedRevision?: number;
}
export interface ToolDefinition {
  name: string;
  version: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effect: "read" | "idempotent" | "external";
  spaceId: string;
  publicActivity: string;
  requiresApproval?: boolean;
  execute: (input: unknown, context: ToolContext) => Promise<unknown>;
  reconcile?: (
    operationId: string,
    input: unknown,
  ) => Promise<{ found: boolean; result?: unknown }>;
}
export interface ToolContext {
  principal: Principal;
  operationId: string;
  workspaceId: string;
  recordSources(sources: SourceRef[]): void;
}
export interface OperationRecord {
  id: string;
  cellId: string;
  sequence: number;
  tool: string;
  toolVersion: string;
  input: ValueGraph;
  status: "pending_approval" | "approved" | "executing" | "completed" | "failed" | "uncertain";
  result?: ValueGraph;
  error?: string;
  approvedBy?: string;
  lineage?: SourceRef[];
}
export interface HarnessEvent {
  id: string;
  sequence: number;
  workspaceId: string;
  kind: string;
  audience: "customer" | "developer";
  createdAt: string;
  text: string;
  data: Record<string, unknown>;
  lineage: SourceRef[];
}
export interface RecordStore {
  get<T>(collection: string, id: string): T | undefined;
  put<T>(collection: string, id: string, value: T): void;
  list<T>(collection: string): T[];
  delete(collection: string, id: string): void;
  transaction<T>(fn: () => T): T;
  afterCommit(fn: () => void): void;
  search?<T>(collection: string, query: string, allowedIds: string[], limit: number): T[];
}
export interface CellExecutor {
  execute(
    code: string,
    invoke: (name: string, input: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}
export interface Budget {
  maxOperations: number;
  maxSourceBytes: number;
  maxStateBytes: number;
}
export const DEFAULT_CELL_BUDGET: Budget = {
  maxOperations: 64,
  maxSourceBytes: 64_000,
  maxStateBytes: 1_000_000,
};
