import { contentHash } from "./compiler.js";
import { HarnessFault, invariant } from "./errors.js";
import { AccessPolicy } from "./policy.js";
import type { Principal, RecordStore } from "./types.js";

export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface McpCredentials { accessToken: string; refreshToken?: string; expiresAt?: number }
export interface CredentialVault { get(id: string): Promise<McpCredentials | undefined>; put(id: string, value: McpCredentials): Promise<void>; delete(id: string): Promise<void> }
export interface McpConnection {
  id: string;
  spaceId: string;
  ownerId: string;
  name: string;
  url: string;
  auth: "oauth" | "bearer" | "none";
  state: "connecting" | "authorization_required" | "ready" | "refreshing" | "reconnection_required" | "unreachable" | "revoked" | "schema_changed";
  backgroundAccess: "supported" | "until_expiry" | "unknown";
  allowedTools: string[];
  tools: McpTool[];
  fingerprint: string;
  revision: number;
  authorizationUrl?: string;
  lastError?: string;
}
export interface McpTransport {
  connect(connection: McpConnection, credentials?: McpCredentials): Promise<{ tools?: McpTool[]; authorizationUrl?: string }>;
  call(connection: McpConnection, tool: string, input: unknown, credentials?: McpCredentials): Promise<unknown>;
  refresh?(connection: McpConnection, credentials: McpCredentials): Promise<McpCredentials>;
}

export function validateMcpUrl(url: string, allowLocalHttp = false): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new HarnessFault("INVALID_INPUT", "Enter a complete HTTPS MCP server URL."); }
  invariant(!parsed.username && !parsed.password && !parsed.hash, "INVALID_INPUT", "Credentials and fragments are not allowed in MCP URLs.");
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || host === "0.0.0.0" || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /^(fc|fd|fe80):/.test(host);
  invariant((parsed.protocol === "https:" && !local) || (allowLocalHttp && local && parsed.protocol === "http:"), "INVALID_INPUT", "Use a public HTTPS MCP endpoint. Local HTTP is restricted to the test adapter.");
  return parsed;
}

/** Owns connection identity and readiness; transport and encrypted credential storage are adapters. */
export class Connections {
  private readonly policy: AccessPolicy;
  private readonly refreshes = new Map<string, Promise<McpCredentials>>();
  constructor(private readonly store: RecordStore, private readonly vault: CredentialVault, private readonly transport: McpTransport, private readonly allowLocalHttp = false) { this.policy = new AccessPolicy(store); }

