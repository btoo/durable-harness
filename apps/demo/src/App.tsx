import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  ChevronRight,
  Circle,
  Code2,
  Database,
  FileText,
  GitBranch,
  Layers3,
  Link2,
  LockKeyhole,
  MessageSquare,
  Package,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import {
  command,
  request,
  setPersona,
  type DemoCommand,
  type DemoState,
  type Persona,
} from "./api.js";
import { Connections } from "./Connections.js";
import { ModelRun } from "./ModelRun.js";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { HarnessEvent } from "@durable-harness/core";

type View = "activity" | "workspace" | "learning" | "connections";
const time = (value: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(value),
  );

export function App() {
  const [data, setData] = useState<DemoState>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>(() =>
    new URLSearchParams(location.search).get("view") === "connections" ? "connections" : "activity",
  );
  const [connection, setConnection] = useState("Connecting");
  const [showCorrection, setShowCorrection] = useState(false);
  const generation = useRef(0);
  const selection = useRef<string | undefined>(undefined);
  const cursor = useRef(0);
  const load = useCallback(async (workspaceId?: string) => {
    const current = ++generation.current;
    const state = await request<DemoState>(
      `/api/state${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ""}`,
    );
    if (current === generation.current) {
      cursor.current = state.events.at(-1)?.sequence ?? 0;
      selection.current = state.selected;
      setData(state);
    }
  }, []);
  useEffect(() => {
    load(new URLSearchParams(location.search).get("workspace") ?? undefined).catch(async () => {
      try {
        await setPersona("northstar");
        await load();
      } catch (error) {
        setError(String(error));
      }
    });
  }, [load]);
  useEffect(() => {
    if (!data) return;
    const workspaceId = data.selected;
    let disposed = false;
    let socket: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events?workspace=${encodeURIComponent(workspaceId)}&after=${cursor.current}`,
      );
      socket.onopen = () => {
        attempts = 0;
        setConnection("Live");
      };
      socket.onmessage = (event) => {
        if (event.data === "pong" || disposed || selection.current !== workspaceId) return;
        const record = JSON.parse(event.data) as HarnessEvent;
        cursor.current = Math.max(cursor.current, record.sequence);
        setData((current) =>
          current?.selected === workspaceId
            ? {
                ...current,
                events: current.events.some((item) => item.id === record.id)
                  ? current.events
                  : [...current.events, record].sort((a, b) => a.sequence - b.sequence),
              }
            : current,
        );
        if (
          [
            "cell.committed",
            "learning.promoted",
            "model.completed",
            "model.failed",
            "model.interrupted",
            "action.awaiting_approval",
          ].includes(record.kind) ||
          record.kind.startsWith("learning.")
        )
          void load(workspaceId).catch((error) => setError(String(error)));
      };
      socket.onclose = () => {
        if (!disposed) {
          setConnection("Reconnecting");
          retry = setTimeout(connect, Math.min(500 * 2 ** attempts++, 5000));
        }
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [data?.selected, data?.persona, load]);

  async function perform(value: DemoCommand, operatorToken?: string) {
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      await command(data.selected, value, operatorToken);
      await load(data.selected);
      setShowCorrection(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function switchPersona(persona: Persona) {
    setBusy(true);
    setError("");
    setView("activity");
    generation.current++;
    selection.current = undefined;
    setData(undefined);
    try {
      await setPersona(persona);
      await load();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  const selected = data?.workspaces.find((workspace) => workspace.id === data.selected);
  const developer = data?.persona === "developer";
  const preferences = data?.configuration?.value as
    { includeFreight: boolean; businessDaysOnly: boolean; approvalRequired: boolean } | undefined;
  const lastCell = data?.cells.at(-1);
  const unresolved =
    lastCell && ["waiting_approval", "waiting_connection", "uncertain"].includes(lastCell.status);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="durable-harness home">
          <span className="brand-icon">
            <Layers3 size={20} strokeWidth={1.6} />
          </span>
          <span>
            durable<span className="brand-light">-harness</span>
          </span>
        </a>
        <div className="experiment">
          <span className="small-dot" /> Synthetic workspace <span className="tiny-tag">EXP</span>
        </div>
        <div className="nav-label">WORKSPACES</div>
        <nav aria-label="Workspaces">
          {data?.workspaces.map((workspace) => (
            <button
              key={workspace.id}
              className={`workspace-link ${data.selected === workspace.id ? "selected" : ""}`}
              onClick={() => {
                setError("");
                selection.current = workspace.id;
                setShowCorrection(false);
                void load(workspace.id).catch((error) => setError(String(error)));
              }}
            >
              <span className="nav-icon">
                {workspace.kind === "po" ? <Package size={17} /> : <MessageSquare size={17} />}
              </span>
              <span>
                <strong>{workspace.label}</strong>
                <small>{workspace.tenant}</small>
              </span>
              {data.selected === workspace.id ? <ChevronRight size={14} /> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={19} />
          <p>Each customer has a private workspace. Access is checked by the runtime.</p>
        </div>
        <div className="sidebar-bottom">
          <span className="nav-label">DEMO IDENTITY</span>
          <label className="identity">
            <span className="avatar">
              {developer ? "D" : data?.persona === "cedar" ? "C" : "N"}
            </span>
            <select
              aria-label="Demo identity"
              value={data?.persona ?? "northstar"}
              onChange={(event) => void switchPersona(event.target.value as Persona)}
              disabled={busy}
            >
              <option value="northstar">Northstar customer</option>
              <option value="cedar">Cedar customer</option>
              <option value="developer">Developer</option>
            </select>
          </label>
          <a
            className="source-link"
            href="https://github.com/btoo/durable-harness"
            target="_blank"
            rel="noreferrer"
          >
            View source <ArrowRight size={13} />
          </a>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <span className="muted">Workspace</span>
            <ChevronRight size={13} />
            <span>{selected?.tenant ?? "Loading"}</span>
          </div>
          <div className="topbar-right">
            <span className="role-tag">{developer ? "Developer view" : "Customer view"}</span>
            <span className={`live-status ${connection === "Live" ? "connected" : ""}`}>
              <span className="small-dot" />
              {connection}
            </span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {selected?.kind === "po" ? "PURCHASE ORDER AGENT" : "QUOTING AGENT"}
              </p>
              <h1>{selected?.subject ?? "Opening your workspace"}</h1>
              <p className="subtitle">Progress, decisions, and the context your agent keeps.</p>
            </div>
            <button
              className="primary"
              disabled={busy || !data || !!unresolved}
              onClick={() => void perform({ action: "run-synthetic" })}
            >
              <Play size={15} />
              {busy ? "Working…" : "Run exercise"}
            </button>
          </div>
          <div className="proof-strip">
            <span>
              <span className="small-dot" />
              {lastCell ? lastCell.status.replaceAll("_", " ") : "Ready to run"}
            </span>
            <span>
              <Database size={14} />
              {data?.cells.filter((cell) => cell.status === "committed").length ?? 0} committed
              cells
            </span>
            <span>
              <GitBranch size={14} />
              Preferences v{data?.configuration?.revision ?? 1}
            </span>
            <span>
              <LockKeyhole size={14} />
              {selected?.tenant ?? "Tenant"} only
            </span>
          </div>
          <div className="tabs" role="tablist" aria-label="Workspace views">
            <button
              role="tab"
              aria-selected={view === "activity"}
              onClick={() => setView("activity")}
            >
              <Activity size={16} />
              Activity
            </button>
            {developer ? (
              <button
                role="tab"
                aria-selected={view === "workspace"}
                onClick={() => setView("workspace")}
              >
                <Terminal size={16} />
                Workspace
              </button>
            ) : null}
            <button
              role="tab"
              aria-selected={view === "learning"}
              onClick={() => setView("learning")}
            >
              <GitBranch size={16} />
              Learning
              {data?.proposals.length ? (
                <span className="count">{data.proposals.length}</span>
              ) : null}
            </button>
            <button
              role="tab"
              aria-selected={view === "connections"}
              onClick={() => setView("connections")}
            >
              <Link2 size={16} />
              Connections
            </button>
          </div>
          {error ? (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          ) : null}
          <div className="content-grid">
            <section className="primary-column">
              {view === "activity" ? (
                <>
                  <section className="panel conversation">
                    <div className="panel-heading">
                      <h2>Conversation & activity</h2>
                      <span className="secondary-label">Saved as it happens</span>
                    </div>
                    {data?.history
                      .filter((item) => item.role === "user")
                      .slice(0, 1)
                      .map((item) => (
                        <div className="customer-message" key={item.id}>
                          <span className="avatar small">N</span>
                          <div>
                            <div className="message-meta">
                              <strong>You</strong>
                              <time>{time(item.createdAt)}</time>
                            </div>
                            <p>{item.text}</p>
                          </div>
                        </div>
                      ))}
                    <ActivityFeed events={data?.events ?? []} developer={developer} />
                    {!data?.cells.length ? (
                      <div className="empty-state">
                        <span className="empty-icon">
                          <Sparkles size={23} />
                        </span>
                        <h3>Ready for the first run</h3>
                        <p>
                          Run the exercise to inspect evidence, retain working data, and prepare a
                          recommendation.
                        </p>
                      </div>
                    ) : null}
                    <div className="conversation-actions">
                      <button
                        className="secondary"
                        disabled={busy || !data?.cells.length}
                        onClick={() => setShowCorrection(true)}
                      >
                        <MessageSquare size={15} />
                        Add a correction
                      </button>
                      <button
                        className="text-button"
                        disabled={busy || !data?.cells.length || !!unresolved}
                        onClick={() => void perform({ action: "prepare-message" })}
                      >
                        Prepare supplier message <ArrowRight size={14} />
                      </button>
                    </div>
                  </section>
                  {lastCell?.status === "waiting_connection" ? (
                    <section className="panel approval">
                      <h2>Reconnect to continue</h2>
                      <p>
                        Progress is saved. Restore the account in Connections, then resume this
                        task.
                      </p>
                      <div className="button-row">
                        <button className="secondary" onClick={() => setView("connections")}>
                          Open connections
                        </button>
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() => void perform({ action: "resume", cellId: lastCell.id })}
                        >
                          Resume saved work
                        </button>
                      </div>
                    </section>
                  ) : null}
                  {developer && data ? (
                    <ModelRun data={data} busy={busy} perform={perform} />
                  ) : null}
                  {data?.pending.map((action) => (
                    <section className="panel approval" key={action.id}>
                      <span className="eyebrow">YOUR APPROVAL</span>
                      <h2>
                        {action.tool.startsWith("mcp.")
                          ? "Review the connected tool action"
                          : "Review the supplier message"}
                      </h2>
                      <pre className="message-preview">
                        {String(
                          (action.input as { body?: string }).body ??
                            JSON.stringify(action.input, null, 2),
                        )}
                      </pre>
                      <p className="caption">
                        {action.tool.startsWith("mcp.")
                          ? "The connected server will receive these approved inputs."
                          : "This exercise uses a synthetic email provider."}
                      </p>
                      <div className="button-row">
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() =>
                            void perform({ action: "approve", operationId: action.id })
                          }
                        >
                          <Check size={15} />
                          Approve & continue
                        </button>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => void perform({ action: "reject", operationId: action.id })}
                        >
                          Reject
                        </button>
                      </div>
                    </section>
                  ))}
                  {showCorrection && selected ? (
                    <Correction
                      kind={selected.kind}
                      busy={busy}
                      developer={developer}
                      onCancel={() => setShowCorrection(false)}
                      onSubmit={(value, token) => void perform(value, token)}
                    />
                  ) : null}
                </>
              ) : view === "workspace" && developer && data ? (
                <Workspace data={data} busy={busy} perform={(value) => void perform(value)} />
              ) : view === "connections" && data ? (
                <Connections
                  key={`${data.persona}:${data.selected}`}
                  data={data}
                  busy={busy}
                  perform={perform}
                />
              ) : data ? (
                <Learning data={data} busy={busy} perform={perform} />
              ) : null}
            </section>
            <aside className="details-column">
              <section className="panel context-card">
                <span className="card-icon">
                  <Database size={20} />
                </span>
                <h2>Retained context</h2>
                <p>Working data stays available between runs.</p>
                <dl>
                  <div>
                    <dt>Committed revisions</dt>
                    <dd>{data?.cells.filter((cell) => cell.status === "committed").length ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Saved memories</dt>
                    <dd>{data?.memories.length ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Pending approvals</dt>
                    <dd>{data?.pending.length ?? 0}</dd>
                  </div>
                </dl>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <h2>Customer preferences</h2>
                  <span className="tiny-tag">v{data?.configuration?.revision ?? 1}</span>
                </div>
                <Preference
                  enabled={!!preferences?.includeFreight}
                  title="Compare total landed cost"
                  description="Include supplier freight in quote rankings."
                />
                <Preference
                  enabled={!!preferences?.businessDaysOnly}
                  title="Follow up on business days"
                  description="Move weekend reminders to Monday."
                />
                <div className="rule-note">
                  <ShieldCheck size={16} />
                  <span>Supplier messages require approval.</span>
                </div>
              </section>
              <div className="demo-note">
                <Circle size={13} />
                <p>
                  <strong>Synthetic business data</strong>
                  <br />
                  Synthetic suppliers and orders. The runtime, saved state, approvals, and tests are
                  real. Model-generated runs are labeled separately.
                </p>
              </div>
            </aside>
          </div>
        </main>
        <footer>
          durable-harness <span>Experimental · Built on Cloudflare</span>
        </footer>
      </div>
    </div>
  );
}

function ActivityFeed({ events, developer }: { events: HarnessEvent[]; developer: boolean }) {
  const visible = events.filter((event) => developer || event.audience === "customer");
  const groups: { event: HarnessEvent; text: string }[] = [];
  for (const event of visible) {
    const last = groups.at(-1);
    if (
      event.kind === "model.delta" &&
      last?.event.kind === "model.delta" &&
      last.event.data.rootId === event.data.rootId
    )
      last.text += event.text;
    else groups.push({ event, text: event.text });
  }
  return (
    <ol className="timeline" aria-label="Saved agent activity">
      {groups.map(({ event, text }) => (
        <li key={event.id} className={event.audience === "developer" ? "diagnostic" : ""}>
          <span className="timeline-icon">
            {event.kind.includes("promoted") ||
            event.kind.includes("completed") ||
            event.kind.includes("committed") ? (
              <Check size={14} />
            ) : event.audience === "developer" ? (
              <Code2 size={14} />
            ) : (
              <Activity size={14} />
            )}
          </span>
          <div>
            <div className="message-meta">
              <strong>
                {event.audience === "developer"
                  ? "Runtime"
                  : event.data.author === "customer"
                    ? "You"
                    : "Agent"}
              </strong>
              {event.audience === "developer" ? <span className="tiny-tag">DEV</span> : null}
              <time>{time(event.createdAt)}</time>
            </div>
            <div className="markdown">
              <Markdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{
                  a: ({ children, ...props }) => (
                    <a {...props} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                  img: () => null,
                }}
              >
                {text}
              </Markdown>
            </div>
            {developer ? (
              <span className="event-code">
                {event.kind} · #{event.sequence}
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
function Preference({
  enabled,
  title,
  description,
}: {
  enabled: boolean;
  title: string;
  description: string;
}) {
  return (
    <div className="preference">
      <span className={`preference-check ${enabled ? "enabled" : ""}`}>
        {enabled ? <Check size={12} /> : null}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
        <span>{enabled ? "Active" : "Not enabled"}</span>
      </div>
    </div>
  );
}
function Correction({
  kind,
  busy,
  onCancel,
  onSubmit,
  developer,
}: {
  kind: "po" | "quoting";
  busy: boolean;
  developer: boolean;
  onCancel: () => void;
  onSubmit: (command: DemoCommand, operatorToken?: string) => void;
}) {
  const [useModel, setUseModel] = useState(false);
  const [operatorToken, setOperatorToken] = useState("");
  const [text, setText] = useState(
    kind === "po"
      ? "Please move follow-ups that fall on weekends to the next business day."
      : "Please include freight when comparing quotes. The cheapest unit price can cost more overall.",
  );
  return (
    <form
      className="panel correction"
      onSubmit={(event) => {
        event.preventDefault();
        const token = operatorToken;
        setOperatorToken("");
        onSubmit(
          {
            action: useModel ? "learn-with-model" : "correct",
            preference: kind === "po" ? "businessDaysOnly" : "includeFreight",
            text,
          },
          token,
        );
      }}
    >
      <span className="eyebrow">TEACH YOUR AGENT</span>
      <h2>Add a customer correction</h2>
      <label htmlFor="correction">Describe why this preference should apply</label>
      <textarea
        id="correction"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        required
        maxLength={2000}
      />
      {developer ? (
        <label className="model-choice">
          <input
            type="checkbox"
            checked={useModel}
            onChange={(event) => setUseModel(event.target.checked)}
          />
          Use a model to propose this change
        </label>
      ) : null}
      {useModel ? (
        <label>
          Operator token
          <input
            type="password"
            autoComplete="off"
            required
            value={operatorToken}
            onChange={(event) => setOperatorToken(event.target.value)}
            placeholder="Deployment ADMIN_TOKEN"
          />
        </label>
      ) : null}
      <p className="caption">
        This exercise applies{" "}
        {kind === "po" ? "business-day follow-ups" : "freight-inclusive quote comparison"} only if
        the evaluation improves without regressions.
      </p>
      <div className="button-row">
        <button className="primary" disabled={busy}>
          Test correction <ArrowRight size={14} />
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
function Workspace({
  data,
  busy,
  perform,
}: {
  data: DemoState;
  busy: boolean;
  perform: (command: DemoCommand) => void;
}) {
  const [source, setSource] = useState('const toolsAvailable = await tools.search("");');
  return (
    <>
      {data.agents.length ? (
        <section className="panel">
          <div className="panel-heading">
            <h2>Agent relationships</h2>
            <span className="secondary-label">Durable identities and results</span>
          </div>
          {data.agents.map((agent) => (
            <details className="cell-record" key={agent.id}>
              <summary>
                <GitBranch size={15} />
                <strong>{agent.name}</strong>
                <span>
                  {agent.parentId
                    ? agent.status
                    : (data.runs?.find((run) => run.id === agent.rootId)?.status ?? agent.status)}
                </span>
              </summary>
              <p className="caption">
                {agent.parentId
                  ? `Delegated by ${data.agents.find((parent) => parent.id === agent.parentId)?.name ?? agent.parentId}`
                  : "Root coordinator"}
              </p>
              <pre>{JSON.stringify({ scopes: agent.scopes, result: agent.result }, null, 2)}</pre>
            </details>
          ))}
        </section>
      ) : null}
      <section className="panel">
        <div className="panel-heading">
          <h2>Durable namespace</h2>
          <span className="tiny-tag">revision {data.workspace?.revision ?? 0}</span>
        </div>
        {data.workspace?.bindings.length ? (
          <table>
            <thead>
              <tr>
                <th>Binding</th>
                <th>Type</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {data.workspace.bindings.map((binding) => (
                <tr key={binding.name}>
                  <td>
                    <code>{binding.name}</code>
                  </td>
                  <td>{binding.type}</td>
                  <td>
                    <code>{binding.preview}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty-copy">Run a cell to create retained bindings.</p>
        )}
        <div className="panel-heading helper-heading">
          <h3>Retained helpers</h3>
          <span>{data.workspace?.functions.length ?? 0} modules</span>
        </div>
        {data.workspace?.functions.map((helper) => (
          <div className="helper" key={helper.name}>
            <Code2 size={16} />
            <strong>{helper.name}</strong>
            <code>{helper.version.slice(0, 12)}</code>
          </div>
        ))}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Code cell</h2>
          <span className="secondary-label">TypeScript · Network isolated</span>
        </div>
        <label className="sr-only" htmlFor="cell-source">
          TypeScript cell source
        </label>
        <textarea
          id="cell-source"
          className="code-editor"
          spellCheck={false}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          rows={7}
        />
        <div className="button-row">
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              perform({
                action: "cell",
                source,
                expectedRevision: data.workspace?.revision ?? 0,
                id: crypto.randomUUID(),
              })
            }
          >
            <Play size={14} />
            Execute cell
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => perform({ action: "compact" })}
          >
            <Layers3 size={15} />
            Prepare context
          </button>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Execution history</h2>
          <span>{data.cells.length} cells</span>
        </div>
        {[...data.cells].reverse().map((cell) => (
          <details className="cell-record" key={cell.id}>
            <summary>
              <span className={`status-dot ${cell.status === "committed" ? "success" : ""}`} />
              <code>{cell.id.slice(0, 12)}</code>
              <span>{cell.status.replaceAll("_", " ")}</span>
              <time>{time(cell.createdAt)}</time>
            </summary>
            <pre>{cell.source}</pre>
            {cell.output ? (
              <>
                <h3>Cell output</h3>
                <pre>
                  {JSON.stringify(
                    "format" in cell.output ? cell.output.value : cell.output,
                    null,
                    2,
                  )}
                </pre>
              </>
            ) : null}
            {cell.error ? <p>{cell.error.message}</p> : null}
            {["waiting_connection", "uncertain"].includes(cell.status) ? (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => perform({ action: "resume", cellId: cell.id })}
              >
                <RefreshCw size={14} />
                Resume recorded cell
              </button>
            ) : null}
          </details>
        ))}
      </section>
    </>
  );
}
function Learning({
  data,
  busy,
  perform,
}: {
  data: DemoState;
  busy: boolean;
  perform(command: DemoCommand): Promise<void>;
}) {
  return (
    <>
      {data.learningRuns.length ? (
        <section className="panel">
          <div className="panel-heading">
            <h2>Learning pipeline</h2>
            <span className="secondary-label">Progress survives interruption</span>
          </div>
          {data.learningRuns.map((run) => (
            <div className="helper" key={run.id}>
              <GitBranch size={16} />
              <strong>{run.status.replaceAll("_", " ")}</strong>
              <span>
                {run.attempts} candidate{run.attempts === 1 ? "" : "s"}
              </span>
              {run.status === "interrupted" ? (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void perform({ action: "resume-learning", runId: run.id })}
                >
                  Resume checks
                </button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      <section className="panel">
        <div className="panel-heading">
          <h2>Corrections & improvements</h2>
          <span className="secondary-label">Evidence → test → promotion</span>
        </div>
        {!data.proposals.length ? (
          <div className="empty-state">
            <GitBranch size={28} />
            <h3>No changes proposed yet</h3>
            <p>
              Add a correction from the activity view. Its evidence and evaluation will appear here.
            </p>
          </div>
        ) : (
          data.proposals.map((proposal) => (
            <article className="proposal" key={proposal.id}>
              <div className="proposal-title">
                <span className="card-icon">
                  <GitBranch size={18} />
                </span>
                <div>
                  <h3>
                    {proposal.kind === "instruction" ? "Customer preference update" : proposal.kind}
                  </h3>
                  <span>
                    {proposal.target} · based on v{proposal.baseRevision}
                  </span>
                </div>
                <span className="status-pill">{proposal.status.replaceAll("_", " ")}</span>
              </div>
              <p>{proposal.rationale}</p>
              <div className="proposal-evidence">
                <FileText size={14} />
                {proposal.evidenceIds.length} correction cited <span>·</span>
                {proposal.origin === "model_generated"
                  ? "Model-generated candidate"
                  : "Structured customer correction"}
              </div>
              <details>
                <summary>View candidate configuration</summary>
                <pre>{JSON.stringify(proposal.candidate, null, 2)}</pre>
              </details>
            </article>
          ))
        )}
      </section>
      {data.evaluations?.length ? (
        <section className="panel">
          <div className="panel-heading">
            <h2>Evaluation evidence</h2>
            <span>Developer-owned checks</span>
          </div>
          {data.evaluations.map((report, index) => (
            <pre className="evaluation-json" key={index}>
              {JSON.stringify(report, null, 2)}
            </pre>
          ))}
        </section>
      ) : null}
      <section className="panel">
        <div className="panel-heading">
          <h2>Feedback groups</h2>
          <span>{data.clusters.length} groups</span>
        </div>
        {data.clusters.map((cluster) => (
          <div className="cluster" key={cluster.id}>
            <span className="count">{cluster.signals.length}</span>
            <div>
              <strong>{cluster.kind}</strong>
              <p>{cluster.signals[0]?.text}</p>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
