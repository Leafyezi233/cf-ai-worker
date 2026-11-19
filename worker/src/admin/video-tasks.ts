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
  let route: Record<string,unknown> = {};
  try {
    const parsed: unknown = JSON.parse(t.route_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) route = parsed as Record<string, unknown>;
  } catch {   }
  return {id:t.id,device_id:t.device_id,sub_token_id:t.sub_token_id,status:t.status,upstream_task_id:t.upstream_task_id,
    model:route.public_model,provider_id:route.provider_id,price_usd:t.price_usd,error_code:t.error_code,
    poll_after:t.poll_after,poll_attempts:t.poll_attempts || 0,created_at:t.created_at,updated_at:t.updated_at};
}
function taskListConditions(query: Record<string, string>, exporting: boolean) {
  const attentionKey = query.attention_before !== undefined ? "attention_before" : "list_task_attention_before";
  const attentionRaw = query[attentionKey];
  const attention = attentionRaw !== undefined;
  if (attention && (query.status !== undefined && query.status !== "review" || query.from !== undefined || query.to !== undefined || query.attention_before !== undefined && query.list_task_attention_before !== undefined || !/^\d+$/.test(attentionRaw) || !Number.isSafeInteger(Number(attentionRaw)) || Number(attentionRaw) < 0 || Number(attentionRaw) > 8640000000000000)) throw new Error("invalid_video_task_filters");
  const integer = (key: string, fallback: number, max: number) => {
    if (query[key] === undefined) return fallback;
    if (!/^\d+$/.test(query[key]) || !Number.isSafeInteger(Number(query[key])) || Number(query[key]) > max)
      throw new Error("invalid_video_task_filters");
    return Number(query[key]);
  };
  const limit = integer("limit", exporting ? 500 : 100, exporting ? 1000 : 200);
  if (limit < 1) throw new Error("invalid_video_task_filters");
  const from = attention ? 0 : integer("from", 0, 8640000000000000);
  const to = attention ? Number(attentionRaw) : integer("to", 8640000000000000, 8640000000000000);
  if (from > to) throw new Error("invalid_video_task_filters");
  if (attention && to > Date.now() - 30 * 60 * 1000) throw new Error("invalid_video_task_filters");
  if (!attention && (query.from !== undefined || query.to !== undefined) &&
      (query.from === undefined || query.to === undefined || to - from > 31 * 86400000))
    throw new Error("invalid_video_task_filters");
  const status = attention ? "review" : query.status || "review";
  if (!["review", "all", "submitting", "submission_unknown", "pending", "succeeded", "failed"].includes(status))
    throw new Error("invalid_video_task_filters");
  const conditions = ["created_at >= ?", attention ? "created_at < ?" : "created_at <= ?"];
  const binds: (string | number)[] = [from, to];
  if (attention || status === "review") conditions.push("status IN ('submission_unknown','pending')");
  else if (status !== "all") { conditions.push("status = ?"); binds.push(status); }
  for (const [key, column] of [["device_id", "device_id"], ["task_id", "id"]] as const) {
    const value = query[key];
    if (!value) continue;
    if (value.length > 256 || /[\x00-\x20\x7f]/.test(value)) throw new Error("invalid_video_task_filters");
    conditions.push(column + " = ?"); binds.push(value);
  }
  const signature = JSON.stringify([...(attention ? ["attention"] : []), status, from, to, query.device_id || "", query.task_id || ""]);
  if (query.cursor) {
    try {
      if (query.cursor.length > 4096) throw new Error();
      const cursor: unknown = JSON.parse(decodeURIComponent(query.cursor));
      if (!Array.isArray(cursor) || cursor.length !== 3 || !Number.isSafeInteger(cursor[0]) || cursor[0] < 0 ||
          cursor[0] > 8640000000000000 || typeof cursor[1] !== "string" || !cursor[1] || cursor[1].length > 256 ||
          cursor[2] !== signature) throw new Error();
      binds[0] = Math.max(from, cursor[0]);  
      conditions.push("(created_at, id) > (?, ?)"); binds.push(cursor[0], cursor[1]);
    } catch { throw new Error("invalid_video_task_filters"); }
  }
  return { limit, signature, status, attention, taskId: query.task_id, deviceId: query.device_id, where: "WHERE " + conditions.join(" AND "), binds };
}
async function readTaskPage(env: Env, filters: ReturnType<typeof taskListConditions>) {
  await ensureSchema(env);
  let where = filters.where;
  let binds = [...filters.binds];
  if ((filters.status === "review" || filters.attention) && !filters.taskId && !filters.deviceId) {
    const branch = (status: "pending" | "submission_unknown") =>
      "SELECT id FROM (SELECT id, created_at FROM video_tasks " +
      filters.where.replace("status IN ('submission_unknown','pending')", "status = '" + status + "'") +
      " ORDER BY created_at ASC, id ASC LIMIT ?)";
    where = "WHERE id IN (" + branch("pending") + " UNION ALL " + branch("submission_unknown") + ")";
    binds = [...filters.binds, filters.limit + 1, ...filters.binds, filters.limit + 1];
  }
  const rows = await env.DB.prepare(
    "SELECT id, device_id, sub_token_id, status, upstream_task_id, price_usd, error_code, poll_after, " +
    "COALESCE(poll_attempts, 0) AS poll_attempts, created_at, updated_at, " +
    "CASE WHEN json_valid(route_json) THEN route_json -> '$.public_model' END AS model_json, " +
    "CASE WHEN json_valid(route_json) THEN route_json -> '$.provider_id' END AS provider_id_json " +
    "FROM video_tasks " + where + " ORDER BY created_at ASC, id ASC LIMIT ?")
    .bind(...binds, filters.limit + 1).all<{ id: string; created_at: number; model_json: string | null; provider_id_json: string | null }>();
  const all = (rows.results || []).map(({ model_json, provider_id_json, ...row }) => ({
    ...row,
    model: model_json === null ? undefined : JSON.parse(model_json),
    provider_id: provider_id_json === null ? undefined : JSON.parse(provider_id_json),
  }));
  const items = all.slice(0, filters.limit);
  const hasMore = all.length > filters.limit;
  const last = items.at(-1);
  return { items, has_more: hasMore, next_cursor: hasMore && last
    ? encodeURIComponent(JSON.stringify([last.created_at, last.id, filters.signature])) : null, limit: filters.limit };
}
videoTasksApp.get("/", async c => {
  let filters: ReturnType<typeof taskListConditions>;
  try { filters = taskListConditions(c.req.query(), false); }
  catch { return c.json({ error: "invalid_video_task_filters" }, 400); }
  return c.json(await readTaskPage(c.env, filters));
});
videoTasksApp.get("/export", async c => {
  let filters: ReturnType<typeof taskListConditions>;
  try { filters = taskListConditions(c.req.query(), true); }
  catch { return c.json({ error: "invalid_video_task_filters" }, 400); }
  const page = await readTaskPage(c.env, filters);
  c.header("Content-Disposition", 'attachment; filename="video-tasks.json"');
  c.header("X-Export-Truncated", String(page.has_more));
  return c.json({ ...page, truncated: page.has_more });
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
