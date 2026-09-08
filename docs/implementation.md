# Implementation ledger

## Established

- Public repository created before feature work: `btoo/durable-harness`.
- Initial scaffold pushed and read back at `425c35dfacfcfb34c2e0d51194cdf8b8208fa300`.
- Core code under development: graph codec, lexical cell compiler, versioned helper modules,
  SQLite record store, permissions, history, operation journal, and event log.
- Seven unit tests pass over graph values, real SQLite, publication policy, scoped FTS, and compaction.
- Seven real Workers runtime tests pass: eviction recovery, approval/resume, helper version pins,
  input validation, unsupported captures, revoked grants, and stream/history parity.

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
