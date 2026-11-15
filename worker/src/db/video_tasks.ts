import type { Env } from "../types";
import { ensureSchema } from "./schema";
import { usageCostExpression } from "./usage_rollups";

export type VideoTaskStatus = "submitting" | "submission_unknown" | "pending" | "succeeded" | "failed";

export interface VideoTask {
  id: string;
  device_id: string;
  sub_token_id: string | null;
  idempotency_key: string;
  request_hash: string;
  status: VideoTaskStatus;
  upstream_task_id: string | null;
  route_json: string;
  price_usd: number;
  pricing_snapshot_json: string;
  upstream_usage_json?: string | null;
  result_url: string | null;
  error_code: string | null;
  poll_after: number | null;
  poll_lease_until: number | null;
  poll_claim?: string | null;
  poll_attempts?: number;
  created_at: number;
  updated_at: number;
  settlement_claim?: string | null;
}

export async function getVideoTask(env: Env, id: string, deviceId?: string): Promise<VideoTask | null> {
  await ensureSchema(env);
  return deviceId === undefined
    ? env.DB.prepare("SELECT * FROM video_tasks WHERE id = ?").bind(id).first<VideoTask>()
    : env.DB.prepare("SELECT * FROM video_tasks WHERE id = ? AND device_id = ?").bind(id, deviceId).first<VideoTask>();
}

export async function findVideoTask(env: Env, deviceId: string, key: string): Promise<VideoTask | null> {
  await ensureSchema(env);
  return env.DB.prepare("SELECT * FROM video_tasks WHERE device_id = ? AND idempotency_key = ?")
    .bind(deviceId, key).first<VideoTask>();
}

export async function listVideoTasks(env: Env, deviceId: string, limit = 30, subTokenId?: string): Promise<VideoTask[]> {
  await ensureSchema(env);
  const count = Number.isFinite(limit) ? Math.min(30, Math.max(0, Math.floor(limit))) : 30;
  const query = subTokenId === undefined
    ? env.DB.prepare("SELECT * FROM video_tasks WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").bind(deviceId, count)
    : env.DB.prepare("SELECT * FROM video_tasks WHERE device_id = ? AND sub_token_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").bind(deviceId, subTokenId, count);
  const result = await query.all<VideoTask>();
  return result.results || [];
}

function assertJsonObject(value: string, name: string): void {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid video " + name);
}

export interface VideoBudget {
  monthStartMs: number;
  globalLimit?: number;
  deviceLimit?: number;
}
export type VideoBudgetError = "monthly_budget_exceeded" | "device_budget_exceeded";
const ACTIVE_VIDEO = "status IN ('submitting', 'submission_unknown', 'pending')";

function budgetConditions(deviceId: string, price: number, budget?: VideoBudget): { sql: string; conditions: string[]; binds: (number | string)[]; errors: VideoBudgetError[] } {
  const conditions: string[] = [];
  const binds: (number | string)[] = [];
  const errors: VideoBudgetError[] = [];
  if (!budget) return { sql: "", conditions, binds, errors };
  if (!Number.isSafeInteger(budget.monthStartMs) || budget.monthStartMs < 0) throw new Error("Invalid video budget period");
  for (const [limit, device, error] of [
    [budget.globalLimit, false, "monthly_budget_exceeded"],
    [budget.deviceLimit, true, "device_budget_exceeded"],
  ] as const) {
    if (limit === undefined) continue;
    if (!Number.isFinite(limit) || limit < 0) throw new Error("Invalid video budget limit");
    conditions.push("(" + usageCostExpression("?", device ? "?" : undefined) + " + (SELECT COALESCE(SUM(price_usd), 0) FROM video_tasks WHERE " +
      ACTIVE_VIDEO + (device ? " AND device_id = ?" : "") + ") + ? <= ?)");
    binds.push(budget.monthStartMs);
    if (device) binds.push(deviceId);
    binds.push(budget.monthStartMs);
    if (device) binds.push(deviceId, deviceId);
    binds.push(price, limit);
    errors.push(error);
  }
  return { sql: conditions.join(" AND "), conditions, binds, errors };
}

