import { createRealD1 } from "./realD1";
import { ensureSchema } from "../../src/db/schema";
import { SCHEMA_MANIFEST_READ_SQL } from "../../src/db/schema_versions";
import type { Env } from "../../src/types";

const fixture = createRealD1();
const manifestPrefix = SCHEMA_MANIFEST_READ_SQL.split("FROM (SELECT")[0];
const manifestQueries = new Set<string>();
let manifestSql: string;
let manifest: Record<string, unknown>;
try {
  const DB = { ...fixture.DB, prepare(sql: string) {
    if (sql.startsWith(manifestPrefix)) manifestQueries.add(sql);
    return fixture.DB.prepare(sql);
  } };
  await ensureSchema({ DB } as Env);
  if (manifestQueries.size !== 1) throw new Error("Expected one current schema manifest query");
  manifestSql = [...manifestQueries][0];
  manifest = await fixture.DB.prepare(manifestSql).first();
} finally { fixture.close(); }

export function initializedSchemaDouble<T extends { prepare(sql: string): unknown }>(db: T): T {
  return { batch: async () => { throw new Error("Read-only handler double cannot execute a migration batch"); }, ...db, prepare(sql: string) {
    if (sql !== manifestSql) return db.prepare(sql);
    const statement = { bind() { return statement; }, async first() { return { ...manifest }; } };
    return statement;
  } } as T;
}
