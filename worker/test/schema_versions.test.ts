import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { ensureSchema, migrateSchema, resetSchemaCache, INIT_STATEMENTS, MIGRATION_ALTERS, SCHEMA_DEFINITION } from "../src/db/schema";
import { migrateVersionedSchema, SCHEMA_MANIFEST_READ_SQL, SCHEMA_VERSION_DDL } from "../src/db/schema_versions";
import type { Env } from "../src/types";


const open: RealD1[] = [];
function database(empty = false) { const d = createRealD1(empty ? { init: [], alters: [] } : {}); open.push(d); return d; }
const env = (DB: D1Database) => ({ DB }) as Env;
afterEach(() => { resetSchemaCache(); for (const d of open.splice(0)) d.close(); vi.restoreAllMocks(); });

function instrument(d: RealD1) {
  const reads: string[] = [], batches: string[][] = [];
  const DB = {
    prepare(sql: string) {
      const s = d.DB.prepare(sql);
      const wrapped = { ...s, bind: (...args: unknown[]) => { s.bind(...args); return wrapped; },
        first: async () => { reads.push(sql); const result = await d.DB.batch([s]); return result[0].results[0] ?? null; },
        all: async () => { reads.push(sql); return s.all(); } };
      return wrapped;
    },
    batch: async (statements: { sql: string }[]) => { batches.push(statements.map(s => s.sql)); return d.DB.batch(statements); },
  } as unknown as D1Database;
  return { DB, reads, batches };
}

function seed(d: RealD1) {
  d.sql("INSERT INTO providers(id,name,type) VALUES('p','old','openai')");
  d.sql("INSERT INTO models(id,provider_id,model_name,input_price_per_m,output_price_per_m,pricing_mode) VALUES('priced','p','priced',3,15,'priced'),('zero','p','zero',0,0,'free'),('unset','p','unset',0,0,'unset'),('legacy','p','legacy',2,0,'unset')");
  d.sql("INSERT INTO devices(id,name,token_hash,cost_limit_monthly) VALUES('funded','funded','funded',99),('zero','zero','zero',55),('missing','missing','missing',7)");
  d.sql("INSERT INTO device_wallets(device_id,balance_usd,reserved_usd) VALUES('funded',12.5,0.25),('zero',0,0)");
  d.sql("INSERT INTO service_groups(id,name) VALUES('g','group')");
  d.sql("INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id,pricing_json) VALUES('mapping','g','reserved-name','model','priced','{}')");
  d.sql("INSERT INTO public_model_identities(id,name,enabled) VALUES('reserved','reserved-name',0)");
}

