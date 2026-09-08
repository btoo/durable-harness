# durable-harness

**A durable programmable workspace for deployed agents.** Built in TypeScript on
Cloudflare Durable Objects, Agents, Think, and Codemode.

An agent can create working structures, retain helper functions, pause for approval,
and recover its recorded operations after interruption. Customer corrections become
versioned proposals with evaluation evidence before promotion.

**Experimental, under active implementation.** The current slice runs synthetic PO
and quoting workflows with customer and developer views. Recovery tests exercise real
local Durable Objects, SQLite, R2, and network-isolated Dynamic Workers. Comparative
benchmarks, the full remote MCP integration, private observation, and the recorded
walkthrough remain in progress. No production-readiness or superiority claim is made.

## Try it locally

Requires Node.js 22 or newer and npm. Default exercises require no model API key.

```sh
git clone https://github.com/btoo/durable-harness.git
cd durable-harness
npm ci
npm run setup
npm run dev
```

Open **http://localhost:5173**. Run the PO exercise, add the business-day correction,
then run it again. In quoting, enable freight-inclusive comparison and see which
supplier the next run recommends. Prepare a supplier message to test approval and
resume. Switch the synthetic identity to **Developer** to inspect retained bindings,
versioned helpers, code cells, and evaluation evidence.

Each browser receives an isolated synthetic environment. Persona switching is a demo
feature; authorization is enforced on the server. Authorized developers can inspect
customer-facing messages. No live suppliers or customer systems are connected.

`npm run setup` creates local secrets in a Git-ignored file. Remote bindings are opt-in
at development startup. Real-model experiments require an administrator token, a
Cloudflare AI binding, and a finite root budget. UI exercises are explicitly deterministic.

## The programming model

An agent writes a TypeScript cell using discoverable capabilities:

```ts
const responses = await tools.call("supplier.readOffers", {});
const comparison = { responses, pending: [], decisions: [] };
const sameComparison = comparison;

function cheapest(items: { price: number }[]) {
  return items.reduce((a, b) => (a.price < b.price ? a : b));
}
```

After a successful commit, later cells can use `comparison` and `cheapest`, including
after a runtime restart. Aliases and cycles retain their relationships. Helper functions
retain versioned source and explicit dependencies; pass mutable values as arguments.
Open sockets, promises, live clients, and arbitrary class instances cannot be retained.
Keep large values in artifacts with bounded reads.

The sandbox has no direct network access. Host operations use a persisted journal.
Completed operations are reused during replay. An external action with a lost result
remains **uncertain** until its connector reconciles it. Workspace rollback does not
undo an external action.

## API concept map

| API                                                           | Responsibility                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `DurableWorkspace.execute(principal, space, source, options)` | Execute and atomically commit a cell                              |
| `inspect`, `snapshot`, `operations`                           | Inspect retained state and execution records                      |
| `approve` / `reject`                                          | Resolve a pending action using current authority                  |
| `Memory.read`, `write`, `publish`                             | Version knowledge and enforce sharing policy                      |
| `Artifacts.write`, `read`                                     | Retain blobs and retrieve bounded byte ranges                     |
| `History.search`, `read`, `around`                            | Recover authorized original evidence                              |
| `ContextManager.prepare`                                      | Budget context without deleting originals                         |
| `Learning.feedback`, `propose`, `evaluate`, `promote`         | Apply measured, policy-controlled changes                         |
| `RunBudgets`                                                  | Account for steps, tokens, active time, and descendant admissions |
| `Connections`                                                 | Track ownership, grants, refresh, and reconnection                |

See the [API guide](docs/api.md), [deployment guide](docs/deployment.md), and
[implementation ledger](docs/implementation.md). Packages currently export workspace
source; npm publication is not yet available.

## Verification

```sh
npm run check         # TypeScript + unit tests + real Workers runtime tests
npm run build         # Worker and React production bundles
npm run format:check
```

Tests cover retained values/functions, object eviction, approval/resume, uncertain
effects, replay divergence, private artifacts, revocation, history retrieval,
compaction, evaluated promotion, OAuth lifecycle contracts, HTTP role enforcement,
and live/history parity. OAuth tests currently use a controlled transport adapter;
they do not yet prove an external provider.

Compaction retains original history and creates a retrievable checkpoint. Exact
original recovery is testable; effective model recall still needs comparative
measurement. Current learning evaluations use deterministic business checks.

## Contributing

Optimize for [developer, agent, and customer experience](CONTRIBUTING.md). Keep domain
behavior in adapters and guarantees precise. Private observation data and credentials
must stay outside source history and public demos.

## License

[MIT](LICENSE).
