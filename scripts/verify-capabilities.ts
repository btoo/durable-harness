import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { decodeGraph, type CapabilityRecord, type WorkspaceSnapshot } from "@durable-harness/core";
import { signSession } from "../apps/demo/worker/auth.js";
import type { DemoState } from "../apps/demo/src/api.js";

const [base, proofPath] = process.argv.slice(2);
assert(
  base && proofPath && /^https:\/\/[^/]+\.workers\.dev$/.test(base),
  "Pass the isolated deployment URL and successful generation proof.",
);
const original = JSON.parse(await readFile(proofPath, "utf8"));
assert(original.model.contractPassed && original.model.sandboxId);
const secrets = parseEnv(
  await readFile(new URL("../apps/demo/.dev.vars.deployed", import.meta.url), "utf8"),
);
let cookie = `dh_session=${await signSession({ sandbox: original.model.sandboxId, persona: "developer", expiresAt: Date.now() + 3600000 }, secrets.SESSION_SECRET!)}`;
async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
  });
  if (response.headers.has("set-cookie"))
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value as T;
}
const command = <T>(body: object, workspace = "northstar-quoting") =>
  api<T>(`/api/command?workspace=${workspace}`, body);
const state = (workspace = "northstar-quoting") =>
  api<DemoState>(`/api/state?workspace=${workspace}`);
const before = await state();
assert(before.workspace?.functions.some((helper) => helper.name === "analyzeSupplierOffers"));
const proposed = await command<CapabilityRecord>({
  action: "propose-capability",
  helperName: "analyzeSupplierOffers",
  name: "recovered-quote-analysis",
  protocolId: "analyze-offers-v1",
});
const evaluated = await command<CapabilityRecord>({
  action: "evaluate-capability",
  id: proposed.id,
});
assert(evaluated.evaluation?.checks.every((check) => check.passed));
await command({ action: "approve-capability", id: proposed.id });
const expectedRevision = Math.max(
  0,
  ...before.capabilities
    .filter((value) => value.spaceId === "shared-library" && value.name === proposed.name)
    .map((value) => value.revision),
);
const published = await command<CapabilityRecord>({
  action: "publish-capability",
  id: proposed.id,
  expectedRevision,
});
assert.notEqual(published.id, proposed.id);
assert.equal(published.sourceId, undefined);
await api("/api/session", { persona: "cedar" });
const cedar = await state("cedar-quoting");
assert(!cedar.capabilities.some((value) => value.id === proposed.id));
assert(cedar.capabilities.some((value) => value.id === published.id));
assert.equal((cedar.configuration!.value as { includeFreight: boolean }).includeFreight, false);
const execution = await command<{ workspace: WorkspaceSnapshot }>(
  { action: "use-capability", id: published.id },
  "cedar-quoting",
);
const comparison = decodeGraph(execution.workspace.graph).sharedComparison as {
  recommendation: { supplier: string };
};
assert.equal(comparison.recommendation.supplier, "Aster Components");
const report = {
  base,
  deployment: await api("/api/health"),
  passed: true,
  sourceModel: original.model.modelId,
  helperVersion: published.program.entry.version,
  privateProposalId: proposed.id,
  publishedId: published.id,
  revision: published.revision,
  checks: evaluated.evaluation!.checks,
  recipient: "cedar",
  recipientPreferencePreserved: true,
  recommendation: comparison.recommendation.supplier,
};
await mkdir(new URL("../.wrangler/proofs/", import.meta.url), { recursive: true });
const path = new URL(`../.wrangler/proofs/capabilities-${Date.now()}.json`, import.meta.url);
await writeFile(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, proof: path.pathname, checks: report.checks }, null, 2));
