import type { Env } from "../types";
import {
  USAGE_HOUR_MS, USAGE_ROLLUP_DIMENSIONS, USAGE_ROLLUP_METRICS, usageMetricExpressions,
  USAGE_CLEANUP_ELIGIBLE_SQL, USAGE_ROLLUP_VERIFY_SQL,
} from "./usage_rollup_schema";

function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("usage_invalid_timestamp");
}
function range(from: number, toExclusive?: number): void {
  timestamp(from);
  if (toExclusive !== undefined) {
    timestamp(toExclusive);
    if (toExclusive < from) throw new Error("usage_invalid_range");
  }
}
function boundedLimit(limit: number | undefined, max: number): number {
  const n = limit ?? max;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error("usage_invalid_limit");
  return n;
}

export function usageReportSource(from: number, toExclusive?: number): { sql: string; binds: unknown[] } {
  range(from, toExclusive);
  const start = Math.ceil(from / USAGE_HOUR_MS) * USAGE_HOUR_MS;
  const end = toExclusive === undefined ? undefined : Math.floor(toExclusive / USAGE_HOUR_MS) * USAGE_HOUR_MS;
  const whole = "u.created_at>=?" + (end === undefined ? "" : " AND u.created_at<?");
  const wholeBinds = end === undefined ? [start] : [start, end];
  const rawRange = "u.created_at>=?" + (toExclusive === undefined ? "" : " AND u.created_at<?");
  const rawBinds = toExclusive === undefined ? [from] : [from, toExclusive];
  const columns = [...USAGE_ROLLUP_DIMENSIONS, ...USAGE_ROLLUP_METRICS].map(c => "h." + c).join(",");
  const rawColumns = USAGE_ROLLUP_DIMENSIONS.map(c => "u." + c).concat(
    usageMetricExpressions("u").map((e,i) => e + " AS " + USAGE_ROLLUP_METRICS[i]),
  ).join(",");
  return {
    sql: "(SELECT h.hour_start AS created_at," + columns + " FROM usage_hourly_rollups h WHERE h.hour_start>=?" +
      (end === undefined ? "" : " AND h.hour_start<?") +
      " UNION ALL SELECT u.created_at," + rawColumns + " FROM usage u WHERE " + rawRange +
      " AND (NOT (" + whole + ") OR NOT EXISTS (SELECT 1 FROM usage_rollup_receipts r WHERE r.id=u.id)))",
    binds: [...wholeBinds, ...rawBinds, ...wholeBinds],
  };
}

export async function validateUsageRange(env: Env, from: number, toExclusive?: number): Promise<void> {
  range(from, toExclusive);
  if (toExclusive === from) return;
  const partial = new Set<number>();
  if (from % USAGE_HOUR_MS !== 0) partial.add(Math.floor(from / USAGE_HOUR_MS) * USAGE_HOUR_MS);
  if (toExclusive !== undefined && toExclusive % USAGE_HOUR_MS !== 0) partial.add(Math.floor(toExclusive / USAGE_HOUR_MS) * USAGE_HOUR_MS);
  if (partial.size === 0) return;
  const found = await env.DB.prepare("SELECT hour_start FROM usage_rollup_archived_hours WHERE hour_start IN (" +
    [...partial].map(() => "?").join(",") + ") LIMIT 1").bind(...partial).first();
  if (found) throw new Error("usage_history_granularity_required");
}

export function usageCostExpression(fromSql: string, deviceSql?: string): string {
  if (!fromSql.trim() || (deviceSql !== undefined && !deviceSql.trim())) throw new Error("usage_invalid_sql_expression");
  return "(COALESCE((SELECT SUM(m.cost_usd) FROM usage_monthly_rollups m WHERE m.month_start >= (" + fromSql + ")" +
    (deviceSql === undefined ? "" : " AND m.device_id = (" + deviceSql + ")") + "),0) + " +
    "COALESCE((SELECT SUM(u.cost_usd) FROM usage u WHERE u.created_at >= (" + fromSql + ")" +
    (deviceSql === undefined ? "" : " AND u.device_id = (" + deviceSql + ")") +
    " AND NOT EXISTS (SELECT 1 FROM usage_rollup_receipts r WHERE r.id=u.id)),0))";
}

