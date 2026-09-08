import { z } from "zod";
import { contentHash, invariant } from "@durable-harness/core";

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const runSchema = z
  .object({
    id: uuid,
    team_id: uuid,
    agent_name: z.string(),
    started_at: z.string().nullable(),
    created_at: z.string(),
    instructions_hash: hash.nullable().optional(),
    messages: z.unknown().optional(),
    feedback: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();
export type ObservedRun = z.infer<typeof runSchema>;
export interface ObservationRecord {
  kind: "run" | "prompt" | "workflow" | "cluster-membership";
  id: string;
  teamId: string;
  observedAt: string;
  evidence: "observed";
  source: string;
  data: unknown;
  replay: "partial" | "unsupported";
}
export interface ObservationSink {
  save(record: ObservationRecord): Promise<{ changed: boolean }>;
  recentRuns(teamId: string, limit: number): Promise<{ id: string; startedAt: string }[]>;
  status(status: ObservationStatus): Promise<void>;
}
export interface ObservationStatus {
  startedAt: string;
  completedAt?: string;
  teamIds: string[];
  from: string;
  until: string;
  requests: number;
  records: number;
  changed: number;
  gaps: string[];
}
export interface ObservationOptions {
  baseUrl: string;
  teamIds: string[];
  token: string;
  from?: string;
  until?: string;
  pageSize?: number;
  maxPages?: number;
  maxRequests?: number;
  revisit?: number;
  agentNames?: string[];
  signal?: AbortSignal;
}

/** Verified Didero GET routes only. The collector cannot submit a mutation or follow a redirect. */
export class DideroCollector {
  constructor(
    private readonly sink: ObservationSink,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now = () => new Date(),
  ) {}
  async collect(options: ObservationOptions): Promise<ObservationStatus> {
    const base = new URL(options.baseUrl);
    invariant(
      base.protocol === "https:" &&
        !base.username &&
        !base.password &&
        !base.search &&
        !base.hash &&
        base.pathname === "/",
      "INVALID_INPUT",
      "Use the HTTPS API origin without credentials, a query, or a path.",
    );
    const teamIds = z.array(uuid).min(1).max(10).parse(options.teamIds);
    invariant(
      options.token.length > 0,
      "INVALID_INPUT",
      "Provide the read-only observation credential through the host environment.",
    );
    const until = options.until ?? this.now().toISOString();
    const from = options.from ?? new Date(Date.parse(until) - 86_400_000).toISOString();
    invariant(
      Number.isFinite(Date.parse(from)) &&
        Number.isFinite(Date.parse(until)) &&
        Date.parse(from) < Date.parse(until) &&
        Date.parse(until) - Date.parse(from) <= 31 * 86_400_000,
      "INVALID_INPUT",
      "Select a valid observation window of at most 31 days.",
    );
    const pageSize = z
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(options.pageSize ?? 10);
    const maxPages = z
      .number()
      .int()
      .min(1)
      .max(10)
      .parse(options.maxPages ?? 2);
    const maxRequests = z
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(options.maxRequests ?? 100);
    const revisit = z
      .number()
      .int()
      .min(0)
      .max(100)
      .parse(options.revisit ?? 10);
    const agentNames = z
      .array(z.string().min(1).max(128))
      .max(10)
      .parse(options.agentNames ?? []);
    const status: ObservationStatus = {
      startedAt: this.now().toISOString(),
      teamIds,
      from,
      until,
      requests: 0,
      records: 0,
      changed: 0,
      gaps: [],
    };
    const known = new Map<string, string>();
    const fetchedPrompts = new Set<string>();
    await this.sink.status(status);
    const read = async (
      path: string,
      query: URLSearchParams = new URLSearchParams(),
    ): Promise<unknown> => {
      options.signal?.throwIfAborted();
      invariant(
        status.requests < maxRequests,
        "BUDGET_EXCEEDED",
        "Observation request budget reached.",
      );
      const url = new URL(`/api/v1/admin/${path}`, base);
      url.search = query.toString();
      status.requests++;
      const timeout = AbortSignal.timeout(30_000);
      const response = await this.fetcher(url, {
        method: "GET",
        headers: { authorization: `Bearer ${options.token}`, accept: "application/json" },
        redirect: "error",
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
      invariant(
        response.status >= 200 && response.status < 300,
        "INVALID_INPUT",
        `Observation GET ${path} returned HTTP ${response.status}.`,
      );
      invariant(
        !response.redirected && (!response.url || new URL(response.url).origin === base.origin),
        "ACCESS_DENIED",
        "The observation response redirected or changed origins.",
      );
      const reader = response.body?.getReader();
      invariant(reader, "INVALID_INPUT", "The observation endpoint returned no body.");
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          invariant(
            bytes <= 5_000_000,
            "BUDGET_EXCEEDED",
            "An observation response exceeded 5 MB; narrow the page or window.",
          );
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel();
      }
      return JSON.parse(text);
    };
    const save = async (
      teamId: string,
      kind: ObservationRecord["kind"],
      id: string,
      source: string,
      data: unknown,
      replay: ObservationRecord["replay"] = "unsupported",
    ) => {
      const result = await this.sink.save({
        teamId,
        kind,
        id,
        source,
        data,
        replay,
        evidence: "observed",
        observedAt: this.now().toISOString(),
      });
      status.records++;
      status.changed += Number(result.changed);
    };
    const captureRun = async (teamId: string, id: string, startedAt?: string) => {
      invariant(
        known.get(id) === teamId,
        "ACCESS_DENIED",
        "Read only runs admitted by an allowlisted team query or private observation index.",
      );
      const run = runSchema.parse(await read(`agent-runs/${uuid.parse(id)}`));
      invariant(run.team_id === teamId, "ACCESS_DENIED", "The run detail belongs to another team.");
      if (startedAt)
        invariant(
          (run.started_at ?? run.created_at) === startedAt,
          "INVALID_INPUT",
          "The stored run identity changed its start time.",
        );
      await save(
        teamId,
        "run",
        run.id,
        `agent-runs/${run.id}`,
        { ...run, feedback: run.feedback ?? [] },
        run.instructions_hash && run.messages ? "partial" : "unsupported",
      );
      if (run.instructions_hash && !fetchedPrompts.has(`${teamId}:${run.instructions_hash}`)) {
        try {
          const prompt = z
            .object({ hash, text: z.string(), first_seen_at: z.string() })
            .parse(await read(`prompt-renders/${run.instructions_hash}`));
          invariant(
            prompt.hash === run.instructions_hash,
            "INVALID_INPUT",
            "The prompt endpoint returned a different content identity.",
          );
          invariant(
            (await contentHash(prompt.text)) === prompt.hash,
            "INVALID_INPUT",
            "The prompt bytes do not match their recorded hash.",
          );
          await save(
            teamId,
            "prompt",
            prompt.hash,
            `prompt-renders/${prompt.hash}`,
            prompt,
            "partial",
          );
          fetchedPrompts.add(`${teamId}:${prompt.hash}`);
        } catch (error) {
          status.gaps.push(`Prompt unavailable for run ${run.id}: ${message(error)}`);
        }
      }
      return run.id;
    };
    for (const teamId of teamIds) {
      const captured: string[] = [];
      try {
        for (const agentName of agentNames.length ? agentNames : [undefined]) {
          let cursor: string | null = null;
          for (let page = 0; page < maxPages; page++) {
            const query = new URLSearchParams({
              team_id: teamId,
              started_after: from,
              started_before: until,
              limit: String(pageSize),
              sort_order: "asc",
            });
            if (agentName) query.set("agent_name", agentName);
            if (cursor) query.set("cursor", cursor);
            const result = z
              .object({ items: z.array(runSchema), next_cursor: z.string().nullable().optional() })
              .parse(await read("agent-runs", query));
            for (const run of result.items) {
              const startedAt = run.started_at ?? run.created_at;
              invariant(
                run.team_id === teamId &&
                  Date.parse(startedAt) >= Date.parse(from) &&
                  Date.parse(startedAt) <= Date.parse(until),
                "ACCESS_DENIED",
                "The run list returned data outside the admitted team/window.",
              );
              known.set(run.id, teamId);
              captured.push(await captureRun(teamId, run.id, startedAt));
            }
            cursor = result.next_cursor ?? null;
            if (!cursor) break;
            if (page === maxPages - 1)
              status.gaps.push(`Team ${teamId}: additional run pages were not collected.`);
          }
        }
        for (const prior of await this.sink.recentRuns(teamId, revisit)) {
          if (captured.includes(prior.id)) continue;
          known.set(uuid.parse(prior.id), teamId);
          await captureRun(teamId, prior.id, prior.startedAt);
        }
        if (captured.length) {
          const query = new URLSearchParams({ team_id: teamId });
          for (const id of [...new Set(captured)].slice(0, 200)) query.append("run_ids", id);
          const membership = z
            .object({
              items: z.array(
                z.object({ cluster_id: uuid, matched_run_ids: z.array(uuid) }).passthrough(),
              ),
            })
            .parse(await read("trace-clusters/membership", query));
          invariant(
            membership.items.every((item) =>
              item.matched_run_ids.every((id) => captured.includes(id)),
            ),
            "ACCESS_DENIED",
            "Cluster membership disclosed an unrequested run.",
          );
          await save(
            teamId,
            "cluster-membership",
            `${Date.parse(from)}-${Date.parse(until)}`,
            "trace-clusters/membership",
            membership,
          );
        }
        try {
          const workflow = z
            .object({ team_id: uuid })
            .passthrough()
            .parse(await read(`po-workflows/${teamId}`));
          invariant(
            workflow.team_id === teamId,
            "ACCESS_DENIED",
            "The workflow belongs to another team.",
          );
          await save(teamId, "workflow", teamId, `po-workflows/${teamId}`, workflow);
        } catch (error) {
          status.gaps.push(`Team ${teamId}: current PO workflow unavailable: ${message(error)}`);
        }
      } catch (error) {
        status.gaps.push(`Team ${teamId}: ${message(error)}`);
      }
    }
    status.gaps.push(
      "Current workflow and cluster observations are not historical decision-state snapshots. Replay remains partial or unsupported; feedback is evaluation evidence.",
    );
    status.completedAt = this.now().toISOString();
    await this.sink.status(status);
    return status;
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "Observation failed.";
}

/** Later corrections and approvals never enter the original decision's input context. */
export function separateRunEvidence(run: ObservedRun) {
  const { feedback = [], ...decisionEvidence } = run;
  return {
    decisionEvidence,
    evaluationSignals: feedback.map((value) => ({
      kind: ["approval", "rejection", "correction"].includes(String(value.feedback_type))
        ? value.feedback_type
        : "unclassified",
      sourceId: value.id,
      occurredAt: value.created_at,
      original: value,
    })),
    replay: "partial" as const,
  };
}
