import { useState } from "react";
import { Code2, Play, Share2, ShieldCheck } from "lucide-react";
import type { DemoCommand, DemoState } from "./api.js";

export function Capabilities({
  data,
  busy,
  perform,
}: {
  data: DemoState;
  busy: boolean;
  perform(command: DemoCommand): Promise<void>;
}) {
  const [helper, setHelper] = useState(data.workspace?.functions[0]?.name ?? "");
  const [name, setName] = useState("quote-comparison");
  const [protocol, setProtocol] = useState<"rank-offers-v1" | "analyze-offers-v1">(
    "rank-offers-v1",
  );
  const developer = data.persona === "developer";
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Reviewed capabilities</h2>
          <Code2 size={18} />
        </div>
        <p className="subtitle">
          Reusable code has its own tests and approval. Sharing it with another customer is a
          separate decision.
        </p>
        {!data.capabilities.length ? (
          <p className="empty-copy">No capabilities have been proposed yet.</p>
        ) : null}
        {data.capabilities.map((capability) => (
          <article className="connection-card" key={capability.id}>
            <div className="panel-heading">
              <h3>{capability.name}</h3>
              <span className="status-pill">{capability.status}</span>
            </div>
            <p className="caption">
              {capability.spaceId === "shared-library" ? "Shared library" : capability.spaceId} ·
              version {capability.revision || "proposed"} · {capability.hash.slice(0, 12)}
            </p>
            <details className="cell-record">
              <summary>Source and dependencies</summary>
              {Object.values(capability.program.modules).map((module) => (
                <pre key={module.version}>{module.source}</pre>
              ))}
            </details>
            {capability.evaluation ? (
              <p className="caption">
                {capability.evaluation.checks.filter((check) => check.passed).length} of{" "}
                {capability.evaluation.checks.length} protocol checks passed
              </p>
            ) : null}
            <div className="button-row">
              {developer && ["proposed", "evaluated"].includes(capability.status) ? (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void perform({ action: "evaluate-capability", id: capability.id })}
                >
                  Run checks
                </button>
              ) : null}
              {developer && capability.status === "evaluated" ? (
                <button
                  className="primary"
                  disabled={busy || !capability.evaluation?.checks.every((check) => check.passed)}
                  onClick={() => void perform({ action: "approve-capability", id: capability.id })}
                >
                  <ShieldCheck size={14} />
                  Approve for this workspace
                </button>
              ) : null}
              {developer && capability.status === "approved" ? (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void perform({
                      action: "publish-capability",
                      id: capability.id,
                      expectedRevision: Math.max(
                        0,
                        ...data.capabilities
                          .filter(
                            (value) =>
                              value.spaceId === "shared-library" && value.name === capability.name,
                          )
                          .map((value) => value.revision),
                      ),
                    })
                  }
                >
                  <Share2 size={14} />
                  Publish to shared library
                </button>
              ) : null}
              {["approved", "published"].includes(capability.status) ? (
                <button
                  className="secondary"
                  disabled={busy || !data.selected.includes("quoting")}
                  onClick={() => void perform({ action: "use-capability", id: capability.id })}
                >
                  <Play size={14} />
                  Compare current quotes
                </button>
              ) : null}
            </div>
            {developer && capability.status === "approved" ? (
              <p className="caption">
                Publishing grants Northstar and Cedar access to all source code in this package.
                Review the source and dependencies first.
              </p>
            ) : null}
          </article>
        ))}
      </section>
      {developer ? (
        <form
          className="panel connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            void perform({
              action: "propose-capability",
              helperName: helper,
              name,
              protocolId: protocol,
            });
          }}
        >
          <h2>Turn a retained helper into a capability</h2>
          <label>
            Helper
            <select required value={helper} onChange={(event) => setHelper(event.target.value)}>
              <option value="" disabled>
                Select a retained helper
              </option>
              {data.workspace?.functions.map((value) => (
                <option key={value.name}>{value.name}</option>
              ))}
            </select>
          </label>
          <label>
            Capability name
            <input
              required
              pattern="[a-z][a-z0-9-]*"
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Evaluation protocol
            <select
              value={protocol}
              onChange={(event) => setProtocol(event.target.value as typeof protocol)}
            >
              <option value="rank-offers-v1">Ranked offers array</option>
              <option value="analyze-offers-v1">Quote analysis object</option>
            </select>
          </label>
          <p className="caption">
            The protocol fixes the input contract and evaluation cases. Published helpers receive
            caller data and cannot make host I/O calls.
          </p>
          <button className="primary" disabled={busy || !helper}>
            Propose capability
          </button>
        </form>
      ) : null}
    </>
  );
}
