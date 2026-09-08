import { DatabaseSync } from "node:sqlite";
import { SqlRecordStore } from "../../packages/cloudflare/src/store.js";
import type { KnowledgeSpace, Principal } from "@durable-harness/core";

export const dev: Principal = { id: "dev", deploymentId: "demo", roles: ["developer"] };
export const buyerA: Principal = { id: "buyer-a", deploymentId: "demo", roles: ["customer"] };
export const buyerB: Principal = { id: "buyer-b", deploymentId: "demo", roles: ["customer"] };

export function database() {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  const store = new SqlRecordStore({
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      return statement.columns().length
        ? statement.all(...bindings)
        : (statement.run(...bindings), []);
    },
    transaction(fn) {
      const name = `t${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        depth--;
      }
    },
  });
  for (const [id, buyer] of [
    ["a", buyerA],
    ["b", buyerB],
    ["shared", buyerB],
  ] as const) {
    const space: KnowledgeSpace = {
      id,
      deploymentId: "demo",
      label: id,
      kind: id === "shared" ? "shared" : "tenant",
      revision: 1,
      grants: [
        { principalId: dev.id, permissions: ["read", "write", "publish", "execute"] },
        { principalId: buyer.id, permissions: ["read", "write", "execute"] },
      ],
    };
    store.put("spaces", id, space);
  }
  return { store, close: () => db.close() };
}
