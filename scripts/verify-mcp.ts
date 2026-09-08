import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { decodeGraph, type McpConnection, type WorkspaceSnapshot } from "@durable-harness/core";
import type { DemoState, Persona } from "../apps/demo/src/api.js";

const [base, fixture] = process.argv.slice(2);
assert(
  base && fixture && [base, fixture].every((url) => /^https:\/\/[^/]+\.workers\.dev$/.test(url)),
  "Pass the isolated application and fixture URLs.",
);
const operator = parseEnv(
  await readFile(new URL("../apps/demo/.dev.vars.deployed", import.meta.url), "utf8"),
);
const fixtureSecrets = parseEnv(
  await readFile(new URL("../apps/mcp-fixture/.dev.vars.deployed", import.meta.url), "utf8"),
);
let cookie = "";
async function api<T>(path: string, body?: object, privileged = false): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      cookie,
      "content-type": "application/json",
      ...(privileged ? { authorization: `Bearer ${operator.ADMIN_TOKEN}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
  });
  if (response.headers.has("set-cookie"))
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value as T;
}
const state = () => api<DemoState>("/api/state?workspace=northstar-quoting");
const command = <T>(body: object, privileged = false) =>
  api<T>("/api/command?workspace=northstar-quoting", body, privileged);
const identity = (persona: Persona) => api("/api/session", { persona });
const checks: string[] = [];
const deployment = await api("/api/health");
await identity("northstar");
const connection = await command<McpConnection>({
  action: "mcp-add",
  name: "Synthetic supplier catalog",
  url: `${fixture}/mcp`,
  auth: "oauth",
});
assert.equal(connection.state, "authorization_required");
async function authorize(connection: McpConnection) {
  assert(connection.authorizationUrl);
  const authUrl = new URL(connection.authorizationUrl);
  assert.equal(authUrl.origin, fixture);
  const consent = await fetch(authUrl, { redirect: "error" });
  assert.equal(consent.status, 200);
  const match = /name="consent" value="([a-f0-9-]+)"/.exec(await consent.text());
  assert(match);
  const fields = new FormData();
  fields.set("consent", match[1]!);
  const approved = await fetch(`${fixture}/authorize`, {
    method: "POST",
    body: fields,
    redirect: "manual",
  });
  assert.equal(approved.status, 303);
  const callback = new URL(approved.headers.get("location")!);
  assert.equal(callback.origin, base);
  assert.equal(callback.pathname, `/api/mcp/callback/${connection.id}`);
  const settled = await fetch(callback, { headers: { cookie }, redirect: "manual" });
  assert.equal(settled.status, 303, await settled.text());
  return (await state()).connections.find((value) => value.id === connection.id)!;
}
let ready = await authorize(connection);
assert.equal(ready.state, "ready");
assert.equal(ready.backgroundAccess, "supported");
checks.push("Real HTTPS OAuth authorization with PKCE");
await command({
  action: "mcp-grant",
  connectionId: ready.id,
  tools: ["lookup"],
  fingerprint: ready.fingerprint,
});
type Lookup = {
  part: string;
  unitPrice: number;
  authorization: { grantId: string; refreshes: number };
};
function lookup(result: { workspace: WorkspaceSnapshot }): Lookup {
  return (decodeGraph(result.workspace.graph).connectionResult as { structuredContent: Lookup })
    .structuredContent;
}
async function invoke() {
  await command({
    action: "mcp-call",
    connectionId: ready.id,
    tool: "lookup",
    input: { part: "A-1" },
  });
  const pending = (await state()).pending[0]!;
  assert(pending);
  return {
    cellId: pending.cellId,
    result: await command<{ workspace: WorkspaceSnapshot; recovery?: { code: string } }>({
      action: "approve",
      operationId: pending.id,
    }),
  };
}
const first = lookup((await invoke()).result);
assert.equal(first.unitPrice, 12);
checks.push("Imported MCP tool executes through the approved cell journal");
async function control(action: "expire" | "revoke", grantId: string) {
  const response = await fetch(`${fixture}/control`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${fixtureSecrets.TEST_CONTROL_TOKEN}`,
    },
    body: JSON.stringify({ action, grantId }),
    redirect: "error",
  });
  assert.equal(response.status, 200);
}
await control("expire", first.authorization.grantId);
await identity("developer");
const restart = await command<{ restarted: boolean }>({ action: "restart-runtime" }, true);
assert(restart.restarted);
await identity("northstar");
const resumed = lookup((await invoke()).result);
assert(resumed.authorization.refreshes >= 1);
checks.push(
  "The connection reconstructs after an actual runtime restart and refreshes without a browser sign-in",
);
await control("revoke", resumed.authorization.grantId);
const paused = await invoke();
assert.equal(paused.result.recovery?.code, "RECONNECTION_REQUIRED");
checks.push("Provider revocation pauses the approved operation before tool dispatch");
ready = await command<McpConnection>({ action: "mcp-discover", connectionId: ready.id });
assert.equal(ready.state, "authorization_required");
ready = await authorize(ready);
assert.equal(ready.state, "ready");
const completed = lookup(
  await command<{ workspace: WorkspaceSnapshot }>({ action: "resume", cellId: paused.cellId }),
);
assert.equal(completed.unitPrice, 12);
checks.push("Explicit reconnection resumes the original cell and its approved operation");
const report = {
  base,
  fixture,
  deployment,
  checks,
  connectionId: ready.id,
  first,
  resumed,
  completed,
  runtimeRestart: restart,
  evidence: "synthetic",
};
await mkdir(new URL("../.wrangler/proofs/", import.meta.url), { recursive: true });
const path = new URL(`../.wrangler/proofs/mcp-${Date.now()}.json`, import.meta.url);
await writeFile(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, checks, proof: path.pathname }, null, 2));
