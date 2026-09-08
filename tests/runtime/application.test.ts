import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { DemoState } from "../../apps/demo/src/api.js";

async function session(persona = "northstar", previous = "") {
  const response = await SELF.fetch("https://demo.test/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: previous },
    body: JSON.stringify({ persona }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
async function state(cookie: string, workspace = "northstar-quoting"): Promise<DemoState> {
  return await (
    await SELF.fetch(`https://demo.test/api/state?workspace=${workspace}`, { headers: { cookie } })
  ).json();
}
async function command(cookie: string, body: object, workspace = "northstar-quoting") {
  return SELF.fetch(`https://demo.test/api/command?workspace=${workspace}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("authenticated reference application", () => {
  it("imports an allowed MCP, gates execution through approval, and enforces revocation", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== "https://fixture.example.test")
        throw new Error("Unexpected outbound request");
      if (request.method === "GET") return new Response(null, { status: 405 });
      const message = (await request.json()) as { id?: number; method: string };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic", version: "1" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "lookup",
                    description: "Read a synthetic price",
                    inputSchema: {
                      type: "object",
                      properties: { part: { type: "string" } },
                      required: ["part"],
                    },
                  },
                ],
              }
            : message.method === "tools/call"
              ? (calls++,
                {
                  content: [{ type: "text", text: "Part A-1 costs 12." }],
                  structuredContent: { price: 12 },
                })
              : {};
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    });
    try {
      const cookie = await session();
      const add = {
        action: "mcp-add",
        name: "Supplier catalog",
        auth: "none",
        url: "https://fixture.example.test/mcp",
      };
      expect(
        (await command(cookie, { ...add, url: "https://unapproved.example/mcp" })).status,
      ).toBe(403);
      const response = await command(cookie, add);
      expect(response.status, await response.clone().text()).toBe(200);
      const connection = (await response.json()) as {
        id: string;
        fingerprint: string;
        state: string;
      };
      expect(connection.state).toBe("ready");
      const invoke = {
        action: "mcp-call",
        connectionId: connection.id,
        tool: "lookup",
        input: { part: "A-1" },
      };
      expect((await command(cookie, invoke)).status).toBe(404);
      expect(
        (
          await command(cookie, {
            action: "mcp-grant",
            connectionId: connection.id,
            tools: ["lookup"],
            fingerprint: connection.fingerprint,
          })
        ).status,
      ).toBe(200);
      expect((await command(cookie, invoke)).status).toBe(200);
      expect(calls).toBe(0);
      const action = (await state(cookie)).pending[0]!;
      const approved = await command(cookie, { action: "approve", operationId: action.id });
      expect(approved.status, await approved.clone().text()).toBe(200);
      expect(calls).toBe(1);
      const other = await session("cedar", cookie);
      expect(
        (
          await command(
            other,
            { action: "mcp-revoke", connectionId: connection.id },
            "cedar-quoting",
          )
        ).status,
      ).toBe(404);
      const owner = await session("northstar", other);
      expect(
        (await command(owner, { action: "mcp-revoke", connectionId: connection.id })).status,
      ).toBe(200);
      expect((await command(owner, invoke)).status).toBe(404);
      expect(calls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retains code, bindings and original history after compaction and an actual runtime restart", async () => {
    const cookie = await session("developer");
    await command(cookie, { action: "run-synthetic" });
    await command(cookie, {
      action: "correct",
      preference: "includeFreight",
      text: "Customer exception: always include freight for RFQ-208.",
    });
    const before = await state(cookie);
    const original = before.history.find((item) => item.metadata.kind === "correction")!;
    const operator = async (body: object) =>
      SELF.fetch("https://demo.test/api/command?workspace=northstar-quoting", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          authorization: "Bearer test-only-model-admission",
        },
        body: JSON.stringify(body),
      });
    expect((await operator({ action: "seed-history" })).status).toBe(200);
    const compacted = (await (await command(cookie, { action: "compact" })).json()) as {
      receipt?: unknown;
    };
    expect(compacted.receipt).toBeDefined();
    const restart = (await (await operator({ action: "restart-runtime" })).json()) as {
      restarted?: boolean;
      after: string;
    };
    expect(restart.restarted, JSON.stringify(restart)).toBe(true);
    expect(restart.after).not.toBe(before.runtimeInstanceId);
    const result = await command(cookie, {
      action: "cell",
      id: crypto.randomUUID(),
      expectedRevision: 1,
      source: `const originalCorrection = await history.read(${JSON.stringify(original.id)}); const restoredRanking = rankOffers(evidence.offers, true);`,
    });
    expect(result.status).toBe(200);
    const restored = await state(cookie);
    expect(restored.workspace?.bindings.some((binding) => binding.name === "restoredRanking")).toBe(
      true,
    );
    expect(restored.history.find((item) => item.id === original.id)?.text).toBe(original.text);
    expect(restored.workspace?.functions).toEqual(before.workspace?.functions);
  });
  it("executes Think tool calls and persists the streamed response", async () => {
    const cookie = await session("developer");
    await SELF.fetch("https://demo.test/api/command?workspace=northstar-quoting", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        authorization: "Bearer test-only-model-admission",
      },
      body: JSON.stringify({ action: "seed-history" }),
    });
    const requestId = crypto.randomUUID();
    const requestBody = {
      action: "model",
      requestId,
      message: "Create retained evidence notes and a reusable helper.",
    };
    const response = await SELF.fetch("https://demo.test/api/command?workspace=northstar-quoting", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        authorization: "Bearer test-only-model-admission",
      },
      body: JSON.stringify(requestBody),
    });
    expect(response.status).toBe(200);
    const duplicate = await SELF.fetch(
      "https://demo.test/api/command?workspace=northstar-quoting",
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          authorization: "Bearer test-only-model-admission",
        },
        body: JSON.stringify(requestBody),
      },
    );
    expect(((await duplicate.json()) as { rootId: string }).rootId).toBe(requestId);
    await vi.waitFor(
      async () => {
        const snapshot = await state(cookie);
        expect(
          snapshot.events.some((event) => event.kind === "model.completed"),
          JSON.stringify(snapshot.modelSteps),
        ).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );
    const snapshot = await state(cookie);
    expect(
      snapshot.workspace?.bindings.some((binding) => binding.name === "modelNotes"),
      JSON.stringify(snapshot.modelSteps),
    ).toBe(true);
    expect(snapshot.workspace?.functions.some((helper) => helper.name === "countChecked")).toBe(
      true,
    );
    expect(
      snapshot.history.some(
        (item) => item.text === "I retained the evidence notes and a helper for the next run.",
      ),
    ).toBe(true);
    expect(snapshot.runs?.[0]?.steps).toBe(4);
    expect(snapshot.runs).toHaveLength(1);
    const stepId = snapshot.modelSteps![0]!.stepId;
    const original = await command(cookie, {
      action: "read-model-step",
      rootId: requestId,
      stepId,
    });
    expect(((await original.json()) as { text: string }).text).toContain(
      "PRIVATE_REASONING_FIXTURE",
    );
    const customerCookie = await session("northstar", cookie);
    expect(
      (await command(customerCookie, { action: "read-model-step", rootId: requestId, stepId }))
        .status,
    ).toBe(403);
    const streamed = snapshot.events
      .filter((event) => event.kind === "model.delta")
      .map((event) => event.text)
      .join("");
    expect(streamed).toBe(
      snapshot.history.find((item) => item.id === `${requestId}:assistant`)?.text,
    );
  });
  it("enforces tenant and developer boundaries on the actual HTTP paths", async () => {
    const cookie = await session();
    expect(
      (
        await SELF.fetch("https://demo.test/api/state?workspace=cedar-quoting", {
          headers: { cookie },
        })
      ).status,
    ).toBe(403);
    const customer = await state(cookie);
    expect(customer.workspace).toBeUndefined();
    expect(customer.workspaces).toHaveLength(2);
    expect(
      (
        await command(cookie, {
          action: "cell",
          source: "const x = 1;",
          expectedRevision: 0,
          id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(403);
    const developer = await state(await session("developer", cookie));
    expect(developer.workspace?.revision).toBe(0);
    expect(developer.workspaces).toHaveLength(3);
    expect(
      (
        await SELF.fetch("https://demo.test/api/state", {
          headers: { cookie: cookie.replace("dh_session=", "dh_session=tampered") },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await SELF.fetch("https://demo.test/api/session", {
          method: "POST",
          headers: { origin: "https://evil.test", "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });
  it("carries a tested customer correction into the next quoting decision", async () => {
    const cookie = await session();
    expect((await command(cookie, { action: "run-synthetic" })).status).toBe(200);
    expect(
      (await state(cookie)).events.some((event) =>
        event.text.includes("Aster Components is the lowest-cost"),
      ),
    ).toBe(true);
    const correction = await command(cookie, {
      action: "correct",
      preference: "includeFreight",
      text: "Please include freight in comparisons.",
    });
    expect(correction.status).toBe(200);
    expect((await state(cookie)).proposals[0]?.status).toBe("promoted");
    expect((await command(cookie, { action: "run-synthetic" })).status).toBe(200);
    const improved = await state(cookie);
    expect(
      improved.events.some((event) =>
        event.text.includes("Brookfield Parts is the lowest-cost option including freight"),
      ),
    ).toBe(true);
    expect(improved.configuration?.revision).toBe(2);
    const other = await state(await session("cedar", cookie), "cedar-quoting");
    expect(other.configuration?.revision).toBe(1);
    expect(other.proposals).toEqual([]);
  });
  it("keeps an action waiting until customer approval, then delivers it once", async () => {
    const cookie = await session();
    await command(cookie, { action: "prepare-message" });
    const pending = (await state(cookie)).pending[0]!;
    expect(pending).toBeDefined();
    const approved = await command(cookie, { action: "approve", operationId: pending.id });
    expect(approved.status).toBe(200);
    expect((await state(cookie)).pending).toEqual([]);
    expect((await command(cookie, { action: "approve", operationId: pending.id })).status).toBe(
      400,
    );
    expect((await state(cookie)).cells.filter((cell) => cell.status === "committed")).toHaveLength(
      1,
    );
  });
  it("upgrades the live transport and reconstructs exactly the same authorized events", async () => {
    const cookie = await session();
    const before = await state(cookie);
    const response = await SELF.fetch(
      "https://demo.test/api/events?workspace=northstar-quoting&after=0",
      { headers: { cookie, Upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const records: unknown[] = [];
    const received = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => {
        records.push(JSON.parse(String(event.data)));
        if (records.length === before.events.length) resolve();
      });
    });
    socket.accept();
    await received;
    expect(records).toEqual(before.events);
    socket.close(1000, "test complete");
  });
});
