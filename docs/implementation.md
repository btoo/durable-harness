# Implementation ledger

## Established

- Public repository created before feature work: `btoo/durable-harness`.
- Initial scaffold pushed and read back at `425c35dfacfcfb34c2e0d51194cdf8b8208fa300`.
- Core code under development: graph codec, lexical cell compiler, versioned helper modules,
  SQLite record store, permissions, history, operation journal, and event log.
- Eighteen unit tests pass over graph values, real SQLite, publication policy, scoped FTS,
  compaction, evaluated learning, encrypted credentials, rotation/revocation, artifacts, and budgets.
- Sixteen real Workers runtime tests pass: eviction recovery, approval/resume, helper version pins,
  input validation, unsupported captures, revoked grants, stream/history parity, uncertain
  effects, replay divergence, retained memory/R2 artifact handles, HTTP role enforcement,
  customer correction impact, approval delivery, and WebSocket/history parity.
- Workers Paid and R2 activation are confirmed in the Cloudflare dashboard. Wrangler is authenticated.
- Private bucket `durable-harness-artifacts` created for the experiment.
- React/Vite customer and developer reference UI runs against actual harness APIs.
- Browser proof: a tested PO correction moved a Sunday follow-up to Monday on the next run;
  approval/resume and saved activity survived reload; retained helper `nextFollowup` is inspectable.
- Think integration now passes a controlled-provider test through tool dispatch, cell commit,
  streamed text, history persistence, and budget accounting. RPC disposal symbols are detached
  before entering the model's JSON tool output.

## Deployed experiment

- URL: https://durable-harness-demo.btjk138.workers.dev
- Verified source revision: `e8033f2`; Cloudflare version `258f7433-f6bb-4b4d-9013-1af96f7c9b80`.
- Deployed checks passed for PO/quoting correction impact, cross-tenant denial, approval replay,
  retained bindings/helpers, and the browser's live subscription.
- First real-model attempt: eight steps, 15,810 reported tokens, 27.2 seconds active execution.
  It produced no new cells and **did not prove** the generation contract. A subsequent local
  controlled-provider test exposed and fixed RPC metadata contaminating model tool output.
- Further real-model and recovery verification is in progress. There is no comparative
  effectiveness result yet.

## Current verification

The real-runtime cell suite passed using Cloudflare's local Workers test pool,
actual SQLite Durable Objects, a WorkerLoader sandbox, and forced object eviction.
An RPC serialization failure was reproduced and fixed: graph envelopes use plain
objects while the graph codec explicitly retains null prototypes as data.

The runtime compatibility date is pinned to `2026-08-22`, supported by the test
pool's bundled workerd. The cell compiler uses Babel lexical scope analysis and
Sucrase TypeScript erasure, avoiding a full TypeScript compiler in the worker.

## Remaining milestones

1. Pass durable-cell and recovery tests, including uncertain effects and permission revocation.
2. Add memory/publication, artifact storage, compaction, and scoped history retrieval.
3. Implement the Cloudflare application boundary, MCP lifecycle, and learning pipeline.
4. Build the synthetic PO and quoting reference application with customer/developer views.
5. Add CLI, read-only observation, comparative evaluations, and executable API documentation.
6. Verify the deployed experiment and record the real application with Recordly.

Production observation is read-only. No Didero changes or production actions are authorized.
Cloudflare project testing is authorized, including the required paid plan and bounded usage.
Payment information must never enter this repository, test fixtures, or demo artifacts.
