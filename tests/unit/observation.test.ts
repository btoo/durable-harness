import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DideroCollector,
  separateRunEvidence,
  type ObservationRecord,
  type ObservationSink,
  type ObservationStatus,
} from "@durable-harness/observation";
import { ObservationFiles } from "../../packages/observation/src/files.js";

const team = "10000000-0000-4000-8000-000000000001";
const otherTeam = "10000000-0000-4000-8000-000000000002";
const runId = "20000000-0000-4000-8000-000000000001";
const run = {
  id: runId,
  team_id: team,
  agent_name: "quoting",
  started_at: "2026-09-07T10:00:00Z",
  created_at: "2026-09-07T10:00:00Z",
  messages: [{ role: "user", content: "Compare the offers." }],
  feedback: [
    {
      id: "feedback-1",
      feedback_type: "correction",
      created_at: "2026-09-07T11:00:00Z",
      comment: "Include freight.",
    },
  ],
};
const options = {
  baseUrl: "https://observer.example.test",
  teamIds: [team],
  token: "synthetic-observation-token",
  from: "2026-09-07T00:00:00Z",
  until: "2026-09-08T00:00:00Z",
  revisit: 0,
};
function memorySink() {
  const records: ObservationRecord[] = [];
  let latest: ObservationStatus | undefined;
  const sink: ObservationSink = {
    save: async (record) => {
      records.push(record);
      return { changed: true };
    },
    recentRuns: async () => [],
    status: async (status) => {
      latest = structuredClone(status);
    },
  };
  return { sink, records, status: () => latest };
}

describe("read-only observation boundaries", () => {
  it("only issues bounded GETs for admitted teams and separates delayed feedback", async () => {
    const { sink, records, status } = memorySink();
    const requests: { url: string; method: string; redirect: string }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url: url.toString(), method: init!.method!, redirect: init!.redirect! });
      if (url.pathname.endsWith("/agent-runs")) {
        expect(url.searchParams.get("team_id")).toBe(team);
        return Response.json({ items: [run], next_cursor: null });
      }
      if (url.pathname.endsWith(runId)) return Response.json(run);
      if (url.pathname.endsWith("/membership")) return Response.json({ items: [] });
      if (url.pathname.endsWith(`/po-workflows/${team}`))
        return Response.json({ team_id: team, version: 1 });
      throw new Error("An unverified endpoint was requested.");
    }) as typeof fetch;
    await new DideroCollector(sink, fetcher).collect(options);
    expect(requests).toHaveLength(4);
    expect(
      requests.every((request) => request.method === "GET" && request.redirect === "error"),
    ).toBe(true);
    expect(records.map((record) => record.kind)).toEqual(["run", "cluster-membership", "workflow"]);
    expect(status()?.requests).toBe(4);
    const separated = separateRunEvidence(run);
    expect("feedback" in separated.decisionEvidence).toBe(false);
    expect(separated.evaluationSignals[0]?.kind).toBe("correction");
  });
  it("refuses out-of-scope records before any detail read or storage", async () => {
    const { sink, records } = memorySink();
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return Response.json({ items: [{ ...run, team_id: otherTeam }], next_cursor: null });
    }) as typeof fetch;
    const status = await new DideroCollector(sink, fetcher).collect(options);
    expect(calls).toBe(1);
    expect(records).toEqual([]);
    expect(status.gaps.some((gap) => gap.includes("outside the admitted"))).toBe(true);
  });
  it("does not follow redirects and stops when its request budget is consumed", async () => {
    const redirected = memorySink();
    const status = await new DideroCollector(
      redirected.sink,
      (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example.test" },
        })) as typeof fetch,
    ).collect(options);
    expect(status.requests).toBe(1);
    expect(redirected.records).toEqual([]);
    const budgeted = memorySink();
    let calls = 0;
    const limited = await new DideroCollector(budgeted.sink, (async () => {
      calls++;
      return Response.json({ items: [run], next_cursor: "more" });
    }) as typeof fetch).collect({ ...options, maxRequests: 1 });
    expect(calls).toBe(1);
    expect(limited.gaps.some((gap) => gap.includes("request budget"))).toBe(true);
  });
});

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
it("stores deduplicated private observations outside Git and retains late-feedback revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "dh-observe-"));
  directories.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await expect(ObservationFiles.open(join(repo, "private"))).rejects.toThrow("outside every Git");
  const output = join(root, "observations");
  const files = await ObservationFiles.open(output);
  await expect(ObservationFiles.open(output)).rejects.toThrow("Another collector");
  const record: ObservationRecord = {
    kind: "run",
    id: runId,
    teamId: team,
    observedAt: "2026-09-08T00:00:00Z",
    evidence: "observed",
    source: `agent-runs/${runId}`,
    data: run,
    replay: "partial",
  };
  expect(await files.save(record)).toEqual({ changed: true });
  expect(await files.save({ ...record, observedAt: "2026-09-08T01:00:00Z" })).toEqual({
    changed: false,
  });
  await files.save({
    ...record,
    data: { ...run, feedback: [...run.feedback, { feedback_type: "approval" }] },
  });
  expect((await readdir(output)).filter((name) => name.startsWith(team))).toHaveLength(2);
  expect(await files.recentRuns(team, 5)).toEqual([{ id: runId, startedAt: run.started_at }]);
  expect(await readFile(join(output, "index.json"), "utf8")).not.toContain(options.token);
  await files.close();
  const reopened = await ObservationFiles.open(output);
  expect(await reopened.recentRuns(team, 5)).toHaveLength(1);
  await reopened.close();
});
