# Initial experimental results

These results establish several implemented contracts. They do not establish general
superiority or production readiness. All public experiments used synthetic business data.

## Sequential tool and recovery study — September 8

The [protocol](../benchmarks/sequential-tool-study.md) and
[machine-readable results](../benchmarks/results/sequential-tool-2026-09-08.json) cover
generated JavaScript tools, rather than predeclared boolean preferences. Customer corrections
first require currency/freight normalization, then pack pricing and minimum-order handling.
The second stage retains the first stage's validation cases. Twelve held-out cases are
assessed only after the final candidate is frozen, without exposing their answers to proposers.

GEPA uses its real reflective mutation and selection with a supported code-oriented prompt
template. Both methods use GLM-5.3-Flash with default reasoning, three candidate attempts,
48,000 tokens and 120 seconds per stage, and explicit synthetic review for executable changes.

| Method            | Held-out trial 1 | Held-out trial 2 | Stages producing an approved improvement |
| ----------------- | ---------------- | ---------------- | ---------------------------------------- |
| Learning disabled | 3/12             | 3/12             | 0/4                                      |
| durable-harness   | 8/12             | 3/12             | 1/4                                      |
| Codemode + GEPA   | 8/12             | 3/12             | 1/4                                      |

Six of the eight model-driven stages timed out before a candidate became available. Both
methods retained their previously approved implementation. **No outcome advantage was
observed.** These runs expose a practical limitation of the chosen model/request format under
the fixed time budget; they do not isolate provider latency, reasoning time, or optimizer
quality as the cause. Unresolved token reservations are reported separately from known usage.

The first deployed recovery comparison uncovered a harness defect: production bundling
injected naming helpers into runtime functions serialized with `toString()`, so installation
failed with `__name is not defined`. The filesystem comparator passed. After generating
runtime text from canonical source before bundling, the exact deployed rerun passed all eight
cases: four used model-generated tools and four used unchanged-seed controls. Every case
performed one input read, one synthetic order and one reconciliation across actual actor
interruption and replay. The filesystem path includes application-authored checkpoints and
the same connector reconciliation support; **recovery rework also tied** on this scenario.

A separate, prebounded source-edit follow-up started from the first harness trial's approved
tool. In one step, 5,722 reported tokens and 74.9 seconds of active time, it produced an eligible
pack-pricing repair. Synthetic review promoted it; validation rose from 5/8 to 8/8 and held-out
assessment from 8/12 to 12/12. This demonstrates a successful additional improvement. It does
not establish that edit-based generation outperforms another full-source retry; keep the new
generator optional until a matched comparison supports that claim.
The repaired tool subsequently survived the same deployed interruption in both runtimes,
retaining the Brook recommendation at USD 76.80 and producing no duplicate order.

An earlier setup batch used GEPA's instruction-writing default template and produced prose;
it was stopped and excluded from optimizer comparisons. An immediate post-deploy request
also reached the preceding Worker version before the edit endpoint was available, without
executing a model step. Follow-up scripts now verify the requested deployment version.

The learning comparison used source `57be6be` and Worker
`c81857f3-57d1-4d6b-ad2a-b5795de2e043`. Corrected recovery and the edit follow-up used source
`677aa68` and Worker `937e2d0a-f04a-480c-96ad-4de843f49df5`.

These remain hand-authored synthetic scenarios with automated review and a synthetic provider
receipt table. They do not measure human integration/review effort, independent-provider
failures, or production outcomes. Keep optimization replaceable and focus further work on
reliable bounded proposals and integration effort before expanding the workspace architecture.

## Durable workspace

Kimi K2.7 Code invented a quote-analysis structure and a reusable helper in four steps
(17,281 reported tokens, 56.9 seconds). After compaction and an actual Durable Object
restart, GLM-5.3-Flash reused both, recovered the exact original customer correction,
recomputed a changed quote comparison, and preserved the original analysis. That continuation
used four steps, 22,004 reported tokens, and 91.0 seconds. The helper source hash was unchanged.

Earlier attempts failed or were inconclusive. They exposed mirrored provider deltas,
unsupported message roles, insufficient response allowance, overlarge context reservations,
and missing REPL output. Those outcomes remain documented in the implementation record.

## Learning comparison

The first comparison used GLM-5.3-Flash, the same bounded candidate generator, two synthetic
corrections, separate adaptation/validation/held-out scenario families, and the same
business evaluator. The filesystem path used actual `@cloudflare/codemode` 0.5.1 and
`@cloudflare/shell` 0.4.3. GEPA 0.1.4 ran its real selection/evaluation loop with a custom
proposer using that same generator.

| Method                     | Validation | Held-out | Model steps | Reported tokens | Wall time |
| -------------------------- | ---------- | -------- | ----------- | --------------- | --------- |
| Learning disabled          | 1/3        | 1/1      | 0           | 0               | 1.75 s    |
| durable-harness            | 3/3        | 1/1      | 1           | 1,601           | 21.55 s   |
| Codemode filesystem + GEPA | 3/3        | 1/1      | 1           | 1,532           | 24.08 s   |

**No quality advantage over the simpler learning baseline was observed.** The single
held-out case was passed by every method and therefore did not distinguish them. Timing
and token differences from one run are not evidence of a reliable advantage. No human
integration or review-effort study has been conducted.

The workspace contract may still improve integration and recovery ergonomics, but that
benefit remains to be measured against a filesystem implementation on representative tasks.
Do not use this toy configuration study to claim otherwise.

## Other deployed proofs

- A real-model preference proposal passed evaluation, promoted, and changed the next quoting
  decision while retaining approval and unrelated preferences: one step, 847 reported tokens,
  7.5 seconds.
- The remote HTTPS MCP fixture passed OAuth with PKCE, approved tool execution, actual runtime
  restart, unattended refresh, provider revocation, reconnection, and original-cell resumption.
- The model-generated helper passed three capability protocol checks and was shared as a new
  reviewed artifact. Cedar reused the code without inheriting Northstar's private preference.

The complete scripts live under `scripts/` and `benchmarks/`. Raw local experiment records
are excluded from source history. Private Didero observations are stored separately and
were not uploaded to the public demo or used in these model experiments.

The deployed learning comparison used Worker version `1bf38b9e-1e25-4a60-94fc-c46f3649dce7`.

## Context strategies

A second experiment placed a receiving exception before 300 synthetic history entries.
GLM-5.3-Flash answered the same question using three active-context strategies, with
identical access to the retained originals.

| Active-context strategy | Exact answer and citation | History searches | Reported tokens | Model wall time |
| ----------------------- | ------------------------- | ---------------- | --------------- | --------------- |
| Extractive checkpoint   | Passed                    | 1                | 5,623           | 10.26 s         |
| Generic summary         | Passed                    | 1                | 5,470           | 13.28 s         |
| Recent window           | Passed                    | 2                | 5,534           | 4.02 s          |

All originals remained available. One case per strategy does not establish a reliable
recall or latency ranking. These results support retaining searchable evidence; they do
not establish that one summary strategy is universally better.

The context comparison used Worker version `1ed18ae1-d7d3-453a-a9dd-d25590d36d3c`.
