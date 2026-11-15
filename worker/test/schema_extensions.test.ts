import { afterEach, describe, expect, it } from "vitest";
import { INIT_STATEMENTS, MIGRATION_ALTERS } from "../src/db/schema";
import { ensureVersionedSchema, migrateVersionedSchema, resetSchemaCache, SCHEMA_MANIFEST_READ_SQL, type SchemaDefinition } from "../src/db/schema_versions";
import { createRealD1, type RealD1 } from "./helpers/realD1";

const core: SchemaDefinition = { init: INIT_STATEMENTS, migrations: MIGRATION_ALTERS };
const sealedCore = [
  { id: "core/0001-tables", checksum: "95e4240d6ca771ec3d943864af1292324dd9c9a992032ec051baf1dbaa0f52fe" },
  { id: "core/0002-columns", checksum: "7f94b56fe22e6c15594581ffae611a419ef4e732a04d04dfdac0e638ad38109e" },
  { id: "core/0003-ready", checksum: "d54ef52b8d4b4d7c475a199e7eb48d609085e015c0a9e3df96798d9c9a6c71b2" },
];
const extensions = [
  { id: "z/monthly-schema", sql: [
    "CREATE TABLE IF NOT EXISTS monthly_passes (id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL UNIQUE, remaining INTEGER NOT NULL DEFAULT 0 CHECK (remaining >= 0), CHECK (length(id) > 0))",
    "ALTER TABLE devices ADD COLUMN monthly_pass_enabled INTEGER NOT NULL DEFAULT 0 CHECK (monthly_pass_enabled IN (0,1))",
    "CREATE TABLE IF NOT EXISTS monthly_runs (n INTEGER NOT NULL)",
  ] },
  { id: "a/monthly-triggers", sql: [
    "CREATE INDEX IF NOT EXISTS idx_monthly_remaining ON monthly_passes(remaining,device_id) WHERE remaining > 0",
    "CREATE TRIGGER IF NOT EXISTS monthly_pass_usage AFTER UPDATE OF monthly_pass_enabled ON devices BEGIN INSERT INTO monthly_runs(n) VALUES(1); END",
    "UPDATE devices SET monthly_pass_enabled=monthly_pass_enabled+1 WHERE id='d'",
  ] },
] as const;
const definition: SchemaDefinition = { ...core, extensions };
const firstOnly: SchemaDefinition = { ...core, extensions: [extensions[0]] };
const open: RealD1[] = [];
function database() { const d = createRealD1({ init: [], alters: [] }); open.push(d); return d; }
async function appliedCore() {
  const d = database();
  await ensureVersionedSchema(d.DB, core);
  d.sql("INSERT INTO devices(id,name,token_hash) VALUES('d','device','token')");
  return d;
}
afterEach(() => { resetSchemaCache(); for (const d of open.splice(0)) d.close(); });

type Statement = D1PreparedStatement & { sql: string };
function instrument(d: RealD1, execute?: (ss: Statement[]) => Promise<unknown>) {
  const reads: string[] = [], batches: string[][] = [];
  const bindings = new Map<string, unknown[]>();
  const DB = {
    prepare(sql: string) {
      const s = d.DB.prepare(sql);
      const wrapped = { ...s, bind: (...args: unknown[]) => { bindings.set(sql, args); s.bind(...args); return wrapped; }, first: async () => {
        reads.push(sql);
        const result = await d.DB.batch([s]);
        return result[0].results[0] ?? null;
      } };
      return wrapped;
    },
    batch: async (ss: Statement[]) => { batches.push(ss.map(s => s.sql)); return execute ? execute(ss) : d.DB.batch(ss); },
  } as unknown as D1Database;
  return { DB, reads, batches, bindings };
}
const manifest = (d: RealD1) => d.rows<{ id: string; checksum: string }>("SELECT id,checksum FROM cpg_schema_versions ORDER BY id");

