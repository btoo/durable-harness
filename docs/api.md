# API guide

Host APIs take an authenticated `Principal`. Models receive narrowly scoped tools;
model-generated IDs never establish authority. The host owns spaces, grants, validation,
and evaluator definitions.

## Construct a workspace

```ts
import { DurableWorkspace } from "@durable-harness/core";
import { CloudflareCellExecutor, durableStore } from "@durable-harness/cloudflare";

const workspace = new DurableWorkspace(durableStore(ctx), new CloudflareCellExecutor(env.LOADER), {
  tools: developerDefinedTools,
});
const result = await workspace.execute(principal, workspaceId, source, {
  id: requestId,
  expectedRevision: 0,
});
```

`ctx` is the current Durable Object state. Provision the authorized `KnowledgeSpace`
through your trusted host first. The reference integration lives in
[`application.ts`](../apps/demo/worker/application.ts).

Use a stable request ID on retry. Reusing an ID with different source or principal fails.
Successful retries return the original committed revision. Start a new cell after the
previous cell settles; a changed starting revision returns `STALE_REVISION`.

## Inside a cell

| Namespace   | Calls                                                                           |
| ----------- | ------------------------------------------------------------------------------- |
| `tools`     | `search(query)`, `describe(name)`, `call(name, input)`                          |
| `runtime`   | `now()`, `uuid()`, `random()`, `progress(text)`                                 |
| `history`   | `search(query)`, `read(id)`, `around(id)`                                       |
| `memory`    | `read(id)`, `write({title, kind, value, id?, expectedRevision?})`               |
| `artifacts` | `write({name, text})` or `write({name, bytes})`, `read(id, {offset?, length?})` |

All calls are asynchronous and journaled. Memory/artifact writes target the current
workspace. Artifact reads default to 16,000 bytes, with a 64,000-byte maximum. Memory
values are limited to 64 KB; artifacts to 10 MB in this experiment.

Cells return their final expression and snapshot up to 20 `console.log/info/warn/error`
entries. This output is committed with the workspace revision. Outputs over 16 KB become
artifact handles; inspect or read those handles instead of inserting the full value into
the model context. Additional console entries are counted as omitted.

```ts
const exception = await memory.write({
  title: "Receiving hours",
  kind: "preference",
  value: { weekday: "Tuesday", after: "09:00" },
});
const attachment = await artifacts.write({ name: "quote.txt", text: "Supplier evidence" });
const excerpt = await artifacts.read(attachment.id, { offset: 0, length: 1000 });
```

Persistence supports plain data graphs, arrays, maps, sets, dates, binary values,
primitives, and explicit typed handles. Keep helper dependencies explicit:

```ts
function total(unitPrice: number, quantity: number, freight: number) {
  return unitPrice * quantity + freight;
}
```

Capturing a mutable top-level `freight` binding fails with `UNSUPPORTED_CAPTURE` and
guidance to pass the value as an argument. Helper dependency versions remain pinned
when another cell replaces an implementation.

`workspace.readHelper(principal, workspaceId, name)` returns its pinned source and dependencies.
`inspectGraph(workspace.readBinding(...))` provides readable JSON for ordinary trees and
retains graph notation when aliases, cycles, or special values matter. Clocks and randomness
remain journaled even when code aliases built-in objects. Dynamic imports, ambient globals,
runtime internals, and implicit `this` captures are outside the supported cell language.

## External actions and recovery

A `ToolDefinition` declares `effect: "read" | "idempotent" | "external"`, JSON schemas,
its space, a stable version, customer activity text, and an execution callback.
`requiresApproval: true` records intent and pauses before execution. The callback
receives a stable `operationId`; pass it to providers supporting idempotency keys.

`reconcile(operationId, input)` returns `{found: true, result}` for a verified outcome.
Without positive reconciliation, uncertain external actions are not repeated. The
host retains their cell and journal for inspection.

`approve(principal, space, operationId)` records approval. Resume the same cell ID,
source, and original execution principal after checking the reviewer's and executor's
current permissions. `reject` closes a waiting cell without undoing earlier effects.

## History, lineage, and channels

Search filters current authorization before ranking and limiting results. Memory edits
inherit existing lineage. Broader publication requires a registered structured projection
or explicit developer review. Improvement approval does not grant publication authority.

`EventLog.read(principal, workspace, afterSequence)` supports live delivery and reload.
The reference app uses hibernatable WebSockets and event-ID deduplication. Developer
diagnostics and customer messages share a work identity with authorized projections.

