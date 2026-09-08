import { afterEach, describe, expect, it } from "vitest";
import { AccessPolicy, ContextManager, History, Memory, decodeGraph } from "@durable-harness/core";
import { buyerA, buyerB, database, dev } from "./store.js";

const cleanup: (() => void)[] = [];
const open = () => {
  const fixture = database();
  cleanup.push(fixture.close);
  return fixture.store;
};
afterEach(() => {
  cleanup.splice(0).forEach((close) => close());
});

describe("scoped knowledge and compaction over real SQLite", () => {
  it("shares only policy-selected fields and preserves the private original", () => {
    const store = open();
    const memory = new Memory(store, [
      { id: "technical-lesson", sourceSpaceId: "a", targetSpaceId: "shared", fields: ["lesson"] },
    ]);
    const original = memory.write(
      dev,
      {
        spaceId: "a",
        title: "Normalize units",
        kind: "procedure",
        value: { lesson: "Convert units before comparing", negotiatedPrice: 37 },
      },
      [{ spaceId: "a", itemId: "source" }],
    );
    expect(() => memory.read(buyerB, original.id)).toThrow(/No accessible memory/);
    expect(() => memory.publish(dev, original.id, "shared")).toThrow(/policy or developer review/);
    const published = memory.publish(dev, original.id, "shared", { ruleId: "technical-lesson" });
    expect(decodeGraph(memory.read(buyerB, published.id).value).value).toEqual({
      lesson: "Convert units before comparing",
    });
    expect(decodeGraph(memory.read(buyerA, original.id).value).value).toEqual({
      lesson: "Convert units before comparing",
      negotiatedPrice: 37,
    });
  });
  it("does not remove lineage through an ordinary edit or stale write", () => {
    const store = open();
    const memory = new Memory(store);
    const original = memory.write(
      dev,
      { spaceId: "shared", title: "Private source", kind: "fact", value: "confidential" },
      [{ spaceId: "a", itemId: "source" }],
    );
    const updated = memory.write(
      dev,
      {
        id: original.id,
        expectedRevision: 1,
        spaceId: "shared",
        title: "Private source",
        kind: "fact",
        value: "still restricted",
      },
      [],
    );
    expect(updated.lineage).toEqual(original.lineage);
    expect(() => memory.read(buyerB, original.id)).toThrow();
    expect(() =>
      memory.write(
        dev,
        {
          id: original.id,
          expectedRevision: 1,
          spaceId: "shared",
          title: "stale",
          kind: "fact",
          value: "wrong",
        },
        [],
      ),
    ).toThrow(/latest revision/);
  });
  it("filters FTS results before ranking and limiting", () => {
    const store = open();
    const history = new History(store);
    history.append({
      workspaceId: "a",
      role: "user",
      text: "Contract EXCEPTION-47357: postpone reminders until Friday",
      audience: "customer",
      lineage: [],
      metadata: {},
    });
    history.append({
      workspaceId: "a",
      role: "system",
      text: "EXCEPTION-47357 internal diagnostics",
      audience: "developer",
      lineage: [],
      metadata: {},
    });
    history.append({
      workspaceId: "a",
      role: "assistant",
      text: "EXCEPTION-47357 private second-tenant evidence",
      audience: "customer",
      lineage: [{ spaceId: "b", itemId: "hidden" }],
      metadata: {},
    });
    const matches = history.search(buyerA, "EXCEPTION-47357", ["a"], 1);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toContain("postpone reminders");
    expect(() => history.search(buyerB, "EXCEPTION-47357", ["a"])).toThrow();
  });
  it("compacts repeatedly without losing original exceptions or crossing permissions", async () => {
    const store = open();
    const history = new History(store);
    const exception = history.append({
      workspaceId: "a",
      role: "user",
      text: "For EXCEPTION-47357, never send follow-ups before Friday.",
      audience: "customer",
      lineage: [],
      metadata: {},
    });
    for (let i = 0; i < 25; i++)
      history.append({
        workspaceId: "a",
        role: "assistant",
        text: `Observation ${i}: ${"supplier evidence ".repeat(35)}`,
        audience: "customer",
        lineage: [],
        metadata: {},
      });
    const before = history.list(buyerA, "a");
    const manager = new ContextManager(store);
    const context = await manager.prepare(
      buyerA,
      "a",
      "test-model",
      {
        contextWindow: 1700,
        outputReserve: 200,
        instructions: "Respect customer rules",
        toolSchemas: {},
      },
      async () =>
        `Open work continues. Retrieve the original customer exception at ${exception.id} before scheduling follow-ups.`,
    );
    expect(context.receipt?.coveredIds).toContain(exception.id);
    expect(context.estimatedTokens).toBeLessThan(1160);
    expect(history.list(buyerA, "a")).toEqual(before);
    expect(history.search(buyerA, "EXCEPTION-47357", ["a"])[0]!.text).toBe(exception.text);
    expect(history.read(buyerA, exception.id)).toEqual(exception);
    new AccessPolicy(store).setGrants(
      dev,
      "a",
      [{ principalId: dev.id, permissions: ["read", "write", "publish", "execute"] }],
      1,
    );
    await expect(
      manager.prepare(
        buyerA,
        "a",
        "test-model",
        { contextWindow: 1700, outputReserve: 200, instructions: "", toolSchemas: {} },
        async () => "must not run",
      ),
    ).rejects.toThrow(/cannot read/);
  });
});
