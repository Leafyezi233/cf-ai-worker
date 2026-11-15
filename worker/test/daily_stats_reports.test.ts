import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/schema";
import {
  aggregateDailyStats,
  recordUsageSafe,
  statsByModel,
  statsByProvider,
  statsSummary,
  statsTrend,
  type UsageInsertData,
} from "../src/db/repo";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv } from "./helpers/realGatewayEnv";


const HOUR = 60 * 60 * 1000;
const DAY_DATE = "2026-10-20";
const DAY_START_UTC = Date.UTC(2026, 9, 19, 16, 0, 0);

function row(over: Partial<UsageInsertData> & { created_at: number }): UsageInsertData {
  return {
    device_id: "dev_1",
    provider_id: "prov_a",
    provider_name: "Provider A",
    model: "m1",
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 0 },
    cost_usd: 0.01,
    status_code: 200,
    latency_ms: 10,
    request_id: "req-" + over.created_at + "-" + Math.random().toString(36).slice(2, 8),
    ...over,
  };
}

function rawSummary(d1: RealD1, fromMs: number) {
  return d1.row<{ n: number; cost: number; tokens: number; errors: number; cacheHits: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(total_tokens), 0) AS tokens, " +
      "COALESCE(SUM(CASE WHEN COALESCE(status_code, 0) >= 400 THEN 1 ELSE 0 END), 0) AS errors, " +
      "COALESCE(SUM(cache_hit), 0) AS cacheHits FROM usage WHERE created_at >= ?",
    fromMs
  )!;
}

function poisonBucket(d1: RealD1, requestCount = 1000, cost = 99) {
  d1.sql(
    "INSERT INTO daily_stats (date, device_id, provider_id, model, request_count, cost_usd) VALUES (?, 'dev_poison', 'prov_poison', 'poison', ?, ?)",
    DAY_DATE,
    requestCount,
    cost
  );
}

describe("authoritative hourly reports preserve whole-day numeric semantics", () => {
  it("matches the raw rows for the same window", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await ensureSchema(env);
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + HOUR, cost_usd: 0.25 }));
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + 2 * HOUR, model: "m2", cost_usd: 0.5, status_code: 500, pricing_missing: true }));
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + 3 * HOUR, provider_id: "prov_b", provider_name: "Provider B" }));
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC - 1000, cost_usd: 7 }));

    const truth = rawSummary(d1, DAY_START_UTC);
    const summary = await statsSummary(env, DAY_START_UTC);

    expect(Number(summary!.request_count)).toBe(truth.n);
    expect(Number(summary!.request_count)).toBe(3);
    expect(Number(summary!.cost_usd)).toBeCloseTo(truth.cost, 10);
    expect(Number(summary!.total_tokens)).toBe(truth.tokens);
    expect(Number(summary!.error_count)).toBe(truth.errors);
    expect(Number(summary!.error_count)).toBe(1);
    expect(Number(summary!.cache_hit_count)).toBe(truth.cacheHits);
    expect(Number(summary!.pricing_missing_count)).toBe(1);
  });

  it("weights hourly latency sums by sample counts instead of averaging averages", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await ensureSchema(env);
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + HOUR, device_id: "dev_a", latency_ms: 100 }));
    for (let i = 0; i < 3; i++) {
      await recordUsageSafe(env, row({ created_at: DAY_START_UTC + 2 * HOUR + i, device_id: "dev_b", latency_ms: 10 }));
    }

    const summary = await statsSummary(env, DAY_START_UTC);
    expect(Number(summary!.request_count)).toBe(4);
    expect(Number(summary!.avg_latency_ms)).toBeCloseTo(32.5, 10);

    const byModel = await statsByModel(env, DAY_START_UTC);
    expect(byModel).toHaveLength(1);
    expect(Number((byModel[0] as any).avg_latency_ms)).toBeCloseTo(32.5, 10);
  });

  it("groups providers and models the same way the raw rows do", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await ensureSchema(env);
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + HOUR, cost_usd: 0.1 }));
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + 2 * HOUR, cost_usd: 0.2 }));
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + 3 * HOUR, provider_id: "prov_b", provider_name: "Provider B", model: "m2", cost_usd: 0.4 }));

    const providers = (await statsByProvider(env, DAY_START_UTC)) as any[];
    expect(providers.map((p) => p.name).sort()).toEqual(["Provider A", "Provider B"]);
    expect(Number(providers.find((p) => p.name === "Provider A")!.requests)).toBe(2);
    expect(Number(providers.find((p) => p.name === "Provider B")!.cost_usd)).toBeCloseTo(0.4, 10);

    const models = (await statsByModel(env, DAY_START_UTC)) as any[];
    expect(models.map((m) => m.name).sort()).toEqual(["m1", "m2"]);

    const trend = (await statsTrend(env, DAY_START_UTC)) as any[];
    expect(trend).toHaveLength(1);
    expect(trend[0].date).toBe(DAY_DATE);
    expect(Number(trend[0].requests)).toBe(3);
    expect(Number(trend[0].cost_usd)).toBeCloseTo(0.7, 10);
  });

  it("keeps the name of a provider that no longer exists", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await ensureSchema(env);
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + HOUR, provider_id: "prov_gone", provider_name: "Gone Co" }));
    await aggregateDailyStats(env, DAY_DATE, "+480 minutes");

    const providers = (await statsByProvider(env, DAY_START_UTC)) as any[];
    expect(providers.map((p) => p.name)).toEqual(["Gone Co"]);
  });
});

