import { describe,it,expect,vi } from "vitest";
import { makeWalletFixture } from "./helpers/walletFixture";
import { ensureWallet,checkDeviceRateLimit } from "../src/db/repo";
import { createRealD1,makeEnv,seedDevice,seedProvider,seedModel,DEVICE_ID,CollectingExecutionContext,postJson,chatBody } from "./helpers/realGatewayEnv";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { createMonthlyPlan,issueMonthlyPass,setMonthlyWalletFallback,renewMonthlyPass,stopMonthlyPass } from "../src/db/monthly_passes";
import { admitBillingRequest,beginBillingAttempt,observeBillingAttempt,persistBillingTerminal,settleBillingRequest,recoverBillingRequests } from "../src/db/request_billing";

const T=Date.UTC(2026,10,12,12);
const modes=["triggers-off","no-card","one-window","three-window","four-window","fallback"] as const;
type Mode=typeof modes[number];
async function fixture(mode:Mode,history=0){
 const f=await makeWalletFixture();await ensureWallet(f.env,"dev-1",1e6);await recoverBillingRequests(f.env,0);
 if(mode==="triggers-off")for(const name of ["monthly_pass_admit","monthly_pass_release","monthly_pass_settle"])f.d1.sql("DROP TRIGGER "+name);
 if(!["triggers-off","no-card"].includes(mode)){
  const plan=await createMonthlyPlan(f.env,{name:mode,enabled:1,limits:{daily_usd:mode==="fallback"?.01:1e6,weekly_usd:mode==="one-window"?null:1e6,five_hour_usd:mode==="one-window"?null:1e6,total_usd:mode==="four-window"?1e6:null},service_group_ids:null});
  await issueMonthlyPass(f.env,"dev-1",plan.id);if(mode==="fallback")await setMonthlyWalletFallback(f.env,"dev-1",true);
 }
 if(history)f.d1.sql("WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO monthly_pass_buckets(subscription_id,kind,starts_at,ends_at,limit_usd) SELECT 'historical','daily_usd',i,i+1,100 FROM n",history);
 return f;
}
async function cycle(f:Awaited<ReturnType<typeof fixture>>,id:string){
 expect(await admitBillingRequest(f.env,{request_id:id,device_id:"dev-1",model:"m",pricing_snapshot_json:"{}",reserved_usd:.1,monthly_service_group_ids:[null]})).toBe(true);
 const attempt=await beginBillingAttempt(f.env,{request_id:id,provider_id:"p",model:"m",protocol:"chat/completions"});
 const usage={input_tokens:10,output_tokens:5,total_tokens:15};await observeBillingAttempt(f.env,attempt,{usage,usage_source:"reported_final"});
 const receipt=await persistBillingTerminal(f.env,{request_id:id,device_id:"dev-1",provider_id:"p",provider_name:"P",model:"m",usage,cost_usd:.1,status_code:200,latency_ms:1,created_at:T});await settleBillingRequest(f.env,id,receipt);
}
const changes=(f:Awaited<ReturnType<typeof fixture>>)=>f.d1.row<{n:number}>("SELECT total_changes() n")!.n;
const percentile=(values:number[],q:number)=>[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*q)];
describe("monthly security/performance independent local audit",()=>{
 it.each(["monthly","fallback","no-card"] as const)("releases all holds immediately on an explicit-fallback RPM exit (%s) and remains idempotent",async payer=>{
  const d=createRealD1(),env=makeEnv(d);resetRateLimitMemory();vi.spyOn(Date,"now").mockReturnValue(T);
  try{
   await seedDevice(d,{balance_usd:payer==="monthly"?0:10});seedProvider(d);seedModel(d,{id:"backup",model_name:"backup"});seedModel(d,{fallback_model_id:"backup"});
   if(payer!=="no-card"){const plan=await createMonthlyPlan(env,{name:"lock",enabled:1,limits:{daily_usd:payer==="fallback"?0.000001:1,weekly_usd:null,five_hour_usd:null,total_usd:5},service_group_ids:null});await issueMonthlyPass(env,DEVICE_ID,plan.id);if(payer==="fallback")await setMonthlyWalletFallback(env,DEVICE_ID,true);}
   d.sql("INSERT INTO device_models(device_id,model_id,rpm) VALUES(?,?,1)",DEVICE_ID,"backup");
   await checkDeviceRateLimit(env,DEVICE_ID+"::model::backup",1);
   const fetch=vi.spyOn(globalThis,"fetch").mockImplementation(async()=>new Response("busy",{status:503}));
   const exec=new CollectingExecutionContext(),response=await postJson(env,"/chat/completions",chatBody(),exec);const text=await response.text();await Promise.all(exec.pending);
   expect(response.status,text).toBe(429);expect(fetch).toHaveBeenCalledTimes(1);
   expect(d.rows("SELECT * FROM reserve_holds")).toEqual([]);
   expect(d.row("SELECT balance_usd,reserved_usd FROM device_wallets WHERE device_id=?",DEVICE_ID)).toEqual({balance_usd:payer==="monthly"?0:10,reserved_usd:0});
   const buckets=d.rows<{reserved_usd:number;used_usd:number}>("SELECT reserved_usd,used_usd FROM monthly_pass_buckets");expect(buckets.length).toBe(payer==="monthly"?2:0);expect(buckets.every(b=>b.reserved_usd===0&&b.used_usd===0)).toBe(true);
   expect(d.row("SELECT billing_state,hold_released_at FROM billing_requests")).toEqual({billing_state:"settled",hold_released_at:T});
   expect(await recoverBillingRequests(env)).toEqual({settled:0,expired:0});
   const request=d.row<{request_id:string}>("SELECT request_id FROM billing_requests")!;await settleBillingRequest(env,request.request_id);
   expect(d.rows<{reserved_usd:number;used_usd:number}>("SELECT reserved_usd,used_usd FROM monthly_pass_buckets")).toEqual(buckets);
  }finally{vi.restoreAllMocks();resetRateLimitMemory();d.close();}
 });
  it("replaying the same renewal operation extends once and returns the original result",async()=>{
   vi.spyOn(Date,"now").mockReturnValue(T);
   try{const f=await fixture("one-window");const old=f.d1.row<{id:string;expires_at:number}>("SELECT id,expires_at FROM monthly_pass_subscriptions")!;
    const operation={operation_id:"audit-renew-replay",actor_scope:"admin:session"};
    const first=await renewMonthlyPass(f.env,old.id,operation);const replay=await renewMonthlyPass(f.env,old.id,operation);expect(replay).toEqual(first);
    expect(f.d1.row<{expires_at:number}>("SELECT expires_at FROM monthly_pass_subscriptions WHERE id=?",old.id)!.expires_at-old.expires_at).toBe(30*86400000);
   }finally{vi.restoreAllMocks();}
  });
  it("rejects renewal if another issuance replaces the pointer before the atomic operation",async()=>{
   vi.spyOn(Date,"now").mockReturnValue(T);
   try{const f=await fixture("one-window");const old=f.d1.row<{id:string;expires_at:number;plan_id:string}>("SELECT id,expires_at,plan_id FROM monthly_pass_subscriptions")!;
    await stopMonthlyPass(f.env,old.id);const batch=f.env.DB.batch.bind(f.env.DB);let replacement="", injected=false;
    f.env.DB.batch=(async(statements: D1PreparedStatement[])=>{if(!injected){injected=true;replacement=(await issueMonthlyPass(f.env,"dev-1",old.plan_id)).id;}return batch(statements);}) as typeof f.env.DB.batch;
    await expect(renewMonthlyPass(f.env,old.id,{operation_id:"audit-pointer-race",actor_scope:"admin:session"})).rejects.toThrow("monthly_subscription_not_current");
    expect(f.d1.row<{expires_at:number}>("SELECT expires_at FROM monthly_pass_subscriptions WHERE id=?",old.id)!.expires_at).toBe(old.expires_at);
    expect(f.d1.row<{subscription_id:string}>("SELECT subscription_id FROM monthly_pass_accounts")!.subscription_id).toBe(replacement);
   }finally{vi.restoreAllMocks();}
  });
 it("measures internal trigger mutations and warm fixed-lifecycle latency without pretending local time is Workers CPU",async()=>{
  vi.spyOn(Date,"now").mockReturnValue(T);
  try{
   const rows:Record<string,unknown>[]=[];
   for(const history of [0,100000])for(const mode of modes){
    const f=await fixture(mode,history),before=changes(f);await cycle(f,"first");const first=changes(f)-before;
    for(let i=0;i<15;i++)await cycle(f,"warm-"+i);
    const samples:number[]=[],writes:number[]=[];
    for(let i=0;i<120;i++){const w=changes(f),start=performance.now();await cycle(f,"sample-"+i);samples.push(performance.now()-start);writes.push(changes(f)-w);}
    const k=mode==="one-window"?1:mode==="three-window"?3:mode==="four-window"?4:0;
    expect(new Set(writes).size).toBe(1);
    rows.push({mode,history,samples:samples.length,firstTableMutations:first,steadyTableMutations:writes[0],p50Ms:percentile(samples,.5),p95Ms:percentile(samples,.95),newRequestFundingRows:mode==="no-card"||mode==="triggers-off"?0:1,newRequestBucketRows:k});
   }
   const report={producer:"local-benchmark",environment:"Windows bundled Node24.21.0 real SQLite in-memory; wall time incl JS/driver, not production Workers CPU/D1 latency",seedTime:T,rows};
   console.log("MONTHLY_AUDIT_REPORT="+JSON.stringify(report));
  }finally{vi.restoreAllMocks();}
 },120000);
});
