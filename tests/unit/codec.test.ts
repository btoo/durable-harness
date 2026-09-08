import { describe, expect, it } from "vitest";
import { decodeGraph, encodeGraph } from "@durable-harness/core";

describe("durable graph values", () => {
  it("preserves aliases, cycles, collection keys, sparse arrays, bytes, and scalars", () => {
    const offer = { price: 120, owner: undefined as unknown };
    offer.owner = offer;
    const sparse = new Array(3); sparse[2] = offer;
    const restored = decodeGraph(encodeGraph({ offer, alias: offer, sparse, map: new Map([[offer, 5n]]), set: new Set([offer]), bytes: new Uint8Array([0, 255]), date: new Date("2026-01-01"), undef: undefined, infinity: Infinity, negativeZero: -0 }));
    expect(restored.offer).toBe(restored.alias);
    expect((restored.offer as typeof offer).owner).toBe(restored.offer);
    expect((restored.sparse as unknown[])[2]).toBe(restored.offer);
    expect(0 in (restored.sparse as unknown[])).toBe(false);
    expect((restored.map as Map<unknown, unknown>).get(restored.offer)).toBe(5n);
    expect((restored.set as Set<unknown>).has(restored.offer)).toBe(true);
    expect(restored.bytes).toEqual(new Uint8Array([0, 255]));
    expect(restored.date).toEqual(new Date("2026-01-01"));
    expect(restored.undef).toBeUndefined();
    expect(restored.infinity).toBe(Infinity);
    expect(Object.is(restored.negativeZero, -0)).toBe(true);
  });
  it("rejects functions, accessors, promises, and arbitrary instances with a path", () => {
    for (const value of [() => {}, Promise.resolve(1), new URL("https://example.com"), { get privateValue() { throw new Error("must not execute"); } }]) {
      expect(() => encodeGraph({ unsupported: value })).toThrow(/UNSUPPORTED_VALUE.*unsupported/);
    }
  });
  it("preserves a __proto__ data property without changing prototypes", () => {
    const value = JSON.parse('{"__proto__":{"secret":true}}');
    const restored = decodeGraph(encodeGraph({ value })).value as object;
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
    expect(Object.hasOwn(restored, "__proto__")).toBe(true);
    expect(({} as { secret?: boolean }).secret).toBeUndefined();
  });
});
