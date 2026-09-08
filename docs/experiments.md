# Initial experimental results

These results establish several implemented contracts. They do not establish general
superiority or production readiness. All public experiments used synthetic business data.

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
