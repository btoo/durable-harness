import { decodeGraph, type ValueGraph } from "./codec.js";

/** Prefer readable JSON for ordinary trees; retain the graph notation when it carries meaning. */
export function inspectGraph(
  graph: ValueGraph,
): { format: "json"; value: unknown } | { format: "graph"; value: ValueGraph } {
  const value = decodeGraph(graph).value;
  const seen = new Set<object>();
  const plain = (item: unknown): boolean => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item) && !Object.is(item, -0);
    if (typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) {
      const keys = Object.keys(item);
      return (
        keys.length === item.length &&
        keys.every((key, index) => key === String(index)) &&
        item.every(plain)
      );
    }
    return Object.getPrototypeOf(item) === Object.prototype && Object.values(item).every(plain);
  };
  return plain(value) ? { format: "json", value } : { format: "graph", value: graph };
}
