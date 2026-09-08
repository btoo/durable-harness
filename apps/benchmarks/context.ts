import { streamText, tool, isStepCount } from "ai";
import { z } from "zod";
import { createWorkersAI } from "workers-ai-provider";
import {
  ContextManager,
  History,
  RunBudgets,
  invariant,
  RETRIEVAL_BACKED_COMPACTION,
  type Principal,
  type RecordStore,
} from "@durable-harness/core";
import { canonicalWorkersAI } from "@durable-harness/cloudflare";

export async function compareContext(
  store: RecordStore,
  binding: Ai,
  modelId: string,
  principal: Principal,
  space: string,
  strategy: "extractive" | "generic-summary" | "recent-window",
) {
  const history = new History(store);
  const originalId = `receiving-exception-${crypto.randomUUID()}`;
  history.append({
    id: originalId,
    workspaceId: space,
    role: "user",
    text: "Customer receiving exception: accept deliveries only on Tuesday mornings.",
    audience: "customer",
    lineage: [],
    metadata: { evidence: "synthetic" },
  });
  for (let index = 0; index < 300; index++)
    history.append({
      workspaceId: space,
      role: "assistant",
      text:
        `Historical synthetic event ${index}: ` +
        "Routine quote and purchase-order updates were recorded for this example. ".repeat(4),
      audience: "customer",
      lineage: [],
      metadata: { evidence: "synthetic" },
    });
  history.append({
    workspaceId: space,
    role: "user",
    text: "What weekday does the customer's receiving exception allow? Give the exact original history item ID as your citation.",
    audience: "customer",
    lineage: [],
    metadata: { evidence: "synthetic" },
  });
  const answerSchema = z.object({
    day: z.enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
    sourceId: z.string(),
  });
  const tools = {
    searchHistory: tool({
      description: "Search retained original history for exact customer evidence.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) =>
        history
          .search(principal, query, [space], 5)
          .map((item) => ({ id: item.id, text: item.text })),
    }),
    answer: tool({
      description: "Record the answer and exact source citation.",
      inputSchema: answerSchema,
      execute: async (input) => input,
    }),
  };
  const instructions =
    "Answer only from the customer's authorized original history. Use searchHistory when the active checkpoint is insufficient. Finish by calling answer once.";
  const schemas = Object.entries(tools).map(([name, definition]) => ({
    name,
    description: definition.description,
    schema: z.toJSONSchema(definition.inputSchema as z.ZodType),
  }));
  const manager = new ContextManager(
    store,
    strategy === "extractive"
      ? RETRIEVAL_BACKED_COMPACTION
      : {
          id: strategy,
          summarize: async () =>
            strategy === "generic-summary"
              ? "The customer discussed procurement updates. Originals remain searchable."
              : "Earlier messages are outside the active window. Originals remain searchable.",
        },
  );
  const prepared = await manager.prepare(
    principal,
    space,
    modelId,
    {
      contextWindow: 16_000,
      outputReserve: 8192,
      instructions,
      toolSchemas: schemas,
      fraction: 0.8,
    },
    async ({ text }) =>
      text
        .split("\n")
        .filter((line) => line.includes("Customer receiving exception:"))
        .join("\n"),
  );
  const budgets = new RunBudgets(store);
  const rootId = crypto.randomUUID();
  budgets.start(rootId, { steps: 3, tokens: 48_000, activeMs: 120_000, descendants: 1 });
  const started = Date.now();
  let stepId = "";
  const response = streamText({
    model: createWorkersAI({ binding: canonicalWorkersAI(binding) })(modelId),
    instructions,
    messages: prepared.messages,
    tools,
    maxOutputTokens: 8192,
    maxRetries: 0,
    stopWhen: [
      isStepCount(3),
      ({ steps }) =>
        steps.some((step) => step.toolCalls.some((call) => call.toolName === "answer")),
    ],
    abortSignal: AbortSignal.timeout(120_000),
    prepareStep: async (context) => {
      stepId = `${rootId}:${context.stepNumber}`;
      budgets.reserve(
        rootId,
        stepId,
        new TextEncoder().encode(
          JSON.stringify(context.messages) + instructions + JSON.stringify(schemas),
        ).byteLength + 8192,
      );
      return {};
    },
    onStepEnd: async (step) => {
      if (step.usage.totalTokens !== undefined)
        budgets.settle(rootId, stepId, step.usage.totalTokens);
    },
  });
  const [calls, usage] = await Promise.all([response.toolCalls, response.totalUsage]);
  const answer = calls.findLast((call) => call.toolName === "answer");
  invariant(answer, "INVALID_TOOL_RESULT", "The context case produced no structured answer.");
  const value = answerSchema.parse(answer.input);
  budgets.complete(rootId);
  return {
    strategy,
    passed: value.day === "Tuesday" && value.sourceId === originalId,
    answer: value,
    historySearches: calls.filter((call) => call.toolName === "searchHistory").length,
    reportedTokens: usage.totalTokens ?? null,
    wallMs: Date.now() - started,
    originalRetained: history.read(principal, originalId).text,
    contextReceipt: prepared.receipt?.id ?? null,
  };
}
