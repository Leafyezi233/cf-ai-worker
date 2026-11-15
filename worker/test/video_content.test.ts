import { Hono } from "hono";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { Env } from "../src/types";
import { ensureSchema } from "../src/db/schema";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { sealSecret, sha256Hex } from "../src/utils/crypto";
import { signVideoTicket, verifyVideoTicket } from "../src/gateway/video_tickets";
import { videoContentHandler, videoContentTicketHandler, resetVideoContentLimits, VIDEO_CONTENT_LIMITS } from "../src/gateway/video_content";

const app=new Hono<{Bindings:Env}>();
app.get("/v1/video/generations/:id/content",videoContentHandler);
app.post("/v1/video/generations/:id/content-ticket",videoContentTicketHandler);
const path="/v1/video/generations/vid_1/content";
const mp4=new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]);
let db:RealD1, env:Env, route:Record<string,unknown>;
const responses:Response[]=[];
async function request(url=path,token:string|null="master",init:RequestInit={}) {
 const r=await app.request("https://gateway.test"+url,{...init,headers:{...(token?{authorization:"Bearer "+token}:{}),...init.headers}},env);
 responses.push(r);return r;
}
function upstream(body:BodyInit=mp4,headers:Record<string,string>={},status=200) {return new Response(body,{status,headers:{"content-type":"video/mp4",...headers}});}
async function seedDevice(id:string,token:string) {db.sql("INSERT INTO devices (id,name,token_hash,enabled,created_at) VALUES (?,?,?,1,1)",id,id,await sha256Hex(token));}
async function seedSub(id:string,token=id) {db.sql("INSERT INTO device_sub_tokens (id,device_id,name,token_hash,enabled,created_at) VALUES (?,'dev_1',?,?,1,1)",id,id,await sha256Hex(token));}
function setRoute(over:Record<string,unknown>) {db.sql("UPDATE video_tasks SET route_json=? WHERE id='vid_1'",JSON.stringify({...route,...over}));}
async function ticket(token="master") {const r=await request(path+"-ticket",token,{method:"POST"});expect(r.status).toBe(200);return await r.json() as {url:string;expires_at:number};}
beforeEach(async()=>{
 resetVideoContentLimits();db=createRealD1();env={DB:db.DB,ENCRYPTION_KEY:"content-test-key"} as Env;await ensureSchema(env);
 await seedDevice("dev_1","master");await seedDevice("dev_other","other");await seedSub("sub_a");await seedSub("sub_b");
 route={endpoint:"https://moyuu.test/channel/v1/video/generations",credential:await sealSecret("upstream-secret",env.ENCRYPTION_KEY),video:{adapter:"moyuu"}};
 db.sql("INSERT INTO video_tasks (id,device_id,sub_token_id,idempotency_key,request_hash,status,upstream_task_id,route_json,price_usd,pricing_snapshot_json,result_url,created_at,updated_at) VALUES ('vid_1','dev_1','sub_a','key-1','hash','succeeded','task_safe',?,1,'{}','https://never-fetch.test/arbitrary',1,1)",JSON.stringify(route));
});
afterEach(async()=>{for(const r of responses.splice(0)) {try{await r.body?.cancel();}catch{}}vi.restoreAllMocks();vi.useRealTimers();db.close();});

