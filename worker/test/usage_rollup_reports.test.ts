import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { ensureSchema } from "../src/db/schema";
import {
  aggregateDailyStats, cleanupOldUsage, generateMonthlyReport, getCurrentMonthSpend,
  getDeviceMonthlyCost, listDevices, statsByModel, statsByProvider, statsCacheAnalytics,
  statsCostAnalytics, statsModelLatency, statsSummary, statsTrend, usageInsertStatement,
  type UsageInsertData,
} from "../src/db/repo";
import {
  backfillUsageRollups, cleanupUsageDetails, usageReportSource, validateUsageRange, verifyUsageRollups,
} from "../src/db/usage_rollups";
import { createRealD1, type RealD1 } from "./helpers/realD1";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 9, 31, 16);  
const NEXT = Date.UTC(2026, 10, 30, 16);
const open: RealD1[] = [];
let serial = 0;
function database() {
  const d1 = createRealD1();
  open.push(d1);
  return { d1, env: { DB: d1.DB } as Env };
}
function data(over: Partial<UsageInsertData> = {}): UsageInsertData {
  return {
    device_id: "a", provider_id: "p", provider_name: "Historical provider", model: "model-a",
    sub_token_id: "child", service_group_id: "service",
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, cache_read_tokens: 3, cache_write_tokens: 4 },
    cost_usd: 0.25, cache_hit: 0, status_code: 200, latency_ms: 100,
    request_id: "report-" + ++serial, created_at: START, ...over,
  };
}
async function write(d1: RealD1, env: Env, over: Partial<UsageInsertData> = {}) {
  const row = data(over);
  await usageInsertStatement(env, row).run();
  d1.sql("INSERT INTO wallet_ledger (device_id, delta_usd, reason, request_id, created_at) VALUES (?, ?, 'usage', ?, ?)",
    row.device_id, -(row.cost_usd || 0), row.request_id, row.created_at);
  return row;
}
async function fixture() {
  const result = database();
  await ensureSchema(result.env);
  result.d1.sql("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('a', 'Account A', 'hash-a', 1)");
  result.d1.sql("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('empty', 'Empty', 'hash-empty', 2)");
  return result;
}
async function reports(env: Env, since = START) {
  return {
    summary: await statsSummary(env, since), provider: await statsByProvider(env, since),
    model: await statsByModel(env, since), trend: await statsTrend(env, since),
    cache: await statsCacheAnalytics(env, since), latency: await statsModelLatency(env, since),
    month: await generateMonthlyReport(env, "2026-11"),
    cost: await statsCostAnalytics(env, since), device: await getDeviceMonthlyCost(env, "a", START),
    budget: await getCurrentMonthSpend(env), list: await listDevices(env),
  };
}
afterEach(() => { vi.restoreAllMocks(); for (const d1 of open.splice(0)) d1.close(); });

