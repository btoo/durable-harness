import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { HarnessThink } from "../../apps/demo/worker/think.js";

/** A controlled provider stream exercises admission, dispatch, and persistence. */
export class TestHarnessThink extends HarnessThink {
  private step = 0;
  private readonly model = new MockLanguageModelV3({
    doStream: async (options) => {
      if (!options.tools?.some((tool) => tool.name === "executeCell"))
        throw new Error("The durable workspace tool was not sent to the model.");
      const step = this.step++;
      if (step > 0 && JSON.stringify(options.prompt).includes("PRIVATE_REASONING_FIXTURE"))
        throw new Error("Old reasoning was repeated in the rendered request.");
      const chunks: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (step === 0)
        chunks.push(
          { type: "reasoning-start", id: "reasoning" },
          { type: "reasoning-delta", id: "reasoning", delta: "PRIVATE_REASONING_FIXTURE" },
          { type: "reasoning-end", id: "reasoning" },
        );
      if (step === 0)
        chunks.push({
          type: "tool-call",
          toolCallId: "inspect-1",
          toolName: "inspectWorkspace",
          input: "{}",
        });
      else if (step === 1)
        chunks.push({
          type: "tool-call",
          toolCallId: "cell-1",
          toolName: "executeCell",
          input: JSON.stringify({
            source:
              'const modelNotes = { checked: ["supplier evidence"], pending: [] }; function countChecked(notes: {checked:string[]}) { return notes.checked.length; }',
          }),
        });
      else if (step === 2)
        chunks.push({
          type: "tool-call",
          toolCallId: "inspect-helper",
          toolName: "inspectWorkspace",
          input: JSON.stringify({ binding: "countChecked" }),
        });
      else {
        if (!JSON.stringify(options.prompt).includes("function countChecked"))
          throw new Error("The model did not receive the retained helper source.");
        chunks.push(
          { type: "text-start", id: "response" },
          {
            type: "text-delta",
            id: "response",
            delta: "I retained the evidence notes and a helper for the next run.",
          },
          { type: "text-end", id: "response" },
        );
      }
      chunks.push({
        type: "finish",
        finishReason: { unified: step < 3 ? "tool-calls" : "stop", raw: undefined },
        usage: {
          inputTokens: { total: 30, noCache: 30, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
      });
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      };
    },
  });
  getModel() {
    return this.model;
  }
}
