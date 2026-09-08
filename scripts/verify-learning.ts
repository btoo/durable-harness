import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import type { DemoState } from "../apps/demo/src/api.js";

const base = process.argv[2];
assert(base && /^https:\/\/[^/]+\.workers\.dev$/.test(base), "Pass the isolated deployment URL.");
const secrets = parseEnv(
  await readFile(new URL("../apps/demo/.dev.vars.deployed", import.meta.url), "utf8"),
);
let cookie = "";
async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      cookie,
      "content-type": "application/json",
      authorization: `Bearer ${secrets.ADMIN_TOKEN}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
  });
  if (response.headers.has("set-cookie"))
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value as T;
}
const state = () => api<DemoState>("/api/state?workspace=northstar-quoting");
const command = <T>(body: object) => api<T>("/api/command?workspace=northstar-quoting", body);
const deployment = await api("/api/health");
await api("/api/session", { persona: "developer" });
await command({ action: "run-synthetic" });
const before = await state();
assert(before.events.some((event) => event.text.includes("Aster Components is the lowest-cost")));
const queued = await command<{ learningRunId: string }>({
  action: "learn-with-model",
  preference: "includeFreight",
  text: "Include freight when comparing supplier quotes; the lowest unit price can cost more overall. Keep the other preferences unchanged.",
});
let after = before;
for (let attempt = 0; attempt < 75; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  after = await state();
  const progress = after.learningRuns.find((run) => run.id === queued.learningRunId);
  if (attempt % 10 === 0)
    console.log(JSON.stringify({ learningRunId: queued.learningRunId, status: progress?.status }));
  if (
    progress &&
    ["promoted", "exhausted", "interrupted", "stale", "awaiting_review"].includes(progress.status)
  )
    break;
}
const run = after.learningRuns.find((run) => run.id === queued.learningRunId)!;
const proposals = after.proposals.filter((proposal) => run.proposalIds.includes(proposal.id));
const report = {
  base,
  deployment,
  passed: false,
  run,
  proposals,
  evaluations: after.evaluations,
  budget: after.runs?.find((value) => value.id === run.rootId),
  before: before.configuration,
  after: after.configuration,
};
await mkdir(new URL("../.wrangler/proofs/", import.meta.url), { recursive: true });
const path = new URL(`../.wrangler/proofs/learning-${Date.now()}.json`, import.meta.url);
await writeFile(path, JSON.stringify(report, null, 2));
assert.equal(
  run.status,
  "promoted",
  `The model improvement did not promote; evidence: ${path.pathname}`,
);
assert(proposals.every((proposal) => proposal.origin === "model_generated"));
assert.deepEqual(after.configuration?.value, {
  includeFreight: true,
  businessDaysOnly: false,
  approvalRequired: true,
});
await command({ action: "run-synthetic" });
const subsequent = await state();
assert(
  subsequent.events.some((event) => event.text.includes("Brookfield Parts is the lowest-cost")),
);
await writeFile(
  path,
  JSON.stringify({ ...report, passed: true, subsequentDecisionVerified: true }, null, 2),
);
console.log(
  JSON.stringify(
    { passed: true, learningRunId: run.id, proof: path.pathname, budget: report.budget },
    null,
    2,
  ),
);
