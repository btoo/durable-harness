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

Customer variations are configuration versions. Generated code-package publication,
state-schema migrations, and infrastructure deployment are not yet implemented.

## Current limitations

Full MCP/OAuth integration, provider-native compaction, semantic history retrieval,
multi-agent message orchestration, comparative benchmarks, and read-only observation
remain under implementation. Each browser experiment uses one Durable Object containing
its synthetic tenant spaces; scaling to thousands of tenants has not been demonstrated.
