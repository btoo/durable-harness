import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { decodeGraph, type PreparedContext, type WorkspaceSnapshot } from "@durable-harness/core";
import { signSession } from "../apps/demo/worker/auth.js";
import type { DemoState } from "../apps/demo/src/api.js";

const [base, proofPath] = process.argv.slice(2);
assert(
  base && proofPath && /^https:\/\/[^/]+\.workers\.dev$/.test(base),
  "Pass the deployed URL and its previous successful proof file.",
);
const previous = JSON.parse(await readFile(proofPath, "utf8"));
assert.equal(previous.url, base, "The proof must belong to the explicitly selected deployment.");
assert(
  previous.model.contractPassed && previous.model.sandboxId,
  "A successful generation proof with its sandbox identity is required.",
);
const secrets = parseEnv(
  await readFile(new URL("../apps/demo/.dev.vars.deployed", import.meta.url), "utf8"),
);
const token = await signSession(
  { sandbox: previous.model.sandboxId, persona: "developer", expiresAt: Date.now() + 86_400_000 },
  secrets.SESSION_SECRET!,
);
const headers = {
  cookie: `dh_session=${token}`,
  authorization: `Bearer ${secrets.ADMIN_TOKEN}`,
  "content-type": "application/json",
};
async function state(): Promise<DemoState> {
  const response = await fetch(`${base}/api/state?workspace=northstar-quoting`, {
    headers,
    redirect: "error",
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function command<T>(body: object): Promise<T> {
  const response = await fetch(`${base}/api/command?workspace=northstar-quoting`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "error",
  });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value as T;
}
const before = await state();
const helper = before.workspace!.functions.find((value) => value.name === "analyzeSupplierOffers");
assert(helper, "This recipe reuses analyzeSupplierOffers from the captured Kimi proof.");
const correction = before.history.find(
  (value) => value.role === "user" && value.metadata.kind === "correction",
)!;
assert(correction);
await command({ action: "seed-history" });
const compacted = await command<PreparedContext>({ action: "compact" });
assert(compacted.receipt, "The synthetic archive must require a real compaction checkpoint.");
const restarted = await command<{ restarted: boolean; before: string; after: string }>({
  action: "restart-runtime",
});
assert(restarted.restarted && restarted.before !== restarted.after);
const restored = await state();
assert.equal(restored.workspace?.revision, before.workspace?.revision);
assert.deepEqual(restored.workspace?.functions, before.workspace?.functions);
assert.equal(restored.history.find((value) => value.id === correction.id)?.text, correction.text);
const started = await command<{ rootId: string; modelId: string }>({
  action: "model",
  message: `The workspace runtime was restarted and its history compacted. Reuse the existing rfq208QuoteAnalysis structure and analyzeSupplierOffers(rfqId, offers, includeFreight, businessDaysOnly) helper. Keep the existing helper unchanged. Recover the original customer correction with history.read(${JSON.stringify(correction.id)}). Make a copy of the retained evidenceSnapshot, increase Brookfield Parts freight by 100, and recompute with the retained helper. Retain a binding named recoveryProof with originalCorrectionText, recommendedSupplier, totalCost, and originalSupplier. Preserve the original analysis. Verify the result through inspectWorkspace. Do not send supplier messages.`,
});
let after = restored;
let terminalKind: string | undefined;
for (let attempt = 0; attempt < 75; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  after = await state();
  const terminal = after.events.findLast(
    (value) =>
      value.data.rootId === started.rootId &&
      ["model.completed", "model.failed", "model.interrupted"].includes(value.kind),
  );
  if (attempt % 10 === 0)
    console.log(
      JSON.stringify({
        rootId: started.rootId,
        steps: after.runs?.find((value) => value.id === started.rootId)?.steps,
        status: terminal?.kind ?? "running",
      }),
    );
  if (terminal) {
    terminalKind = terminal.kind;
    break;
  }
}
const reportPath = new URL(`../.wrangler/proofs/recovery-${Date.now()}.json`, import.meta.url);
const evidence = {
  base,
  previousModelId: previous.model.modelId,
  resumeModelId: started.modelId,
  rootId: started.rootId,
  checkpointId: compacted.receipt.id,
  runtime: restarted,
  originalCorrectionId: correction.id,
  helperVersion: helper.version,
  terminalKind: terminalKind ?? "timeout",
  newCells: after.cells.filter((value) => !before.cells.some((old) => old.id === value.id)),
  steps: after.modelSteps?.filter((value) => value.rootId === started.rootId),
  run: after.runs?.find((value) => value.id === started.rootId),
};
await writeFile(
  reportPath,
  JSON.stringify({ ...evidence, passed: false, assessment: "verification pending" }, null, 2),
);
try {
  assert.equal(
    terminalKind,
    "model.completed",
    `Recovery ended ${terminalKind ?? "without a terminal event"}; evidence: ${reportPath.pathname}`,
  );
  assert.equal(
    after.workspace?.functions.find((value) => value.name === helper.name)?.version,
    helper.version,
  );
  const verification = await command<{ workspace: WorkspaceSnapshot }>({
    action: "cell",
    id: crypto.randomUUID(),
    expectedRevision: after.workspace!.revision,
    source: "const recoveredVerification = recoveryProof;",
  });
  const values = decodeGraph(verification.workspace.graph);
  const result = values.recoveredVerification as {
    originalCorrectionText: string;
    recommendedSupplier: string;
    totalCost: number;
    originalSupplier: string;
  };
  assert.equal(result.originalCorrectionText, correction.text);
  assert.equal(result.recommendedSupplier, "Aster Components");
  assert.equal(result.totalCost, 1420);
  assert.equal(result.originalSupplier, "Brookfield Parts");
  const newCells = after.cells.filter((value) => !before.cells.some((old) => old.id === value.id));
  assert(
    newCells.some(
      (value) =>
        value.source?.includes("analyzeSupplierOffers(") &&
        !value.source.includes("function analyzeSupplierOffers"),
    ),
    "The continuation must call the retained helper without redefining it.",
  );
  await writeFile(reportPath, JSON.stringify({ ...evidence, passed: true, result }, null, 2));
  console.log(JSON.stringify({ passed: true, proof: reportPath.pathname, result }, null, 2));
} catch (error) {
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        ...evidence,
        passed: false,
        assessment: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  throw error;
}
