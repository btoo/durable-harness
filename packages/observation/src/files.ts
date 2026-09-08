import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ObservationRecord, ObservationSink, ObservationStatus } from "./index.js";

interface IndexEntry {
  kind: ObservationRecord["kind"];
  id: string;
  teamId: string;
  hash: string;
  startedAt?: string;
  lastSeenAt: string;
}

/** Private local evidence is never accepted inside a Git working tree. */
export class ObservationFiles implements ObservationSink {
  private index: Record<string, IndexEntry> = {};
  private readonly owner = randomUUID();
  private constructor(private readonly directory: string) {}
  static async open(directory: string): Promise<ObservationFiles> {
    const path = resolve(directory);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const canonical = await realpath(path);
    let ancestor = canonical;
    while (true) {
      let inGit = false;
      try {
        await access(join(ancestor, ".git"));
        inGit = true;
      } catch {}
      if (inGit)
        throw new Error(
          "Private observation data must be outside every Git working tree. Choose a private local directory.",
        );
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    await chmod(canonical, 0o700);
    const files = new ObservationFiles(canonical);
    const lockPath = join(canonical, ".collector.lock");
    try {
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
      if (!Number.isInteger(lock.pid) || lock.pid < 1)
        throw new Error("The observation lock is invalid; inspect it before restarting.");
      let alive = true;
      try {
        process.kill(lock.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        else throw error;
      }
      if (alive)
        throw new Error(
          "Another collector is using this observation directory. Stop that process or choose a separate private directory.",
        );
      await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, owner: files.owner }), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      files.index = JSON.parse(await readFile(join(canonical, "index.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await files.close();
        throw error;
      }
    }
    return files;
  }
  async close(): Promise<void> {
    const path = join(this.directory, ".collector.lock");
    try {
      const lock = JSON.parse(await readFile(path, "utf8"));
      if (lock.owner === this.owner) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async save(record: ObservationRecord): Promise<{ changed: boolean }> {
    const hash = createHash("sha256").update(JSON.stringify(record.data)).digest("hex");
    const key = `${record.teamId}:${record.kind}:${record.id}`;
    const changed = this.index[key]?.hash !== hash;
    if (changed) {
      const path = join(this.directory, `${record.teamId}-${record.kind}-${hash}.json`);
      try {
        await writeFile(path, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const data = record.data as { started_at?: string; created_at?: string };
    this.index[key] = {
      kind: record.kind,
      id: record.id,
      teamId: record.teamId,
      hash,
      lastSeenAt: record.observedAt,
      ...(record.kind === "run" ? { startedAt: data.started_at ?? data.created_at! } : {}),
    };
    await this.atomic("index.json", this.index);
    return { changed };
  }
  async recentRuns(teamId: string, limit: number) {
    return Object.values(this.index)
      .filter((entry) => entry.teamId === teamId && entry.kind === "run" && entry.startedAt)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, limit)
      .map((entry) => ({ id: entry.id, startedAt: entry.startedAt! }));
  }
  async status(status: ObservationStatus): Promise<void> {
    await this.atomic("status.json", status);
  }
  private async atomic(name: string, value: unknown) {
    const pending = join(this.directory, `${name}.pending`);
    await writeFile(pending, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(pending, join(this.directory, name));
  }
}
