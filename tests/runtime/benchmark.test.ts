import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
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
