import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { app } from "../src/index";
import { ensureSchema } from "../src/db/schema";
import { statsSummary, statsTrend, ensureWallet, aggregateDailyStats } from "../src/db/repo";
import { cleanupUsageDetails, verifyUsageRollups } from "../src/db/usage_rollups";
import { admitBillingRequest, beginBillingAttempt, observeBillingAttempt, persistBillingTerminal, settleBillingRequest } from "../src/db/request_billing";
import { createRealD1, DEVICE_ID, TOKEN, makeEnv, seedDevice, type RealD1 } from "./helpers/realGatewayEnv";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
const H=3600000;
const handles:RealD1[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const d of handles.splice(0))d.close();});
async function fixture(){const d=createRealD1();handles.push(d);const env=makeEnv(d);await ensureSchema(env);await seedDevice(d);return{d,env};}
function row(d:RealD1,id:string,time=H+20*60000,latency=10){
 d.sql("INSERT INTO usage(device_id,provider_id,model,input_tokens,output_tokens,total_tokens,cost_usd,request_id,created_at,latency_ms) VALUES(?, 'p','m',1,2,3,.25,?,?,?)",DEVICE_ID,id,time,latency);
 d.sql("INSERT INTO wallet_ledger(device_id,delta_usd,reason,request_id,created_at) VALUES(?,-.25,'usage',?,?)",DEVICE_ID,id,time);
}
function rawCount(d:RealD1){return d.row<{n:number}>("SELECT COUNT(*) n FROM usage")!.n;}
describe("retained usage maintenance race and replay safety",()=>{
 it("never erases the only legacy daily history proof during a scheduled rebuild",async()=>{
  const {d,env}=await fixture();row(d,"known",24*H);
  d.sql("INSERT INTO daily_stats(date,device_id,provider_id,model,request_count,input_tokens,output_tokens,total_tokens,cost_usd) VALUES('1970-01-02',?,'p','m',2,10,20,30,.5)",DEVICE_ID);
  const prior=d.rows("SELECT * FROM daily_stats");expect((await verifyUsageRollups(env)).status).toBe("history_missing");
  const trigger=d.row<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='usage_daily_rebuild_history_guard'")!.sql;
  const check=trigger.slice(trigger.indexOf("SELECT 1 FROM ("),trigger.indexOf("THEN RAISE"))
    .replace(/OLD\.date/g,"'1970-01-02'").replace(/OLD\.device_id/g,"'"+DEVICE_ID+"'")
    .replace(/OLD\.provider_id/g,"'p'").replace(/OLD\.model/g,"'m'")
    .replace(/OLD\.(request_count|input_tokens|output_tokens|total_tokens|cost_usd)/g,"2");
  const plan=d.rows<{detail:string}>("EXPLAIN QUERY PLAN "+check.trim().slice(0,-1)).map(r=>r.detail).join("\n");
  expect(plan).toContain("idx_usage_hourly_device");expect(plan).toContain("idx_usage_device_created");
  expect(plan).not.toMatch(/SCAN (?:h|u)\b/);
  await expect(aggregateDailyStats(env,"1970-01-02")).rejects.toThrow("usage_history_missing");
  expect(d.rows("SELECT * FROM daily_stats")).toEqual(prior);expect((await verifyUsageRollups(env)).status).toBe("history_missing");
 });

 it("replays the first committed result after a lost ACK instead of deleting the next page",async()=>{
  const {d,env}=await fixture();row(d,"one");row(d,"two",H+21*60000);
  const lost={...env,DB:{prepare:env.DB.prepare.bind(env.DB),batch:async(stmts:D1PreparedStatement[])=>{await env.DB.batch(stmts);throw Error("lost cleanup ACK");}}} as unknown as Env;
  const args={enabled:true,before:2*H,limit:1,operation_id:"lost-one"};
  await expect(cleanupUsageDetails(lost,args)).rejects.toThrow("lost cleanup ACK");expect(rawCount(d)).toBe(1);
  const result=await cleanupUsageDetails(env,args);expect(result).toMatchObject({deleted:1,scanned:1});expect(rawCount(d)).toBe(1);
  await expect(cleanupUsageDetails(env,{...args,limit:2})).rejects.toThrow("usage_cleanup_operation_conflict");
  expect((await cleanupUsageDetails(env,{...args,operation_id:"explicit-next"})).deleted).toBe(1);expect(rawCount(d)).toBe(0);
 });
 it("serializes the same operation key and freezes zero-candidate results too",async()=>{
  const {d,env}=await fixture();row(d,"one");row(d,"two",H+21*60000);const args={enabled:true,before:2*H,limit:1,operation_id:"parallel"};
  const [a,b]=await Promise.all([cleanupUsageDetails(env,args),cleanupUsageDetails(env,args)]);expect(a).toEqual(b);expect(a.deleted).toBe(1);expect(rawCount(d)).toBe(1);
  const empty={enabled:true,before:H,operation_id:"empty"};expect((await cleanupUsageDetails(env,empty)).scanned).toBe(0);row(d,"late",H-100);
  expect((await cleanupUsageDetails(env,empty)).scanned).toBe(0);expect(rawCount(d)).toBe(2);expect((await verifyUsageRollups(env)).ok).toBe(true);
 });
 it("rolls back cleanup claim and every raw deletion if durable result recording fails",async()=>{
  const {d,env}=await fixture();row(d,"one");d.sql("CREATE TRIGGER fault_cleanup_result BEFORE UPDATE ON usage_rollup_cleanup_operations BEGIN SELECT RAISE(ABORT,'fault result'); END");
  const args={enabled:true,before:2*H,operation_id:"rollback"};await expect(cleanupUsageDetails(env,args)).rejects.toThrow("fault result");expect(rawCount(d)).toBe(1);expect(d.rows("SELECT * FROM usage_rollup_cleanup_operations")).toEqual([]);expect(d.rows("SELECT * FROM usage_rollup_archived_hours")).toEqual([]);
  d.sql("DROP TRIGGER fault_cleanup_result");expect((await cleanupUsageDetails(env,args)).deleted).toBe(1);
 });
 it("preserves at least the latest hour and future raw rows even with a far future requested cutoff",async()=>{
  const {d,env}=await fixture();const now=Number(d.row<{t:number}>("SELECT CAST(strftime('%s','now') AS INTEGER)*1000 t")!.t);row(d,"old",H);row(d,"recent",now-10000);row(d,"future",now+H);
  const result=await cleanupUsageDetails(env,{enabled:true,before:Math.ceil((now+3*H)/H)*H});expect(result).toMatchObject({scanned:3,deleted:1});expect(d.rows("SELECT request_id FROM usage ORDER BY id")).toEqual([{request_id:"recent"},{request_id:"future"}]);
 });
 for(const fractional of [false,true])it("rejects cleanup racing between report validation and query (fractional timezone="+fractional+")",async()=>{
  const {d,env}=await fixture();row(d,"race");const original=env.DB.prepare.bind(env.DB);let injected=false;
  vi.spyOn(env.DB,"prepare").mockImplementation((sql:string)=>{const st=original(sql);if(!injected&&sql.includes("FROM (SELECT")&&(sql.includes("usage_hourly_rollups")||sql.includes("u.created_at,u.device_id"))){
   const key=fractional?"all":"first",read=st[key].bind(st);Object.assign(st,{[key]:async()=>{if(!injected){injected=true;await cleanupUsageDetails(env,{enabled:true,before:2*H});}return read();}});
  }return st;});
  await expect(fractional?statsTrend(env,0,"+330 minutes",330):statsSummary(env,H+15*60000)).rejects.toThrow("usage_history_granularity_required");expect(injected).toBe(true);expect(rawCount(d)).toBe(0);
 });
 it("preserves fractional weighted latency in actual authenticated console responses",async()=>{
  const {d,env}=await fixture();row(d,"latency-ten",H+1,10);row(d,"latency-eleven",H+2,11);resetRateLimitMemory();
  const response=await app.request("https://retention.test/console/usage?from=0&to="+(2*H-1),{headers:{authorization:"Bearer "+TOKEN}},env);expect(response.status).toBe(200);expect((await response.json() as any).summary.avg_latency_ms).toBe(10.5);
 });
 it("adds no request-side round trips while recording additional atomic rollup table mutations",async()=>{
  async function sample(rollups:boolean){const {d,env}=await fixture();await ensureWallet(env,DEVICE_ID,100);
   if(!rollups)for(const t of d.rows<{name:string}>("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'usage_%'"))d.sql('DROP TRIGGER "'+t.name+'"');
   const prepare=env.DB.prepare.bind(env.DB),batch=env.DB.batch.bind(env.DB);let inBatch=0,calls=0,statements=0;
   env.DB.prepare=((sql:string)=>{const st=prepare(sql);for(const k of ["first","all","run"] as const){const method=st[k].bind(st);Object.assign(st,{[k]:(...args:unknown[])=>{if(!inBatch){calls++;statements++;}return Reflect.apply(method,st,args);}});}return st;}) as typeof env.DB.prepare;
   env.DB.batch=(async(stmts:D1PreparedStatement[])=>{calls++;statements+=stmts.length;inBatch++;try{return await batch(stmts);}finally{inBatch--;}}) as typeof env.DB.batch;
   const before=d.row<{n:number}>("SELECT total_changes() n")!.n;
   expect(await admitBillingRequest(env,{request_id:"sample",device_id:DEVICE_ID,model:"m",pricing_snapshot_json:"{}",reserved_usd:1})).toBe(true);
   const id=await beginBillingAttempt(env,{request_id:"sample",provider_id:"p",model:"m",protocol:"chat/completions"});const usage={input_tokens:10,output_tokens:5,total_tokens:15};await observeBillingAttempt(env,id,{usage,usage_source:"reported_final"});
   const receipt=await persistBillingTerminal(env,{request_id:"sample",device_id:DEVICE_ID,provider_id:"p",provider_name:"P",model:"m",usage,cost_usd:.5,status_code:200,latency_ms:1,created_at:Date.now()});await settleBillingRequest(env,"sample",receipt);
   const changes=d.row<{n:number}>("SELECT total_changes() n")!.n-before;return {calls,statements,changes};}
  const baseline=await sample(false),rollups=await sample(true);expect(rollups.calls).toBe(baseline.calls);expect(rollups.statements).toBe(baseline.statements);expect(rollups.changes-baseline.changes).toBe(5);
  console.log("USAGE_ROLLUP_HOTPATH="+JSON.stringify({baseline,rollups,note:"local SQLite total_changes includes trigger table mutations, not index writes or billed D1 rows/Workers CPU"}));
 });
});