describe("durable core schema versions", () => {
  it("creates a truly empty database and makes applied cold readiness one indexed read, warm zero", async () => {
    const d = database(true), t = instrument(d);
    const promises = Array.from({ length: 20 }, () => ensureSchema(env(t.DB)));
    expect(promises.every(p => p === promises[0])).toBe(true);
    await Promise.all(promises);
    expect(d.rows("SELECT id,completed,length(checksum) AS checksum FROM cpg_schema_versions ORDER BY id")).toEqual([
      { id: "admin-record/0001-query-indexes", completed: 1, checksum: 64 },
      { id: "core/0001-tables", completed: 1, checksum: 64 }, { id: "core/0002-columns", completed: 1, checksum: 64 }, { id: "core/0003-ready", completed: 1, checksum: 64 },
      { id: "monthly/0001-tables", completed: 1, checksum: 64 }, { id: "monthly/0002-funding", completed: 1, checksum: 64 },
      { id: "monthly/0003-operations", completed: 1, checksum: 64 }, { id: "monthly/0004-operation-apply", completed: 1, checksum: 64 }, { id: "monthly/0005-retention", completed: 1, checksum: 64 },
      { id: "usage/0001-tables", completed: 1, checksum: 64 }, { id: "usage/0002-rollups", completed: 1, checksum: 64 },
      { id: "video/0001-upstream-usage", completed: 1, checksum: 64 },
    ]);
    expect(d.row("SELECT name FROM sqlite_master WHERE name='billing_requests'")).not.toBeNull();
    expect(d.row("SELECT name FROM sqlite_master WHERE name='token_routing_policies'")).not.toBeNull();
    const before = { reads: t.reads.length, batches: t.batches.length };
    await ensureSchema(env(t.DB));
    expect(t.reads.length).toBe(before.reads); expect(t.batches.length).toBe(before.batches);
    const cold = instrument(d); await ensureSchema(env(cold.DB));
    expect(cold.reads).toHaveLength(1); expect(cold.reads[0]).toContain("ORDER BY id LIMIT 13"); expect(SCHEMA_MANIFEST_READ_SQL).toContain("ORDER BY id LIMIT 4"); expect(cold.batches).toHaveLength(0);
    const explain = d.rows<{ detail: string }>("EXPLAIN QUERY PLAN " + cold.reads[0]);
    expect(explain.some(r => /SEARCH.*INDEX/.test(r.detail))).toBe(true);
  });

  it("verifies legacy postconditions, preserves custom prices/explicit zero/wallet balances and reserved aliases", async () => {
    const d = database(); seed(d);
    const beforeModels = d.rows("SELECT * FROM models WHERE id<>'legacy' ORDER BY id");
    const beforeWallets = d.rows("SELECT * FROM device_wallets ORDER BY device_id");
    const beforeAliases = d.rows("SELECT * FROM public_model_identities ORDER BY id");
    await ensureSchema(env(d.DB));
    expect(d.rows("SELECT * FROM models WHERE id<>'legacy' ORDER BY id")).toEqual(beforeModels);
    expect(d.rows("SELECT * FROM device_wallets WHERE device_id<>'missing' ORDER BY device_id")).toEqual(beforeWallets);
    expect(d.rows("SELECT * FROM public_model_identities ORDER BY id")).toEqual(beforeAliases);
    expect(d.row("SELECT pricing_mode FROM models WHERE id='legacy'")).toEqual({ pricing_mode: "priced" });
    expect(d.row("SELECT balance_usd,reserved_usd FROM device_wallets WHERE device_id='missing'")).toEqual({ balance_usd: 7, reserved_usd: 0 });
    d.sql("UPDATE models SET pricing_mode='unset' WHERE id='legacy'");
    d.sql("DELETE FROM device_wallets WHERE device_id='missing'");
    const cold = instrument(d); await ensureSchema(env(cold.DB));
    expect(cold.batches).toHaveLength(0);
    expect(d.row("SELECT pricing_mode FROM models WHERE id='legacy'")).toEqual({ pricing_mode: "unset" });
    expect(d.row("SELECT * FROM device_wallets WHERE device_id='missing'")).toBeNull();
  });

  it("repairs a partial legacy upgrade before marking ready", async () => {
    const d = database();
    d.sql("DROP INDEX idx_usage_device_sub_token");
    d.sql("ALTER TABLE usage DROP COLUMN sub_token_id");
    d.sql("ALTER TABLE devices DROP COLUMN password_hash");
    d.sql("DROP TABLE token_routing_policies");
    await ensureSchema(env(d.DB));
    expect(d.rows<{ name: string }>("PRAGMA table_info(usage)").some(r => r.name === "sub_token_id")).toBe(true);
    expect(d.row("SELECT name FROM sqlite_master WHERE name='idx_usage_device_sub_token'")).not.toBeNull();
  });

  it("two independent runners contend on UNIQUE claims, never replaying the backfills", async () => {
    const d = database(); seed(d);
    d.sql("CREATE TABLE runs(n INTEGER)");
    d.sql("CREATE TRIGGER count_pricing AFTER UPDATE OF pricing_mode ON models BEGIN INSERT INTO runs VALUES(1); END");
    const a = instrument(d), b = instrument(d);
    await Promise.all([migrateSchema(env(a.DB)), migrateSchema(env(b.DB))]);
    expect(d.rows("SELECT * FROM runs")).toHaveLength(1);
    expect(d.rows("SELECT * FROM cpg_schema_versions")).toHaveLength(12);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])("fails closed at batch boundary %i and safely retries", async boundary => {
    const d = database(true); let count = 0;
    const DB = { prepare: (sql: string) => d.DB.prepare(sql), batch: async (ss: unknown[]) => {
      if (++count === boundary) throw new Error("injected boundary failure");
      return d.DB.batch(ss);
    } } as unknown as D1Database;
    await expect(ensureSchema(env(DB))).rejects.toThrow("injected boundary failure");
    expect(d.row<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name='cpg_schema_versions'")!.n).toBe(boundary === 1 ? 0 : 1);
    if (boundary > 1) expect(d.rows("SELECT * FROM cpg_schema_versions")).toHaveLength(boundary - 2);
    await ensureSchema(env(DB));
    expect(d.rows("SELECT * FROM cpg_schema_versions")).toHaveLength(12);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])("handles ambiguous commit at boundary %i using durable confirmation or safe retry", async boundary => {
    const d = database(); seed(d); let count = 0;
    d.sql("CREATE TABLE runs(n INTEGER)");
    d.sql("CREATE TRIGGER count_pricing AFTER UPDATE OF pricing_mode ON models BEGIN INSERT INTO runs VALUES(1); END");
    const DB = { prepare: (sql: string) => d.DB.prepare(sql), batch: async (ss: { sql: string }[]) => {
      const result = await d.DB.batch(ss);
      if (++count === boundary) throw new Error("lost acknowledgement");
      return result;
    } } as unknown as D1Database;
    if (boundary === 1) await expect(ensureSchema(env(DB))).rejects.toThrow("lost acknowledgement");
    await ensureSchema(env(DB));
    expect(d.rows("SELECT * FROM cpg_schema_versions")).toHaveLength(12);
    expect(d.rows("SELECT * FROM runs")).toHaveLength(1);
  });

  it.each(["checksum", "unknown", "incomplete", "gap"])("rejects unsafe %s manifest instead of running SQL", async mutation => {
    const d = database(); await ensureSchema(env(d.DB));
    if (mutation === "checksum") d.sql("UPDATE cpg_schema_versions SET checksum=? WHERE id='core/0002-columns'", "0".repeat(64));
    if (mutation === "unknown") d.sql("INSERT INTO cpg_schema_versions VALUES('core/9999-new',?,1,1)", "0".repeat(64));
    if (mutation === "incomplete") d.sql("UPDATE cpg_schema_versions SET completed=0 WHERE id='core/0003-ready'");
    if (mutation === "gap") d.sql("DELETE FROM cpg_schema_versions WHERE id='core/0001-tables'");
    const t = instrument(d);
    await expect(ensureSchema(env(t.DB))).rejects.toThrow(/core schema (manifest|version)/);
    expect(t.batches).toHaveLength(0);
  });

  it("rejects changed historical definitions rather than silently re-stamping their checksums", async () => {
    const d = database(); await ensureSchema(env(d.DB));
    const t = instrument(d);
    await expect(migrateVersionedSchema(t.DB, { init: INIT_STATEMENTS.map(s => s + " "), migrations: MIGRATION_ALTERS, extensions: SCHEMA_DEFINITION.extensions })).rejects.toThrow("checksum/completion mismatch");
    expect(t.batches).toHaveLength(0);
  });

  it("rejects malformed manifests, missing constraints, fake DB metadata and actual read failures", async () => {
    const malformed = database(); malformed.sql("CREATE TABLE cpg_schema_versions(id TEXT,checksum TEXT,completed INTEGER,applied_at INTEGER)");
    await expect(ensureSchema(env(malformed.DB))).rejects.toThrow("Malformed core schema manifest");
    const fake = { prepare: () => ({ first: async () => null }), batch: async () => [] } as unknown as D1Database;
    await expect(ensureSchema(env(fake))).rejects.toThrow("Malformed core schema manifest");
    const unavailable = { prepare: () => ({ first: async () => { throw new Error("D1 unavailable"); } }), batch: async () => [] } as unknown as D1Database;
    await expect(ensureSchema(env(unavailable))).rejects.toThrow("D1 unavailable");
    await expect(ensureSchema({} as Env)).rejects.toThrow("D1 binding required");
  });

  it("does not stamp readiness when a legacy schema fails actual column/unique postconditions", async () => {
    const d = database(true);
    d.sql("CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT,type TEXT,endpoint TEXT,api_key TEXT,secret_name TEXT,enabled INTEGER,config_json TEXT,created_at INTEGER,updated_at INTEGER)");
    await expect(ensureSchema(env(d.DB))).rejects.toThrow(/NOT NULL constraint failed/);
    expect(d.rows("SELECT id FROM cpg_schema_versions")).toEqual([{ id: "core/0001-tables" }]);
  });

  it("reset audits restored structure and retries an older manifest without redoing completed backfills", async () => {
    const d = database(); seed(d); await ensureSchema(env(d.DB));
    d.sql("DROP INDEX idx_usage_device_sub_token");
    await ensureSchema(env(d.DB)); resetSchemaCache(d.DB);
    await expect(ensureSchema(env(d.DB))).rejects.toThrow("restore audit failed");
    d.sql("CREATE INDEX idx_usage_device_sub_token ON usage(device_id,sub_token_id,created_at)");
    await ensureSchema(env(d.DB));
    resetSchemaCache(d.DB);
    d.sql("DELETE FROM cpg_schema_versions WHERE id='core/0003-ready' OR id LIKE 'monthly/%' OR id LIKE 'usage/%' OR id LIKE 'video/%' OR id LIKE 'admin-record/%'");
    await ensureSchema(env(d.DB));
    expect(d.rows("SELECT * FROM cpg_schema_versions")).toHaveLength(12);
  });

  it.each([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])("rolls back SQL, claim and completion together on an in-transaction failure at boundary %i", async boundary => {
    const d = database(); seed(d); let count = 0;
    d.sql("ALTER TABLE devices DROP COLUMN password_hash");
    d.sql("CREATE TABLE injection(n INTEGER CHECK(n=0))");
    const DB = { prepare: (sql: string) => d.DB.prepare(sql), batch: async (ss: D1PreparedStatement[]) => {
      if (++count === boundary) return d.DB.batch([...ss.slice(0, -1), d.DB.prepare("INSERT INTO injection VALUES(1)"), ss[ss.length - 1]]);
      return d.DB.batch(ss);
    } } as unknown as D1Database;
    await expect(ensureSchema(env(DB))).rejects.toThrow(/CHECK constraint failed/);
    expect(d.rows("SELECT * FROM cpg_schema_versions")).toHaveLength(boundary - 2);
    expect(d.rows("SELECT * FROM injection")).toHaveLength(0);
    if (boundary === 3) expect(d.rows<{ name: string }>("PRAGMA table_info(devices)").some(c => c.name === "password_hash")).toBe(false);
    if (boundary === 4) {
      expect(d.row("SELECT pricing_mode FROM models WHERE id='legacy'")).toEqual({ pricing_mode: "unset" });
      expect(d.row("SELECT * FROM device_wallets WHERE device_id='missing'")).toBeNull();
    }
    if (boundary === 10) expect(d.row("SELECT name FROM sqlite_master WHERE name='usage_rollup_receipts'")).toBeNull();
    if (boundary === 11) {
      expect(d.row("SELECT name FROM sqlite_master WHERE name='usage_rollup_receipts'")).not.toBeNull();
      expect(d.row("SELECT name FROM sqlite_master WHERE name='usage_rollup_raw_insert'")).toBeNull();
    }
    if (boundary === 13) {
      expect(d.row("SELECT name FROM sqlite_master WHERE name='idx_video_tasks_created_id'")).toBeNull();
      expect(d.row("SELECT name FROM sqlite_master WHERE name='idx_audit_logs_action_created_id'")).toBeNull();
    }
    if (boundary === 12) expect(d.rows<{name:string}>("PRAGMA table_info(video_tasks)").some(c=>c.name === "upstream_usage_json")).toBe(false);
    await ensureSchema(env(DB));
    expect(d.rows("SELECT * FROM cpg_schema_versions")).toHaveLength(12);
  });

  it.each(["throw", "malformed"])("fails closed on a %s legacy column probe, then retries", async failure => {
    const d = database(); let fail = true;
    const DB = { prepare: (sql: string) => {
      const s = d.DB.prepare(sql);
      if (sql.includes("json_group_array(m.name") && fail) return { ...s, first: async () => {
        if (failure === "throw") throw new Error("probe unauthorized");
        return { cols: "{}" };
      } };
      return s;
    }, batch: (ss: D1PreparedStatement[]) => d.DB.batch(ss) } as unknown as D1Database;
    await expect(ensureSchema(env(DB))).rejects.toThrow(failure === "throw" ? "probe unauthorized" : "Malformed core schema column probe");
    expect(d.rows("SELECT id FROM cpg_schema_versions")).toEqual([{ id: "core/0001-tables" }]);
    fail = false; await ensureSchema(env(DB));
  });

  it.each(["default", "unique", "check", "index"])("refuses to bless a legacy schema with an incorrect %s invariant", async fault => {
    const init = INIT_STATEMENTS.map(sql => {
      if (fault === "default" && /CREATE TABLE IF NOT EXISTS providers\s*\(/.test(sql)) return sql.replace("DEFAULT 1", "DEFAULT 2");
      if (fault === "unique" && /CREATE TABLE IF NOT EXISTS billing_attempts\s*\(/.test(sql)) return sql.replace(/,\s*UNIQUE\(request_id, attempt_number\)/, "");
      if (fault === "check" && /CREATE TABLE IF NOT EXISTS billing_requests\s*\(/.test(sql)) return sql.replace("CHECK (reserved_usd >= 0)", "");
      if (fault === "index" && sql.includes("idx_billing_requests_pending")) return sql.replace("billing_state, settled_at, updated_at", "billing_state, updated_at");
      return sql;
    });
    expect(init).not.toEqual(INIT_STATEMENTS);
    const d = createRealD1({ init }); open.push(d);
    await expect(ensureSchema(env(d.DB))).rejects.toThrow(/NOT NULL constraint failed/);
    expect(d.row("SELECT * FROM cpg_schema_versions WHERE id='core/0003-ready'")).toBeNull();
  });

  it("global restore reset audits bindings that were previously verified", async () => {
    const d = database(); await ensureSchema(env(d.DB));
    d.sql("DROP INDEX idx_usage_device_sub_token"); resetSchemaCache();
    await expect(ensureSchema(env(d.DB))).rejects.toThrow("restore audit failed");
  });

  it("keeps cache readiness isolated by actual DB binding", async () => {
    const a = database(true), b = database(true);
    await ensureSchema(env(a.DB));
    expect(b.row("SELECT name FROM sqlite_master WHERE name='cpg_schema_versions'")).toBeNull();
    await ensureSchema(env(b.DB));
    expect(b.rows("SELECT * FROM cpg_schema_versions")).toHaveLength(12);
  });

  it("preserves exported SQL arrays and retains fail-safe pending migration contracts", () => {
    expect(INIT_STATEMENTS.every(s => typeof s === "string")).toBe(true);
    expect(MIGRATION_ALTERS.some(s => s.includes("INSERT OR IGNORE INTO device_wallets"))).toBe(true);
    expect(SCHEMA_VERSION_DDL).toContain("PRIMARY KEY NOT NULL");
  });
});
