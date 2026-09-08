import { useState } from "react";
import { Play, Terminal } from "lucide-react";
import type { DemoCommand, DemoState } from "./api.js";

export function ModelRun({
  data,
  busy,
  perform,
}: {
  data: DemoState;
  busy: boolean;
  perform(command: DemoCommand, operatorToken?: string): Promise<void>;
}) {
  const [message, setMessage] = useState(
    "Inspect the evidence and customer preferences. Create a useful working structure and a reusable helper, then verify the retained result. Ask before contacting suppliers.",
  );
  const [token, setToken] = useState("");
  return (
    <form
      className="panel model-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const operatorToken = token;
        setToken("");
        await perform({ action: "model", message, requestId: crypto.randomUUID() }, operatorToken);
      }}
    >
      <div className="panel-heading">
        <h2>Ask the agent</h2>
        <Terminal size={17} />
      </div>
      <p className="caption">
        Real inference on synthetic business data. Your request is durably queued and streams into
        this conversation.
      </p>
      <label htmlFor="model-request">Request</label>
      <textarea
        id="model-request"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        rows={4}
        required
        maxLength={8000}
      />
      <label htmlFor="operator-token">Operator token</label>
      <input
        id="operator-token"
        type="password"
        autoComplete="off"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        required
        placeholder="Deployment ADMIN_TOKEN"
      />
      <p className="caption">
        The token authorizes this paid experiment and is cleared after submission. Each root run is
        limited to {data.model.limits.steps} steps, {data.model.limits.tokens.toLocaleString()}{" "}
        tokens, and {data.model.limits.activeMs / 1000} seconds of active work.
      </p>
      <button className="primary" disabled={busy}>
        <Play size={14} />
        Start agent run
      </button>
      <p className="model-label">{data.model.id}</p>
    </form>
  );
}
