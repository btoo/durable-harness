import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { evaluateProgram } from "../../apps/benchmarks/program-study.js";
import { procurementCases, seedTool } from "../../apps/benchmarks/procurement-cases.js";

const referenceTool = `function rankOffers(input) {
  const options = input.offers.flatMap(offer => {
    const rate = input.rates[offer.currency];
    if (!(rate > 0)) return [];
    const packs = Math.max(Math.ceil(input.quantity / offer.packSize), offer.minimumPacks);
    if (!input.policy.allowOverbuy && packs * offer.packSize > input.quantity) return [];
    return [{ supplier: offer.supplier, total: (packs * offer.unitPrice + (input.policy.includeFreight ? offer.freight : 0)) * rate }];
  }).sort((a,b) => a.total - b.total || a.supplier.localeCompare(b.supplier));
  return {supplier: options[0]?.supplier ?? null, totalUsd: options[0] ? Math.round(options[0].total*100)/100 : null, approvalRequired: true};
}`;

it("distinguishes missing normalization from a correct tool on independently specified outcomes", async () => {
  const executor = new DynamicWorkerExecutor({
    loader: (env as unknown as { LOADER: WorkerLoader }).LOADER,
    globalOutbound: null,
    timeout: 1000,
  });
  const cases = procurementCases(2);
  for (const testCase of cases) {
    const score = await evaluateProgram(executor, { source: referenceTool }, testCase);
    expect(score.passed, score.explanation).toBe(true);
  }
  let failures = 0;
  for (const testCase of cases.filter((c) => c.split === "heldout")) {
    const score = await evaluateProgram(executor, { source: seedTool }, testCase);
    failures += Number(!score.passed);
  }
  expect(failures).toBeGreaterThanOrEqual(8);
  const malformed = await evaluateProgram(
    executor,
    { source: "function rankOffers( {" },
    cases[0]!,
  );
  expect(malformed.passed).toBe(false);
  const unauthorized = await evaluateProgram(
    executor,
    { source: referenceTool.replace("approvalRequired: true", "approvalRequired: false") },
    cases[0]!,
  );
  expect(unauthorized.passed).toBe(false);
});

it("withholds assessment evidence and prevents tuning a candidate after seeing its held-out score", async () => {
  const benchmark = (env as unknown as { BENCHMARKS: DurableObjectNamespace }).BENCHMARKS.getByName(
    crypto.randomUUID(),
  );
  const call = (body: unknown) =>
    benchmark.fetch("https://benchmark.test/run", { method: "POST", body: JSON.stringify(body) });
  const metadata = (await (await call({ action: "program-metadata", stage: 2 })).json()) as {
    cases: { split: string }[];
  };
  expect(metadata.cases.every((c) => c.split !== "heldout")).toBe(true);
  expect(
    (
      await call({
        action: "program-evaluate",
        stage: 2,
        candidate: { source: referenceTool },
        caseIds: ["import-carton"],
      })
    ).status,
  ).toBe(400);
  const sealed = (await (
    await call({ action: "program-seal", candidate: { source: referenceTool } })
  ).json()) as { passed: number; cases: number };
  expect(sealed).toMatchObject({ passed: 12, cases: 12 });
  expect((await call({ action: "program-evaluate", candidate: { source: seedTool } })).status).toBe(
    400,
  );
  expect((await call({ action: "program-seal", candidate: { source: seedTool } })).status).toBe(
    400,
  );
  expect((await call({ action: "program-review", reviewed: false })).status).toBe(400);
});

for (const mode of ["harness", "filesystem"] as const) {
  it(`recovers ${mode} after an actual actor interruption without repeating the accepted order`, async () => {
    const namespace = (env as unknown as { BENCHMARKS: DurableObjectNamespace }).BENCHMARKS;
    const name = crypto.randomUUID();
    const call = (body: unknown) =>
      namespace
        .getByName(name)
        .fetch("https://benchmark.test/run", { method: "POST", body: JSON.stringify(body) });
    const setup = (await (
      await call({ action: "recovery-setup", mode, candidate: { source: referenceTool } })
    ).json()) as { incarnation: string };
    const waiting = await call({ action: "recovery-run" });
    expect(waiting.status, await waiting.clone().text()).toBe(200);
    const pending = (await waiting.json()) as { counts: { effects: number } };
    expect(pending.counts.effects).toBe(0);
    await call({ action: "recovery-run", approved: true }).catch(() => undefined);
    const restored = await call({ action: "recovery-run", approved: true });
    expect(restored.status, await restored.clone().text()).toBe(200);
    const result = (await restored.json()) as {
      incarnation: string;
      counts: { reads: number; effects: number; reconciliations: number };
      values: { draft: unknown; delivery: unknown };
    };
    expect(result.incarnation).not.toBe(setup.incarnation);
    expect(result.counts).toEqual({ reads: 1, effects: 1, reconciliations: 1 });
    expect(result.values.draft).toEqual({
      supplier: "Brook",
      totalUsd: 76.8,
      approvalRequired: true,
    });
    expect(result.values.delivery).toMatchObject({ receipt: { id: "synthetic-order-1" } });
    const replay = (await (
      await call({ action: "recovery-run", approved: true })
    ).json()) as typeof result;
    expect(replay.counts).toEqual(result.counts);
    await call({ action: "recovery-revoke" });
    expect((await call({ action: "recovery-run", approved: true })).status).toBe(400);
  });
}
it("evaluates the stock Codemode filesystem baseline through its real state provider", async () => {
  const benchmark = (env as unknown as { BENCHMARKS: DurableObjectNamespace }).BENCHMARKS.getByName(
    crypto.randomUUID(),
  );
  const response = await benchmark.fetch("https://benchmark.test/run", {
    method: "POST",
    body: JSON.stringify({
      action: "evaluate",
      candidate: { includeFreight: true, businessDaysOnly: true, approvalRequired: true },
    }),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as { scores: { passed: boolean }[] };
  expect(result.scores).toHaveLength(3);
  expect(result.scores.every((score) => score.passed)).toBe(true);
});
