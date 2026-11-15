import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema } from "../src/db/schema";
import {
  DAILY_STATS_REBUILD_DAYS,
  RETENTION_DELETE_CHUNK,
  aggregateDailyStats,
  chargeBalanceIfAffordable,
  cleanupOldUsage,
  ensureWallet,
  localDateString,
  localDayStartMs,
  recordUsageSafe,
  recentLocalDates,
  settleBalance,
  statsCostAnalytics,
  reserveBalance,
} from "../src/db/repo";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv } from "./helpers/realGatewayEnv";


const DAY = 24 * 60 * 60 * 1000;
const TZ = "+480 minutes";
const DAY_DATE = "2026-10-20";
const DAY_START_UTC = Date.UTC(2026, 9, 19, 16, 0, 0);

function insertUsageRow(
  d1: RealD1,
  over: {
    createdAt: number;
    device_id?: string | null;
    provider_id?: string | null;
    model?: string | null;
    cost_usd?: number;
    input_tokens?: number;
    output_tokens?: number;
    status_code?: number | null;
    latency_ms?: number | null;
    cache_hit?: number;
    request_id?: string;
  }
) {
  d1.sql(
    `INSERT INTO usage (
      device_id, provider_id, provider_name, model, input_tokens, output_tokens, total_tokens,
      cost_usd, cache_hit, cache_read_tokens, cache_write_tokens, pricing_missing,
      price_multiplier, price_window_id, status_code, latency_ms, request_id, created_at, image_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 1, NULL, ?, ?, ?, ?, 0)`,
    over.device_id === undefined ? "dev_1" : over.device_id,
    over.provider_id === undefined ? "prov_a" : over.provider_id,
    "Provider A",
    over.model === undefined ? "m1" : over.model,
    over.input_tokens ?? 10,
    over.output_tokens ?? 20,
    (over.input_tokens ?? 10) + (over.output_tokens ?? 20),
    over.cost_usd ?? 0.01,
    over.cache_hit ?? 0,
    over.status_code === undefined ? 200 : over.status_code,
    over.latency_ms === undefined ? 5 : over.latency_ms,
    over.request_id ?? "req-" + over.createdAt + "-" + Math.random().toString(36).slice(2, 8),
    over.createdAt
  );
}

function dailyRows(d1: RealD1) {
  return d1.rows<{
    date: string;
    device_id: string;
    provider_id: string;
    model: string;
    request_count: number;
    cost_usd: number;
    error_count: number;
  }>(
    "SELECT date, device_id, provider_id, model, request_count, cost_usd, error_count " +
      "FROM daily_stats ORDER BY date ASC, model ASC"
  );
}

function sumUsage(d1: RealD1, fromMs: number, toMs: number) {
  const row = d1.row<{ n: number; cost: number; errors: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost, " +
      "COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) AS errors " +
      "FROM usage WHERE created_at >= ? AND created_at < ?",
    fromMs,
    toMs
  );
  return { n: Number(row?.n ?? 0), cost: Number(row?.cost ?? 0), errors: Number(row?.errors ?? 0) };
}

describe("the local-day helpers agree with the SQL grouping they replace", () => {
  it("maps a date to the UTC instant its local day begins", () => {
    expect(localDayStartMs(DAY_DATE, -480)).toBe(DAY_START_UTC);
    const d1 = createRealD1();
    const row = d1.row<{ d: string }>(
      "SELECT strftime('%Y-%m-%d', datetime(? / 1000, 'unixepoch', ?)) AS d",
      DAY_START_UTC,
      TZ
    );
    expect(row?.d).toBe(DAY_DATE);
  });

  it("rejects strings that are not a real calendar date", () => {
    expect(localDayStartMs("2026-02-31", -480)).toBeNull();
    expect(localDayStartMs("2026-13-01", -480)).toBeNull();
    expect(localDayStartMs("not-a-date", -480)).toBeNull();
  });

  it("names the trailing local days, newest first, with no duplicates across a DST-free offset", () => {
    const now = DAY_START_UTC + 6 * 60 * 60 * 1000;  
    const dates = recentLocalDates(3, -480, now);
    expect(dates).toEqual(["2026-10-20", "2026-10-19", "2026-10-18"]);
    expect(recentLocalDates(DAILY_STATS_REBUILD_DAYS, -480, now)).toHaveLength(DAILY_STATS_REBUILD_DAYS);
  });

  it("formats a timestamp as the local date, not the UTC one", () => {
    expect(localDateString(DAY_START_UTC)).toBe(DAY_DATE);
    expect(localDateString(DAY_START_UTC, 0)).toBe("2026-10-19");
  });
});

