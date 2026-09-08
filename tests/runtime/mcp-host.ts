import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { MCPClientManager } from "agents/mcp/client";
import { Connections, type KnowledgeSpace } from "@durable-harness/core";
import {
  CloudflareMcpTransport,
  EncryptedCredentialVault,
  EncryptedSecrets,
  cloudflareOAuthProvider,
  durableStore,
  modelData,
} from "@durable-harness/cloudflare";
import { developer } from "./worker.js";

export class McpTestHost extends DurableObject<{ CREDENTIAL_KEY: string }> {
  private readonly store = durableStore(this.ctx);
  private readonly secrets = new EncryptedSecrets(this.store, this.env.CREDENTIAL_KEY);
  private provider = (callback: string) =>
    cloudflareOAuthProvider(this.secrets, String(this.ctx.id.name), callback);
  private readonly manager = new MCPClientManager("durable-harness-tests", "0.1.0", {
    createAuthProvider: (callback) => this.provider(callback),
  });
  private readonly lifecycle = new Lifecycle(this).use(this.manager);
  private readonly transport = new CloudflareMcpTransport(this.manager, {
    start: () => this.lifecycle.start(),
    callbackUrl: (id) => `https://fixture.example.test/api/mcp/callback/${id}`,
    authProvider: (callback) => this.provider(callback),
  });
  private readonly connections = new Connections(
    this.store,
    new EncryptedCredentialVault(this.secrets),
    this.transport,
  );
  async connectServer(auth: "oauth" | "none" = "none") {
    const space: KnowledgeSpace = {
      id: "test",
      deploymentId: "test",
      kind: "tenant",
      label: "MCP fixture",
      revision: 1,
      grants: [{ principalId: developer.id, permissions: ["read", "write", "execute", "publish"] }],
    };
    this.store.put("spaces", "test", space);
    const connection = await this.connections.add(developer, {
      spaceId: "test",
      name: "Supplier catalog",
      url: "https://fixture.example.test/mcp",
      auth,
    });
    if (connection.state === "ready")
      this.connections.allowTools(developer, connection.id, ["lookup"], connection.fingerprint);
    this.store.put("metadata", "connection", connection.id);
    return modelData(this.connections.read(developer, connection.id));
  }
  async call() {
    const id = this.store.get<string>("metadata", "connection")!;
    const connection = this.connections.read(developer, id);
    return modelData(
      await this.connections.call(developer, id, "lookup", { part: "A-1" }, connection.fingerprint),
    );
  }
  async close() {
    await this.manager.closeAllConnections();
  }
  async tryCall() {
    try {
      return { ok: true, value: await this.call() };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  async authorize(url: string) {
    const id = this.store.get<string>("metadata", "connection")!;
    await this.transport.completeAuthorization(new Request(url), id);
    const connection = await this.connections.discover(developer, id);
    this.connections.allowTools(developer, id, ["lookup"], connection.fingerprint);
    return modelData(connection);
  }
  credentialScan() {
    return JSON.stringify(this.store.list("protected_credentials"));
  }
}
