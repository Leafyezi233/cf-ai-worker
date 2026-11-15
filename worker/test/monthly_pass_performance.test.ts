import { describe,expect,it } from "vitest";
import type { Env } from "../src/types";
import { ensureWallet } from "../src/db/repo";
import { createMonthlyPlan,issueMonthlyPass,setMonthlyWalletFallback } from "../src/db/monthly_passes";
import { admitBillingRequest,beginBillingAttempt,observeBillingAttempt,persistBillingTerminal,settleBillingRequest,recoverBillingRequests } from "../src/db/request_billing";
import { makeWalletFixture } from "./helpers/walletFixture";
function countCalls(env:Env){
 const prepare=env.DB.prepare.bind(env.DB),batch=env.DB.batch.bind(env.DB);let batching=0;
 const calls:{kind:string;statements:number}[]=[];
 env.DB.prepare=((sql:string)=>{const st=prepare(sql);for(const key of ["first","all","run"] as const){const method=st[key].bind(st);Object.assign(st,{[key]:(...args:unknown[])=>{if(!batching)calls.push({kind:key,statements:1});return Reflect.apply(method,st,args);}});}return st;}) as typeof env.DB.prepare;
 env.DB.batch=(async (statements:D1PreparedStatement[])=>{calls.push({kind:"batch",statements:statements.length});batching++;try{return await batch(statements);}finally{batching--;}}) as typeof env.DB.batch;
 return{calls,restore(){env.DB.prepare=prepare;env.DB.batch=batch;}};
}
async function run(mode:"wallet"|"no-card"|"monthly"|"fallback"){
 const f=await makeWalletFixture();await ensureWallet(f.env,"dev-1",20);await recoverBillingRequests(f.env,0);
 if(mode==="monthly"||mode==="fallback"){
  const plan=await createMonthlyPlan(f.env,{name:"cost",enabled:1,limits:{daily_usd:mode==="fallback"?.5:10,weekly_usd:20,five_hour_usd:5,total_usd:30},service_group_ids:null});
  await issueMonthlyPass(f.env,"dev-1",plan.id);if(mode==="fallback")await setMonthlyWalletFallback(f.env,"dev-1",true);
 }
 const counter=countCalls(f.env);
 try{
  expect(await admitBillingRequest(f.env,{request_id:"cost",device_id:"dev-1",model:"m",pricing_snapshot_json:"{}",reserved_usd:1,...(mode==="wallet"?{}:{monthly_service_group_ids:[null]})})).toBe(true);
  const id=await beginBillingAttempt(f.env,{request_id:"cost",provider_id:"p",model:"m",protocol:"chat/completions"});
  const usage={input_tokens:10,output_tokens:5,total_tokens:15};await observeBillingAttempt(f.env,id,{usage,usage_source:"reported_final"});
  const receipt=await persistBillingTerminal(f.env,{request_id:"cost",device_id:"dev-1",provider_id:"p",provider_name:"P",model:"m",usage,cost_usd:1,status_code:200,latency_ms:1,created_at:Date.now()});
  await settleBillingRequest(f.env,"cost",receipt);
  const calls=[...counter.calls];counter.restore();
  expect(f.d1.row("SELECT balance_usd,reserved_usd FROM device_wallets WHERE device_id='dev-1'")).toEqual({balance_usd:mode==="monthly"?20:19,reserved_usd:0});
  expect(f.d1.rows("SELECT cost_usd FROM usage")).toEqual([{cost_usd:1}]);
  expect(f.d1.rows("SELECT * FROM monthly_pass_request_buckets")).toHaveLength(mode==="monthly"?4:0);
  return calls;
 }finally{counter.restore();}  
}
describe("monthly pass D1 hot-path budgets",()=>{
 it("adds zero client SQL statements and round trips for no-card, four-window monthly, and explicit fallback",async()=>{
  const wallet=await run("wallet"),none=await run("no-card"),monthly=await run("monthly"),fallback=await run("fallback");
  expect(none).toEqual(wallet);expect(monthly).toEqual(wallet);expect(fallback).toEqual(wallet);expect(wallet).toHaveLength(7);
  console.log("[monthly D1 local SQLite] client round trips="+wallet.length+", statements="+wallet.reduce((n,c)=>n+c.statements,0)+" for wallet/no-card/monthly/fallback; trigger row work is additional, not counted as free");
 });
});