describe("rebuilding one local day reproduces the raw rows for that day", () => {
  it("counts every row of the day, including the ones a 48-hour window would have missed", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    insertUsageRow(d1, { createdAt: DAY_START_UTC + 60 * 1000, model: "m1" });
    insertUsageRow(d1, { createdAt: DAY_START_UTC + 60 * 1000, model: "m1", request_id: "r2" });
    insertUsageRow(d1, { createdAt: DAY_START_UTC + 20 * 60 * 60 * 1000, model: "m2", cost_usd: 0.5 });
    insertUsageRow(d1, { createdAt: DAY_START_UTC - 1000, model: "m1" });

    const res = await aggregateDailyStats(env, DAY_DATE, TZ);
    expect(res.aggregated).toBeGreaterThan(0);

    const rows = dailyRows(d1);
    const day = rows.filter((r) => r.date === DAY_DATE);
    expect(day.map((r) => r.model).sort()).toEqual(["m1", "m2"]);
    expect(day.find((r) => r.model === "m1")!.request_count).toBe(2);
    expect(day.find((r) => r.model === "m2")!.request_count).toBe(1);

    const truth = sumUsage(d1, DAY_START_UTC, DAY_START_UTC + DAY);
    expect(day.reduce((a, r) => a + r.request_count, 0)).toBe(truth.n);
    expect(day.reduce((a, r) => a + r.cost_usd, 0)).toBeCloseTo(truth.cost, 10);
  });

  it("replaces an understated slot from the complete source instead of adding to it", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    insertUsageRow(d1, { createdAt: DAY_START_UTC + 1000 });
    d1.sql(
      "INSERT OR REPLACE INTO daily_stats (date, device_id, provider_id, model, request_count, cost_usd) VALUES (?, 'dev_1', 'prov_a', 'm1', 0, 0)",
      DAY_DATE
    );

    await aggregateDailyStats(env, DAY_DATE, TZ);

    const day = dailyRows(d1).filter((r) => r.date === DAY_DATE);
    expect(day).toHaveLength(1);
    expect(day[0].request_count).toBe(1);
    expect(day[0].cost_usd).toBeCloseTo(0.01, 10);
  });

  it("preserves an overstated legacy slot when completeness cannot be proven", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    insertUsageRow(d1, { createdAt: DAY_START_UTC + 1000 });
    d1.sql("INSERT OR REPLACE INTO daily_stats (date,device_id,provider_id,model,request_count,cost_usd) VALUES (?,'dev_1','prov_a','m1',999,123.456)", DAY_DATE);
    const before = dailyRows(d1);
    await expect(aggregateDailyStats(env, DAY_DATE, TZ)).rejects.toThrow("usage_history_missing");
    expect(dailyRows(d1)).toEqual(before);
    expect(sumUsage(d1, DAY_START_UTC, DAY_START_UTC + DAY)).toMatchObject({ n: 1, cost: 0.01 });
  });

  it("leaves other days alone when it rebuilds one", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const otherDate = "2026-10-19";
    d1.sql(
      "INSERT OR REPLACE INTO daily_stats (date, device_id, provider_id, model, request_count) VALUES (?, 'dev_1', 'prov_a', 'keep', 7)",
      otherDate
    );
    insertUsageRow(d1, { createdAt: DAY_START_UTC + 1000 });

    await aggregateDailyStats(env, DAY_DATE, TZ);

    const kept = dailyRows(d1).filter((r) => r.date === otherDate);
    expect(kept).toHaveLength(1);
    expect(kept[0].request_count).toBe(7);
  });

  it("counts errors the same way the report does", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    insertUsageRow(d1, { createdAt: DAY_START_UTC + 1000, status_code: 200 });
    insertUsageRow(d1, { createdAt: DAY_START_UTC + 2000, status_code: 500 });
    insertUsageRow(d1, { createdAt: DAY_START_UTC + 3000, status_code: 429 });

    await aggregateDailyStats(env, DAY_DATE, TZ);

    const day = dailyRows(d1).filter((r) => r.date === DAY_DATE);
    expect(day.reduce((a, r) => a + r.error_count, 0)).toBe(2);
  });

  it("does not merge rows that differ only by device or provider", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    insertUsageRow(d1, { createdAt: DAY_START_UTC + 1000, device_id: "dev_1", provider_id: "prov_a" });
    insertUsageRow(d1, { createdAt: DAY_START_UTC + 2000, device_id: "dev_1", provider_id: "prov_b" });
    insertUsageRow(d1, { createdAt: DAY_START_UTC + 3000, device_id: "dev_2", provider_id: "prov_a" });

    await aggregateDailyStats(env, DAY_DATE, TZ);

    const day = dailyRows(d1).filter((r) => r.date === DAY_DATE);
    expect(day).toHaveLength(3);
  });
});

