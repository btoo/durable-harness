# Sequential tool and recovery study

This protocol is fixed before deployed model execution. It replaces the boolean-only
learning comparison with generated executable source. It is still a small synthetic
study, not evidence of production readiness or reduced human engineering effort.

## Learning experiment

- Stage 1: customer feedback requires a missing currency/freight normalization capability.
- Stage 2: a supplier schema change adds pack pricing and minimum orders. Earlier currency,
  freight, customer-policy and approval behavior must survive the change.
- Both methods receive the same developer-owned API contract, natural-language corrections,
  adaptation cases and evaluator. No corrected configuration values are provided.
- The harness uses its resumable capability-proposal pipeline. GEPA 0.1.4 uses its built-in
  reflective proposer and selection loop, with actual execution diagnostics. A bounded
  callable supplies the configured Workers AI model; it does not replace GEPA's proposer.
- Each stage allows three candidates, 48,000 tokens and 120 seconds of active execution,
  with 8,192 output tokens per call and the model's default reasoning. Three repetitions
  rotate method order. The maximum aggregate model admission is 576,000 tokens.
- The stage-2 validation set retains all stage-1 validation cases. Every validation case
  is critical. Executable proposals require an explicit synthetic reviewer before use.
  This reviewer is automated and does not measure human approval quality or effort.
- Twelve held-out cases are assessed only after the final candidate is frozen. Assessment
  seals the run against further evaluation or generation and returns no inputs/answers.
- Families are hand-authored scenarios assigned once to a split. They are not independent
  customer populations; shared semantic rules make statistical generalization claims premature.

Report every run, including exhaustion and provider failures. Measure validation and
held-out outcomes, prior-case regressions, candidate attempts, reported tokens, active time,
wall time and review counts. Do not infer a meaningful latency difference from three runs.

## Recovery experiment

For each frozen model-generated tool, run the same code through both:

1. durable-harness cells and operation journal;
2. Codemode/Shell with application-authored draft/delivery checkpoints and stable provider keys.

Pause before approval, then interrupt the actual Durable Object after the synthetic provider
records an accepted order but before returning its result. Resume and replay once more.
Measure duplicate effects, repeated input reads, reconciliations and retained results.
The comparator receives the same connector reconciliation support. Both are expected to
avoid duplicates; a tie is useful evidence that a small filesystem wrapper can cover this case.

The fixture stores provider receipts in a separate table in the same actor's SQLite storage.
It verifies process-loss recovery, not failure of an independent provider or storage region.
The model does not participate in the recovery phase. This isolates runtime behavior but
does not measure autonomous recovery planning or developer integration time.

## Reproduce

```sh
npx vitest run tests/runtime/benchmark.test.ts
.wrangler/gepa314/bin/python -m unittest discover -s benchmarks -p 'test_*.py'
npx wrangler deploy --config apps/benchmarks/wrangler.jsonc \
  --secrets-file apps/benchmarks/.dev.vars.deployed
.wrangler/gepa314/bin/python benchmarks/compare_programs.py \
  https://your-benchmark.account.workers.dev --repetitions 3
.wrangler/gepa314/bin/python benchmarks/verify_program_recovery.py \
  https://your-benchmark.account.workers.dev .wrangler/proofs/program-comparison-TIMESTAMP.json
```

Use Python 3.10–3.14 with `gepa==0.1.4` in an isolated environment. Credentials and raw
recordings remain ignored. Model-generated code is evaluated in a Dynamic Worker without
outbound network, host tools, credentials or evaluator answers. Public reports contain only
synthetic fixtures and measured aggregates.
