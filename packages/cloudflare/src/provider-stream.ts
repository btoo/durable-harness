import { invariant } from "@durable-harness/core";

/** Normalize only exact mirrors within one SSE event, never repeated tokens across events. */
export function canonicalWorkersAIStream(
  stream: ReadableStream<Uint8Array>,
  onMirror?: (fields: number) => void,
): ReadableStream<Uint8Array> {
  let buffer = "";
  const encoder = new TextEncoder();
  const normalize = (frame: string): string => {
    const lines = frame.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return frame;
    let value: {
      response?: unknown;
      tool_calls?: unknown;
      choices?: { delta?: { content?: unknown; tool_calls?: unknown } }[];
    };
    try {
      value = JSON.parse(data);
    } catch {
      return frame;
    }
    if (!value || typeof value !== "object") return frame;
    const delta = value.choices?.[0]?.delta;
    if (!delta) return frame;
    let mirrors = 0;
    if (typeof value.response === "string" && value.response === delta.content) {
      delete value.response;
      mirrors++;
    }
    if (
      Array.isArray(value.tool_calls) &&
      Array.isArray(delta.tool_calls) &&
      JSON.stringify(value.tool_calls) === JSON.stringify(delta.tool_calls)
    ) {
      delete value.tool_calls;
      mirrors++;
    }
    if (!mirrors) return frame;
    onMirror?.(mirrors);
    return [
      ...lines.filter((line) => !line.startsWith("data:")),
      `data: ${JSON.stringify(value)}`,
    ].join("\n");
  };
  const decoder = new TextDecoder();
  const decode = new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      controller.enqueue(decoder.decode(chunk, { stream: true }));
    },
    flush(controller) {
      controller.enqueue(decoder.decode());
    },
  });
  return stream.pipeThrough(decode).pipeThrough(
    new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        buffer += chunk;
        invariant(
          buffer.length <= 2_000_000,
          "BUDGET_EXCEEDED",
          "The model stream exceeded the maximum SSE event size.",
        );
        let delimiter: RegExpExecArray | null;
        while ((delimiter = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, delimiter.index);
          buffer = buffer.slice(delimiter.index + delimiter[0].length);
          controller.enqueue(encoder.encode(`${normalize(frame)}\n\n`));
        }
      },
      flush(controller) {
        if (buffer) controller.enqueue(encoder.encode(normalize(buffer)));
      },
    }),
  );
}

/** Compatibility adapter for workers-ai-provider 4.0.0's dual-format SSE handling. */
export function canonicalWorkersAI(binding: Ai, onMirror?: (fields: number) => void): Ai {
  return new Proxy(binding, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "run")
        return async (...args: unknown[]) => {
          const response: unknown = await Reflect.apply(value, target, args);
          return response instanceof ReadableStream
            ? canonicalWorkersAIStream(response, onMirror)
            : response;
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
