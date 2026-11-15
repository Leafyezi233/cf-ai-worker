import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { gatewayApp } from "../src/gateway";
import { adminApp } from "../src/admin";
import { pollVideoTasks, resetVideoReadLimits } from "../src/gateway/video";
import { BoundedWindow } from "../src/utils/boundedWindow";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { createRealD1, makeEnv, seedDevice, seedProvider, seedModel, wallet, holdRows, usageRows, TOKEN, DEVICE_ID, type RealD1 } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";
import { createVideoAttempt, prepareVideoAttemptForPost, canReleaseRejectedVideoAttempt } from "../../web/src/utils/videoTask";
const cfg={model_type:"video",video:{adapter:"moyuu",task_id_path:"data.task_id",sizes:["1920x1080"],failed_statuses:["FAILED"]}};
const input={model:"video-model",prompt:"river",seconds:5,size:"1920x1080"};
let db:RealD1,env:Env;
async function request(method="POST",body:unknown=input,key="video-key-0001",path="/video/generations") {
 return gatewayApp.request("https://gw.test"+path,{method,headers:{authorization:"Bearer "+TOKEN,"content-type":"application/json","Idempotency-Key":key},...(method==="POST"?{body:JSON.stringify(body)}:{})},env);
}
async function admin(path:string,body?:unknown,auth=true) {
 const cookie=buildSessionCookie(await signSession("test-admin-session",0)).split(";")[0];
 return adminApp.request("https://gw.test/video-tasks"+path,{method:body===undefined?"GET":"POST",headers:{...(auth?{cookie}:{}),"content-type":"application/json","cf-connecting-ip":"203.0.113.4"},...(body===undefined?{}:{body:JSON.stringify(body)})},env);
}
async function create(key="video-key-0001") {const r=await request("POST",input,key);expect(r.status).toBe(202);return await r.json() as any;}
function due(id:string) {db.sql("UPDATE video_tasks SET poll_after=0,poll_lease_until=NULL WHERE id=?",id);}
beforeEach(async()=>{resetVideoReadLimits();resetRateLimitMemory();db=createRealD1();env=makeEnv(db);env.ENCRYPTION_KEY="test-key";env.SESSION_SECRET="test-admin-session";env.ADMIN_SECRET="test-password";await seedDevice(db,{balance_usd:100});seedProvider(db,{endpoint:"https://video.test/v1"});seedModel(db,{model_name:input.model,billing_unit:"call",price_per_call:2,input_price_per_m:0,output_price_per_m:0,config_json:JSON.stringify(cfg)});});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();db.close();});
describe("video gateway safety regression",()=>{
 it("labels a definite validation rejection but not a prior submitted key",async()=>{
  const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({data:{task_id:"up"}}));
  const r=await request("POST",{...input,prompt:"x".repeat(8001)});expect(r.status).toBe(400);expect(await r.json()).toMatchObject({dispatch:"not_started"});expect(fetch).not.toHaveBeenCalled();
  await create();const bad=await request("POST",{...input,prompt:"x".repeat(8001)});expect(await bad.json()).not.toHaveProperty("dispatch");
  const conflict=await request("POST",{...input,seconds:6});expect(conflict.status).toBe(409);expect(await conflict.json()).not.toHaveProperty("dispatch");
 });
 it("keeps an uncertain key when a rejected retry races an earlier in-flight create",async()=>{
  db.sql("UPDATE devices SET rate_limit_rpm=1 WHERE id=?",DEVICE_ID);
  const fetcher=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({data:{task_id:"up"}}));
  let reached!:()=>void, release!:()=>void;
  const paused=new Promise<void>(resolve=>{reached=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const batch=env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB,"batch").mockImplementation(async(statements:any[])=>{
    if(statements.some(s=>s.sql?.startsWith("INSERT INTO video_tasks"))){reached();await gate;}
    return batch(statements);
  });
  const fresh=createVideoAttempt(input,()=>"same-racing-key");
  const uncertain=await prepareVideoAttemptForPost(fresh,async()=>{});
  const first=request("POST",input,fresh.key);await paused;
  try {
    const retry=await request("POST",input,fresh.key);expect(retry.status).toBe(429);
    expect(await retry.json()).toMatchObject({dispatch:"not_started"});
    expect(canReleaseRejectedVideoAttempt(uncertain,true)).toBe(false);
  } finally {release();}
  expect((await first).status).toBe(202);expect(fetcher).toHaveBeenCalledTimes(1);
  expect(holdRows(db)).toHaveLength(1);
 });
 it.each(["device","global"])("atomically budgets quote plus active video liability for %s",async kind=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({data:{task_id:"up"}}));
  if(kind==="device") db.sql("UPDATE devices SET cost_limit_monthly=3 WHERE id=?",DEVICE_ID);
  else db.sql("INSERT INTO settings (key,value_json,updated_at) VALUES ('budget_config',?,1)",JSON.stringify({monthly_budget_usd:3,budget_action:"block"}));
  const rs=await Promise.all([request("POST",input,"budget-key-0001"),request("POST",input,"budget-key-0002")]);expect(rs.map(r=>r.status).sort()).toEqual([202,429]);
  expect(wallet(db)?.reserved_usd).toBe(2);expect(holdRows(db)).toHaveLength(1);
 });
 it("uses existing UTC+8 monthly boundary instead of UTC calendar rollover",async()=>{
  vi.useFakeTimers();vi.setSystemTime(Date.UTC(2026,10,1,0));db.sql("UPDATE devices SET cost_limit_monthly=3 WHERE id=?",DEVICE_ID);
  db.sql("INSERT INTO usage (device_id,cost_usd,created_at) VALUES (?,2,?)",DEVICE_ID,Date.UTC(2026,9,31,17));
  const fetch=vi.spyOn(globalThis,"fetch");const r=await request();expect(r.status).toBe(429);expect(fetch).not.toHaveBeenCalled();
 });
 it("avoids claim writes and duplicate task read when not due",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({data:{task_id:"up"}}));const t=await create();const statements:string[]=[];const original=env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB,"prepare").mockImplementation((sql:string)=>{statements.push(sql);return original(sql);});
  expect((await request("GET",null,"ignored","/video/generations/"+t.id)).status).toBe(200);
  expect(statements.filter(x=>x.startsWith("SELECT * FROM video_tasks WHERE id"))).toHaveLength(1);expect(statements.some(x=>x.startsWith("UPDATE video_tasks"))).toBe(false);
 });
 it("backs off uncertain queries and exposes review without releasing wallet holds",async()=>{
  const m=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({data:{task_id:"up"}}));const t=await create();due(t.id);m.mockRejectedValue(Error("network"));
  const start=Date.now();let r=await (await request("GET",null,"ignored","/video/generations/"+t.id)).json() as any;expect(r.next_poll_at).toBeGreaterThanOrEqual(start+60_000);expect(r.status).toBe("pending");expect(wallet(db)?.reserved_usd).toBe(2);
  due(t.id);db.sql("UPDATE video_tasks SET poll_attempts=20 WHERE id=?",t.id);r=await (await request("GET",null,"ignored","/video/generations/"+t.id)).json() as any;expect(r.requires_review).toBe(true);expect(r.next_poll_at).toBeGreaterThan(Date.now()+800_000);
 });
 it("read quotas do not consume generation RPM and are shared across list/detail",async()=>{
  for(let i=0;i<120;i++) expect((await request("GET")).status).toBe(200);
  const limited=await request("GET",null,"ignored","/video/generations/nonexistent");expect(limited.status).toBe(429);expect(limited.headers.get("retry-after")).toBe("60");
  vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({data:{task_id:"up"}}));expect((await request()).status).toBe(202);
 });
 it.each(["throws","false","malformed","http"])("fails closed when authoritative read limiter %s",async mode=>{
  env.RATE_LIMITER={idFromName:(x:string)=>x,get:()=>({fetch:async()=>{if(mode==="throws")throw Error("offline");if(mode==="http")return Response.json({allowed:true},{status:503});return Response.json(mode==="false"?{allowed:false}:{});}})} as any;
  expect((await request("GET")).status).toBe(429);
 });
 it("cron processes over twenty fast tasks with concurrency bounded to four",async()=>{
  let active=0,max=0,gets=0;
  const m=vi.spyOn(globalThis,"fetch").mockImplementation(async(_u,init)=>{if(init?.method==="POST")return Response.json({data:{task_id:"up"}});active++;max=Math.max(max,active);gets++;await Promise.resolve();active--;return Response.json({status:"RUNNING"});});
  const t=await create();for(let i=0;i<39;i++) db.sql("INSERT INTO video_tasks (id,device_id,idempotency_key,request_hash,status,upstream_task_id,route_json,price_usd,pricing_snapshot_json,poll_after,created_at,updated_at) SELECT ?,device_id,?,request_hash,status,upstream_task_id,route_json,price_usd,pricing_snapshot_json,0,created_at,updated_at FROM video_tasks WHERE id=?","extra-"+i,"extra-key-"+i,t.id);due(t.id);
  await pollVideoTasks(env);expect(gets).toBe(40);expect(max).toBeLessThanOrEqual(4);expect(m).toHaveBeenCalledTimes(41);
 });
 it("cron ages at most 100 interrupted submissions without releasing holds",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({bad:"id"}));const t=await create();db.sql("UPDATE video_tasks SET status='submitting',created_at=1 WHERE id=?",t.id);
  for(let i=0;i<110;i++)db.sql("INSERT INTO video_tasks (id,device_id,idempotency_key,request_hash,status,route_json,price_usd,pricing_snapshot_json,created_at,updated_at) SELECT ?,device_id,?,request_hash,status,route_json,price_usd,pricing_snapshot_json,1,1 FROM video_tasks WHERE id=?","age-"+i,"age-key-"+i,t.id);
  await pollVideoTasks(env);expect(db.row<any>("SELECT COUNT(*) AS n FROM video_tasks WHERE status='submission_unknown'")?.n).toBe(100);expect(holdRows(db)).toHaveLength(1);
 });
});
describe("admin-only manual evidence reconciliation",()=>{
 it("requires real admin session; hides credentials and never sends POST",async()=>{
  const m=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("uncertain"));const t=await create();expect((await admin("/"+t.id,undefined,false)).status).toBe(401);
  const r=await admin("/"+t.id);expect(r.status).toBe(200);expect(JSON.stringify(await r.json())).not.toMatch(/route_json|credential|enc:v1/);expect(m).toHaveBeenCalledTimes(1);
 });
 it("attaches verified upstream ID, resumes polling, and forbids replacement",async()=>{
  const m=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("uncertain"));const t=await create();const attach={action:"attach",upstream_task_id:"confirmed-id",confirm_verified:true};
  expect((await admin("/"+t.id+"/reconcile",attach)).status).toBe(200);expect((await admin("/"+t.id+"/reconcile",{...attach,upstream_task_id:"other"})).status).toBe(409);
  m.mockResolvedValue(Response.json({status:"SUCCESS",result_url:"https://cdn.test/result.mp4"}));await pollVideoTasks(env);const r=await request("GET",null,"unused","/video/generations/"+t.id);expect((await r.json() as any).status).toBe("succeeded");expect(wallet(db)?.balance_usd).toBe(98);expect(db.row<any>("SELECT COUNT(*) AS n FROM audit_logs")?.n).toBe(1);
 });
 it("only explicit verified failure releases reserve with atomic zero usage and audit",async()=>{
  vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("uncertain"));const t=await create();const fail={action:"fail",note:"Operator verified upstream final failure",confirm_verified:true};
  expect((await admin("/"+t.id+"/reconcile",{...fail,confirm_verified:false})).status).toBe(400);expect(wallet(db)?.reserved_usd).toBe(2);
  expect((await admin("/"+t.id+"/reconcile",fail)).status).toBe(200);expect(wallet(db)).toMatchObject({balance_usd:100,reserved_usd:0});expect(usageRows(db)[0].cost_usd).toBe(0);
  expect((await admin("/"+t.id+"/reconcile",fail)).status).toBe(409);expect(db.row<any>("SELECT COUNT(*) AS n FROM audit_logs")?.n).toBe(1);
 });
 it.each([".",".."," x","bad\nline"])("rejects unsafe upstream ID %j",async id=>{expect((await admin("/missing/reconcile",{action:"attach",upstream_task_id:id,confirm_verified:true})).status).toBe(400);});
});
describe("bounded window capacity",()=>{
 it("rejects new keys rather than evicting a live limit, expires incrementally",()=>{const w=new BoundedWindow(2,3);expect(w.hit("a",1,1)).toBe(true);expect(w.hit("b",2,1)).toBe(true);expect(w.hit("c",1,1)).toBe(false);expect(w.hit("a",1,1)).toBe(false);expect(w.size).toBe(2);expect(w.hit("c",1,60_002)).toBe(true);expect(w.size).toBe(1);});
 it("bounds timestamp count independently of key count and supports rollback",()=>{const w=new BoundedWindow(10,2);expect(w.hit("a",100,1)).toBe(true);expect(w.hit("b",100,1)).toBe(true);expect(w.hit("a",100,1)).toBe(false);w.undo("b",1);expect(w.stamps).toBe(1);expect(w.hit("a",100,1)).toBe(true);expect(w.stamps).toBe(2);w.clear();expect(w.size).toBe(0);});
});
