import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { Env } from "../src/types";
import {
  invalidateMonthlyDeviceStatsStatement, monthlyDeviceCostExpression,
  MONTHLY_DEVICE_STATS_COST_TOLERANCE_USD, MONTHLY_DEVICE_STATS_COVERAGE_KEY,
  verifyMonthlyDeviceStatsCoverage,
} from "../src/db/monthly_device_stats";
import { dailyStatsUpsertStatement, releaseStaleReserves, usageInsertStatement, type UsageInsertData } from "../src/db/repo";
import { claimVideoPoll, createVideoTask, finishVideoPoll, markVideoSubmission, type VideoTask } from "../src/db/video_tasks";
import { ensureSchema } from "../src/db/schema";
import { createRealD1, type RealD1 } from "./helpers/realD1";

const START = Date.UTC(2026, 10, 1) - 480 * 60_000;
const NEXT = Date.UTC(2026, 11, 1) - 480 * 60_000;
const DAY = 86_400_000;
const opened: { close(): void }[] = [];
function database() {
  const d1 = createRealD1();
  opened.push(d1);
  const env = { DB: d1.DB } as Env;
  return { d1, env };
}
function device(d1: RealD1, id: string, revoked = false) {
  d1.sql("INSERT INTO devices (id, name, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)",
    id, "account " + id, "hash-" + id, START + id.length, revoked ? START + 1 : null);
}
let serial = 0;
function data(over: Partial<UsageInsertData> = {}): UsageInsertData {
  return { device_id: "a", provider_id: "p", provider_name: "Provider", model: "m", usage: null,
    status_code: 200, latency_ms: 7, request_id: "r" + ++serial, created_at: START, cost_usd: 0.125, ...over };
}
async function write(env: Env, over: Partial<UsageInsertData> = {}) {
  const row = data(over);
  await env.DB.batch([usageInsertStatement(env, row), dailyStatsUpsertStatement(env, row)]);
}
function marker(d1: RealD1) {
  return d1.row<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", MONTHLY_DEVICE_STATS_COVERAGE_KEY);
}
const fields = "d.id, d.name, d.enabled, d.rate_limit_rpm, COALESCE(d.cost_limit_monthly, 0) AS cost_limit_monthly, " +
  "d.last_used_at, d.created_at, d.revoked_at, d.model_scope, COALESCE(d.calls_enabled, 1) AS calls_enabled, " +
  "CASE WHEN d.password_hash IS NULL THEN 0 ELSE 1 END AS password_set, " +
  "COALESCE(w.balance_usd, 0) AS balance_usd, COALESCE(w.reserved_usd, 0) AS reserved_usd";
function oldList(d1: RealD1, start = START, includeRevoked = false) {
  return d1.rows("SELECT " + fields + ", COALESCE(SUM(u.cost_usd), 0) AS current_month_cost FROM devices d " +
    "LEFT JOIN usage u ON u.device_id = d.id AND u.created_at >= ? " +
    "LEFT JOIN device_wallets w ON w.device_id = d.id " +
    (includeRevoked ? "" : "WHERE d.revoked_at IS NULL ") + "GROUP BY d.id ORDER BY d.created_at DESC", start);
}
function newListQuery(start = START, includeRevoked = false) {
  const expression = monthlyDeviceCostExpression(start);
  return { sql: "SELECT " + fields + ", " + expression.sql + " AS current_month_cost FROM devices d " +
    "LEFT JOIN device_wallets w ON w.device_id = d.id " +
    (includeRevoked ? "" : "WHERE d.revoked_at IS NULL ") + "ORDER BY d.created_at DESC", params: expression.params };
}
function newList(d1: RealD1, start = START, includeRevoked = false) {
  const query = newListQuery(start, includeRevoked);
  return d1.rows(query.sql, ...query.params);
}
afterEach(() => { vi.restoreAllMocks(); for (const db of opened.splice(0)) db.close(); });

