# Private observation

The Node-only collector is separate from the public Worker. It issues verified Didero
GET requests using a credential held by the local host. Agents never receive that credential.

```sh
npm run harness -- observe \
  --origin https://your-didero-api.example \
  --team YOUR_TEAM_UUID \
  --agent po_reasoning_agent
```

Set `DIDERO_OBSERVATION_TOKEN` in the invoking shell. Do not put it in source, a URL,
or a command-line argument. The default output is
`~/.local/share/durable-harness/observations`, with private file permissions. The file
store rejects output paths inside Git working trees.

Defaults: the previous 24 hours, serial requests, ten runs per page, two pages per agent,
100 requests maximum, and ten previously captured runs revisited for delayed feedback.
Change these through the documented CLI options. `watch` starts only when explicitly
launched and stops with its process; the default interval is five minutes.

The route contract was verified in the Didero source on September 7, 2026:

| GET route, relative to `/api/v1/admin` | Use                                                      |
| -------------------------------------- | -------------------------------------------------------- |
| `/agent-runs`                          | Explicit team/time filters and bounded cursor pagination |
| `/agent-runs/{id}`                     | Details and feedback for an admitted run                 |
| `/prompt-renders/{hash}`               | Original prompt bytes, checked against their SHA-256     |
| `/po-workflows/{team_id}`              | Current workflow snapshot                                |
| `/trace-clusters/membership`           | Cluster membership for explicitly captured run IDs       |

The collector rejects redirects, changed origins, responses over 5 MB, and records outside
the admitted team/window. It does not expose a mutation method. Private record files are
content-addressed and retain earlier revisions when late feedback changes a run.

Current workflow snapshots and cluster memberships are observations at collection time.
They do not establish the historical state that an agent saw. Missing prompt/state coverage
stays visible in `status.json`; replay is marked partial or unsupported. Feedback is
separated from decision evidence before replay preparation.

The HTTP path is locally verified with controlled responses. Initial live research may
also use separately labeled, read-only CDC observations through an existing operator
credential. CDC lag and absent historical state must remain explicit. No private evidence
is imported into the public demo or committed to this repository.
