import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { McpTestHost } from "./mcp-host.js";

it("uses the runnable OAuth fixture through the actual Cloudflare MCP client", async () => {
  const bindings = env as unknown as {
    CATALOG: DurableObjectNamespace;
    MCP_TESTS: DurableObjectNamespace;
  };
  const catalogId = crypto.randomUUID();
  const catalog = bindings.CATALOG.getByName(catalogId);
  const traffic: unknown[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe("https://fixture.example.test");
    try {
      const response = await bindings.CATALOG.getByName(catalogId).fetch(request);
      traffic.push({ path: new URL(request.url).pathname, status: response.status });
      return response;
    } catch (error) {
      traffic.push({ error: String(error) });
      throw error;
    }
  });
  const host = bindings.MCP_TESTS.getByName(crypto.randomUUID()) as DurableObjectStub &
    Pick<McpTestHost, "connectServer" | "authorize" | "call" | "close" | "tryCall">;
  try {
    const connection = await host.connectServer("oauth");
    expect(connection.state, JSON.stringify(traffic)).toBe("authorization_required");
    const consent = await catalog.fetch(connection.authorizationUrl!);
    expect(consent.status).toBe(200);
    const id = /name="consent" value="([a-f0-9-]+)"/.exec(await consent.text())![1]!;
    const form = new FormData();
    form.set("consent", id);
    const approved = await catalog.fetch("https://fixture.example.test/authorize", {
      method: "POST",
      body: form,
      redirect: "manual",
    });
    expect(approved.status).toBe(303);
    const authorized = await host.authorize(approved.headers.get("location")!);
    expect(authorized.state).toBe("ready");
    expect(authorized.backgroundAccess).toBe("supported");
    const first = (await host.call()) as {
      structuredContent: { authorization: { grantId: string; refreshes: number } };
    };
    expect(first.structuredContent.authorization.refreshes).toBe(0);
    const control = async (action: string) =>
      catalog.fetch("https://fixture.example.test/control", {
        method: "POST",
        headers: {
          authorization: "Bearer test-only-fixture-control",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action, grantId: first.structuredContent.authorization.grantId }),
      });
    expect((await control("expire")).status).toBe(200);
    await host.close();
    await evictDurableObject(host);
    const resumed = (await host.call()) as typeof first;
    expect(resumed.structuredContent.authorization.refreshes).toBe(1);
    expect((await control("revoke")).status).toBe(200);
    expect((await host.tryCall()).ok).toBe(false);
  } finally {
    await host.close();
    vi.unstubAllGlobals();
  }
});
