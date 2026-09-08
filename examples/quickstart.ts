import {
  Artifacts,
  DurableWorkspace,
  Memory,
  decodeGraph,
  type ArtifactBackend,
  type CellExecutor,
  type Principal,
  type RecordStore,
} from "@durable-harness/core";

/** This complete recipe is compiled and exercised against the local Workers runtime. */
export async function quickstart(
  store: RecordStore,
  executor: CellExecutor,
  blobs: ArtifactBackend,
) {
  const principal: Principal = {
    id: "example-owner",
    deploymentId: "example",
    roles: ["developer"],
  };
  const space = "example-workspace";
  store.put("spaces", space, {
    id: space,
    deploymentId: "example",
    kind: "tenant",
    label: "Synthetic example",
    revision: 1,
    grants: [{ principalId: principal.id, permissions: ["read", "write", "execute", "publish"] }],
  });
  const options = { memory: new Memory(store), artifacts: new Artifacts(store, blobs) };
  const workspace = new DurableWorkspace(store, executor, options);
  await workspace.execute(
    principal,
    space,
    `
const offers = [{supplier:"Aster",price:120},{supplier:"Brookfield",price:95}];
function cheapest(items: {supplier:string,price:number}[]) { return items.reduce((a,b)=>a.price<b.price?a:b); }
const exception = await memory.write({title:"Receiving hours",kind:"preference",value:{day:"Tuesday"}});
const attachment = await artifacts.write({name:"quote.txt",text:"Synthetic supplier evidence"});
`,
    { id: "example-first", expectedRevision: 0 },
  );
  // Reconstruct the host; the namespace, helper source, memory and artifact handles are durable.
  const restored = new DurableWorkspace(store, executor, options);
  const result = await restored.execute(
    principal,
    space,
    `
const selected = cheapest(offers);
const remembered = await memory.read(exception.id);
const excerpt = await artifacts.read(attachment.id, {length:100});
selected;
`,
    { id: "example-second", expectedRevision: 1 },
  );
  return {
    revision: result.workspace.revision,
    values: decodeGraph(result.workspace.graph),
    namespace: restored.inspect(principal, space),
  };
}