  async add(principal: Principal, input: { spaceId: string; name: string; url: string; auth: McpConnection["auth"] }, credentials?: McpCredentials): Promise<McpConnection> {
    this.policy.require(principal, input.spaceId, "write");
    validateMcpUrl(input.url, this.allowLocalHttp);
    const connection: McpConnection = { ...input, id: crypto.randomUUID(), ownerId: principal.id, state: "connecting", backgroundAccess: credentials?.refreshToken || input.auth === "bearer" || input.auth === "none" ? "supported" : "unknown", allowedTools: [], tools: [], fingerprint: "", revision: 1 };
    this.store.put("connections", connection.id, connection);
    if (credentials) await this.vault.put(connection.id, credentials);
    return this.discover(principal, connection.id);
  }
  read(principal: Principal, id: string): McpConnection {
    const connection = this.store.get<McpConnection>("connections", id);
    invariant(connection && this.policy.permits(principal, connection.spaceId, "read"), "NOT_FOUND", "No accessible connection exists with that reference.");
    return connection;
  }
  list(principal: Principal, spaceId: string): McpConnection[] {
    this.policy.require(principal, spaceId, "read");
    return this.store.list<McpConnection>("connections").filter(connection => connection.spaceId === spaceId);
  }
  async discover(principal: Principal, id: string): Promise<McpConnection> {
    const connection = this.read(principal, id);
    this.policy.require(principal, connection.spaceId, "write");
    invariant(connection.state !== "revoked", "RECONNECTION_REQUIRED", "This connection was revoked. Create a new authorization explicitly.");
    try {
      const result = await this.transport.connect(connection, await this.vault.get(id));
      this.checkCurrent(principal, connection, "write");
      if (result.authorizationUrl) return this.save({ ...connection, state: "authorization_required", authorizationUrl: result.authorizationUrl });
      const tools = result.tools ?? [];
      const fingerprint = await contentHash(JSON.stringify(tools.map(tool => [tool.name, tool.inputSchema]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))));
      this.checkCurrent(principal, connection, "write");
      const changed = !!connection.fingerprint && connection.fingerprint !== fingerprint;
      return this.save({ ...connection, tools, fingerprint, state: changed ? "schema_changed" : "ready", revision: connection.revision + Number(changed), ...(changed ? { allowedTools: [] } : {}) });
    } catch (error) {
      this.checkCurrent(principal, connection, "write");
      return this.save({ ...connection, state: "unreachable", lastError: "The MCP server could not be reached. Check its endpoint and authorization." });
    }
  }
  allowTools(principal: Principal, id: string, names: string[], expectedFingerprint: string): McpConnection {
    const connection = this.read(principal,id);
    invariant(connection.ownerId === principal.id || principal.roles.includes("developer"), "ACCESS_DENIED", "Only the connection owner or an authorized developer can grant tool access.");
    this.policy.require(principal, connection.spaceId, "write");
    invariant(connection.state === "ready" || connection.state === "schema_changed", "RECONNECTION_REQUIRED", "Reconnect and discover this server before granting tool access.");
    invariant(connection.fingerprint === expectedFingerprint, "STALE_REVISION", "The tool catalog changed. Review the current tools first.");
    invariant(names.every(name => connection.tools.some(tool => tool.name === name)), "INVALID_INPUT", "Grant access only to discovered tools.");
    return this.save({ ...connection, allowedTools: [...names], state: "ready", revision: connection.revision + 1 });
  }
  async completeAuthorization(principal: Principal, id: string, credentials: McpCredentials): Promise<McpConnection> {
    const connection = this.read(principal,id);
    invariant(connection.ownerId === principal.id, "ACCESS_DENIED", "The connection owner must complete authorization.");
    this.policy.require(principal,connection.spaceId,"write");
    invariant(connection.state !== "revoked", "RECONNECTION_REQUIRED", "Create a new connection after revocation.");
    await this.vault.put(id,credentials);
    try { this.checkCurrent(principal, connection, "write"); }
    catch (error) { await this.vault.delete(id); throw error; }
    this.save({ ...connection, state: "connecting", backgroundAccess: credentials.refreshToken ? "supported" : "until_expiry" });
    return this.discover(principal,id);
  }
  async call(principal: Principal, id: string, tool: string, input: unknown, expectedFingerprint: string): Promise<unknown> {
    let connection = this.read(principal,id);
    this.policy.require(principal,connection.spaceId,"execute");
    invariant(connection.state === "ready" || connection.state === "refreshing", "RECONNECTION_REQUIRED", "This connection needs attention before the agent can use it.");
    invariant(connection.fingerprint === expectedFingerprint, "STALE_REVISION", "The MCP tool schema changed. Review the action against the current catalog.");
    invariant(connection.allowedTools.includes(tool), "ACCESS_DENIED", "This MCP tool has not been granted to the workspace.");
    let credentials = await this.vault.get(id);
    if (connection.auth !== "none" && !credentials) {
      this.save({ ...connection, state: "reconnection_required" });
      throw new HarnessFault("RECONNECTION_REQUIRED", "The connection has no usable authorization. Reconnect it to resume.");
    }
    if (credentials?.expiresAt !== undefined && credentials.expiresAt <= Date.now() + 10_000) {
      if (!credentials.refreshToken || !this.transport.refresh) {
        this.save({ ...connection, state: "reconnection_required", backgroundAccess: "until_expiry" });
        throw new HarnessFault("RECONNECTION_REQUIRED", "The connection expired. Reconnect it to resume this work.");
      }
      let refresh = this.refreshes.get(id);
      if (!refresh) {
        this.save({ ...connection, state: "refreshing" });
        const previous = credentials;
        refresh = (async () => {
          try {
            const next = await this.transport.refresh!(connection,previous);
            const current = this.read(principal,id);
            invariant(current.state !== "revoked", "RECONNECTION_REQUIRED", "Connection access was revoked during refresh.");
            await this.vault.put(id,{ ...next, ...(next.refreshToken ? {} : { refreshToken: previous.refreshToken! }) });
            if (this.store.get<McpConnection>("connections",id)?.state === "revoked") {
              await this.vault.delete(id);
              throw new HarnessFault("RECONNECTION_REQUIRED", "Connection access was revoked during credential storage.");
            }
            this.save({ ...current, state: "ready", backgroundAccess: next.refreshToken ? "supported" : "until_expiry" });
            return next;
          } catch (error) {
            const current = this.store.get<McpConnection>("connections",id)!;
            if (current.state !== "revoked") this.save({ ...current, state: "reconnection_required", lastError: "Authorization could not be renewed. Reconnect this account." });
            throw new HarnessFault("RECONNECTION_REQUIRED", "Authorization could not be renewed. Reconnect this account.");
          } finally { this.refreshes.delete(id); }
        })();
        this.refreshes.set(id,refresh);
      }
      credentials = await refresh;
    }
    connection = this.read(principal,id);
    invariant(connection.state === "ready", "RECONNECTION_REQUIRED", "The connection is no longer ready.");
    this.policy.require(principal,connection.spaceId,"execute");
    invariant(connection.fingerprint === expectedFingerprint && connection.allowedTools.includes(tool), "ACCESS_DENIED", "Connection grants changed while preparing this operation.");
    const result = await this.transport.call(connection,tool,input,credentials);
    this.checkCurrent(principal, connection, "execute");
    return result;
  }
  async revoke(principal: Principal,id: string): Promise<void> {
    const connection = this.read(principal,id);
    invariant(connection.ownerId === principal.id || principal.roles.includes("developer"), "ACCESS_DENIED", "Only the owner or an authorized developer can revoke this connection.");
    this.policy.require(principal,connection.spaceId,"write");
    this.save({ ...connection, state:"revoked", allowedTools:[] });
    await this.vault.delete(id);
  }
  private save(connection: McpConnection): McpConnection { this.store.put("connections",connection.id,connection); return connection; }
  private checkCurrent(principal: Principal, expected: McpConnection, permission: "write" | "execute"): void {
    const current = this.read(principal, expected.id);
    this.policy.require(principal, current.spaceId, permission);
    invariant(current.state !== "revoked", "ACCESS_DENIED", "This connection was revoked.");
    invariant(current.revision === expected.revision, "STALE_REVISION", "Connection settings changed during this request. Read the current connection before continuing.");
  }
}