export type UsageRollupVerification = {
  ok: boolean;
  status: "verified" | "backfill_required" | "history_missing" | "mismatch";
  unprocessed: number; invalid_timestamps: number; receipt_mismatches: number;
  hourly_mismatches: number; monthly_mismatches: number; receipt_count_mismatches: number; missing_history: number;
};
export async function verifyUsageRollups(env: Env): Promise<UsageRollupVerification> {
  const row = await env.DB.prepare(USAGE_ROLLUP_VERIFY_SQL).first<Record<string, number>>();
  const names = ["unprocessed", "invalid_timestamps", "receipt_mismatches", "hourly_mismatches", "monthly_mismatches", "receipt_count_mismatches", "missing_history"] as const;
  if (!row || names.some(n => !Number.isSafeInteger(row[n]) || row[n] < 0)) throw new Error("usage_invalid_verification_result");
  const counts = Object.fromEntries(names.map(n => [n, row[n]])) as Pick<UsageRollupVerification, typeof names[number]>;
  const mismatch = counts.invalid_timestamps + counts.receipt_mismatches + counts.hourly_mismatches + counts.monthly_mismatches + counts.receipt_count_mismatches;
  const status = counts.missing_history ? "history_missing" : mismatch ? "mismatch" : counts.unprocessed ? "backfill_required" : "verified";
  return { ...counts, ok: status === "verified", status };
}

export async function backfillUsageRollups(env: Env, options: { limit?: number } = {}): Promise<{ processed: number; remaining: number }> {
  const limit = boundedLimit(options.limit, 500);
  const out = await env.DB.batch([
    env.DB.prepare("INSERT INTO usage_rollup_receipts(id,request_id,device_id,created_at) " +
      "SELECT u.id,u.request_id,u.device_id,u.created_at FROM usage u " +
      "WHERE u.created_at>=0 AND typeof(u.created_at)='integer' AND NOT EXISTS (SELECT 1 FROM usage_rollup_receipts r WHERE r.id=u.id) ORDER BY u.id LIMIT ?").bind(limit),
    env.DB.prepare("SELECT changes() AS processed, (SELECT COUNT(*) FROM usage u WHERE NOT EXISTS (SELECT 1 FROM usage_rollup_receipts r WHERE r.id=u.id)) AS remaining"),
  ]);
  const row = out[1]?.results?.[0] as { processed?: number; remaining?: number } | undefined;
  if (out.length !== 2 || out[0].success !== true || (out[1] as { success?: boolean }).success === false || !row ||
    !Number.isSafeInteger(row.processed) || row.processed! < 0 || row.processed! > limit ||
    !Number.isSafeInteger(row.remaining) || row.remaining! < 0) throw new Error("usage_invalid_backfill_result");
  return { processed: row.processed!, remaining: row.remaining! };
}

export type UsageCleanupCursor = { createdAt: number; id: number };
export type UsageCleanupOptions = { before: number; limit?: number; after?: UsageCleanupCursor };
export type UsageCleanupPreview = {
  scanned: number; eligible: number; next: UsageCleanupCursor | null;
  candidates: { id: number; created_at: number; eligible: number }[];
};
function cleanupOptions(options: UsageCleanupOptions): { limit: number; after: UsageCleanupCursor } {
  timestamp(options.before);
  if (!options.before || options.before % USAGE_HOUR_MS !== 0) throw new Error("usage_cleanup_hour_alignment_required");
  const limit = boundedLimit(options.limit, 1000);
  const after = options.after ?? { createdAt: 0, id: 0 };
  timestamp(after.createdAt);
  if (!Number.isSafeInteger(after.id) || after.id < 0) throw new Error("usage_invalid_cursor");
  return { limit, after };
}
export const USAGE_CLEANUP_PAGE_SQL = "WITH candidates AS MATERIALIZED (SELECT id,created_at FROM usage INDEXED BY idx_usage_rollup_cleanup_page " +
  "WHERE created_at<? AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT ?) " +
  "SELECT u.id,u.created_at,CASE WHEN " + USAGE_CLEANUP_ELIGIBLE_SQL + " THEN 1 ELSE 0 END AS eligible " +
  "FROM candidates c JOIN usage u ON u.id=c.id ORDER BY c.created_at,c.id";
export async function previewUsageCleanup(env: Env, options: UsageCleanupOptions): Promise<UsageCleanupPreview> {
  const { limit, after } = cleanupOptions(options);
  const page = await env.DB.prepare(USAGE_CLEANUP_PAGE_SQL).bind(options.before, after.createdAt, after.id, limit)
    .all<{ id: number; created_at: number; eligible: number }>();
  if (!Array.isArray(page.results) || page.results.length > limit || page.results.some(r =>
    !Number.isSafeInteger(r.id) || !Number.isSafeInteger(r.created_at) || (r.eligible !== 0 && r.eligible !== 1))) throw new Error("usage_invalid_cleanup_page");
  const last = page.results[page.results.length - 1];
  return { scanned: page.results.length, eligible: page.results.filter(r => r.eligible === 1).length,
    next: last ? { createdAt: last.created_at, id: last.id } : null, candidates: page.results };
}

