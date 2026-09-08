import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { WorkspaceTestHost } from "./worker.js";
it("executes the public quickstart recipe against SQLite, WorkerLoader and R2", async () => {
  const host = (env as unknown as { WORKSPACES: DurableObjectNamespace }).WORKSPACES.getByName(
    crypto.randomUUID(),
  ) as DurableObjectStub & Pick<WorkspaceTestHost, "documentationExample">;
  const result = await host.documentationExample();
  expect(result.revision).toBe(2);
  expect(result.values.selected).toEqual({ supplier: "Brookfield", price: 95 });
  expect(result.values.remembered).toMatchObject({ value: { day: "Tuesday" } });
  expect(result.values.excerpt).toMatchObject({ text: "Synthetic supplier evidence" });
});
