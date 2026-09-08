import { expect, it } from "vitest";
import { SignalClusters, type FeedbackSignal } from "@durable-harness/core";
import { database, dev, buyerB } from "./store.js";
it("uses embeddings only for candidates and requires scoped source citations for membership", () => {
  const { store, close } = database();
  const clusters = new SignalClusters(store);
  const signal = (id: string, text: string): FeedbackSignal => ({
    id,
    workspaceId: "a",
    agent: "quoting",
    kind: "correction",
    text,
    sourceRunId: id,
    createdAt: "2026-09-08",
    lineage: [],
    embedding: [1, 0],
  });
  store.put("feedback", "one", signal("one", "Include freight"));
  store.put("feedback", "two", signal("two", "Use the current exchange rate"));
  expect(clusters.list(dev, "a").every((cluster) => !cluster.confirmed)).toBe(true);
  expect(clusters.candidates(dev, "two")[0]?.similarity).toBe(1);
  expect(() =>
    clusters.confirm(dev, {
      id: "group",
      signalIds: ["one", "two"],
      citations: ["one"],
      reason: "Related",
    }),
  ).toThrow("citation");
  expect(() =>
    clusters.confirm(buyerB, {
      id: "group",
      signalIds: ["one"],
      citations: ["one"],
      reason: "Related",
    }),
  ).toThrow("accessible");
  clusters.confirm(dev, {
    id: "group",
    signalIds: ["one"],
    citations: ["one"],
    reason: "Freight correction confirmed",
  });
  expect(clusters.list(dev, "a").find((cluster) => cluster.id === "two")?.confirmed).toBe(false);
  close();
});
