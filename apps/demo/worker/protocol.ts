import { z } from "zod";
import type { DemoApplication } from "./application.js";
import type { HarnessThink } from "./think.js";

export interface DemoEnv {
  APPLICATIONS: DurableObjectNamespace;
  MODEL_AGENTS: DurableObjectNamespace<HarnessThink>;
  LOADER: WorkerLoader;
  ARTIFACTS: R2Bucket;
  ASSETS: Fetcher;
  AI: Ai;
  SESSION_SECRET: string;
  CREDENTIAL_KEY: string;
  ADMIN_TOKEN: string;
  DEMO_MODE: string;
  MODEL_ID: string;
  MCP_ALLOWED_ORIGINS?: string;
}
// Workers' RPC mapper cannot infer values that intentionally contain unknown data graphs.
// Keep the concrete public method contract while letting the transport serialize values.
export type ApplicationStub = DurableObjectStub &
  Pick<
    DemoApplication,
    | "state"
    | "command"
    | "apiState"
    | "apiCommand"
    | "mcpCallback"
    | "prepareRestart"
    | "restartNow"
    | "subscribe"
    | "modelContext"
    | "modelBinding"
    | "modelPrepared"
    | "modelActivate"
    | "modelReserve"
    | "modelSettle"
    | "modelStep"
    | "modelCell"
    | "modelEvent"
  >;
export function application(env: DemoEnv, sandbox: string): ApplicationStub {
  return env.APPLICATIONS.getByName(sandbox) as ApplicationStub;
}
export const personaSchema = z.enum(["northstar", "cedar", "developer"]);
export type Persona = z.infer<typeof personaSchema>;
export const commandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("mcp-add"),
    name: z.string().min(1).max(80),
    url: z.string().url().max(2000),
    auth: z.enum(["oauth", "bearer", "none"]),
    accessToken: z.string().min(1).max(8000).optional(),
  }),
  z.object({ action: z.literal("mcp-discover"), connectionId: z.string().uuid() }),
  z.object({ action: z.literal("mcp-revoke"), connectionId: z.string().uuid() }),
  z.object({
    action: z.literal("mcp-grant"),
    connectionId: z.string().uuid(),
    tools: z.array(z.string().min(1).max(200)).max(100),
    fingerprint: z.string().min(1),
  }),
  z.object({
    action: z.literal("mcp-call"),
    connectionId: z.string().uuid(),
    tool: z.string().min(1).max(200),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({ action: z.literal("run-synthetic") }),
  z.object({ action: z.literal("probe-model") }),
  z.object({ action: z.literal("seed-history") }),
  z.object({ action: z.literal("restart-runtime") }),
  z.object({ action: z.literal("prepare-message") }),
  z.object({
    action: z.literal("cell"),
    source: z.string().min(1).max(64_000),
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().uuid(),
  }),
  z.object({
    action: z.literal("correct"),
    preference: z.enum(["includeFreight", "businessDaysOnly"]),
    text: z.string().min(1).max(2000),
  }),
  z.object({ action: z.literal("approve"), operationId: z.string().min(1) }),
  z.object({ action: z.literal("reject"), operationId: z.string().min(1) }),
  z.object({ action: z.literal("resume"), cellId: z.string().min(1) }),
  z.object({ action: z.literal("compact") }),
  z.object({
    action: z.literal("model"),
    message: z.string().min(1).max(8000),
    requestId: z.string().uuid().optional(),
  }),
]);
export type DemoCommand = z.infer<typeof commandSchema>;
export interface ModelRequest {
  sandbox: string;
  workspaceId: string;
  principalId: string;
  rootId: string;
  message: string;
}
