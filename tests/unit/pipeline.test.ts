import { expect, it } from "vitest";
import {
  Learning,
  LearningPipeline,
  RunBudgets,
  type CandidateGenerator,
  type LearningTarget,
} from "@durable-harness/core";
import { buyerA, database, dev } from "./store.js";

function setup(kind: LearningTarget["kind"] = "instruction") {
  const { store, close } = database();
  const target: LearningTarget = {
    name: "preferences",
    kind,
    validate: () => {},
    cases: [
      { id: "adapt", family: "adapt", split: "adaptation", input: 1, expected: true },
      {
        id: "validate",
        family: "validate",
        split: "validation",
        input: 2,
        expected: true,
        critical: true,
      },
      {
        id: "sealed-answer",
        family: "sealed",
        split: "heldout",
        input: "never supplied to proposer",
        expected: true,
      },
    ],
    evaluator: {
      id: "check-v1",
      evaluate: async ({ configuration, testCase }) => ({
        caseId: testCase.id,
        passed: configuration === true,
        score: Number(configuration === true),
        explanation: "Configuration must enable this preference.",
      }),
    },
  };
  const learning = new Learning(store, [target]);
  learning.initialize(dev, "a", target.name, false);
  learning.feedback(buyerA, {
    id: "feedback",
    workspaceId: "a",
    agent: "quoting",
    kind: "correction",
    text: "Include freight",
    sourceRunId: "source",
    lineage: [],
  });
  return { store, close, learning };
}
it("refines within three attempts and never supplies held-out answers to a proposer", async () => {
  const { store, close, learning } = setup();
  let attempts = 0;
  const generator: CandidateGenerator = {
    id: "test-v1",
    origin: "developer",
    reserveTokens: () => 100,
    generate: async (context) => {
      expect(JSON.stringify(context)).not.toContain("sealed-answer");
      expect(context.adaptationCases.map((item) => item.id)).toEqual(["adapt"]);
      return {
        candidate: ++attempts === 2,
        rationale: "Include freight in the comparison",
        usedTokens: 50,
      };
    },
  };
  const pipeline = new LearningPipeline(store, learning, generator);
  const run = pipeline.start(buyerA, {
    workspaceId: "a",
    target: "preferences",
    evidenceIds: ["feedback"],
  });
  const result = await pipeline.advance(buyerA, run.id);
  expect(result.status).toBe("promoted");
  expect(result.attempts).toBe(2);
  expect(result.proposalIds).toHaveLength(2);
  expect(new RunBudgets(store).read(run.rootId).usedTokens).toBe(100);
  expect(learning.configuration(buyerA, "a", "preferences")?.value).toBe(true);
  close();
});
it("stops after three failed candidates and retains each independent proposal", async () => {
  const { store, close, learning } = setup();
  const generator: CandidateGenerator = {
    id: "unchanged-v1",
    origin: "developer",
    reserveTokens: () => 0,
    generate: async () => ({ candidate: false, rationale: "No improvement", usedTokens: 0 }),
  };
  const pipeline = new LearningPipeline(store, learning, generator);
  const run = pipeline.start(buyerA, {
    workspaceId: "a",
    target: "preferences",
    evidenceIds: ["feedback"],
  });
  const result = await pipeline.advance(buyerA, run.id);
  expect(result.status).toBe("exhausted");
  expect(result.proposalIds).toHaveLength(3);
  expect(learning.configuration(buyerA, "a", "preferences")?.revision).toBe(1);
  close();
});
it("waits for executable-change review and resumes after the authorized promotion", async () => {
  const { store, close, learning } = setup("capability");
  const generator: CandidateGenerator = {
    id: "capability-v1",
    origin: "developer",
    reserveTokens: () => 0,
    generate: async () => ({
      candidate: true,
      rationale: "Use the corrected procedure",
      usedTokens: 0,
    }),
  };
  const pipeline = new LearningPipeline(store, learning, generator);
  const run = pipeline.start(buyerA, {
    workspaceId: "a",
    target: "preferences",
    evidenceIds: ["feedback"],
  });
  const awaiting = await pipeline.advance(buyerA, run.id);
  expect(awaiting.status).toBe("awaiting_review");
  expect(new RunBudgets(store).read(run.rootId).status).toBe("paused");
  await learning.promote(dev, awaiting.currentProposalId!, true);
  const restored = new LearningPipeline(store, learning, generator);
  expect((await restored.advance(buyerA, run.id)).status).toBe("promoted");
  close();
});
it("counts an interrupted generator attempt and preserves unknown usage before resuming", async () => {
  const { store, close, learning } = setup();
  let calls = 0;
  const generator: CandidateGenerator = {
    id: "interrupted-v1",
    origin: "developer",
    reserveTokens: () => 100,
    generate: async () => {
      if (++calls === 1) throw new Error("Interrupted inference");
      return { candidate: true, rationale: "Recovered candidate", usedTokens: 50 };
    },
  };
  const pipeline = new LearningPipeline(store, learning, generator);
  const run = pipeline.start(buyerA, {
    workspaceId: "a",
    target: "preferences",
    evidenceIds: ["feedback"],
  });
  await expect(pipeline.advance(buyerA, run.id)).rejects.toThrow("Interrupted inference");
  const restored = new LearningPipeline(store, learning, generator);
  expect((await restored.advance(buyerA, run.id)).attempts).toBe(2);
  expect(new RunBudgets(store).read(run.rootId).reservedTokens).toBe(100);
  close();
});

it("retains known model usage when parsing the generated candidate subsequently fails", async () => {
  const { store, close, learning } = setup();
  const generator: CandidateGenerator = {
    id: "known-receipt",
    origin: "model_generated",
    reserveTokens: () => 100,
    generate: async (_context, execution) => {
      execution.reportUsage?.(50);
      throw new Error("The generated source edit was ambiguous");
    },
  };
  const pipeline = new LearningPipeline(store, learning, generator);
  const run = pipeline.start(buyerA, {
    workspaceId: "a",
    target: "preferences",
    evidenceIds: ["feedback"],
  });
  await expect(pipeline.advance(buyerA, run.id)).rejects.toThrow("ambiguous");
  expect(new RunBudgets(store).read(run.rootId)).toMatchObject({
    usedTokens: 50,
    reservedTokens: 0,
  });
  expect(learning.configuration(buyerA, "a", "preferences")?.value).toBe(false);
  close();
});
