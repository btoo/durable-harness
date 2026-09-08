import { HarnessFault, asFault, invariant } from "@durable-harness/core";
import { application, commandSchema, personaSchema, type DemoEnv } from "./protocol.js";
import { readSession, sessionCookie, signSession } from "./auth.js";
export { DemoApplication } from "./application.js";
export { HarnessThink } from "./think.js";

export default {
  async fetch(request: Request, env: DemoEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      invariant(
        env.DEMO_MODE === "synthetic",
        "ACCESS_DENIED",
        "This reference application accepts synthetic deployments only.",
      );
      const origin = request.headers.get("origin");
      invariant(
        !origin || origin === url.origin,
        "ACCESS_DENIED",
        "Requests must originate from this application.",
      );
      if (url.pathname === "/api/health")
        return Response.json({
          status: "ok",
          evidence: "synthetic",
          version: "0.1.0-experimental",
        });
      const existing = await readSession(request, env.SESSION_SECRET);
      if (url.pathname === "/api/session" && request.method === "POST") {
        const input = (await request.json()) as { persona?: unknown };
        const persona = personaSchema.parse(input.persona ?? "northstar");
        const session = {
          sandbox: existing?.sandbox ?? crypto.randomUUID(),
          persona,
          expiresAt: Date.now() + 86_400_000,
        };
        return Response.json(
          { persona },
          {
            headers: {
              "set-cookie": sessionCookie(await signSession(session, env.SESSION_SECRET), url),
              "cache-control": "no-store",
            },
          },
        );
      }
      invariant(existing, "ACCESS_DENIED", "Start a demo session to open your workspaces.");
      const app = application(env, existing.sandbox);
      const workspaceId = url.searchParams.get("workspace") ?? undefined;
      if (url.pathname === "/api/state" && request.method === "GET") {
        const result = await app.apiState(existing.persona, workspaceId);
        if (!result.ok) throw new HarnessFault(result.error.code, result.error.message);
        return Response.json(result.value, { headers: { "cache-control": "no-store" } });
      }
      if (
        url.pathname === "/api/events" &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        invariant(workspaceId, "INVALID_INPUT", "Choose a workspace before subscribing.");
        const after = Number(url.searchParams.get("after") ?? 0);
        invariant(
          Number.isSafeInteger(after) && after >= 0,
          "INVALID_INPUT",
          "The event cursor must be a nonnegative integer.",
        );
        // WebSocket upgrades use the Durable Object fetch transport, not RPC serialization.
        const headers = new Headers(request.headers);
        headers.set("x-dh-persona", existing.persona);
        return app.fetch(new Request(request, { headers }));
      }
      if (url.pathname === "/api/command" && request.method === "POST") {
        invariant(workspaceId, "INVALID_INPUT", "Choose a workspace before submitting work.");
        const body = await request.text();
        invariant(
          body.length <= 70_000,
          "BUDGET_EXCEEDED",
          "The request exceeds the application limit.",
        );
        const command = commandSchema.parse(JSON.parse(body));
        const realModelAllowed =
          !!env.ADMIN_TOKEN && request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
        const result = await app.apiCommand(
          existing.sandbox,
          existing.persona,
          workspaceId,
          command,
          realModelAllowed,
        );
        if (!result.ok) throw new HarnessFault(result.error.code, result.error.message);
        return Response.json(result.value, { headers: { "cache-control": "no-store" } });
      }
      return Response.json(
        { error: { code: "NOT_FOUND", message: "No API route matches this request." } },
        { status: 404 },
      );
    } catch (error) {
      const fault = asFault(error);
      const status =
        fault.code === "ACCESS_DENIED"
          ? 403
          : fault.code === "NOT_FOUND"
            ? 404
            : fault.code === "STALE_REVISION" || fault.code === "WORKSPACE_BUSY"
              ? 409
              : 400;
      return Response.json(
        { error: fault.toJSON() },
        { status, headers: { "cache-control": "no-store" } },
      );
    }
  },
} satisfies ExportedHandler<DemoEnv>;
