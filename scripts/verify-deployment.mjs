import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const base = process.argv[2];
if (!base || !/^https:\/\/[^/]+\.workers\.dev$/.test(base)) {
  throw new Error(
    "Pass the isolated deployment URL: node scripts/verify-deployment.mjs https://name.account.workers.dev [--model]",
  );
}
let cookie = "";
async function api(path, body, extraHeaders = {}) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
  });
  if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
  return { status: response.status, data: await response.json() };
}
const proof = { url: base, startedAt: new Date().toISOString(), checks: [] };
assert.equal((await api("/api/health")).status, 200);
assert.equal((await api("/api/session", { persona: "northstar" })).status, 200);
assert.equal((await api("/api/state?workspace=cedar-quoting")).status, 403);
proof.checks.push("Cross-tenant HTTP access denied");
for (const [workspace, preference, before, after] of [
  ["northstar-po", "businessDaysOnly", "2026-09-06", "2026-09-07"],
  [
    "northstar-quoting",
    "includeFreight",
    "Aster Components is the lowest-cost",
    "Brookfield Parts is the lowest-cost",
  ],
]) {
  const path = `/api/command?workspace=${workspace}`;
  assert.equal((await api(path, { action: "run-synthetic" })).status, 200);
  const initial = await api(`/api/state?workspace=${workspace}`);
  assert(initial.data.events.some((event) => event.text.includes(before)));
  const correction = await api(path, {
    action: "correct",
    preference,
    text:
      preference === "includeFreight"
        ? "Include freight in quote rankings."
        : "Move weekend follow-ups to Monday.",
  });
  assert.equal(correction.status, 200);
  assert.equal(correction.data.proposal.status, "promoted");
  assert.equal((await api(path, { action: "run-synthetic" })).status, 200);
  const improved = await api(`/api/state?workspace=${workspace}`);
  assert(improved.data.events.some((event) => event.text.includes(after)));
  assert.equal(improved.data.configuration.revision, 2);
  proof.checks.push(`${workspace}: correction passed evaluation and changed the next decision`);
}
const actionPath = "/api/command?workspace=northstar-quoting";
assert.equal((await api(actionPath, { action: "prepare-message" })).status, 200);
const pending = (await api("/api/state?workspace=northstar-quoting")).data.pending[0];
assert(pending);
assert.equal((await api(actionPath, { action: "approve", operationId: pending.id })).status, 200);
assert.equal((await api(actionPath, { action: "approve", operationId: pending.id })).status, 400);
proof.checks.push("Synthetic supplier action waits for approval; repeated approval is rejected");
await api("/api/session", { persona: "developer" });
const inspector = await api("/api/state?workspace=northstar-quoting");
assert(inspector.data.workspace.functions.some((helper) => helper.name === "rankOffers"));
proof.checks.push("Developer inspector returns committed bindings and retained helper versions");

if (process.argv.includes("--model")) {
  const secrets = parseEnv(
    await readFile(new URL("../apps/demo/.dev.vars.deployed", import.meta.url), "utf8"),
  );
  const response = await api(
    actionPath,
    {
      action: "model",
      message:
        "Inspect the synthetic supplier offers. Invent a useful compact working structure that tracks evidence and your findings; retain it under a new descriptive name. Create a reusable helper with explicit arguments to analyze the offers. Use executeCell so both are durably retained. Report what you actually verified. Do not send any supplier messages.",
    },
    { authorization: `Bearer ${secrets.ADMIN_TOKEN}` },
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  proof.model = { rootId: response.data.rootId, status: response.data.status };
  // Explicit verification only: a finite one-minute observation, not a background monitor.
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const state = (await api("/api/state?workspace=northstar-quoting")).data;
    const terminal = state.events.findLast(
      (event) =>
        event.data.rootId === proof.model.rootId &&
        ["model.completed", "model.failed", "model.interrupted"].includes(event.kind),
    );
    if (terminal) {
      proof.model = {
        ...proof.model,
        status: terminal.kind,
        namespace: state.workspace,
        run: state.runs.find((run) => run.id === proof.model.rootId),
        events: state.events.filter((event) => event.data.rootId === proof.model.rootId),
        cells: state.cells,
        steps: state.modelSteps.filter((step) => step.rootId === proof.model.rootId),
      };
      break;
    }
  }
  const newBindings =
    proof.model.namespace?.bindings.filter(
      (binding) =>
        !inspector.data.workspace.bindings.some((previous) => previous.name === binding.name),
    ) ?? [];
  const newHelpers =
    proof.model.namespace?.functions.filter(
      (helper) =>
        !inspector.data.workspace.functions.some((previous) => previous.version === helper.version),
    ) ?? [];
  proof.model.contractPassed =
    proof.model.status === "model.completed" && newBindings.length > 0 && newHelpers.length > 0;
  if (!proof.model.contractPassed) process.exitCode = 1;
}
const directory = new URL("../.wrangler/proofs/", import.meta.url);
await mkdir(directory, { recursive: true });
const path = new URL(`deployment-${Date.now()}.json`, directory);
await writeFile(path, JSON.stringify(proof, null, 2));
console.log(
  JSON.stringify(
    {
      checks: proof.checks,
      model: proof.model ? { rootId: proof.model.rootId, status: proof.model.status } : undefined,
      proof: path.pathname,
    },
    null,
    2,
  ),
);