describe("legacy retention cannot bypass the verified preview workflow", () => {
  it("refuses deletion even for more old rows than a legacy chunk holds", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const now = Date.now();
    const old = now - 400 * DAY;
    await ensureSchema(env);
    const extra = RETENTION_DELETE_CHUNK + 200;
    d1.sql(
      `WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < ${extra})
       INSERT INTO usage (device_id, provider_id, provider_name, model, input_tokens, output_tokens,
         total_tokens, cost_usd, cache_hit, cache_read_tokens, cache_write_tokens, pricing_missing,
         price_multiplier, price_window_id, status_code, latency_ms, request_id, created_at, image_count)
       SELECT 'dev_1', 'prov_a', 'Provider A', 'old', 1, 1, 2, 0.001, 0, 0, 0, 0, 1, NULL, 200, 1,
         'bulk-' || x, ${old}, 0 FROM seq`
    );
    insertUsageRow(d1, { createdAt: now - 1 * DAY, model: "fresh", request_id: "keep-me" });

    d1.sql("INSERT INTO audit_logs (actor_type, action, target_type, target_id, summary, created_at) VALUES ('admin', 'keep-audit', 'usage', 'old', 'preserve', ?)", old);
    const before = d1.rows("SELECT model, COUNT(*) AS n, SUM(cost_usd) AS cost FROM usage GROUP BY model ORDER BY model");
    const hourly = d1.rows("SELECT * FROM usage_hourly_rollups ORDER BY hour_start, dimension_key");
    const monthly = d1.rows("SELECT * FROM usage_monthly_rollups ORDER BY month_start, dimension_key");

    await expect(cleanupOldUsage(env, { retentionDays: 30, keepDailyStats: true }))
      .rejects.toThrow("usage_retention_requires_verified_preview");

    expect(d1.rows("SELECT model, COUNT(*) AS n, SUM(cost_usd) AS cost FROM usage GROUP BY model ORDER BY model")).toEqual(before);
    expect(d1.row<{ n: number }>("SELECT COUNT(*) AS n FROM usage")!.n).toBe(extra + 1);
    expect(d1.rows("SELECT action FROM audit_logs")).toEqual([{ action: "keep-audit" }]);
    expect(d1.rows("SELECT * FROM usage_hourly_rollups ORDER BY hour_start, dimension_key")).toEqual(hourly);
    expect(d1.rows("SELECT * FROM usage_monthly_rollups ORDER BY month_start, dimension_key")).toEqual(monthly);
  });

  it("refuses explicit cutoffs and preserves daily history even when keepDailyStats is false", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const cutoffMs = DAY_START_UTC + 6 * 60 * 60 * 1000;  
    d1.sql(
      "INSERT OR REPLACE INTO daily_stats (date, device_id, provider_id, model, request_count) VALUES (?, 'd', 'p', 'm', 1)",
      "2026-10-19"
    );
    d1.sql(
      "INSERT OR REPLACE INTO daily_stats (date, device_id, provider_id, model, request_count) VALUES (?, 'd', 'p', 'm', 1)",
      DAY_DATE
    );

    const before = dailyRows(d1);
    await expect(cleanupOldUsage(env, { cutoffMs, keepDailyStats: false }))
      .rejects.toThrow("usage_retention_requires_verified_preview");

    expect(dailyRows(d1)).toEqual(before);
    expect(dailyRows(d1).map((r) => r.date)).toEqual(["2026-10-19", DAY_DATE]);
  });
});

describe("the cost report describes the window it actually covered", () => {
  it("echoes the requested range instead of always claiming 30d", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const since = Date.now() - 7 * DAY;

    expect((await statsCostAnalytics(env, since, TZ, "7d")).range).toBe("7d");
    expect((await statsCostAnalytics(env, since, TZ, "90d")).range).toBe("90d");
    expect((await statsCostAnalytics(env, since, TZ)).range).toBe("30d");
  });

  it("prices a spike day from a half-open millisecond window, not a strftime scan", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    for (const [dayOffset, cost, model] of [
      [-3, 0.2, "cheap"],
      [-2, 0.2, "cheap"],
      [-1, 12, "expensive"],
    ] as const) {
      insertUsageRow(d1, {
        createdAt: DAY_START_UTC + dayOffset * DAY + 60 * 60 * 1000,
        cost_usd: cost,
        model,
      });
    }

    const analytics = await statsCostAnalytics(env, DAY_START_UTC - 4 * DAY, TZ, "7d");

    expect(analytics.anomaly_alert.is_anomaly).toBe(true);
    expect(analytics.anomaly_alert.spike_date).toBe("2026-10-19");
    expect(analytics.anomaly_alert.top_contributor_model).toBe("expensive");
    expect(analytics.total_cost_usd).toBeCloseTo(12.4, 6);
  });
});