describe("video content ownership and encrypted tickets",()=>{
 it("requires header auth, denies cross-account and sibling subtoken; master may read a sub task",async()=>{
  const f=vi.spyOn(globalThis,"fetch").mockImplementation(async()=>upstream());
  expect((await request(path,null)).status).toBe(401);
  expect((await request(path+"?token=master",null)).status).toBe(401);
  expect((await request(path,"other")).status).toBe(404);expect((await request(path,"sub_b")).status).toBe(404);
  for(const token of ["master","sub_a"]) {const r=await request(path,token);expect(r.status).toBe(200);expect(new Uint8Array(await r.arrayBuffer())).toEqual(mp4);}
  expect(f).toHaveBeenCalledTimes(2);
 });
 it.each(["failed","pending","submission_unknown","submitting"])("does not grant content to %s or manually waived tasks",async status=>{
  const f=vi.spyOn(globalThis,"fetch");db.sql("UPDATE video_tasks SET status=?,error_code='manual_waived'",status);
  expect((await request()).status).toBe(409);expect((await request(path+"-ticket","master",{method:"POST"})).status).toBe(409);expect(f).not.toHaveBeenCalled();
 });
 it("issues only a same-site URL, encrypts owner/task, grants GET only, and checks live eligibility",async()=>{
  const f=vi.spyOn(globalThis,"fetch").mockImplementation(async()=>upstream());const t=await ticket("sub_a");
  expect(t.url.startsWith(path+"?ticket=")).toBe(true);expect(t.expires_at-Date.now()).toBeLessThanOrEqual(300_000);
  expect(t.url).not.toMatch(/master|sub_a|upstream-secret|moyuu|task_safe/);
  const r=await request(t.url,null);expect(r.status).toBe(200);await r.arrayBuffer();
  expect((await request(t.url.replace("/content?","/content-ticket?"),null,{method:"POST"})).status).toBe(401);
  db.sql("UPDATE video_tasks SET status='failed',error_code='manual_waived'");expect((await request(t.url,null)).status).toBe(409);expect(f).toHaveBeenCalledTimes(1);
 });
 it.each(["sub-disable","sub-revoke","account-disable","account-revoke"])("rechecks %s on each ticket use",async kind=>{
  const t=await ticket("sub_a");
  if(kind==="sub-disable")db.sql("UPDATE device_sub_tokens SET enabled=0 WHERE id='sub_a'");
  if(kind==="sub-revoke")db.sql("UPDATE device_sub_tokens SET revoked_at=1 WHERE id='sub_a'");
  if(kind==="account-disable")db.sql("UPDATE devices SET enabled=0 WHERE id='dev_1'");
  if(kind==="account-revoke")db.sql("UPDATE devices SET revoked_at=1 WHERE id='dev_1'");
  const f=vi.spyOn(globalThis,"fetch");expect((await request(t.url,null)).status).toBe(401);expect(f).not.toHaveBeenCalled();
 });
 it("rejects tampering, wrong task/purpose, duplicates, plaintext, expiration and missing/rotated secret",async()=>{
  const t=await ticket();const value=new URL("https://gw.test"+t.url).searchParams.get("ticket")!;
  expect(await verifyVideoTicket(env,value,"video","vid_other")).toBeNull();expect(await verifyVideoTicket(env,value,"reference","vid_1")).toBeNull();
  expect(await verifyVideoTicket(env,value.slice(0,-8)+"abcdefgh","video","vid_1")).toBeNull();
  expect(await verifyVideoTicket(env,JSON.stringify({kind:"video",id:"vid_1"}),"video","vid_1")).toBeNull();
  expect((await request(t.url+"&ticket="+encodeURIComponent(value),null)).status).toBe(401);
  env.ENCRYPTION_KEY="rotated";expect(await verifyVideoTicket(env,value,"video","vid_1")).toBeNull();
  env.ENCRYPTION_KEY="";expect((await request(path+"-ticket","master",{method:"POST"})).status).toBe(503);
  env.ENCRYPTION_KEY="content-test-key";vi.useFakeTimers();vi.advanceTimersByTime(300_001);expect(await verifyVideoTicket(env,value,"video","vid_1")).toBeNull();
 });
 it("shares purpose-bound reference TTL up to seven days and fails closed on excessive TTL",async()=>{
  const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now);
  const payload={kind:"reference" as const,id:"asset_1",device_id:"dev_1",sub_token_id:"sub_a",expires_at:now+7*24*60*60_000};
  const t=await signVideoTicket(env,payload);expect(await verifyVideoTicket(env,t,"reference","asset_1")).toEqual(payload);
  await expect(signVideoTicket(env,{...payload,expires_at:now+7*24*60*60_000+1})).rejects.toThrow("content_ticket_unavailable");
  const video={...payload,kind:"video" as const,expires_at:now+300_000};
  expect(await verifyVideoTicket(env,await signVideoTicket(env,video),"video","asset_1")).toEqual(video);
  await expect(signVideoTicket(env,{...video,expires_at:now+300_001})).rejects.toThrow("content_ticket_unavailable");
 });
});

