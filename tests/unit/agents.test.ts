import { expect, it } from "vitest";
import {
  AccessPolicy,
  AgentRegistry,
  Memory,
  RunBudgets,
  decodeGraph,
} from "@durable-harness/core";
import { database, dev, buyerB } from "./store.js";

it("narrows child authority, persists mail/results, and enforces live parent revocation", () => {
  const { store, close } = database();
  const budgets = new RunBudgets(store);
  budgets.start("root");
  const registry = new AgentRegistry(store);
  registry.create(dev, {
    id: "root",
    name: "Coordinator",
    rootId: "root",
    workspaceId: "a",
    scopes: [{ spaceId: "a", permissions: ["read", "write", "execute"] }],
  });
  const parent = registry.principal(dev, "root");
  expect(() =>
    registry.create(parent, {
      id: "b-child",
      name: "Unapproved customer",
      rootId: "root",
      workspaceId: "b",
      scopes: [{ spaceId: "b", permissions: ["read"] }],
    }),
  ).toThrow();
  const child = registry.create(parent, {
    id: "supplier",
    name: "Supplier check",
    rootId: "root",
    workspaceId: "a",
    scopes: [{ spaceId: "a", permissions: ["read"] }],
  });
  const identity = registry.principal(parent, child.id);
  expect(() =>
    new Memory(store).write(
      identity,
      { spaceId: "a", title: "Unauthorized edit", kind: "fact", value: 1 },
      [],
    ),
  ).toThrow("write");
  const message = {
    id: "assignment",
    value: { part: "A-1" },
    lineage: [{ spaceId: "a", itemId: "quote-1" }],
  };
  registry.send(parent, child.id, message);
  registry.send(parent, child.id, message);
  const restored = new AgentRegistry(store);
  expect(restored.inbox(identity)).toHaveLength(1);
  expect(decodeGraph(restored.inbox(identity)[0]!.value).value).toEqual({ part: "A-1" });
  restored.complete(identity, { verified: true }, message.lineage);
  expect(restored.inbox(identity)[0]!.status).toBe("acknowledged");
  expect(() => restored.complete(identity, { verified: false }, message.lineage)).toThrow(
    "immutable",
  );
  expect(() => restored.read(buyerB, child.id)).toThrow("accessible");
  expect(budgets.read("root").descendants).toBe(1);
  restored.revoke(dev, "root");
  expect(new AccessPolicy(store).permits(identity, "a", "read")).toBe(false);
  expect(() => restored.inbox(identity)).toThrow();
  close();
});
it("rechecks the original owner's grants for a cached child identity and rejects forged identity pairs", () => {
  const { store, close } = database();
  new RunBudgets(store).start("root");
  const registry = new AgentRegistry(store);
  registry.create(dev, {
    id: "root",
    name: "Root",
    rootId: "root",
    workspaceId: "a",
    scopes: [{ spaceId: "a", permissions: ["read"] }],
  });
  const principal = registry.principal(dev, "root");
  const access = new AccessPolicy(store);
  expect(access.permits({ ...principal, id: "forged" }, "a", "read")).toBe(false);
  access.setGrants(dev, "a", [], 1);
  expect(access.permits(principal, "a", "read")).toBe(false);
  close();
});
it("keeps combined findings in an operator space and delivers tenant-specific work only from permitted sources", () => {
  const { store, close } = database();
  store.put("spaces", "operator", {
    id: "operator",
    deploymentId: "demo",
    label: "Operator",
    kind: "session",
    revision: 1,
    grants: [{ principalId: dev.id, permissions: ["read", "write", "execute", "publish"] }],
  });
  new RunBudgets(store).start("coordination");
  const registry = new AgentRegistry(store);
  registry.create(dev, {
    id: "coordination",
    rootId: "coordination",
    workspaceId: "operator",
    name: "Selected-customer review",
    scopes: [
      { spaceId: "operator", permissions: ["read", "write", "execute"] },
      { spaceId: "a", permissions: ["read", "execute"] },
      { spaceId: "b", permissions: ["read", "execute"] },
    ],
  });
  const parent = registry.principal(dev, "coordination");
  expect(new AccessPolicy(store).permits(parent, "shared", "read")).toBe(false);
  registry.create(parent, {
    id: "a-review",
    rootId: "coordination",
    workspaceId: "a",
    name: "Customer A review",
    scopes: [{ spaceId: "a", permissions: ["read"] }],
  });
  expect(() =>
    registry.send(parent, "a-review", {
      id: "mixed",
      value: "Combined findings",
      lineage: [
        { spaceId: "a", itemId: "a-input" },
        { spaceId: "b", itemId: "b-input" },
      ],
    }),
  ).toThrow("read");
  registry.send(parent, "a-review", {
    id: "permitted",
    value: "A-only findings",
    lineage: [{ spaceId: "a", itemId: "a-input" }],
  });
  registry.complete(parent, { summary: "Combined operator findings" }, []);
  expect(() => registry.read(buyerB, "coordination")).toThrow("accessible");
  close();
});
