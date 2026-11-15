import type { AuthedDevice, Env } from "../types";
import { ensureSchema, VIDEO_REFERENCE_SCHEDULE_SQL } from "./schema";

export const VIDEO_REFERENCE_MAX_BYTES = 5 * 1024 * 1024;
export const VIDEO_REFERENCE_GLOBAL_MAX_BYTES = 1_000_000_000;
export const VIDEO_REFERENCE_TTL = 24 * 60 * 60 * 1000;
export const VIDEO_REFERENCE_HARD_TTL = 7 * VIDEO_REFERENCE_TTL;
const DELETE_WAIT_MS = 5_000;
const CLEANUP_BUDGET_MS = 20_000;
const CLEANUP_LEASE_MS = 30_000;
export interface VideoReferenceAsset {
  id: string; device_id: string; sub_token_id: string | null; object_key: string;
  content_type: string; size_bytes: number; width: number | null; height: number | null;
  checksum_sha256: string | null; state: "uploading" | "ready" | "deleting" | "lost" | "deleted";
  task_id: string | null; created_at: number; updated_at: number; expires_at: number; upload_lease_until: number;
  upload_token: string | null; write_outcome: "pending" | "confirmed" | "unknown" | "absent"; cancelled_at: number | null;
}
interface CleanupClaim { asset: VideoReferenceAsset; token: string; attempts: number }
export function referenceOwner(device: AuthedDevice): string | null {
  if (device.auth_via === "sub" && !device.sub_token_id) throw new Error("invalid_video_references");
  return device.auth_via === "sub" ? device.sub_token_id! : null;
}
export async function getVideoReferenceAsset(env: Env, id: string): Promise<VideoReferenceAsset | null> {
  await ensureSchema(env);
  return env.DB.prepare("SELECT * FROM video_reference_assets WHERE id = ?").bind(id).first<VideoReferenceAsset>();
}
export async function getVideoReferenceAssets(env: Env, ids: string[]): Promise<VideoReferenceAsset[]> {
  if (!ids.length) return [];
  if (ids.length > 3) throw new Error("invalid_video_references");
  await ensureSchema(env);
  const rows = await env.DB.prepare("SELECT * FROM video_reference_assets WHERE id IN (" + ids.map(() => "?").join(",") + ")").bind(...ids).all<VideoReferenceAsset>();
  return rows.results || [];
}
export async function reserveVideoReferenceAsset(env: Env, device: AuthedDevice, contentType: string): Promise<VideoReferenceAsset | null> {
  await ensureSchema(env);
  const now = Date.now(); const id = "vref_" + crypto.randomUUID().replace(/-/g, "");
  const key = "video-references/" + crypto.randomUUID(); const token = crypto.randomUUID();
  const result = await env.DB.prepare(
    "INSERT INTO video_reference_assets (id,device_id,sub_token_id,object_key,content_type,size_bytes,state,created_at,updated_at,expires_at,upload_lease_until,upload_token,write_outcome) " +
    "SELECT ?,?,?,?,?,?,'uploading',?,?,?,?,?,'pending' WHERE " +
    "(SELECT COALESCE(SUM(size_bytes),0) FROM video_reference_assets WHERE device_id = ? AND " +
    "(state <> 'deleted' OR write_outcome NOT IN ('confirmed','absent'))) + ? <= 104857600 " +
    "AND (SELECT COALESCE(SUM(size_bytes),0) FROM video_reference_assets WHERE " +
    "(state <> 'deleted' OR write_outcome NOT IN ('confirmed','absent'))) + ? <= ? " +
    "AND (SELECT COUNT(*) FROM video_reference_assets WHERE device_id = ? AND created_at > ?) < 20 " +
    "AND (SELECT COUNT(*) FROM video_reference_assets WHERE device_id = ? AND state = 'uploading' AND upload_lease_until > ?) < 2"
  ).bind(id,device.id,referenceOwner(device),key,contentType,VIDEO_REFERENCE_MAX_BYTES,now,now,now + VIDEO_REFERENCE_TTL,now + 60_000,token,
    device.id,VIDEO_REFERENCE_MAX_BYTES,VIDEO_REFERENCE_MAX_BYTES,VIDEO_REFERENCE_GLOBAL_MAX_BYTES,device.id,now - 3_600_000,device.id,now).run();
  return Number(result.meta?.changes || 0) > 0 ? getVideoReferenceAsset(env,id) : null;
}
export async function markVideoReferenceUploadUncertain(env: Env, asset: VideoReferenceAsset): Promise<void> {
  const now = Date.now();
  await env.DB.prepare("UPDATE video_reference_assets SET cancelled_at = ?, " +
    "write_outcome = CASE WHEN write_outcome = 'pending' THEN 'unknown' ELSE write_outcome END, " +
    "state = 'lost', updated_at = ? WHERE id = ? AND object_key = ? AND upload_token = ? " +
    "AND cancelled_at IS NULL AND state <> 'deleted' AND task_id IS NULL")
    .bind(now,now,asset.id,asset.object_key,asset.upload_token).run();
}
export async function completeVideoReferenceWrite(env: Env, asset: VideoReferenceAsset, stored: boolean): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE video_reference_cleanup SET next_attempt_at = ?, lease_token = NULL, lease_until = NULL, reason = 'write_settled' " +
      "WHERE asset_id = ? AND EXISTS (SELECT 1 FROM video_reference_assets a WHERE a.id = ? AND a.upload_token = ? " +
      "AND a.write_outcome IN ('pending','unknown') AND (? = 0 OR a.cancelled_at IS NOT NULL OR a.state <> 'uploading' OR a.upload_lease_until <= ?))")
      .bind(now,asset.id,asset.id,asset.upload_token,stored ? 1 : 0,now),
    env.DB.prepare("UPDATE video_reference_assets SET write_outcome = ?, " +
      "cancelled_at = CASE WHEN ? = 0 THEN COALESCE(cancelled_at,?) ELSE cancelled_at END, " +
      "state = CASE WHEN ? = 0 OR cancelled_at IS NOT NULL OR state <> 'uploading' OR upload_lease_until <= ? THEN 'lost' ELSE state END, " +
      "updated_at = ? WHERE id = ? AND object_key = ? AND upload_token = ? AND write_outcome IN ('pending','unknown')")
      .bind(stored ? "confirmed" : "absent",stored ? 1 : 0,now,stored ? 1 : 0,now,now,asset.id,asset.object_key,asset.upload_token)
  ]);
}
export async function finishVideoReferenceAsset(env: Env, asset: VideoReferenceAsset, bytes: number, width: number, height: number, checksum: string | null): Promise<boolean> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > VIDEO_REFERENCE_MAX_BYTES || !asset.upload_token) return false;
  const now = Date.now();
  const result = await env.DB.prepare("UPDATE video_reference_assets SET state = 'ready', size_bytes = ?, width = ?, height = ?, checksum_sha256 = ?, updated_at = ? " +
    "WHERE id = ? AND object_key = ? AND upload_token = ? AND state = 'uploading' AND upload_lease_until > ? " +
    "AND write_outcome = 'confirmed' AND cancelled_at IS NULL AND NOT EXISTS " +
    "(SELECT 1 FROM video_reference_cleanup q WHERE q.asset_id = video_reference_assets.id AND q.lease_token IS NOT NULL)")
    .bind(bytes,width,height,checksum,now,asset.id,asset.object_key,asset.upload_token,now).run();
  return Number(result.meta?.changes || 0) > 0;
}

