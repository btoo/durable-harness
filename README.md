# durable-harness

**A durable programmable workspace for deployed agents.** Built in TypeScript on
Cloudflare Durable Objects, Agents, Think, and Codemode.

An agent can create working structures, retain helper functions, pause for approval,
and recover its recorded operations after interruption. Customer corrections become
versioned proposals with evaluation evidence before promotion.

**Experimental, under active implementation.** The reference app runs synthetic PO
and quoting workflows with customer and developer views, durable supplier agents,
reviewed capabilities, scoped knowledge, and remote MCP connections.

[Open the demo](https://durable-harness-demo.btjk138.workers.dev) ·
[Read the API guide](docs/api.md) · [See the experimental results](docs/experiments.md)

Real-model checks proved generation, recovery after compaction and restart, a tested
customer-preference improvement, and cross-customer reuse of reviewed code. The comparison
studies have **not established an advantage over Codemode + GEPA**. A separate source-edit
follow-up repaired an unfinished tool and passed 12/12 synthetic held-out cases; see the
[experiment report](docs/experiments.md) for the matched results and limitations. See the
[acceptance register](docs/acceptance.md) for remaining work; no production-readiness or
superiority claim is made. The Recordly walkthrough is still being prepared.

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
Cloudflare AI binding, and a finite root budget. Default UI exercises are deterministic. The developer correction form can also run a funded model-generated proposal.

## The programming model

A **cell** is a block of TypeScript executed as one unit against a workspace.
After successful execution, its supported named values and helper functions are
committed durably for later cells to use, including after a restart.

An agent writes a TypeScript cell and can discover host capabilities through `tools.search`:

```ts
const offers = [
  { supplier: "Aster", price: 120 },
  { supplier: "Brookfield", price: 95 },
];
const comparison = { offers, pending: [], decisions: [] };
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

| API                                                           | Responsibility                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| `DurableWorkspace.execute(principal, space, source, options)` | Execute and atomically commit a cell                                |
| `inspect`, `snapshot`, `operations`                           | Inspect retained state and execution records                        |
| `approve` / `reject`                                          | Resolve a pending action using current authority                    |
| `Memory.read`, `write`, `publish`                             | Version knowledge and enforce sharing policy                        |
| `Artifacts.write`, `read`                                     | Retain blobs and retrieve bounded byte ranges                       |
| `History.search`, `read`, `around`                            | Recover authorized original evidence                                |
| `ContextManager.prepare`                                      | Budget context without deleting originals                           |
| `Learning.feedback`, `propose`, `evaluate`, `promote`         | Apply measured, policy-controlled changes                           |
| `RunBudgets`                                                  | Account for steps, tokens, active time, and descendant admissions   |
| `Connections`                                                 | Track ownership, grants, refresh, and reconnection                  |
| `LearningPipeline`                                            | Resume bounded generation, evaluation, promotion and review         |
| `modelCodeEditGenerator`                                      | Propose exact source edits for the same evaluation and review gates |
| `AgentRegistry`                                               | Persist scoped delegation, mailboxes and immutable results          |
| `Capabilities`                                                | Evaluate, approve and separately publish reusable code              |

See the [API guide](docs/api.md) · [MCP connections](docs/mcp.md), [deployment guide](docs/deployment.md), and
[implementation ledger](docs/implementation.md). Packages currently export workspace
source; npm publication is not yet available.

The [private observation CLI](docs/observation.md) supports bounded, GET-only collection
and explicitly launched watch mode, with evidence kept outside Git.

## Verification

```sh
npm run check         # TypeScript + unit tests + real Workers runtime tests
npm run build         # Worker and React production bundles
npm run format:check
```

Tests cover retained values/functions, object eviction, approval/resume, uncertain
effects, replay divergence, private artifacts, revocation, history retrieval,
compaction, evaluated promotion, OAuth lifecycle contracts, HTTP role enforcement,
and live/history parity. Deployed checks also exercise a real HTTPS OAuth fixture,
including refresh after restart, revocation, reconnection, and original-cell resumption.

Compaction retains original history and creates a retrievable checkpoint. Exact
original recovery is testable; effective model recall still needs comparative
measurement. Current learning evaluations use deterministic business checks. The complete
[quickstart recipe](examples/quickstart.ts) is compiled and exercised by the Worker test suite.

## Contributing

Optimize for [developer, agent, and customer experience](CONTRIBUTING.md). Keep domain
behavior in adapters and guarantees precise. Private observation data and credentials
must stay outside source history and public demos.

## License

[MIT](LICENSE).
