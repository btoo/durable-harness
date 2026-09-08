import type { ModelMessage } from "ai";

/** Originals live in the turn archive and cell journal; active requests retain the latest tool round. */
export function reduceStepContext(original: ModelMessage[], inputByteLimit: number) {
  let messages: ModelMessage[] = original.flatMap((message) => {
    if (message.role !== "assistant" || typeof message.content === "string") return [message];
    const content = message.content.filter((part) => part.type !== "reasoning");
    return content.length ? [{ ...message, content }] : [];
  });
  const bytes = (value: ModelMessage[]) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const originalBytes = bytes(original);
  let removedRounds = 0;
  const user = messages.findLastIndex((message) => message.role === "user");
  const latestRound = messages.findLastIndex(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "tool-call"),
  );
  if (bytes(messages) > inputByteLimit && latestRound > user + 1) {
    const older = messages.slice(user + 1, latestRound);
    type Receipt = { cellId: string } | { inspection: unknown };
    const receipts = older.flatMap<Receipt>((message) =>
      message.role !== "assistant" || !Array.isArray(message.content)
        ? []
        : message.content.flatMap<Receipt>((part) =>
            part.type !== "tool-call"
              ? []
              : part.toolName === "executeCell"
                ? [{ cellId: part.toolCallId }]
                : part.toolName === "inspectWorkspace"
                  ? [{ inspection: part.input }]
                  : [],
          ),
    );
    removedRounds = older.filter((message) => message.role === "assistant").length;
    messages = [
      ...messages.slice(0, user + 1),
      {
        role: "assistant",
        content: `Runtime context checkpoint. Earlier tool rounds are retained in the workspace and turn archive. Use inspectWorkspace with cellId to read exact cell output, or repeat a named inspection when needed. Receipts: ${JSON.stringify(receipts.slice(-32))}`,
      },
      ...messages.slice(latestRound),
    ];
  }
  return { messages, originalBytes, renderedBytes: bytes(messages), removedRounds };
}
