import { expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { reduceStepContext } from "../../packages/cloudflare/src/step-context.js";
it("retains the goal and latest call/result pair while replacing older rounds with retrievable references", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "Include freight and keep the customer exception." },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "private notes" },
        {
          type: "tool-call",
          toolCallId: "cell-1",
          toolName: "executeCell",
          input: { source: "retainedEvidence;" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "cell-1",
          toolName: "executeCell",
          output: { type: "text", value: "Large original evidence. ".repeat(1000) },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "inspect-2",
          toolName: "inspectWorkspace",
          input: { binding: "retainedEvidence" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "inspect-2",
          toolName: "inspectWorkspace",
          output: { type: "json", value: { price: 12 } },
        },
      ],
    },
  ];
  const reduced = reduceStepContext(messages, 2000);
  expect(reduced.renderedBytes).toBeLessThan(2000);
  expect(reduced.messages[0]).toEqual(messages[0]);
  expect(reduced.messages.slice(-2)).toEqual(messages.slice(-2));
  expect(JSON.stringify(reduced.messages)).toContain("cell-1");
  expect(JSON.stringify(reduced.messages)).not.toContain("private notes");
  expect(JSON.stringify(messages)).toContain("Large original evidence.");
});