describe("legacy daily_stats never overrides authoritative hourly and raw history", () => {
  it("ignores daily poison for aligned and exact partial-hour windows", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await ensureSchema(env);
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + HOUR, pricing_missing: true }));
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + 2 * HOUR }));
    poisonBucket(d1);

    const whole = await statsSummary(env, DAY_START_UTC);
    expect(Number(whole!.request_count)).toBe(2);
    expect(Number(whole!.cost_usd)).toBeCloseTo(0.02, 10);

    const rolling = await statsSummary(env, DAY_START_UTC + HOUR);
    expect(Number(rolling!.request_count)).toBe(2);
    expect(Number(rolling!.pricing_missing_count)).toBe(1);

    const trend = (await statsTrend(env, DAY_START_UTC + HOUR)) as any[];
    expect(trend).toHaveLength(1);
    expect(Number(trend[0].requests)).toBe(2);
    expect(Number(trend[0].cost_usd)).toBeCloseTo(0.02, 10);

    const partial = await statsSummary(env, DAY_START_UTC + HOUR + 1);
    expect(Number(partial!.request_count)).toBe(1);
    expect(Number(partial!.cost_usd)).toBeCloseTo(0.01, 10);
    expect(Number(partial!.pricing_missing_count)).toBe(0);
    const providers = await statsByProvider(env, DAY_START_UTC) as any[];
    const models = await statsByModel(env, DAY_START_UTC) as any[];
    expect(providers.map(p => p.name)).toEqual(["Provider A"]);
    expect(providers[0].requests).toBe(2);
    expect(providers[0].cost_usd).toBeCloseTo(0.02, 10);
    expect(models.map(m => m.name)).toEqual(["m1"]);
    expect(models[0].requests).toBe(2);
    expect(models[0].cost_usd).toBeCloseTo(0.02, 10);
  });

  it("a caller on another timezone also ignores legacy daily poison", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await ensureSchema(env);
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + HOUR }));
    poisonBucket(d1);

    const utc = await statsSummary(env, DAY_START_UTC, 0);
    expect(Number(utc!.request_count)).toBe(1);
    const utcProviders = (await statsByProvider(env, DAY_START_UTC, 0)) as any[];
    expect(utcProviders).toHaveLength(1);
    expect(utcProviders[0].name).toBe("Provider A");
  });
});

describe("immutable hourly history alongside the legacy daily projection", () => {
  it("refuses direct changes to authoritative raw, receipts, hourly and monthly rows", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await ensureSchema(env);
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + HOUR, cost_usd: 0.25 }));
    for (const sql of [
      "UPDATE usage SET cost_usd = 99",
      "UPDATE usage_rollup_receipts SET created_at = created_at + 1",
      "DELETE FROM usage_rollup_receipts",
      "UPDATE usage_hourly_rollups SET cost_usd = 99",
      "DELETE FROM usage_hourly_rollups",
      "UPDATE usage_monthly_rollups SET cost_usd = 99",
      "DELETE FROM usage_monthly_rollups",
    ]) {
      expect(() => d1.sql(sql)).toThrow("usage_rollup_immutable");
    }
    expect(() => d1.sql("DELETE FROM usage")).toThrow("usage_cleanup_not_authorized");
    const summary = await statsSummary(env, DAY_START_UTC);
    expect(Number(summary!.request_count)).toBe(1);
    expect(Number(summary!.cost_usd)).toBeCloseTo(0.25, 10);
    expect(d1.row<{ cost_usd: number }>("SELECT cost_usd FROM usage_monthly_rollups")!.cost_usd).toBeCloseTo(0.25, 10);
    d1.close();
  });
  it("accumulates the second call onto the first, average included", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await ensureSchema(env);
    await recordUsageSafe(
      env,
      row({
        created_at: DAY_START_UTC + HOUR,
        cost_usd: 0.25,
        latency_ms: 10,
        cache_hit: 1,
        pricing_missing: true,
        status_code: 500,
        usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300, cache_read_tokens: 400, cache_write_tokens: 500 },
      })
    );
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + 2 * HOUR, cost_usd: 0.5, latency_ms: 20 }));

    const bucket = d1.row<Record<string, number | string>>("SELECT * FROM daily_stats")!;
    expect(bucket.date).toBe(DAY_DATE);
    expect(Number(bucket.request_count)).toBe(2);
    expect(Number(bucket.input_tokens)).toBe(110);
    expect(Number(bucket.output_tokens)).toBe(220);
    expect(Number(bucket.total_tokens)).toBe(330);
    expect(Number(bucket.cost_usd)).toBeCloseTo(0.75, 10);
    expect(Number(bucket.cost_saved_usd)).toBeCloseTo(0.25, 10);
    expect(Number(bucket.cache_hit_count)).toBe(1);
    expect(Number(bucket.cache_read_tokens)).toBe(400);
    expect(Number(bucket.cache_write_tokens)).toBe(500);
    expect(Number(bucket.pricing_missing_count)).toBe(1);
    expect(Number(bucket.error_count)).toBe(1);
    expect(Number(bucket.avg_latency_ms)).toBeCloseTo(15, 10);
    expect(bucket.provider_name).toBe("Provider A");
  });

  it("does not count a request twice when the nightly rebuild runs over the same day", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await ensureSchema(env);
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + HOUR, cost_usd: 0.25 }));
    await recordUsageSafe(env, row({ created_at: DAY_START_UTC + 2 * HOUR, cost_usd: 0.5 }));

    const before = await statsSummary(env, DAY_START_UTC);
    expect(Number(before!.request_count)).toBe(2);

    await aggregateDailyStats(env, DAY_DATE, "+480 minutes");

    const after = await statsSummary(env, DAY_START_UTC);
    expect(Number(after!.request_count)).toBe(2);
    expect(Number(after!.cost_usd)).toBeCloseTo(0.75, 10);
    expect(Number(after!.avg_latency_ms)).toBeCloseTo(10, 10);
  });
});
