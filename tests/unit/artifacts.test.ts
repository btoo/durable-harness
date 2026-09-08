import { expect, it } from "vitest";
import { AccessPolicy, Artifacts, type ArtifactBackend } from "@durable-harness/core";
import { buyerA, buyerB, database, dev } from "./store.js";

it("retains binary artifacts and byte ranges without exposing private handles", async () => {
  const { store } = database();
  const blobs = new Map<string, Uint8Array>();
  const backend: ArtifactBackend = { put: async (key, value) => { blobs.set(key, value); }, get: async (key, offset, length) => blobs.get(key)!.slice(offset, offset + length) };
  const artifacts = new Artifacts(store, backend);
  const input = { spaceId: "a", name: "parts.bin", bytes: new Uint8Array([0, 255, 42, 10]) };
  const handle = await artifacts.write(buyerA, input, [{ spaceId: "a", itemId: "source" }], "operation-1");
  expect(await artifacts.write(buyerA, input, [], "operation-1")).toEqual(handle);
  expect(blobs.size).toBe(1);
  expect((await new Artifacts(store, backend).read(buyerA, handle.id, { offset: 1, length: 2 })).bytes).toEqual(new Uint8Array([255, 42]));
  await expect(artifacts.read(buyerB, handle.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(artifacts.write(buyerA, { ...input, name: "different" }, [], "operation-1")).rejects.toMatchObject({ code: "REPLAY_DIVERGENCE" });
});

it("rechecks revocation after blob upload before publishing its handle", async () => {
  const { store } = database();
  const artifacts = new Artifacts(store, { put: async () => { new AccessPolicy(store).setGrants(dev, "a", [{ principalId: dev.id, permissions: ["read", "write", "execute", "publish"] }], 1); }, get: async () => new Uint8Array() });
  await expect(artifacts.write(buyerA, { spaceId: "a", name: "quote.txt", text: "private" }, [], "upload")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(store.list("artifacts")).toEqual([]);
});
