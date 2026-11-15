import { Hono } from "hono";
import type { Env } from "../types";
import { getVideoTask, reconcileVideoTask } from "../db/video_tasks";
import { ensureSchema } from "../db/schema";
import { readBoundedBody } from "../gateway/embeddings";
import { extractClientIp } from "../middleware/adminAuth";
import { getVideoDiagnostics, VIDEO_DIAGNOSTIC_ARM_MS } from "../db/video_diagnostics";
import { sealSecret } from "../utils/crypto";

export const videoTasksApp = new Hono<{Bindings:Env}>();
videoTasksApp.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
for (const operation of ["arm", "disarm"] as const) {
  videoTasksApp.post("/diagnostics/" + operation, async c => {
    let input: unknown;
    try { input = JSON.parse(await readBoundedBody(c.req.raw.body, 4096, c.req.raw.signal)); }
    catch { return c.json({ error: "invalid_diagnostic_account" }, 400); }
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 ||
      !Object.hasOwn(input, "device_id")) return c.json({ error: "invalid_diagnostic_account" }, 400);
    const deviceId = (input as { device_id?: unknown }).device_id;
    if (typeof deviceId !== "string" || !deviceId || deviceId.length > 256 || /[\x00-\x20\x7f]/.test(deviceId))
      return c.json({ error: "invalid_diagnostic_account" }, 400);
    await ensureSchema(c.env);
    if (!await c.env.DB.prepare("SELECT id FROM devices WHERE id = ?").bind(deviceId).first())
      return c.json({ error: "device_not_found" }, 404);
    if (operation === "arm") {
      if (!c.env.ENCRYPTION_KEY?.trim()) return c.json({ error: "diagnostic_encryption_unavailable" }, 503);
      try { await sealSecret("{}", c.env.ENCRYPTION_KEY); }
      catch { return c.json({ error: "diagnostic_encryption_unavailable" }, 503); }
    }
    const now = Date.now();
    const mutation = operation === "arm"
      ? c.env.DB.prepare("INSERT INTO video_diagnostic_arms (device_id, arm_id, task_id, armed_at, task_rowid_floor, enabled_until) " +
          "VALUES (?, ?, NULL, ?, (SELECT COALESCE(MAX(rowid), 0) FROM video_tasks), ?) " +
          "ON CONFLICT (device_id) DO UPDATE SET arm_id = excluded.arm_id, task_id = NULL, armed_at = excluded.armed_at, " +
          "task_rowid_floor = excluded.task_rowid_floor, enabled_until = excluded.enabled_until")
          .bind(deviceId, crypto.randomUUID(), now, now + VIDEO_DIAGNOSTIC_ARM_MS)
      : c.env.DB.prepare("DELETE FROM video_diagnostic_arms WHERE device_id = ? AND task_id IS NULL").bind(deviceId);
    await c.env.DB.batch([mutation, c.env.DB.prepare(
      "INSERT INTO audit_logs (actor_type, ip, action, target_type, target_id, summary, details_json, created_at) " +
      "VALUES ('admin', ?, ?, 'device', ?, 'Video diagnostic sampling control', ?, ?)")
      .bind(extractClientIp(c, c.env), "video_diagnostics." + operation, deviceId,
        JSON.stringify({ retention_days: 7, arm_hours: 24 }), now)]);
    return c.json({ ok: true, device_id: deviceId, armed: operation === "arm",
      enabled_until: operation === "arm" ? now + VIDEO_DIAGNOSTIC_ARM_MS : null, retention_days: 7 });
  });
}
videoTasksApp.get("/:id/diagnostics", async c => {
  const task = await getVideoTask(c.env, c.req.param("id"));
  return task ? c.json(await getVideoDiagnostics(c.env, task.id)) : c.json({ error: "video_task_not_found" }, 404);
});
videoTasksApp.get("/:id/diagnostics/export", async c => {
  const task = await getVideoTask(c.env, c.req.param("id"));
  if (!task) return c.json({ error: "video_task_not_found" }, 404);
  const data = await getVideoDiagnostics(c.env, task.id);
  await c.env.DB.prepare("INSERT INTO audit_logs (actor_type, ip, action, target_type, target_id, summary, details_json, created_at) " +
    "VALUES ('admin', ?, 'video_diagnostics.export', 'video_task', ?, 'Redacted video diagnostics exported', ?, ?)")
    .bind(extractClientIp(c, c.env), task.id, JSON.stringify({ redacted: true, samples: data.samples.length }), Date.now()).run();
  c.header("Content-Disposition", 'attachment; filename="video-diagnostics.json"');
  return c.json(data);
});
function reviewView(t: Awaited<ReturnType<typeof getVideoTask>>) {
  if (!t) return null;
  let route: Record<string,unknown> = {}; try { route=JSON.parse(t.route_json); } catch {   }
  return {id:t.id,device_id:t.device_id,sub_token_id:t.sub_token_id,status:t.status,upstream_task_id:t.upstream_task_id,
    model:route.public_model,provider_id:route.provider_id,price_usd:t.price_usd,error_code:t.error_code,
    poll_after:t.poll_after,poll_attempts:t.poll_attempts || 0,created_at:t.created_at,updated_at:t.updated_at};
}
videoTasksApp.get("/",async c=>{
  await ensureSchema(c.env); c.header("Cache-Control","no-store");
  const rows=await c.env.DB.prepare("SELECT * FROM video_tasks WHERE status IN ('submission_unknown','pending') ORDER BY created_at,id LIMIT 100").all<NonNullable<Awaited<ReturnType<typeof getVideoTask>>>>();
  return c.json({items:(rows.results || []).map(reviewView)});
});
videoTasksApp.get("/:id",async c=>{ c.header("Cache-Control","no-store"); const task=await getVideoTask(c.env,c.req.param("id")); return task ? c.json(reviewView(task)) : c.json({error:"video_task_not_found"},404); });
videoTasksApp.post("/:id/reconcile",async c=>{
  c.header("Cache-Control","no-store");
  let body: Record<string,unknown>;
  try { body=JSON.parse(await readBoundedBody(c.req.raw.body,4096,c.req.raw.signal)); } catch { return c.json({error:"invalid_reconciliation"},400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || body.confirm_verified !== true) return c.json({error:"upstream_verification_required"},400);
  const allowed=body.action === "attach" ? ["action","upstream_task_id","confirm_verified"] : ["action","note","confirm_verified"];
  if (Object.keys(body).some(k=>!allowed.includes(k))) return c.json({error:"invalid_reconciliation"},400);
  const actor="admin:"+extractClientIp(c,c.env);
  if (body.action === "attach") {
    const id=body.upstream_task_id;
    if(typeof id!=="string" || !id || id.length>256 || id==="." || id===".." || /[\x00-\x20\x7f]/.test(id)) return c.json({error:"invalid_upstream_task_id"},400);
    const ok=await reconcileVideoTask(c.env,c.req.param("id"),{kind:"attach",upstreamId:id},actor);
    return ok ? c.json({ok:true}) : c.json({error:"video_state_conflict"},409);
  }
  if(body.action!=="fail" || typeof body.note!=="string" || !body.note.trim() || body.note.length>1024) return c.json({error:"verified_failure_note_required"},400);
  const ok=await reconcileVideoTask(c.env,c.req.param("id"),{kind:"fail",note:body.note},actor);
  return ok ? c.json({ok:true}) : c.json({error:"video_state_conflict"},409);
});
