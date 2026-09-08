# Synthetic comparison

The newer [sequential tool and recovery study](sequential-tool-study.md) tests
generated executable capabilities, sequential corrections, held-out cases and actor
interruption. It uses GEPA's built-in reflective proposer. Start there for the current
comparison; the original configuration study below is retained for provenance.

This experiment compares learning disabled, the durable-harness learning pipeline,
and stock Cloudflare Codemode/Shell filesystem execution with GEPA 0.1.4 selection.
It uses the same model, bounded candidate generator, corrections, evaluation logic,
and separate adaptation/validation/held-out scenario families.

It is one small configuration task. It cannot establish general superiority, measure
human integration effort, or establish production readiness. The final report records
these limits and preserves inconclusive results.

```sh
npm run setup -- --benchmarks --deployed
npx wrangler deploy --config apps/benchmarks/wrangler.jsonc \
  --secrets-file apps/benchmarks/.dev.vars.deployed
python3 -m venv .wrangler/gepa-env
.wrangler/gepa-env/bin/python -m pip install gepa==0.1.4
.wrangler/gepa-env/bin/python benchmarks/compare_learning.py \
  https://your-benchmark.account.workers.dev
```

Use Python 3.10–3.14. Each method has a 120-second wall-time limit and at most 40
requests. Model work also has an eight-step, 48,000-token root budget and at most
three candidate attempts. Operator secrets stay in ignored deployment files.
Results are written under `.wrangler/proofs` and should be summarized with their
model, package versions, dataset limitations, and observed costs/latencies.
