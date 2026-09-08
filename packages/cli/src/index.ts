import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { DideroCollector } from "@durable-harness/observation";
import { ObservationFiles } from "../../observation/src/files.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean" },
    origin: { type: "string" },
    team: { type: "string", multiple: true },
    agent: { type: "string", multiple: true },
    from: { type: "string" },
    until: { type: "string" },
    output: { type: "string" },
    "max-requests": { type: "string" },
    "max-pages": { type: "string" },
    "page-size": { type: "string" },
    interval: { type: "string" },
  },
});
if (values.help || !positionals.length) {
  console.log(
    `durable-harness experimental CLI\n\nobserve --origin https://your-api.example --team UUID [--team UUID]\nwatch   --origin https://your-api.example --team UUID [--interval 300]\n\nOptional: --agent NAME --from ISO --until ISO --output PRIVATE_DIRECTORY\n          --max-requests 100 --max-pages 2 --page-size 10\n\nCredential: DIDERO_OBSERVATION_TOKEN environment variable.\nDefault window: the previous 24 hours. Requests are serial, GET-only, and reject redirects.\nWatch mode runs only while this explicitly launched process is active; Ctrl+C stops it.`,
  );
} else {
  if (
    !positionals.every((position) => ["observe", "watch"].includes(position)) ||
    positionals.length !== 1
  )
    throw new Error("Choose observe or watch. Use --help for options.");
  if (!values.origin || !values.team?.length)
    throw new Error("Observation requires an explicit --origin and at least one --team UUID.");
  const token = process.env.DIDERO_OBSERVATION_TOKEN;
  if (!token)
    throw new Error(
      "Set DIDERO_OBSERVATION_TOKEN in the local environment. Do not pass credentials as command-line arguments.",
    );
  const interval = Number(values.interval ?? 300);
  if (!Number.isFinite(interval) || interval < 60 || interval > 86400)
    throw new Error("Watch interval must be between 60 and 86,400 seconds.");
  const sink = await ObservationFiles.open(
    values.output ?? join(homedir(), ".local/share/durable-harness/observations"),
  );
  const collector = new DideroCollector(sink);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    do {
      const status = await collector.collect({
        baseUrl: values.origin,
        teamIds: values.team,
        token,
        signal: controller.signal,
        ...(values.agent ? { agentNames: values.agent } : {}),
        ...(values.from ? { from: values.from } : {}),
        ...(values.until ? { until: values.until } : {}),
        ...(values["max-requests"] ? { maxRequests: Number(values["max-requests"]) } : {}),
        ...(values["max-pages"] ? { maxPages: Number(values["max-pages"]) } : {}),
        ...(values["page-size"] ? { pageSize: Number(values["page-size"]) } : {}),
      });
      console.log(JSON.stringify(status, null, 2));
      if (positionals[0] !== "watch" || controller.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, interval * 1000);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    } while (!controller.signal.aborted);
  } finally {
    await sink.close();
  }
}
