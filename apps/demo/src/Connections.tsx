import { useState } from "react";
import { Link2, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import type { DemoCommand, DemoState } from "./api.js";

type Props = { data: DemoState; busy: boolean; perform(command: DemoCommand): Promise<void> };
export function Connections({ data, busy, perform }: Props) {
  const [name, setName] = useState("Supplier catalog");
  const [url, setUrl] = useState(
    data.connectionPolicy.allowedOrigins[0] ? `${data.connectionPolicy.allowedOrigins[0]}/mcp` : "",
  );
  const [auth, setAuth] = useState<"oauth" | "bearer" | "none">("oauth");
  const [token, setToken] = useState("");
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Connected tools</h2>
          <Link2 size={18} />
        </div>
        <p className="subtitle">
          Choose which accounts and tools this workspace can use. Authorization is retained securely
          between runs.
        </p>
        {!data.connections.length ? <p className="empty-copy">No accounts connected yet.</p> : null}
        {data.connections.map((connection) => (
          <section className="connection-card" key={connection.id}>
            <div className="panel-heading">
              <h3>{connection.name}</h3>
              <span className="status-pill">{connection.state.replaceAll("_", " ")}</span>
            </div>
            <p className="connection-url">{connection.url}</p>
            <dl className="connection-facts">
              <dt>Unattended access</dt>
              <dd>
                {connection.backgroundAccess === "supported"
                  ? "Supported by this authorization"
                  : connection.backgroundAccess === "until_expiry"
                    ? "Until this authorization expires"
                    : "Not established yet"}
              </dd>
              <dt>Tools available</dt>
              <dd>
                {connection.allowedTools.length} of {connection.tools.length} granted
              </dd>
              <dt>Granted scopes</dt>
              <dd>{connection.scopes?.join(", ") || "None reported"}</dd>
            </dl>
            {connection.lastError ? <p role="status">{connection.lastError}</p> : null}
            {connection.authorizationUrl ? (
              <a className="primary inline-button" href={connection.authorizationUrl}>
                Authorize account <Link2 size={14} />
              </a>
            ) : null}
            {connection.state !== "revoked" ? (
              <>
                <div className="button-row">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform({ action: "mcp-discover", connectionId: connection.id })
                    }
                  >
                    <RefreshCw size={14} />
                    Refresh connection
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void perform({ action: "mcp-revoke", connectionId: connection.id })
                    }
                  >
                    <Unplug size={14} />
                    Revoke
                  </button>
                </div>
                {connection.state === "ready" || connection.state === "schema_changed" ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const fields = new FormData(event.currentTarget);
                      void perform({
                        action: "mcp-grant",
                        connectionId: connection.id,
                        tools: fields.getAll("tool").map(String),
                        fingerprint: connection.fingerprint,
                      });
                    }}
                    key={`${connection.id}:${connection.revision}:${connection.fingerprint}`}
                  >
                    <fieldset className="tool-grants">
                      <legend>Allow the agent to use</legend>
                      {connection.tools.map((tool) => (
                        <label key={tool.name}>
                          <input
                            type="checkbox"
                            name="tool"
                            value={tool.name}
                            defaultChecked={connection.allowedTools.includes(tool.name)}
                          />
                          <span>
                            <strong>{tool.name}</strong>
                            <small>{tool.description}</small>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                    <button className="secondary" disabled={busy}>
                      <ShieldCheck size={14} />
                      Save tool access
                    </button>
                    <p className="caption">
                      Imported tools require action approval by default. Actions use only this
                      connection’s authorization.
                    </p>
                  </form>
                ) : null}
              </>
            ) : null}
          </section>
        ))}
      </section>
      <form
        className="panel connection-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const accessToken = token;
          setToken("");
          await perform({
            action: "mcp-add",
            name,
            url,
            auth,
            ...(auth === "bearer" ? { accessToken } : {}),
          });
        }}
      >
        <h2>Connect an MCP server</h2>
        <p className="caption">
          The deployment owner controls the allowed endpoints. This public experiment accepts
          synthetic services only.
        </p>
        <label>
          Connection name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          HTTPS endpoint
          <input
            required
            type="url"
            maxLength={2000}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://your-server.example/mcp"
          />
        </label>
        <label>
          Authorization
          <select value={auth} onChange={(event) => setAuth(event.target.value as typeof auth)}>
            <option value="oauth">Sign in with OAuth</option>
            <option value="bearer">Service token</option>
            <option value="none">No authorization</option>
          </select>
        </label>
        {auth === "bearer" ? (
          <label>
            Service token
            <input
              required
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
        ) : null}
        <button className="primary" disabled={busy || !data.connectionPolicy.allowedOrigins.length}>
          <Link2 size={15} />
          Connect account
        </button>
        <p className="caption">
          {data.connectionPolicy.allowedOrigins.length
            ? `Allowed origins: ${data.connectionPolicy.allowedOrigins.join(", ")}`
            : "No MCP origins have been enabled for this deployment yet."}
        </p>
      </form>
    </>
  );
}
