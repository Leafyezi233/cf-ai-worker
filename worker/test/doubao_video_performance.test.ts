import {gatewayApp} from "../src/gateway";
import {ensureSchema} from "../src/db/schema";
import {resetVideoReadLimits} from "../src/gateway/video";
import {describe,expect,it,vi} from "vitest";
import {createRealD1,makeEnv,seedDevice,seedProvider,seedModel,wallet,holdRows,usageRows,ledgerRows,TOKEN} from "./helpers/realGatewayEnv";
type Counts={prepare:number;batch:number;batchStatements:number;first:number;all:number;run:number;table_changes:number;fetch:number;roundtrips:number};
const common={upstream_model:"synthetic-video-v1",default_ratio:"16:9",default_duration:4,ratios:["16:9"],resolutions:["720p"],default_resolution:"720p",seconds_min:4,seconds_max:15,min_images:0,max_images:0,max_videos:0,max_audios:0,support_first_last:false,support_video_urls:false,support_audio_urls:false,support_audio_only:false,max_audio_only:0,poll_interval_ms:15000,quotes:[{resolution:"720p",has_reference_video:false,unit:"second",price:.1}]};
const input={model:"perf-video",prompt:"A quiet river",duration:4,ratio:"16:9",resolution:"720p"};
async function flow(adapter:"doubao"|"secure_skill",rawUsage:boolean,officialContent=false){
 const db=createRealD1(),env=makeEnv(db);env.ENCRYPTION_KEY="synthetic-test-key";let calls=0,pollStatus="processing";
 try{
  await ensureSchema(env);await seedDevice(db,{balance_usd:10});seedProvider(db,{endpoint:"https://video.vendor.example/api/v3",api_key:"synthetic-key"});seedModel(db,{model_name:input.model,billing_unit:"call",price_per_call:99,input_price_per_m:0,output_price_per_m:0,config_json:JSON.stringify({model_type:"video",video:{...common,adapter,...(adapter==="doubao"?{upstream_model:"doubao-seedance-2-0-260128",default_ratio:"16:9",default_duration:4,max_total_refs:0,use_asset_library:false}:{})}})});
  const mock=vi.spyOn(globalThis,"fetch").mockImplementation(async(_url,init)=>{calls++;if(init?.method==="POST")return Response.json(adapter==="doubao"?{id:"local-upstream"}:{task_id:"local-upstream",status:"queued"},{status:adapter==="doubao"?202:200});return Response.json(adapter==="doubao"?{id:"local-upstream",status:pollStatus,...(pollStatus==="succeeded"?{content:{video_url:"https://cdn.test/local.mp4"}}:{}),...(rawUsage?{usage:{completion_tokens:11,total_tokens:18,prompt_tokens:7}}:{})}:{task_id:"local-upstream",status:pollStatus==="succeeded"?"completed":"in_progress",...(pollStatus==="succeeded"?{output:[{url:"https://cdn.test/local.mp4"}]}:{})});});
  async function req(method="POST",path="/videos"){const r=await gatewayApp.request("https://gw.test"+path,{method,headers:{authorization:"Bearer "+TOKEN,"content-type":"application/json","Idempotency-Key":"local-perf-0001"},...(method==="POST"?{body:JSON.stringify(officialContent?{model:input.model,content:[{type:"text",text:input.prompt}],duration:input.duration,ratio:input.ratio,resolution:input.resolution}:input)}:{})},env);expect(r.status).toBe(200);return await r.json() as any;}
  const counters:Record<string,Counts>={};
  async function stage(name:string,fn:()=>Promise<void>){
   const c:Counts={prepare:0,batch:0,batchStatements:0,first:0,all:0,run:0,table_changes:0,fetch:0,roundtrips:0},before=Number(db.row<any>("SELECT total_changes() AS n")!.n),fetchBefore=calls;
   const target=env.DB as any,oldPrepare=target.prepare,oldBatch=target.batch;let inBatch=false;
   target.prepare=(sql:string)=>{c.prepare++;const p=oldPrepare(sql);for(const key of ["first","all","run"] as const){const original=p[key];p[key]=async(...args:any[])=>{if(!inBatch)c[key]++;return original(...args);};}return p;};
   target.batch=async(ss:any[])=>{c.batch++;c.batchStatements+=ss.length;inBatch=true;try{return await oldBatch(ss);}finally{inBatch=false;}};
   try{await fn();}finally{target.prepare=oldPrepare;target.batch=oldBatch;}
   c.table_changes=Number(db.row<any>("SELECT total_changes() AS n")!.n)-before;c.fetch=calls-fetchBefore;c.roundtrips=c.first+c.all+c.run+c.batch;counters[name]=c;
  }
  resetVideoReadLimits();let task:any;
  await stage("create",async()=>{task=await req();expect(task.status).toBe("in_progress");});
  await stage("replay",async()=>expect((await req()).id).toBe(task.id));
  await stage("not_due_get",async()=>expect((await req("GET","/videos/"+task.id)).status).toBe("in_progress"));
  const due=()=>db.sql("UPDATE video_tasks SET poll_after=0,poll_lease_until=NULL WHERE id=?",task.id);
  due();await stage("processing_poll",async()=>expect((await req("GET","/videos/"+task.id)).status).toBe("in_progress"));
  due();pollStatus="succeeded";await stage("success_poll",async()=>expect((await req("GET","/videos/"+task.id)).status).toBe("completed"));
  await stage("completed_get_x2",async()=>{for(let i=0;i<2;i++)expect((await req("GET","/videos/"+task.id)).status).toBe("completed");});
  await stage("list",async()=>expect((await req("GET")).data).toHaveLength(1));
  expect(wallet(db)?.reserved_usd).toBe(0);expect(holdRows(db)).toEqual([]);expect(ledgerRows(db)).toHaveLength(1);expect(usageRows(db)).toHaveLength(1);expect(usageRows(db)[0]).toMatchObject({input_tokens:0,output_tokens:0,cost_usd:.4});expect(calls).toBe(3);
  for(const name of ["replay","not_due_get","completed_get_x2","list"]){expect(counters[name].fetch).toBe(0);expect(counters[name].table_changes).toBe(0);}
  if(adapter==="doubao")expect(db.row<any>("SELECT upstream_usage_json FROM video_tasks WHERE id=?",task.id)!.upstream_usage_json).toBe(rawUsage?JSON.stringify({completion_tokens:11,total_tokens:18}):null);
  mock.mockRestore();return {adapter,rawUsage,officialContent,counters,final:{holds:0,ledger:1,usage:1,fetch:calls}};
 }finally{vi.restoreAllMocks();resetVideoReadLimits();db.close();}
}
describe("video database method overhead with warm schema",()=>{
 it("compares actual gateway stages, optional raw usage and repeated reads",async()=>{
  const doubao=await flow("doubao",true),withoutUsage=await flow("doubao",false),minimax=await flow("secure_skill",false),official=await flow("doubao",true,true);
  expect(doubao.counters).toEqual(withoutUsage.counters);expect(doubao.counters.create.roundtrips).toBe(official.counters.create.roundtrips+1);
  console.log("DOUBAO_DB_PERF_REPORT="+JSON.stringify({producer:"local-benchmark",doubao,withoutUsage,minimax,official,note:"Warm schema; env.DB identity preserved; method wrappers preserve bind self. Roundtrips=top-level first/all/run+batch, batch internal calls excluded. Prepare counts top-level SQL, not trigger statements. TABLE total_changes includes trigger table mutations, NOT billed D1 rows/index writes. No RATE_LIMITER DO bound in local fixture; production read requests additionally consume a DO request."}));
 });
});
