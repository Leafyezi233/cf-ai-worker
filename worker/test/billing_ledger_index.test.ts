import { afterEach, describe, expect, it, vi } from "vitest";
import { INIT_STATEMENTS, MIGRATION_ALTERS } from "../src/db/schema";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedDevice } from "./helpers/realGatewayEnv";

const INDEX = "idx_wallet_ledger_request_reason";
const opened: RealD1[] = [];

function database(withIndex = true): RealD1 {
  const keep = (sql: string) => withIndex || !sql.includes(INDEX);
  const d1 = createRealD1({ init: INIT_STATEMENTS.filter(keep), alters: MIGRATION_ALTERS.filter(keep) });
  opened.push(d1);
  return d1;
}

function expectLookupIndex(d1: RealD1): void {
  const indexes = d1.rows<{ name: string; unique: number; partial: number }>("PRAGMA index_list(wallet_ledger)");
  expect(indexes.filter(index => index.name === INDEX)).toEqual([
    expect.objectContaining({ name: INDEX, unique: 0, partial: 0 }),
  ]);
  expect(d1.rows<{ name: string }>("PRAGMA index_info(" + INDEX + ")").map(column => column.name))
    .toEqual(["request_id", "reason"]);
  expect(indexes.find(index => index.name === "idx_wallet_ledger_idem"))
    .toMatchObject({ unique: 1, partial: 1 });
}

