import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { WorkspaceTestHost } from "./worker.js";

type Host = DurableObjectStub & Pick<WorkspaceTestHost, "run" | "capability">;
const host = () =>
  (env as unknown as { WORKSPACES: DurableObjectNamespace }).WORKSPACES.getByName(
    crypto.randomUUID(),
  ) as Host;
it("reviews a helper independently from publication and excludes private working data", async () => {
  const workspace = host();
  await workspace.run(
    'const privateNote = "private-customer-note"; function double(value: number) { return value * 2; }',
  );
  const proposed = await workspace.capability("propose");
  if (!proposed.ok || !proposed.value) throw new Error(JSON.stringify(proposed));
  const id = proposed.value.id;
  expect((await workspace.capability("publish", id)).ok).toBe(false);
  expect((await workspace.capability("approve", id)).ok).toBe(false);
  expect((await workspace.capability("other-read", id)).ok).toBe(false);
  const evaluated = await workspace.capability("evaluate", id);
  expect(evaluated.ok, JSON.stringify(evaluated)).toBe(true);
  expect((await workspace.capability("customer-approve", id)).ok).toBe(false);
  expect((await workspace.capability("approve", id)).ok).toBe(true);
  const shared = await workspace.capability("publish", id);
  if (!shared.ok || !shared.value) throw new Error(JSON.stringify(shared));
  expect(shared.value.id).not.toBe(id);
  expect(JSON.stringify(shared.value)).not.toContain("private-customer-note");
  expect((await workspace.capability("other-read", shared.value.id)).ok).toBe(true);
  await evictDurableObject(workspace);
  const reused = await workspace.run(
    'const verified = await tools.call("capability.library.double.v1", {value:9});',
  );
  expect(reused.ok, JSON.stringify(reused)).toBe(true);
  if (reused.ok) expect(reused.values.verified).toBe(18);
});
it("rejects workspace I/O in a helper proposed as a shared pure capability", async () => {
  const workspace = host();
  await workspace.run('async function double(value) { return tools.call("offers", {}); }');
  const proposed = await workspace.capability("propose");
  expect(proposed.ok).toBe(false);
});