export const VIDEO_REFERENCE_DUE_SQL = "SELECT asset_id FROM video_reference_cleanup INDEXED BY idx_video_reference_due " +
  "WHERE next_attempt_at <= ? ORDER BY next_attempt_at,asset_id LIMIT 50";
export const VIDEO_REFERENCE_TOMBSTONES_SQL = "DELETE FROM video_reference_assets WHERE id IN " +
  "(SELECT id FROM video_reference_assets INDEXED BY idx_video_reference_settled_tombstone WHERE state = 'deleted' " +
  "AND write_outcome IN ('confirmed','absent') AND updated_at < ? ORDER BY updated_at,id LIMIT 50)";

export async function backfillVideoReferenceCleanup(env: Env): Promise<number> {
  const progress = await env.DB.prepare("SELECT cursor_rowid,done FROM video_reference_cleanup_backfill WHERE id = 1")
    .first<{cursor_rowid:number;done:number}>();
  if (!progress || progress.done) return 0;
  const rows = await env.DB.prepare("SELECT rowid AS rid FROM video_reference_assets WHERE rowid > ? ORDER BY rowid LIMIT 50")
    .bind(progress.cursor_rowid).all<{rid:number}>();
  const ids = (rows.results || []).map(r=>r.rid);
  if (!ids.length) {
    await env.DB.prepare("UPDATE video_reference_cleanup_backfill SET done = 1 WHERE id = 1 AND cursor_rowid = ?").bind(progress.cursor_rowid).run();
    return 0;
  }
  const slots = ids.map(()=>"?").join(",");
  await env.DB.batch([
    env.DB.prepare("UPDATE video_reference_assets SET upload_token = 'legacy:' || id, " +
      "write_outcome = CASE WHEN state = 'ready' THEN 'confirmed' ELSE 'unknown' END, " +
      "state = CASE WHEN state = 'deleted' THEN 'lost' ELSE state END WHERE rowid IN (" + slots + ") AND upload_token IS NULL").bind(...ids),
    env.DB.prepare("INSERT INTO video_reference_cleanup(asset_id,object_key,next_attempt_at) " +
      "SELECT a.id,a.object_key," + VIDEO_REFERENCE_SCHEDULE_SQL + " FROM video_reference_assets a WHERE a.rowid IN (" + slots + ") " +
      "AND a.state <> 'deleted' ON CONFLICT(asset_id) DO NOTHING").bind(...ids),
    env.DB.prepare("UPDATE video_reference_cleanup_backfill SET cursor_rowid = ? WHERE id = 1 AND cursor_rowid = ?")
      .bind(ids[ids.length-1],progress.cursor_rowid)
  ]);
  return ids.length;
}

