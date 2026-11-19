import type { Context } from "hono";
import { secureRequestError, type SecureVideoRequest } from "./secure_skill_video_request";
import { refreshSecureVideoTask } from "./secure_skill_video";
import { refreshDoubaoVideoTask, doubaoVideoTaskView } from "./doubao_video";
import { normalizeDoubaoRequest, type DoubaoVideoRequest } from "./doubao_video_request";
export { createStandardVideoHandler, getStandardVideoHandler, listStandardVideoHandler } from "./secure_skill_video";
import { HTTPException } from "hono/http-exception";
import type { AuthedDevice, Env, ModelWithProvider } from "../types";
import { authenticateGateway } from "./auth";
import { readBoundedBody } from "./embeddings";
import { assertLegacyTokenScope, isAutoServiceSelection, resolveAutoServiceRoutes, resolveServiceRoute } from "./service_groups";
import { tokenScopeAllows } from "../db/token_policies";
import { resolveModelType } from "./model_type";
import { resolveRowPeakPricing, resolveRowPricingMode } from "./pricing";
import { consumeModelQuota } from "./quota";
import { selectCandidateRoute, routeNeedsLatencies } from "./routing";
import { checkDeviceRateLimit, monthStartMs, getSetting, getDeviceGroupIds, isModelInScope, filterCandidatesForDevice, getDeviceGroupRateLimits, getDeviceModelRateLimits, resolveModelKey, groupBillingRow, openModelKey, resolvePriceSnapshot, getRecentProviderAvgLatencies } from "../db/repo";
import { createVideoTask, videoBudgetError, getVideoTask, findVideoTask, listVideoTasks, markVideoSubmission, claimVideoPoll, finishVideoPoll, type VideoTask } from "../db/video_tasks";
import { readVideoConfig, readVideoPath, safeVideoUrl, videoCreationEndpoint, safeVideoUpstreamId, videoModelError, type VideoConfig } from "./video_config";
import { sha256Hex, sealSecret, openSecret } from "../utils/crypto";
import { readEnvSecret } from "../utils/env-secret";
import { validateVideoReferences, buildVideoReferenceUrls } from "./video_reference_assets";
import { ensureSchema } from "../db/schema";
import { BoundedWindow } from "../utils/boundedWindow";
import { claimVideoDiagnostics, captureVideoDiagnostic } from "../db/video_diagnostics";
import { readVideoDiagnosticBody, withVideoDiagnosticDeadline } from "./video_diagnostic_body";


