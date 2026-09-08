import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { customer, type WorkspaceTestHost } from "./worker.js";

type TestHost = DurableObjectStub & Pick<WorkspaceTestHost, "run" | "inspect" | "actions" | "approve" | "counts" | "events" | "revoke" | "reconcile" | "changeToolVersion">;
const testEnv = env as unknown as { WORKSPACES: DurableObjectNamespace };
const host = () => testEnv.WORKSPACES.getByName(crypto.randomUUID()) as TestHost;

describe("code cells in real Dynamic Workers and Durable Object storage", () => {
  it("keeps uncertain writes unresolved until the provider reconciles them", async () => {
    const workspace = host();
    const id = crypto.randomUUID();
    const source = 'const receipt = await tools.call("uncertain", {});';
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await workspace.run(source, id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("EFFECT_UNCERTAIN");
      await evictDurableObject(workspace);
    }
    expect((await workspace.counts()).sends).toBe(1);
    await workspace.reconcile();
    const resolved = await workspace.run(source, id);
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
    if (resolved.ok) expect(resolved.values.receipt).toEqual({ delivery: "verified" });
    expect((await workspace.counts()).sends).toBe(1);
  });
  it("stops replay when a pinned tool implementation changed", async () => {
    const workspace = host();
    const id = crypto.randomUUID();
    const source = 'const offers = await tools.call("offers", {}); const sent = await tools.call("send", {to:"test@example.test"});';
    await workspace.run(source, id);
    await workspace.approve(`${id}:2`);
    await workspace.changeToolVersion();
    await evictDurableObject(workspace);
    const result = await workspace.run(source, id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("REPLAY_DIVERGENCE");
    expect(await workspace.counts()).toEqual({ offers: 1, sends: 0 });
  });
  it("uses memory and R2 artifact handles from a restored code cell", async () => {
    const workspace = host();
    const first = await workspace.run('const saved = await memory.write({title:"Delivery exception",kind:"preference",value:{day:"Tuesday"}}); const file = await artifacts.write({name:"supplier.txt",text:"Requested Tuesday delivery."});');
    expect(first.ok, JSON.stringify(first)).toBe(true);
    await evictDurableObject(workspace);
    const next = await workspace.run('const exception = await memory.read(saved.id); const excerpt = await artifacts.read(file.id, {offset:10,length:7});');
    expect(next.ok, JSON.stringify(next)).toBe(true);
    if (next.ok) { expect(next.values.exception).toMatchObject({value:{day:"Tuesday"}}); expect(next.values.excerpt).toMatchObject({text:"Tuesday"}); }
  });
  it("retains model-shaped data and helpers across eviction", async () => {
    const workspace = host();
    const first = await workspace.run('const offers = await tools.call("offers", {}); const evidence = { offers }; const alias = evidence; function cheapest(items: {price: number}[]) { return items.reduce((a, b) => a.price < b.price ? a : b); }');
    expect(first.ok, JSON.stringify(first)).toBe(true);
    await evictDurableObject(workspace);
    const next = await workspace.run('const best = cheapest(offers); const same = alias === evidence;');
    expect(next.ok, JSON.stringify(next)).toBe(true);
    if (next.ok) { expect(next.values.best).toEqual({ supplier: "B", price: 95 }); expect(next.values.same).toBe(true); expect(next.workspace.revision).toBe(2); }
    expect(await workspace.counts()).toEqual({ offers: 1, sends: 0 });
  });
  it("resumes an approval after eviction without repeating completed reads", async () => {
    const workspace = host();
    const id = crypto.randomUUID();
    const source = 'const offers = await tools.call("offers", {}); const delivery = await tools.call("send", {to: "buyer@example.test"});';
    const paused = await workspace.run(source, id);
    expect(paused.ok).toBe(false);
    if (!paused.ok) expect(paused.error.code).toBe("APPROVAL_REQUIRED");
    expect((await workspace.inspect()).revision).toBe(0);
    await evictDurableObject(workspace);
    await workspace.approve(`${id}:2`);
    const resumed = await workspace.run(source, id);
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    expect(await workspace.counts()).toEqual({ offers: 1, sends: 1 });
    await workspace.run(source, id);
    expect(await workspace.counts()).toEqual({ offers: 1, sends: 1 });
  });
  it("rejects captured mutable state and leaves the workspace unmodified", async () => {
    const workspace = host();
    const result = await workspace.run('const rate = 2; function normalize(price: number) { return price * rate; }');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_CAPTURE");
    expect((await workspace.inspect()).revision).toBe(0);
  });
  it("pins retained helper dependencies across later redefinitions", async () => {
    const workspace = host();
    expect((await workspace.run('function rate(n: number) { return n * 2; } function quote(n: number) { return rate(n); }')).ok).toBe(true);
    expect((await workspace.run('function rate(n: number) { return n * 3; }')).ok).toBe(true);
    await evictDurableObject(workspace);
    const result = await workspace.run('const existing = quote(10); const updated = rate(10);');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) { expect(result.values.existing).toBe(20); expect(result.values.updated).toBe(30); }
  });
  it("rejects invalid tool input before creating an effect", async () => {
    const workspace = host();
    const result = await workspace.run('const delivery = await tools.call("send", {to: 42});');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    expect((await workspace.counts()).sends).toBe(0);
  });
  it("checks revoked grants on a resumed request", async () => {
    const workspace = host();
    const id = crypto.randomUUID();
    const source = 'const delivery = await tools.call("send", {to: "buyer@example.test"});';
    await workspace.run(source, id, customer);
    await workspace.revoke();
    await evictDurableObject(workspace);
    const result = await workspace.run(source, id, customer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ACCESS_DENIED");
    expect((await workspace.counts()).sends).toBe(0);
  });
  it("reconstructs audience-filtered events with stable cursors", async () => {
    const workspace = host();
    await workspace.run('const offers = await tools.call("offers", {}); await runtime.progress("Two supplier responses are available.");');
    const visible = await workspace.events(customer);
    expect(visible.some(event => event.kind === "cell.started")).toBe(false);
    expect(visible.some(event => event.text === "Two supplier responses are available.")).toBe(true);
    const cursor = visible.at(-1)!.sequence;
    await evictDurableObject(workspace);
    expect(await workspace.events(customer)).toEqual(visible);
    expect(await workspace.events(customer, cursor)).toEqual([]);
  });
});