describe("independent hourly/monthly history reports (real SQLite)", () => {
  it("preserves every report DTO after detail cleanup, including null/zero/positive weighted latency and cache savings", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + 10 * DAY);
    const { d1, env } = await fixture();
    await write(d1, env, { created_at: START - 1, cost_usd: 1 });
    await write(d1, env, { created_at: START, cost_usd: 0.1, latency_ms: null });
    await write(d1, env, { created_at: START + 10_000, cache_hit: 1, cost_usd: 0.2, latency_ms: 10 });
    await write(d1, env, { created_at: START + HOUR, cost_usd: 0.3, latency_ms: 1000 });
    await write(d1, env, { created_at: START + HOUR + 1, cost_usd: 0.4, latency_ms: 0, status_code: 500 });
    await write(d1, env, { created_at: START + HOUR + 2, cost_usd: 0.5, latency_ms: null, status_code: 502 });
    await write(d1, env, { created_at: START + HOUR + 3, cache_hit: 1, cost_usd: 0.6, latency_ms: 20, status_code: 503 });
    await write(d1, env, { created_at: NEXT, model: "future", cost_usd: 2, latency_ms: 40 });
    const before = await reports(env);
    expect(before.summary).toMatchObject({ request_count: 7, total_tokens: 210, error_count: 3 });
    expect(before.summary!.avg_latency_ms).toBeCloseTo(1070 / 5, 10);
    expect(before.month).toMatchObject({ total_requests: 6, total_cost_usd: 2.1, cache_hit_count: 2,
      cache_saved_tokens: 60, cache_saved_cost_usd: 0.8 });
    expect(before.month.mom_growth).toMatchObject({ previous_requests: 1, previous_cost_usd: 1 });
    expect(before.latency.find(r => r.model === "model-a")).toMatchObject({ requests: 3, avg_latency_ms: 343,
      min_latency_ms: 10, max_latency_ms: 1000, error_count: 1, error_rate: 33.3 });
    expect(before.cache).toMatchObject({ total_requests: 7, cache_hits: 2, tokens_saved: 60,
      cost_saved_usd: 0.8, avg_cached_latency_ms: 15, avg_direct_latency_ms: 347 });
    expect(before.device).toBe(4.1);  
    expect(before.budget).toBe(4.1);
    expect((await verifyUsageRollups(env)).ok).toBe(true);
    const cleanup = await cleanupUsageDetails(env, { enabled: true, before: NEXT + HOUR });
    expect(cleanup.deleted).toBe(7);
    expect(d1.rows("SELECT model,cost_usd FROM usage")).toEqual([{model:"future",cost_usd:2}]);
    expect(await reports(env)).toEqual(before);
  });

  it("keeps arbitrary recent boundaries exact, then rejects an archived partial hour explicitly", async () => {
    const { d1, env } = await fixture();
    for (const minute of [5, 20, 40, 55]) await write(d1, env, { created_at: START + minute * 60_000 });
    const from = START + 15 * 60_000;
    const to = START + 45 * 60_000;
    await validateUsageRange(env, from, to);
    const source = usageReportSource(from, to);
    expect(d1.row<{ n: number }>("SELECT SUM(request_count) AS n FROM " + source.sql, ...source.binds)!.n).toBe(2);
    expect((await statsSummary(env, from))!.request_count).toBe(3);
    expect((await cleanupUsageDetails(env, { enabled: true, before: START + HOUR })).deleted).toBe(4);
    await expect(statsSummary(env, from)).rejects.toThrow("usage_history_granularity_required");
    await expect(validateUsageRange(env, START, to)).rejects.toThrow("usage_history_granularity_required");
    expect((await statsSummary(env, START))!.request_count).toBe(4);
    await expect(statsTrend(env, START, "+330 minutes", -330)).rejects.toThrow("usage_history_granularity_required");
    await expect(generateMonthlyReport(env, "2026-11", "+330 minutes")).rejects.toThrow("usage_history_granularity_required");
    await expect(statsCostAnalytics(env, START, "+330 minutes")).rejects.toThrow("usage_history_granularity_required");
  });

  it("unions unprocessed historical rows with live rolls without double counting during backfill", async () => {
    const { d1, env } = database();
    await write(d1, env, { created_at: START + 1, cost_usd: 1 });
    await ensureSchema(env);
    await write(d1, env, { created_at: START + HOUR + 1, cost_usd: 2 });
    expect((await statsSummary(env, START))!.request_count).toBe(2);
    expect(await getDeviceMonthlyCost(env, "a", START)).toBe(3);
    expect((await backfillUsageRollups(env)).processed).toBe(1);
    expect((await statsSummary(env, START))!.request_count).toBe(2);
    expect(await getDeviceMonthlyCost(env, "a", START)).toBe(3);
    expect((await cleanupUsageDetails(env, { enabled: true, before: START + 2 * HOUR })).deleted).toBe(2);
    expect((await statsSummary(env, START))!.request_count).toBe(2);
    expect(await getDeviceMonthlyCost(env, "a", START)).toBe(3);
  });

  it("rebuilds archived local days from complete hourly history, including a later arrival, not partial raw detail", async () => {
    const { d1, env } = await fixture();
    await write(d1, env, { created_at: START + HOUR, latency_ms: null, cost_usd: 1 });
    await write(d1, env, { created_at: START + 2 * HOUR, latency_ms: 100, cost_usd: 2 });
    await aggregateDailyStats(env, "2026-11-01");
    expect((await cleanupUsageDetails(env, { enabled: true, before: START + DAY })).deleted).toBe(2);
    await write(d1, env, { created_at: START + 3 * HOUR, latency_ms: 10, cost_usd: 3 });
    await aggregateDailyStats(env, "2026-11-01");
    const day = d1.row<{ n: number; cost: number; latency: number }>(
      "SELECT SUM(request_count) AS n, SUM(cost_usd) AS cost, MAX(avg_latency_ms) AS latency FROM daily_stats WHERE date='2026-11-01'")!;
    expect(day).toMatchObject({ n: 3, cost: 6, latency: 55 });
    const before = d1.rows("SELECT * FROM daily_stats");
    await expect(aggregateDailyStats(env, "2026-11-01", "+0 minutes")).rejects.toThrow("usage_daily_timezone_unsupported");
    expect(d1.rows("SELECT * FROM daily_stats")).toEqual(before);
  });

  it("continues detecting historical cost anomalies and their model after raw detail is removed", async () => {
    const { d1, env } = await fixture();
    for (let day = 0; day < 4; day++) await write(d1, env, {
      created_at: START + day * DAY + HOUR, model: day === 3 ? "expensive" : "cheap", cost_usd: day === 3 ? 9 : 0.1,
    });
    const before = await statsCostAnalytics(env, START, "+480 minutes", "7d");
    expect(before).toMatchObject({ range: "7d", total_cost_usd: 9.3,
      anomaly_alert: { is_anomaly: true, spike_date: "2026-11-04", top_contributor_model: "expensive" } });
    await cleanupUsageDetails(env, { enabled: true, before: START + 4 * DAY });
    expect(await statsCostAnalytics(env, START, "+480 minutes", "7d")).toEqual(before);
  });

  it("legacy cleanup fails before deleting usage, daily statistics, or audit records", async () => {
    const { d1, env } = await fixture();
    await write(d1, env);
    await aggregateDailyStats(env, "2026-11-01");
    d1.sql("INSERT INTO audit_logs(action,target_type,summary,created_at) VALUES ('test','usage','keep',1)");
    const before = ["usage", "daily_stats", "audit_logs"].map(table => d1.rows("SELECT * FROM " + table));
    await expect(cleanupOldUsage(env, { cutoffMs: NEXT, keepDailyStats: false }))
      .rejects.toThrow("usage_retention_requires_verified_preview");
    expect(["usage", "daily_stats", "audit_logs"].map(table => d1.rows("SELECT * FROM " + table))).toEqual(before);
  });
});
