import { describe, expect, it, vi } from "vitest";
import { COLUMN_PROBE_SQL, INIT_STATEMENTS, MIGRATION_ALTERS, pendingMigrations } from "../src/db/schema";
import { USAGE_ROLLUP_TABLES, USAGE_ROLLUP_TRIGGERS } from "../src/db/usage_rollup_schema";
import { createRealD1 } from "./helpers/realD1";
import { initializedSchemaDouble } from "./helpers/initializedSchemaDouble";


const ALTER_PREFIX = /^ALTER TABLE/i;

async function freshSchemaModule() {
  vi.resetModules();
  return import("../src/db/schema");
}

async function probeColumns(d1: ReturnType<typeof createRealD1>): Promise<string[]> {
  const row = (await d1.DB.prepare(COLUMN_PROBE_SQL).first()) as { cols: string | null } | null;
  expect(row?.cols).toBeTruthy();
  return JSON.parse(String(row?.cols)) as string[];
}

describe("schema migration probe", () => {
  it("uses the actual current manifest in handler doubles without business SQL or migration writes", async () => {
    const prepare = vi.fn((_sql: string) => { throw new Error("Unexpected handler SQL during readiness"); });
    const batch = vi.fn(async () => { throw new Error("Unexpected handler migration batch"); });
    const DB = initializedSchemaDouble({ prepare, batch });
    const { ensureSchema } = await freshSchemaModule();
    await ensureSchema({ DB } as never);
    await ensureSchema({ DB } as never);
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(() => DB.prepare("SELECT unexpected_handler_query")).toThrow("Unexpected handler SQL during readiness");
    expect(prepare).toHaveBeenCalledWith("SELECT unexpected_handler_query");
  });

  it("reports every column and skips D1's internal tables", async () => {
    const d1 = createRealD1();
    d1.sql("CREATE TABLE _cf_KV (k TEXT PRIMARY KEY, v BLOB)");

    const cols = await probeColumns(d1);

    expect(cols).toContain("models.cache_enabled");
    expect(cols).toContain("usage.cost_usd");
    expect(cols).toContain("device_wallets.balance_usd");
    expect(cols.some((c) => c.startsWith("_cf_KV."))).toBe(false);
    expect(cols.some((c) => c.startsWith("sqlite_"))).toBe(false);
    d1.close();
  });

  it("drops only the ALTERs whose column already exists", async () => {
    const d1 = createRealD1();
    const applied = new Set((await probeColumns(d1)).map((c) => c.toLowerCase()));
    d1.close();

    const pending = pendingMigrations(applied);

    expect(pending.some((sql) => ALTER_PREFIX.test(sql))).toBe(false);
    expect(pending.some((sql) => /INSERT OR IGNORE INTO device_wallets/.test(sql))).toBe(true);
    expect(pending.some((sql) => /UPDATE models SET pricing_mode = 'priced'/.test(sql))).toBe(true);
    expect(pending.some((sql) => /CREATE TABLE IF NOT EXISTS audit_logs/.test(sql))).toBe(true);
    expect(pending.every((sql) => /^(CREATE|UPDATE|INSERT)/i.test(sql.trim()))).toBe(true);
  });

  it("keeps every statement on an empty database", () => {
    expect(pendingMigrations(new Set())).toEqual(MIGRATION_ALTERS);
  });

  it("filters a partially migrated database down to the missing columns", () => {
    const columns = new Set(["models.peak_pricing_enabled", "usage.cost_usd"]);

    const pending = pendingMigrations(columns);

    expect(pending).not.toContain("ALTER TABLE models ADD COLUMN peak_pricing_enabled INTEGER NOT NULL DEFAULT 0");
    expect(pending).not.toContain("ALTER TABLE usage ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0");
    expect(pending).toContain("ALTER TABLE usage ADD COLUMN price_multiplier REAL NOT NULL DEFAULT 1");
    expect(pending.length).toBe(MIGRATION_ALTERS.length - 2);
  });

  it("uses atomic version claims and skips all completed stages on a fresh binding", async () => {
    const d1 = createRealD1();
    try {
      const batches: string[][] = [];
      const DB = {
        prepare: (sql: string) => d1.DB.prepare(sql),
        batch: async (statements: { sql: string }[]) => {
          batches.push(statements.map(s => s.sql)); return d1.DB.batch(statements);
        },
      };
      const { ensureSchema } = await freshSchemaModule();
      await ensureSchema({ DB } as never);
      const stages = batches.filter(sqls => sqls[0]?.startsWith("INSERT INTO cpg_schema_versions"));
      expect(stages).toHaveLength(12);
      expect(stages[11]).toContain("CREATE INDEX IF NOT EXISTS idx_video_tasks_created_id ON video_tasks(created_at DESC, id DESC)");
      expect(stages[11]).toContain("CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created_id ON audit_logs(action, created_at DESC, id DESC)");
      expect(stages[10]).toContain("ALTER TABLE video_tasks ADD COLUMN upstream_usage_json TEXT");
      expect(stages[5].some(sql => sql.includes("monthly_pass_operations"))).toBe(true);
      expect(stages[6].some(sql => sql.includes("monthly_pass_operation_apply"))).toBe(true);
      expect(stages[7].some(sql => sql.includes("idx_monthly_retention_settled"))).toBe(true);
      expect(stages[8].slice(1, -1)).toEqual(USAGE_ROLLUP_TABLES);
      expect(stages[9].slice(1, -1)).toEqual(USAGE_ROLLUP_TRIGGERS);
      expect(stages[1].some(sql => ALTER_PREFIX.test(sql))).toBe(false);
      expect(stages[2].some(sql => /INSERT OR IGNORE INTO device_wallets/.test(sql))).toBe(true);
      expect(stages[3]).toContain("ALTER TABLE billing_requests ADD COLUMN monthly_groups_json TEXT");
      expect(stages[4].some(sql => /^CREATE TRIGGER IF NOT EXISTS monthly_pass_admit/.test(sql))).toBe(true);
      expect(d1.rows("SELECT id, completed FROM cpg_schema_versions ORDER BY id")).toEqual([
        { id: "admin-record/0001-query-indexes", completed: 1 },
        { id: "core/0001-tables", completed: 1 },
        { id: "core/0002-columns", completed: 1 },
        { id: "core/0003-ready", completed: 1 },
        { id: "monthly/0001-tables", completed: 1 },
        { id: "monthly/0002-funding", completed: 1 },
        { id: "monthly/0003-operations", completed: 1 },
        { id: "monthly/0004-operation-apply", completed: 1 },
        { id: "monthly/0005-retention", completed: 1 },
        { id: "usage/0001-tables", completed: 1 },
        { id: "usage/0002-rollups", completed: 1 },
        { id: "video/0001-upstream-usage", completed: 1 },
      ]);
      batches.length = 0;
      const freshDB = { prepare: DB.prepare, batch: DB.batch };
      await ensureSchema({ DB: freshDB } as never);
      expect(batches).toHaveLength(0);
    } finally { d1.close(); }
  });

  it("fails closed on unavailable schema evidence instead of replaying individual SQL", async () => {
    const d1 = createRealD1();
    try {
      const batches: string[][] = [];
      const run = vi.fn();
      const DB = {
        prepare: (sql: string) => {
          const stmt = d1.DB.prepare(sql);
          if (!sql.includes("AS cols")) return stmt;
          return { sql, first: async () => { throw new Error("probe unavailable"); }, run };
        },
        batch: async (statements: { sql: string }[]) => {
          batches.push(statements.map(s => s.sql)); return d1.DB.batch(statements);
        },
      };
      const { ensureSchema } = await freshSchemaModule();
      await expect(ensureSchema({ DB } as never)).rejects.toThrow("probe unavailable");
      expect(run).not.toHaveBeenCalled();
      expect(d1.rows("SELECT id FROM cpg_schema_versions WHERE completed=1")).toHaveLength(1);
      expect(batches.some(sqls => sqls.some(sql => /INSERT OR IGNORE INTO device_wallets/.test(sql)))).toBe(false);
    } finally { d1.close(); }
  });
});