describe("the usage row and the device touch share one round trip", () => {
  it("writes both in a single batch", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    d1.sql(
      "INSERT INTO devices (id, name, token_hash, enabled, model_scope, created_at) VALUES ('dev_1', 'Device 1', 'hash', 1, 'all', 1)"
    );
    const batches: number[] = [];
    const realBatch = env.DB.batch.bind(env.DB);
    (env.DB as any).batch = async (statements: unknown[]) => {
      batches.push(statements.length);
      return realBatch(statements as never);
    };

    await recordUsageSafe(env, {
      device_id: "dev_1",
      provider_id: "prov_a",
      provider_name: "Provider A",
      model: "m1",
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 0 },
      cost_usd: 0.5,
      status_code: 200,
      latency_ms: 12,
      request_id: "req-batch",
      created_at: Date.now(),
    });

    expect(batches).toEqual([3]);
    expect(d1.rows<{ n: number }>("SELECT COUNT(*) AS n FROM usage")).toEqual([{ n: 1 }]);
    expect(d1.rows<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE last_used_at IS NOT NULL")).toEqual([{ n: 1 }]);
    const buckets = d1.rows<{ request_count: number; cost_usd: number; total_tokens: number }>(
      "SELECT request_count, cost_usd, total_tokens FROM daily_stats"
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].request_count).toBe(1);
    expect(buckets[0].total_tokens).toBe(30);
    expect(buckets[0].cost_usd).toBeCloseTo(0.5, 10);
  });

  it("still records usage for an unknown device, without the touch", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const batches: number[] = [];
    const realBatch = env.DB.batch.bind(env.DB);
    (env.DB as any).batch = async (statements: unknown[]) => {
      batches.push(statements.length);
      return realBatch(statements as never);
    };

    await recordUsageSafe(env, {
      device_id: "dev-missing",
      provider_id: null,
      provider_name: null,
      model: "m1",
      usage: null,
      status_code: 0,
      latency_ms: null,
      request_id: "req-orphan",
      created_at: Date.now(),
    });

    expect(batches).toEqual([3]);
    expect(d1.rows<{ n: number }>("SELECT COUNT(*) AS n FROM usage")).toEqual([{ n: 1 }]);
    expect(d1.rows<{ n: number }>("SELECT COUNT(*) AS n FROM daily_stats")).toEqual([{ n: 1 }]);
  });

  it("never replays statements after the batch itself threw", async () => {
    const runSpy = vi.fn(async () => ({ meta: { changes: 1 } }));
    const env = {
      DB: {
        prepare: () => ({ bind: () => ({ run: runSpy, first: async () => null, all: async () => ({ results: [] }) }) }),
        batch: async () => {
          throw new Error("batch exploded");
        },
      },
    } as any;

    await recordUsageSafe(env, {
      device_id: "dev_1",
      provider_id: null,
      provider_name: null,
      model: "m1",
      usage: null,
      status_code: 200,
      latency_ms: 1,
      request_id: "req-boom",
      created_at: Date.now(),
    });

    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe("the wallet writes keep their ledger semantics with the fused read-back", () => {
  it("settles against the balance the UPDATE produced", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await ensureWallet(env, "dev_1", 1);

    expect(await reserveBalance(env, "dev_1", 0.5, "req-1")).toBe(true);
    expect(await settleBalance(env, "dev_1", 0.5, 0.3, "req-1")).toBeCloseTo(0.7, 10);

    expect(
      d1.rows("SELECT delta_usd, balance_after, reason, request_id FROM wallet_ledger")
    ).toEqual([{ delta_usd: -0.3, balance_after: 0.7, reason: "usage", request_id: "req-1" }]);
    expect(d1.rows<{ n: number }>("SELECT COUNT(*) AS n FROM reserve_holds")).toEqual([{ n: 0 }]);
  });

  it("still refuses a cache-hit charge that does not fit and writes no ledger row", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await ensureWallet(env, "dev_1", 0.1);

    expect(await chargeBalanceIfAffordable(env, "dev_1", 0.5, "req-hit")).toBe(false);
    expect(d1.rows<{ n: number }>("SELECT COUNT(*) AS n FROM wallet_ledger")).toEqual([{ n: 0 }]);
    expect(d1.row<{ balance_usd: number }>("SELECT balance_usd FROM device_wallets")).toEqual({ balance_usd: 0.1 });
  });

  it("records the balance the cache-hit charge produced", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await ensureWallet(env, "dev_1", 1);

    expect(await chargeBalanceIfAffordable(env, "dev_1", 0.25, "req-hit")).toBe(true);
    expect(d1.rows("SELECT delta_usd, balance_after FROM wallet_ledger")).toEqual([
      { delta_usd: -0.25, balance_after: 0.75 },
    ]);
  });
});