describe("frozen Moyuu source and sanitization",()=>{
 it("uses only constructed frozen same-origin path, own headers, no generation or billing writes",async()=>{
  const before=db.rows("SELECT * FROM video_tasks");const f=vi.spyOn(globalThis,"fetch").mockImplementation(async()=>upstream(mp4,{"content-length":"16","set-cookie":"s=secret","location":"https://leak.test/","server":"moyuu","content-disposition":"attachment; filename=upstream-secret","etag":"upstream-id","content-range":"bytes 0-15/16","accept-ranges":"none"}));
  const r=await request(path,"master",{headers:{"x-api-key":"do-not-forward","cookie":"private","referer":"https://client.test/","cf-connecting-ip":"192.0.2.1"}});
  expect(r.status).toBe(200);expect(new Uint8Array(await r.arrayBuffer())).toEqual(mp4);
  const [url,init]=f.mock.calls[0];expect(url).toBe("https://moyuu.test/channel/v1/videos/task_safe/content");expect(init?.method).toBe("GET");expect(init?.redirect).toBe("manual");
  expect(init?.headers).toEqual({authorization:"Bearer upstream-secret",accept:"video/mp4","accept-encoding":"identity"});
  expect(Object.fromEntries(r.headers)).toEqual({"content-type":"video/mp4","content-length":"16","content-disposition":'inline; filename="vid_1.mp4"',"accept-ranges":"none","cache-control":"private, no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff"});
  expect(db.rows("SELECT * FROM video_tasks")).toEqual(before);expect(db.rows("SELECT * FROM usage")).toHaveLength(0);expect(db.rows("SELECT * FROM reserve_holds")).toHaveLength(0);expect(f).toHaveBeenCalledTimes(1);
 });
 it.each(["http://moyuu.test/v1/video/generations","https://user:pw@moyuu.test/v1/video/generations","https://moyuu.test/v1/video/generations?key=secret","https://moyuu.test/v1/video/generations#hash","https://127.0.0.1/v1/video/generations","https://10.1.2.3/v1/video/generations","https://[::1]/v1/video/generations","https://2130706433/v1/video/generations","https://localhost/v1/video/generations","https://foo.localhost/v1/video/generations","https://moyuu.test/v1/../video/generations","https://moyuu.test/v1/%2e%2e/video/generations","https://moyuu.test/v1/videos", "https://moyuu.test:8443/v1/video/generations"])("rejects unsafe source %s before fetch",async endpoint=>{setRoute({endpoint});const f=vi.spyOn(globalThis,"fetch");expect((await request()).status).toBe(409);expect(f).not.toHaveBeenCalled();});
 it("rejects non-Moyuu adapter, plaintext credentials, unsafe upstream id and missing/unsafe result",async()=>{
  const f=vi.spyOn(globalThis,"fetch");
  for(const over of [{video:{adapter:"openai"}},{credential:"plaintext"}]) {setRoute(over);expect((await request()).status).toBe(409);}
  setRoute({});db.sql("UPDATE video_tasks SET upstream_task_id='../evil'");expect((await request()).status).toBe(409);
  db.sql("UPDATE video_tasks SET upstream_task_id='task_safe',result_url='http://unsafe.test/'");expect((await request()).status).toBe(409);expect(f).not.toHaveBeenCalled();
 });
 it.each([401,302,307,403,500])("hides upstream %s body/URL and cancels reader",async status=>{
  const cancel=vi.fn();const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode("secret https://leak.test/ upstream-secret"));},cancel},{highWaterMark:0});
  const f=vi.spyOn(globalThis,"fetch").mockResolvedValue(upstream(body,{location:"https://leak.test/"},status));
  const r=await request();expect(r.status).toBe(502);expect(await r.text()).toBe('{"error":"video_content_upstream_error"}');expect(r.headers.has("location")).toBe(false);expect(cancel).toHaveBeenCalledTimes(1);expect(f).toHaveBeenCalledTimes(1);
 });
 it.each(["text/html","application/json","application/octet-stream","video/mp4; charset=utf-8"])("rejects unapproved MIME %s",async type=>{vi.spyOn(globalThis,"fetch").mockResolvedValue(upstream(mp4,{"content-type":type}));expect((await request()).status).toBe(502);});
 it("rejects mislabeled full HTML/JSON and encoded bodies",async()=>{
  const f=vi.spyOn(globalThis,"fetch");for(const body of ["<html>upstream-secret</html>",'{"message":"upstream-secret"}']) {f.mockResolvedValue(upstream(body));expect((await request()).status).toBe(502);}
  f.mockResolvedValue(upstream(mp4,{"content-encoding":"gzip"}));expect((await request()).status).toBe(502);
 });
});