const MONTHLY_TABLES = [
  "monthly_pass_accounts", "monthly_pass_buckets", "monthly_pass_funding",
  "monthly_pass_plans", "monthly_pass_request_buckets", "monthly_pass_subscriptions", "monthly_pass_operations",
];
const USAGE_ROLLUP_TABLES = [
  "usage_rollup_receipts", "usage_hourly_rollups", "usage_monthly_rollups",
  "usage_rollup_archived_hours", "usage_rollup_write_context", "usage_rollup_cleanup_context",
  "usage_rollup_cleanup_permits", "usage_rollup_cleanup_operations",
];
const EMPTY_EXTENSION_TABLES = [...MONTHLY_TABLES, ...USAGE_ROLLUP_TABLES];
const quoteIdentifier = (name: string) => '"' + name.replace(/"/g, '""') + '"';

function snapshot(d1: RealD1) {
  return d1.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'cpg_schema_versions' ORDER BY name")
    .map(({ name }) => ({
      table: name,
      columns: d1.rows<{ name: string }>("PRAGMA table_info(" + quoteIdentifier(name) + ")"),
      rows: d1.rows("SELECT * FROM " + quoteIdentifier(name) + " ORDER BY rowid"),
    }));
}

function expectOriginalSnapshot(d1: RealD1, before: ReturnType<typeof snapshot>): void {
  const after = snapshot(d1);
  const originalTables = new Set(before.map(table => table.table));
  expect(after.map(table => table.table)).toEqual([
    ...originalTables, ...EMPTY_EXTENSION_TABLES.filter(table => !originalTables.has(table)
      && after.some(actual => actual.table === table)),
  ].sort());
  for (const original of before) {
    const actual = after.find(table => table.table === original.table)!;
    const addedColumns = actual.columns.filter(column => !original.columns.some(old => old.name === column.name));
    if (addedColumns.length) {
      expect(["billing_requests","video_tasks"]).toContain(original.table);
      const name=original.table === "billing_requests" ? "monthly_groups_json" : "upstream_usage_json";
      expect(addedColumns).toEqual([expect.objectContaining({ name, type: "TEXT", notnull: 0, dflt_value: null, pk: 0 })]);
      expect(actual.rows.every(row => row[name] === null)).toBe(true);
    }
    expect(actual.columns.filter(column => !addedColumns.includes(column))).toEqual(original.columns);
    expect(actual.rows.map(row => Object.fromEntries(original.columns.map(column => [column.name, row[column.name]]))))
      .toEqual(original.rows);
  }
}

function expectMonthlyExtension(d1: RealD1): void {
  for (const table of MONTHLY_TABLES) expect(d1.rows("SELECT * FROM " + quoteIdentifier(table))).toEqual([]);
  expect(d1.rows("PRAGMA table_info(billing_requests)"))
    .toContainEqual(expect.objectContaining({ name: "monthly_groups_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 }));
  expect(d1.rows("SELECT id, completed FROM cpg_schema_versions WHERE id LIKE 'monthly/%' ORDER BY id")).toEqual([
    { id: "monthly/0001-tables", completed: 1 },
    { id: "monthly/0002-funding", completed: 1 },
    { id: "monthly/0003-operations", completed: 1 },
    { id: "monthly/0004-operation-apply", completed: 1 },
    { id: "monthly/0005-retention", completed: 1 },
  ]);
  expect(d1.rows("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'monthly_pass_%' ORDER BY name"))
    .toEqual([{ name: "monthly_pass_admit" }, { name: "monthly_pass_operation_apply" }, { name: "monthly_pass_operation_immutable" }, { name: "monthly_pass_operation_no_delete" }, { name: "monthly_pass_release" }, { name: "monthly_pass_settle" }]);
  expect(d1.rows("PRAGMA index_info(idx_monthly_retention_settled)").map(row => row.name)).toEqual(["settled_at", "request_id"]);
}

function expectUsageRollupExtension(d1: RealD1): void {
  for (const table of USAGE_ROLLUP_TABLES) expect(d1.rows("SELECT * FROM " + quoteIdentifier(table))).toEqual([]);
  expect(d1.rows("SELECT id, completed FROM cpg_schema_versions WHERE id LIKE 'usage/%' ORDER BY id")).toEqual([
    { id: "usage/0001-tables", completed: 1 },
    { id: "usage/0002-rollups", completed: 1 },
  ]);
}

async function seedHistory(d1: RealD1): Promise<void> {
  await seedDevice(d1, { id: "historical-owner", token_hash: "history-hash", balance_usd: 23.5 });
  await seedDevice(d1, { id: "caller", token_hash: "caller-hash", balance_usd: 50 });
  await seedDevice(d1, { id: "other-owner", token_hash: "other-hash", balance_usd: 7.25 });
  d1.sql("INSERT INTO wallet_ledger (device_id, delta_usd, balance_after, reason, request_id, note, created_at) " +
    "VALUES ('historical-owner', -1.5, 23.5, 'usage', 'shared-history', 'original invoice', 100)");
  d1.sql("INSERT INTO wallet_ledger (device_id, delta_usd, balance_after, reason, request_id, note, created_at) " +
    "VALUES ('other-owner', -2.75, 7.25, 'usage', 'shared-history', 'second owner', 101)");
  d1.sql("INSERT INTO wallet_ledger (device_id, delta_usd, balance_after, reason, request_id, note, created_at) " +
    "VALUES ('historical-owner', 1, 24.5, 'refund', 'shared-history', NULL, 102)");
  for (let i = 0; i < 2; i++) {
    d1.sql("INSERT INTO wallet_ledger (device_id, delta_usd, balance_after, reason, request_id, note, created_at) " +
      "VALUES ('historical-owner', 1, 25.5, 'topup', NULL, 'nullable historical id', ?)", 103 + i);
  }
  d1.sql("INSERT INTO usage (device_id, model, cost_usd, request_id, created_at) VALUES ('historical-owner', 'old-model', 1.5, 'unrelated-usage', 100)");
  d1.sql("INSERT INTO reserve_holds (request_id, device_id, amount_usd, created_at) VALUES ('unrelated-hold', 'historical-owner', 0.75, 105)");
  d1.sql("UPDATE device_wallets SET reserved_usd = 0.75 WHERE device_id = 'historical-owner'");
}

async function coldStart(d1: RealD1): Promise<void> {
  vi.resetModules();
  const { ensureSchema } = await import("../src/db/schema");
  const env = makeEnv(d1);
  await ensureSchema(env);
  await ensureSchema(env);  
  expectMonthlyExtension(d1);
  expectUsageRollupExtension(d1);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d1 of opened.splice(0)) d1.close();
});

describe("wallet ledger admission lookup index", () => {
  it("builds the fresh INIT schema and survives real migrations and repeated cold starts", async () => {
    const d1 = createRealD1({ alters: [] });
    opened.push(d1);
    expectLookupIndex(d1);
    const errors = vi.spyOn(console, "error");
    await coldStart(d1);
    expectLookupIndex(d1);
    expect(d1.rows("SELECT * FROM wallet_ledger")).toEqual([]);
    const before = snapshot(d1);
    for (let i = 0; i < 2; i++) {
      await coldStart(d1);
      expectLookupIndex(d1);
      expectOriginalSnapshot(d1, before);
    }
    expect(errors).not.toHaveBeenCalled();
  });

  for (const withIndex of [true, false]) {
    it((withIndex ? "reinitializes the current" : "upgrades the previous") + " schema without changing any data", async () => {
      const d1 = database(withIndex);
      await seedHistory(d1);
      d1.sql("INSERT INTO billing_requests (request_id, device_id, model, pricing_snapshot_json, reserved_usd, admission_nonce, lease_until, created_at, updated_at) " +
        "VALUES ('historical-managed', 'historical-owner', 'old-model', '{}', 0, 'legacy-nonce', 200, 100, 100)");
      if (!withIndex) expect(d1.rows("PRAGMA index_info(" + INDEX + ")")).toEqual([]);
      const before = snapshot(d1);
      const errors = vi.spyOn(console, "error");
      for (let i = 0; i < 3; i++) {
        await coldStart(d1);
        expectLookupIndex(d1);
        expectOriginalSnapshot(d1, before);
      }
      expect(errors).not.toHaveBeenCalled();
      expect(d1.row("SELECT COUNT(*) AS n FROM wallet_ledger WHERE request_id = 'shared-history' AND reason = 'usage'"))
        .toEqual({ n: 2 });
      expect(() => d1.sql("INSERT INTO wallet_ledger (device_id, delta_usd, balance_after, reason, request_id, created_at) " +
        "VALUES ('caller', -1, 49, 'usage', 'shared-history', 200)")).not.toThrow();
      expect(() => d1.sql("INSERT INTO wallet_ledger (device_id, delta_usd, balance_after, reason, request_id, created_at) " +
        "VALUES ('caller', -1, 48, 'usage', 'shared-history', 201)")).toThrow(/UNIQUE constraint failed/);
    });
  }

  for (const [path, statements] of [["INIT_STATEMENTS", INIT_STATEMENTS], ["MIGRATION_ALTERS", MIGRATION_ALTERS]] as const) {
    it("can apply the additive index from " + path + " independently and repeatedly", async () => {
      const d1 = database(false);
      await seedHistory(d1);
      const before = snapshot(d1);
      const creates = statements.filter(sql => sql.includes(INDEX));
      expect(creates).toHaveLength(1);
      for (let i = 0; i < 3; i++) {
        d1.sql(creates[0]);
        expectLookupIndex(d1);
        expectOriginalSnapshot(d1, before);
      }
    });
  }

  it("uses indexed SEARCH, not a ledger SCAN, for the actual admission SQL with seeded history", async () => {
    const d1 = database();
    await seedHistory(d1);
    d1.sql("WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 4096) " +
      "INSERT INTO wallet_ledger (device_id, delta_usd, balance_after, reason, request_id, note, created_at) " +
      "SELECT 'historical-owner', -0.01, 23.5, CASE WHEN n % 2 = 0 THEN 'usage' ELSE 'refund' END, 'history-' || n, NULL, n FROM history");
    expect(d1.row("SELECT COUNT(*) AS n FROM wallet_ledger")).toEqual({ n: 4101 });
    await coldStart(d1);
    const env = makeEnv(d1);
    const queries: string[] = [];
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => { queries.push(sql); return prepare(sql); });
    const { admitBillingRequest } = await import("../src/db/request_billing");
    expect(await admitBillingRequest(env, {
      request_id: "fresh-request", device_id: "caller", model: "public-model",
      pricing_snapshot_json: "{}", reserved_usd: 1,
    })).toBe(true);
    const admissions = queries.filter(sql => sql.startsWith("INSERT INTO billing_requests "));
    expect(admissions).toHaveLength(1);
    const sql = admissions[0];
    const plan = d1.rows<{ detail: string }>("EXPLAIN QUERY PLAN " + sql, ...Array((sql.match(/\?/g) ?? []).length).fill(null))
      .map(row => row.detail);
    const ledgerPlan = plan.filter(detail => /wallet_ledger/i.test(detail));
    expect(ledgerPlan).toHaveLength(1);
    expect(ledgerPlan[0]).toMatch(/SEARCH wallet_ledger USING (?:COVERING )?INDEX idx_wallet_ledger_request_reason/);
    expect(ledgerPlan[0]).toContain("request_id=? AND reason=?");
    expect(ledgerPlan[0]).not.toMatch(/SCAN/);
  });

  for (const reserved_usd of [0, 1]) {
    it("still refuses a global cross-owner historical usage collision for a " + reserved_usd + " dollar admission", async () => {
      const d1 = database(false);
      await seedHistory(d1);
      await coldStart(d1);
      const before = snapshot(d1);
      const { admitBillingRequest } = await import("../src/db/request_billing");
      expect(d1.rows("SELECT * FROM usage WHERE request_id = 'shared-history'")).toEqual([]);
      expect(d1.rows("SELECT * FROM billing_requests")).toEqual([]);
      expect(await admitBillingRequest(makeEnv(d1), {
        request_id: "shared-history", device_id: "caller", model: "public-model",
        pricing_snapshot_json: "{}", reserved_usd,
      })).toBe(false);
      expectOriginalSnapshot(d1, before);
    });
  }
});
