import { DurableObject } from "cloudflare:workers";
import { DurableWorkspace, asFault, decodeGraph, type KnowledgeSpace, type Principal, type ToolDefinition } from "@durable-harness/core";
import { CloudflareCellExecutor, durableStore } from "@durable-harness/cloudflare";

export const developer: Principal = { id: "developer", deploymentId: "test", roles: ["developer"] };
export const customer: Principal = { id: "customer", deploymentId: "test", roles: ["customer"] };

export class WorkspaceTestHost extends DurableObject<{ LOADER: WorkerLoader }> {
  private readonly store = durableStore(this.ctx);
  private readonly workspace: DurableWorkspace;
  constructor(ctx: DurableObjectState, env: { LOADER: WorkerLoader }) {
    super(ctx, env);
    const space: KnowledgeSpace = { id: "test", deploymentId: "test", kind: "tenant", label: "Test", revision: 1, grants: [{ principalId: developer.id, permissions: ["read", "write", "publish", "execute"] }, { principalId: customer.id, permissions: ["read", "write", "execute"] }] };
    if (!this.store.get("spaces", "test")) this.store.put("spaces", "test", space);
    const tools: ToolDefinition[] = [
      { name: "offers", version: "1", description: "Read supplier offers", spaceId: "test", inputSchema: { type: "object" }, effect: "read", publicActivity: "Reading supplier offers", execute: async () => {
        this.store.put("counts", "offers", (this.store.get<number>("counts", "offers") ?? 0) + 1);
        return [{ supplier: "A", price: 120 }, { supplier: "B", price: 95 }];
      } },
      { name: "send", version: "1", description: "Send a simulated email", spaceId: "test", inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] }, effect: "external", requiresApproval: true, publicActivity: "Sending the approved message", execute: async input => {
        this.store.put("counts", "sends", (this.store.get<number>("counts", "sends") ?? 0) + 1);
        return { delivery: "simulated", to: (input as { to: string }).to };
      } },
    ];
    this.workspace = new DurableWorkspace(this.store, new CloudflareCellExecutor(env.LOADER), { tools });
  }
  async run(source: string, id = crypto.randomUUID(), identity = developer) {
    try { const result = await this.workspace.execute(identity, "test", source, { id }); return { ok: true as const, ...result, values: decodeGraph(result.workspace.graph) }; }
    catch (error) { return { ok: false as const, error: asFault(error).toJSON() }; }
  }
  inspect() { return this.workspace.inspect(developer, "test"); }
  actions(id: string) { return this.workspace.operations(developer, "test", id); }
  approve(id: string) { return this.workspace.approve(customer, "test", id); }
  counts() { return { offers: this.store.get<number>("counts", "offers") ?? 0, sends: this.store.get<number>("counts", "sends") ?? 0 }; }
  events(identity = developer, after = 0) { return this.workspace.events.read(identity, "test", after); }
  revoke() { this.workspace.access.setGrants(developer, "test", [{ principalId: developer.id, permissions: ["read", "write", "publish", "execute"] }], 1); }
}
export default { fetch() { return new Response("Test worker"); } };
