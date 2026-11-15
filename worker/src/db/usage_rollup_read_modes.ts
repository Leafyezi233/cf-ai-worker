import type { Env } from "../types";
import { USAGE_ROLLUP_DIMENSIONS, USAGE_ROLLUP_METRICS, usageMetricExpressions } from "./usage_rollup_schema";
import { usageReportSource, validateUsageRange } from "./usage_rollups";

export async function usageGroupedReportSource(env: Env, from: number, toExclusive: number | undefined, tzOffsetMinutes: number) {
  if (!Number.isFinite(tzOffsetMinutes)) throw new Error("usage_invalid_range");
  await validateUsageRange(env, from, toExclusive);
  if (tzOffsetMinutes % 60 === 0) return usageReportSource(from, toExclusive);
  const archived = await env.DB.prepare("SELECT hour_start FROM usage_rollup_archived_hours WHERE hour_start>=?" + (toExclusive === undefined ? "" : " AND hour_start<?") + " LIMIT 1")
    .bind(Math.floor(from / 3600000) * 3600000, ...(toExclusive === undefined ? [] : [toExclusive])).first();
  if (archived) throw new Error("usage_history_granularity_required");
  const columns = USAGE_ROLLUP_DIMENSIONS.map(c => "u." + c).concat(usageMetricExpressions("u").map((e, i) => e + " AS " + USAGE_ROLLUP_METRICS[i])).join(",");
  return { sql: "(SELECT u.created_at," + columns + " FROM usage u WHERE u.created_at>=?" + (toExclusive === undefined ? "" : " AND u.created_at<?") + ")", binds: toExclusive === undefined ? [from] : [from,toExclusive] };
}
