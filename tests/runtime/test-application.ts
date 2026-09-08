import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import { modelCandidateGenerator } from "@durable-harness/cloudflare";
import { DemoApplication } from "../../apps/demo/worker/application.js";

export class TestDemoApplication extends DemoApplication {
  protected createProposalGenerator() {
    return modelCandidateGenerator(
      () =>
        new MockLanguageModelV3({
          doStream: async () => ({
            stream: simulateReadableStream({
              initialDelayInMs: null,
              chunkDelayInMs: null,
              chunks: [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "candidate",
                  toolName: "submitCandidate",
                  input: JSON.stringify({
                    candidate: {
                      includeFreight: true,
                      businessDaysOnly: false,
                      approvalRequired: true,
                    },
                    rationale: "Compare total landed cost, as the customer requested.",
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
          }),
        }),
      {
        id: "controlled-proposer-v1",
        instructions: "Preserve approval and unrelated preferences.",
      },
    );
  }
}
