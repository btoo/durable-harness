import { MCPClientManager } from "agents/mcp/client";
import { DurableObjectOAuthClientProvider } from "agents/mcp/do-oauth-client-provider";
import {
  HarnessFault,
  fingerprintMcpTools,
  invariant,
  validateMcpUrl,
  type McpConnection,
  type McpCredentials,
  type McpTool,
  type McpTransport,
} from "@durable-harness/core";
import { encryptedOAuthStorage, type EncryptedSecrets } from "./vault.js";

export function cloudflareOAuthProvider(
  secrets: EncryptedSecrets,
  clientName: string,
  callbackUrl: string,
) {
  return new DurableObjectOAuthClientProvider(
    encryptedOAuthStorage(secrets),
    clientName,
    callbackUrl,
  );
}

/** The host installs the manager with Lifecycle; every imported call still uses the core journal. */
export class CloudflareMcpTransport implements McpTransport {
  readonly managesAuthorization = true;
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly manager: MCPClientManager,
    private readonly options: {
      start(): Promise<void>;
      callbackUrl(id: string): string;
      authProvider(callbackUrl: string): DurableObjectOAuthClientProvider;
    },
  ) {}

  async connect(connection: McpConnection, credentials?: McpCredentials) {
    return this.serial(connection.id, async () => {
      validateMcpUrl(connection.url);
      await this.options.start();
      if (!this.manager.listServers().some((server) => server.id === connection.id)) {
        const callbackUrl = this.options.callbackUrl(connection.id);
        const provider = this.options.authProvider(callbackUrl);
        provider.serverId = connection.id;
        if (credentials) {
          provider.clientId = "configured-token";
          await provider.saveTokens({
            access_token: credentials.accessToken,
            token_type: "Bearer",
            ...(credentials.refreshToken ? { refresh_token: credentials.refreshToken } : {}),
          });
        }
        await this.manager.registerServer(connection.id, {
          url: connection.url,
          name: connection.name,
          callbackUrl,
          transport: { type: "streamable-http", authProvider: provider },
          ...(credentials ? { clientId: "configured-token" } : {}),
        });
      }
      let state = this.manager.mcpConnections[connection.id]?.connectionState;
      if (state !== "ready" && state !== "connected") {
        const result = await this.manager.connectToServer(connection.id);
        if (result.state === "authenticating") return { authorizationUrl: result.authUrl };
        invariant(
          result.state !== "failed",
          "RECONNECTION_REQUIRED",
          "The MCP server could not establish an authorized session.",
        );
        state = result.state;
      }
      const discovered = await this.manager.discoverIfConnected(connection.id, {
        timeoutMs: 15_000,
      });
      if (!discovered?.success && discovered?.state === "authenticating") {
        const reauthorization = await this.manager.connectToServer(connection.id);
        if (reauthorization.state === "authenticating")
          return { authorizationUrl: reauthorization.authUrl };
      }
      invariant(
        discovered?.success,
        "RECONNECTION_REQUIRED",
        "The MCP tool catalog is unavailable. Reconnect or retry discovery.",
      );
      const provider = this.manager.mcpConnections[connection.id]?.options.transport.authProvider;
      const tokens = await provider?.tokens();
      return {
        tools: this.catalog(connection.id),
        backgroundAccess:
          connection.auth === "none" ||
          tokens?.refresh_token ||
          (connection.auth === "bearer" && credentials?.expiresAt === undefined)
            ? ("supported" as const)
            : ("until_expiry" as const),
        scopes: tokens?.scope?.split(/\s+/).filter(Boolean) ?? [],
      };
    });
  }
  async call(connection: McpConnection, name: string, input: unknown) {
    return this.serial(connection.id, async () => {
      await this.options.start();
      await this.manager.waitForConnections({ timeout: 15_000 });
      invariant(
        this.manager.mcpConnections[connection.id]?.connectionState === "ready",
        "RECONNECTION_REQUIRED",
        "Reconnect this MCP server to resume its work.",
      );
      const tools = this.catalog(connection.id);
      const fingerprint = await fingerprintMcpTools(tools);
      invariant(
        fingerprint === connection.fingerprint,
        "STALE_REVISION",
        "The MCP catalog changed before dispatch. Review the current capabilities.",
      );
      const result = await this.manager.callTool(
        { serverId: connection.id, name, arguments: input as Record<string, unknown> },
        { timeout: 30_000 },
      );
      if (result.isError)
        throw new HarnessFault(
          "INVALID_TOOL_RESULT",
          "The MCP server reported that this tool failed. Inspect its authorized diagnostics before retrying.",
        );
      return result;
    });
  }
  async prepare(connection: McpConnection): Promise<void> {
    await this.serial(connection.id, async () => {
      await this.options.start();
      await this.manager.waitForConnections({ timeout: 15_000 });
      const result = await this.manager.discoverIfConnected(connection.id, { timeoutMs: 15_000 });
      invariant(
        result?.success,
        "RECONNECTION_REQUIRED",
        "The MCP connection needs authorization or a refreshed catalog.",
      );
      invariant(
        (await fingerprintMcpTools(this.catalog(connection.id))) === connection.fingerprint,
        "STALE_REVISION",
        "The remote MCP schema changed; review the current tools before resuming.",
      );
    });
  }
  async disconnect(connection: McpConnection) {
    await this.serial(connection.id, async () => {
      await this.options.start();
      await this.manager.removeServer(connection.id);
    });
  }
  async completeAuthorization(request: Request, connectionId: string) {
    return this.serial(connectionId, async () => {
      await this.options.start();
      invariant(
        this.manager.isCallbackRequest(request),
        "ACCESS_DENIED",
        "This is not a registered OAuth callback.",
      );
      const result = await this.manager.handleCallbackRequest(request);
      invariant(
        result.authSuccess && result.serverId === connectionId,
        "RECONNECTION_REQUIRED",
        "Authorization was not completed for this connection.",
      );
      await this.manager.waitForConnections({ timeout: 15_000 });
      return { authorized: true };
    });
  }
  private catalog(id: string): McpTool[] {
    return this.manager.listTools({ serverId: id }).map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    }));
  }
  private async serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
}
