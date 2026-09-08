import type { SupplierOffer } from "./supplier.js";
import { DurableObject } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { MCPClientManager } from "agents/mcp/client";
import {
  Artifacts,
  Capabilities,
  AgentRegistry,
  ContextManager,
  DEFAULT_RUN_LIMITS,
  Connections,
  DurableWorkspace,
  HarnessFault,
  Learning,
  LearningPipeline,
  type LearningRun,
  Memory,
  RunBudgets,
  asFault,
  decodeGraph,
  inspectGraph,
  invariant,
  type CellRecord,
  type ContextReceipt,
  type HarnessEvent,
  type KnowledgeSpace,
  type OperationRecord,
  type Principal,
  type RootRun,
  type ToolDefinition,
} from "@durable-harness/core";
import {
  CloudflareCellExecutor,
  PureCapabilityExecutor,
  CloudflareMcpTransport,
  EncryptedSecrets,
  EncryptedCredentialVault,
  cloudflareOAuthProvider,
  R2Artifacts,
  durableStore,
  modelData,
  workersAICandidateGenerator,
} from "@durable-harness/cloudflare";
import {
  DEMO_DEPLOYMENT,
  capabilityProtocols,
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
import { z } from "zod";

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
  private readonly instanceId = crypto.randomUUID();
  private readonly records = durableStore(this.ctx);
  private readonly secrets = new EncryptedSecrets(this.records, this.env.CREDENTIAL_KEY);
  private readonly authProvider = (callback: string) =>
    cloudflareOAuthProvider(this.secrets, this.ctx.id.toString(), callback);
  private readonly mcpManager = new MCPClientManager("durable-harness", "0.1.0", {
    createAuthProvider: (callback) => this.authProvider(callback),
  });
  private readonly mcpLifecycle = new Lifecycle(this).use(this.mcpManager);
  private readonly mcpTransport = new CloudflareMcpTransport(this.mcpManager, {
    start: () => this.mcpLifecycle.start(),
    callbackUrl: (id) =>
      `${this.records.get<string>("metadata", "mcp-origin")}/api/mcp/callback/${id}`,
    authProvider: (callback) => this.authProvider(callback),
  });
  private readonly connections = new Connections(
    this.records,
    new EncryptedCredentialVault(this.secrets),
    this.mcpTransport,
  );
  private readonly agents = new AgentRegistry(this.records);
  private readonly capabilities = new Capabilities(
    this.records,
    new PureCapabilityExecutor(this.env.LOADER),
    capabilityProtocols(),
  );
  private readonly memory = new Memory(this.records);
  private readonly learning = new Learning(this.records, [preferencesTarget()]);
  private readonly pipeline = new LearningPipeline(this.records, this.learning, {
    id: "synthetic-preference-projection-v1",
    origin: "customer_correction",
    maxCandidates: 1,
    reserveTokens: () => 0,
    generate: async (context) => ({
      candidate: {
        ...(context.baseline as ProcurementPreferences),
        ...Object.assign({}, ...context.evidence.map((item) => item.corrected ?? {})),
      },
      rationale: context.evidence.at(-1)!.text,
      usedTokens: 0,
    }),
  });
  private readonly modelGenerator = this.createProposalGenerator();
  protected createProposalGenerator() {
    return workersAICandidateGenerator(this.env.AI, this.env.MODEL_ID, {
      version: "procurement-proposer-v1",
      instructions:
        "Only change preference keys explicitly identified by the correction evidence. Keep approvalRequired true. Preserve every unrelated preference.",
      candidateSchema: z
        .object({
          includeFreight: z.boolean(),
          businessDaysOnly: z.boolean(),
          approvalRequired: z.literal(true),
        })
        .strict(),
    });
  }
  private readonly modelPipeline = new LearningPipeline(
    this.records,
    this.learning,
    this.modelGenerator,
    { onTransition: (run) => this.learningTransition(run) },
  );
  private readonly activeLearning = new Set<string>();
  private readonly budgets = new RunBudgets(this.records);
  private readonly workspace = new DurableWorkspace(
    this.records,
    new CloudflareCellExecutor(this.env.LOADER),
    {
      tools: () => [
        ...domainTools(this.records, (input, context) => this.verifySuppliers(input, context)),
        ...this.connections.capabilities(),
        ...this.capabilities.definitions(),
      ],
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
    if (!this.records.get("spaces", "shared-library"))
      this.records.put("spaces", "shared-library", {
        id: "shared-library",
        deploymentId: DEMO_DEPLOYMENT,
        kind: "library",
        label: "Reviewed shared library",
        revision: 1,
        grants: [
          { principalId: "developer", permissions: ["read", "write", "execute", "publish"] },
          { principalId: "northstar", permissions: ["read", "execute"] },
          { principalId: "cedar", permissions: ["read", "execute"] },
        ],
      } satisfies KnowledgeSpace);
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
      .filter(
        (cell) =>
          cell.workspaceId === selected &&
          this.workspace.access.visible(principal, selected, cell.lineage ?? cell.starting.lineage),
      );
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
      runtimeInstanceId: this.instanceId,
      workspaces: visible,
      selected,
      evidence: "synthetic" as const,
      model: { id: this.env.MODEL_ID, limits: DEFAULT_RUN_LIMITS },
      connections: this.connections.list(principal, selected).map((connection) => {
        const { authorizationUrl, ...publicConnection } = connection;
        return {
          ...publicConnection,
          ...(connection.ownerId === principal.id && authorizationUrl ? { authorizationUrl } : {}),
        };
      }),
      connectionPolicy: {
        allowedOrigins: (this.env.MCP_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
      },
      events: this.workspace.events.read(principal, selected),
      history: this.workspace.history.list(principal, selected),
      pending,
      configuration: this.learning.configuration(principal, selected, "procurement-preferences"),
      proposals: this.learning.list(principal, selected),
      capabilities: this.capabilities.list(principal),
      capabilityProtocols: capabilityProtocols().map(({ id, description }) => ({
        id,
        description,
      })),
      agents: this.agents.list(principal, selected),
      learningRuns: this.records
        .list<LearningRun>("learning_runs")
        .filter(
          (run) =>
            run.workspaceId === selected &&
            this.workspace.access.visible(principal, selected, run.lineage),
        ),
      clusters: this.learning.clusters(principal, selected),
      memories: this.memory
        .list(principal, selected)
        .map((entry) => ({ ...entry, value: decodeGraph(entry.value).value })),
      cells: cells.map((cell) => ({
        id: cell.id,
        status: cell.status,
        revision: cell.committedRevision,
        error: cell.error
          ? {
              code: cell.error.code,
              message:
                persona === "developer"
                  ? cell.error.message
                  : "This cell stopped. Its saved progress and recorded actions remain available.",
            }
          : undefined,
        createdAt: cell.createdAt,
        ...(persona === "developer"
          ? {
              source: cell.source,
              attempt: cell.attempt,
              output:
                cell.output?.kind === "inline" ? inspectGraph(cell.output.graph) : cell.output,
            }
          : {}),
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
              modelId?: string;
              usage?: {
                inputTokens: number | null;
                outputTokens: number | null;
                totalTokens: number | null;
              };
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
    transportOrigin?: string,
  ) {
    try {
      return {
        ok: true as const,
        value: await this.command(
          sandbox,
          persona,
          workspaceId,
          command,
          realModelAllowed,
          transportOrigin,
        ),
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
    transportOrigin?: string,
  ) {
    this.seed();
    const principal = principalFor(persona);
    this.workspace.access.require(principal, workspaceId, "write");
    if (command.action === "propose-capability")
      return this.capabilities.propose(principal, {
        spaceId: workspaceId,
        helperName: command.helperName,
        name: command.name,
        protocolId: command.protocolId,
      });
    if (command.action === "evaluate-capability")
      return this.capabilities.evaluate(principal, command.id);
    if (command.action === "approve-capability")
      return this.capabilities.approve(principal, command.id);
    if (command.action === "publish-capability")
      return this.capabilities.publish(
        principal,
        command.id,
        "shared-library",
        command.expectedRevision,
      );
    if (command.action === "use-capability") {
      const capability = this.capabilities.read(principal, command.id);
      invariant(
        capability.status === "approved" || capability.status === "published",
        "ACCESS_DENIED",
        "Only an approved capability can be used.",
      );
      invariant(
        workspaces.find((item) => item.id === workspaceId)?.kind === "quoting",
        "INVALID_INPUT",
        "Use a quoting workspace for this capability.",
      );
      return this.execute(
        principal,
        workspaceId,
        `const capabilityEvidence = await tools.call(${JSON.stringify(`${workspaceId}.read`)}, {}); const capabilityPreferences = await tools.call(${JSON.stringify(`${workspaceId}.preferences`)}, {}); const sharedComparison = await tools.call(${JSON.stringify(`capability.${capability.spaceId}.${capability.name}.v${capability.revision}`)}, {rfq:capabilityEvidence.rfq,offers:capabilityEvidence.offers,includeFreight:capabilityPreferences.includeFreight,businessDaysOnly:capabilityPreferences.businessDaysOnly}); sharedComparison;`,
        crypto.randomUUID(),
      );
    }
    if (command.action === "read-model-step") {
      invariant(
        persona === "developer",
        "ACCESS_DENIED",
        "Original model messages require developer access.",
      );
      const request = this.records.get<ModelRequest>("model_requests", command.rootId);
      invariant(
        request?.workspaceId === workspaceId,
        "NOT_FOUND",
        "No model run belongs to this workspace with that identity.",
      );
      this.workspace.snapshot(principal, workspaceId);
      const agent = await getAgentByName(
        this.env.MODEL_AGENTS,
        `${request.sandbox}:${workspaceId}:${request.principalId}`,
      );
      return agent.originalStep(command.rootId, command.stepId, command.offset, command.length);
    }
    if (command.action === "mcp-add") {
      invariant(
        transportOrigin,
        "INVALID_INPUT",
        "Connect MCP servers through the authenticated application transport.",
      );
      invariant(
        (this.env.MCP_ALLOWED_ORIGINS ?? "").split(",").includes(new URL(command.url).origin),
        "ACCESS_DENIED",
        "This MCP origin is not enabled by the deployment's connection policy.",
      );
      const previousOrigin = this.records.get<string>("metadata", "mcp-origin");
      invariant(
        !previousOrigin || previousOrigin === transportOrigin,
        "INVALID_INPUT",
        "Authorize this connection from its original application origin.",
      );
      this.records.put("metadata", "mcp-origin", transportOrigin);
      invariant(
        command.auth !== "bearer" || command.accessToken,
        "INVALID_INPUT",
        "Enter the service token for this connection.",
      );
      const connected = await this.connections.add(
        principal,
        { spaceId: workspaceId, name: command.name, url: command.url, auth: command.auth },
        command.accessToken ? { accessToken: command.accessToken } : undefined,
      );
      this.connectionEvent(workspaceId, connected.id, connected.state);
      return modelData(connected);
    }
    if (command.action.startsWith("mcp-")) {
      const input = command as Extract<DemoCommand, { connectionId: string }>;
      const connection = this.connections.read(principal, input.connectionId);
      invariant(
        connection.spaceId === workspaceId,
        "ACCESS_DENIED",
        "This connection belongs to another workspace.",
      );
      if (input.action === "mcp-discover") {
        const result = await this.connections.discover(principal, input.connectionId);
        this.connectionEvent(workspaceId, result.id, result.state);
        return modelData(result);
      }
      if (input.action === "mcp-grant")
        return modelData(
          this.connections.allowTools(
            principal,
            input.connectionId,
            input.tools,
            input.fingerprint,
          ),
        );
      if (input.action === "mcp-revoke") {
        await this.connections.revoke(principal, input.connectionId);
        this.connectionEvent(workspaceId, input.connectionId, "revoked");
        return { revoked: true };
      }
      if (input.action === "mcp-call")
        return this.execute(
          principal,
          workspaceId,
          `const connectionResult = await tools.call(${JSON.stringify(`mcp.${connection.id}.${input.tool}`)}, ${JSON.stringify(input.input)});`,
          crypto.randomUUID(),
        );
    }
    if (command.action === "seed-history") {
      invariant(
        persona === "developer" && realModelAllowed,
        "ACCESS_DENIED",
        "Long-history fixtures require an authorized operator.",
      );
      this.records.transaction(() => {
        for (let index = 0; index < 80; index++)
          this.workspace.history.append({
            id: `${workspaceId}:history-fixture:${index}`,
            workspaceId,
            role: "assistant",
            text:
              `Synthetic archive note ${index}. ` +
              "This historical fixture supports context-recovery testing. Supplier messages still require approval. ".repeat(
                10,
              ),
            audience: "customer",
            lineage: [],
            metadata: { evidence: "synthetic", fixture: true },
          });
      });
      this.workspace.events.append({
        workspaceId,
        kind: "context.fixture_added",
        audience: "developer",
        text: "Added 80 labeled synthetic archive entries for compaction testing",
        data: { entries: 80 },
        lineage: [],
      });
      return { entries: 80 };
    }
    if (command.action === "restart-runtime")
      throw new HarnessFault("INVALID_INPUT", "Use the authenticated runtime restart transport.");
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
    if (command.action === "correct" || command.action === "learn-with-model") {
      if (command.action === "learn-with-model")
        invariant(
          realModelAllowed && persona === "developer",
          "ACCESS_DENIED",
          "Starting a model-generated improvement requires the operator token.",
        );
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
      const selectedPipeline =
        command.action === "learn-with-model" ? this.modelPipeline : this.pipeline;
      const learningRun = selectedPipeline.start(principal, {
        id: feedbackId,
        workspaceId,
        target: "procurement-preferences",
        evidenceIds: [feedbackId],
      });
      if (command.action === "learn-with-model") {
        this.records.put("pending_learning", learningRun.id, { id: learningRun.id, persona });
        await this.wakeLearning();
        return { learningRunId: learningRun.id, status: "queued" };
      }
      this.workspace.events.append({
        workspaceId,
        kind: "learning.evaluating",
        audience: "customer",
        text: "Testing your correction against the existing procurement checks",
        data: { learningRunId: learningRun.id },
        lineage: [],
      });
      const completed = await this.pipeline.advance(principal, learningRun.id);
      const proposal = this.learning.read(principal, completed.proposalIds.at(-1)!);
      const evaluation = this.learning.report(principal, proposal.id)!;
      if (completed.status === "promoted") {
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
      return { proposal, evaluation, learningRun: completed };
    }
    if (command.action === "resume-learning") {
      const run = this.pipeline.read(principal, command.runId);
      invariant(
        run.workspaceId === workspaceId,
        "ACCESS_DENIED",
        "This improvement belongs to another workspace.",
      );
      if (run.generatorId === this.modelGenerator.id) {
        this.records.put("pending_learning", run.id, {
          id: run.id,
          persona: personaSchema.parse(run.principalId),
        });
        await this.wakeLearning();
        return { learningRunId: run.id, status: "queued" };
      }
      return this.pipeline.advance(principalFor(personaSchema.parse(run.principalId)), run.id);
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
      const response = await this.env.AI.run(this.env.MODEL_ID as keyof AiModels, {
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
      return { rootId: id, model: this.env.MODEL_ID, wire: result };
    }
    invariant(command.action === "model", "INVALID_INPUT", "Choose a supported command.");
    const rootId = command.requestId ?? crypto.randomUUID();
    // Customer-facing generation starts with the selected customer's authority.
    const principalId = workspaceId.startsWith("cedar") ? "cedar" : "northstar";
    const request: ModelRequest = {
      sandbox,
      workspaceId,
      principalId,
      rootId,
      message: command.message,
    };
    const previous = this.records.get<ModelRequest>("model_requests", rootId);
    invariant(
      !previous || JSON.stringify(previous) === JSON.stringify(request),
      "INVALID_INPUT",
      "This request identity already belongs to different work.",
    );
    const agent = await getAgentByName(
      this.env.MODEL_AGENTS,
      `${sandbox}:${workspaceId}:${principalId}`,
    );
    if (previous)
      return { rootId, status: (await agent.run(request)).status, modelId: this.env.MODEL_ID };
    this.budgets.start(rootId);
    this.budgets.pause(rootId);
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
      kind: "model.queued",
      audience: "customer",
      text: "Your request is queued; the agent will continue even if you close this page",
      data: { rootId, evidence: "real-model" },
      lineage: [],
    });
    const submission = await agent.run(request);
    return { rootId, status: submission.status, modelId: this.env.MODEL_ID };
  }

  async mcpCallback(persona: Persona, url: string) {
    try {
      const connectionId = new URL(url).pathname.split("/").at(-1)!;
      const principal = principalFor(persona);
      const connection = this.connections.read(principal, connectionId);
      invariant(
        connection.ownerId === principal.id,
        "ACCESS_DENIED",
        "Complete authorization with the identity that owns this connection.",
      );
      invariant(connection.state !== "revoked", "ACCESS_DENIED", "This connection was revoked.");
      this.workspace.access.require(principal, connection.spaceId, "write");
      await this.mcpTransport.completeAuthorization(new Request(url), connectionId);
      const current = await this.connections.discover(principal, connectionId);
      this.connectionEvent(connection.spaceId, connectionId, current.state);
      return { ok: true as const, workspaceId: connection.spaceId };
    } catch (error) {
      return { ok: false as const, error: asFault(error).toJSON() };
    }
  }
  private connectionEvent(workspaceId: string, connectionId: string, state: string) {
    this.workspace.events.append({
      workspaceId,
      kind: `connection.${state}`,
      audience: "customer",
      text:
        state === "ready"
          ? "The connection is ready; review which tools the agent may use"
          : state === "revoked"
            ? "Connection access has been revoked"
            : "The connection needs attention; open Connections to continue",
      data: { connectionId, state },
      lineage: [],
    });
  }
  private async verifySuppliers(input: unknown, context: Parameters<ToolDefinition["execute"]>[1]) {
    const cellId = context.operationId.slice(0, context.operationId.lastIndexOf(":"));
    const modelRoot = this.records.get<string>("model_cell_roots", cellId);
    const rootId = modelRoot ?? cellId;
    if (!modelRoot) {
      this.budgets.start(rootId);
      this.records.put("synthetic_agent_roots", cellId, { rootId });
    }
    const lineage =
      this.records.get<OperationRecord>("operations", context.operationId)?.lineage ?? [];
    this.agents.create(context.principal, {
      id: rootId,
      name: "Quoting coordinator",
      rootId,
      workspaceId: context.workspaceId,
      scopes: [{ spaceId: context.workspaceId, permissions: ["read", "write", "execute"] }],
      lineage,
    });
    const coordinator = this.agents.principal(context.principal, rootId);
    const outputs = [];
    for (const [index, offer] of (input as { offers: SupplierOffer[] }).offers.entries()) {
      const id = `${context.operationId}:supplier:${index}`;
      const handle = this.agents.create(coordinator, {
        id,
        name: `${offer.supplier} check`,
        rootId,
        workspaceId: context.workspaceId,
        scopes: [{ spaceId: context.workspaceId, permissions: ["read"] }],
        lineage,
      });
      this.agents.send(coordinator, id, { id: `${id}:request`, value: { offer }, lineage });
      const identity = this.agents.principal(coordinator, id);
      const child = await getAgentByName(this.env.SUPPLIER_AGENTS, `${this.ctx.id}:${id}`);
      const result = modelData(await child.verify(id, offer));
      this.agents.complete(identity, result, lineage);
      outputs.push({ agent: handle, result });
    }
    return outputs;
  }
  private async execute(principal: Principal, workspaceId: string, source: string, id: string) {
    try {
      const result = await this.workspace.execute(principal, workspaceId, source, { id });
      const owned = this.records.get<{ rootId: string }>("synthetic_agent_roots", id);
      if (owned && this.budgets.read(owned.rootId).status !== "completed") {
        this.agents.complete(
          this.agents.principal(principal, owned.rootId),
          { completed: true },
          result.workspace.lineage,
        );
        this.budgets.complete(owned.rootId);
      }
      return result;
    } catch (error) {
      const fault = asFault(error);
      if (["APPROVAL_REQUIRED", "RECONNECTION_REQUIRED", "EFFECT_UNCERTAIN"].includes(fault.code))
        return { cellId: id, recovery: fault.toJSON() };
      throw error;
    }
  }
  async prepareRestart(persona: Persona, workspaceId: string) {
    this.seed();
    invariant(
      persona === "developer",
      "ACCESS_DENIED",
      "A runtime restart requires developer access.",
    );
    this.workspace.access.require(principalFor(persona), workspaceId, "write");
    const stamp = { id: crypto.randomUUID(), instanceId: this.instanceId, workspaceId };
    this.records.put("metadata", "requested-restart", stamp);
    this.workspace.events.append({
      workspaceId,
      kind: "runtime.restart_requested",
      audience: "developer",
      text: "An operator requested a runtime restart; committed state is retained",
      data: { requestId: stamp.id },
      lineage: [],
    });
    await this.ctx.storage.sync();
    return stamp;
  }
  restartNow(id: string): void {
    invariant(
      this.records.get<{ id: string }>("metadata", "requested-restart")?.id === id,
      "ACCESS_DENIED",
      "No matching restart was prepared.",
    );
    this.ctx.abort("Synthetic runtime restart requested");
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

  async modelContext(rootId: string) {
    const request = this.modelRequest(rootId);
    const principal = principalFor(request.principalId as Persona);
    return {
      workspace: this.workspace.inspect(principal, request.workspaceId),
      preferences: this.learning.configuration(
        principal,
        request.workspaceId,
        "procurement-preferences",
      ),
    };
  }
  modelBinding(rootId: string, binding: string, path: (string | number)[] = []) {
    const request = this.modelRequest(rootId);
    const principal = principalFor(request.principalId as Persona);
    if (this.workspace.snapshot(principal, request.workspaceId).functions[binding])
      return {
        binding,
        kind: "helper" as const,
        helper: this.workspace.readHelper(principal, request.workspaceId, binding),
      };
    return {
      binding,
      kind: "data" as const,
      ...inspectGraph(this.workspace.readBinding(principal, request.workspaceId, binding, path)),
    };
  }
  modelOutput(rootId: string, cellId: string) {
    const request = this.modelRequest(rootId);
    const principal = principalFor(request.principalId as Persona);
    const cell = this.records.get<CellRecord>("cells", cellId);
    invariant(
      cell?.workspaceId === request.workspaceId,
      "NOT_FOUND",
      "No cell output belongs to this workspace with that identity.",
    );
    this.workspace.access.requireSources(principal, cell.lineage ?? cell.starting.lineage);
    return {
      cellId,
      status: cell.status,
      output: cell.output?.kind === "inline" ? inspectGraph(cell.output.graph) : cell.output,
    };
  }
  modelRemaining(rootId: string) {
    this.modelRequest(rootId);
    const run = this.budgets.read(rootId);
    return {
      remainingTokens: run.limits.tokens - run.usedTokens - run.reservedTokens,
      remainingActiveMs: this.budgets.remainingActiveMs(rootId),
    };
  }
  async modelPrepared(
    rootId: string,
    instructions: string,
    toolSchemas: unknown,
    outputReserve: number,
  ) {
    const request = this.modelRequest(rootId);
    return new ContextManager(this.records).prepare(
      principalFor(request.principalId as Persona),
      request.workspaceId,
      this.env.MODEL_ID,
      {
        contextWindow: 24_000,
        outputReserve,
        instructions,
        toolSchemas,
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
  async modelActivate(rootId: string) {
    const request = this.modelRequest(rootId);
    this.budgets.resume(rootId);
    this.workspace.events.append({
      workspaceId: request.workspaceId,
      kind: "model.started",
      audience: "customer",
      text: "The agent is working on your request",
      data: { rootId, evidence: "real-model" },
      lineage: [],
    });
    const run = this.budgets.read(rootId);
    const remainingMs = run.limits.activeMs - run.activeMs;
    invariant(
      remainingMs > 0,
      "BUDGET_EXCEEDED",
      "This run has used its active execution budget. Its progress is retained.",
    );
    const deadline = Date.now() + remainingMs;
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || currentAlarm > deadline) await this.ctx.storage.setAlarm(deadline);
    return { remainingMs };
  }
  private async wakeLearning() {
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > Date.now()) await this.ctx.storage.setAlarm(Date.now());
  }
  private learningTransition(run: LearningRun) {
    const text: Record<LearningRun["status"], string> = {
      ready: "Your correction is queued for an improvement proposal",
      generating: "The agent is considering your correction",
      evaluating: "Checking the proposed change against the existing evaluation cases",
      awaiting_review: "The proposed change passed its checks and needs review",
      promoted: "The improvement passed its checks and is active",
      exhausted: "No verified improvement was found within the attempt limit",
      interrupted: "The improvement paused; its progress is saved",
      stale: "The settings changed during this improvement; it needs to be checked again",
    };
    this.workspace.events.append({
      workspaceId: run.workspaceId,
      kind: `learning.${run.status}`,
      audience: "customer",
      text: text[run.status],
      data: { learningRunId: run.id, attempt: run.attempts, evidence: "real-model" },
      lineage: run.lineage,
    });
  }
  private async driveLearning(job: { id: string; persona: Persona }) {
    this.activeLearning.add(job.id);
    try {
      await this.modelPipeline.advance(principalFor(job.persona), job.id);
    } catch {
      /* The pipeline retains a recoverable, authorized failure state. */
    } finally {
      this.records.delete("pending_learning", job.id);
      this.activeLearning.delete(job.id);
    }
  }
  async alarm() {
    let nextDeadline = Infinity;
    for (const run of this.records.list<RootRun>("root_runs")) {
      if (run.status !== "active" || run.activeSince === null) continue;
      const request = this.records.get<ModelRequest>("model_requests", run.id);
      if (!request || this.records.get("model_terminals", run.id)) continue;
      const deadline = run.activeSince + run.limits.activeMs - run.activeMs;
      if (deadline > Date.now()) {
        nextDeadline = Math.min(nextDeadline, deadline);
        continue;
      }
      const agent = await getAgentByName(
        this.env.MODEL_AGENTS,
        `${request.sandbox}:${request.workspaceId}:${request.principalId}`,
      );
      await agent.cancelSubmission(run.id, "The root run reached its active execution budget.");
      this.modelEvent(
        run.id,
        "failed",
        "The root run reached its active execution budget; unsettled usage remains reserved.",
      );
    }
    for (const job of this.records.list<{ id: string; persona: Persona }>("pending_learning")) {
      if (!this.activeLearning.has(job.id)) this.ctx.waitUntil(this.driveLearning(job));
      nextDeadline = Math.min(nextDeadline, Date.now() + 120_000);
    }
    if (Number.isFinite(nextDeadline)) await this.ctx.storage.setAlarm(nextDeadline);
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
      modelId?: string;
      usage?: {
        inputTokens: number | null;
        outputTokens: number | null;
        totalTokens: number | null;
      };
    },
  ): void {
    this.modelRequest(rootId);
    this.records.put("model_steps", stepId, { rootId, stepId, ...evidence });
  }
  async modelCell(rootId: string, source: string, cellId: string) {
    const request = this.modelRequest(rootId);
    this.records.put("model_cell_roots", cellId, rootId);
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
          ...(result.cell.output
            ? {
                output:
                  result.cell.output.kind === "inline"
                    ? inspectGraph(result.cell.output.graph)
                    : result.cell.output,
              }
            : {}),
          bindings: Object.keys(result.workspace.graph.roots),
          helpers: Object.values(result.workspace.functions).map(({ name, version }) => ({
            name,
            version,
          })),
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
    const lastStep = this.records
      .list<{ rootId: string; finishReason: string }>("model_steps")
      .filter((step) => step.rootId === rootId)
      .at(-1);
    if (kind === "completed" && lastStep && lastStep.finishReason !== "stop") kind = "interrupted";
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
