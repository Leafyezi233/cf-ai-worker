import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema } from "../src/db/schema";
import worker from "../src/index";
import {
  CollectingExecutionContext,
  createRealD1,
  makeEnv,
  makeKv,
} from "./helpers/realGatewayEnv";


const DAY = 24 * 60 * 60 * 1000;

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function insertUsage(d1: ReturnType<typeof createRealD1>, createdAt: number, model = "m1") {
  d1.sql(
    `INSERT INTO usage (
      device_id, provider_id, provider_name, model, input_tokens, output_tokens, total_tokens,
      cost_usd, cache_hit, cache_read_tokens, cache_write_tokens, pricing_missing,
      price_multiplier, price_window_id, status_code, latency_ms, request_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    "dev_1", "prov_a", "Provider A", model, 10, 20, 30, 0.001, 0, 0, 0, 0, 1, null, 200, 5, "req-" + createdAt, createdAt
  );
}

function insertAudit(d1: ReturnType<typeof createRealD1>, createdAt: number, action = "test.action") {
  d1.sql(
    "INSERT INTO audit_logs (actor_type, ip, action, target_type, target_id, summary, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "admin", "127.0.0.1", action, "device", "dev_1", "test row", null, createdAt
  );
}

function insertDailyStat(d1: ReturnType<typeof createRealD1>, date: string) {
  d1.sql(
    `INSERT OR REPLACE INTO daily_stats (
      date, device_id, provider_id, model, request_count, input_tokens, output_tokens,
      total_tokens, cost_usd, cache_hit_count, cache_read_tokens, cache_write_tokens,
      cost_saved_usd, avg_latency_ms, error_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    date, "dev_1", "prov_a", "m1", 1, 10, 20, 30, 0.001, 0, 0, 0, 0, 5, 0
  );
}

function setRetention(d1: ReturnType<typeof createRealD1>, cfg: Record<string, unknown>) {
  d1.sql(
    "INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)",
    "retention_config",
    JSON.stringify(cfg),
    Date.now()
  );
}

async function runScheduled(env: ReturnType<typeof makeEnv>) {
  const exec = new CollectingExecutionContext();
  await (worker as any).scheduled({ cron: "0 1 * * *" } as any, env, exec as any);
  await Promise.all(exec.pending);
}

function count(d1: ReturnType<typeof createRealD1>, table: string): number {
  const row = d1.row<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(row?.n ?? 0);
}

describe("the scheduled handler never performs legacy retention deletion", () => {
  it("preserves usage, audit and authoritative rollups even with enabled legacy retention", async () => {
    const d1 = createRealD1();
    await ensureSchema(makeEnv(d1));
    const now = Date.now();
    insertUsage(d1, now - 40 * DAY, "old");
    insertUsage(d1, now - 1 * DAY, "fresh");
    insertAudit(d1, now - 40 * DAY, "old.action");
    insertAudit(d1, now - 1 * DAY, "fresh.action");
    setRetention(d1, { enabled: true, retention_days: 30, keep_daily_stats: true });

    const usage = d1.rows("SELECT * FROM usage ORDER BY id");
    const audits = d1.rows("SELECT * FROM audit_logs ORDER BY id");
    const hourly = d1.rows("SELECT * FROM usage_hourly_rollups ORDER BY hour_start, dimension_key");
    const monthly = d1.rows("SELECT * FROM usage_monthly_rollups ORDER BY month_start, dimension_key");
    const receipts = d1.rows("SELECT * FROM usage_rollup_receipts ORDER BY id");
    await runScheduled(makeEnv(d1, makeKv()));

    expect(d1.rows("SELECT * FROM usage ORDER BY id")).toEqual(usage);
    expect(d1.rows("SELECT * FROM audit_logs ORDER BY id")).toEqual(audits);
    expect(d1.rows("SELECT * FROM usage_hourly_rollups ORDER BY hour_start, dimension_key")).toEqual(hourly);
    expect(d1.rows("SELECT * FROM usage_monthly_rollups ORDER BY month_start, dimension_key")).toEqual(monthly);
    expect(d1.rows("SELECT * FROM usage_rollup_receipts ORDER BY id")).toEqual(receipts);
  });

  it("does not revive deletion under either a 60-day or a 30-day enabled setting", async () => {
    const d1 = createRealD1();
    await ensureSchema(makeEnv(d1));
    insertUsage(d1, Date.now() - 40 * DAY, "forty-days");
    insertAudit(d1, Date.now() - 40 * DAY, "forty-days.action");
    setRetention(d1, { enabled: true, retention_days: 60, keep_daily_stats: true });

    await runScheduled(makeEnv(d1, makeKv()));

    expect(count(d1, "usage")).toBe(1);

    const d1b = createRealD1();
    await ensureSchema(makeEnv(d1b));
    insertUsage(d1b, Date.now() - 40 * DAY, "forty-days");
    insertAudit(d1b, Date.now() - 40 * DAY, "forty-days.action");
    setRetention(d1b, { enabled: true, retention_days: 30, keep_daily_stats: true });

    await runScheduled(makeEnv(d1b, makeKv()));

    expect(count(d1b, "usage")).toBe(1);
    expect(count(d1, "audit_logs")).toBe(1);
    expect(count(d1b, "audit_logs")).toBe(1);
  });

  it("deletes nothing when retention is disabled", async () => {
    const d1 = createRealD1();
    await ensureSchema(makeEnv(d1));
    insertUsage(d1, Date.now() - 400 * DAY, "ancient");
    insertAudit(d1, Date.now() - 400 * DAY, "ancient.action");
    setRetention(d1, { enabled: false, retention_days: 15, keep_daily_stats: true });

    await runScheduled(makeEnv(d1, makeKv()));

    expect(count(d1, "usage")).toBe(1);
    expect(count(d1, "audit_logs")).toBe(1);
  });

  it("deletes nothing when no retention config was ever saved", async () => {
    const d1 = createRealD1();
    await ensureSchema(makeEnv(d1));
    insertUsage(d1, Date.now() - 400 * DAY, "ancient");

    await runScheduled(makeEnv(d1, makeKv()));

    expect(count(d1, "usage")).toBe(1);
  });

  it("keeps old daily aggregates when keep_daily_stats is on", async () => {
    const d1 = createRealD1();
    await ensureSchema(makeEnv(d1));
    const oldDate = new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10);
    insertDailyStat(d1, oldDate);
    insertUsage(d1, Date.now() - 400 * DAY, "ancient");
    setRetention(d1, { enabled: true, retention_days: 30, keep_daily_stats: true });

    await runScheduled(makeEnv(d1, makeKv()));

    expect(count(d1, "usage")).toBe(1);
    const dates = d1.rows<{ date: string }>("SELECT date FROM daily_stats");
    expect(dates.map((r) => r.date)).toContain(oldDate);
  });

  it("preserves old usage, audit and daily aggregates even when keep_daily_stats is off", async () => {
    const d1 = createRealD1();
    await ensureSchema(makeEnv(d1));
    const oldDate = new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10);
    insertDailyStat(d1, oldDate);
    insertUsage(d1, Date.now() - 400 * DAY, "ancient");
    insertAudit(d1, Date.now() - 400 * DAY, "ancient.action");
    setRetention(d1, { enabled: true, retention_days: 30, keep_daily_stats: false });

    await runScheduled(makeEnv(d1, makeKv()));

    const dates = d1.rows<{ date: string }>("SELECT date FROM daily_stats");
    expect(dates.map((r) => r.date)).toContain(oldDate);
    expect(count(d1, "usage")).toBe(1);
    expect(count(d1, "audit_logs")).toBe(1);
  });
});
