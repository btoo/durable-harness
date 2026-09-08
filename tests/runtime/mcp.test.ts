import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { McpTestHost } from "./mcp-host.js";

afterEach(() => {
  vi.unstubAllGlobals();
});
it("uses the Cloudflare MCP client and reconstructs it after object eviction", async () => {
  const methods: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== "https://fixture.example.test")
      throw new Error("Unexpected outbound request");
    if (request.method === "GET") return new Response(null, { status: 405 });
    const message = (await request.json()) as { id?: number; method: string };
    methods.push(message.method);
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "synthetic-supplier", version: "1" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "lookup",
                  description: "Look up a synthetic part",
                  inputSchema: {
                    type: "object",
                    properties: { part: { type: "string" } },
                    required: ["part"],
                  },
                },
              ],
            }
          : message.method === "tools/call"
            ? {
                content: [{ type: "text", text: "Part A-1 costs 12." }],
                structuredContent: { part: "A-1", price: 12 },
              }
            : {};
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  });
  const namespace = (env as unknown as { MCP_TESTS: DurableObjectNamespace }).MCP_TESTS;
  const host = namespace.getByName(crypto.randomUUID()) as DurableObjectStub &
    Pick<McpTestHost, "connectServer" | "call" | "close">;
  const connected = await host.connectServer();
  expect(connected.state, JSON.stringify({ connected, methods })).toBe("ready");
  expect(await host.call()).toMatchObject({ structuredContent: { part: "A-1", price: 12 } });
  await host.close();
  await evictDurableObject(host);
  expect(await host.call()).toMatchObject({ structuredContent: { part: "A-1", price: 12 } });
  await host.close();
  expect(methods.filter((method) => method === "tools/call")).toHaveLength(2);
});

it("completes OAuth with PKCE, keeps tokens encrypted, and refreshes after eviction", async () => {
  let expired = false;
  let tokenRequests = 0;
  let refreshes = 0;
  let challenge = "";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe("https://fixture.example.test");
    if (url.pathname.includes("oauth-protected-resource"))
      return Response.json({
        resource: "https://fixture.example.test/mcp",
        authorization_servers: [url.origin],
        scopes_supported: ["tools:read", "offline_access"],
      });
    if (
      url.pathname.includes("oauth-authorization-server") ||
      url.pathname.includes("openid-configuration")
    )
      return Response.json({
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/authorize`,
        token_endpoint: `${url.origin}/token`,
        registration_endpoint: `${url.origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register")
      return Response.json(
        { ...((await request.json()) as object), client_id: "fixture-client" },
        { status: 201 },
      );
    if (url.pathname === "/token") {
      tokenRequests++;
      const fields = new URLSearchParams(await request.text());
      if (fields.get("grant_type") === "refresh_token") {
        refreshes++;
        expect(fields.get("refresh_token")).toBe("refresh-fixture-1");
        return Response.json({
          access_token: "access-fixture-2",
          refresh_token: "refresh-fixture-2",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "tools:read offline_access",
        });
      }
      const hash = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(fields.get("code_verifier")!),
        ),
      );
      expect(
        btoa(String.fromCharCode(...hash))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, ""),
      ).toBe(challenge);
      return Response.json({
        access_token: "access-fixture-1",
        refresh_token: "refresh-fixture-1",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "tools:read offline_access",
      });
    }
    if (
      request.headers.get("authorization") !==
      (expired ? "Bearer access-fixture-2" : "Bearer access-fixture-1")
    )
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://fixture.example.test/.well-known/oauth-protected-resource"',
        },
      });
    if (request.method === "GET") return new Response(null, { status: 405 });
    const message = (await request.json()) as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "authorized-supplier", version: "1" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                { name: "lookup", description: "Read a part", inputSchema: { type: "object" } },
              ],
            }
          : { content: [{ type: "text", text: "Authorized synthetic lookup" }] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  });
  const namespace = (env as unknown as { MCP_TESTS: DurableObjectNamespace }).MCP_TESTS;
  const host = namespace.getByName(crypto.randomUUID()) as DurableObjectStub &
    Pick<McpTestHost, "connectServer" | "call" | "close" | "authorize" | "credentialScan">;
  const connection = await host.connectServer("oauth");
  expect(connection.state, JSON.stringify(connection)).toBe("authorization_required");
  const authorization = new URL(connection.authorizationUrl!);
  challenge = authorization.searchParams.get("code_challenge")!;
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "fixture-code");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  expect((await host.authorize(callback.toString())).state).toBe("ready");
  expect(await host.call()).toMatchObject({ content: [{ text: "Authorized synthetic lookup" }] });
  const stored = await host.credentialScan();
  expect(stored).not.toContain("access-fixture");
  expect(stored).not.toContain("refresh-fixture");
  await host.close();
  await evictDurableObject(host);
  expired = true;
  await Promise.all([host.call(), host.call()]);
  expect(tokenRequests).toBe(2);
  expect(refreshes).toBe(1);
  await host.close();
});
