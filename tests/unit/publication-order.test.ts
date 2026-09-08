import { expect, it } from "vitest";
import { EventLog } from "@durable-harness/core";
import { database, buyerA } from "./store.js";

it("publishes events only after the outer transaction commits", () => {
  const { store, close } = database();
  const delivered: unknown[] = [];
  const events = new EventLog(store, (event) => delivered.push(event));
  const event = {
    workspaceId: "a",
    kind: "message.delta",
    audience: "customer" as const,
    text: "Saved progress",
    data: {},
    lineage: [],
  };
  expect(() =>
    store.transaction(() => {
      events.append(event);
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  expect(delivered).toEqual([]);
  expect(events.read(buyerA, "a")).toEqual([]);
  store.transaction(() => {
    events.append(event);
    expect(delivered).toEqual([]);
  });
  expect(delivered).toEqual(events.read(buyerA, "a"));
  close();
});
