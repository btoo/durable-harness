import { useState } from "react";
import { Database, LockKeyhole, Share2 } from "lucide-react";
import type { DemoCommand, DemoState } from "./api.js";

export function Knowledge({
  data,
  busy,
  perform,
}: {
  data: DemoState;
  busy: boolean;
  perform(command: DemoCommand): Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const developer = data.persona === "developer";
  const space = data.knowledgeSpaces.find((value) => value.id === data.selected)!;
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Private knowledge</h2>
          <LockKeyhole size={18} />
        </div>
        <p className="subtitle">
          Notes stay within their knowledge space. Source restrictions follow derived work.
        </p>
        {!data.memories.length ? (
          <p className="empty-copy">No notes have been retained in this workspace.</p>
        ) : null}
        {data.memories.map((memory) => (
          <article className="connection-card" key={memory.id}>
            <h3>{memory.title}</h3>
            <pre>
              {typeof memory.value === "string"
                ? memory.value
                : JSON.stringify(memory.value, null, 2)}
            </pre>
            <p className="caption">
              Version {memory.revision} · {memory.lineage.length} source references
            </p>
            {developer ? (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void perform({ action: "publish-memory", id: memory.id })}
              >
                <Share2 size={14} />
                Publish reviewed copy
              </button>
            ) : null}
          </article>
        ))}
        {developer ? (
          <p className="caption">
            Publishing a note makes its full title and value available to both demo customers. This
            is separate from approving a behavior change.
          </p>
        ) : null}
      </section>
      <form
        className="panel connection-form"
        onSubmit={async (event) => {
          event.preventDefault();
          await perform({ action: "save-memory", title, text });
          setTitle("");
          setText("");
        }}
      >
        <h2>Retain a note</h2>
        <label>
          Title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={160}
            required
          />
        </label>
        <label>
          Note
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={4000}
            rows={3}
            required
          />
        </label>
        <button className="primary" disabled={busy}>
          Save to this workspace
        </button>
      </form>
      <section className="panel">
        <div className="panel-heading">
          <h2>Shared knowledge</h2>
          <Database size={18} />
        </div>
        {data.sharedMemories.length ? (
          data.sharedMemories.map((memory) => (
            <article className="connection-card" key={memory.id}>
              <h3>{memory.title}</h3>
              <pre>
                {typeof memory.value === "string"
                  ? memory.value
                  : JSON.stringify(memory.value, null, 2)}
              </pre>
            </article>
          ))
        ) : (
          <p className="empty-copy">No knowledge has been published to the shared library.</p>
        )}
      </section>
      {developer ? (
        <section className="panel">
          <div className="panel-heading">
            <h2>Workspace access</h2>
            <span className="tiny-tag">revision {space.revision}</span>
          </div>
          <p className="caption">
            Changes apply to retrieval, execution, and live subscriptions. Developer access is
            retained for this synthetic experiment.
          </p>
          {(["northstar", "cedar"] as const).map((principalId) => (
            <form
              className="permission-row"
              key={`${principalId}:${space.revision}`}
              onSubmit={(event) => {
                event.preventDefault();
                const fields = new FormData(event.currentTarget);
                void perform({
                  action: "set-customer-access",
                  principalId,
                  permissions: fields.getAll("permission") as ("read" | "write" | "execute")[],
                  expectedRevision: space.revision,
                });
              }}
            >
              <strong>{principalId === "northstar" ? "Northstar" : "Cedar"}</strong>
              {(["read", "write", "execute"] as const).map((permission) => (
                <label key={permission}>
                  <input
                    type="checkbox"
                    name="permission"
                    value={permission}
                    defaultChecked={space.grants?.some(
                      (grant) =>
                        grant.principalId === principalId && grant.permissions.includes(permission),
                    )}
                  />
                  {permission}
                </label>
              ))}
              <button className="secondary" disabled={busy}>
                Update access
              </button>
            </form>
          ))}
        </section>
      ) : null}
    </>
  );
}