export async function videoBudgetError(env: Env, deviceId: string, price: number, budget: VideoBudget): Promise<VideoBudgetError | null> {
  await ensureSchema(env);
  if (!Number.isFinite(price) || price < 0) throw new Error("Invalid video price");
  const gate = budgetConditions(deviceId, price, budget);
  if (!gate.sql) return null;
  const selections = gate.conditions.map((expression, i) => expression + " AS ok" + i);
  const row = await env.DB.prepare("SELECT " + selections.join(", ")).bind(...gate.binds).first<Record<string, number>>();
  return gate.errors.find((_, i) => !row?.["ok" + i]) ?? null;
}

export async function createVideoTask(env: Env, task: VideoTask, budget?: VideoBudget, referenceIds?: string[]): Promise<boolean> {
  await ensureSchema(env);
  if (!Number.isFinite(task.price_usd) || task.price_usd < 0) throw new Error("Invalid video price");
  if (task.status !== "submitting" || task.upstream_task_id !== null || task.settlement_claim != null ||
      task.result_url !== null || task.error_code !== null || task.poll_lease_until !== null ||
      task.poll_claim != null || (task.poll_attempts ?? 0) !== 0) {
    throw new Error("Invalid initial video task state");
  }
  assertJsonObject(task.route_json, "route snapshot");
  assertJsonObject(task.pricing_snapshot_json, "pricing snapshot");
  const frozenIds: unknown = JSON.parse(task.route_json).reference_image_ids;
  if (referenceIds !== undefined && (!Array.isArray(referenceIds) || referenceIds.length > 3 ||
      new Set(referenceIds).size !== referenceIds.length || referenceIds.some(id => typeof id !== "string" || !/^vref_[a-f0-9]{32}$/.test(id)) ||
      JSON.stringify(frozenIds) !== JSON.stringify(referenceIds))) throw new Error("invalid_video_references");
  if (Array.isArray(frozenIds) && frozenIds.length && (!env.VIDEO_REFERENCES || referenceIds === undefined)) {
    throw new Error("invalid_video_references");
  }
  const gate = budgetConditions(task.device_id, task.price_usd, budget);
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO device_wallets (device_id, balance_usd, reserved_usd, created_at, updated_at) VALUES (?, 0, 0, ?, ?)"
    ).bind(task.device_id, task.created_at, task.updated_at),
    env.DB.prepare(
      "INSERT INTO video_tasks (id, device_id, sub_token_id, idempotency_key, request_hash, status, upstream_task_id, " +
      "route_json, price_usd, pricing_snapshot_json, result_url, error_code, poll_after, poll_lease_until, created_at, updated_at) " +
      "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM device_wallets w " +
      "WHERE w.device_id = ? AND (? = 0 OR w.balance_usd - w.reserved_usd >= ?) " +
      "AND NOT EXISTS (SELECT 1 FROM reserve_holds WHERE request_id = ?) " +
      "AND NOT EXISTS (SELECT 1 FROM wallet_ledger WHERE device_id = ? AND reason = 'usage' AND request_id = ?) " +
      (gate.sql ? "AND " + gate.sql + " " : "") + "ON CONFLICT DO NOTHING"
    ).bind(task.id, task.device_id, task.sub_token_id, task.idempotency_key, task.request_hash, task.status,
      task.upstream_task_id, task.route_json, task.price_usd, task.pricing_snapshot_json, task.result_url,
      task.error_code, task.poll_after, task.poll_lease_until, task.created_at, task.updated_at,
      task.device_id, task.price_usd, task.price_usd, task.id, task.device_id, task.id, ...gate.binds),
    env.DB.prepare(
      "INSERT INTO reserve_holds (request_id, device_id, amount_usd, created_at) SELECT ?, ?, ?, ? WHERE changes() = 1"
    ).bind(task.id, task.device_id, task.price_usd, task.created_at),
    env.DB.prepare(
      "UPDATE device_wallets SET reserved_usd = reserved_usd + ?, updated_at = ? WHERE device_id = ? AND changes() = 1"
    ).bind(task.price_usd, task.updated_at, task.device_id),
  ]);
  return Number(results[1].meta?.changes || 0) > 0;
}

