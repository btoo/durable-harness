# Implementation ledger

## Established

- Public repository created before feature work: `btoo/durable-harness`.
- Initial scaffold pushed and read back at `425c35dfacfcfb34c2e0d51194cdf8b8208fa300`.
- Core code under development: graph codec, lexical cell compiler, versioned helper modules,
  SQLite record store, permissions, history, operation journal, and event log.
- Twenty-eight unit tests pass over graph values, real SQLite, publication policy, scoped FTS,
  compaction, evaluated learning, encrypted credentials, rotation/revocation, artifacts, and budgets.
- Eighteen real Workers runtime tests pass: eviction recovery, approval/resume, helper version pins,
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
- Second attempt: eight steps, 17,081 reported tokens, 29.0 seconds active execution.
  Its tool arguments contained doubled tokens and never reached the runtime. An actual-provider
  unit test reproduced the failure with mirrored native/OpenAI SSE fields. The compatibility
  adapter removes only exact mirrors within one event and preserves repeated text across events.
- Promoted configuration now retains proposal and baseline lineage; a cross-scope regression
  test verifies that promotion cannot disclose restricted evidence to another customer.
- Further real-model and recovery verification is in progress. There is no comparative
  effectiveness result yet.
- Kimi K2.7 Code completed the generation proof in four steps, 17,281 reported tokens,
  and 56.9 seconds. It created a quote-analysis structure and a reusable helper, corrected
  a rejected non-journaled timestamp, and committed the data and function. This is a
  single proof case, not a comparative benchmark.
- Default inference switched at the user's request to `@cf/zai-org/glm-5.3-flash`.
  Its published rates and the comparable proof limits are documented in the deployment guide.
- Local runtime proof now covers compaction, exact original lookup, actual actor abort,
  reconstruction through a fresh RPC stub, and reuse of retained data/functions.
- Publication waits for the outer transaction to commit. Automatic sharing no longer copies
  an unselected private title; operation diagnostics recheck acquired source restrictions.
- A bounded private CDC sample and prompt original were retained outside Git. Live HTTP
  collector verification and quoting observation coverage remain separate pending checks.
- The Cloudflare MCP client now passes local protocol and OAuth integration tests, including
  PKCE, encrypted credentials, refresh rotation after eviction, and reconstructed connections.
  An authentication preflight can pause safely; failure after dispatch retains write uncertainty.
- The first GLM attempt stopped at its 2,048-token response cap without creating a cell.
  The response allowance is now 8,192, with default reasoning and the same 48,000-token root
  budget. This change is not evidence that the model performs better.
- The first deployed recovery continuation exposed an AI SDK 7 message-role incompatibility
  after the actual restart succeeded. Portable checkpoints now enter the model as historical
  user evidence, with source roles retained, instead of unsupported system messages.
- The next GLM recovery attempt retained the original data and helper through restart,
  but reported neither a completed model step nor a terminal outcome within the verification
  window. It is inconclusive; unknown token usage remains reserved.
- Model turns now use Think's durable submission ledger with stable request identities,
  protected request lookup, persisted stream batches, and a separate active-time alarm.
  Local tests verify duplicate admission and stream/history parity.
- Customer and developer connection screens use the real connection APIs. Imported tools
  pass through cell approval and journaling; the HTTP regression checks origin policy,
  cross-tenant denial, approved dispatch, and revocation. Live HTTPS proof is still pending.
- Replay now rejects omitted journal entries before committing. Untrusted error strings
  cannot manufacture authorization or resumable recovery states.
- The real HTTPS MCP proof passed on application version `66983435-dc8d-4629-b0ce-122c555ac89b`:
  authorization, approved use, actual actor restart, unattended refresh, provider revocation,
  and explicit reconnection followed by resuming the original cell. Its separate fixture
  contains only fictional prices and no customer connections.
- GLM's next generation attempt produced a valid inspection step after about 74 seconds,
  then reached the 120-second active-time limit during step two. The watchdog produced a
  truthful failed outcome; no new bindings/helpers were created. Reported settled usage was
  4,344 tokens, with 32,196 tokens retained as an unsettled reservation.
- Inspection now returns readable JSON for ordinary trees and graph notation for special
  values/references. Retained helper source is inspectable. Evaluation progress now survives
  interruption and is invalidated if the candidate, baseline, cases, or evaluator version changes.

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
