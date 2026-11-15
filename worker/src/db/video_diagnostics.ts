import type { Env } from "../types";
import { isEncryptedSecret, openSecret, sealSecret } from "../utils/crypto";
import { ensureSchema } from "./schema";

export const VIDEO_DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const VIDEO_DIAGNOSTIC_ARM_MS = 24 * 60 * 60 * 1000;
const BODY_LIMIT = 64 * 1024;
const REDACTED = "[REDACTED]";
const SLOTS = ["create", "processing", "terminal", "error"] as const;
export interface VideoDiagnosticEvent {
  slot: typeof SLOTS[number];
  http_status: number | null;
  content_type: string | null;
  body: string | null;
  truncated: boolean;
  error_code?: string;
}
type SafeJson = null | boolean | number | string | SafeJson[] | { [key: string]: SafeJson };

function sensitiveKey(key: string): boolean {
  const k = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (/^(prompt|input|output|total|cached|completion|reasoning|cache(read|write))tokens?(details)?$/.test(k)) return false;
  return /authorization|apikey|cookie|token|credential|password|secret|prompt/.test(k) ||
    ["auth", "key", "signature", "messages", "input", "instructions", "__proto__", "prototype", "constructor"].includes(key.toLowerCase());
}
function scrubString(value: string, secrets: string[], redactUrls: boolean): string {
  let out = value;
  for (const secret of secrets) if (secret) out = out.split(secret).join(REDACTED);
  out = out.replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, REDACTED)
    .replace(/\b(?:sk-|ccs_|ccs-sub_)[a-z0-9_-]+/gi, REDACTED);
  if (redactUrls) out = out.replace(/(?:https?:\/\/|data:|blob:)[^\s<>"']+/gi, "[REDACTED_URL]");
  return out;
}
function sanitize(value: unknown, secrets: string[], redactUrls: boolean, depth = 0): SafeJson {
  if (depth > 32) return "[DEPTH_LIMIT]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return scrubString(value, secrets, redactUrls);
  if (Array.isArray(value)) return value.map(v => sanitize(v, secrets, redactUrls, depth + 1));
  if (!value || typeof value !== "object") return null;
  const out: { [key: string]: SafeJson } = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    const safeKey = scrubString(key, secrets, redactUrls);
    if (sensitiveKey(key)) out[safeKey] = REDACTED;
    else if (redactUrls && /url|uri|href|location/i.test(key) && typeof child === "string") out[safeKey] = "[REDACTED_URL]";
    else if (/^(error|message|detail|reason|description|error_description)$/i.test(key) && typeof child === "string") out[safeKey] = REDACTED;
    else out[safeKey] = sanitize(child, secrets, redactUrls, depth + 1);
  }
  return out;
}

export async function claimVideoDiagnostics(env: Env, taskId: string, allowAfterSubmission = false): Promise<boolean> {
  try {
    if (!env.ENCRYPTION_KEY?.trim()) return false;
    await ensureSchema(env);
    const now = Date.now();
    const result = await env.DB.batch([
      env.DB.prepare("UPDATE video_diagnostic_arms SET task_id = ? WHERE task_id IS NULL AND enabled_until > ? " +
        "AND EXISTS (SELECT 1 FROM video_tasks t WHERE t.id = ? AND t.device_id = video_diagnostic_arms.device_id " +
        (allowAfterSubmission ? "AND t.created_at >= armed_at AND t.rowid > task_rowid_floor) " : "AND t.status = 'submitting' AND t.upstream_task_id IS NULL AND t.created_at >= armed_at AND t.rowid > task_rowid_floor) ") +
        "AND NOT EXISTS (SELECT 1 FROM video_diagnostic_grants WHERE task_id = ?)").bind(taskId, now, taskId, taskId),
      env.DB.prepare("INSERT INTO video_diagnostic_grants (task_id, arm_id, device_id, consumed_at, expires_at) " +
        "SELECT task_id, arm_id, device_id, ?, ? FROM video_diagnostic_arms WHERE task_id = ? AND changes() = 1")
        .bind(now, now + VIDEO_DIAGNOSTIC_RETENTION_MS, taskId),
    ]);
    return Number(result[0].meta?.changes || 0) === 1;
  } catch { return false; }
}