export async function markVideoSubmission(env: Env, id: string, upstreamId: string | null): Promise<void> {
  await ensureSchema(env);
  if (upstreamId !== null && !upstreamId.trim()) throw new Error("Invalid upstream video task id");
  await env.DB.prepare(
    "UPDATE video_tasks SET status = ?, upstream_task_id = ?, updated_at = ? WHERE id = ? AND status = 'submitting'"
  ).bind(upstreamId === null ? "submission_unknown" : "pending", upstreamId, Date.now(), id).run();
}

export async function claimVideoPoll(env: Env, id: string, now: number): Promise<string | null> {
  await ensureSchema(env);
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 30_000)) throw new Error("Invalid video poll time");
  const claim = "video-poll:" + crypto.randomUUID();
  const result = await env.DB.prepare(
    "UPDATE video_tasks SET poll_claim = ?, poll_attempts = COALESCE(poll_attempts, 0) + 1, poll_lease_until = ?, poll_after = ?, updated_at = ? " +
    "WHERE id = ? AND status = 'pending' AND upstream_task_id IS NOT NULL AND upstream_task_id <> '' " +
    "AND COALESCE(poll_after, 0) <= ? AND COALESCE(poll_lease_until, 0) <= ?"
  ).bind(claim, now + 30_000, now + 15_000, now, id, now, now).run();
  return Number(result.meta?.changes || 0) === 1 ? claim : null;
}

function validResultUrl(value: string | undefined): string {
  if (!value || !value.toLowerCase().startsWith("https://") || /[\\\s]/.test(value)) throw new Error("Invalid video result URL");
  const url = new URL(value);
  if (value.length > 4096 || url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) throw new Error("Invalid video result URL");
  return value;
}

function validateUpstreamUsage(raw?: string): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw.length > 256) throw new Error("Invalid video upstream usage");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid video upstream usage");
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([key, count]) => !["completion_tokens", "total_tokens"].includes(key) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) throw new Error("Invalid video upstream usage");
  return JSON.stringify(value);
}
export async function finishVideoPoll(
  env: Env,
  id: string,
  outcome: { status: "pending" | "succeeded" | "failed"; result_url?: string; error_code?: string; upstream_usage_json?: string;   next_poll_ms?: number },
  claim: string,
): Promise<void> {
  await ensureSchema(env);
  if (typeof claim !== "string" || !claim) return;
  const now = Date.now();
  const upstreamUsage = validateUpstreamUsage(outcome.upstream_usage_json);
  if (outcome.status === "pending") {
    const delay = outcome.next_poll_ms ?? 15_000;
    if (!Number.isSafeInteger(delay) || delay < 0 || !Number.isSafeInteger(now + delay)) throw new Error("Invalid video poll delay");
    await env.DB.prepare(
      "UPDATE video_tasks SET poll_claim = NULL, poll_lease_until = NULL, poll_after = MAX(COALESCE(poll_after, 0), ?), updated_at = ?, upstream_usage_json = COALESCE(?, upstream_usage_json), error_code = CASE WHEN error_code = 'reference_assets_expired' THEN error_code ELSE ? END " +
      "WHERE id = ? AND status = 'pending' AND poll_claim = ?"
    ).bind(now + Math.max(15_000, delay), now, upstreamUsage, outcome.error_code ?? null, id, claim).run();
    return;
  }
  if (outcome.status !== "succeeded" && outcome.status !== "failed") throw new Error("Invalid video poll outcome");
  const resultUrl = outcome.status === "succeeded" ? validResultUrl(outcome.result_url) : null;
  await settleVideoTask(env, id, outcome.status, resultUrl, outcome.status === "failed" ? outcome.error_code ?? null : null, claim, undefined, false, upstreamUsage);
}

