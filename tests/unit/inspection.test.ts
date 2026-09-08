import { expect, it } from "vitest";
import { encodeGraph, inspectGraph } from "@durable-harness/core";

it("shows ordinary data directly and preserves notation for reference relationships and special values", () => {
  const offers = { offers: [{ supplier: "Aster", price: 12.4 }] };
  expect(inspectGraph(encodeGraph({ value: offers }))).toEqual({ format: "json", value: offers });
  const shared = { price: 12 };
  const sparse = Object.assign(new Array(1), { note: "retained property" });
  for (const value of [
    { first: shared, second: shared },
    new Map([["price", 12]]),
    new Date("2026-01-01"),
    [undefined],
    -0,
    sparse,
  ]) {
    const graph = encodeGraph({ value });
    expect(inspectGraph(graph)).toEqual({ format: "graph", value: graph });
  }
});
