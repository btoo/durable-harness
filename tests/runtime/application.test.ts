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
    const response = await SELF.fetch("https://demo.test/api/command?workspace=northstar-quoting", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        authorization: "Bearer test-only-model-admission",
      },
      body: JSON.stringify({
        action: "model",
        message: "Create retained evidence notes and a reusable helper.",
      }),
    });
    expect(response.status).toBe(200);
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
    expect(snapshot.runs?.[0]?.steps).toBe(3);
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
