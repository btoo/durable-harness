import { invariant } from "./errors.js";
import type { RecordStore } from "./types.js";

export interface RunLimits {
  steps: number;
  tokens: number;
  activeMs: number;
  descendants: number;
}
export interface RootRun {
  id: string;
  limits: RunLimits;
  steps: number;
  reservedTokens: number;
  usedTokens: number;
  activeMs: number;
  activeSince: number | null;
  descendants: number;
  status: "active" | "paused" | "completed";
}
export const DEFAULT_RUN_LIMITS: RunLimits = {
  steps: 8,
  tokens: 48_000,
  activeMs: 120_000,
  descendants: 12,
};

/** A root reservation covers every child. Unknown interrupted usage remains reserved. */
export class RunBudgets {
  constructor(
    private readonly store: RecordStore,
    private readonly now = () => Date.now(),
  ) {}
  start(id: string, limits: RunLimits = DEFAULT_RUN_LIMITS): RootRun {
    const existing = this.store.get<RootRun>("root_runs", id);
    if (existing) return existing;
    for (const limit of Object.values(limits))
      invariant(
        Number.isInteger(limit) && limit > 0,
        "INVALID_INPUT",
        "Run limits must be finite positive integers.",
      );
    const run: RootRun = {
      id,
      limits,
      steps: 0,
      reservedTokens: 0,
      usedTokens: 0,
      activeMs: 0,
      activeSince: this.now(),
      descendants: 0,
      status: "active",
    };
    this.store.put("root_runs", id, run);
    return run;
  }
  read(id: string): RootRun {
    const run = this.store.get<RootRun>("root_runs", id);
    invariant(run, "NOT_FOUND", "The root run does not exist.");
    return run;
  }
  reserve(id: string, stepId: string, maxTokens: number): void {
    invariant(
      Number.isInteger(maxTokens) && maxTokens > 0,
      "INVALID_INPUT",
      "Reserve a positive token bound before requesting a model step.",
    );
    this.store.transaction(() => {
      invariant(
        !this.store.get("budget_steps", `${id}:${stepId}`),
        "INVALID_INPUT",
        "This model step has already been admitted. Recover its result or account for a new attempt.",
      );
      const run = this.read(id);
      invariant(
        run.status === "active",
        "BUDGET_EXCEEDED",
        "Resume this run before admitting another model step.",
      );
      invariant(
        run.steps < run.limits.steps &&
          run.usedTokens + run.reservedTokens + maxTokens <= run.limits.tokens &&
          this.elapsed(run) < run.limits.activeMs,
        "BUDGET_EXCEEDED",
        "This root run reached its step, token, or active-time budget. Its progress remains saved.",
      );
      this.store.put("root_runs", id, {
        ...run,
        steps: run.steps + 1,
        reservedTokens: run.reservedTokens + maxTokens,
      });
      this.store.put("budget_steps", `${id}:${stepId}`, { reserved: maxTokens, settled: false });
    });
  }
  settle(id: string, stepId: string, used: number): void {
    invariant(
      Number.isFinite(used) && used >= 0,
      "INVALID_INPUT",
      "Reported token usage must be nonnegative.",
    );
    this.store.transaction(() => {
      const step = this.store.get<{ reserved: number; settled: boolean }>(
        "budget_steps",
        `${id}:${stepId}`,
      );
      invariant(step, "NOT_FOUND", "The model step has no reservation.");
      if (step.settled) return;
      const run = this.read(id);
      this.store.put("root_runs", id, {
        ...run,
        reservedTokens: run.reservedTokens - step.reserved,
        usedTokens: run.usedTokens + used,
      });
      this.store.put("budget_steps", `${id}:${stepId}`, { ...step, settled: true, used });
    });
  }
  addDescendant(id: string): void {
    const run = this.read(id);
    invariant(
      run.status !== "completed" && run.descendants < run.limits.descendants,
      "BUDGET_EXCEEDED",
      "This root run reached its delegation budget.",
    );
    this.store.put("root_runs", id, { ...run, descendants: run.descendants + 1 });
  }
  pause(id: string): void {
    this.transition(id, "paused");
  }
  resume(id: string): void {
    this.transition(id, "active");
  }
  complete(id: string): void {
    this.transition(id, "completed");
  }
  private elapsed(run: RootRun): number {
    return (
      run.activeMs + (run.activeSince === null ? 0 : Math.max(0, this.now() - run.activeSince))
    );
  }
  private transition(id: string, status: RootRun["status"]): void {
    const run = this.read(id);
    invariant(
      run.status !== "completed" || status === "completed",
      "INVALID_INPUT",
      "A completed root run cannot be resumed.",
    );
    this.store.put("root_runs", id, {
      ...run,
      activeMs: this.elapsed(run),
      activeSince: status === "active" ? this.now() : null,
      status,
    });
  }
}
