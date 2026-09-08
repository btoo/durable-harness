import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import { CloudflareCellExecutor } from "@durable-harness/cloudflare";
import {
  DurableWorkspace,
  asFault,
  contentHash,
  decodeGraph,
  invariant,
  type RecordStore,
  type ToolDefinition,
} from "@durable-harness/core";
import { procurementCases } from "./procurement-cases.js";
import { studyOwner, studySpace, type ProgramCandidate } from "./program-study.js";

type Mode = "harness" | "filesystem";
interface Setup {
  mode: Mode;
  source: string;
  hash: string;
  initialized: boolean;
}

/** Both paths get the same connector reconciliation and explicit approval.
 * The filesystem comparator includes application-authored checkpoints; it is not
 * deliberately left to repeat effects after a crash. Only fictional orders exist. */
export class RecoveryStudy {
  private readonly files: Workspace;
  private readonly executor: DynamicWorkerExecutor;
  private readonly workspace: DurableWorkspace;
  constructor(
    private readonly store: RecordStore,
    private readonly ctx: DurableObjectState,
    loader: WorkerLoader,
    private readonly incarnation: string,
  ) {
    this.files = new Workspace({
      sql: ctx.storage.sql,
      namespace: "recovery_files",
      name: () => ctx.id.toString(),
    });
    this.executor = new DynamicWorkerExecutor({ loader, globalOutbound: null, timeout: 3000 });
    const tools: ToolDefinition[] = [
      {
        name: "load-offers",
        version: "1",
        spaceId: studySpace,
        effect: "read",
        description: "Load synthetic RFQ",
        inputSchema: { type: "object" },
        publicActivity: "Loading test quotes",
        execute: async () => this.loadOffers(),
      },
      {
        name: "send-order",
        version: "1",
        spaceId: studySpace,
        effect: "external",
        requiresApproval: true,
        description: "Record a synthetic order and interrupt the actor",
        inputSchema: { type: "object" },
        publicActivity: "Recording a test order",
        execute: async (input, context) => this.send(context.operationId, input),
        reconcile: async (id) => {
          this.requireAuthorized();
          this.increment("reconciliations");
          const result = this.store.get("recovery-provider", id);
          return { found: !!result, result };
        },
      },
    ];
    this.workspace = new DurableWorkspace(store, new CloudflareCellExecutor(loader, 3000), {
      tools,
    });
  }
  private increment(name: string) {
    this.store.put(
      "recovery-counts",
      name,
      (this.store.get<number>("recovery-counts", name) ?? 0) + 1,
    );
  }
  private requireAuthorized() {
    invariant(
      !this.store.get("recovery-control", "revoked"),
      "ACCESS_DENIED",
      "The synthetic operator grant was revoked.",
    );
  }
  private loadOffers() {
    this.requireAuthorized();
    this.increment("reads");
    return procurementCases(2).find((c) => c.id === "import-carton")!.input;
  }
  private async send(id: string, input: unknown): Promise<unknown> {
    this.requireAuthorized();
    const previous = this.store.get<{ inputHash: string; receipt: unknown }>(
      "recovery-provider",
      id,
    );
    const inputHash = await contentHash(JSON.stringify(input));
    if (previous) {
      invariant(
        previous.inputHash === inputHash,
        "REPLAY_DIVERGENCE",
        "The resumed order changed.",
      );
      this.increment("reconciliations");
      return previous;
    }
    this.increment("effects");
    const result = { inputHash, receipt: { id: "synthetic-order-1", decision: input } };
    this.store.put("recovery-provider", id, result);
    await this.ctx.storage.sync();
    this.ctx.abort("Study interruption after provider accepted the synthetic order");
  }
  async setup(mode: Mode, candidate: ProgramCandidate) {
    this.requireAuthorized();
    invariant(
      mode === "harness" || mode === "filesystem",
      "INVALID_INPUT",
      "Choose a recovery implementation.",
    );
    invariant(
      typeof candidate?.source === "string" && candidate.source.length <= 16000,
      "INVALID_INPUT",
      "Choose the frozen candidate source.",
    );
    const hash = await contentHash(candidate.source);
    const existing = this.store.get<Setup>("recovery-control", "setup");
    invariant(
      !existing || (existing.hash === hash && existing.mode === mode),
      "STALE_REVISION",
      "A recovery identity has immutable code and mode.",
    );
    if (!existing?.initialized) {
      this.store.put("recovery-control", "setup", {
        mode,
        source: candidate.source,
        hash,
        initialized: false,
      });
      if (mode === "harness")
        await this.workspace.execute(studyOwner, studySpace, candidate.source, {
          id: "install-tool",
        });
      else {
        const result = await this.executor.execute(
          `async()=>{await state.writeFile('/tool.js',${JSON.stringify(candidate.source)});}`,
          [resolveProvider(stateTools(this.files))],
        );
        invariant(!result.error, "INVALID_CELL", result.error ?? "Could not persist the tool");
      }
      this.store.put("recovery-control", "setup", {
        mode,
        source: candidate.source,
        hash,
        initialized: true,
      });
    }
    return this.status();
  }
  async run(approved: boolean) {
    this.requireAuthorized();
    const setup = this.store.get<Setup>("recovery-control", "setup");
    invariant(
      setup?.initialized,
      "NOT_FOUND",
      "Install a frozen tool before recovery verification.",
    );
    if (setup.mode === "harness") {
      const source =
        'const input = await tools.call("load-offers", {}); const draft = rankOffers(input); const delivery = await tools.call("send-order", draft);';
      if (
        approved &&
        this.workspace
          .operations(studyOwner, studySpace, "order-cell")
          .some(
            (operation) =>
              operation.id === "order-cell:2" && operation.status === "pending_approval",
          )
      )
        this.workspace.approve(studyOwner, studySpace, "order-cell:2");
      try {
        await this.workspace.execute(studyOwner, studySpace, source, { id: "order-cell" });
      } catch (error) {
        if (asFault(error).code === "APPROVAL_REQUIRED")
          return { ...this.status(), awaitingApproval: true };
        throw error;
      }
      return {
        ...this.status(),
        values: decodeGraph(this.workspace.snapshot(studyOwner, studySpace).graph),
      };
    }
    // This is the comparator's explicit application recovery contract: checkpoint
    // the draft before awaiting approval, and use the same stable provider key.
    const sourceResult = await this.executor.execute('async()=>await state.readFile("/tool.js")', [
      resolveProvider(stateTools(this.files)),
    ]);
    invariant(
      !sourceResult.error && typeof sourceResult.result === "string",
      "INVALID_CELL",
      "The retained filesystem tool is unavailable.",
    );
    const result = await this.executor.execute(
      `async()=>{
      const saved = await state.exists('/draft.json');
      let draft;
      if(saved) draft = await state.readJson('/draft.json');
      else {
        const input = await connector.loadOffers();
        const rank = (input) => {${sourceResult.result}\n return rankOffers(input);};
        draft = rank(input);
        await state.writeJson('/draft.json',draft);
      }
      if(!${JSON.stringify(approved)}) return {awaitingApproval:true};
      if(await state.exists('/delivery.json'))return {draft,delivery:await state.readJson('/delivery.json')};
      const delivery = await connector.send('order-cell:2',draft);
      await state.writeJson('/delivery.json',delivery);
      return {draft,delivery};
    }`,
      [
        resolveProvider(stateTools(this.files)),
        {
          name: "connector",
          fns: {
            loadOffers: async () => this.loadOffers(),
            send: async (...args: unknown[]) => {
              invariant(
                approved,
                "APPROVAL_REQUIRED",
                "The host requires approval before recording a synthetic order.",
              );
              return this.send(String(args[0]), args[1]);
            },
          },
        },
      ],
    );
    invariant(!result.error, "INVALID_CELL", result.error ?? "Filesystem recovery failed");
    return { ...this.status(), values: result.result };
  }
  revoke() {
    this.store.put("recovery-control", "revoked", true);
    return this.status();
  }
  status() {
    return {
      incarnation: this.incarnation,
      setup: this.store.get<Setup>("recovery-control", "setup"),
      counts: {
        reads: this.store.get<number>("recovery-counts", "reads") ?? 0,
        effects: this.store.get<number>("recovery-counts", "effects") ?? 0,
        reconciliations: this.store.get<number>("recovery-counts", "reconciliations") ?? 0,
      },
    };
  }
}