async function claimCleanup(env: Env, id: string, deadline: number): Promise<CleanupClaim | null> {
  if (Date.now() >= deadline) return null;
  const now = Date.now(), token = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE video_reference_assets SET " +
      "write_outcome = CASE WHEN upload_token IS NULL AND state = 'ready' THEN 'confirmed' ELSE write_outcome END, " +
      "upload_token = CASE WHEN upload_token IS NULL AND state = 'ready' THEN 'legacy:' || id ELSE upload_token END, " +
      "state = 'deleting', cancelled_at = COALESCE(cancelled_at,?), updated_at = ? " +
      "WHERE id = ? AND state <> 'deleted' AND EXISTS " +
      "(SELECT 1 FROM video_reference_cleanup q WHERE q.asset_id = video_reference_assets.id AND q.next_attempt_at <= ?)")
      .bind(now,now,id,now),
    env.DB.prepare("UPDATE video_reference_cleanup SET lease_token = ?, lease_until = ?, next_attempt_at = ?, attempts = attempts + 1 " +
      "WHERE asset_id = ? AND next_attempt_at <= ? AND EXISTS (SELECT 1 FROM video_reference_assets WHERE id = ? AND state = 'deleting')")
      .bind(token,now+CLEANUP_LEASE_MS,now+CLEANUP_LEASE_MS,id,now,id)
  ]);
  if (results[1]?.meta?.changes !== 1) return null;
  const row = await env.DB.prepare("SELECT a.*,q.attempts FROM video_reference_assets a JOIN video_reference_cleanup q ON q.asset_id = a.id " +
    "WHERE a.id = ? AND q.lease_token = ?").bind(id,token).first<VideoReferenceAsset & {attempts:number}>();
  return row ? {asset:row,token,attempts:row.attempts} : null;
}
export function videoReferenceRetryDelay(attempts: number): number {
  const base = Math.min(3_600_000,60_000 * 2 ** Math.min(6,Math.max(0,attempts-1)));
  return Math.min(3_600_000,Math.floor(base * (0.9 + Math.random() * 0.2)));
}
async function finishCleanup(env: Env, claim: CleanupClaim, success: boolean): Promise<boolean> {
  const now = Date.now(); const {asset,token} = claim;
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE video_reference_assets SET state = CASE WHEN ? = 1 AND write_outcome IN ('confirmed','absent') THEN 'deleted' ELSE 'lost' END, " +
      "updated_at = ? WHERE id = ? AND state = 'deleting' AND EXISTS " +
      "(SELECT 1 FROM video_reference_cleanup q WHERE q.asset_id = video_reference_assets.id AND q.lease_token = ? AND q.lease_until > ?)")
      .bind(success ? 1 : 0,now,asset.id,token,now),
    env.DB.prepare("UPDATE video_reference_cleanup SET next_attempt_at = ?, lease_token = NULL, lease_until = NULL, reason = ? " +
      "WHERE asset_id = ? AND lease_token = ? AND lease_until > ?")
      .bind(now+videoReferenceRetryDelay(claim.attempts),claim.attempts >= 10 ? "cleanup_review_required" : success ? "write_unsettled" : "delete_retry",asset.id,token,now)
  ]);
  if (!success || !(Number(results[0]?.meta?.changes || 0) > 0)) return false;
  return (await getVideoReferenceAsset(env,asset.id))?.state === "deleted";
}
async function bounded<T>(operation: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  if (milliseconds <= 0) { operation.catch(()=>{}); return fallback; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation,new Promise<T>(resolve=>{timer=setTimeout(()=>resolve(fallback),milliseconds);})]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
let activeDeletes = 0;
async function deleteClaim(env: Env, claim: CleanupClaim, deadline: number): Promise<boolean> {
  if (!env.VIDEO_REFERENCES || activeDeletes >= 2 || Date.now() >= deadline) return false;
  const {asset} = claim;
  if (asset.task_id && asset.created_at <= Date.now() - VIDEO_REFERENCE_HARD_TTL) {
    await env.DB.prepare("UPDATE video_tasks SET error_code = 'reference_assets_expired', poll_attempts = MAX(COALESCE(poll_attempts,0),20), updated_at = ? " +
      "WHERE id = ? AND status IN ('submitting','submission_unknown','pending')").bind(Date.now(),asset.task_id).run();
  }
  if (activeDeletes >= 2 || Date.now() >= deadline) return false;
  activeDeletes++;
  const io = Promise.resolve().then(()=>env.VIDEO_REFERENCES!.delete(asset.object_key))
    .then(()=>true,()=>false).finally(()=>{activeDeletes--;});
  const success = await bounded(io,Math.min(DELETE_WAIT_MS,deadline-Date.now()),false);
  return finishCleanup(env,claim,success);
}
export async function discardVideoReferenceAsset(env: Env, asset: VideoReferenceAsset): Promise<boolean> {
  const deadline = Date.now()+DELETE_WAIT_MS;
  const work = async () => {
    if (!env.VIDEO_REFERENCES) return false;
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE video_reference_assets SET state = 'lost', cancelled_at = COALESCE(cancelled_at,?), updated_at = ? " +
        "WHERE id = ? AND object_key = ? AND upload_token = ? AND task_id IS NULL AND state <> 'deleted'")
        .bind(Date.now(),Date.now(),asset.id,asset.object_key,asset.upload_token),
      env.DB.prepare("UPDATE video_reference_cleanup SET next_attempt_at = ? WHERE asset_id = ? AND lease_token IS NULL " +
        "AND EXISTS (SELECT 1 FROM video_reference_assets WHERE id = ? AND upload_token = ? AND task_id IS NULL AND state = 'lost')")
        .bind(Date.now(),asset.id,asset.id,asset.upload_token)
    ]);
    if (!(Number(results[0]?.meta?.changes || 0) > 0) || activeDeletes >= 2 || Date.now() >= deadline) return false;
    const claim = await claimCleanup(env,asset.id,deadline);
    return claim ? deleteClaim(env,claim,deadline) : false;
  };
  return bounded(work(),DELETE_WAIT_MS,false);
}
export async function pruneVideoReferenceAssets(env: Env): Promise<number> {
  const deadline = Date.now()+CLEANUP_BUDGET_MS;
  const work = async () => {
    if (!env.VIDEO_REFERENCES) return 0;
    await ensureSchema(env);
    if (Date.now() >= deadline) return 0;
    await backfillVideoReferenceCleanup(env);
    if (Date.now() >= deadline) return 0;
    const candidates = await env.DB.prepare(VIDEO_REFERENCE_DUE_SQL).bind(Date.now()).all<{asset_id:string}>();
    let cursor = 0, count = 0;
    async function worker() {
      while (cursor < (candidates.results || []).length && Date.now() < deadline && activeDeletes < 2) {
        const id = candidates.results![cursor++].asset_id;
        const claim = await claimCleanup(env,id,deadline);
        if (claim && await deleteClaim(env,claim,deadline)) count++;
      }
    }
    await Promise.all([worker(),worker()]);
    if (Date.now() < deadline) await env.DB.prepare(VIDEO_REFERENCE_TOMBSTONES_SQL).bind(Date.now()-VIDEO_REFERENCE_HARD_TTL).run();
    return count;
  };
  return bounded(work(),CLEANUP_BUDGET_MS,0);
}
