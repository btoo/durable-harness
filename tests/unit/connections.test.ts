import { describe, expect, it } from "vitest";
import { Connections, validateMcpUrl, type CredentialVault, type McpCredentials, type McpTransport } from "@durable-harness/core";
import { EncryptedCredentialVault, EncryptedSecrets } from "../../packages/cloudflare/src/vault.js";
import { buyerA, buyerB, database, dev } from "./store.js";

function fixture(transport: McpTransport) {
  const { store } = database();
  const vault: CredentialVault = new EncryptedCredentialVault(new EncryptedSecrets(store, btoa("a".repeat(32))));
  return { store, vault, connections: new Connections(store, vault, transport) };
}
const catalog = [{ name: "lookup", description: "Look up a synthetic part", inputSchema: { type: "object" } }];
const input = { spaceId: "a", name: "Parts", url: "https://mcp.example.test", auth: "oauth" as const };

describe("remote connection authorization", () => {
  it("renews once for concurrent unattended calls and restores encrypted credentials", async () => {
    let refreshes = 0;
    const used: (McpCredentials | undefined)[] = [];
    const transport: McpTransport = {
      connect: async () => ({ tools: catalog }),
      refresh: async () => { refreshes++; await new Promise(resolve => setTimeout(resolve, 5)); return { accessToken: "next-access", refreshToken: "next-refresh", expiresAt: Date.now() + 60_000 }; },
      call: async (_connection, _tool, _input, credentials) => { used.push(credentials); return { part: "ABC" }; },
    };
    const { store, vault, connections } = fixture(transport);
    const created = await connections.add(buyerA, input, { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 0 });
    connections.allowTools(buyerA, created.id, ["lookup"], created.fingerprint);
    await Promise.all([1, 2].map(() => connections.call(buyerA, created.id, "lookup", {}, created.fingerprint)));
    expect(refreshes).toBe(1);
    expect(used.map(value => value?.accessToken)).toEqual(["next-access", "next-access"]);
    expect(JSON.stringify(store.list("protected_credentials"))).not.toContain("next-access");
    const restarted = new Connections(store, vault, transport);
    await restarted.call(buyerA, created.id, "lookup", {}, created.fingerprint);
    expect(refreshes).toBe(1);
    expect(() => restarted.read(buyerB, created.id)).toThrow("No accessible connection");
  });
  it("requires reconnection when unattended renewal is unavailable", async () => {
    let calls = 0;
    const { connections } = fixture({ connect: async () => ({ tools: catalog }), call: async () => { calls++; } });
    const created = await connections.add(buyerA, input, { accessToken: "expired", expiresAt: 0 });
    connections.allowTools(buyerA, created.id, ["lookup"], created.fingerprint);
    await expect(connections.call(buyerA, created.id, "lookup", {}, created.fingerprint)).rejects.toMatchObject({ code: "RECONNECTION_REQUIRED" });
    expect(connections.read(buyerA, created.id).state).toBe("reconnection_required");
    expect(calls).toBe(0);
  });
  it("does not resurrect revoked credentials during refresh", async () => {
    let resolveRefresh!: (value: McpCredentials) => void;
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const { connections, vault } = fixture({ connect: async () => ({ tools: catalog }), call: async () => { throw new Error("must not run"); }, refresh: async () => { started(); return new Promise(resolve => { resolveRefresh = resolve; }); } });
    const created = await connections.add(buyerA, input, { accessToken: "old", refreshToken: "refresh", expiresAt: 0 });
    connections.allowTools(buyerA, created.id, ["lookup"], created.fingerprint);
    const pending = connections.call(buyerA, created.id, "lookup", {}, created.fingerprint);
    const rejected = expect(pending).rejects.toMatchObject({ code: "RECONNECTION_REQUIRED" });
    await start;
    await connections.revoke(dev, created.id);
    resolveRefresh({ accessToken: "new", refreshToken: "new-refresh" });
    await rejected;
    expect(await vault.get(created.id)).toBeUndefined();
    expect(() => connections.allowTools(buyerA, created.id, ["lookup"], created.fingerprint)).toThrow("Reconnect");
  });
  it("invalidates prepared calls after a remote schema change", async () => {
    let changed = false;
    const { connections } = fixture({ connect: async () => ({ tools: changed ? [{ ...catalog[0]!, inputSchema: { type: "object", required: ["part"] } }] : catalog }), call: async () => ({}) });
    const created = await connections.add(buyerA, { ...input, auth: "none" });
    connections.allowTools(buyerA, created.id, ["lookup"], created.fingerprint);
    changed = true;
    const discovered = await connections.discover(buyerA, created.id);
    expect(discovered.state).toBe("schema_changed");
    expect(discovered.allowedTools).toEqual([]);
    await expect(connections.call(buyerA, created.id, "lookup", {}, created.fingerprint)).rejects.toMatchObject({ code: "RECONNECTION_REQUIRED" });
  });
  it("rejects private endpoints and credential-bearing URLs", () => {
    for (const url of ["http://example.test", "https://127.0.0.1", "https://10.0.0.1", "https://[::1]", "https://user:password@example.test"]) expect(() => validateMcpUrl(url)).toThrow();
    expect(validateMcpUrl("https://mcp.example.test").protocol).toBe("https:");
  });
});
