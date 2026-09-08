import { z } from "zod";
import type { LanguageModel } from "ai";
import { invariant, type CandidateGenerator } from "@durable-harness/core";
import { modelCandidateGenerator } from "./proposals.js";

const editSchema = z
  .object({
    edits: z
      .array(
        z.object({ before: z.string().min(1).max(16000), after: z.string().max(16000) }).strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export type SourceEdit = z.infer<typeof editSchema>["edits"][number];

/** Apply ordered, exact replacements to a copy. A stale or ambiguous match fails closed. */
export function applySourceEdits(source: string, edits: SourceEdit[]): string {
  editSchema.parse({ edits });
  let result = source;
  for (const [index, edit] of edits.entries()) {
    const matches = result.split(edit.before).length - 1;
    invariant(
      matches === 1,
      "INVALID_TOOL_RESULT",
      `Source edit ${index + 1} matched ${matches} locations. Copy an exact, unique excerpt from the current source.`,
    );
    result = result.replace(edit.before, () => edit.after);
    invariant(
      result.length <= 16000,
      "INVALID_TOOL_RESULT",
      "The edited source exceeds 16,000 characters. Propose a smaller capability.",
    );
  }
  return result;
}

/** A smaller proposal representation. The pipeline still evaluates and reviews full source. */
export function modelCodeEditGenerator(
  model: () => LanguageModel,
  options: { id: string; instructions: string; maxOutputTokens?: number },
): CandidateGenerator {
  const proposer = modelCandidateGenerator(model, {
    ...options,
    candidateSchema: editSchema,
    instructions: `${options.instructions}\nThe baseline contains source code in baseline.source. Propose only the necessary exact text edits, not a complete replacement program. Each before excerpt must match exactly once in the current source; edits apply in order. Include enough surrounding text to make each match unique. Preserve unrelated behavior. The host will reconstruct and evaluate the complete candidate before any promotion.`,
  });
  return {
    ...proposer,
    async generate(context, execution) {
      const baseline = z
        .object({ source: z.string().max(16000) })
        .strict()
        .parse(context.baseline);
      const result = await proposer.generate(context, execution);
      const { edits } = editSchema.parse(result.candidate);
      return { ...result, candidate: { source: applySourceEdits(baseline.source, edits) } };
    },
  };
}
