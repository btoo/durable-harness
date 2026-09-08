export type FaultCode =
  | "ACCESS_DENIED"
  | "INVALID_INPUT"
  | "UNSUPPORTED_VALUE"
  | "UNSUPPORTED_CAPTURE"
  | "INVALID_CELL"
  | "INVALID_TOOL_RESULT"
  | "NOT_CONFIGURED"
  | "WORKSPACE_BUSY"
  | "STALE_REVISION"
  | "REPLAY_DIVERGENCE"
  | "EFFECT_UNCERTAIN"
  | "APPROVAL_REQUIRED"
  | "RECONNECTION_REQUIRED"
  | "BUDGET_EXCEEDED"
  | "NOT_FOUND"
  | "EVALUATION_REQUIRED"
  | "SHARING_REVIEW_REQUIRED";

/** Errors are actionable data at API boundaries, never an invitation to retry blindly. */
export class HarnessFault extends Error {
  constructor(
    public readonly code: FaultCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HarnessFault";
  }
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function invariant(condition: unknown, code: FaultCode, message: string): asserts condition {
  if (!condition) throw new HarnessFault(code, message);
}

export function asFault(error: unknown): HarnessFault {
  if (error instanceof HarnessFault) return error;
  const message = error instanceof Error ? error.message : String(error);
  // The self-contained graph codec can only return this diagnostic across a sandbox.
  // Provider and user-controlled error strings must never manufacture a retry/approval state.
  const match = /^\[UNSUPPORTED_VALUE\]\s*([\s\S]*)$/.exec(message);
  return new HarnessFault(match ? "UNSUPPORTED_VALUE" : "INVALID_CELL", match?.[1] ?? message);
}