export type UsageCleanupResult = { enabled: boolean; scanned: number; deleted: number; next: UsageCleanupCursor | null };
export async function cleanupUsageDetails(
  env: Env, options: Partial<UsageCleanupOptions> & { enabled?: boolean; operation_id?: string } = {},
): Promise<UsageCleanupResult> {
  if (options.enabled !== true) return { enabled: false, scanned: 0, deleted: 0, next: null };
  if (options.before === undefined) throw new Error("usage_cleanup_cutoff_required");
  const full = { ...options, before: options.before };
  const { limit, after } = cleanupOptions(full);
  const operationId = options.operation_id ?? crypto.randomUUID();
  if (typeof operationId !== "string" || !operationId.length || operationId.length > 200) throw new Error("usage_invalid_operation_id");
  const params = JSON.stringify({ before: full.before, limit, after });
  type Operation = { params_json: string; result_json: string | null };
  const decode = (row: Operation | null): UsageCleanupResult | null => {
    if (!row) return null;
    if (row.params_json !== params) throw new Error("usage_cleanup_operation_conflict");
    if (row.result_json === null) throw new Error("usage_cleanup_operation_incomplete");
    const result = JSON.parse(row.result_json) as UsageCleanupResult;
    if (result.enabled !== true || !Number.isSafeInteger(result.scanned) || !Number.isSafeInteger(result.deleted) || result.deleted < 0 || result.deleted > result.scanned || result.scanned > limit) throw new Error("usage_invalid_cleanup_result:not_replayed");
    return result;
  };
  const lookup = () => env.DB.prepare("SELECT params_json,result_json FROM usage_rollup_cleanup_operations WHERE operation_id=?").bind(operationId).first<Operation>();
  const previous = decode(await lookup());
  if (previous) return previous;
  const verification = await verifyUsageRollups(env);
  if (!verification.ok) throw new Error("usage_rollup_verification_required:" + verification.status);
  const page = await previewUsageCleanup(env, full);
  const ids = JSON.stringify(page.candidates.map(r => r.id));
  const nonce = crypto.randomUUID();
  const owned = "EXISTS(SELECT 1 FROM usage_rollup_cleanup_operations WHERE operation_id=? AND nonce=? AND result_json IS NULL)";
  const baseResult = JSON.stringify({ enabled: true, scanned: page.scanned, deleted: 0, next: page.next });
  const result = await env.DB.batch([
    env.DB.prepare("INSERT INTO usage_rollup_cleanup_operations(operation_id,params_json,nonce) VALUES(?,?,?) ON CONFLICT(operation_id) DO NOTHING").bind(operationId, params, nonce),
    env.DB.prepare("INSERT INTO usage_rollup_cleanup_context(id,before_ms,batch_limit) SELECT 1,?,? WHERE " + owned).bind(full.before, limit, operationId, nonce),
    env.DB.prepare("INSERT INTO usage_rollup_cleanup_permits(usage_id) SELECT u.id FROM json_each(?) ids JOIN usage u ON u.id=ids.value WHERE u.created_at<? AND " + USAGE_CLEANUP_ELIGIBLE_SQL + " AND " + owned).bind(ids, full.before, operationId, nonce),
    env.DB.prepare("DELETE FROM usage WHERE id IN (SELECT usage_id FROM usage_rollup_cleanup_permits)"),
    env.DB.prepare("UPDATE usage_rollup_cleanup_operations SET result_json=json_set(?,'$.deleted',changes()) WHERE operation_id=? AND nonce=? AND result_json IS NULL").bind(baseResult, operationId, nonce),
    env.DB.prepare("DELETE FROM usage_rollup_cleanup_context WHERE id=1"),
    env.DB.prepare("SELECT params_json,result_json FROM usage_rollup_cleanup_operations WHERE operation_id=?").bind(operationId),
  ]);
  if (result.length !== 7 || result.some(r => (r as { success?: boolean }).success === false)) throw new Error("usage_invalid_cleanup_result:not_replayed");
  const stored = result[6].results?.[0] as Operation | undefined;
  const committed = decode(stored ?? await lookup());
  if (!committed) throw new Error("usage_invalid_cleanup_result:not_replayed");
  return committed;
}
