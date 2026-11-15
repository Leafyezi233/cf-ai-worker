import type { Env } from "../types";

type DatabaseEnv = Pick<Env, "DB">;

export const MONTHLY_DEVICE_STATS_COVERAGE_KEY = "account_list_daily_coverage_v1";
export const MONTHLY_DEVICE_STATS_COST_TOLERANCE_USD = 1e-9;

function coverageWindow(startOfMonthMs: number): { date: string; value: string } {
  if (!Number.isSafeInteger(startOfMonthMs)) throw new Error("Expected a UTC+8 month-start timestamp");
  const local = new Date(startOfMonthMs + 480 * 60_000);
  if (!Number.isFinite(local.getTime()) || !/^\d{4}-\d{2}-01T00:00:00\.000Z$/.test(local.toISOString())) {
    throw new Error("Expected a UTC+8 month-start timestamp");
  }
  const date = local.toISOString().slice(0, 10);
  return { date, value: JSON.stringify({ version: 1, start_ms: startOfMonthMs, tolerance_usd: MONTHLY_DEVICE_STATS_COST_TOLERANCE_USD }) };
}

export function monthlyDeviceCostExpression(startOfMonthMs: number): {
  sql: string;
  params: [string, string, string, number];
} {
  const window = coverageWindow(startOfMonthMs);
  return {
    sql: `CASE WHEN d.id <> '' AND EXISTS (
      SELECT 1 FROM settings WHERE key = ? AND value_json = ?
    ) THEN (
      SELECT COALESCE(SUM(ds.cost_usd), 0) FROM daily_stats ds
      WHERE ds.device_id = d.id AND ds.date >= ?
    ) ELSE (
      SELECT COALESCE(SUM(u.cost_usd), 0) FROM usage u
      WHERE u.device_id = d.id AND u.created_at >= ?
    ) END`,
    params: [MONTHLY_DEVICE_STATS_COVERAGE_KEY, window.value, window.date, startOfMonthMs],
  };
}

export function invalidateMonthlyDeviceStatsStatement(env: DatabaseEnv): D1PreparedStatement {
  return env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(MONTHLY_DEVICE_STATS_COVERAGE_KEY);
}

export async function verifyMonthlyDeviceStatsCoverage(env: DatabaseEnv, startOfMonthMs: number): Promise<boolean> {
  const window = coverageWindow(startOfMonthMs);
  const stamp = env.DB.prepare(`
    WITH raw_buckets AS (
      SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', '+480 minutes') AS date,
        COALESCE(device_id, '') AS device_id, COALESCE(provider_id, '') AS provider_id,
        COALESCE(model, '') AS model, COUNT(*) AS n, SUM(cost_usd) AS cost,
        SUM(CASE WHEN typeof(cost_usd) NOT IN ('integer', 'real')
          OR ABS(cost_usd) > 1.7976931348623157e308
          OR typeof(created_at) NOT IN ('integer', 'real')
          OR strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', '+480 minutes') IS NULL
          THEN 1 ELSE 0 END) AS bad
      FROM usage WHERE created_at >= ?
      GROUP BY date, COALESCE(device_id, ''), COALESCE(provider_id, ''), COALESCE(model, '')
    ), combined AS (
      SELECT date, device_id, provider_id, model, n AS raw_n, 0 AS daily_n,
        cost AS raw_cost, 0 AS daily_cost, 1 AS raw_present, 0 AS daily_present, bad
      FROM raw_buckets
      UNION ALL
      SELECT date, COALESCE(device_id, ''), COALESCE(provider_id, ''), COALESCE(model, ''),
        0, request_count, 0, cost_usd, 0, 1,
        CASE WHEN typeof(request_count) <> 'integer' OR request_count < 1
          OR typeof(cost_usd) NOT IN ('integer', 'real') OR ABS(cost_usd) > 1.7976931348623157e308
          OR length(date) <> 10 OR date(date, '+0 days') IS NOT date
          THEN 1 ELSE 0 END
      FROM daily_stats WHERE date >= ?
    ), buckets AS (
      SELECT date, device_id, provider_id, model, SUM(raw_n) AS raw_n, SUM(daily_n) AS daily_n,
        SUM(raw_cost) AS raw_cost, SUM(daily_cost) AS daily_cost,
        SUM(raw_present) AS raw_present, SUM(daily_present) AS daily_present, SUM(bad) AS bad
      FROM combined GROUP BY date, device_id, provider_id, model
    ), devices AS (
      SELECT device_id, SUM(raw_cost) AS raw_cost, SUM(daily_cost) AS daily_cost
      FROM buckets GROUP BY device_id
    )
    INSERT INTO settings (key, value_json, updated_at)
    SELECT ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM buckets WHERE bad <> 0 OR raw_present = 0 OR daily_present = 0 OR raw_n <> daily_n
        OR (ABS(raw_cost - daily_cost) <= ?) IS NOT 1
    ) AND NOT EXISTS (
      SELECT 1 FROM devices WHERE (ABS(raw_cost - daily_cost) <= ?) IS NOT 1
    )
  `).bind(startOfMonthMs, window.date, MONTHLY_DEVICE_STATS_COVERAGE_KEY, window.value, Date.now(),
    MONTHLY_DEVICE_STATS_COST_TOLERANCE_USD, MONTHLY_DEVICE_STATS_COST_TOLERANCE_USD);
  const results = await env.DB.batch([invalidateMonthlyDeviceStatsStatement(env), stamp]);
  return Number(results[1]?.meta?.changes ?? 0) === 1;
}