describe("account-list monthly aggregate coverage", () => {
  it("preserves the complete old list result before and after proof, including UTC+8 edges and shared-master subtokens", async () => {
    const { d1, env } = database();
    for (const id of ["a", "b", "empty"]) device(d1, id);
    device(d1, "revoked", true);
    device(d1, "");
    d1.sql("INSERT INTO device_wallets (device_id, balance_usd, reserved_usd) VALUES ('a', 19, 2)");
    d1.sql("UPDATE devices SET enabled = 0, calls_enabled = 0, password_hash = 'hash' WHERE id = 'b'");
    d1.sql("INSERT INTO device_sub_tokens (id, device_id, name, token_hash, created_at) VALUES ('child', 'a', 'child', 'child-hash', ?)", START);
    await write(env, { created_at: START - 1, cost_usd: 999 });  
    await write(env, { cost_usd: 1.25 });
    await write(env, { sub_token_id: "child", cost_usd: 2.5 });
    await write(env, { device_id: "b", provider_id: null, model: null, cost_usd: 0, status_code: 502 });
    await write(env, { device_id: "revoked", cost_usd: 3 });
    await write(env, { device_id: null, provider_id: null, model: null, cost_usd: 77 });
    await write(env, { device_id: "", cost_usd: 4 });  
    await write(env, { created_at: NEXT, cost_usd: 0.5 });  
    for (const revoked of [false, true]) expect(newList(d1, START, revoked)).toEqual(oldList(d1, START, revoked));
    expect(marker(d1)).toBeNull();
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
    for (const revoked of [false, true]) expect(newList(d1, START, revoked)).toEqual(oldList(d1, START, revoked));
    expect(newList(d1).find(row => row.id === "a")?.current_month_cost).toBe(4.25);
    expect(newList(d1).find(row => row.id === "")?.current_month_cost).toBe(4);
    expect(d1.rows("SELECT * FROM settings")).toHaveLength(1);
  });

  it("never trusts absent, wrong-month, malformed, or wrong-version coverage and writes nothing while listing", async () => {
    const { d1 } = database(); device(d1, "a");
    d1.sql("INSERT INTO usage (device_id, cost_usd, created_at) VALUES ('a', 2, ?)", START);
    d1.sql("INSERT INTO daily_stats (date, device_id, provider_id, model, request_count, cost_usd) VALUES ('2026-11-01', 'a', '', '', 1, 999)");
    for (const value of [null, "true", "{bad", JSON.stringify({ version: 2, start_ms: START }),
      monthlyDeviceCostExpression(NEXT).params[1]]) {
      if (value !== null) d1.sql("INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, 5)", MONTHLY_DEVICE_STATS_COVERAGE_KEY, value);
      const before = d1.rows("SELECT * FROM settings");
      expect(newList(d1)).toEqual(oldList(d1));
      expect(d1.rows("SELECT * FROM settings")).toEqual(before);
    }
  });

  for (const [label, mutation] of [
    ["missing zero-cost rows", "DELETE FROM daily_stats WHERE device_id = 'b'"],
    ["same-total account offsets", "UPDATE daily_stats SET cost_usd = cost_usd + CASE WHEN device_id = 'a' THEN 0.125 ELSE -0.25 END"],
    ["same-account bucket offsets", "UPDATE daily_stats SET cost_usd = cost_usd + CASE WHEN model = 'm' THEN 0.25 ELSE -0.25 END WHERE device_id = 'a'"],
    ["wrong counts", "UPDATE daily_stats SET request_count = request_count + 1 WHERE device_id = 'b'"],
    ["negative counts", "UPDATE daily_stats SET request_count = -1 WHERE device_id = 'b'"],
    ["fractional counts", "UPDATE daily_stats SET request_count = 1.5 WHERE device_id = 'b'"],
    ["text cost poison", "UPDATE daily_stats SET cost_usd = 'poison' WHERE device_id = 'a'"],
    ["infinite cost poison", "UPDATE daily_stats SET cost_usd = 1e999 WHERE device_id = 'a'"],
    ["daily-only zero phantom", "INSERT INTO daily_stats (date, device_id, provider_id, model, request_count, cost_usd) VALUES ('2026-11-02', 'ghost', '', '', 0, 0)"],
    ["raw retention with historical daily stats kept", "DELETE FROM usage WHERE device_id = 'a'"],
    ["invalid future daily date", "UPDATE daily_stats SET date = '2026-11-31' WHERE device_id = 'b'"],
  ]) {
    it("fails reconciliation and removes even an earlier marker for " + label, async () => {
      const { d1, env } = database(); device(d1, "a"); device(d1, "b");
      await write(env, { cost_usd: 1 }); await write(env, { model: "m2", cost_usd: 1 });
      await write(env, { device_id: "b", cost_usd: 0 });
      expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
      d1.sql(mutation);  
      expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(false);
      expect(marker(d1)).toBeNull();
      expect(newList(d1)).toEqual(oldList(d1));
    });
  }

  it("rejects raw poison, including invalid dates, rather than certifying coincidentally matching casts", async () => {
    for (const poison of ["UPDATE usage SET cost_usd = 'poison'", "UPDATE usage SET cost_usd = 1e999", "UPDATE usage SET created_at = 'not-a-date'"]) {
      const { d1, env } = database(); device(d1, "a"); await write(env);
      d1.sql(poison);
      expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(false);
      expect(marker(d1)).toBeNull();
    }
  });

  it("allows only explicit 1e-9 absolute USD error, also bounding accumulated per-device error", async () => {
    expect(MONTHLY_DEVICE_STATS_COST_TOLERANCE_USD).toBe(1e-9);
    const { d1, env } = database(); device(d1, "a");
    for (let i = 0; i < 4; i++) await write(env, { model: "m" + i, cost_usd: 0 });
    d1.sql("UPDATE daily_stats SET cost_usd = ? WHERE model = 'm0'", 0.5e-9);
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
    d1.sql("UPDATE daily_stats SET cost_usd = ?", 0.5e-9);
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(false);  
    d1.sql("UPDATE daily_stats SET cost_usd = 0");
    d1.sql("UPDATE daily_stats SET cost_usd = ? WHERE model = 'm0'", 2e-9);
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(false);
    expect(marker(d1)).toBeNull();
  });

  it("handles normal floating accumulation without requiring bit-identical SUM order", async () => {
    const { d1, env } = database(); device(d1, "a");
    for (let i = 0; i < 300; i++) await write(env, { cost_usd: 0.01, model: "m" + i % 3 });
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
    expect(Number(newList(d1)[0].current_month_cost)).toBeCloseTo(Number(oldList(d1)[0].current_month_cost), 9);
  });

  it("rolls over without reusing last month's proof and bounds durable state to one slot", async () => {
    const { d1, env } = database(); device(d1, "a");
    await write(env, { cost_usd: 1 }); await write(env, { created_at: NEXT, cost_usd: 2 });
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
    const previous = marker(d1);
    d1.sql("UPDATE daily_stats SET cost_usd = 99 WHERE date = '2026-12-01'");
    expect(newList(d1, NEXT)).toEqual(oldList(d1, NEXT));
    expect(await verifyMonthlyDeviceStatsCoverage(env, NEXT)).toBe(false);
    expect(marker(d1)).toBeNull();
    d1.sql("UPDATE daily_stats SET cost_usd = 2 WHERE date = '2026-12-01'");
    expect(await verifyMonthlyDeviceStatsCoverage(env, NEXT)).toBe(true);
    expect(marker(d1)).not.toEqual(previous);
    expect(d1.rows("SELECT * FROM settings")).toHaveLength(1);
    expect(newList(d1, NEXT)).toEqual(oldList(d1, NEXT));
    await write(env, { device_id: "new-device", created_at: NEXT + DAY, cost_usd: 4 });
    device(d1, "new-device");
    expect(newList(d1, NEXT)).toEqual(oldList(d1, NEXT));
  });

  it("certifies an empty database safely and subsequent atomic writers preserve coverage", async () => {
    const { d1, env } = database(); device(d1, "a");
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
    await write(env, { cost_usd: 2 });
    expect(marker(d1)).not.toBeNull();
    expect(newList(d1)).toEqual(oldList(d1));
  });

  it("propagates an actual deferred-constraint COMMIT failure, leaves no false marker, and retries", async () => {
    const { d1, env } = database(); device(d1, "a"); await write(env);
    d1.sql("PRAGMA foreign_keys = ON");
    d1.sql("CREATE TABLE commit_parent (id INTEGER PRIMARY KEY)");
    d1.sql("CREATE TABLE commit_child (ref INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)");
    d1.sql("CREATE TRIGGER fail_coverage_commit AFTER INSERT ON settings WHEN NEW.key = '" + MONTHLY_DEVICE_STATS_COVERAGE_KEY + "' BEGIN INSERT INTO commit_child VALUES (1); END");
    await expect(verifyMonthlyDeviceStatsCoverage(env, START)).rejects.toThrow(/FOREIGN KEY constraint failed/);
    expect(marker(d1)).toBeNull();
    expect(d1.rows("SELECT * FROM commit_child")).toEqual([]);
    expect(newList(d1)).toEqual(oldList(d1));
    d1.sql("INSERT INTO commit_parent VALUES (1)");
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
    expect(marker(d1)).not.toBeNull();
  });

  for (const verifierFirst of [true, false]) {
    it("serializes concurrent verification and atomic billing (verifier first=" + verifierFirst + ")", async () => {
      const { d1, env } = database(); device(d1, "a"); await write(env);
      let verify!: Promise<boolean>;
      let billing!: Promise<void>;
      if (verifierFirst) { verify = verifyMonthlyDeviceStatsCoverage(env, START); billing = write(env, { cost_usd: 0.5 }); }
      else { billing = write(env, { cost_usd: 0.5 }); verify = verifyMonthlyDeviceStatsCoverage(env, START); }
      expect((await Promise.all([verify, billing]))[0]).toBe(true);
      expect(newList(d1)).toEqual(oldList(d1));
      expect(newList(d1)[0].current_month_cost).toBe(0.625);
    });

    it("serializes concurrent retention+invalidation and verification (verifier first=" + verifierFirst + ")", async () => {
      const { d1, env } = database(); device(d1, "a"); await write(env, { cost_usd: 1 });
      await write(env, { created_at: START + DAY, cost_usd: 2 });
      expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
      const cleanup = () => env.DB.batch([invalidateMonthlyDeviceStatsStatement(env),
        env.DB.prepare("DELETE FROM usage WHERE created_at < ?").bind(START + DAY)]);
      let verify!: Promise<boolean>;
      let retention!: ReturnType<typeof cleanup>;
      if (verifierFirst) { verify = verifyMonthlyDeviceStatsCoverage(env, START); retention = cleanup(); }
      else { retention = cleanup(); verify = verifyMonthlyDeviceStatsCoverage(env, START); }
      expect((await Promise.all([verify, retention]))[0]).toBe(verifierFirst);
      expect(marker(d1)).toBeNull();
      expect(newList(d1)).toEqual(oldList(d1));
      expect(newList(d1)[0].current_month_cost).toBe(2);
    });
  }

  it("transactionally invalidates daily-only rebuilds and raw-only restore writes", async () => {
    const { d1, env } = database(); device(d1, "a"); await write(env);
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
    await env.DB.batch([invalidateMonthlyDeviceStatsStatement(env), env.DB.prepare("DELETE FROM daily_stats")]);
    expect(marker(d1)).toBeNull(); expect(newList(d1)).toEqual(oldList(d1));
    await env.DB.batch([invalidateMonthlyDeviceStatsStatement(env), usageInsertStatement(env, data({ cost_usd: 7 }))]);
    expect(marker(d1)).toBeNull(); expect(newList(d1)).toEqual(oldList(d1));
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(false);
  });

  it("preserves a proof across real video success/failure/retry and stale-hold zero-cost writers", async () => {
    const { d1, env } = database(); device(d1, "a");
    const now = START + DAY;
    vi.spyOn(Date, "now").mockReturnValue(now);
    await ensureSchema(env);
    d1.sql("INSERT OR REPLACE INTO device_wallets (device_id, balance_usd, reserved_usd) VALUES ('a', 100, 0)");
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
    const originalMarker = marker(d1);
    for (const status of ["succeeded", "failed"] as const) {
      const id = "video-" + status;
      const task: VideoTask = { id, device_id: "a", sub_token_id: "child", idempotency_key: id,
        request_hash: "hash", status: "submitting", upstream_task_id: null,
        route_json: JSON.stringify({ provider_id: "video-provider", public_model: "video-public" }),
        price_usd: 3.25, pricing_snapshot_json: "{}", result_url: null, error_code: null,
        poll_after: null, poll_lease_until: null, created_at: now - 1000, updated_at: now - 1000 };
      expect(await createVideoTask(env, task)).toBe(true);
      await markVideoSubmission(env, id, "up-" + id);
      const claim = await claimVideoPoll(env, id, now);
      expect(claim).not.toBeNull();
      const outcome = { status, result_url: "https://cdn.example/result.mp4" };
      await finishVideoPoll(env, id, outcome, claim!);
      await finishVideoPoll(env, id, outcome, claim!);  
    }
    d1.sql("INSERT INTO reserve_holds (request_id, device_id, amount_usd, created_at) VALUES ('stale', 'a', 1, ?)", now - 90 * 60_000);
    d1.sql("UPDATE device_wallets SET reserved_usd = 1 WHERE device_id = 'a'");
    expect(await releaseStaleReserves(env)).toBe(1);
    expect(marker(d1)).toEqual(originalMarker);
    expect(newList(d1)).toEqual(oldList(d1));
    expect(newList(d1)[0].current_month_cost).toBe(3.25);
    expect(d1.row("SELECT COUNT(*) AS n FROM usage")).toEqual({ n: 3 });
    expect(d1.row("SELECT SUM(request_count) AS n FROM daily_stats")).toEqual({ n: 3 });
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
  });

  it("rolls invalidation back with failed maintenance rather than exposing a half-deleted daily set", async () => {
    const { d1, env } = database(); device(d1, "a"); await write(env);
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
    const proof = marker(d1);
    await expect(env.DB.batch([invalidateMonthlyDeviceStatsStatement(env), env.DB.prepare("DELETE FROM daily_stats"),
      env.DB.prepare("INSERT INTO daily_stats (date) VALUES (NULL)")])).rejects.toThrow(/NOT NULL/);
    expect(marker(d1)).toEqual(proof);
    expect(newList(d1)).toEqual(oldList(d1));
    expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
  });

  it("rejects non-month and non-UTC+8 boundaries instead of silently using misaligned buckets", async () => {
    const { env } = database();
    for (const invalid of [START + 1, START + DAY, Date.UTC(2026, 10, 1), NaN, Infinity]) {
      expect(() => monthlyDeviceCostExpression(invalid)).toThrow(/UTC[+]8 month-start/);
      await expect(verifyMonthlyDeviceStatsCoverage(env, invalid)).rejects.toThrow(/UTC[+]8 month-start/);
    }
  });
});