async function settleVideoTask(
  env: Env, id: string, status: "succeeded" | "failed", resultUrl: string | null,
  errorCode: string | null, claim: string | null, audit?: { actor: string; note: string },
  notDispatched = false, upstreamUsage: string | null = null,
): Promise<boolean> {
  const now = Date.now();
  const marker = "video-settlement:" + crypto.randomUUID();
  const taskClaim = "t.id = ? AND t.settlement_claim = ?";
  const ownedClaim = taskClaim + " AND EXISTS (SELECT 1 FROM wallet_ledger l WHERE l.device_id = t.device_id " +
    "AND l.reason = 'usage' AND l.request_id = t.id AND l.note = t.settlement_claim)";
  const charge = "CASE WHEN t.status = 'succeeded' THEN t.price_usd ELSE 0 END";
  const provider = "COALESCE(json_extract(t.route_json, '$.provider_id'), '')";
  const providerName = "COALESCE(json_extract(t.route_json, '$.provider_name'), '')";
  const model = "COALESCE(NULLIF(json_extract(t.route_json, '$.public_model'), ''), json_extract(t.route_json, '$.model'), '')";
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE video_tasks SET status = ?, result_url = ?, error_code = ?, settlement_claim = ?, upstream_usage_json = COALESCE(?, upstream_usage_json), " +
      "poll_claim = NULL, poll_lease_until = NULL, poll_after = NULL, updated_at = ? " +
      "WHERE id = ? AND settlement_claim IS NULL " +
      (notDispatched ? "AND status = 'submitting' AND upstream_task_id IS NULL " :
        audit ? "AND status IN ('submission_unknown', 'pending') " :
        "AND status = 'pending' AND poll_claim = ? AND upstream_task_id IS NOT NULL AND upstream_task_id <> '' ") +
      "AND EXISTS (SELECT 1 FROM device_wallets w WHERE w.device_id = video_tasks.device_id) " +
      "AND NOT EXISTS (SELECT 1 FROM wallet_ledger l WHERE l.device_id = video_tasks.device_id AND l.reason = 'usage' AND l.request_id = video_tasks.id) " +
      "AND NOT EXISTS (SELECT 1 FROM reserve_holds h WHERE h.request_id = video_tasks.id AND h.device_id <> video_tasks.device_id)"
    ).bind(status, resultUrl, errorCode, marker, upstreamUsage, now, id, ...(audit || notDispatched ? [] : [claim])),
    env.DB.prepare(
      "INSERT INTO wallet_ledger (device_id, delta_usd, balance_after, reason, request_id, note, created_at) " +
      "SELECT t.device_id, -(" + charge + "), w.balance_usd - (" + charge + "), 'usage', t.id, ?, ? " +
      "FROM video_tasks t JOIN device_wallets w ON w.device_id = t.device_id WHERE " + taskClaim +
      " ON CONFLICT(device_id, reason, request_id) WHERE request_id IS NOT NULL DO NOTHING"
    ).bind(marker, now, id, marker),
    env.DB.prepare(
      "UPDATE device_wallets SET reserved_usd = MAX(0, reserved_usd - COALESCE(" +
      "(SELECT MAX(0, h.amount_usd) FROM reserve_holds h WHERE h.request_id = ? AND h.device_id = device_wallets.device_id), 0)), " +
      "balance_usd = balance_usd - (SELECT " + charge + " FROM video_tasks t WHERE t.id = ?), updated_at = ? " +
      "WHERE device_id = (SELECT device_id FROM video_tasks WHERE id = ?) " +
      "AND EXISTS (SELECT 1 FROM video_tasks t WHERE t.device_id = device_wallets.device_id AND " + ownedClaim + ")"
    ).bind(id, id, now, id, id, marker),
    env.DB.prepare(
      "DELETE FROM reserve_holds WHERE request_id = ? AND EXISTS (SELECT 1 FROM video_tasks t " +
      "WHERE t.id = reserve_holds.request_id AND t.device_id = reserve_holds.device_id AND " + ownedClaim + ")"
    ).bind(id, id, marker),
    env.DB.prepare(
      "INSERT INTO usage (device_id, sub_token_id, provider_id, provider_name, model, cost_usd, " +
      "price_multiplier, price_window_id, status_code, latency_ms, request_id, created_at, " +
      "service_group_id, service_group_revision, pricing_snapshot_json) " +
      "SELECT t.device_id, t.sub_token_id, " + provider + ", " + providerName + ", " + model + ", " + charge + ", " +
      "COALESCE(json_extract(t.route_json, '$.price_multiplier'), 1), " +
      "COALESCE(json_extract(t.route_json, '$.window_id'), json_extract(t.route_json, '$.price_window_id')), " +
      "CASE WHEN t.status = 'succeeded' THEN 200 ELSE 502 END, MAX(0, ? - t.created_at), t.id, ?, " +
      "json_extract(t.route_json, '$.service_group_id'), " +
      "COALESCE(json_extract(t.route_json, '$.revision'), json_extract(t.route_json, '$.service_group_revision')), " +
      "t.pricing_snapshot_json FROM video_tasks t WHERE " + ownedClaim
    ).bind(now, now, id, marker),
    env.DB.prepare(
      "INSERT INTO daily_stats (date, device_id, provider_id, provider_name, model, request_count, cost_usd, avg_latency_ms, error_count) " +
      "SELECT strftime('%Y-%m-%d', ? / 1000, 'unixepoch', '+480 minutes'), t.device_id, " + provider + ", " +
      providerName + ", " + model + ", 1, " + charge + ", MAX(0, ? - t.created_at), " +
      "CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END FROM video_tasks t WHERE " + ownedClaim +
      " ON CONFLICT(date, device_id, provider_id, model) DO UPDATE SET " +
      "provider_name = excluded.provider_name, request_count = daily_stats.request_count + 1, " +
      "cost_usd = daily_stats.cost_usd + excluded.cost_usd, " +
      "avg_latency_ms = (daily_stats.avg_latency_ms * daily_stats.request_count + excluded.avg_latency_ms) / (daily_stats.request_count + 1), " +
      "error_count = daily_stats.error_count + excluded.error_count"
    ).bind(now, now, id, marker),
    ...(audit ? [env.DB.prepare(
      "INSERT INTO audit_logs (actor_type, action, target_type, target_id, summary, details_json, created_at) " +
      "SELECT 'admin', 'video.reconcile.fail', 'video_task', t.id, 'Verified manual video failure', ?, ? " +
      "FROM video_tasks t WHERE " + ownedClaim
    ).bind(JSON.stringify(audit), now, id, marker)] : []),
  ]);
  return Number(results[0].meta?.changes || 0) > 0;
}