describe("real range semantics and bounded streaming",()=>{
 it.each(["bytes=0-1,3-4","bytes=4-2","bytes=-0","bytes=","items=0-1","bytes=9007199254740993-","bytes=0-999999999","bytes="+"0".repeat(129)+"-1"])("rejects invalid/oversize range %s",async range=>{const f=vi.spyOn(globalThis,"fetch");expect((await request(path,"master",{headers:{range}})).status).toBe(416);expect(f).not.toHaveBeenCalled();});
 it("forwards valid range but keeps ignored range200 as200 without invented metadata",async()=>{
  const f=vi.spyOn(globalThis,"fetch").mockResolvedValue(upstream(mp4,{"content-length":"16","accept-ranges":"bytes"}));
  const r=await request(path,"master",{headers:{range:"bytes=0-"}});expect(r.status).toBe(200);await r.arrayBuffer();expect(r.headers.has("content-range")).toBe(false);expect(r.headers.has("accept-ranges")).toBe(false);expect((f.mock.calls[0][1]?.headers as Record<string,string>).range).toBe("bytes=0-");
 });
 it.each([["bytes=4-7","bytes 4-7/16"],["bytes=-4","bytes 12-15/16"],["bytes=12-","bytes 12-15/16"]])("preserves genuine206 %s",async(range,contentRange)=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(upstream(new Uint8Array([1,2,3,4]),{"content-length":"4","content-range":contentRange},206));
  const r=await request(path,"master",{headers:{range}});expect(r.status).toBe(206);expect(r.headers.get("content-range")).toBe(contentRange);expect(r.headers.get("accept-ranges")).toBe("bytes");expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([1,2,3,4]));
 });
 it.each(["bytes 4-8/16","bytes 5-8/16","bytes 4-7/*","bytes 4-7/7","garbage"])("rejects mismatched206 %s",async contentRange=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(upstream(new Uint8Array([1,2,3,4]),{"content-length":"4","content-range":contentRange},206));expect((await request(path,"master",{headers:{range:"bytes=4-7"}})).status).toBe(502);
 });
 it("rejects unsolicited206 and advertised oversize or malformed lengths",async()=>{
  const f=vi.spyOn(globalThis,"fetch").mockResolvedValue(upstream(mp4,{"content-range":"bytes 0-15/16"},206));expect((await request()).status).toBe(502);
  for(const length of ["999999999","-1","1.5","oops"]) {f.mockResolvedValue(upstream(mp4,{"content-length":length}));expect((await request()).status).toBe(502);}
 });
 it("pulls only bounded signature before consumption and directly cancels upstream on consumer cancel",async()=>{
  let pulls=0;const cancel=vi.fn();let signal:AbortSignal|undefined;
  vi.spyOn(globalThis,"fetch").mockImplementation(async(_url,init)=>{signal=init?.signal as AbortSignal;return upstream(new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(pulls===1?mp4:new Uint8Array(1024));},cancel},{highWaterMark:0}));});
  const r=await request();expect(r.status).toBe(200);expect(pulls).toBe(1);
  const reader=r.body!.getReader();await reader.read();expect(pulls).toBe(1);await reader.read();expect(pulls).toBe(2);await reader.cancel();reader.releaseLock();expect(cancel).toHaveBeenCalledTimes(1);expect(signal?.aborted).toBe(true);
 });
 it("propagates client abort to pending direct reader and releases concurrency slots",async()=>{
  const cancel=vi.fn();let signal:AbortSignal|undefined;
  vi.spyOn(globalThis,"fetch").mockImplementation(async(_url,init)=>{signal=init?.signal as AbortSignal;return upstream(new ReadableStream<Uint8Array>({start(c){c.enqueue(mp4);},cancel},{highWaterMark:0}));});
  const ac=new AbortController();const r=await request(path,"master",{signal:ac.signal});const reader=r.body!.getReader();await reader.read();const pending=reader.read();const rejected=expect(pending).rejects.toThrow("video_content_interrupted");ac.abort();await rejected;reader.releaseLock();expect(signal?.aborted).toBe(true);expect(cancel).toHaveBeenCalledTimes(1);
  const next=await request();expect(next.status).toBe(200);await next.body!.cancel();
 });
 it("bounds per-account concurrency and releases on cancellation",async()=>{
  vi.spyOn(globalThis,"fetch").mockImplementation(async()=>upstream(new ReadableStream<Uint8Array>({start(c){c.enqueue(mp4);}},{highWaterMark:0})));
  const a=await request(),b=await request();expect(a.status).toBe(200);expect(b.status).toBe(200);expect((await request()).status).toBe(429);await a.body!.cancel();const c=await request();expect(c.status).toBe(200);await b.body!.cancel();await c.body!.cancel();
 });
 it("bounds all active accounts to sixteen streams and releases every slot",async()=>{
  vi.spyOn(globalThis,"fetch").mockImplementation(async()=>upstream(new ReadableStream<Uint8Array>({start(c){c.enqueue(mp4);}},{highWaterMark:0})));
  const opened:Response[]=[];
  for(let i=0;i<17;i++) {
   await seedDevice("parallel_"+i,"parallel_"+i);
   db.sql("INSERT INTO video_tasks (id,device_id,sub_token_id,idempotency_key,request_hash,status,upstream_task_id,route_json,price_usd,pricing_snapshot_json,result_url,created_at,updated_at) SELECT ?,?,NULL,?,request_hash,status,upstream_task_id,route_json,price_usd,pricing_snapshot_json,result_url,created_at,updated_at FROM video_tasks WHERE id='vid_1'","parallel_task_"+i,"parallel_"+i,"parallel_key_"+i);
   const r=await request("/v1/video/generations/parallel_task_"+i+"/content","parallel_"+i);
   expect(r.status).toBe(i<16?200:429);if(i<16)opened.push(r);
  }
  await Promise.all(opened.map(r=>r.body!.cancel()));const retry=await request("/v1/video/generations/parallel_task_16/content","parallel_16");expect(retry.status).toBe(200);await retry.body!.cancel();
 });
 it("enforces an independent request quota without task writes",async()=>{
  const f=vi.spyOn(globalThis,"fetch").mockImplementation(async()=>upstream());for(let i=0;i<30;i++) {const r=await request();expect(r.status).toBe(200);await r.arrayBuffer();}
  const r=await request();expect(r.status).toBe(429);expect(r.headers.get("retry-after")).toBe("60");expect(f).toHaveBeenCalledTimes(30);expect(db.rows("SELECT * FROM usage")).toHaveLength(0);
 });
 it("fails closed when authoritative download limiter fails",async()=>{
  env.RATE_LIMITER={idFromName:(s:string)=>s,get:()=>({fetch:async()=>Response.json({allowed:false})})} as unknown as DurableObjectNamespace;
  const f=vi.spyOn(globalThis,"fetch");expect((await request()).status).toBe(429);expect(f).not.toHaveBeenCalled();
 });
 it("idle/deadline cleanup cancels stalled upstream and leaves no timers",async()=>{
  vi.useFakeTimers();const cancel=vi.fn();vi.spyOn(globalThis,"fetch").mockImplementation(async()=>upstream(new ReadableStream<Uint8Array>({start(c){c.enqueue(mp4);},cancel},{highWaterMark:0})));
  const r=await request();const reader=r.body!.getReader();await reader.read();const pending=reader.read();const rejection=expect(pending).rejects.toThrow("video_content_interrupted");await vi.advanceTimersByTimeAsync(VIDEO_CONTENT_LIMITS.idleMs+1);await rejection;reader.releaseLock();expect(cancel).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
 it("enforces total deadline despite continuing upstream progress",async()=>{
  vi.useFakeTimers();const cancel=vi.fn();let i=0;
  vi.spyOn(globalThis,"fetch").mockImplementation(async()=>upstream(new ReadableStream<Uint8Array>({pull(c){c.enqueue(i++===0?mp4:new Uint8Array(1024));},cancel},{highWaterMark:0})));
  const r=await request();const reader=r.body!.getReader();await reader.read();
  for(let i=0;i<8;i++){await vi.advanceTimersByTimeAsync(14_000);expect((await reader.read()).done).toBe(false);}
  await vi.advanceTimersByTimeAsync(8001);await expect(reader.read()).rejects.toThrow("video_content_interrupted");reader.releaseLock();expect(cancel).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
 it("rejects endless empty chunks without resetting byte bounds indefinitely",async()=>{
  let i=0;const cancel=vi.fn();vi.spyOn(globalThis,"fetch").mockImplementation(async()=>upstream(new ReadableStream<Uint8Array>({pull(c){c.enqueue(i++===0?mp4:new Uint8Array());},cancel},{highWaterMark:0})));
  const r=await request();await expect(r.arrayBuffer()).rejects.toThrow("video_content_interrupted");expect(cancel).toHaveBeenCalledTimes(1);expect(i).toBeLessThan(20);
 });
 it("errors on early EOF rather than returning a successful truncated declared length",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(upstream(mp4,{"content-length":"20"}));const r=await request();expect(r.status).toBe(200);await expect(r.arrayBuffer()).rejects.toThrow("video_content_interrupted");
 });
 it("bounds connection timeout even when fetch ignores abort and cancels late response",async()=>{
  vi.useFakeTimers();let resolve!:(r:Response)=>void, signal:AbortSignal|undefined;
  let signalStarted!:()=>void;const started=new Promise<void>(r=>{signalStarted=r;});vi.spyOn(globalThis,"fetch").mockImplementation(async(_url,init)=>{signal=init?.signal as AbortSignal;signalStarted();return new Promise<Response>(r=>{resolve=r;});});
  const pending=request();await started;await vi.advanceTimersByTimeAsync(VIDEO_CONTENT_LIMITS.headerMs+1);expect((await pending).status).toBe(502);expect(signal?.aborted).toBe(true);
  const cancel=vi.fn();resolve(upstream(new ReadableStream<Uint8Array>({cancel},{highWaterMark:0})));await Promise.resolve();await Promise.resolve();expect(cancel).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
 it("retains two timed-out fetch slots through late bodies and stalled cancellation",async()=>{
  vi.useFakeTimers();const finishes:((r:Response)=>void)[]=[],acks:(()=>void)[]=[];
  let notify!:()=>void;const started=new Promise<void>(resolve=>{notify=resolve;});
  const f=vi.spyOn(globalThis,"fetch").mockImplementation(()=>new Promise<Response>(resolve=>{finishes.push(resolve);if(finishes.length===2)notify();}));
  const first=request(),second=request();await started;await vi.advanceTimersByTimeAsync(VIDEO_CONTENT_LIMITS.headerMs+1);
  expect((await first).status).toBe(502);expect((await second).status).toBe(502);
  expect((await request()).status).toBe(429);expect(f).toHaveBeenCalledTimes(2);
  for(const done of finishes)done(upstream(new ReadableStream<Uint8Array>({cancel(){return new Promise<void>(yes=>{acks.push(yes);});}},{highWaterMark:0})));
  for(let i=0;i<12;i++)await Promise.resolve();expect(acks).toHaveLength(2);
  expect((await request()).status).toBe(429);expect(f).toHaveBeenCalledTimes(2);
  for(const ack of acks)ack();for(let i=0;i<12;i++)await Promise.resolve();
  f.mockResolvedValue(upstream());const retry=await request();expect(retry.status).toBe(200);await retry.arrayBuffer();expect(vi.getTimerCount()).toBe(0);
 });
 it("errors rather than silently truncating mismatched or oversized chunks",async()=>{
  const cancel=vi.fn();let i=0;vi.spyOn(globalThis,"fetch").mockImplementation(async()=>upstream(new ReadableStream<Uint8Array>({pull(c){if(i++===0)c.enqueue(mp4);else c.enqueue(new Uint8Array(VIDEO_CONTENT_LIMITS.maxChunkBytes+1));},cancel},{highWaterMark:0})));
  const r=await request();await expect(r.arrayBuffer()).rejects.toThrow("video_content_interrupted");expect(cancel).toHaveBeenCalledTimes(1);
 });
});