## Learning

Register a `LearningTarget` with developer-owned validation, an evaluator, and split
evaluation cases. Capture feedback, propose against a base revision, evaluate, and
promote. Promotion requires improvement without a baseline-pass regression, critical-case
success, and the exact evaluated candidate. Memory and instruction changes can promote
automatically; other kinds require review. Related variants stay in one data split.
Held-out cases are excluded from candidate validation and the reference API.

`LearningPipeline` drives bounded refinement using a developer-supplied `CandidateGenerator`.
Start a run with a workspace, target, and 1–20 evidence IDs, then call `advance` to resume it.
The generator receives adaptation cases and previous validation reports; held-out answers
are excluded. Each model attempt reserves tokens first. Interrupted usage remains reserved,
and no improvement may attempt more than three candidates. Deterministic generators declare
zero model usage and may use a smaller attempt limit.

Evaluation checkpoints persist individual case scores. Resumption reuses them only for
the same candidate, baseline, evaluation cases, and evaluator version. Eligible instruction
and memory changes promote automatically. Other change kinds pause for review. The PO and
quoting correction exercises both use this pipeline with a labeled deterministic generator.

The Cloudflare adapter also exposes `modelCandidateGenerator` and `workersAICandidateGenerator`.
They use one bounded model step per candidate, preserve default reasoning, and return reported
usage to the root ledger. Missing usage remains reserved. The reference correction form can
select this path in developer view with an operator token. Admission is durable, and runtime
alarms drive the queued improvement after the browser request returns.

Customer variations are configuration versions. Generated code-package publication,
state-schema migrations, and infrastructure deployment are not yet implemented.

## Current limitations

Provider-native compaction, semantic history retrieval, multi-agent message orchestration,
comparative benchmarks, and live HTTP observation verification remain under implementation.
Each browser experiment uses one Durable Object containing
its synthetic tenant spaces; scaling to thousands of tenants has not been demonstrated.

## MCP connections

`Connections` owns connection identities, capability grants, schema fingerprints, and
readiness. `CloudflareMcpTransport` uses Cloudflare's `MCPClientManager`; its OAuth provider
stores client registrations, PKCE material, and rotated tokens through `EncryptedSecrets`.
The host installs the manager with `Lifecycle` and supplies its exact callback URL.

Register a connection with `add(principal, {spaceId, name, url, auth}, credentials?)`.
Complete OAuth as its owner, then explicitly grant discovered tools with
`allowTools(principal, id, names, expectedFingerprint)`. Credentials stay in the host vault.
Use `discover` to refresh readiness and `revoke` to remove connection access.

Pass `tools: () => [...localTools, ...connections.capabilities()]` to `DurableWorkspace`.
Imported tools participate in the same journal, live activity, approval, and replay checks.
Their default policy treats them as external actions requiring approval. A developer-owned
policy callback may classify verified read tools differently. OAuth preflight failures can
pause before dispatch; failures after external dispatch retain an uncertain outcome.

The reference UI exposes account authorization and tool grants to customers and developers.
Set `MCP_ALLOWED_ORIGINS` to a comma-separated list of developer-approved origins.
An empty list disables new connections. OAuth needs a provider supporting refresh tokens
for unattended operation; the API reports the authorization's observed capability.

## Durable model submissions

The reference `model` command accepts an optional UUID `requestId`. Retry with the same ID
and identical message to inspect the original admission rather than start another run.
The server first persists the root request, then accepts it into Think's durable submission
ledger. Only inference time counts against the active execution budget; queue and approval
waits are paused. Root token reservations include instructions, schemas, rendered messages,
and output headroom. Unknown usage after interruption remains reserved.

Text batches enter a durable outbox before publication and are deduplicated in the
application event log. A runtime alarm cancels submissions that exceed active-time limits.
The real-model form requires the deployment's operator token; synthetic identity switching
does not authorize paid inference.

Original provider messages from new runs are archived before repeated reasoning is removed
from subsequent requests. Developers can use the `read-model-step` command with `rootId`,
`stepId`, and optional `offset`/`length` for bounded reads (16,000 characters by default;
64,000 maximum). Customer sessions cannot read those internal provider messages.

When a request would exceed its remaining reservation, the Cloudflare adapter can replace
older completed tool rounds with durable receipts while retaining the goal and latest
call/result pair. `inspectWorkspace({cellId})` retrieves the saved cell output under current
permissions. This reduces repeated context without deleting the original records.