async function hasVideoDiagnostics(env: Env, taskId: string): Promise<boolean> {
  try {
    if (!env.ENCRYPTION_KEY?.trim()) return false;
    return !!await env.DB.prepare("SELECT 1 AS active FROM video_diagnostic_grants WHERE task_id = ? AND expires_at > ?").bind(taskId,Date.now()).first();
  } catch { return false; }
}
const readWindows = new BoundedWindow();
export async function allowVideoRead(env: Env, deviceId: string): Promise<boolean> {
  if (!readWindows.hit("video-read:" + deviceId,120)) return false;
  if (!env.RATE_LIMITER) return true;  
  try {
    const ns=env.RATE_LIMITER;
    const response=await ns.get(ns.idFromName("video-read:"+deviceId)).fetch("https://rate-limiter.internal/consume?rpm=120",{method:"POST"});
    return response.ok && (await response.json() as {allowed?:boolean}).allowed === true;
  } catch { return false; }
}
export function resetVideoReadLimits(): void { readWindows.clear(); }
export const MAX_VIDEO_BODY_BYTES = 32 * 1024;
export const MAX_VIDEO_RESPONSE_BYTES = 64 * 1024;
export interface VideoRequest { model: string; prompt: string; seconds: number; size: string; reference_image_ids?:string[]; secure?:SecureVideoRequest; doubao?:DoubaoVideoRequest }
interface FrozenVideoRoute {
  model: string; public_model: string; upstream_model: string; provider_id: string; provider_name: string;
  endpoint: string; credential: string; video: VideoConfig; seconds: number; size: string;
  service_group_id: string | null; revision: number | null; price_multiplier: number; window_id: string | null;
  reference_image_ids?:string[];
}
export function validateVideoRequest(body: unknown): body is VideoRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return Object.keys(b).every(k => ["model","prompt","seconds","size","reference_image_ids"].includes(k))
    && typeof b.model === "string" && b.model.trim().length > 0 && b.model.length <= 256
    && typeof b.prompt === "string" && b.prompt.trim().length > 0 && b.prompt.length <= 8000
    && typeof b.seconds === "number" && Number.isInteger(b.seconds) && b.seconds >= 3 && b.seconds <= 15
    && typeof b.size === "string" && /^[1-9][0-9]{2,3}x[1-9][0-9]{2,3}$/.test(b.size)
    && (b.reference_image_ids === undefined || (Array.isArray(b.reference_image_ids) && b.reference_image_ids.length <= 3
      && b.reference_image_ids.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(id))
      && new Set(b.reference_image_ids).size === b.reference_image_ids.length));
}
function frozenRoute(task: VideoTask): FrozenVideoRoute { return JSON.parse(task.route_json) as FrozenVideoRoute; }
export function readGenericVideoPoll(reply: unknown, expectedTaskId?: string): {status:string|null; result:unknown} {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return {status:null,result:undefined};
  const root = reply as Record<string,unknown>;
  if (Object.prototype.hasOwnProperty.call(root,"code") && root.code !== "success") return {status:null,result:undefined};
  let obj=root;
  if (root.code === "success" && root.data && typeof root.data === "object" && !Array.isArray(root.data)) obj=root.data as Record<string,unknown>;
  if (expectedTaskId && (root.code === "success" || Object.prototype.hasOwnProperty.call(obj,"task_id"))
    && obj.task_id !== expectedTaskId) return {status:null,result:undefined};
  const nested=obj.data && typeof obj.data === "object" && !Array.isArray(obj.data) ? (obj.data as Record<string,unknown>).video_url : undefined;
  return {status:typeof obj.status === "string" ? obj.status : null,result:safeVideoUrl(obj.result_url) ? obj.result_url : nested};
}
export function videoTaskView(task: VideoTask) {
  if(JSON.parse(task.route_json).video?.adapter === "doubao")return doubaoVideoTaskView(task);
  const r = frozenRoute(task);
  const status = task.status === "submitting" && Date.now() - task.created_at > 60_000 ? "submission_unknown" : task.status;
  return { id:task.id, model:r.public_model, status, seconds:r.seconds, size:r.size,
    price_per_call:task.price_usd, cost_usd:task.status === "succeeded" ? task.price_usd : 0,
    result_url:task.status === "succeeded" && safeVideoUrl(task.result_url) && task.upstream_task_id ? "/v1/video/generations/" + encodeURIComponent(task.id) + "/content" : null,
    error_code:task.error_code,
    next_poll_at:status === "pending" ? task.poll_after : null,
    requires_review:status === "submission_unknown" || (status === "pending" && !!task.error_code && Number(task.poll_attempts || 0) >= 20),
    created_at:task.created_at, updated_at:task.updated_at };
}
export function mayRead(task: VideoTask, device: AuthedDevice): boolean {
  return task.device_id === device.id && (device.auth_via !== "sub" || task.sub_token_id === device.sub_token_id);
}
function videoRequestError(row: Parameters<typeof videoModelError>[0], body: VideoRequest): string | null {
  if (resolveModelType(row) !== "video") return "video_model_required";
  const error = videoModelError(row); if (error) return error;
  const config = readVideoConfig(row)!;
  if (config.adapter === "doubao") return body.doubao && normalizeDoubaoRequest(config,body.doubao) ? null : "doubao_video_spec_not_allowed";
  if (body.secure) return config.adapter === "secure_skill" ? secureRequestError(config,body.secure) : "secure_video_model_required";
  if (config.adapter !== "generic") return "legacy_video_model_required";
  if (!config.sizes.includes(body.size) || body.seconds < config.seconds_min || body.seconds > config.seconds_max) return "video_spec_not_allowed";
  const count = body.reference_image_ids?.length ?? 0;
  if (count && (!config.reference_images || count > config.reference_images.max_images)) return "video_references_not_allowed";
  return null;
}
function compatibleVideoMember(billing: Parameters<typeof videoModelError>[0], members: ModelWithProvider[], body: VideoRequest): {member: ModelWithProvider | null; error: string | null} {
  const error = videoRequestError(billing,body); if (error) return {member:null,error};
  const errors: string[] = [];
  for (const member of members) {
    const error = videoRequestError(member,body);
    if (!error) return {member,error:null};
    errors.push(error);
  }
  return {member:null,error:errors.includes("video_references_not_allowed") ? "video_references_not_allowed" : errors[0] ?? "invalid_video_pool"};
}
export async function resolveVideoRoute(env: Env, device: AuthedDevice, body: VideoRequest) {
  const model = body.model;
  const autoSelection = isAutoServiceSelection(device);
  const fixed = autoSelection ? null : await resolveServiceRoute(env,device,model);
  const routes = autoSelection ? await resolveAutoServiceRoutes(env,device,model) : fixed ? [fixed] : [];
  const errors: string[] = [];
  for (const route of routes) {
    const candidate = compatibleVideoMember(route.billingRow,route.members,body);
    if (!candidate.member) { errors.push(candidate.error!); continue; }
    return {billing:route.billingRow, member:candidate.member, quotaId:route.quotaId,
      limits:await (route.targetKind === "group" ? getDeviceGroupRateLimits : getDeviceModelRateLimits)(env,device.id),
      groupId:route.group.id, revision:route.group.revision, peak:route.autoPriceSnapshot,
      serviceMultiplier:route.group.multiplier,servicePricingOverride:route.mapping.pricing_json};
  }
  if (routes.length) throw new HTTPException(400,{message:errors.includes("video_references_not_allowed") ? "video_references_not_allowed" : errors[0]});
  const target = await resolveModelKey(env,model,{includeSecrets:false});
  if (target.kind === "none") throw new HTTPException(404,{message:"model_not_found"});
  if (target.kind === "group") {
    assertLegacyTokenScope(device, target.group.id, true);
    const scope = device.model_scope || "all";
    const grants = scope === "all" ? new Set<string>() : new Set(await getDeviceGroupIds(env,device.id));
    if (!isModelInScope(scope,target.group.id,grants,!!target.group.model_public)) throw new HTTPException(403,{message:"model_not_in_scope"});
    if (!target.members.length) throw new HTTPException(503,{message:"model_unavailable"});
    const billing = groupBillingRow(target.group,target.members[0].provider_type);
    const candidate = compatibleVideoMember(billing,target.members,body);
    if (!candidate.member) throw new HTTPException(400,{message:candidate.error!});
    const groupRewrite = JSON.parse(target.group.config_json || "{}").model_rewrite;
    const member = typeof groupRewrite === "string" && groupRewrite.trim() ? { ...candidate.member,
      config_json: JSON.stringify({ ...JSON.parse(candidate.member.config_json || "{}"), model_rewrite: groupRewrite }) } : candidate.member;
    return {billing,member,quotaId:target.group.id,limits:await getDeviceGroupRateLimits(env,device.id),groupId:null,revision:null,peak:undefined};
  }
  const scoped = (await filterCandidatesForDevice(env,device,target.candidates)).filter(row => tokenScopeAllows(device, ["model:" + row.id]));
  if (!scoped.length) throw new HTTPException(403,{message:"model_not_in_scope"});
  const video = scoped.filter(r => resolveModelType(r) === "video");
  if (!video.length) throw new HTTPException(400,{message:"video_model_required"});
  const latency = routeNeedsLatencies(video) ? await getRecentProviderAvgLatencies(env) : {};
  for (const member of selectCandidateRoute(video,model,latency)) {
    const error = videoRequestError(member,body);
    if (error) { errors.push(error); continue; }
    return {billing:member,member,quotaId:member.id,limits:await getDeviceModelRateLimits(env,device.id),groupId:null,revision:null,peak:undefined};
  }
  throw new HTTPException(400,{message:errors.includes("video_references_not_allowed") ? "video_references_not_allowed" : errors[0]});
}
async function upstreamJson(env: Env, route: FrozenVideoRoute, method: "GET" | "POST", taskId?: string, body?: unknown, timeoutMs = 20_000, diagnosticTaskId?: string, diagnosticGate?:Promise<boolean>, deferDiagnostic?:(work:Promise<void>)=>void): Promise<unknown> {
  const key = await openSecret(route.credential,env.ENCRYPTION_KEY);
  if (!key) throw Error("video_credential_unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),Math.max(1,timeoutMs));
  const requestDeadline=Date.now()+Math.max(1,timeoutMs); let captureDeadline: number|undefined;
  let httpStatus: number|null=null, contentType: string|null=null, text: string|null=null, truncated=false, sampled=false;
  const capture=async(slot:"create"|"processing"|"terminal"|"error",error_code?:string)=>{
    if(!diagnosticTaskId) return;
    captureDeadline ??= Math.min(requestDeadline,Date.now()+250);
    const event={slot,http_status:httpStatus,content_type:contentType,body:text,truncated,error_code};
    const work=(diagnosticGate ?? Promise.resolve(true)).then(allowed => allowed
      ? captureVideoDiagnostic(env,diagnosticTaskId,event,[key,typeof (body as VideoRequest|undefined)?.prompt === "string" ? (body as VideoRequest).prompt : ""]) : undefined).catch(()=>{});
    deferDiagnostic?.(work);
    await withVideoDiagnosticDeadline(()=>work,undefined,captureDeadline-Date.now());
  };
  try {
    const response = await fetch(route.endpoint + (taskId ? "/" + encodeURIComponent(taskId) : ""),{
      method,headers:{authorization:"Bearer " + key,"content-type":"application/json",accept:"application/json"},
      body:body === undefined ? undefined : JSON.stringify(body),redirect:"manual",signal:controller.signal,
    });
    httpStatus=response.status;contentType=response.headers.get("content-type");
    const invalidHeaders=!response.ok || Number(response.headers.get("content-length") || 0) > MAX_VIDEO_RESPONSE_BYTES
      || !/application\/(?:[a-z0-9.+-]*\+)?json/i.test(contentType || "");
    if(invalidHeaders && !diagnosticTaskId){void response.body?.cancel().catch(()=>{});throw Error("invalid_video_upstream_response");}
    let reply: unknown;
    if(diagnosticTaskId){
      const read=await readVideoDiagnosticBody(response.body,MAX_VIDEO_RESPONSE_BYTES,controller.signal);
      text=read.text;truncated=read.truncated;
      if(read.error_code || invalidHeaders){
        clearTimeout(timer);sampled=true;
        if(method==="POST") await capture("create",read.error_code || "invalid_video_upstream_response");
        await capture("error",read.error_code || "invalid_video_upstream_response");
        throw Error("invalid_video_upstream_response");
      }
      reply=JSON.parse(text);
    } else {reply=JSON.parse(await readBoundedBody(response.body,MAX_VIDEO_RESPONSE_BYTES,controller.signal));}
    clearTimeout(timer);
    if(diagnosticTaskId){
      const poll=readGenericVideoPoll(reply,method === "GET" ? taskId : undefined);
      if(method==="POST"){
        await capture("create");
        const id=readVideoPath(reply,route.video.task_id_path);
        if(typeof id!=="string" || !id || id.length>256 || id==="." || id===".." || /[\x00-\x20\x7f]/.test(id)) await capture("error","submission_unconfirmed");
      } else if(poll.status==="SUCCESS" || (poll.status !== null && route.video.failed_statuses.includes(poll.status))){
        await capture("terminal");
        if(poll.status==="SUCCESS" && !safeVideoUrl(poll.result)) await capture("error","video_result_unconfirmed");
      } else {await capture(poll.status !== null ? "processing" : "error",poll.status !== null ? undefined : "invalid_video_status");}
    }
    return reply;
  } catch(error) {
    clearTimeout(timer);
    if(!sampled){if(method==="POST")await capture("create","upstream_unconfirmed");await capture("error","upstream_unconfirmed");}
    throw error;
  } finally { clearTimeout(timer); }
}
export async function refreshVideoTask(env: Env, task: VideoTask, deadline = Date.now()+20_000): Promise<boolean> {
  if (frozenRoute(task).video.adapter === "secure_skill") return refreshSecureVideoTask(env,task,deadline);
  if (frozenRoute(task).video.adapter === "doubao") return refreshDoubaoVideoTask(env,task,deadline);
  if (task.status !== "pending" || !task.upstream_task_id || Number(task.poll_after || 0) > Date.now() || Number(task.poll_lease_until || 0) > Date.now()) return false;
  const claim = await claimVideoPoll(env,task.id,Date.now()); if (!claim) return false;
  const failureDelay = Math.min(900_000,60_000 * 2 ** Math.min(4,Math.max(0,Number(task.poll_attempts || 0))));
  try {
    const route = frozenRoute(task);
    const diagnostics = await withVideoDiagnosticDeadline(()=>hasVideoDiagnostics(env,task.id),false,Math.min(250,deadline-Date.now()));
    const body = await upstreamJson(env,route,"GET",task.upstream_task_id,undefined,Math.min(20_000,deadline-Date.now()),diagnostics ? task.id : undefined) as Record<string,unknown>;
    const poll = readGenericVideoPoll(body,task.upstream_task_id);
    if (poll.status === "SUCCESS") {
      const result = poll.result;
      if (safeVideoUrl(result)) { await finishVideoPoll(env,task.id,{status:"succeeded",result_url:result},claim); return true; }
      await finishVideoPoll(env,task.id,{status:"pending",error_code:"video_result_unconfirmed",next_poll_ms:failureDelay},claim); return true;
    }
    if (poll.status !== null && route.video.failed_statuses.includes(poll.status)) {
      await finishVideoPoll(env,task.id,{status:"failed",error_code:"upstream_generation_failed"},claim); return true;
    }
    await finishVideoPoll(env,task.id,{status:"pending",...(poll.status === null ? {error_code:"invalid_video_status",next_poll_ms:failureDelay} : {next_poll_ms:60_000})},claim);
  } catch {
    await finishVideoPoll(env,task.id,{status:"pending",error_code:"video_query_unconfirmed",next_poll_ms:failureDelay},claim);
  }
  return true;
}
export async function createVideoHandler(c: Context<{Bindings:Env}>) {
  c.header("Cache-Control","no-store");
  const device = await authenticateGateway(c); if (!device) return c.json({error:"unauthorized"},401);
  const key = c.req.header("idempotency-key") || "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) return c.json({dispatch:"not_started",error:"idempotency_key_required"},400);
  const prior = await findVideoTask(c.env,device.id,key);
  const safeDispatch = prior ? {} : {dispatch:"not_started"};
  if (Number(c.req.header("content-length") || 0) > MAX_VIDEO_BODY_BYTES) return c.json({...safeDispatch,error:"request_too_large"},413);
  let body: unknown;
  try { body = JSON.parse(await readBoundedBody(c.req.raw.body,MAX_VIDEO_BODY_BYTES,c.req.raw.signal)); }
  catch(e) { return c.json({...safeDispatch,error:e instanceof Error && e.message === "body_too_large" ? "request_too_large" : "invalid_json"}, e instanceof Error && e.message === "body_too_large" ? 413 : 400); }
  if (!validateVideoRequest(body)) return c.json({...safeDispatch,error:"invalid_video_request"},400);
  const referenceIds = body.reference_image_ids ?? [];
  const hash = await sha256Hex(JSON.stringify([body.model,body.prompt,body.seconds,body.size,device.sub_token_id ?? null,...(referenceIds.length ? [referenceIds] : [])]));
  const existing = prior;
  if (existing) {
    if (!mayRead(existing,device) || existing.request_hash !== hash) return c.json({error:"idempotency_key_conflict"},409);
    return c.json(videoTaskView(existing),200);
  }
  if (device.auth_via === "master" && Number(device.calls_enabled ?? 1) === 0) return c.json({dispatch:"not_started",error:"calls_disabled"},403);
  if (device.rate_limit_rpm > 0 && !await checkDeviceRateLimit(c.env,device.id,device.rate_limit_rpm)) return c.json({dispatch:"not_started",error:"rate_limit_exceeded"},429);
  let selected: Awaited<ReturnType<typeof resolveVideoRoute>>;
  try { selected = await resolveVideoRoute(c.env,device,body); }
  catch (e) { if (e instanceof HTTPException && e.status >= 400 && e.status < 500) return c.json({dispatch:"not_started",error:e.message},e.status); throw e; }
  if (resolveRowPricingMode(selected.billing) === "unset") return c.json({dispatch:"not_started",error:"model_pricing_missing"},400);
  const error = videoModelError(selected.billing) || videoModelError(selected.member);
  if (error) return c.json({dispatch:"not_started",error},400);
  let referenceUrls:string[] = [];
  let referenceAssets:Awaited<ReturnType<typeof validateVideoReferences>> = [];
  if (referenceIds.length) {
    try { referenceAssets=await validateVideoReferences(c.env,device,referenceIds); }
    catch (e) { if (e instanceof HTTPException) return c.json({dispatch:"not_started",error:e.message},e.status); return c.json({dispatch:"not_started",error:"video_references_unavailable"},400); }
  }
  const quota = await consumeModelQuota(c.env,device,selected.quotaId,selected.limits);
  if (quota.limited) return c.json({dispatch:"not_started",error:"rate_limit_exceeded"},429);
  const peak = selected.peak ?? await resolvePriceSnapshot(c.env,selected.billing.id,resolveRowPeakPricing(selected.billing));
  const price = resolveRowPricingMode(selected.billing) === "free" ? 0 : Number(selected.billing.price_per_call ?? 0) * peak.multiplier;
  if (!Number.isFinite(price) || price < 0) return c.json({dispatch:"not_started",error:"invalid_video_price"},400);
  const configBudget = await getSetting<{monthly_budget_usd?:number;budget_action?:string}>(c.env,"budget_config");
  const budget = {monthStartMs:monthStartMs(),
    ...(configBudget?.budget_action === "block" && Number(configBudget.monthly_budget_usd)>0 ? {globalLimit:Number(configBudget.monthly_budget_usd)} : {}),
    ...(Number(device.cost_limit_monthly)>0 ? {deviceLimit:Number(device.cost_limit_monthly)} : {})};
  const member = await openModelKey(c.env,selected.member);
  const endpoint = videoCreationEndpoint(member.provider_endpoint);
  if (!endpoint) return c.json({dispatch:"not_started",error:"video_endpoint_required"},400);
  const credential = readEnvSecret(c.env,member.provider_secret_name) || member.provider_api_key;
  if (!credential || !c.env.ENCRYPTION_KEY) return c.json({dispatch:"not_started",error:"video_credential_unavailable"},503);
  const rewrite = JSON.parse(member.config_json || "{}").model_rewrite;
  const route: FrozenVideoRoute = {model:body.model,public_model:body.model,upstream_model:typeof rewrite === "string" && rewrite.trim() ? rewrite : member.model_name,
    provider_id:member.provider_id,provider_name:member.provider_name,endpoint,credential:await sealSecret(credential,c.env.ENCRYPTION_KEY),video:readVideoConfig(member)!,
    seconds:body.seconds,size:body.size,...(referenceIds.length ? {reference_image_ids:referenceIds} : {}),service_group_id:selected.groupId,revision:selected.revision,price_multiplier:peak.multiplier,window_id:peak.window_id};
  const now = Date.now();
  const task: VideoTask = {id:"vid_" + crypto.randomUUID(),device_id:device.id,sub_token_id:device.sub_token_id ?? null,idempotency_key:key,request_hash:hash,
    status:"submitting",upstream_task_id:null,route_json:JSON.stringify(route),price_usd:price,pricing_snapshot_json:JSON.stringify({policy_version:device.token_routing_policy?.version ?? null,billing_unit:"call",price_per_call:selected.billing.price_per_call,price_usd:price,price_multiplier:peak.multiplier,price_window_id:peak.window_id,model:body.model,service_group_id:selected.groupId,revision:selected.revision,seconds:body.seconds,size:body.size}),
    result_url:null,error_code:null,poll_after:now+15_000,poll_lease_until:null,created_at:now,updated_at:now};
  if (!await createVideoTask(c.env,task,budget,referenceIds.length ? referenceIds : undefined)) {
    const raced = await findVideoTask(c.env,device.id,key);
    if (raced) return c.json(raced.request_hash === hash && mayRead(raced,device) ? videoTaskView(raced) : {error:"idempotency_key_conflict"},raced.request_hash === hash && mayRead(raced,device) ? 200 : 409);
    const budgetError = await videoBudgetError(c.env,device.id,price,budget);
    if (budgetError) return c.json({dispatch:"not_started",error:budgetError},429);
    return c.json({dispatch:"not_started",error:"insufficient_balance"},402);
  }
  const diagnosticGate = claimVideoDiagnostics(c.env,task.id,true);
  const deferDiagnostic=(work:Promise<void>)=>{try { c.executionCtx.waitUntil(work); } catch {   }};
  try {
    referenceUrls = await buildVideoReferenceUrls(c.env,device,referenceAssets,new URL(c.req.url).origin);
    const reply = await upstreamJson(c.env,route,"POST",undefined,{model:route.upstream_model,prompt:body.prompt,seconds:body.seconds,size:body.size,...(referenceUrls.length === 1 ? {image:referenceUrls[0]} : referenceUrls.length > 1 ? {images:referenceUrls} : {})},20_000,task.id,diagnosticGate,deferDiagnostic);
    const upstreamId = readVideoPath(reply,route.video.task_id_path);
    const validId = safeVideoUpstreamId(upstreamId);
    await markVideoSubmission(c.env,task.id,validId ? upstreamId : null);
  } catch { await markVideoSubmission(c.env,task.id,null); }
  const saved = await getVideoTask(c.env,task.id,device.id);
  return c.json(videoTaskView(saved || task),202);
}
export async function getVideoHandler(c: Context<{Bindings:Env}>) {
  c.header("Cache-Control","no-store");
  const device = await authenticateGateway(c); if (!device) return c.json({error:"unauthorized"},401);
  if (!await allowVideoRead(c.env,device.id)) { c.header("Retry-After","60"); return c.json({error:"video_read_rate_limited"},429); }
  const task = await getVideoTask(c.env,c.req.param("id") || "",device.id);
  if (!task || !mayRead(task,device)) return c.json({error:"video_task_not_found"},404);
  const refreshed = await refreshVideoTask(c.env,task);
  return c.json(videoTaskView(refreshed ? (await getVideoTask(c.env,task.id,device.id)) || task : task));
}
export async function listVideoHandler(c: Context<{Bindings:Env}>) {
  c.header("Cache-Control","no-store");
  const device = await authenticateGateway(c); if (!device) return c.json({error:"unauthorized"},401);
  if (!await allowVideoRead(c.env,device.id)) { c.header("Retry-After","60"); return c.json({error:"video_read_rate_limited"},429); }
  const tasks = await listVideoTasks(c.env,device.id,30,device.auth_via === "sub" ? device.sub_token_id ?? "" : undefined);
  return c.json({data:tasks.filter(t => mayRead(t,device)).map(videoTaskView)});
}
export async function pollVideoTasks(env: Env): Promise<void> {
  await ensureSchema(env);
  const now = Date.now(), deadline = now + 35_000;
  await env.DB.prepare("UPDATE video_tasks SET status = 'submission_unknown', error_code = 'submission_unconfirmed', updated_at = ? WHERE id IN (SELECT id FROM video_tasks WHERE status = 'submitting' AND created_at < ? ORDER BY created_at LIMIT 100) AND status = 'submitting'").bind(now,now-60_000).run();
  const due = await env.DB.prepare("SELECT * FROM video_tasks WHERE status = 'pending' AND poll_after <= ? AND COALESCE(poll_lease_until,0) <= ? ORDER BY poll_after LIMIT 100").bind(now,now).all<VideoTask>();
  const rows = due.results || []; let cursor = 0;
  await Promise.allSettled(Array.from({length:4},async()=>{
    while (cursor < rows.length && Date.now() < deadline) {
      const task = rows[cursor++];
      try { await refreshVideoTask(env,task,deadline); } catch {   }
    }
  }));
}
