import { AccessPolicy } from "./policy.js";
import { invariant } from "./errors.js";
import type { HarnessEvent, Principal, RecordStore, SourceRef } from "./types.js";

export interface HistoryItem {
  id: string;
  workspaceId: string;
  sequence: number;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  createdAt: string;
  lineage: SourceRef[];
  audience: "customer" | "developer";
  metadata: Record<string, unknown>;
}

export class History {
  private readonly access: AccessPolicy;
  constructor(private readonly store: RecordStore) { this.access = new AccessPolicy(store); }

  append(item: Omit<HistoryItem, "id" | "sequence" | "createdAt"> & { id?: string }): HistoryItem {
    return this.store.transaction(() => {
      if (item.id) {
        const existing = this.store.get<HistoryItem>("history", item.id);
        if (existing) {
          invariant(existing.workspaceId === item.workspaceId && existing.role === item.role && existing.text === item.text && existing.audience === item.audience && JSON.stringify(existing.lineage) === JSON.stringify(item.lineage) && JSON.stringify(existing.metadata) === JSON.stringify(item.metadata), "REPLAY_DIVERGENCE", "This history ID already identifies a different event.");
          return existing;
        }
      }
      const sequence = (this.store.get<number>("counters", "history") ?? 0) + 1;
      const record: HistoryItem = { ...item, id: item.id ?? crypto.randomUUID(), sequence, createdAt: new Date().toISOString() };
      this.store.put("counters", "history", sequence);
      this.store.put("history", record.id, record);
      return record;
    });
  }

  list(principal: Principal, workspaceId: string): HistoryItem[] {
    this.access.require(principal, workspaceId, "read");
    return this.store.list<HistoryItem>("history").filter(item => item.workspaceId === workspaceId && this.canRead(principal, item)).sort((a, b) => a.sequence - b.sequence);
  }

  read(principal: Principal, id: string): HistoryItem {
    const item = this.store.get<HistoryItem>("history", id);
    invariant(item && this.canRead(principal, item), "NOT_FOUND", "No accessible history item exists with that reference.");
    return item;
  }

  around(principal: Principal, id: string, radius = 2): HistoryItem[] {
    const item = this.read(principal, id);
    const items = this.list(principal, item.workspaceId);
    const index = items.findIndex(row => row.id === id);
    return items.slice(Math.max(0, index - radius), index + radius + 1);
  }

  search(principal: Principal, query: string, workspaceIds: string[], limit = 10): HistoryItem[] {
    invariant(query.length > 0 && query.length <= 500, "INVALID_INPUT", "Search requires 1–500 characters.");
    const visible = workspaceIds.flatMap(id => this.list(principal, id));
    const bounded = Math.max(1, Math.min(limit, 20));
    if (this.store.search) return this.store.search<HistoryItem>("history", query, visible.map(item => item.id), bounded);
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return visible.map(item => ({ item, score: terms.reduce((score, term) => score + Number(item.text.toLocaleLowerCase().includes(term)), 0) })).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || b.item.sequence - a.item.sequence).slice(0, bounded).map(hit => hit.item);
  }

  private canRead(principal: Principal, item: HistoryItem): boolean {
    return (item.audience === "customer" || principal.roles.includes("developer")) && this.access.visible(principal, item.workspaceId, item.lineage);
  }
}

/** Persist first, then deliver. Consumers reconnect with the last sequence they received. */
export class EventLog {
  constructor(private readonly store: RecordStore, private readonly publish?: (event: HarnessEvent) => void) {}

  append(event: Omit<HarnessEvent, "id" | "sequence" | "createdAt">): HarnessEvent {
    const record = this.store.transaction(() => {
      const sequence = (this.store.get<number>("counters", "events") ?? 0) + 1;
      const entry: HarnessEvent = { ...event, id: crypto.randomUUID(), sequence, createdAt: new Date().toISOString() };
      this.store.put("counters", "events", sequence);
      this.store.put("events", entry.id, entry);
      return entry;
    });
    try { this.publish?.(record); }
    catch { this.store.put("delivery_gaps", record.id, { eventId: record.id, sequence: record.sequence }); }
    return record;
  }

  read(principal: Principal, workspaceId: string, after = 0): HarnessEvent[] {
    const access = new AccessPolicy(this.store);
    access.require(principal, workspaceId, "read");
    return this.store.list<HarnessEvent>("events").filter(event => event.workspaceId === workspaceId && event.sequence > after && (event.audience === "customer" || principal.roles.includes("developer")) && access.visible(principal, workspaceId, event.lineage)).sort((a, b) => a.sequence - b.sequence);
  }
}
