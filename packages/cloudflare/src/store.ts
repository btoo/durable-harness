import type { RecordStore } from "@durable-harness/core";

export interface SqlDatabase {
  exec(query: string, ...bindings: (string | number | null)[]): Iterable<Record<string, unknown>>;
  transaction<T>(fn: () => T): T;
}

/** Small record store with real SQLite transactions and a persistent FTS5 index. */
export class SqlRecordStore implements RecordStore {
  constructor(private readonly db: SqlDatabase) {
    db.exec("CREATE TABLE IF NOT EXISTS dh_records (collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection, id))");
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS dh_search USING fts5(collection UNINDEXED, id UNINDEXED, text)");
  }
  get<T>(collection: string, id: string): T | undefined {
    const row = [...this.db.exec("SELECT value FROM dh_records WHERE collection = ? AND id = ?", collection, id)][0];
    return row ? JSON.parse(row.value as string) as T : undefined;
  }
  put<T>(collection: string, id: string, value: T): void {
    const encoded = JSON.stringify(value);
    this.db.exec("INSERT INTO dh_records (collection,id,value) VALUES (?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value = excluded.value", collection, id, encoded);
    if (collection === "history") {
      this.db.exec("DELETE FROM dh_search WHERE collection = ? AND id = ?", collection, id);
      this.db.exec("INSERT INTO dh_search (collection,id,text) VALUES (?,?,?)", collection, id, String((value as { text?: string }).text ?? ""));
    }
  }
  list<T>(collection: string): T[] {
    return [...this.db.exec("SELECT value FROM dh_records WHERE collection = ? ORDER BY rowid", collection)].map(row => JSON.parse(row.value as string) as T);
  }
  delete(collection: string, id: string): void {
    this.db.exec("DELETE FROM dh_records WHERE collection = ? AND id = ?", collection, id);
    if (collection === "history") this.db.exec("DELETE FROM dh_search WHERE collection = ? AND id = ?", collection, id);
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn); }
  search<T>(collection: string, query: string, allowedIds: string[], limit: number): T[] {
    if (!allowedIds.length) return [];
    const terms = query.match(/[\p{L}\p{N}_.:-]+/gu) ?? [];
    if (!terms.length) return [];
    const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    // JSON keeps the bind count bounded; ACL filtering happens before ranking and limiting.
    return [...this.db.exec("SELECT r.value FROM dh_search f JOIN dh_records r ON r.collection = f.collection AND r.id = f.id WHERE dh_search MATCH ? AND f.collection = ? AND f.id IN (SELECT value FROM json_each(?)) ORDER BY bm25(dh_search) LIMIT ?", expression, collection, JSON.stringify(allowedIds), limit)].map(row => JSON.parse(row.value as string) as T);
  }
}

export function durableStore(ctx: DurableObjectState): SqlRecordStore {
  return new SqlRecordStore({ exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings), transaction: fn => ctx.storage.transactionSync(fn) });
}