export async function failUnsubmittedVideoTask(env: Env, id: string): Promise<boolean> {
  await ensureSchema(env);
  return settleVideoTask(env, id, "failed", null, "reference_bind_failed", null, undefined, true);
}

export type VideoReconcileAction = { kind: "attach"; upstreamId: string } | { kind: "fail"; note: string };
export async function reconcileVideoTask(env: Env, id: string, action: VideoReconcileAction, actor: string): Promise<boolean> {
  await ensureSchema(env);
  if (typeof actor !== "string" || !actor.trim() || actor.length > 256) throw new Error("Invalid video reconciliation actor");
  if (action.kind === "fail") {
    if (typeof action.note !== "string" || !action.note.trim() || action.note.length > 1024) throw new Error("Invalid video reconciliation note");
    return settleVideoTask(env, id, "failed", null, "MANUALLY_RECONCILED", null, { actor, note: action.note });
  }
  if (action.kind !== "attach" || typeof action.upstreamId !== "string" || !action.upstreamId.trim() || action.upstreamId.length > 512) {
    throw new Error("Invalid upstream video task id");
  }
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE video_tasks SET status = 'pending', upstream_task_id = ?, poll_claim = NULL, poll_lease_until = NULL, " +
      "poll_after = ?, updated_at = ? WHERE id = ? AND settlement_claim IS NULL " +
      "AND status IN ('submission_unknown', 'pending') AND (upstream_task_id IS NULL OR upstream_task_id = '') " +
      "AND NOT EXISTS (SELECT 1 FROM wallet_ledger l WHERE l.device_id = video_tasks.device_id AND l.reason = 'usage' AND l.request_id = video_tasks.id)"
    ).bind(action.upstreamId, now, now, id),
    env.DB.prepare(
      "INSERT INTO audit_logs (actor_type, action, target_type, target_id, summary, details_json, created_at) " +
      "SELECT 'admin', 'video.reconcile.attach', 'video_task', ?, 'Verified upstream video attachment', ?, ? WHERE changes() = 1"
    ).bind(id, JSON.stringify({ actor, upstreamId: action.upstreamId }), now),
  ]);
  return Number(results[0].meta?.changes || 0) === 1;
}