describe("schema extensions", () => {
  it("preserves the exact historical protocol-1 checksums on empty DBs and after extensions", async () => {
    const d = database();
    await migrateVersionedSchema(d.DB, definition);
    expect(manifest(d).filter(s => s.id.startsWith("core/"))).toEqual(sealedCore);
    expect(manifest(d)).toHaveLength(5);
    const old = database();
    await migrateVersionedSchema(old.DB, core);
    expect(manifest(old)).toEqual(sealedCore);
  });

  it("extends already-completed core in caller order without rerunning historical data SQL", async () => {
    const d = await appliedCore(), before = manifest(d), t = instrument(d);
    await ensureVersionedSchema(t.DB, definition);
    expect(manifest(d).filter(s => s.id.startsWith("core/"))).toEqual(before);
    expect(d.row("SELECT * FROM device_wallets WHERE device_id='d'")).toBeNull();
    expect(d.row("SELECT monthly_pass_enabled FROM devices WHERE id='d'")).toEqual({ monthly_pass_enabled: 1 });
    expect(d.rows("SELECT * FROM monthly_runs")).toEqual([{ n: 1 }]);
    expect(t.batches).toHaveLength(2);
    for (const sql of t.batches) {
      expect(sql[0]).toMatch(/^INSERT INTO cpg_schema_versions/);
      expect(sql[0]).not.toContain("OR IGNORE");
      expect(sql[sql.length - 1]).toMatch(/^UPDATE cpg_schema_versions SET completed=CASE WHEN/);
    }
    const completion = t.batches[0].at(-1)!;
    let parameter = 0;
    const firstCondition = completion.split("CASE WHEN ")[1].split(" THEN 1 ELSE NULL END")[0]
      .replace(/json_each\(\?\)/g, () => "json_each('" + String(t.bindings.get(completion)![parameter++]).replace(/'/g,"''") + "')");
    const expectedHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({
      protocol: 2, id: extensions[0].id, sql: extensions[0].sql, condition: firstCondition, predecessors: sealedCore,
    })));
    expect(manifest(d).find(s => s.id === extensions[0].id)?.checksum)
      .toBe([...new Uint8Array(expectedHash)].map(n => n.toString(16).padStart(2, "0")).join(""));
  });

  it("upgrades the same binding from a warm core definition, then keeps cold 1 indexed read and warm 0", async () => {
    const d = await appliedCore();
    await ensureVersionedSchema(d.DB, definition);
    const cold = instrument(d);
    const promises = Array.from({ length: 12 }, () => ensureVersionedSchema(cold.DB, definition));
    expect(promises.every(p => p === promises[0])).toBe(true);
    await Promise.all(promises);
    expect(cold.reads).toHaveLength(1); expect(cold.batches).toHaveLength(0);
    expect(cold.reads[0]).toContain("ORDER BY id LIMIT 6");
    expect(d.rows<{ detail: string }>("EXPLAIN QUERY PLAN " + cold.reads[0]).some(r => /SEARCH.*INDEX/.test(r.detail))).toBe(true);
    await ensureVersionedSchema(cold.DB, definition);
    expect(cold.reads).toHaveLength(1); expect(cold.batches).toHaveLength(0);
    const old = instrument(await appliedCore());
    await ensureVersionedSchema(old.DB, core);
    expect(old.reads).toEqual([SCHEMA_MANIFEST_READ_SQL]);
  });

  it("supports appending a later extension without changing the first extension checksum", async () => {
    const d = await appliedCore();
    await ensureVersionedSchema(d.DB, firstOnly);
    const firstHash = manifest(d).find(s => s.id === extensions[0].id)?.checksum;
    await ensureVersionedSchema(d.DB, definition);
    expect(manifest(d).find(s => s.id === extensions[0].id)?.checksum).toBe(firstHash);
    expect(d.rows("SELECT * FROM monthly_runs")).toEqual([{ n: 1 }]);
  });

  it.each(["sql", "id", "order", "removed", "core"])("rejects changed %s definitions before executing SQL", async fault => {
    const d = await appliedCore(); await ensureVersionedSchema(d.DB, definition);
    let changed: SchemaDefinition = { ...definition };
    if (fault === "sql") changed.extensions = [extensions[0], { ...extensions[1], sql: [...extensions[1].sql, "UPDATE devices SET monthly_pass_enabled=0"] }];
    if (fault === "id") changed.extensions = [extensions[0], { ...extensions[1], id: "new/monthly-triggers" }];
    if (fault === "order") changed.extensions = [...extensions].reverse();
    if (fault === "removed") changed.extensions = [extensions[0]];
    if (fault === "core") changed.init = INIT_STATEMENTS.map(s => s + " ");
    const t = instrument(d);
    await expect(ensureVersionedSchema(t.DB, changed)).rejects.toThrow(/core schema (manifest|version)/);
    expect(t.batches).toHaveLength(0);
    expect(d.rows("SELECT * FROM monthly_runs")).toEqual([{ n: 1 }]);
  });

  it.each(["checksum", "incomplete", "gap", "unknown-first", "unknown-last", "unknown-many", "negative-time"])("rejects unsafe %s manifests using all stages plus an unknown sentinel", async fault => {
    const d = await appliedCore(); await migrateVersionedSchema(d.DB, definition);
    if (fault === "checksum") d.sql("UPDATE cpg_schema_versions SET checksum=? WHERE id=?", "0".repeat(64), extensions[1].id);
    if (fault === "incomplete") d.sql("UPDATE cpg_schema_versions SET completed=0 WHERE id=?", extensions[1].id);
    if (fault === "gap") d.sql("DELETE FROM cpg_schema_versions WHERE id=?", extensions[0].id);
    if (fault === "negative-time") d.sql("UPDATE cpg_schema_versions SET applied_at=-1 WHERE id=?", extensions[1].id);
    if (fault.startsWith("unknown")) {
      const count = fault === "unknown-many" ? 9 : 1;
      for (let i = 0; i < count; i++) d.sql("INSERT INTO cpg_schema_versions VALUES(?,?,1,1)", (fault === "unknown-first" ? "!unknown" : "zz/unknown") + i, "0".repeat(64));
    }
    const t = instrument(d);
    await expect(migrateVersionedSchema(t.DB, definition)).rejects.toThrow(/core schema (manifest|version)/);
    expect(t.reads).toHaveLength(1); expect(t.batches).toHaveLength(0);
  });

  it("strictly rejects an out-of-order manifest response", async () => {
    const d = await appliedCore(); await migrateVersionedSchema(d.DB, definition);
    const DB = { prepare: (sql: string) => {
      const s = d.DB.prepare(sql);
      return { ...s, first: async () => { const row = await s.first(); return { ...row, versions: JSON.stringify(JSON.parse(row.versions).reverse()) }; } };
    }, batch: d.DB.batch } as unknown as D1Database;
    await expect(migrateVersionedSchema(DB, definition)).rejects.toThrow("checksum/completion mismatch");
  });

  it.each(["core/0004-new", "core/0001-tables", ""])("rejects reserved/invalid extension id %s", async id => {
    const d = await appliedCore(), t = instrument(d);
    await expect(migrateVersionedSchema(t.DB, { ...core, extensions: [{ id, sql: [] }] })).rejects.toThrow("Invalid schema extension id");
    expect(t.reads).toHaveLength(0); expect(t.batches).toHaveLength(0);
  });

  it("rejects duplicate extension IDs", async () => {
    const d = await appliedCore();
    await expect(migrateVersionedSchema(d.DB, { ...core, extensions: [extensions[0], extensions[0]] })).rejects.toThrow("Invalid schema extension id");
  });

  it("probes and filters already-present ALTER columns while preserving other extension SQL", async () => {
    const d = await appliedCore(); d.sql(extensions[0].sql[1]);
    const t = instrument(d); await migrateVersionedSchema(t.DB, definition);
    expect(t.reads.filter(s => s.includes("json_group_array(m.name"))).toHaveLength(1);
    expect(t.batches[0].some(s => /^ALTER TABLE/.test(s))).toBe(false);
    expect(d.row("SELECT name FROM sqlite_master WHERE name='monthly_passes'")).not.toBeNull();
    expect(d.rows("SELECT * FROM monthly_runs")).toEqual([{ n: 1 }]);
  });

  it.each(["throw", "malformed"])("fails closed on a %s extension column probe and permits a safe retry", async fault => {
    const d = await appliedCore(); let fail = true;
    const DB = { prepare: (sql: string) => {
      const s = d.DB.prepare(sql);
      if (fail && sql.includes("json_group_array(m.name")) return { ...s, first: async () => {
        if (fault === "throw") throw new Error("extension probe denied");
        return { cols: "{}" };
      } };
      return s;
    }, batch: d.DB.batch } as unknown as D1Database;
    await expect(ensureVersionedSchema(DB, definition)).rejects.toThrow(fault === "throw" ? "extension probe denied" : "Malformed core schema column probe");
    expect(manifest(d)).toEqual(sealedCore);
    fail = false; await ensureVersionedSchema(DB, definition);
    expect(manifest(d)).toHaveLength(5);
  });

  it.each(["column", "check", "unique", "alter-check", "index", "trigger"])("rolls back the claim when an existing %s structure fails extension postconditions", async fault => {
    const d = await appliedCore();
    if (["column", "check", "unique"].includes(fault)) d.sql(extensions[0].sql[0]
      .replace(fault === "column" ? "remaining INTEGER" : fault === "check" ? " CHECK (remaining >= 0)" : " UNIQUE", fault === "column" ? "remaining TEXT" : ""));
    if (fault === "alter-check") d.sql(extensions[0].sql[1].replace(" CHECK (monthly_pass_enabled IN (0,1))", ""));
    if (["index", "trigger"].includes(fault)) {
      await migrateVersionedSchema(d.DB, firstOnly);
      d.sql(fault === "index" ? extensions[1].sql[0].replace("remaining,device_id", "device_id,remaining") : extensions[1].sql[1].replace("VALUES(1)", "VALUES(9)"));
    }
    const before = manifest(d);
    await expect(migrateVersionedSchema(d.DB, definition)).rejects.toThrow(/NOT NULL constraint failed/);
    expect(manifest(d)).toEqual(before);
    if (["index", "trigger"].includes(fault)) {
      expect(d.rows("SELECT * FROM monthly_runs")).toEqual([]);
      expect(d.row("SELECT monthly_pass_enabled FROM devices WHERE id='d'")).toEqual({ monthly_pass_enabled: 0 });
    }
  });

  it("cannot use extension requirements to weaken or overwrite historical core requirements", async () => {
    const d = await appliedCore();
    const bad: SchemaDefinition = { ...core, extensions: [{ id: "extension/unsafe-core", sql: ["DROP INDEX idx_usage_device_sub_token", "CREATE INDEX IF NOT EXISTS idx_usage_device_sub_token ON usage(device_id)"] }] };
    await expect(migrateVersionedSchema(d.DB, bad)).rejects.toThrow(/NOT NULL constraint failed/);
    expect(manifest(d)).toEqual(sealedCore);
    expect(d.row<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='idx_usage_device_sub_token'")?.sql).toContain("sub_token_id");
  });

  it.each([0, 1])("rolls back extension %i SQL, claim and completion in the same transaction", async target => {
    const d = await appliedCore(); d.sql("CREATE TABLE injection(n INTEGER CHECK(n=0))");
    let count = 0, injected = false;
    const t = instrument(d, ss => {
      if (count++ === target && !injected) { injected = true; return d.DB.batch([...ss.slice(0, -1), d.DB.prepare("INSERT INTO injection VALUES(1)"), ss[ss.length - 1]]); }
      return d.DB.batch(ss);
    });
    await expect(ensureVersionedSchema(t.DB, definition)).rejects.toThrow("CHECK constraint failed");
    expect(manifest(d)).toHaveLength(3 + target);
    if (target === 0) {
      expect(d.row("SELECT name FROM sqlite_master WHERE name='monthly_passes'")).toBeNull();
      expect(d.rows<{ name: string }>("PRAGMA table_info(devices)").some(c => c.name === "monthly_pass_enabled")).toBe(false);
    } else {
      expect(d.row("SELECT name FROM sqlite_master WHERE name='monthly_pass_usage'")).toBeNull();
      expect(d.rows("SELECT * FROM monthly_runs")).toEqual([]);
    }
    await ensureVersionedSchema(t.DB, definition);
    expect(manifest(d)).toHaveLength(5); expect(d.rows("SELECT * FROM monthly_runs")).toEqual([{ n: 1 }]);
  });

  it.each(["throw", "malformed"])("uses only read confirmation after a committed extension %s acknowledgement", async fault => {
    const d = await appliedCore();
    const t = instrument(d, async ss => { const out = await d.DB.batch(ss); if (fault === "throw") throw new Error("lost extension ack"); return out.slice(0, -1); });
    await ensureVersionedSchema(t.DB, definition);
    expect(t.batches).toHaveLength(2);
    expect(t.reads.filter(s => s.includes(" AS versions"))).toHaveLength(5);
    expect(d.rows("SELECT * FROM monthly_runs")).toEqual([{ n: 1 }]);
  });

  it("competing runners use UNIQUE claims and never replay the extension backfill", async () => {
    const d = await appliedCore(), a = instrument(d), b = instrument(d);
    await Promise.all([migrateVersionedSchema(a.DB, definition), migrateVersionedSchema(b.DB, definition)]);
    expect(manifest(d)).toHaveLength(5);
    expect(d.rows("SELECT * FROM monthly_runs")).toEqual([{ n: 1 }]);
    expect([...a.batches, ...b.batches].filter(s => s.some(q => q === extensions[1].sql[2])).length).toBeGreaterThanOrEqual(1);
  });

  it.each(["core-index", "extension-table", "extension-column", "extension-index", "extension-trigger"])("restore audit validates core plus %s without replaying completed SQL", async fault => {
    const d = await appliedCore(); await ensureVersionedSchema(d.DB, definition);
    if (fault === "core-index") d.sql("DROP INDEX idx_usage_device_sub_token");
    if (fault === "extension-table") d.sql("DROP TABLE monthly_runs");
    if (fault === "extension-column") d.sql("ALTER TABLE monthly_passes ADD COLUMN scratch INTEGER");
    if (fault === "extension-column") { d.sql("DROP INDEX idx_monthly_remaining"); d.sql("ALTER TABLE monthly_passes DROP COLUMN remaining"); }
    if (fault === "extension-index") d.sql("DROP INDEX idx_monthly_remaining");
    if (fault === "extension-trigger") d.sql("DROP TRIGGER monthly_pass_usage");
    const t = instrument(d);
    resetSchemaCache(t.DB);
    await expect(ensureVersionedSchema(t.DB, definition)).rejects.toThrow("restore audit failed");
    expect(t.batches).toHaveLength(0);
    expect(t.reads).toHaveLength(2);
  });
});
