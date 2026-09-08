import { DurableObject } from "cloudflare:workers";
import {
  Artifacts,
  Capabilities,
  DurableWorkspace,
  HarnessFault,
  asFault,
  decodeGraph,
  type KnowledgeSpace,
  type Principal,
  type ToolDefinition,
} from "@durable-harness/core";
import {
  CloudflareCellExecutor,
  PureCapabilityExecutor,
  R2Artifacts,
  durableStore,
  modelData,
} from "@durable-harness/cloudflare";
import demoWorker from "../../apps/demo/worker/index.js";
import type { DemoEnv } from "../../apps/demo/worker/protocol.js";
export { HarnessThink, SupplierAgent } from "../../apps/demo/worker/index.js";
export { TestHarnessThink } from "./model.js";
export { TestDemoApplication } from "./test-application.js";
export { McpTestHost } from "./mcp-host.js";

export const developer: Principal = { id: "developer", deploymentId: "test", roles: ["developer"] };
export const customer: Principal = { id: "customer", deploymentId: "test", roles: ["customer"] };

export class WorkspaceTestHost extends DurableObject<{
  LOADER: WorkerLoader;
  ARTIFACTS: R2Bucket;
}> {
  private readonly store = durableStore(this.ctx);
  private readonly workspace: DurableWorkspace;
  private readonly capabilities = new Capabilities(
    this.store,
    new PureCapabilityExecutor(this.env.LOADER),
    [
      {
        id: "double-v1",
        description: "Double a number",
        inputSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        arguments: (input) => [(input as { value: number }).value],
        cases: [
          { id: "positive", input: { value: 2 }, expected: 4 },
          { id: "negative", input: { value: -3 }, expected: -6 },
        ],
        assess: (actual, expected) => actual === expected,
      },
    ],
  );
  constructor(ctx: DurableObjectState, env: { LOADER: WorkerLoader; ARTIFACTS: R2Bucket }) {
    super(ctx, env);
    const space: KnowledgeSpace = {
      id: "test",
      deploymentId: "test",
      kind: "tenant",
      label: "Test",
      revision: 1,
      grants: [
        { principalId: developer.id, permissions: ["read", "write", "publish", "execute"] },
        { principalId: customer.id, permissions: ["read", "write", "execute"] },
      ],
    };
    if (!this.store.get("spaces", "test")) this.store.put("spaces", "test", space);
    if (!this.store.get("spaces", "operator-private"))
      this.store.put("spaces", "operator-private", {
        ...space,
        id: "operator-private",
        grants: [
          { principalId: developer.id, permissions: ["read", "write", "execute", "publish"] },
        ],
      });
    if (!this.store.get("spaces", "library"))
      this.store.put("spaces", "library", {
        ...space,
        id: "library",
        kind: "library",
        grants: [
          { principalId: developer.id, permissions: ["read", "write", "execute", "publish"] },
          { principalId: "other-customer", permissions: ["read", "execute"] },
        ],
      });
    const tools: ToolDefinition[] = [
      {
        name: "crash-after-send",
        version: "1",
        spaceId: "test",
        description: "Inject a runtime loss after a synthetic effect",
        inputSchema: { type: "object" },
        effect: "external",
        publicActivity: "Sending a synthetic message",
        execute: async (_input, context) => {
          this.store.put("counts", "sends", (this.store.get<number>("counts", "sends") ?? 0) + 1);
          this.store.put("crash_receipts", context.operationId, { delivered: true });
          await this.ctx.storage.sync();
          this.ctx.abort("Injected crash after durable effect receipt");
        },
        reconcile: async (id) => {
          const result = this.store.get("crash_receipts", id);
          return { found: !!result, result };
        },
      },

      {
        name: "connection.send",
        version: "1",
        description: "Send after authorization",
        spaceId: "test",
        inputSchema: { type: "object" },
        effect: "external",
        publicActivity: "Sending through the connected account",
        prepare: async () => {
          if (!this.store.get("connection", "ready"))
            throw new HarnessFault("RECONNECTION_REQUIRED", "Reconnect this account.");
        },
        execute: async () => {
          this.store.put("counts", "sends", (this.store.get<number>("counts", "sends") ?? 0) + 1);
          return { sent: true };
        },
      },
      {
        name: "connection.lost-result",
        version: "1",
        description: "Lose authorization after an effect",
        spaceId: "test",
        inputSchema: { type: "object" },
        effect: "external",
        publicActivity: "Sending a synthetic message",
        execute: async () => {
          this.store.put("counts", "sends", (this.store.get<number>("counts", "sends") ?? 0) + 1);
          throw new HarnessFault("RECONNECTION_REQUIRED", "Authorization was lost after dispatch.");
        },
      },
      {
        name: "private.lookup",
        version: "1",
        description: "Read operator-only evidence",
        spaceId: "operator-private",
        inputSchema: { type: "object" },
        effect: "read",
        publicActivity: "Reading restricted evidence",
        execute: async () => ({ recipient: "restricted@example.test" }),
      },
      {
        name: "offers",
        version: this.store.get<string>("versions", "offers") ?? "1",
        description: "Read supplier offers",
        spaceId: "test",
        inputSchema: { type: "object" },
        effect: "read",
        publicActivity: "Reading supplier offers",
        execute: async () => {
          this.store.put("counts", "offers", (this.store.get<number>("counts", "offers") ?? 0) + 1);
          return [
            { supplier: "A", price: 120 },
            { supplier: "B", price: 95 },
          ];
        },
      },
      {
        name: "send",
        version: "1",
        description: "Send a simulated email",
        spaceId: "test",
        inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
        effect: "external",
        requiresApproval: true,
        publicActivity: "Sending the approved message",
        execute: async (input) => {
          this.store.put("counts", "sends", (this.store.get<number>("counts", "sends") ?? 0) + 1);
          return { delivery: "simulated", to: (input as { to: string }).to };
        },
      },
      {
        name: "uncertain",
        version: "1",
        description: "Simulate a lost response after delivery",
        spaceId: "test",
        inputSchema: { type: "object" },
        effect: "external",
        publicActivity: "Sending a synthetic message",
        execute: async () => {
          this.store.put("counts", "sends", (this.store.get<number>("counts", "sends") ?? 0) + 1);
          throw new Error("The response was lost after the synthetic provider accepted the write.");
        },
        reconcile: async () =>
          this.store.get("provider", "reconciled")
            ? { found: true, result: { delivery: "verified" } }
            : { found: false },
      },
    ];
    this.workspace = new DurableWorkspace(this.store, new CloudflareCellExecutor(env.LOADER), {
      tools: () => [...tools, ...this.capabilities.definitions()],
      artifacts: new Artifacts(this.store, new R2Artifacts(env.ARTIFACTS)),
    });
  }
  async run(source: string, id = crypto.randomUUID(), identity = developer) {
    try {
      const result = await this.workspace.execute(identity, "test", source, { id });
      return { ok: true as const, ...result, values: decodeGraph(result.workspace.graph) };
    } catch (error) {
      return { ok: false as const, error: asFault(error).toJSON() };
    }
  }
  inspect() {
    return this.workspace.inspect(developer, "test");
  }
  actions(id: string) {
    return this.workspace.operations(developer, "test", id);
  }
  approve(id: string) {
    return this.workspace.approve(customer, "test", id);
  }
  counts() {
    return {
      offers: this.store.get<number>("counts", "offers") ?? 0,
      sends: this.store.get<number>("counts", "sends") ?? 0,
    };
  }
  events(identity = developer, after = 0) {
    return this.workspace.events.read(identity, "test", after);
  }
  revoke() {
    this.workspace.access.setGrants(
      developer,
      "test",
      [{ principalId: developer.id, permissions: ["read", "write", "publish", "execute"] }],
      1,
    );
  }
  reconcile() {
    this.store.put("provider", "reconciled", true);
  }
  changeToolVersion() {
    this.store.put("versions", "offers", "2");
  }
  revokePrivate() {
    this.workspace.access.setGrants(developer, "operator-private", [], 1);
  }
  async capability(action: string, id?: string) {
    try {
      const outsider: Principal = {
        id: "other-customer",
        deploymentId: "test",
        roles: ["customer"],
      };
      if (action === "propose")
        return {
          ok: true,
          value: modelData(
            await this.capabilities.propose(developer, {
              spaceId: "test",
              helperName: id ?? "double",
              name: "double",
              protocolId: "double-v1",
            }),
          ),
        };
      if (action === "evaluate")
        return { ok: true, value: modelData(await this.capabilities.evaluate(developer, id!)) };
      if (action === "approve")
        return { ok: true, value: modelData(await this.capabilities.approve(developer, id!)) };
      if (action === "customer-approve")
        return { ok: true, value: modelData(await this.capabilities.approve(customer, id!)) };
      if (action === "publish")
        return {
          ok: true,
          value: modelData(this.capabilities.publish(developer, id!, "library", 0)),
        };
      if (action === "other-read")
        return { ok: true, value: modelData(this.capabilities.read(outsider, id!)) };
      throw new Error("Unknown capability fixture action");
    } catch (error) {
      return { ok: false, error: asFault(error).toJSON() };
    }
  }
  authorizeConnection() {
    this.store.put("connection", "ready", true);
  }
}
export default {
  fetch(request: Request, env: DemoEnv) {
    return new URL(request.url).pathname.startsWith("/api/")
      ? demoWorker.fetch(request, env)
      : new Response("Test worker");
  },
};

export { SyntheticCatalog } from "../../apps/mcp-fixture/worker.js";

export { BenchmarkRun } from "../../apps/benchmarks/worker.js";
