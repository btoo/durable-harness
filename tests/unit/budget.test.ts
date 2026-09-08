import { expect, it } from "vitest";
import { RunBudgets } from "@durable-harness/core";
import { database } from "./store.js";

it("charges descendants to one root and excludes approval waits from active time", () => {
  const { store } = database();
  let now = 0;
  const budgets = new RunBudgets(store, () => now);
  budgets.start("root", { steps: 2, tokens: 100, activeMs: 1000, descendants: 1 });
  budgets.reserve("root", "first", 60);
  now = 100;
  budgets.pause("root");
  now = 10_000;
  budgets.resume("root");
  budgets.settle("root", "first", 40);
  budgets.addDescendant("root");
  budgets.reserve("root", "child-step", 60);
  expect(budgets.read("root").activeMs).toBe(100);
  expect(() => budgets.reserve("root", "third", 1)).toThrow("budget");
  expect(() => budgets.addDescendant("root")).toThrow("delegation budget");
  // An interrupted, unsettled request still consumes its reserved allowance after restart.
  expect(new RunBudgets(store).read("root").reservedTokens).toBe(60);
});
