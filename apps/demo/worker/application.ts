import { DurableObject } from "cloudflare:workers";
import { getAgentByName } from "agents";
import {
  Artifacts,
  ContextManager,
  DurableWorkspace,
  HarnessFault,
  Learning,
  Memory,
  RunBudgets,
  asFault,
  decodeGraph,
  invariant,
  type CellRecord,
  type ContextReceipt,
  type HarnessEvent,
  type KnowledgeSpace,
  type OperationRecord,
  type Principal,
  type RootRun,
} from "@durable-harness/core";
import { CloudflareCellExecutor, R2Artifacts, durableStore } from "@durable-harness/cloudflare";
import {
  DEMO_DEPLOYMENT,
  domainTools,
  initialPreferences,
  operator,
  preferencesTarget,
  scenarioSource,
  workspaces,
  type ProcurementPreferences,
} from "./domain.js";
import type { DemoCommand, DemoEnv, ModelRequest, Persona } from "./protocol.js";
import { personaSchema } from "./protocol.js";

export function principalFor(persona: Persona): Principal {
  return {
    id: persona,
    deploymentId: DEMO_DEPLOYMENT,
    roles: [persona === "developer" ? "developer" : "customer"],
  };
}
interface Subscription {
  principal: Principal;
  workspaceId: string;
  cursor: number;
}