it("uses indexed branch plans and eliminates all raw row visits only AFTER verified coverage", async () => {
  const require = createRequire(import.meta.url);
  type InstrumentedDb = import("node:sqlite").DatabaseSync & { function(name: string, fn: () => number): void };
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => InstrumentedDb };
  const db = new DatabaseSync(":memory:"); opened.push(db);
  let rawVisits = 0; let dailyVisits = 0;
  db.function("raw_visit", () => { rawVisits++; return 0; });
  db.function("daily_visit", () => { dailyVisits++; return 0; });
  db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY); INSERT INTO devices VALUES ('a'), ('b'); " +
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at INTEGER); " +
    "CREATE TABLE usage_storage (created_at INTEGER, device_id TEXT, provider_id TEXT, model TEXT, cost_usd REAL); " +
    "CREATE INDEX usage_device_created ON usage_storage(device_id, created_at); " +
    "CREATE TABLE daily_storage (date TEXT, device_id TEXT, provider_id TEXT, model TEXT, request_count INTEGER, cost_usd REAL); " +
    "CREATE INDEX daily_device_date ON daily_storage(device_id, date); " +
    "CREATE VIEW usage AS SELECT created_at, device_id, provider_id, model, cost_usd + raw_visit() AS cost_usd FROM usage_storage; " +
    "CREATE VIEW daily_stats AS SELECT date, device_id, provider_id, model, request_count, cost_usd + daily_visit() AS cost_usd FROM daily_storage");
  const ins = db.prepare("INSERT INTO usage_storage VALUES (?, ?, 'p', 'm', 0.125)");
  for (let i = 0; i < 4000; i++) ins.run(START + i, i % 2 ? "a" : "b");
  db.exec("INSERT INTO daily_storage VALUES ('2026-11-01', 'a', 'p', 'm', 2000, 250), ('2026-11-01', 'b', 'p', 'm', 2000, 250)");
  const expr = monthlyDeviceCostExpression(START);
  const query = "SELECT d.id, " + expr.sql + " AS cost FROM devices d ORDER BY d.id";
  const old = "SELECT d.id, COALESCE(SUM(u.cost_usd), 0) AS cost FROM devices d LEFT JOIN usage u ON u.device_id = d.id AND u.created_at >= ? GROUP BY d.id ORDER BY d.id";
  const expected = db.prepare(old).all(START);
  rawVisits = 0; dailyVisits = 0;
  expect(db.prepare(query).all(...expr.params)).toEqual(expected);
  expect(rawVisits).toBe(4000); expect(dailyVisits).toBe(0);
  const plans = db.prepare("EXPLAIN QUERY PLAN " + query).all(...expr.params) as { detail: string }[];
  expect(plans.some(row => /SEARCH usage_storage USING INDEX usage_device_created/.test(row.detail))).toBe(true);
  expect(plans.some(row => /SEARCH daily_storage USING INDEX daily_device_date/.test(row.detail))).toBe(true);
  expect(plans.some(row => /SCAN (usage_storage|daily_storage)/.test(row.detail))).toBe(false);
  const prepare = (sql: string) => {
    const statement = db.prepare(sql); let binds: unknown[] = [];
    const self = { bind: (...args: unknown[]) => { binds = args; return self; },
      run: () => { const r = statement.run(...binds); return { meta: { changes: Number(r.changes) } }; } };
    return self;
  };
  const env = { DB: { prepare, batch: async (stmts: { run(): unknown }[]) => {
    db.exec("BEGIN"); try { const out = stmts.map(stmt => stmt.run()); db.exec("COMMIT"); return out; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } } } as unknown as Env;
  expect(await verifyMonthlyDeviceStatsCoverage(env, START)).toBe(true);
  rawVisits = 0; dailyVisits = 0;
  expect(db.prepare(query).all(...expr.params)).toEqual(expected);
  expect(rawVisits).toBe(0); expect(dailyVisits).toBe(2);
  const real = database(); device(real.d1, "a");
  const realQuery = newListQuery();
  const realPlan = real.d1.rows<{ detail: string }>("EXPLAIN QUERY PLAN " + realQuery.sql, ...realQuery.params).map(r => r.detail).join("\n");
  expect(realPlan).toContain("idx_daily_stats_device_date");
  expect(realPlan).toContain("idx_usage_device_created");
  console.log("monthly scan evidence: raw visits 4000 -> 0; daily visits 0 -> 2; indexed branches verified");
});
