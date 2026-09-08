import {
  Think,
  type StepContext,
  type TurnContext,
  type PrepareStepContext,
  type ThinkModel,
} from "@cloudflare/think";
import { tool } from "ai";
import { z } from "zod";
import { invariant } from "@durable-harness/core";
import { modelData } from "@durable-harness/cloudflare";
import { application, type DemoEnv, type ModelRequest } from "./protocol.js";

/** Think owns turn admission; durable-harness owns authorized cells and their journal. */
export class HarnessThink extends Think<DemoEnv> {
  includeMcpTools = false;
  maxSteps = 8;
  sendReasoning = false;
  getModel(): ThinkModel {
    return "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
  }
  private request(): ModelRequest {
    const request = this.activeTurnMetadata as unknown as ModelRequest | undefined;
    invariant(
      request?.rootId && request.sandbox,
      "ACCESS_DENIED",
      "This model turn has no authenticated root-run context.",
    );
    return request;
  }
  private application() {
    return application(this.env, this.request().sandbox);
  }
  getTools() {
    return {
      inspectWorkspace: tool({
        description:
          "Inspect named durable bindings, retained helper functions, current customer preferences, and authorized recent conversation.",
        inputSchema: z.object({
          binding: z.string().optional(),
          path: z.array(z.union([z.string(), z.number()])).optional(),
        }),
        execute: async ({ binding, path }) =>
          modelData(await this.application().modelContext(this.request().rootId, binding, path)),
      }),
      executeCell: tool({
        description:
          "Execute a sandboxed TypeScript cell. Top-level named data persists after success. Retained helpers must take mutable data as arguments. Use tools.search/describe/call for authorized capabilities; history.search/read/around for originals; memory.read/write and artifacts.read/write for retained knowledge. Use runtime.now/uuid/random for nondeterminism. An approval or connection pause preserves the cell identity and settled operations. Do not repeat a paused action in a new cell.",
        inputSchema: z.object({ source: z.string().min(1).max(16_000) }),
        execute: async ({ source }, { toolCallId }) =>
          modelData(await this.application().modelCell(this.request().rootId, source, toolCallId)),
      }),
    };
  }
  async beforeTurn(_context: TurnContext) {
    const request = this.request();
    const context = await this.application().modelContext(request.rootId);
    const instructions = `You are a procurement assistant working in a synthetic demonstration. Work only in workspace ${request.workspaceId}. All supplier and ERP operations are synthetic. Use inspectWorkspace and executeCell to create useful working structures and explicit helper functions. Inspect the namespace before reusing or changing bindings. Never claim a message was sent without a delivery receipt. When approval is required, report that it is waiting. Your text is customer-facing; use clear, specific language and do not include hidden diagnostics. Preserve the customer's business rules. The current evaluated preferences are ${JSON.stringify(context.preferences?.value)}. Retained bindings and helper handles: ${JSON.stringify(context.workspace)}. Tool names are discoverable with tools.search("").`;
    const prepared = await this.application().modelPrepared(request.rootId, instructions);
    return {
      instructions,
      messages: prepared.messages,
      activeTools: ["inspectWorkspace", "executeCell"],
      maxSteps: 8,
      maxOutputTokens: 2048,
      maxRetries: 0,
      timeout: 120_000,
      sendReasoning: false,
    };
  }
  async beforeStep(context: PrepareStepContext) {
    const request = this.request();
    const stepId = `${request.rootId}:${context.stepNumber}`;
    // Conservative admission estimate includes tool schemas, instructions and output headroom.
    const estimate = Math.ceil(JSON.stringify(context.messages).length / 3) + 4096;
    await this.application().modelReserve(request.rootId, stepId, estimate);
    await this.ctx.storage.put(`budget-step:${request.rootId}`, stepId);
    return { activeTools: ["inspectWorkspace", "executeCell"] };
  }
  async onStepEnd(context: StepContext) {
    const request = this.request();
    const stepId = await this.ctx.storage.get<string>(`budget-step:${request.rootId}`);
    if (stepId && context.usage.totalTokens !== undefined)
      await this.application().modelSettle(request.rootId, stepId, context.usage.totalTokens);
    if (stepId)
      await this.application().modelStep(request.rootId, stepId, {
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
  async run(request: ModelRequest): Promise<void> {
    let buffer = "";
    let sequence = 0;
    let lastFlush = Date.now();
    let terminal = false;
    const parent = application(this.env, request.sandbox);
    const attempt = crypto.randomUUID();
    const flush = async () => {
      if (!buffer) return;
      const text = buffer;
      buffer = "";
      await parent.modelEvent(
        request.rootId,
        "delta",
        text,
        `${request.rootId}:${attempt}:${sequence++}`,
      );
      lastFlush = Date.now();
    };
    await this.chat(
      request.message,
      {
        onStart: async () => {},
        onEvent: async (json) => {
          const event = JSON.parse(json) as { type: string; delta?: string };
          if (event.type === "text-delta" && event.delta) {
            buffer += event.delta;
            if (buffer.length >= 256 || Date.now() - lastFlush >= 100) await flush();
          }
        },
        onDone: async () => {
          if (!terminal) {
            terminal = true;
            await flush();
            await parent.modelEvent(request.rootId, "completed", "");
          }
        },
        onError: async (error) => {
          if (!terminal) {
            terminal = true;
            await flush();
            await parent.modelEvent(request.rootId, "failed", error);
          }
        },
        onInterrupted: async () => {
          if (!terminal) {
            terminal = true;
            await flush();
            await parent.modelEvent(request.rootId, "interrupted", "");
          }
        },
      },
      {
        metadata: request as unknown as Record<string, unknown>,
        channel: "web",
        signal: AbortSignal.timeout(120_000),
      },
    );
  }
}
