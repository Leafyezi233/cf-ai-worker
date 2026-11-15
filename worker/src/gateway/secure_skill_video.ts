import { createPreparedDoubaoVideo, doubaoVideoTaskView, refreshDoubaoVideoTask } from "./doubao_video";
import { parseDoubaoVideoRequest } from "./doubao_video_request";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { authenticateGateway } from "./auth";
import { readBoundedBody } from "./embeddings";
import { isAutoServiceSelection } from "./service_groups";
import { resolveVideoRoute, allowVideoRead, mayRead } from "./video";
import { readVideoConfig, safeVideoUpstreamId, safeVideoUrl, videoModelError } from "./video_config";
import { videoUpstreamModel } from "./video_endpoint";
import { secureVideoEndpoint, type SecureVideoConfig } from "./secure_skill_video_config";
import { parseSecureVideoRequest, normalizeSecureVideoRequest, serviceImageIds, type NormalizedSecureVideoRequest } from "./secure_skill_video_request";
import { validateServiceImageIds, bindServiceImageIds } from "./video_reference_service";
import { validateServiceVideoIds, bindServiceVideoIds } from "./video_reference_video_service";
import { resolveRowPeakPricing, resolveRowPricingMode } from "./pricing";
import { consumeModelQuota } from "./quota";
import { checkDeviceRateLimit, getSetting, monthStartMs, openModelKey, resolvePriceSnapshot } from "../db/repo";
import { createVideoTask, failUnsubmittedVideoTask, findVideoTask, getVideoTask, listVideoTasks, markVideoSubmission, claimVideoPoll, finishVideoPoll, videoBudgetError, type VideoTask } from "../db/video_tasks";
import { sha256Hex, sealSecret, openSecret, isEncryptedSecret } from "../utils/crypto";
import { readEnvSecret } from "../utils/env-secret";
type C=Context<{Bindings:Env}>;
interface SecureRoute {model:string;public_model:string;upstream_model:string;provider_id:string;provider_name:string;endpoint:string;credential:string;video:SecureVideoConfig;seconds:number;ratio:string;resolution:string;service_image_ids:string[];service_group_id:string|null;revision:number|null;price_multiplier:number;window_id:string|null}
export function readSecureVideoPoll(value:unknown,expectedId?:string):{id:string|null;status:string|null;result:string|null}{
  const invalid={id:null,status:null,result:null};
  if(!value||typeof value!=="object"||Array.isArray(value))return invalid;
  const v=value as Record<string,unknown>;
  const id=v.task_id??v.id;
  if(!safeVideoUpstreamId(id)||(Object.hasOwn(v,"task_id")&&v.task_id!==id)||(Object.hasOwn(v,"id")&&v.id!==id)||(expectedId!==undefined&&id!==expectedId))return invalid;
  if(typeof v.status!=="string"||!["queued","in_progress","completed","failed"].includes(v.status))return invalid;
  const result=v.result&&typeof v.result==="object"&&!Array.isArray(v.result)?v.result as Record<string,unknown>:{};
  const output=Array.isArray(v.output)&&v.output[0]&&typeof v.output[0]==="object"?v.output[0] as Record<string,unknown>:{};
  const url=[v.video_url,v.url,output.url,result.video_url,result.url].find(safeVideoUrl)??null;
  return {id,status:v.status,result:url};
}
export function standardVideoTaskView(task:VideoTask){
  const r=JSON.parse(task.route_json) as SecureRoute;
  const unknown=task.status==="submission_unknown"||(task.status==="submitting"&&Date.now()-task.created_at>60000);
  const status=unknown?"submission_unknown":task.status==="succeeded"?"completed":task.status==="failed"?"failed":task.status==="submitting"?"queued":"in_progress";
  const url=status==="completed"?"/v1/videos/"+encodeURIComponent(task.id)+"/content":null;
  return {object:"video.generation",id:task.id,task_id:task.id,model:r.public_model,status,duration:r.seconds,seconds:r.seconds,ratio:r.ratio,resolution:r.resolution,
    url,video_url:url,result_url:url,output:url?[{url}]:[],result:url?{url,video_url:url}:null,
    price_per_call:task.price_usd,cost_usd:status==="completed"?task.price_usd:0,next_poll_at:task.status==="pending"?task.poll_after:null,
    ...(unknown?{submission_unknown:true,requires_review:true}:{}),...(task.error_code==="reference_bind_unconfirmed"?{error:{code:"reference_bind_unconfirmed"},requires_review:true}:{}),
    ...(status==="failed"?{error:{code:"video_generation_failed"}}:{}),created_at:task.created_at,updated_at:task.updated_at};
}
async function secureJson(env:Env,r:SecureRoute,method:"POST"|"GET",taskId:string,upstreamId?:string,body?:unknown,timeout=20000):Promise<unknown>{
  if(timeout<=0||r.video?.adapter!=="secure_skill"||!videoUpstreamModel(r.upstream_model)||r.upstream_model!==r.video.upstream_model||typeof r.endpoint!=="string"||!r.endpoint.endsWith("/videos")||r.endpoint!==secureVideoEndpoint(r.endpoint.slice(0,-"/videos".length))||!isEncryptedSecret(r.credential)||upstreamId!==undefined&&!safeVideoUpstreamId(upstreamId))throw Error("invalid_secure_video_route");
  const key=await openSecret(r.credential,env.ENCRYPTION_KEY);if(!key||/[\r\n]/.test(key))throw Error("video_credential_unavailable");
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1,timeout));
  try{
    const response=await fetch(r.endpoint+(upstreamId?"/"+encodeURIComponent(upstreamId):""),{method,redirect:"manual",signal:controller.signal,
      headers:{authorization:"Bearer "+key,accept:"application/json","content-type":"application/json",...(method==="POST"?{"Idempotency-Key":"cpg-video-"+taskId}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok||Number(response.headers.get("content-length")||0)>65536||!/application\/(?:[a-z0-9.+-]*\+)?json/i.test(response.headers.get("content-type")||"")){void response.body?.cancel().catch(()=>{});throw Error("video_upstream_unconfirmed");}
    return JSON.parse(await readBoundedBody(response.body,65536,controller.signal));
  }finally{clearTimeout(timer);}
}
export async function refreshSecureVideoTask(env:Env,task:VideoTask,deadline=Date.now()+20000):Promise<boolean>{
  if(task.status!=="pending"||!task.upstream_task_id||Number(task.poll_after||0)>Date.now()||Number(task.poll_lease_until||0)>Date.now())return false;
  const claim=await claimVideoPoll(env,task.id,Date.now());if(!claim)return false;
  const r=JSON.parse(task.route_json) as SecureRoute;
  const delay=Number.isInteger(r.video.poll_interval_ms)&&r.video.poll_interval_ms>=15000&&r.video.poll_interval_ms<=300000?r.video.poll_interval_ms:60000;
  try{
    const reply=await secureJson(env,r,"GET",task.id,task.upstream_task_id,undefined,Math.min(20000,deadline-Date.now()));
    const poll=readSecureVideoPoll(reply,task.upstream_task_id);
    if(poll.status==="completed"&&poll.result){await finishVideoPoll(env,task.id,{status:"succeeded",result_url:poll.result},claim);return true;}
    if(poll.status==="failed"){await finishVideoPoll(env,task.id,{status:"failed",error_code:"upstream_generation_failed"},claim);return true;}
    await finishVideoPoll(env,task.id,{status:"pending",next_poll_ms:delay,...(poll.status===null||poll.status==="completed"?{error_code:"video_result_unconfirmed"}:{})},claim);
  }catch{await finishVideoPoll(env,task.id,{status:"pending",error_code:"video_query_unconfirmed",next_poll_ms:Math.max(delay,60000)},claim);}
  return true;
}
function canonical(b:NormalizedSecureVideoRequest,resolution:string,subId:string|null){return JSON.stringify(["secure_skill",b.model,b.prompt,b.duration,b.ratio,resolution,b.image_urls,b.first_frame??null,b.last_frame??null,b.video_urls,b.audio_urls,b.reference_image_ids,b.first_frame_id??null,b.last_frame_id??null,subId,...(b.reference_video_ids.length?[b.reference_video_ids]:[])]);}
export async function createStandardVideoHandler(c:C):Promise<Response>{
  c.header("Cache-Control","no-store");
  c.header("X-Cpg-Video-Dispatch","not-started");
  const device=await authenticateGateway(c);if(!device)return c.json({error:"unauthorized"},401);
  const key=c.req.header("idempotency-key")||"";if(!/^[A-Za-z0-9_-]{8,128}$/.test(key))return c.json({error:"idempotency_key_required"},400);
  if(Number(c.req.header("content-length")||0)>32768)return c.json({error:"request_too_large"},413);
  let raw:unknown;try{raw=JSON.parse(await readBoundedBody(c.req.raw.body,32768,c.req.raw.signal));}catch(e){return c.json({error:"invalid_video_request"},e instanceof Error&&e.message==="body_too_large"?413:400);}
  const parsed=parseSecureVideoRequest(raw),doubao=parseDoubaoVideoRequest(raw);
  if(!parsed)return createPreparedDoubaoVideo(c,{raw,device});
  const prior=await findVideoTask(c.env,device.id,key);
  if(prior){
    if(JSON.parse(prior.route_json).video?.adapter==="doubao")return createPreparedDoubaoVideo(c,{raw,device,prior});
    const r=JSON.parse(prior.route_json) as SecureRoute;
    const b=normalizeSecureVideoRequest(r.video,parsed);
    if(!b)return c.json({error:"idempotency_key_conflict"},409);
    const hash=await sha256Hex(canonical(b,b.resolution,device.sub_token_id??null));
    if(r.video.adapter!=="secure_skill"||!mayRead(prior,device)||prior.request_hash!==hash)return c.json({error:"idempotency_key_conflict"},409);
    return c.json(standardVideoTaskView(prior),200);
  }
  if(device.auth_via==="master"&&Number(device.calls_enabled??1)===0)return c.json({error:"calls_disabled"},403);
  if(isAutoServiceSelection(device))return c.json({error:"secure_video_explicit_route_required"},400);
  let selected:Awaited<ReturnType<typeof resolveVideoRoute>>;
  try{selected=await resolveVideoRoute(c.env,device,{model:parsed.model,prompt:parsed.prompt,seconds:parsed.duration??0,size:"",secure:parsed,...(doubao?{doubao}:{})});}
  catch(e){if(e instanceof HTTPException)return c.json({error:e.message},e.status);throw e;}
  const cfg=readVideoConfig(selected.billing),memberCfg=readVideoConfig(selected.member);
  if(cfg?.adapter==="doubao")return createPreparedDoubaoVideo(c,{raw,device,selected});
  if(device.rate_limit_rpm>0&&!await checkDeviceRateLimit(c.env,device.id,device.rate_limit_rpm))return c.json({error:"rate_limit_exceeded"},429);
  if(cfg?.adapter!=="secure_skill"||memberCfg?.adapter!=="secure_skill")return c.json({error:"secure_video_model_required"},400);
  const error=videoModelError(selected.billing)||videoModelError(selected.member);if(error)return c.json({error},400);
  const b=normalizeSecureVideoRequest(cfg,parsed),mb=normalizeSecureVideoRequest(memberCfg,parsed);
  if(!b||!mb||b.duration!==mb.duration||b.ratio!==mb.ratio||b.resolution!==mb.resolution||cfg.upstream_model!==memberCfg.upstream_model)return c.json({error:"incompatible_video_defaults"},400);
  const mode=resolveRowPricingMode(selected.billing);if(mode==="unset"||resolveRowPricingMode(selected.member)==="unset")return c.json({error:"model_pricing_missing"},400);
  if((mode==="free"&&cfg.quotes.some(q=>q.price!==0))||(resolveRowPricingMode(selected.member)==="free"&&memberCfg.quotes.some(q=>q.price!==0)))return c.json({error:"free_video_requires_zero_quotes"},400);
  const resolution=b.resolution??cfg.default_resolution;
  if(!b.resolution&&memberCfg.default_resolution!==resolution)return c.json({error:"incompatible_video_default_resolution"},400);
  const rate=cfg.quotes.find(q=>q.resolution===resolution&&q.has_reference_video===(b.video_urls.length+b.reference_video_ids.length>0));if(!rate)return c.json({error:"video_quote_missing"},400);
  const peak=selected.peak??await resolvePriceSnapshot(c.env,selected.billing.id,resolveRowPeakPricing(selected.billing));
  if ("servicePricingOverride" in selected && selected.servicePricingOverride != null) return c.json({error:"secure_video_scalar_override_not_supported"},400);
  const serviceMultiplier = "serviceMultiplier" in selected ? selected.serviceMultiplier : 1;
  if (typeof serviceMultiplier !== "number" || !Number.isFinite(serviceMultiplier) || serviceMultiplier < 0) return c.json({error:"invalid_video_price"},400);
  const price=rate.price*(rate.unit==="second"?b.duration:1)*serviceMultiplier*peak.multiplier;
  if(!Number.isFinite(price)||price<0||price>1000000)return c.json({error:"invalid_video_price"},400);
  const ids=serviceImageIds(b);
  try{if(ids.length)await validateServiceImageIds(c.env,device,ids);await validateServiceVideoIds(c.env,device,b.reference_video_ids);}catch{return c.json({error:"video_references_unavailable"},400);}
  const member=await openModelKey(c.env,selected.member),endpoint=secureVideoEndpoint(member.provider_endpoint);
  if(!endpoint)return c.json({error:"secure_video_endpoint_required"},400);
  const credential=readEnvSecret(c.env,member.provider_secret_name)||member.provider_api_key;
  if(!credential||!c.env.ENCRYPTION_KEY||/[\r\n]/.test(credential))return c.json({error:"video_credential_unavailable"},503);
  const quota=await consumeModelQuota(c.env,device,selected.quotaId,selected.limits);if(quota.limited)return c.json({error:"rate_limit_exceeded"},429);
  const budgetConfig=await getSetting<{monthly_budget_usd?:number;budget_action?:string}>(c.env,"budget_config");
  const budget={monthStartMs:monthStartMs(),...(budgetConfig?.budget_action==="block"&&Number(budgetConfig.monthly_budget_usd)>0?{globalLimit:Number(budgetConfig.monthly_budget_usd)}:{}),...(Number(device.cost_limit_monthly)>0?{deviceLimit:Number(device.cost_limit_monthly)}:{})};
  const route:SecureRoute={model:b.model,public_model:b.model,upstream_model:memberCfg.upstream_model,provider_id:member.provider_id,provider_name:member.provider_name,endpoint,credential:await sealSecret(credential,c.env.ENCRYPTION_KEY),video:memberCfg,
    seconds:b.duration,ratio:b.ratio,resolution,service_image_ids:ids,service_group_id:selected.groupId,revision:selected.revision,price_multiplier:peak.multiplier,window_id:peak.window_id};
  const now=Date.now(),hash=await sha256Hex(canonical(b,resolution,device.sub_token_id??null));
  const task:VideoTask={id:"vid_"+crypto.randomUUID(),device_id:device.id,sub_token_id:device.sub_token_id??null,idempotency_key:key,request_hash:hash,status:"submitting",upstream_task_id:null,route_json:JSON.stringify(route),price_usd:price,
    pricing_snapshot_json:JSON.stringify({billing_unit:"call",quote:rate,quote_quantity:rate.unit==="second"?b.duration:1,service_multiplier:serviceMultiplier,price_usd:price,price_multiplier:peak.multiplier,price_window_id:peak.window_id,model:b.model,duration:b.duration,ratio:b.ratio,resolution,service_group_id:selected.groupId,revision:selected.revision}),
    result_url:null,error_code:null,poll_after:now+memberCfg.poll_interval_ms,poll_lease_until:null,created_at:now,updated_at:now};
  if(!await createVideoTask(c.env,task,budget)){
    const raced=await findVideoTask(c.env,device.id,key);if(raced)return c.json(raced.request_hash===hash&&mayRead(raced,device)?standardVideoTaskView(raced):{error:"idempotency_key_conflict"},raced.request_hash===hash&&mayRead(raced,device)?200:409);
    const budgetError=await videoBudgetError(c.env,device.id,price,budget);return c.json({error:budgetError??"insufficient_balance"},budgetError?429:402);
  }
  let bound:string[]=[],boundVideos:string[]=[];
  try{if(ids.length)bound=await bindServiceImageIds(c.env,device,ids,task.id);if(bound.length!==ids.length)throw Error("reference_bind_unconfirmed");if(b.reference_video_ids.length)boundVideos=await bindServiceVideoIds(c.env,device,b.reference_video_ids,task.id);if(boundVideos.length!==b.reference_video_ids.length)throw Error("reference_bind_unconfirmed");}
  catch{
    await failUnsubmittedVideoTask(c.env,task.id);
    return c.json(standardVideoTaskView((await getVideoTask(c.env,task.id,device.id))||task),200);
  }
  const refs=new Map(ids.map((id,i)=>[id,bound[i]]));
  const images=[...b.image_urls,...b.reference_image_ids.map(id=>refs.get(id)!)];
  const first=b.first_frame??(b.first_frame_id?refs.get(b.first_frame_id):undefined),last=b.last_frame??(b.last_frame_id?refs.get(b.last_frame_id):undefined);
  try{
    c.header("X-Cpg-Video-Dispatch","attempted");
    const reply=await secureJson(c.env,route,"POST",task.id,undefined,{model:route.upstream_model,prompt:b.prompt,duration:b.duration,ratio:b.ratio,resolution,
      ...(images.length?{image_urls:images}:{}),...(first?{first_frame:first}:{}),...(last?{last_frame:last}:{}),...(b.video_urls.length+boundVideos.length?{video_urls:[...b.video_urls,...boundVideos]}:{}),...(b.audio_urls.length?{audio_urls:b.audio_urls}:{})});
    await markVideoSubmission(c.env,task.id,readSecureVideoPoll(reply).id);
  }catch{await markVideoSubmission(c.env,task.id,null);}
  return c.json(standardVideoTaskView((await getVideoTask(c.env,task.id,device.id))||task),200);
}
export async function getStandardVideoHandler(c:C):Promise<Response>{
  c.header("Cache-Control","no-store");const device=await authenticateGateway(c);if(!device)return c.json({error:"unauthorized"},401);
  if(!await allowVideoRead(c.env,device.id))return c.json({error:"video_read_rate_limited"},429);
  let task=await getVideoTask(c.env,c.req.param("id")||"",device.id);
  if(!task||!mayRead(task,device)||!["secure_skill","doubao"].includes(JSON.parse(task.route_json).video?.adapter))return c.json({error:"video_task_not_found"},404);
  if(JSON.parse(task.route_json).video?.adapter==="doubao"){
    if(await refreshDoubaoVideoTask(c.env,task))task=(await getVideoTask(c.env,task.id,device.id))||task;
    return c.json(doubaoVideoTaskView(task));
  }
  if(await refreshSecureVideoTask(c.env,task))task=(await getVideoTask(c.env,task.id,device.id))||task;
  return c.json(standardVideoTaskView(task));
}
export async function listStandardVideoHandler(c:C):Promise<Response>{
  c.header("Cache-Control","no-store");const device=await authenticateGateway(c);if(!device)return c.json({error:"unauthorized"},401);
  if(!await allowVideoRead(c.env,device.id))return c.json({error:"video_read_rate_limited"},429);
  const tasks=await listVideoTasks(c.env,device.id,30,device.auth_via==="sub"?device.sub_token_id??"":undefined);
  return c.json({object:"list",data:tasks.filter(t=>mayRead(t,device)&&["secure_skill","doubao"].includes(JSON.parse(t.route_json).video?.adapter)).map(t=>JSON.parse(t.route_json).video?.adapter==="doubao"?doubaoVideoTaskView(t):standardVideoTaskView(t))});
}
