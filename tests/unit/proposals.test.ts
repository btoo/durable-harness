import { expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import { modelCandidateGenerator } from "../../packages/cloudflare/src/proposals.js";
import type { CandidateContext } from "@durable-harness/core";

it("generates a typed candidate in one model step and reports actual usage", async () => {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      calls++;
      expect(options.toolChoice).toEqual({ type: "tool", toolName: "submitCandidate" });
      expect(options.maxOutputTokens).toBe(8192);
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "proposal-1",
              toolName: "submitCandidate",
              input: JSON.stringify({
                candidate: { includeFreight: true },
                rationale: "The correction asks for total landed cost.",
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
                outputTokens: { total: 50, text: 50, reasoning: undefined },
              },
            },
          ],
        }),
      };
    },
  });
  const generator = modelCandidateGenerator(() => model, {
    id: "test-model-proposer",
    instructions: "Preserve action approval.",
  });
  const context: CandidateContext = {
    workspaceId: "a",
    target: "preferences",
    baseRevision: 1,
    baseline: { includeFreight: false },
    evidence: [],
    adaptationCases: [],
    previousEvaluations: [],
  };
  const reservedTokens = generator.reserveTokens(context);
  expect(reservedTokens).toBeGreaterThan(8192);
  const proposal = await generator.generate(context, {
    id: "attempt-1",
    reservedTokens,
    signal: new AbortController().signal,
  });
  expect(proposal.candidate).toEqual({ includeFreight: true });
  expect(proposal.usedTokens).toBe(150);
  expect(calls).toBe(1);
});