/** Each browser experiment receives an isolated Durable Object with synthetic tenants. */
export class DemoApplication extends DurableObject<DemoEnv> {
  private readonly records = durableStore(this.ctx);
  private readonly memory = new Memory(this.records);
  private readonly learning = new Learning(this.records, [preferencesTarget()]);
  private readonly budgets = new RunBudgets(this.records);
  private readonly workspace = new DurableWorkspace(
    this.records,
    new CloudflareCellExecutor(this.env.LOADER),
    {
      tools: domainTools(this.records),
      memory: this.memory,
      artifacts: new Artifacts(this.records, new R2Artifacts(this.env.ARTIFACTS)),
      publish: (event) => this.publish(event),
    },
  );
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const persona = personaSchema.parse(request.headers.get("x-dh-persona"));
    invariant(
      request.headers.get("upgrade")?.toLowerCase() === "websocket",
      "INVALID_INPUT",
      "This transport only accepts a WebSocket upgrade.",
    );
    return this.subscribe(
      persona,
      url.searchParams.get("workspace")!,
      Number(url.searchParams.get("after") ?? 0),
    );
  }

  private seed(): void {
    invariant(
      this.env.DEMO_MODE === "synthetic",
      "ACCESS_DENIED",
      "Synthetic identity switching is disabled in this deployment.",
    );
    if (this.records.get("metadata", "seeded")) return;
    this.records.transaction(() => {
      for (const workspace of workspaces) {
        const buyer = workspace.id.startsWith("cedar") ? "cedar" : "northstar";
        const space: KnowledgeSpace = {
          id: workspace.id,
          deploymentId: DEMO_DEPLOYMENT,
          kind: "tenant",
          label: `${workspace.tenant} · ${workspace.label}`,
          revision: 1,
          grants: [
            { principalId: "developer", permissions: ["read", "write", "execute", "publish"] },
            { principalId: buyer, permissions: ["read", "write", "execute"] },
          ],
        };
        this.records.put("spaces", space.id, space);
        this.learning.initialize(operator, space.id, "procurement-preferences", initialPreferences);
        this.workspace.history.append({
          id: `${space.id}:welcome`,
          workspaceId: space.id,
          role: "user",
          text:
            workspace.kind === "po"
              ? "Check PO-1042 and prepare the next supplier follow-up. Ask me before sending."
              : "Compare the supplier quotes and recommend an option. Ask me before contacting suppliers.",
          audience: "customer",
          lineage: [],
          metadata: { evidence: "synthetic" },
        });
        this.workspace.events.append({
          workspaceId: space.id,
          kind: "work.created",
          audience: "customer",
          text:
            workspace.kind === "po"
              ? "Purchase order ready to review"
              : "Two supplier quotes ready to compare",
          data: { evidence: "synthetic" },
          lineage: [],
        });
      }
      this.records.put("metadata", "seeded", true);
    });
  }

  state(persona: Persona, workspaceId?: string) {
    this.seed();
    const principal = principalFor(persona);
    const visible = workspaces.filter((workspace) =>
      this.workspace.access.permits(principal, workspace.id, "read"),
    );
    const selected = workspaceId ?? visible[0]!.id;
    this.workspace.access.require(principal, selected, "read");
    const cells = this.records
      .list<CellRecord>("cells")
      .filter((cell) => cell.workspaceId === selected);
    const pending = this.records
      .list<OperationRecord>("operations")
      .filter(
        (operation) =>
          cells.some((cell) => cell.id === operation.cellId) &&
          operation.status === "pending_approval" &&
          this.workspace.access.visible(principal, selected, operation.lineage ?? []),
      )
      .map((operation) => ({
        id: operation.id,
        cellId: operation.cellId,
        tool: operation.tool,
        input: decodeGraph(operation.input).input,
      }));
    return {
      persona,
      workspaces: visible,
      selected,
      evidence: "synthetic" as const,
      events: this.workspace.events.read(principal, selected),
      history: this.workspace.history.list(principal, selected),
      pending,
      configuration: this.learning.configuration(principal, selected, "procurement-preferences"),
      proposals: this.learning.list(principal, selected),
      clusters: this.learning.clusters(principal, selected),
      memories: this.memory
        .list(principal, selected)
        .map((entry) => ({ ...entry, value: decodeGraph(entry.value).value })),
      cells: cells.map((cell) => ({
        id: cell.id,
        status: cell.status,
        revision: cell.committedRevision,
        error: cell.error,
        createdAt: cell.createdAt,
        ...(persona === "developer" ? { source: cell.source, attempt: cell.attempt } : {}),
      })),
      ...(persona === "developer"
        ? {
            workspace: this.workspace.inspect(principal, selected),
            operations: cells.flatMap((cell) =>
              this.workspace.operations(principal, selected, cell.id),
            ),
            compactions: this.records
              .list<ContextReceipt>("compactions")
              .filter((receipt) => receipt.workspaceId === selected),
            evaluations: this.learning
              .list(principal, selected)
              .flatMap((proposal) =>
                proposal.evaluationId
                  ? [this.records.get("evaluations", proposal.evaluationId)]
                  : [],
              ),
            runs: this.records.list<RootRun>("root_runs"),
            modelSteps: this.records.list<{
              rootId: string;
              stepId: string;
              calls: unknown[];
              results: unknown[];
              errors: unknown[];
              finishReason: string;
              mirroredFields?: number;
            }>("model_steps"),
          }
        : {}),
    };
  }
  apiState(persona: Persona, workspaceId?: string) {
    try {
      return { ok: true as const, value: this.state(persona, workspaceId) };
    } catch (error) {
      return { ok: false as const, error: asFault(error).toJSON() };
    }
  }
  async apiCommand(
    sandbox: string,
    persona: Persona,
    workspaceId: string,
    command: DemoCommand,
    realModelAllowed: boolean,
  ) {
    try {
      return {
        ok: true as const,
        value: await this.command(sandbox, persona, workspaceId, command, realModelAllowed),
      };
    } catch (error) {
      return { ok: false as const, error: asFault(error).toJSON() };
    }
  }

  async command(
    sandbox: string,
    persona: Persona,
    workspaceId: string,
    command: DemoCommand,
    realModelAllowed = false,
  ) {
    this.seed();
    const principal = principalFor(persona);
    this.workspace.access.require(principal, workspaceId, "write");
    if (command.action === "run-synthetic")
      return this.execute(principal, workspaceId, scenarioSource(workspaceId), crypto.randomUUID());
    if (command.action === "prepare-message")
      return this.execute(
        principal,
        workspaceId,
        `const delivery = await tools.call(${JSON.stringify(`${workspaceId}.send`)}, { subject: "Delivery confirmation", body: "Hello, please confirm the expected dispatch date and let us know if anything has changed. Thank you." });`,
        crypto.randomUUID(),
      );
    if (command.action === "cell") {
      invariant(
        persona === "developer",
        "ACCESS_DENIED",
        "The workspace editor requires developer access.",
      );
      return this.workspace.execute(principal, workspaceId, command.source, {
        id: command.id,
        expectedRevision: command.expectedRevision,
      });
    }
    if (command.action === "correct") {
      const feedbackId = crypto.randomUUID();
      this.workspace.history.append({
        id: feedbackId,
        workspaceId,
        role: "user",
        text: command.text,
        audience: "customer",
        lineage: [],
        metadata: { evidence: "synthetic", kind: "correction" },
      });
      this.workspace.events.append({
        workspaceId,
        kind: "message.completed",
        audience: "customer",
        text: command.text,
        data: { author: "customer", sourceId: feedbackId },
        lineage: [],
      });
      this.learning.feedback(principal, {
        id: feedbackId,
        workspaceId,
        agent: workspaceId.includes("-po") ? "po" : "quoting",
        kind: "correction",
        text: command.text,
        sourceRunId:
          this.records
            .list<CellRecord>("cells")
            .filter((cell) => cell.workspaceId === workspaceId)
            .at(-1)?.id ?? "before-first-run",
        lineage: [],
        corrected: { [command.preference]: true },
      });
      const baseline = this.learning.configuration(
        principal,
        workspaceId,
        "procurement-preferences",
      )!;
      const candidate = {
        ...(baseline.value as ProcurementPreferences),
        [command.preference]: true,
      };
      const proposal = this.learning.propose(principal, {
        workspaceId,
        kind: "instruction",
        target: "procurement-preferences",
        baseRevision: baseline.revision,
        candidate,
        rationale: command.text,
        evidenceIds: [feedbackId],
        lineage: [{ spaceId: workspaceId, itemId: feedbackId }],
        origin: "customer_correction",
      });
      this.workspace.events.append({
        workspaceId,
        kind: "learning.evaluating",
        audience: "customer",
        text: "Testing your correction against the existing procurement checks",
        data: { proposalId: proposal.id },
        lineage: [],
      });
      const evaluation = await this.learning.evaluate(principal, proposal.id);
      if (evaluation.eligible) {
        await this.learning.promote(principal, proposal.id);
        this.workspace.events.append({
          workspaceId,
          kind: "learning.promoted",
          audience: "customer",
          text: "Your preference passed the checks and will apply to the next run",
          data: { proposalId: proposal.id, evaluationId: evaluation.id },
          lineage: [],
        });
      } else
        this.workspace.events.append({
          workspaceId,
          kind: "learning.review",
          audience: "customer",
          text: "The tests did not establish an improvement. Your current preferences are still active.",
          data: { proposalId: proposal.id },
          lineage: [],
        });
      return { proposal: this.learning.read(principal, proposal.id), evaluation };
    }
    if (command.action === "approve" || command.action === "reject") {
      if (command.action === "reject") {
        this.workspace.reject(principal, workspaceId, command.operationId);
        return { rejected: true };
      }
      this.workspace.approve(principal, workspaceId, command.operationId);
      const operation = this.records.get<OperationRecord>("operations", command.operationId)!;
      return this.resume(principal, workspaceId, operation.cellId);
    }
    if (command.action === "resume") return this.resume(principal, workspaceId, command.cellId);
    if (command.action === "compact") {
      invariant(
        persona === "developer",
        "ACCESS_DENIED",
        "The compaction inspector requires developer access.",
      );
      const prepared = await new ContextManager(this.records).prepare(
        principal,
        workspaceId,
        "portable-exercise",
        {
          contextWindow: 2000,
          outputReserve: 300,
          instructions: "Retain customer constraints and pending work.",
          toolSchemas: {},
        },
        async ({ text }) =>
          text
            .split("\n")
            .filter((line) => /correction|exception|Tuesday|approval/i.test(line))
            .slice(0, 5)
            .map((line) => line.slice(0, 200))
            .join("\n") ||
          "Original events remain available through history retrieval. Inspect the workspace and pending operations before continuing.",
      );
      this.workspace.events.append({
        workspaceId,
        kind: "context.prepared",
        audience: "developer",
        text: prepared.receipt
          ? "Created a continuation checkpoint; original events are retained"
          : "Context fits its budget; no summary was needed",
        data: {
          estimatedTokens: prepared.estimatedTokens,
          receiptId: prepared.receipt?.id ?? null,
        },
        lineage: [],
      });
      return prepared;
    }
    invariant(
      realModelAllowed && persona === "developer",
      "ACCESS_DENIED",
      "Real-model experiments require the deployment's administrator token and a finite run budget.",
    );
    if (command.action === "probe-model") {
      const id = crypto.randomUUID();
      this.budgets.start(id, { steps: 1, tokens: 4096, activeMs: 30_000, descendants: 1 });
      this.budgets.reserve(id, "probe", 4096);
      const response = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [{ role: "user", content: "Call the capture tool with the text alpha beta." }],
        tools: [
          {
            type: "function",
            function: {
              name: "capture",
              description: "Capture a test string",
              parameters: {
                type: "object",
                properties: { text: { type: "string", description: "The literal probe text." } },
                required: ["text"],
              },
            },
          },
        ],
        stream: true,
        max_tokens: 128,
      });
      const result =
        response instanceof ReadableStream
          ? await new Response(response).text()
          : JSON.stringify(response);
      invariant(
        result.length <= 64_000,
        "BUDGET_EXCEEDED",
        "The provider probe exceeded its output bound.",
      );
      this.budgets.complete(id);
      return { rootId: id, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", wire: result };
    }
    const rootId = crypto.randomUUID();
    // Customer-facing generation starts with the selected customer's authority.
    const principalId = workspaceId.startsWith("cedar") ? "cedar" : "northstar";
    const request: ModelRequest = {
      sandbox,
      workspaceId,
      principalId,
      rootId,
      message: command.message,
    };
    this.budgets.start(rootId);
    this.records.put("model_requests", rootId, request);
    this.workspace.history.append({
      id: rootId,
      workspaceId,
      role: "user",
      text: command.message,
      audience: "customer",
      lineage: [],
      metadata: { evidence: "real-model", rootId },
    });
    this.workspace.events.append({
      workspaceId,
      kind: "model.started",
      audience: "customer",
      text: "The agent is working on your request",
      data: { rootId, evidence: "real-model" },
      lineage: [],
    });
    const agent = await getAgentByName(
      this.env.MODEL_AGENTS,
      `${sandbox}:${workspaceId}:${principalId}`,
    );
    this.ctx.waitUntil(
      agent
        .run(request)
        .catch((error) => this.modelEvent(rootId, "failed", asFault(error).message)),
    );
    return { rootId, status: "running" };
  }

  private async execute(principal: Principal, workspaceId: string, source: string, id: string) {
    try {
      return await this.workspace.execute(principal, workspaceId, source, { id });
    } catch (error) {
      const fault = asFault(error);
      if (["APPROVAL_REQUIRED", "RECONNECTION_REQUIRED", "EFFECT_UNCERTAIN"].includes(fault.code))
        return { cellId: id, recovery: fault.toJSON() };
      throw error;
    }
  }
  private async resume(principal: Principal, workspaceId: string, cellId: string) {
    const cell = this.records.get<CellRecord>("cells", cellId);
    invariant(
      cell?.workspaceId === workspaceId,
      "NOT_FOUND",
      "No cell exists with that reference.",
    );
    this.workspace.access.requireSources(principal, cell.starting.lineage);
    return this.execute(
      principalFor(cell.principalId as Persona),
      workspaceId,
      cell.source,
      cell.id,
    );
  }

  async modelContext(rootId: string, binding?: string, path: (string | number)[] = []) {
    const request = this.modelRequest(rootId);
    const principal = principalFor(request.principalId as Persona);
    return {
      workspace: this.workspace.inspect(principal, request.workspaceId),
      ...(binding
        ? { value: this.workspace.readBinding(principal, request.workspaceId, binding, path) }
        : {}),
      history: this.workspace.history
        .list(principal, request.workspaceId)
        .slice(-8)
        .map((item) => ({ ...item, text: item.text.slice(0, 2000) })),
      preferences: this.learning.configuration(
        principal,
        request.workspaceId,
        "procurement-preferences",
      ),
    };
  }
  async modelPrepared(rootId: string, instructions: string) {
    const request = this.modelRequest(rootId);
    return new ContextManager(this.records).prepare(
      principalFor(request.principalId as Persona),
      request.workspaceId,
      this.env.MODEL_ID,
      {
        contextWindow: 24_000,
        outputReserve: 2048,
        instructions,
        toolSchemas: {
          inspectWorkspace: "namespace and conversation inspection",
          executeCell: "bounded TypeScript source",
        },
        fraction: 0.6,
      },
      async ({ text }) =>
        `Earlier exchanges have been archived. Recover exact original events with history.search/read/around. Recent constraints:\n${text
          .split("\n")
          .filter((line) => /approval|correction|exception/i.test(line))
          .slice(-8)
          .map((line) => line.slice(0, 300))
          .join("\n")}`,
    );
  }
  modelReserve(rootId: string, stepId: string, tokens: number) {
    this.modelRequest(rootId);
    this.budgets.reserve(rootId, stepId, tokens);
  }
  modelSettle(rootId: string, stepId: string, tokens: number) {
    this.modelRequest(rootId);
    this.budgets.settle(rootId, stepId, tokens);
  }
  modelStep(
    rootId: string,
    stepId: string,
    evidence: {
      calls: unknown[];
      results: unknown[];
      errors: unknown[];
      finishReason: string;
      mirroredFields?: number;
    },
  ): void {
    this.modelRequest(rootId);
    this.records.put("model_steps", stepId, { rootId, stepId, ...evidence });
  }
  async modelCell(rootId: string, source: string, cellId: string) {
    const request = this.modelRequest(rootId);
    const result = await this.execute(
      principalFor(request.principalId as Persona),
      request.workspaceId,
      source,
      cellId,
    );
    if ("recovery" in result) this.budgets.pause(rootId);
    return "workspace" in result
      ? {
          cellId,
          revision: result.workspace.revision,
          namespace: this.workspace.inspect(
            principalFor(request.principalId as Persona),
            request.workspaceId,
          ),
        }
      : result;
  }
  modelEvent(
    rootId: string,
    kind: "delta" | "completed" | "failed" | "interrupted",
    text: string,
    chunkId?: string,
  ): void {
    const request = this.modelRequest(rootId);
    const principal = principalFor(request.principalId as Persona);
    const lineage = this.workspace.snapshot(principal, request.workspaceId).lineage;
    if (this.records.get("model_terminals", rootId)) return;
    const run = this.budgets.read(rootId);
    const lastStep = this.records
      .list<{ rootId: string; finishReason: string }>("model_steps")
      .filter((step) => step.rootId === rootId)
      .at(-1);
    if (kind === "completed" && run.steps >= run.limits.steps && lastStep?.finishReason !== "stop")
      kind = "interrupted";
    if (chunkId && this.records.get("model_chunks", chunkId)) return;
    const previous = this.records.get<string>("model_text", rootId) ?? "";
    const content = kind === "delta" ? previous + text : previous;
    invariant(
      content.length <= 64_000,
      "BUDGET_EXCEEDED",
      "The model response reached its retained text limit.",
    );
    this.records.transaction(() => {
      if (kind === "delta") this.records.put("model_text", rootId, content);
      if (chunkId) this.records.put("model_chunks", chunkId, true);
      if (kind === "completed" || kind === "failed")
        this.records.put("model_terminals", rootId, kind);
      this.workspace.events.append({
        workspaceId: request.workspaceId,
        kind: `model.${kind}`,
        audience: "customer",
        text:
          kind === "delta"
            ? text
            : kind === "completed"
              ? "Agent response finished"
              : kind === "interrupted"
                ? "The agent was interrupted; its progress is saved"
                : "The agent could not complete this run",
        data: {
          rootId,
          ...(kind === "failed"
            ? { recovery: "Inspect the developer timeline before resuming." }
            : {}),
        },
        lineage,
      });
    });
    if (kind === "completed") {
      this.workspace.history.append({
        id: `${rootId}:assistant`,
        workspaceId: request.workspaceId,
        role: "assistant",
        text: content,
        audience: "customer",
        lineage,
        metadata: { evidence: "real-model", rootId },
      });
      this.budgets.complete(rootId);
    } else if (kind !== "delta") this.budgets.pause(rootId);
    if (kind === "failed")
      this.workspace.events.append({
        workspaceId: request.workspaceId,
        kind: "model.diagnostic",
        audience: "developer",
        text,
        data: { rootId },
        lineage,
      });
  }
  private modelRequest(rootId: string): ModelRequest {
    const request = this.records.get<ModelRequest>("model_requests", rootId);
    invariant(request, "NOT_FOUND", "This model run does not exist.");
    this.workspace.access.require(
      principalFor(request.principalId as Persona),
      request.workspaceId,
      "execute",
    );
    return request;
  }

  subscribe(persona: Persona, workspaceId: string, after: number): Response {
    this.seed();
    const principal = principalFor(persona);
    const backlog = this.workspace.events.read(principal, workspaceId, after);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ principal, workspaceId, cursor: after } satisfies Subscription);
    for (const event of backlog) {
      server.send(JSON.stringify(event));
      after = event.sequence;
    }
    server.serializeAttachment({ principal, workspaceId, cursor: after } satisfies Subscription);
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send("pong");
  }
  private publish(event: HarnessEvent): void {
    for (const socket of this.ctx.getWebSockets()) {
      const subscription = socket.deserializeAttachment() as Subscription;
      if (subscription.workspaceId !== event.workspaceId || subscription.cursor >= event.sequence)
        continue;
      try {
        for (const visible of this.workspace.events.read(
          subscription.principal,
          subscription.workspaceId,
          subscription.cursor,
        )) {
          socket.send(JSON.stringify(visible));
          subscription.cursor = visible.sequence;
        }
        socket.serializeAttachment(subscription);
      } catch {
        socket.close(1008, "Access changed. Reconnect to refresh your session.");
      }
    }
  }
}
