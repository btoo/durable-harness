import { expect, it } from "vitest";
import { createWorkersAI } from "workers-ai-provider";
import captured from "../fixtures/workers-ai-mirrored-stream.json";

it("matches typed native fragments using their emitted argument bytes", async () => {
  const fragments: unknown[] = ['{"source":"const result = ', 42, "; const item = ", {}, ';"}'];
  const frames = [
    {
      tool_calls: [{ name: "executeCell" }],
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "call", function: { name: "executeCell" } }] } },
      ],
    },
    ...fragments.map((value) => ({
      tool_calls: [{ arguments: value }],
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: typeof value === "string" ? value : JSON.stringify(value) },
              },
            ],
          },
        },
      ],
    })),
  ];
  const wire =
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  const binding = {
    run: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(wire));
          controller.close();
        },
      }),
  } as unknown as Ai;
  const response = await createWorkersAI({ binding: canonicalWorkersAI(binding) })(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  ).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Create a cell." }] }] });
  let input = "";
  for await (const part of response.stream) if (part.type === "tool-call") input = part.input;
  expect(JSON.parse(input)).toEqual({ source: "const result = 42; const item = {};" });
});
import {
  canonicalWorkersAI,
  canonicalWorkersAIStream,
} from "../../packages/cloudflare/src/provider-stream.js";

it("maps the captured Cloudflare flat/nested wire format without duplicated arguments", async () => {
  const wire =
    captured.frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
    "data: [DONE]\n\n";
  const binding = {
    run: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(wire));
          controller.close();
        },
      }),
  } as unknown as Ai;
  const response = await createWorkersAI({ binding: canonicalWorkersAI(binding) })(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  ).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Call capture." }] }] });
  let input = "";
  for await (const part of response.stream) if (part.type === "tool-call") input = part.input;
  expect(JSON.parse(input)).toEqual({ text: "alpha beta" });
});

it("maps mirrored native/OpenAI tool chunks to one argument sequence", async () => {
  const frames = [
    { id: "call", index: 0, type: "function", function: { name: "executeCell", arguments: "" } },
    { index: 0, function: { arguments: '{"source":' } },
    { index: 0, function: { arguments: '"const value = 42;"}' } },
  ].map((call) => ({ tool_calls: [call], choices: [{ delta: { tool_calls: [call] } }] }));
  const wire =
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  const binding = {
    run: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(wire));
          controller.close();
        },
      }),
  } as unknown as Ai;
  let mirrored = 0;
  const provider = createWorkersAI({
    binding: canonicalWorkersAI(binding, (fields) => {
      mirrored += fields;
    }),
  });
  const response = await provider("@cf/meta/llama-3.3-70b-instruct-fp8-fast").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Create a cell." }] }],
  });
  let input = "";
  for await (const part of response.stream) if (part.type === "tool-call") input = part.input;
  expect(input).toBe('{"source":"const value = 42;"}');
  expect(mirrored).toBe(3);
});

it("preserves legitimate repeated text across fragmented SSE events", async () => {
  const wire =
    'data: {"response":"ha","choices":[{"delta":{"content":"ha"}}]}\r\n\r\ndata: {"response":"ha","choices":[{"delta":{"content":"ha"}}]}\r\n\r\ndata: {"response":"echoecho"}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(wire);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
  const result = await new Response(canonicalWorkersAIStream(stream)).text();
  const frames = result
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: {"))
    .map((frame) => JSON.parse(frame.slice(6)));
  expect(frames.map((frame) => frame.choices?.[0].delta.content ?? frame.response).join("")).toBe(
    "hahaechoecho",
  );
});
