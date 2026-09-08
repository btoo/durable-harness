import { DurableObject } from "cloudflare:workers";

interface Env {
  CATALOG: DurableObjectNamespace;
  CALLBACK_ORIGINS: string;
  TEST_CONTROL_TOKEN: string;
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
}
interface Client {
  id: string;
  redirects: string[];
}
interface Consent {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  expiresAt: number;
}
interface Grant {
  id: string;
  clientId: string;
  revoked: boolean;
  refreshes: number;
  accessKey: string;
}
interface Token {
  grantId: string;
  expiresAt: number;
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
const digest = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
const random = () => crypto.randomUUID() + crypto.randomUUID();
function fail(message: string): never {
  throw new Error(message);
}

/** A synthetic test service, not an OAuth implementation for production accounts. */
export class SyntheticCatalog extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (
        request.method === "POST" &&
        request.headers.get("origin") &&
        request.headers.get("origin") !== url.origin
      )
        return json({ error: "invalid_origin" }, 403);
      if (url.pathname.includes("/.well-known/oauth-protected-resource"))
        return json({
          resource: `${url.origin}/mcp`,
          authorization_servers: [url.origin],
          scopes_supported: ["catalog:read", "offline_access"],
        });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          registration_endpoint: `${url.origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["catalog:read", "offline_access"],
        });
      if (url.pathname === "/register" && request.method === "POST") {
        const input = (await request.json()) as { redirect_uris?: unknown };
        if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length !== 1)
          fail("invalid_redirect_uri");
        const redirect = new URL(String(input.redirect_uris[0]));
        if (
          !this.env.CALLBACK_ORIGINS.split(",").includes(redirect.origin) ||
          !/^\/api\/mcp\/callback\/[a-f0-9-]{36}$/.test(redirect.pathname) ||
          redirect.search ||
          redirect.hash
        )
          fail("invalid_redirect_uri");
        const id = crypto.randomUUID();
        await this.ctx.storage.put(`client:${id}`, {
          id,
          redirects: [redirect.toString()],
        } satisfies Client);
        return json(
          {
            client_id: id,
            redirect_uris: [redirect.toString()],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          },
          201,
        );
      }
      if (url.pathname === "/authorize" && request.method === "GET") {
        const params = url.searchParams;
        const client = await this.ctx.storage.get<Client>(`client:${params.get("client_id")}`);
        const redirectUri = params.get("redirect_uri") ?? "";
        const challenge = params.get("code_challenge") ?? "";
        const state = params.get("state") ?? "";
        if (
          !client?.redirects.includes(redirectUri) ||
          params.get("response_type") !== "code" ||
          params.get("code_challenge_method") !== "S256" ||
          !/^[-_a-zA-Z0-9]{43}$/.test(challenge) ||
          state.length > 2000
        )
          fail("invalid_authorization_request");
        const id = crypto.randomUUID();
        await this.ctx.storage.put(`consent:${id}`, {
          clientId: client.id,
          redirectUri,
          challenge,
          state,
          expiresAt: Date.now() + 300_000,
        } satisfies Consent);
        return new Response(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect the synthetic supplier catalog</title><style>body{font:16px/1.6 system-ui;background:#f5f6f3;color:#263832;display:grid;min-height:95vh;place-items:center}main{max-width:480px;background:white;padding:40px;border:1px solid #e4e8e1;border-radius:16px}h1{font-size:26px;line-height:1.3}small{color:#65726b}button{background:#286b52;color:white;border:0;border-radius:7px;padding:13px 20px;font:inherit;cursor:pointer}</style><main><small>DURABLE-HARNESS · SYNTHETIC SERVICE</small><h1>Connect the supplier catalog</h1><p>Allow your agent to look up fictional part prices while you are away. This service contains no customer data and cannot send messages or place orders.</p><p>The connection uses OAuth with PKCE and rotating refresh tokens.</p><form method="post"><input type="hidden" name="consent" value="${id}"><button>Authorize synthetic account</button></form></main></html>`,
          {
            headers: {
              "content-type": "text/html;charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy":
                "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
            },
          },
        );
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        const fields = await request.formData();
        const id = String(fields.get("consent"));
        const consent = await this.ctx.storage.get<Consent>(`consent:${id}`);
        if (!consent || consent.expiresAt < Date.now()) fail("expired_consent");
        await this.ctx.storage.delete(`consent:${id}`);
        const code = random();
        await this.ctx.storage.put(`code:${await digest(code)}`, consent);
        const redirect = new URL(consent.redirectUri);
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", consent.state);
        return new Response(null, {
          status: 303,
          headers: { location: redirect.toString(), "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const body = await request.formData();
        return this.ctx.blockConcurrencyWhile(() => this.exchange(body));
      }
      if (url.pathname === "/control" && request.method === "POST") {
        if (
          !this.env.TEST_CONTROL_TOKEN ||
          request.headers.get("authorization") !== `Bearer ${this.env.TEST_CONTROL_TOKEN}`
        )
          return json({ error: "forbidden" }, 403);
        const input = (await request.json()) as { action: string; grantId: string };
        const grant = await this.ctx.storage.get<Grant>(`grant:${input.grantId}`);
        if (!grant) return json({ error: "not_found" }, 404);
        if (input.action === "expire")
          await this.ctx.storage.put(grant.accessKey, { grantId: grant.id, expiresAt: 0 });
        else if (input.action === "revoke")
          await this.ctx.storage.put(`grant:${grant.id}`, { ...grant, revoked: true });
        else return json({ error: "invalid_action" }, 400);
        return json({ changed: true, action: input.action });
      }
      if (url.pathname === "/mcp") return this.mcp(request, url);
      if (url.pathname === "/")
        return json({
          service: "durable-harness synthetic MCP fixture",
          deployment: this.env.CF_VERSION_METADATA ?? null,
          evidence: "synthetic",
          endpoint: `${url.origin}/mcp`,
        });
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "invalid_request" }, 400);
    }
  }
  private async exchange(fields: FormData): Promise<Response> {
    const clientId = String(fields.get("client_id"));
    let grant: Grant;
    if (fields.get("grant_type") === "authorization_code") {
      const key = `code:${await digest(String(fields.get("code")))}`;
      const consent = await this.ctx.storage.get<Consent>(key);
      const bytes = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(String(fields.get("code_verifier"))),
        ),
      );
      const challenge = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      if (
        !consent ||
        consent.expiresAt < Date.now() ||
        consent.clientId !== clientId ||
        consent.redirectUri !== fields.get("redirect_uri") ||
        consent.challenge !== challenge
      )
        return json({ error: "invalid_grant" }, 400);
      await this.ctx.storage.delete(key);
      grant = { id: crypto.randomUUID(), clientId, revoked: false, refreshes: 0, accessKey: "" };
    } else if (fields.get("grant_type") === "refresh_token") {
      const key = `refresh:${await digest(String(fields.get("refresh_token")))}`;
      const token = await this.ctx.storage.get<Token>(key);
      const previous = token
        ? await this.ctx.storage.get<Grant>(`grant:${token.grantId}`)
        : undefined;
      if (
        !token ||
        token.expiresAt < Date.now() ||
        !previous ||
        previous.revoked ||
        previous.clientId !== clientId
      )
        return json({ error: "invalid_grant" }, 400);
      await this.ctx.storage.delete(key);
      grant = { ...previous, refreshes: previous.refreshes + 1 };
    } else return json({ error: "unsupported_grant_type" }, 400);
    const access = random();
    const refresh = random();
    grant.accessKey = `access:${await digest(access)}`;
    await this.ctx.storage.put({
      [grant.accessKey]: { grantId: grant.id, expiresAt: Date.now() + 30_000 },
      [`refresh:${await digest(refresh)}`]: {
        grantId: grant.id,
        expiresAt: Date.now() + 3_600_000,
      },
      [`grant:${grant.id}`]: grant,
    });
    return json({
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 30,
      scope: "catalog:read offline_access",
    });
  }
  private async mcp(request: Request, url: URL): Promise<Response> {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const token = bearer
      ? await this.ctx.storage.get<Token>(`access:${await digest(bearer)}`)
      : undefined;
    const grant = token ? await this.ctx.storage.get<Grant>(`grant:${token.grantId}`) : undefined;
    if (!token || token.expiresAt < Date.now() || !grant || grant.revoked)
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
          "cache-control": "no-store",
        },
      });
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    const message = (await request.json()) as {
      id?: string | number;
      method: string;
      params?: { name?: string; arguments?: { part?: string } };
    };
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "synthetic-supplier-catalog", version: "1" },
      };
    else if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "lookup",
            description:
              "Read a fictional part price. The result includes synthetic authorization proof counters.",
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: "object",
              properties: { part: { type: "string" } },
              required: ["part"],
              additionalProperties: false,
            },
            outputSchema: {
              type: "object",
              properties: {
                part: { type: "string" },
                unitPrice: { type: "number" },
                evidence: { const: "synthetic" },
                authorization: { type: "object" },
              },
              required: ["part", "unitPrice", "evidence", "authorization"],
            },
          },
        ],
      };
    else if (message.method === "tools/call" && message.params?.name === "lookup") {
      const part = message.params.arguments?.part;
      if (typeof part !== "string" || part.length > 80)
        return json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: "Provide a part identifier of at most 80 characters." },
        });
      const data = {
        part,
        unitPrice: 12,
        evidence: "synthetic",
        authorization: { grantId: grant.id, refreshes: grant.refreshes },
      };
      result = { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    } else if (message.method === "ping") result = {};
    else
      return json({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not supported by this synthetic fixture." },
      });
    return json({ jsonrpc: "2.0", id: message.id, result });
  }
}
export default {
  fetch(request: Request, env: Env) {
    return env.CATALOG.getByName("synthetic-catalog").fetch(request);
  },
} satisfies ExportedHandler<Env>;
