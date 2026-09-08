export type EncodedValue = null | boolean | string | number | { ref: number } | { scalar: "undefined" | "bigint" | "number"; value: string };
export type GraphNode =
  | { kind: "object"; nullPrototype: boolean; entries: [string, EncodedValue][] }
  | { kind: "array"; length: number; entries: [string, EncodedValue][] }
  | { kind: "map"; entries: [EncodedValue, EncodedValue][] }
  | { kind: "set"; entries: EncodedValue[] }
  | { kind: "date"; value: string }
  | { kind: "bytes"; values: number[] };
export interface ValueGraph { format: 1; roots: Record<string, EncodedValue>; nodes: GraphNode[] }

/** Self-contained so the identical codec can run inside a Dynamic Worker. */
export function encodeGraph(roots: Record<string, unknown>): ValueGraph {
  const nodes: GraphNode[] = [];
  const seen = new Map<object, number>();
  const fail = (path: string, what: string): never => {
    throw new Error(`[UNSUPPORTED_VALUE] Cannot retain ${path}: ${what}. Store plain data, bytes, or a durable handle instead.`);
  };
  const visit = (value: unknown, path: string): EncodedValue => {
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "undefined") return { scalar: "undefined", value: "" };
    if (typeof value === "bigint") return { scalar: "bigint", value: String(value) };
    if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0) ? value : { scalar: "number", value: Object.is(value, -0) ? "-0" : String(value) };
    if (typeof value !== "object") return fail(path, typeof value);
    const existing = seen.get(value);
    if (existing !== undefined) return { ref: existing };
    const id = nodes.length;
    seen.set(value, id);
    nodes.push({ kind: "object", nullPrototype: false, entries: [] });
    let node: GraphNode;
    if (value instanceof Uint8Array) node = { kind: "bytes", values: Array.from(value) };
    else if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) return fail(path, "invalid Date");
      node = { kind: "date", value: value.toISOString() };
    } else if (value instanceof Map) node = { kind: "map", entries: Array.from(value, ([k, v], i) => [visit(k, `${path}.key[${i}]`), visit(v, `${path}.value[${i}]`)]) };
    else if (value instanceof Set) node = { kind: "set", entries: Array.from(value, (v, i) => visit(v, `${path}[${i}]`)) };
    else {
      const proto = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return fail(path, proto?.constructor?.name ?? "class instance");
      const entries: [string, EncodedValue][] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") return fail(path, "symbol property");
        if (Array.isArray(value) && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) return fail(`${path}.${key}`, "accessor property");
        entries.push([key, visit(descriptor.value, `${path}.${key}`)]);
      }
      node = Array.isArray(value) ? { kind: "array", length: value.length, entries } : { kind: "object", nullPrototype: proto === null, entries };
    }
    nodes[id] = node;
    return { ref: id };
  };
  const encoded: Record<string, EncodedValue> = {};
  for (const [name, value] of Object.entries(roots)) Object.defineProperty(encoded, name, { value: visit(value, name), enumerable: true, writable: true, configurable: true });
  return { format: 1, roots: encoded, nodes };
}

/** Restores aliasing and cycles across bindings, including map/set references. */
export function decodeGraph(graph: ValueGraph): Record<string, unknown> {
  if (graph.format !== 1 || !Array.isArray(graph.nodes)) throw new Error("[UNSUPPORTED_VALUE] Unsupported workspace graph version.");
  const values: unknown[] = graph.nodes.map(node => {
    switch (node.kind) {
      case "array": return new Array(node.length);
      case "object": return node.nullPrototype ? Object.create(null) : {};
      case "map": return new Map();
      case "set": return new Set();
      case "date": return new Date(node.value);
      case "bytes": return new Uint8Array(node.values);
    }
  });
  const read = (value: EncodedValue): unknown => {
    if (value === null || typeof value !== "object") return value;
    if ("ref" in value) {
      if (!Number.isInteger(value.ref) || value.ref < 0 || value.ref >= values.length) throw new Error("[UNSUPPORTED_VALUE] Invalid graph reference.");
      return values[value.ref];
    }
    switch (value.scalar) {
      case "undefined": return undefined;
      case "bigint": return BigInt(value.value);
      case "number": return value.value === "-0" ? -0 : Number(value.value);
    }
  };
  graph.nodes.forEach((node, i) => {
    if (node.kind === "object" || node.kind === "array") {
      for (const [key, value] of node.entries) Object.defineProperty(values[i], key, { value: read(value), enumerable: true, writable: true, configurable: true });
    } else if (node.kind === "map") {
      for (const [key, value] of node.entries) (values[i] as Map<unknown, unknown>).set(read(key), read(value));
    } else if (node.kind === "set") {
      for (const value of node.entries) (values[i] as Set<unknown>).add(read(value));
    }
  });
  return Object.fromEntries(Object.entries(graph.roots).map(([key, value]) => [key, read(value)]));
}

export const emptyGraph = (): ValueGraph => ({ format: 1, roots: {}, nodes: [] });
