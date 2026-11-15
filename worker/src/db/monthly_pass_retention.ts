import type { Env } from "../types";
import { ensureSchema } from "./schema";

export const MONTHLY_PASS_RETENTION_SCHEMA_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_monthly_retention_settled ON billing_requests(settled_at,request_id) WHERE billing_state='settled' AND settled_at IS NOT NULL AND hold_released_at IS NOT NULL AND known_cost_usd IS NOT NULL AND terminal_snapshot_json IS NOT NULL AND outcome IS NOT NULL AND outcome NOT IN ('unknown','not_dispatched')",
] as const;

export const MONTHLY_PASS_RETENTION_MAX_BATCH = 100;
const eligibleRequest = "r.billing_state='settled' AND r.settled_at IS NOT NULL AND r.hold_released_at IS NOT NULL AND r.known_cost_usd IS NOT NULL AND r.terminal_snapshot_json IS NOT NULL AND r.outcome IS NOT NULL AND r.outcome NOT IN ('unknown','not_dispatched')";

export const MONTHLY_PASS_RETENTION_PAGE_SQL =
  "SELECT r.request_id,r.settled_at FROM billing_requests r INDEXED BY idx_monthly_retention_settled WHERE " + eligibleRequest +
  " AND (r.settled_at,r.request_id)>(?,?) AND r.settled_at<? ORDER BY r.settled_at,r.request_id LIMIT ?";

export type MonthlyPassRetentionCursor = Readonly<{ settledAt: number; requestId: string }>;
export type MonthlyPassRetentionOptions = {
  enabled?: boolean;
  before?: number;
  batchLimit?: number;
  after?: MonthlyPassRetentionCursor;
};
export type MonthlyPassRetentionResult = {
  enabled: boolean; scanned: number; requestBucketsDeleted: number; fundingDeleted: number;
  next: MonthlyPassRetentionCursor | null;
};

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function cleanupMonthlyPassAttribution(
  env: Env, options: MonthlyPassRetentionOptions = {},
): Promise<MonthlyPassRetentionResult> {
  const empty: MonthlyPassRetentionResult = { enabled: false, scanned: 0, requestBucketsDeleted: 0, fundingDeleted: 0, next: null };
  if (options.enabled !== true || options.before === undefined) return empty;
  if (!positiveInteger(options.before)) throw new Error("Invalid monthly retention cutoff");
  const limit = options.batchLimit ?? MONTHLY_PASS_RETENTION_MAX_BATCH;
  if (!positiveInteger(limit) || limit > MONTHLY_PASS_RETENTION_MAX_BATCH) throw new Error("Invalid monthly retention batch limit");
  const after = options.after;
  if (after !== undefined && (!positiveInteger(after.settledAt) || typeof after.requestId !== "string" ||
      !after.requestId || after.requestId.length > 512 || /[\r\n\x00]/.test(after.requestId))) {
    throw new Error("Invalid monthly retention cursor");
  }
  await ensureSchema(env);
  const page = await env.DB.prepare(MONTHLY_PASS_RETENTION_PAGE_SQL)
    .bind(after?.settledAt ?? 0, after?.requestId ?? "", options.before, limit)
    .all<{ request_id: string; settled_at: number }>();
  if (!Array.isArray(page.results) || page.results.length > limit) throw new Error("Invalid monthly retention page");
  if (page.results.length === 0) return { ...empty, enabled: true };
  const ids = JSON.stringify(page.results.map(row => row.request_id));
  const eligible = "SELECT r.request_id FROM json_each(?) ids CROSS JOIN billing_requests r ON r.request_id=ids.value " +
    "CROSS JOIN monthly_pass_funding f ON f.request_id=r.request_id WHERE " + eligibleRequest +
    " AND r.settled_at<? AND r.hold_released_at<? AND f.released=1 AND f.settled=1 " +
    "AND NOT EXISTS (SELECT 1 FROM reserve_holds h WHERE h.request_id=r.request_id)";
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM monthly_pass_request_buckets WHERE (request_id,kind) IN (" +
      "SELECT h.request_id,h.kind FROM (" + eligible + ") e CROSS JOIN monthly_pass_request_buckets h ON h.request_id=e.request_id LIMIT ?)")
      .bind(ids, options.before, options.before, 4 * limit),
    env.DB.prepare("DELETE FROM monthly_pass_funding WHERE request_id IN (" + eligible +
      " AND NOT EXISTS (SELECT 1 FROM monthly_pass_request_buckets h WHERE h.request_id=r.request_id))")
      .bind(ids, options.before, options.before),
  ]);
  if (!Array.isArray(results) || results.length !== 2 || results.some(r => r?.success !== true || !r.meta)) {
    throw new Error("Invalid monthly retention transaction result; not replayed");
  }
  const last = page.results[page.results.length - 1];
  return {
    enabled: true, scanned: page.results.length,
    requestBucketsDeleted: Number(results[0].meta.changes), fundingDeleted: Number(results[1].meta.changes),
    next: { settledAt: last.settled_at, requestId: last.request_id },
  };
}
