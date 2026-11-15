import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthedDevice, Env } from "../types";
import { authenticateGateway } from "./auth";
import { VideoUploadLifetime } from "./video_upload_lifecycle";
import { callReferenceService as call, referenceServiceOrigin, referenceServiceOwner } from "./video_reference_service";
type C = Context<{ Bindings: Env }>;
const ID = /^[a-f0-9]{32}$/;
const STORAGE_MAX = 100 * 1024 * 1024;
function fail(status: 400|401|404|409|411|413|415|429|503, code:string): never { throw new HTTPException(status,{message:code}); }
function idsChecked(ids:string[]):void { if(!Array.isArray(ids)||ids.length>3||ids.some(id=>!ID.test(id))||new Set(ids).size!==ids.length)fail(400,"invalid_video_references"); }
export interface ReferenceVideoLimits { enabled:boolean; formats:string[]; max_bytes:number; max_duration_ms:number }
export async function referenceVideoLimits(env:Env):Promise<ReferenceVideoLimits> {
  const v=await call(env,"/v1/video-assets/limits");
  if(v?.enabled===false)return {enabled:false,formats:[],max_bytes:0,max_duration_ms:0};
  if(v?.enabled!==true||!Array.isArray(v.formats)||v.formats.length!==1||v.formats[0]!=="video/mp4"||!Number.isSafeInteger(v.max_bytes)||v.max_bytes<1||v.max_bytes>STORAGE_MAX||!Number.isSafeInteger(v.max_duration_ms)||v.max_duration_ms<1)fail(503,"invalid_reference_service_result");
  return {enabled:true,formats:[...v.formats],max_bytes:v.max_bytes,max_duration_ms:v.max_duration_ms};
}
function metadata(v:any,limits:ReferenceVideoLimits,expected?:string){
  if(!limits.enabled||!v||!ID.test(v.id)||expected!==undefined&&v.id!==expected||!Number.isSafeInteger(v.bytes)||v.bytes<1||v.bytes>limits.max_bytes||!limits.formats.includes(v.content_type)||!Number.isSafeInteger(v.duration_ms)||v.duration_ms<1||v.duration_ms>limits.max_duration_ms||!Number.isSafeInteger(v.expires_at)||v.expires_at<=Date.now()/1000)fail(503,"invalid_reference_service_result");
  return {id:v.id,bytes:v.bytes,content_type:v.content_type,duration_ms:v.duration_ms,expires_at:v.expires_at};
}
export async function validateServiceVideoIds(env:Env,device:AuthedDevice,ids:string[]):Promise<void>{
  idsChecked(ids);if(!ids.length)return;referenceServiceOrigin(env);
  const limits=await referenceVideoLimits(env);if(!limits.enabled)fail(503,"reference_video_upload_disabled");
  for(const id of ids)metadata(await call(env,"/v1/video-assets/"+id+"?owner="+encodeURIComponent(referenceServiceOwner(device))),limits,id);
}
export async function bindServiceVideoIds(env:Env,device:AuthedDevice,ids:string[],taskId:string):Promise<string[]>{
  idsChecked(ids);if(!/^vid_[A-Za-z0-9_-]{8,160}$/.test(taskId))fail(400,"invalid_video_task");if(!ids.length)return[];
  const origin=referenceServiceOrigin(env),expires=Math.floor(Date.now()/1000)+86400,urls:string[]=[];
  for(const id of ids){
    const v=await call(env,"/v1/video-assets/"+id+"/bind",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({owner:referenceServiceOwner(device),task_id:taskId,expires_at:expires})});
    let u:URL;try{u=new URL(v.url);}catch{fail(503,"invalid_reference_service_result");}
    if(v.id!==id||v.expires_at!==expires||u.origin!==origin||u.username||u.password||u.hash||u.pathname!=="/video-assets/"+id||u.search.length>2048)fail(503,"invalid_reference_service_result");
    urls.push(u.toString());
  }return urls;
}
export async function getReferenceVideoLimits(c:C):Promise<Response>{c.header("Cache-Control","no-store");if(!await authenticateGateway(c))fail(401,"unauthorized");return c.json({item:await referenceVideoLimits(c.env)});}
let uploads=0;
export async function uploadServiceReferenceVideo(c:C):Promise<Response>{
  c.header("Cache-Control","no-store");if(uploads>=2)fail(429,"reference_upload_busy");uploads++;
  const life=new VideoUploadLifetime(c.req.raw.signal,()=>{uploads--;},()=>new HTTPException(400,{message:"reference_upload_timeout"}),()=>new HTTPException(400,{message:"reference_upload_interrupted"}),120_000);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    const device=await life.wait(life.track(authenticateGateway(c)));if(!device)fail(401,"unauthorized");
    const limits=await life.wait(life.track(referenceVideoLimits(c.env)));life.check();if(!limits.enabled)fail(503,"reference_video_upload_disabled");
    const type=(c.req.header("content-type")??"").split(";")[0].trim().toLowerCase();if(!limits.formats.includes(type))fail(415,"unsupported_reference_content_type");
    const declared=c.req.header("content-length");if(!declared)fail(411,"reference_content_length_required");
    const length=/^\d+$/.test(declared)?Number(declared):NaN;if(!Number.isSafeInteger(length)||length<1||length>limits.max_bytes)fail(413,"reference_video_too_large");
    if(!c.req.raw.body)fail(400,"invalid_reference_video");reader=c.req.raw.body.getReader();let readBytes=0;
    life.onStop(()=>{void reader?.cancel().catch(()=>{});});
    const stream=new ReadableStream<Uint8Array>({async pull(controller){try{life.check();const part=await life.wait(life.track(reader!.read()));if(part.done){if(readBytes!==length)throw new HTTPException(400,{message:"reference_length_mismatch"});controller.close();return;}if(!(part.value instanceof Uint8Array)||readBytes+part.value.byteLength>length)throw new HTTPException(413,{message:"reference_video_too_large"});readBytes+=part.value.byteLength;controller.enqueue(part.value);}catch(e){life.stop(e instanceof Error?e:new Error("reference_upload_interrupted"));controller.error(e);void reader?.cancel().catch(()=>{});}},cancel(){void reader?.cancel().catch(()=>{});}});
    const result=await call(c.env,"/v1/video-assets",{method:"POST",headers:{"content-type":type,"content-length":String(length),"x-cpg-owner":referenceServiceOwner(device),"x-cpg-account":device.id},body:stream},life,120_000);
    life.check();if(readBytes!==length)fail(503,"invalid_reference_service_result");return c.json(metadata(result,limits),201);
  }catch(e){life.stop(e instanceof Error?e:new Error("reference_service_unavailable"));throw e;}finally{void reader?.cancel().catch(()=>{});life.returnedResponse();}
}
export async function deleteServiceReferenceVideo(c:C):Promise<Response>{
  c.header("Cache-Control","no-store");const device=await authenticateGateway(c);if(!device)fail(401,"unauthorized");const id=c.req.param("id")||"";idsChecked([id]);
  const v=await call(c.env,"/v1/video-assets/"+id,{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({owner:referenceServiceOwner(device)})});if(v?.deleted!==true)fail(503,"invalid_reference_service_result");return c.json({deleted:true});
}
