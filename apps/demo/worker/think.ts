import {
  Think,
  type StepContext,
  type TurnContext,
  type PrepareStepContext,
  type ThinkModel,
  type ChunkContext,
  type ChatResponseResult,
  type ChatErrorContext,
  type ThinkSubmissionInspection,
} from "@cloudflare/think";
import { tool } from "ai";
import { z } from "zod";
import { invariant } from "@durable-harness/core";
import { canonicalWorkersAI, modelData } from "@durable-harness/cloudflare";
import { application, type DemoEnv, type ModelRequest } from "./protocol.js";

/** Think owns turn admission; durable-harness owns authorized cells and their journal. */
export class HarnessThink extends Think<DemoEnv> {
  includeMcpTools = false;
  maxSteps = 8;
  sendReasoning = false;
  private readonly responseTokenLimit = 8192;
  private inputOverhead = 0;
  private mirroredFields = 0;
  private buffer = "";
  private lastFlush = 0;
  private attempt = "";
  getAIBinding(): Ai {
    return canonicalWorkersAI(this.env.AI, (count) => {
      this.mirroredFields += count;
    });
  }
  getModel(): ThinkModel {
    invariant(
      typeof this.env.MODEL_ID === "string" && this.env.MODEL_ID.includes("/"),
      "NOT_CONFIGURED",
      "Set MODEL_ID to a model identifier from the Cloudflare catalog.",
    );
    return this.env.MODEL_ID as ThinkModel;
  }
  private async request(): Promise<ModelRequest> {
    // Think 0.17 submission metadata is ledger metadata, not activeTurnMetadata.
    // Resolve the latest host-stamped user ID against our protected request record.
    const id = this.messages.findLast((message) => message.role === "user")?.id;
    const request = id ? await this.ctx.storage.get<ModelRequest>(`request:${id}`) : undefined;
    invariant(
      request?.rootId && request.sandbox,
      "ACCESS_DENIED",
      "This model turn has no authenticated root-run context.",
    );
    return request;
  }
  private async application() {
    return application(this.env, (await this.request()).sandbox);
  }
  getTools() {
    return {
      inspectWorkspace: tool({
        description:
          "Inspect one named binding or helper source, or omit binding to read the concise namespace index and customer preferences. Read only the items needed for the current task.",
        inputSchema: z.object({
          binding: z.string().optional(),
          path: z.array(z.union([z.string(), z.number()])).optional(),
        }),
        execute: async ({ binding, path }) =>
          binding
            ? modelData(
                await (
                  await this.application()
                ).modelBinding((await this.request()).rootId, binding, path),
              )
            : modelData(
                await (await this.application()).modelContext((await this.request()).rootId),
              ),
      }),
      executeCell: tool({
        description:
          "Execute a complete TypeScript cell, with real values and function bodies. Top-level const/let bindings and function declarations persist automatically after success. Declare a helper as function name(arguments) { body }; pass mutable data as arguments. memory.write({title,kind,value}) stores serializable knowledge, and cannot store functions. Use tools.search(query), tools.describe(name), and await tools.call(name,input) for capabilities. history.search/read/around retrieves originals; artifacts.write/read retains large data. Use runtime.now/uuid/random for nondeterminism. An approval or connection pause preserves the cell identity and settled operations. Resume that recorded cell after the wait is resolved.",
        inputSchema: z.object({ source: z.string().min(1).max(16_000) }),
        execute: async ({ source }, { toolCallId }) =>
          modelData(
            await (
              await this.application()
            ).modelCell((await this.request()).rootId, source, toolCallId),
          ),
      }),
    };
  }
  async beforeTurn(_context: TurnContext) {
    const request = await this.request();
    await this.deliverPending(request.rootId);
    const { remainingMs } = await (await this.application()).modelActivate(request.rootId);
    this.attempt = crypto.randomUUID();
    this.buffer = "";
    this.lastFlush = Date.now();
    const context = await (await this.application()).modelContext(request.rootId);
    const instructions = `You are a procurement assistant working in a synthetic demonstration. Work only in workspace ${request.workspaceId}. All supplier and ERP operations are synthetic. Use inspectWorkspace and executeCell to create useful working structures and explicit helper functions. The authorized namespace index is supplied below. Inspect individual values or helper source only when needed; analyze retained data directly inside a cell instead of reading every binding. Never claim a message was sent without a delivery receipt. When approval is required, report that it is waiting. Your text is customer-facing; use clear, specific language and do not include hidden diagnostics. Preserve the customer's business rules. The current evaluated preferences are ${JSON.stringify(context.preferences?.value)}. Retained bindings and helper handles: ${JSON.stringify(context.workspace)}. Tool names are discoverable with tools.search("").`;
    const schemas = Object.entries(this.getTools()).map(([name, definition]) => ({
      name,
      description: definition.description,
      inputSchema: z.toJSONSchema(definition.inputSchema as z.ZodType),
    }));
    this.inputOverhead =
      new TextEncoder().encode(instructions + JSON.stringify(schemas)).byteLength + 512;
    const prepared = await (
      await this.application()
    ).modelPrepared(request.rootId, instructions, schemas, this.responseTokenLimit);
    return {
      instructions,
      messages: prepared.messages,
      activeTools: ["inspectWorkspace", "executeCell"],
      maxSteps: 8,
      maxOutputTokens: this.responseTokenLimit,
      maxRetries: 0,
      timeout: remainingMs,
      sendReasoning: false,
    };
  }
  async beforeStep(context: PrepareStepContext) {
    this.mirroredFields = 0;
    const request = await this.request();
    const stepId = `${request.rootId}:${this.attempt}:${context.stepNumber}`;
    // Reserve conservatively from the complete UTF-8 input plus the full output allowance.
    const estimate =
      new TextEncoder().encode(JSON.stringify(context.messages)).byteLength +
      this.inputOverhead +
      this.responseTokenLimit;
    await (await this.application()).modelReserve(request.rootId, stepId, estimate);
    await this.ctx.storage.put(`budget-step:${request.rootId}`, stepId);
    return { activeTools: ["inspectWorkspace", "executeCell"] };
  }
  async onStepEnd(context: StepContext) {
    const request = await this.request();
    const stepId = await this.ctx.storage.get<string>(`budget-step:${request.rootId}`);
    if (stepId && context.usage.totalTokens !== undefined)
      await (
        await this.application()
      ).modelSettle(request.rootId, stepId, context.usage.totalTokens);
    if (stepId)
      await (
        await this.application()
      ).modelStep(request.rootId, stepId, {
        mirroredFields: this.mirroredFields,
        modelId: context.response.modelId,
        usage: {
          inputTokens: context.usage.inputTokens ?? null,
          outputTokens: context.usage.outputTokens ?? null,
          totalTokens: context.usage.totalTokens ?? null,
        },
        finishReason: context.finishReason,
        calls: context.toolCalls.map((call) => ({ name: call.toolName, input: call.input })),
        results: context.toolResults.map((result) => ({
          name: result.toolName,
          output: result.output,
        })),
        errors: context.content
          .filter((part) => part.type === "tool-error")
          .map((part) => ({ name: part.toolName, error: String(part.error) })),
      });
  }
  async run(request: ModelRequest) {
    const previous = await this.ctx.storage.get<ModelRequest>(`request:${request.rootId}`);
    invariant(
      !previous || JSON.stringify(previous) === JSON.stringify(request),
      "INVALID_INPUT",
      "This submission identity already belongs to different work.",
    );
    await this.ctx.storage.put(`request:${request.rootId}`, request);
    const accepted = await this.runTurn({
      mode: "submit",
      input: { id: request.rootId, role: "user", parts: [{ type: "text", text: request.message }] },
      submissionId: request.rootId,
      idempotencyKey: request.rootId,
      metadata: request as unknown as Record<string, unknown>,
      channel: "web",
    });
    return {
      submissionId: accepted.submissionId,
      status: accepted.status,
      accepted: accepted.accepted,
    };
  }
  async onChunk({ chunk }: ChunkContext) {
    if (chunk.type !== "text-delta") return;
    this.buffer += chunk.text;
    if (this.buffer.length >= 256 || Date.now() - this.lastFlush >= 100)
      await this.flush(await this.request());
  }
  private async flush(request: ModelRequest) {
    if (this.buffer) {
      const text = this.buffer;
      this.buffer = "";
      const id = `${request.rootId}:${crypto.randomUUID()}`;
      await this.ctx.storage.put(`outbox:${id}`, { id, request, text });
    }
    await this.deliverPending(request.rootId);
    this.lastFlush = Date.now();
  }
  private async deliverPending(rootId: string) {
    const batches = await this.ctx.storage.list<{
      id: string;
      request: ModelRequest;
      text: string;
    }>({ prefix: `outbox:${rootId}:` });
    for (const [key, batch] of batches) {
      await application(this.env, batch.request.sandbox).modelEvent(
        rootId,
        "delta",
        batch.text,
        batch.id,
      );
      await this.ctx.storage.delete(key);
    }
  }
  async onChatResponse(result: ChatResponseResult) {
    const request = await this.ctx.storage.get<ModelRequest>(`request:${result.requestId}`);
    if (!request) return;
    await this.flush(request);
    await application(this.env, request.sandbox).modelEvent(
      request.rootId,
      result.status === "completed"
        ? "completed"
        : result.status === "error"
          ? "failed"
          : "interrupted",
      result.error ?? "",
    );
  }
  protected async onSubmissionStatus(submission: ThinkSubmissionInspection) {
    if (!["error", "aborted", "skipped"].includes(submission.status)) return;
    const request = await this.ctx.storage.get<ModelRequest>(`request:${submission.submissionId}`);
    if (request)
      await application(this.env, request.sandbox).modelEvent(
        request.rootId,
        "failed",
        submission.error ?? `Submission ${submission.status}; progress is retained.`,
      );
  }
  onChatError(error: unknown, context?: ChatErrorContext): unknown {
    if (context?.requestId)
      this.ctx.waitUntil(
        (async () => {
          const request = await this.ctx.storage.get<ModelRequest>(`request:${context.requestId}`);
          if (request) {
            await this.flush(request);
            await application(this.env, request.sandbox).modelEvent(
              request.rootId,
              "failed",
              error instanceof Error ? error.message : String(error),
            );
          }
        })(),
      );
    return error;
  }
}
