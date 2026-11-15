import { Hono } from "hono";
import type { Env, ModelWithProvider } from "../types";
import { ensureSchema } from "../db/schema";
import { openModelKey } from "../db/repo";
import { sha256Hex } from "../utils/crypto";
import { readEnvSecret } from "../utils/env-secret";
import { buildProtocolHeaders, buildUpstreamHeaders } from "../utils/http";
import { protocolModelName, protocolTargetUrl, protocolUpstreamKey, readConnectionSet, resolveProtocolConnection } from "../gateway/protocol_connections";
import { resolveProviderBase } from "../gateway/endpoints";
import { isImageModel, resolveModelType } from "../gateway/model_type";
import { parseRewriteRules } from "../gateway/rewrite";

export const protocolProbesApp = new Hono<{ Bindings: Env }>();
export const PROTOCOL_PROBE_TTL_MS = 86400000;
export const PROTOCOL_PROBE_TIMEOUT_MS = 8000;
const PREFIX = "protocol_probe:";
type Endpoint = "chat/completions" | "responses" | "messages";
export interface ProbeResult { fingerprint: string; checked_at: number; expires_at: number; results: { endpoint: Endpoint; status: "supported" | "unsupported" | "unknown"; http_status: number; latency_ms: number; reason: string }[] }
type Row = ModelWithProvider & { provider_enabled: number };
type WireTarget = { endpoint: Endpoint; url: string; model: string; headers: Headers };
type Target = { row: Row; wires: WireTarget[]; explicit: boolean; fingerprint: string; endpoints: Endpoint[]; config: Record<string, any> };
const active = new WeakMap<object, Set<string>>();
const query = "SELECT m.*, p.name AS provider_name,p.type AS provider_type,p.endpoint AS provider_endpoint,p.api_key AS provider_api_key,p.secret_name AS provider_secret_name,p.config_json AS provider_config_json,p.enabled AS provider_enabled FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.enabled=1 AND p.enabled=1";
function config(raw: string | null) { const v=JSON.parse(raw || "{}"); if(!v || typeof v!=="object" || Array.isArray(v)) throw Error("invalid_config"); return v; }
async function target(env: Env, row: Row): Promise<Target> {
  if (resolveModelType(row) === "video") throw Error("video_model_not_probed");
  if (resolveModelType(row) === "embedding") throw Error("embedding_model_not_probed");
  if (isImageModel(row)) throw Error("image_model_not_probed");
  const cfg=config(row.config_json);
  const connections=readConnectionSet(row);
  if(!connections.valid)throw Error("invalid_connections");
  const endpoints: Endpoint[]=connections.explicit
    ? (["chat/completions","responses","messages"] as const).filter(e=>!!resolveProtocolConnection(row,e))
    : row.provider_type==="anthropic" ? ["messages"] : ["chat/completions","responses"];
  if(!endpoints.length)throw Error("no_enabled_connections");
  const needsSharedKey=!connections.explicit||endpoints.some(e=>!resolveProtocolConnection(row,e)?.secret_name);
  const opened=needsSharedKey?await openModelKey(env,row):row;
  const rewrite=parseRewriteRules(row.config_json).model_rewrite;
  const wires:WireTarget[]=[];
  for(const endpoint of endpoints){
    const key=connections.explicit?protocolUpstreamKey(opened,endpoint,env):opened.provider_api_key||readEnvSecret(env,row.provider_secret_name);
    if(!key)throw Error("missing_connection_credential");
    const url=connections.explicit?protocolTargetUrl(row,endpoint):resolveProviderBase(row.provider_endpoint,row.provider_type)+"/"+endpoint;
    if(!url)throw Error("missing_connection_endpoint");
    const parsed=new URL(url);if(!["http:","https:"].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)throw Error("invalid_endpoint");
    const model=rewrite||(connections.explicit?protocolModelName(row,endpoint):row.model_name);
    const source=new Headers({"content-type":"application/json"});
    const headers=connections.explicit?buildProtocolHeaders(source,row,endpoint,key):buildUpstreamHeaders(source,row.provider_type,key);
    if(!connections.explicit&&endpoint==="messages")headers.set("anthropic-version","2023-06-01");
    wires.push({endpoint,url,model,headers});
  }
  const identity=wires.map(w=>{const headers:[string,string][]=[];w.headers.forEach((v,k)=>headers.push([k,v]));headers.sort(([a],[b])=>a.localeCompare(b));return [w.endpoint,w.url,w.model,headers];});
  const fingerprint=await sha256Hex(JSON.stringify(["protocol-probe-v2",identity]));
  return {row,wires,explicit:connections.explicit,fingerprint,endpoints,config:cfg};
}
function locked(t:Target) { return Object.prototype.hasOwnProperty.call(t.config,"protocol_capabilities") || Object.prototype.hasOwnProperty.call(t.config,"responses_mode"); }
async function load(env:Env,id:string) {const row=await env.DB.prepare(query+" AND m.id=?").bind(id).first<Row>();if(!row)return null;try{return await target(env,row);}catch{return null;}}
async function saved(env:Env,fp:string):Promise<ProbeResult|null> {
  const row=await env.DB.prepare("SELECT value_json FROM settings WHERE key=?").bind(PREFIX+fp).first<{value_json:string}>();
  if(!row)return null;
  try {const r=JSON.parse(row.value_json);return r.fingerprint===fp && Array.isArray(r.results) && Number.isFinite(r.expires_at) ? r : null;}catch{return null;}
}
async function body(c:any) { const text=await c.req.text();if(text.length>65536)throw Error("body_too_large");const v=JSON.parse(text);if(!v||typeof v!=="object"||Array.isArray(v))throw Error("invalid_body");return v; }
protocolProbesApp.use("*",async(c,next)=>{c.header("Cache-Control","no-store");try{await ensureSchema(c.env);await next();}catch{return c.json({error:"protocol_probe_failed"},400);}});
protocolProbesApp.post("/preview",async c=>{
  const b=await body(c);
  if(b.force!==undefined&&typeof b.force!=="boolean"||b.provider_id!==undefined&&typeof b.provider_id!=="string"||b.model_ids!==undefined&&(!Array.isArray(b.model_ids)||b.model_ids.length>500||b.model_ids.some((id:any)=>typeof id!=="string"||!id)))return c.json({error:"invalid_scope"},400);
  const ids=b.model_ids===undefined?null:new Set<string>(b.model_ids);
  const rows=(await c.env.DB.prepare(query+" ORDER BY m.id LIMIT 10001").all<Row>()).results || [];
  const selected=rows.filter(r=>(!ids||ids.has(r.id))&&(!b.provider_id||r.provider_id===b.provider_id));
  if(selected.length>500||rows.length>10000)return c.json({error:"scope_too_large",limit:500},400);
  const groups=new Map<string,{t:Target;ids:string[]}>();let skipped=0;
  for(const row of selected){try{const t=await target(c.env,row);const old=groups.get(t.fingerprint);if(old)old.ids.push(row.id);else groups.set(t.fingerprint,{t,ids:[row.id]});}catch{skipped++;}}
  const observations=new Map<string,ProbeResult>();
  const fingerprints=[...groups.keys()];
  for(let at=0;at<fingerprints.length;at+=80){
    const keys=fingerprints.slice(at,at+80).map(fp=>PREFIX+fp);
    const found=await c.env.DB.prepare("SELECT key,value_json FROM settings WHERE key IN ("+keys.map(()=>"?").join(",")+")").bind(...keys).all<{key:string;value_json:string}>();
    for(const row of found.results || []){try{const r=JSON.parse(row.value_json);if(r.fingerprint===row.key.slice(PREFIX.length)&&Array.isArray(r.results)&&Number.isFinite(r.expires_at))observations.set(r.fingerprint,r);}catch{}}
  }
  const items=[];let request_count=0;
  for(const {t,ids:memberIds} of groups.values()){
    const cached=observations.get(t.fingerprint) ?? null;
    const needs_probe=!!b.force||!cached||cached.expires_at<=Date.now()||cached.results.some(r=>r.status==="unknown");
    if(needs_probe)request_count+=t.endpoints.length;
    items.push({model_id:t.row.id,model_ids:memberIds,model_name:t.row.model_name,provider_name:t.row.provider_name,fingerprint:t.fingerprint,endpoints:t.endpoints,cached,needs_probe,manual_locked:locked(t)});
  }
  return c.json({items,request_count,skipped,ttl_ms:PROTOCOL_PROBE_TTL_MS});
});
async function readBounded(res:Response) {
  if(!res.body)throw Error("empty_body");const reader=res.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>65536)throw Error("oversized_body");parts.push(r.value);}const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}return JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes));}
  finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function validAnswer(endpoint:Endpoint,v:any):boolean {
  if(!v||v.error)return false;
  if(endpoint==="responses")return v.object==="response"&&["completed","incomplete"].includes(v.status)&&Array.isArray(v.output);
  if(endpoint==="messages")return v.type==="message"&&v.role==="assistant"&&Array.isArray(v.content);
  return v.object==="chat.completion"&&Array.isArray(v.choices)&&v.choices.length>0&&v.choices[0]?.message?.role==="assistant";
}
async function probe(wire:WireTarget):Promise<ProbeResult["results"][number]> {
  const {endpoint,model,headers,url}=wire;
  const start=Date.now(),controller=new AbortController();const timer=setTimeout(()=>controller.abort(),PROTOCOL_PROBE_TIMEOUT_MS);
  let status=0;let verdict: "supported"|"unsupported"|"unknown"="unknown",reason="network_error";
  try{
    const payload=endpoint==="responses"?{model,input:"Reply OK.",max_output_tokens:16,stream:false,store:false}:{model,messages:[{role:"user",content:"Reply OK."}],max_tokens:16,stream:false};
    const res=await fetch(url,{method:"POST",headers,body:JSON.stringify(payload),redirect:"manual",signal:controller.signal});status=res.status;
    if(status>=300&&status<400){void res.body?.cancel().catch(()=>{});return {endpoint,status:"unknown",http_status:status,latency_ms:Date.now()-start,reason:"redirect_rejected"};}
    let json:any;try{json=await readBounded(res);}catch{reason=controller.signal.aborted?"timeout":"invalid_or_oversized_body";return {endpoint,status:verdict,http_status:status,latency_ms:Date.now()-start,reason};}
    if(res.ok&&validAnswer(endpoint,json)){verdict="supported";reason="valid_response";}
    else {
      const code=typeof json?.error?.code==="string"?json.error.code.toLowerCase():"";
      if([400,404,405,422,501].includes(status)&&["unsupported_endpoint","endpoint_not_supported","unsupported_protocol","protocol_not_supported"].includes(code)){verdict="unsupported";reason="explicit_endpoint_rejection";}
      else reason=status===401||status===403?"authentication_or_permission":status===429?"rate_or_credit_limit":status>=500?"upstream_unavailable":res.ok?"invalid_protocol_shape":"inconclusive_rejection";
    }
  }catch{reason=controller.signal.aborted?"timeout":"network_error";}finally{clearTimeout(timer);controller.abort();}
  return {endpoint,status:verdict,http_status:status,latency_ms:Date.now()-start,reason};
}
protocolProbesApp.post("/run",async c=>{
  const b=await body(c);if(b.confirm_cost!==true||typeof b.model_id!=="string"||typeof b.fingerprint!=="string")return c.json({error:"cost_confirmation_required"},400);
  const t=await load(c.env,b.model_id);if(!t||t.fingerprint!==b.fingerprint)return c.json({error:"probe_target_changed"},409);
  let running=active.get(c.env.DB);if(!running){running=new Set();active.set(c.env.DB,running);}if(running.size>=2||running.has(t.fingerprint))return c.json({error:"probe_busy"},429);
  running.add(t.fingerprint);
  try{
    const results=[];for(const wire of t.wires)results.push(await probe(wire));
    const current=await load(c.env,b.model_id);if(!current||current.fingerprint!==t.fingerprint)return c.json({error:"probe_target_changed"},409);
    const checked_at=Date.now();const result:ProbeResult={fingerprint:t.fingerprint,checked_at,expires_at:checked_at+PROTOCOL_PROBE_TTL_MS,results};
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM settings WHERE key LIKE 'protocol_probe:%' AND updated_at < ?").bind(checked_at-7*PROTOCOL_PROBE_TTL_MS),
      c.env.DB.prepare("INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES(?,?,?)").bind(PREFIX+t.fingerprint,JSON.stringify(result),checked_at),
    ]);
    return c.json({result});
  }finally{running.delete(t.fingerprint);}
});
protocolProbesApp.post("/apply",async c=>{
  const b=await body(c);if(typeof b.model_id!=="string"||typeof b.fingerprint!=="string")return c.json({error:"invalid_target"},400);
  const t=await load(c.env,b.model_id);if(!t||t.fingerprint!==b.fingerprint)return c.json({error:"probe_target_changed"},409);
  if(locked(t))return c.json({error:"manual_protocol_config_locked"},409);
  const r=await saved(c.env,t.fingerprint);
  if(!r||r.expires_at<=Date.now()||r.results.length!==t.endpoints.length||t.endpoints.some(e=>!r.results.some(x=>x.endpoint===e))||r.results.some(x=>x.status==="unknown")||!r.results.some(x=>x.status==="supported"))return c.json({error:"probe_inconclusive_or_expired"},409);
  const pc={chat_completions:r.results.some(x=>x.endpoint==="chat/completions"&&x.status==="supported"),responses:r.results.some(x=>x.endpoint==="responses"&&x.status==="supported"),...(t.explicit||t.endpoints.includes("messages")?{messages:r.results.some(x=>x.endpoint==="messages"&&x.status==="supported")}:{}),chat_route:"auto",responses_route:"auto",loss_policy:"safe"};
  const updated=await c.env.DB.prepare("UPDATE models SET config_json=?,updated_at=? WHERE id=? AND config_json IS ? AND provider_id=? AND model_name=? AND enabled=1 AND EXISTS(SELECT 1 FROM providers p WHERE p.id=models.provider_id AND p.enabled=1 AND p.endpoint IS ? AND p.type=? AND p.api_key IS ? AND p.secret_name IS ? AND p.config_json IS ?)").bind(JSON.stringify({...t.config,protocol_capabilities:pc}),Date.now(),t.row.id,t.row.config_json,t.row.provider_id,t.row.model_name,t.row.provider_endpoint,t.row.provider_type,t.row.provider_api_key,t.row.provider_secret_name,t.row.provider_config_json??null).run();
  if(!updated.meta?.changes)return c.json({error:"probe_target_changed"},409);
  return c.json({ok:true,model_id:t.row.id,protocol_capabilities:pc});
});
