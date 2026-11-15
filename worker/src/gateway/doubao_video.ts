import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { authenticateGateway } from "./auth";
import { readBoundedBody } from "./embeddings";
import { isAutoServiceSelection } from "./service_groups";
import { resolveVideoRoute, allowVideoRead, mayRead } from "./video";
import { readVideoConfig, safeVideoUpstreamId, safeVideoUrl, videoModelError } from "./video_config";
import { videoUpstreamModel } from "./video_endpoint";
import { doubaoVideoEndpoint, type DoubaoVideoConfig } from "./doubao_video_config";
import { parseDoubaoVideoRequest, normalizeDoubaoRequest, type DoubaoVideoRequest } from "./doubao_video_request";
import { validateServiceImageIds, bindServiceImageIds } from "./video_reference_service";
import { validateServiceVideoIds, bindServiceVideoIds } from "./video_reference_video_service";
import { resolveRowPeakPricing, resolveRowPricingMode } from "./pricing";
import { consumeModelQuota } from "./quota";
import { checkDeviceRateLimit, getSetting, monthStartMs, openModelKey, resolvePriceSnapshot } from "../db/repo";
import { createVideoTask, failUnsubmittedVideoTask, findVideoTask, getVideoTask, listVideoTasks, markVideoSubmission, claimVideoPoll, finishVideoPoll, videoBudgetError, type VideoTask } from "../db/video_tasks";
import { sha256Hex, sealSecret, openSecret, isEncryptedSecret } from "../utils/crypto";
import { readEnvSecret } from "../utils/env-secret";
type C = Context<{ Bindings: Env }>;
interface DoubaoRoute {
  protocol_version: "doubao-video-v1"; model: string; public_model: string; upstream_model: string;
  provider_id: string; provider_name: string; endpoint: string; credential: string;
  video: DoubaoVideoConfig; billing_video: DoubaoVideoConfig;
  seconds: number; ratio: string; resolution: string; sub_token_id: string | null;
  service_group_id: string | null; revision: number | null; price_multiplier: number; window_id: string | null;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function rootId(value: unknown, expectedId?: string): string | null {
  const v = record(value); if (!v || !safeVideoUpstreamId(v.id)) return null;
  if (Object.hasOwn(v,"task_id") && v.task_id !== v.id || expectedId !== undefined && expectedId !== v.id) return null;
  return v.id;
}
function actualUsage(value: unknown): string | undefined {
  const usage = record(value); if (!usage) return undefined;
  const clean: Record<string, number> = {};
  for (const key of ["completion_tokens", "total_tokens"]) {
    const n = usage[key]; if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) clean[key] = n;
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : undefined;
}
export function readDoubaoVideoPoll(value: unknown, expectedId?: string): { id: string | null; status: string | null; result: string | null; upstream_usage_json?: string } {
  const invalid = { id: null, status: null, result: null }, v = record(value), id = rootId(value, expectedId);
  if (!v || !id || typeof v.status !== "string" || !["queued","processing","succeeded","failed"].includes(v.status)) return invalid;
  const url = record(v.content)?.video_url;
  const usage = actualUsage(v.usage);
  return { id, status: v.status, result: safeVideoUrl(url) ? url : null, ...(usage === undefined ? {} : { upstream_usage_json: usage }) };
}
export function doubaoVideoTaskView(task: VideoTask) {
  const r = JSON.parse(task.route_json) as DoubaoRoute;
  const unknown = task.status === "submission_unknown" || task.status === "submitting" && Date.now()-task.created_at > 60000;
  const status = unknown ? "submission_unknown" : task.status === "succeeded" ? "completed" : task.status === "failed" ? "failed" : task.status === "submitting" ? "queued" : "in_progress";
  return { object: "video.generation", id: task.id, task_id: task.id, model: r.public_model, status,
    duration: r.seconds, seconds: r.seconds, ratio: r.ratio, resolution: r.resolution,
    content_available: false, url: null, video_url: null, result_url: null, output: [], result: null,
    price_per_call: task.price_usd, cost_usd: status === "completed" ? task.price_usd : 0,
    next_poll_at: task.status === "pending" ? task.poll_after : null,
    ...(unknown ? { submission_unknown: true, requires_review: true } : {}),
    ...(status === "failed" ? { error: { code: "video_generation_failed" } } : {}), created_at: task.created_at, updated_at: task.updated_at };
}
async function doubaoJson(env: Env, r: DoubaoRoute, method: "POST" | "GET", taskId: string, upstreamId?: string, body?: unknown, timeout = 20000): Promise<unknown> {
  if (timeout <= 0 || r.protocol_version !== "doubao-video-v1" || r.video.adapter !== "doubao" || r.upstream_model !== r.video.upstream_model ||
    !videoUpstreamModel(r.upstream_model) || typeof r.endpoint!=="string" || !r.endpoint.endsWith("/contents/generations/tasks") || doubaoVideoEndpoint(r.endpoint.slice(0,-"/contents/generations/tasks".length)) !== r.endpoint ||
    !isEncryptedSecret(r.credential) || upstreamId !== undefined && !safeVideoUpstreamId(upstreamId)) throw Error("invalid_doubao_video_route");
  const key = await openSecret(r.credential,env.ENCRYPTION_KEY);
  if (!key || /[\r\n]/.test(key)) throw Error("video_credential_unavailable");
  const controller = new AbortController(), timer = setTimeout(()=>controller.abort(), Math.max(1,timeout));
  try {
    const response = await fetch(r.endpoint + (upstreamId ? "/"+encodeURIComponent(upstreamId) : ""), { method, redirect: "manual", signal: controller.signal,
      headers: { authorization: "Bearer "+key, accept: "application/json", "content-type": "application/json", ...(method === "POST" ? { "Idempotency-Key": "cpg-video-"+taskId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if ((method === "POST" ? response.status !== 202 : response.status !== 200) || Number(response.headers.get("content-length")||0)>65536 || !/application\/(?:[a-z0-9.+-]*\+)?json/i.test(response.headers.get("content-type")||"")) {
      void response.body?.cancel().catch(()=>{}); throw Error("video_upstream_unconfirmed");
    }
    return JSON.parse(await readBoundedBody(response.body,65536,controller.signal));
  } finally { clearTimeout(timer); }
}
export async function refreshDoubaoVideoTask(env: Env, task: VideoTask, deadline = Date.now()+20000): Promise<boolean> {
  if (task.status !== "pending" || !task.upstream_task_id || Number(task.poll_after||0)>Date.now() || Number(task.poll_lease_until||0)>Date.now() || deadline <= Date.now()) return false;
  const claim = await claimVideoPoll(env,task.id,Date.now()); if (!claim) return false;
  const r = JSON.parse(task.route_json) as DoubaoRoute;
  const delay = Number.isInteger(r.video.poll_interval_ms) && r.video.poll_interval_ms >= 15000 && r.video.poll_interval_ms <= 300000 ? r.video.poll_interval_ms : 60000;
  try {
    const poll = readDoubaoVideoPoll(await doubaoJson(env,r,"GET",task.id,task.upstream_task_id,undefined,Math.min(20000,deadline-Date.now())),task.upstream_task_id);
    if (poll.status === "succeeded" && poll.result) {
      const outcome = { status: "succeeded" as const, result_url: poll.result, ...(poll.upstream_usage_json === undefined ? {} : { upstream_usage_json: poll.upstream_usage_json }) };
      await finishVideoPoll(env,task.id,outcome,claim); return true;
    }
    if (poll.status === "failed") {
      const outcome = { status: "failed" as const, error_code: "upstream_generation_failed", ...(poll.upstream_usage_json === undefined ? {} : { upstream_usage_json: poll.upstream_usage_json }) };
      await finishVideoPoll(env,task.id,outcome,claim); return true;
    }
    await finishVideoPoll(env,task.id,{status:"pending",next_poll_ms:delay,...(poll.upstream_usage_json === undefined ? {} : {upstream_usage_json:poll.upstream_usage_json}),...(poll.status === null || poll.status === "succeeded" ? {error_code:"video_result_unconfirmed"} : {})},claim);
  } catch { await finishVideoPoll(env,task.id,{status:"pending",error_code:"video_query_unconfirmed",next_poll_ms:Math.max(delay,60000)},claim); }
  return true;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  const v = record(value); return v ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])) : value;
}
function canonical(b: DoubaoVideoRequest, subId: string | null): string { return JSON.stringify(stable(["doubao-video-v1",b,subId])); }
function privateIds(b: DoubaoVideoRequest, kind: "image" | "video"): string[] {
  return b.content.flatMap(item=>{
    const url = kind === "image" ? item.image_url?.url : item.video_url?.url;
    return typeof url === "string" && new RegExp("^cpg-"+kind+":[a-f0-9]{32}$").test(url) ? [url.slice(url.indexOf(":")+1)] : [];
  });
}
function upstreamBody(b: DoubaoVideoRequest, model: string, images: Map<string,string>, videos: Map<string,string>) {
  const content = b.content.map(item=>({ type: item.type,
    ...(item.type === "text" ? {text:item.text} : {}),
    ...(item.type === "image_url" ? {image_url:{url:images.get(item.image_url!.url)??item.image_url!.url}} : {}),
    ...(item.type === "video_url" ? {video_url:{url:videos.get(item.video_url!.url)??item.video_url!.url}} : {}),
    ...(item.type === "audio_url" ? {audio_url:{url:item.audio_url!.url}} : {}), ...(item.role === undefined ? {} : {role:item.role}) }));
  return { model, content, duration:b.duration, ratio:b.ratio, resolution:b.resolution,
    ...(b.use_asset_library === undefined ? {} : {use_asset_library:b.use_asset_library}),
    ...(b.generate_audio === undefined ? {} : {generate_audio:b.generate_audio}), ...(b.watermark === undefined ? {} : {watermark:b.watermark}),
    ...(b.return_last_frame === undefined ? {} : {return_last_frame:b.return_last_frame}), ...(b.seed === undefined ? {} : {seed:b.seed}) };
}
export function createDoubaoVideoHandler(c: C): Promise<Response> { return createPreparedDoubaoVideo(c); }
export async function createPreparedDoubaoVideo(c: C, prepared?: { raw: unknown; device: NonNullable<Awaited<ReturnType<typeof authenticateGateway>>>; selected?: Awaited<ReturnType<typeof resolveVideoRoute>>; prior?: VideoTask }): Promise<Response> {
  c.header("Cache-Control","no-store"); c.header("X-Cpg-Video-Dispatch","not-started");
  const device = prepared?.device ?? await authenticateGateway(c); if (!device) return c.json({error:"unauthorized"},401);
  const key = c.req.header("idempotency-key")||""; if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) return c.json({error:"idempotency_key_required"},400);
  if (Number(c.req.header("content-length")||0)>32768) return c.json({error:"request_too_large"},413);
  let raw: unknown; try { raw = prepared ? prepared.raw : JSON.parse(await readBoundedBody(c.req.raw.body,32768,c.req.raw.signal)); }
  catch (e) { return c.json({error:"invalid_video_request"},e instanceof Error && e.message === "body_too_large" ? 413 : 400); }
  const parsed = parseDoubaoVideoRequest(raw); if (!parsed) return c.json({error:"invalid_video_request"},400);
  const prior = prepared?.prior ?? await findVideoTask(c.env,device.id,key);
  if (prior) {
    const r = JSON.parse(prior.route_json) as DoubaoRoute;
    if (r.protocol_version !== "doubao-video-v1" || r.video?.adapter !== "doubao" || !mayRead(prior,device)) return c.json({error:"idempotency_key_conflict"},409);
    const b = normalizeDoubaoRequest(r.billing_video,parsed);
    if (!b || prior.request_hash !== await sha256Hex(canonical(b,device.sub_token_id??null))) return c.json({error:"idempotency_key_conflict"},409);
    return c.json(doubaoVideoTaskView(prior),200);
  }
  if (device.auth_via === "master" && Number(device.calls_enabled??1) === 0) return c.json({error:"calls_disabled"},403);
  if (isAutoServiceSelection(device)) return c.json({error:"doubao_video_explicit_route_required"},400);
  if (device.rate_limit_rpm>0 && !await checkDeviceRateLimit(c.env,device.id,device.rate_limit_rpm)) return c.json({error:"rate_limit_exceeded"},429);
  let selected: Awaited<ReturnType<typeof resolveVideoRoute>>;
  try { selected = prepared?.selected ?? await resolveVideoRoute(c.env,device,{model:parsed.model,prompt:"",seconds:parsed.duration??0,size:"",doubao:parsed}); }
  catch (e) { if (e instanceof HTTPException) return c.json({error:e.message},e.status); throw e; }
  const cfg = readVideoConfig(selected.billing), memberCfg = readVideoConfig(selected.member);
  if (cfg?.adapter !== "doubao" || memberCfg?.adapter !== "doubao") return c.json({error:"doubao_video_model_required"},400);
  const error = videoModelError(selected.billing)||videoModelError(selected.member); if (error) return c.json({error},400);
  const b = normalizeDoubaoRequest(cfg,parsed), mb = normalizeDoubaoRequest(memberCfg,parsed);
  if (!b || !mb || canonical(b,null) !== canonical(mb,null) || cfg.upstream_model !== memberCfg.upstream_model) return c.json({error:"incompatible_video_defaults"},400);
  const mode = resolveRowPricingMode(selected.billing), memberMode = resolveRowPricingMode(selected.member);
  if (mode === "unset" || memberMode === "unset") return c.json({error:"model_pricing_missing"},400);
  if (mode === "free" && cfg.quotes.some(q=>q.price!==0) || memberMode === "free" && memberCfg.quotes.some(q=>q.price!==0)) return c.json({error:"free_video_requires_zero_quotes"},400);
  const rate = cfg.quotes.find(q=>q.resolution === b.resolution && q.has_reference_video === b.content.some(i=>i.type === "video_url"));
  if (!rate) return c.json({error:"video_quote_missing"},400);
  if ("servicePricingOverride" in selected && selected.servicePricingOverride != null) return c.json({error:"doubao_video_scalar_override_not_supported"},400);
  const serviceMultiplier = "serviceMultiplier" in selected ? selected.serviceMultiplier : 1;
  if (typeof serviceMultiplier !== "number" || !Number.isFinite(serviceMultiplier) || serviceMultiplier<0) return c.json({error:"invalid_video_price"},400);
  const peak = selected.peak??await resolvePriceSnapshot(c.env,selected.billing.id,resolveRowPeakPricing(selected.billing));
  const price = rate.price*(rate.unit === "second" ? b.duration! : 1)*serviceMultiplier*peak.multiplier;
  if (!Number.isFinite(price) || price<0 || price>1000000) return c.json({error:"invalid_video_price"},400);
  const ids = privateIds(b,"image"), vids = privateIds(b,"video");
  if (ids.length>9 || vids.length>3) return c.json({error:"video_references_not_allowed"},400);
  try { await validateServiceImageIds(c.env,device,ids); await validateServiceVideoIds(c.env,device,vids); }
  catch { return c.json({error:"video_references_unavailable"},400); }
  const member = await openModelKey(c.env,selected.member), endpoint = doubaoVideoEndpoint(member.provider_endpoint);
  if (!endpoint) return c.json({error:"doubao_video_endpoint_required"},400);
  const credential = readEnvSecret(c.env,member.provider_secret_name)||member.provider_api_key;
  if (!credential || !c.env.ENCRYPTION_KEY || /[\r\n]/.test(credential)) return c.json({error:"video_credential_unavailable"},503);
  const quota = await consumeModelQuota(c.env,device,selected.quotaId,selected.limits); if (quota.limited) return c.json({error:"rate_limit_exceeded"},429);
  const budgetConfig = await getSetting<{monthly_budget_usd?:number;budget_action?:string}>(c.env,"budget_config");
  const budget = {monthStartMs:monthStartMs(),...(budgetConfig?.budget_action === "block" && Number(budgetConfig.monthly_budget_usd)>0 ? {globalLimit:Number(budgetConfig.monthly_budget_usd)} : {}),...(Number(device.cost_limit_monthly)>0 ? {deviceLimit:Number(device.cost_limit_monthly)} : {})};
  const route: DoubaoRoute = {protocol_version:"doubao-video-v1",model:b.model,public_model:b.model,upstream_model:memberCfg.upstream_model,
    provider_id:member.provider_id,provider_name:member.provider_name,endpoint,credential:await sealSecret(credential,c.env.ENCRYPTION_KEY),video:memberCfg,billing_video:cfg,
    seconds:b.duration!,ratio:b.ratio!,resolution:b.resolution!,sub_token_id:device.sub_token_id??null,service_group_id:selected.groupId,revision:selected.revision,price_multiplier:peak.multiplier,window_id:peak.window_id};
  const now = Date.now(), hash = await sha256Hex(canonical(b,device.sub_token_id??null));
  const task: VideoTask = {id:"vid_"+crypto.randomUUID(),device_id:device.id,sub_token_id:device.sub_token_id??null,idempotency_key:key,request_hash:hash,status:"submitting",upstream_task_id:null,
    route_json:JSON.stringify(route),price_usd:price,pricing_snapshot_json:JSON.stringify({billing_unit:"call",quote:rate,quote_quantity:rate.unit === "second" ? b.duration : 1,service_multiplier:serviceMultiplier,price_usd:price,price_multiplier:peak.multiplier,price_window_id:peak.window_id,model:b.model,duration:b.duration,ratio:b.ratio,resolution:b.resolution,service_group_id:selected.groupId,revision:selected.revision}),
    result_url:null,error_code:null,poll_after:now+memberCfg.poll_interval_ms,poll_lease_until:null,created_at:now,updated_at:now};
  if (!await createVideoTask(c.env,task,budget)) {
    const raced = await findVideoTask(c.env,device.id,key);
    if (raced) { const same = raced.request_hash === hash && mayRead(raced,device) && JSON.parse(raced.route_json).video?.adapter === "doubao"; return c.json(same ? doubaoVideoTaskView(raced) : {error:"idempotency_key_conflict"},same ? 200 : 409); }
    const budgetError = await videoBudgetError(c.env,device.id,price,budget); return c.json({error:budgetError??"insufficient_balance"},budgetError ? 429 : 402);
  }
  let bound: string[] = [], boundVideos: string[] = [];
  try {
    bound = await bindServiceImageIds(c.env,device,ids,task.id); boundVideos = await bindServiceVideoIds(c.env,device,vids,task.id);
    if (bound.length !== ids.length || boundVideos.length !== vids.length) throw Error("reference_bind_unconfirmed");
  } catch {
    await failUnsubmittedVideoTask(c.env,task.id);
    return c.json(doubaoVideoTaskView((await getVideoTask(c.env,task.id,device.id))||task),200);
  }
  const images = new Map(ids.map((id,i)=>["cpg-image:"+id,bound[i]])), videos = new Map(vids.map((id,i)=>["cpg-video:"+id,boundVideos[i]]));
  try {
    c.header("X-Cpg-Video-Dispatch","attempted");
    const reply = await doubaoJson(c.env,route,"POST",task.id,undefined,upstreamBody(b,route.upstream_model,images,videos));
    await markVideoSubmission(c.env,task.id,rootId(reply));
  } catch { await markVideoSubmission(c.env,task.id,null); }
  return c.json(doubaoVideoTaskView((await getVideoTask(c.env,task.id,device.id))||task),200);
}
export async function getDoubaoVideoHandler(c: C): Promise<Response> {
  c.header("Cache-Control","no-store"); const device = await authenticateGateway(c); if (!device) return c.json({error:"unauthorized"},401);
  if (!await allowVideoRead(c.env,device.id)) return c.json({error:"video_read_rate_limited"},429);
  let task = await getVideoTask(c.env,c.req.param("id")||"",device.id);
  if (!task || !mayRead(task,device) || JSON.parse(task.route_json).video?.adapter !== "doubao") return c.json({error:"video_task_not_found"},404);
  if (await refreshDoubaoVideoTask(c.env,task)) task = (await getVideoTask(c.env,task.id,device.id))||task;
  return c.json(doubaoVideoTaskView(task));
}
export async function listDoubaoVideoHandler(c: C): Promise<Response> {
  c.header("Cache-Control","no-store"); const device = await authenticateGateway(c); if (!device) return c.json({error:"unauthorized"},401);
  if (!await allowVideoRead(c.env,device.id)) return c.json({error:"video_read_rate_limited"},429);
  const tasks = await listVideoTasks(c.env,device.id,30,device.auth_via === "sub" ? device.sub_token_id??"" : undefined);
  return c.json({object:"list",data:tasks.filter(t=>mayRead(t,device) && JSON.parse(t.route_json).video?.adapter === "doubao").map(doubaoVideoTaskView)});
}
