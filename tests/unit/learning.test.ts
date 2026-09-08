import { afterEach, describe, expect, it } from "vitest";
import { Learning, invariant, type LearningTarget } from "@durable-harness/core";
import { buyerA, database, dev } from "./store.js";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

function setup(kind: LearningTarget["kind"] = "instruction") {
  const { store, close } = database();
  cleanup.push(close);
  const target: LearningTarget = {
    name: "quote-normalization",
    kind,
    validate(value) {
      invariant(
        value === "unit" || value === "line",
        "INVALID_INPUT",
        "Choose a supported comparison basis.",
      );
    },
    cases: [
      {
        id: "case-price",
        family: "case-pack",
        split: "validation",
        input: { price: 120, quantity: 12 },
        expected: 10,
        critical: true,
      },
      {
        id: "single-unit",
        family: "unit-pack",
        split: "validation",
        input: { price: 19, quantity: 1 },
        expected: 19,
        critical: true,
      },
      {
        id: "unseen",
        family: "sealed-pack",
        split: "heldout",
        input: { price: 84, quantity: 4 },
        expected: 21,
        critical: true,
      },
    ],
    evaluator: {
      id: "price-per-unit-v1",
      async evaluate({ configuration, testCase }) {
        const input = testCase.input as { price: number; quantity: number };
        const actual = configuration === "unit" ? input.price / input.quantity : input.price;
        const passed = actual === testCase.expected;
        return {
          caseId: testCase.id,
          passed,
          score: Number(passed),
          explanation: `${actual} per unit; expected ${testCase.expected}`,
        };
      },
    },
  };
  const learning = new Learning(store, [target]);
  learning.initialize(dev, "a", target.name, "line");
  learning.feedback(buyerA, {
    id: "correction-1",
    workspaceId: "a",
    agent: "quoting",
    kind: "correction",
    text: "Compare the price per unit",
    sourceRunId: "run-1",
    lineage: [],
  });
  const proposal = learning.propose(buyerA, {
    workspaceId: "a",
    kind,
    target: target.name,
    baseRevision: 1,
    candidate: "unit",
    rationale: "The original comparison ignored case quantities",
    evidenceIds: ["correction-1"],
    lineage: [],
    origin: "customer_correction",
  });
  return { learning, proposal, store, target };
}

describe("measured configuration promotion", () => {
  it("resumes an interrupted evaluation without repeating settled case scores", async () => {
    const { learning, proposal, store, target } = setup();
    const evaluate = target.evaluator.evaluate;
    let calls = 0;
    target.evaluator.evaluate = async (input) => {
      if (++calls === 2) throw new Error("Evaluator temporarily unavailable");
      return evaluate(input);
    };
    await expect(learning.evaluate(buyerA, proposal.id)).rejects.toThrow("temporarily");
    // This is the persisted status an evicted evaluator can leave behind.
    store.put("proposals", proposal.id, {
      ...learning.read(buyerA, proposal.id),
      status: "evaluating",
    });
    const restored = new Learning(store, [target]);
    const report = await restored.evaluate(buyerA, proposal.id);
    expect(report.eligible).toBe(true);
    expect(calls).toBe(5); // Four distinct scores, plus the interrupted attempt.
  });
  it("preserves source restrictions when a derived candidate becomes active configuration", async () => {
    const { learning, proposal } = setup();
    const derived = learning.propose(dev, {
      ...proposal,
      lineage: [{ spaceId: "b", itemId: "private-evidence" }],
    });
    await learning.evaluate(dev, derived.id);
    await learning.promote(dev, derived.id);
    expect(() => learning.configuration(buyerA, "a", proposal.target)).toThrow("read");
    expect(learning.configuration(dev, "a", proposal.target)?.value).toBe("unit");
  });
  it("evaluates the exact candidate, excludes heldout cases, and promotes an improvement", async () => {
    const { learning, proposal } = setup();
    await expect(learning.promote(buyerA, proposal.id)).rejects.toThrow(/exact candidate/);
    const report = await learning.evaluate(buyerA, proposal.id);
    expect(report.caseIds).toEqual(["case-price", "single-unit"]);
    expect(report.baseline.map((score) => score.passed)).toEqual([false, true]);
    expect(report.candidate.every((score) => score.passed)).toBe(true);
    expect((await learning.promote(buyerA, proposal.id)).revision).toBe(2);
    expect(learning.rollback(dev, "a", proposal.target, 1).value).toBe("line");
    expect(learning.configuration(buyerA, "a", proposal.target)?.revision).toBe(3);
  });
  it("requires developer review for executable capabilities", async () => {
    const { learning, proposal } = setup("capability");
    await learning.evaluate(buyerA, proposal.id);
    await expect(learning.promote(buyerA, proposal.id, true)).rejects.toThrow(/reviewer/);
    expect((await learning.promote(dev, proposal.id, true)).value).toBe("unit");
  });
  it("invalidates evaluated authority when the evaluator version changes", async () => {
    const { learning, proposal, target } = setup();
    const previous = await learning.evaluate(buyerA, proposal.id);
    target.evaluator.id = "price-per-unit-v2";
    await expect(learning.promote(buyerA, proposal.id)).rejects.toThrow("exact candidate");
    const next = await learning.evaluate(buyerA, proposal.id);
    expect(next.id).not.toBe(previous.id);
    expect(next.evaluatorId).toBe("price-per-unit-v2");
    expect((await learning.promote(buyerA, proposal.id)).revision).toBe(2);
  });
  it("refuses stale candidates after another proposal changes the target", async () => {
    const { learning, proposal } = setup();
    const other = learning.propose(buyerA, { ...proposal, candidate: "unit" });
    await learning.evaluate(buyerA, proposal.id);
    await learning.evaluate(buyerA, other.id);
    await learning.promote(buyerA, proposal.id);
    await expect(learning.promote(buyerA, other.id)).rejects.toThrow(/target changed/);
  });
});
