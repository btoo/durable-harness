import { expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import {
  applySourceEdits,
  modelCodeEditGenerator,
} from "../../packages/cloudflare/src/code-edits.js";

it("applies literal replacements without interpreting replacement-string metacharacters", () => {
  expect(applySourceEdits("const cost = 1;", [{ before: "1", after: '"$&"' }])).toBe(
    'const cost = "$&";',
  );
  expect(() => applySourceEdits("cost + cost", [{ before: "cost", after: "total" }])).toThrow(
    "matched 2 locations",
  );
  expect(() => applySourceEdits("cost", [{ before: "price", after: "total" }])).toThrow(
    "matched 0 locations",
  );
});

it("reconstructs an evaluated source candidate while leaving the prior version unchanged", async () => {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: null,
        chunkDelayInMs: null,
        chunks: [
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "edit-1",
            toolName: "submitCandidate",
            input: JSON.stringify({
              candidate: { edits: [{ before: "return price;", after: "return price + freight;" }] },
              rationale: "Include the requested freight.",
            }),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: {
              inputTokens: {
                total: 100,
                noCache: 100,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 40, text: 40, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
  const generator = modelCodeEditGenerator(() => model, {
    id: "edits-v1",
    instructions: "Preserve approval.",
  });
  const baseline = { source: "function cost(price, freight) { return price; }" };
  const result = await generator.generate(
    {
      workspaceId: "a",
      target: "cost",
      baseRevision: 1,
      baseline,
      evidence: [],
      adaptationCases: [],
      previousEvaluations: [],
    },
    { id: "edit-1", reservedTokens: 10000, signal: new AbortController().signal },
  );
  expect(result.candidate).toEqual({
    source: "function cost(price, freight) { return price + freight; }",
  });
  expect(baseline.source).toBe("function cost(price, freight) { return price; }");
  expect(result.usedTokens).toBe(140);
});