export async function captureVideoDiagnostic(env: Env, taskId: string, event: VideoDiagnosticEvent, secrets: string[] = []): Promise<void> {
  try {
    if (!env.ENCRYPTION_KEY?.trim() || !SLOTS.includes(event.slot)) return;
    await ensureSchema(env);
    const now = Date.now();
    const grant = await env.DB.prepare("SELECT expires_at FROM video_diagnostic_grants WHERE task_id = ? AND expires_at > ?")
      .bind(taskId, now).first<{ expires_at: number }>();
    if (!grant) return;
    let body: SafeJson = null;
    let truncated = event.truncated === true;
    if (typeof event.body === "string") {
      if (new TextEncoder().encode(event.body).byteLength > BODY_LIMIT) { body = "[BODY_LIMIT]"; truncated = true; }
      else {
        try { body = sanitize(JSON.parse(event.body), secrets, false); }
        catch { body = "[REDACTED_NON_JSON]"; }
      }
    }
    const errorCode = typeof event.error_code === "string" && /^[a-z0-9_.:-]{1,96}$/i.test(event.error_code)
      ? scrubString(event.error_code, secrets, true) : event.error_code === undefined ? null : REDACTED;
    let payload = JSON.stringify({ body, error_code: errorCode });
    if (new TextEncoder().encode(payload).byteLength > BODY_LIMIT) {
      payload = JSON.stringify({ body: "[BODY_LIMIT]", error_code: errorCode }); truncated = true;
    }
    const sealed = await sealSecret(payload, env.ENCRYPTION_KEY);
    if (!isEncryptedSecret(sealed)) return;
    const status = Number.isInteger(event.http_status) && event.http_status! >= 100 && event.http_status! <= 599 ? event.http_status : null;
    const mime = event.content_type?.split(";", 1)[0].trim().toLowerCase();
    const contentType = mime && mime.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)
      ? scrubString(mime, secrets, true) : null;
    await env.DB.prepare("INSERT INTO video_diagnostics (task_id, slot, http_status, content_type, body_sealed, truncated, captured_at, expires_at) " +
      "SELECT task_id, ?, ?, ?, ?, ?, ?, expires_at FROM video_diagnostic_grants WHERE task_id = ? AND expires_at > ? " +
      "ON CONFLICT (task_id, slot) DO NOTHING")
      .bind(event.slot, status, contentType, sealed, truncated ? 1 : 0, now, taskId, Date.now()).run();
  } catch {   }
}

interface SampleRow {
  slot: VideoDiagnosticEvent["slot"]; http_status: number | null; content_type: string | null;
  body_sealed: string; truncated: number; captured_at: number; expires_at: number;
}
export interface SafeVideoDiagnostics {
  task_id: string;
  redacted: true;
  retention_days: 7;
  samples: { slot: VideoDiagnosticEvent["slot"]; http_status: number | null; content_type: string | null;
    body: SafeJson; error_code: SafeJson; truncated: boolean; captured_at: number; expires_at: number }[];
}
export async function getVideoDiagnostics(env: Env, taskId: string): Promise<SafeVideoDiagnostics> {
  await ensureSchema(env);
  const rows = await env.DB.prepare("SELECT slot, http_status, content_type, body_sealed, truncated, captured_at, expires_at " +
    "FROM video_diagnostics WHERE task_id = ? AND expires_at > ? ORDER BY captured_at, slot LIMIT 4")
    .bind(taskId, Date.now()).all<SampleRow>();
  const samples: SafeVideoDiagnostics["samples"] = [];
  for (const row of rows.results || []) {
    let body: SafeJson = "[UNAVAILABLE]", errorCode: SafeJson = null;
    const plain = isEncryptedSecret(row.body_sealed) ? await openSecret(row.body_sealed, env.ENCRYPTION_KEY) : null;
    if (plain !== null) {
      try {
        const parsed = JSON.parse(plain);
        body = sanitize(parsed.body, [], true);
        errorCode = sanitize(parsed.error_code, [], true);
      } catch {   }
    }
    samples.push({ slot: row.slot, http_status: row.http_status, content_type: row.content_type,
      body, error_code: errorCode, truncated: row.truncated === 1, captured_at: row.captured_at, expires_at: row.expires_at });
  }
  return { task_id: taskId, redacted: true, retention_days: 7, samples };
}

export async function pruneVideoDiagnostics(env: Env): Promise<void> {
  try {
    await ensureSchema(env);
    const now = Date.now();
    const batch: D1PreparedStatement[] = [];
    for (const [table, column] of [["video_diagnostics", "expires_at"], ["video_diagnostic_grants", "expires_at"], ["video_diagnostic_arms", "enabled_until"]]) {
      batch.push(env.DB.prepare("DELETE FROM " + table + " WHERE rowid IN (SELECT rowid FROM " + table + " WHERE " + column + " <= ? ORDER BY " + column + " LIMIT 100)").bind(now));
      batch.push(env.DB.prepare("INSERT INTO audit_logs (actor_type, action, target_type, summary, details_json, created_at) " +
        "SELECT 'system', 'video_diagnostics.retention', 'video_diagnostics', 'Expired diagnostic rows pruned', " +
        "json_object('table', ?, 'deleted', changes()), ? WHERE changes() > 0").bind(table, now));
    }
    await env.DB.batch(batch);
  } catch {   }
}
