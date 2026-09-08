import { HarnessFault } from "@durable-harness/core";

/** RPC results carry disposal symbols. The model boundary accepts detached JSON only. */
export function modelData<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    throw new HarnessFault(
      "INVALID_TOOL_RESULT",
      "The model result is not JSON data. Encode binary values and reference graphs before returning them.",
    );
  }
}
