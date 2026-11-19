import {describe,it,expect,vi} from "vitest";
import {createRequire} from "node:module";
import {gatewayApp} from "../src/gateway";
import {ensureSchema} from "../src/db/schema";
import {resetVideoReadLimits} from "../src/gateway/video";
import {createRealD1,makeEnv,seedDevice,seedProvider,seedModel,TOKEN,DEVICE_ID,holdRows,ledgerRows,usageRows} from "./helpers/realGatewayEnv";
const process=createRequire(new URL("../package.json",import.meta.url))("node:process") as {version:string;env:Record<string,string|undefined>;cpuUsage(start?:{user:number;system:number}):{user:number;system:number}};
const percentile=(v:number[],p:number)=>[...v].sort((a,b)=>a-b)[Math.floor((v.length-1)*p)];
describe.skipIf(process.env.CPG_VIDEO_PERF !== "1")("offline actual Doubao gateway CPU (Node+SQLite, not production CPU)",()=>{
 it("samples full requests without instrumentation and leaves all tasks settled once",async()=>{
  const db=createRealD1(),env=makeEnv(db);env.ENCRYPTION_KEY="synthetic-local-perf-key";
  try{
   await seedDevice(db,{rate_limit_rpm:0,balance_usd:100000});seedProvider(db,{endpoint:"https://video.vendor.example/api/v3",api_key:"synthetic-key"});
   const video={adapter:"doubao",upstream_model:"doubao-seedance-2-5-260628",ratios:["16:9"],resolutions:["720p"],default_resolution:"720p",default_duration:4,default_ratio:"16:9",seconds_min:4,seconds_max:30,min_images:0,max_images:0,max_videos:0,max_audios:0,max_total_refs:0,support_first_last:false,support_video_urls:false,support_audio_urls:false,support_audio_only:false,max_audio_only:0,use_asset_library:false,poll_interval_ms:15000,quotes:[{resolution:"720p",has_reference_video:false,unit:"second",price:.1}]};
   seedModel(db,{model_name:"local-video",billing_unit:"call",price_per_call:0,input_price_per_m:0,output_price_per_m:0,config_json:JSON.stringify({model_type:"video",video})});await ensureSchema(env);
   let next=0,paidPosts=0,polls=0,reply="succeeded";const mock=vi.spyOn(globalThis,"fetch").mockImplementation(async(url,init)=>{if(init?.method==="POST"){paidPosts++;return Response.json({id:"local-"+paidPosts},{status:202});}polls++;return Response.json({id:String(url).split("/").at(-1),status:reply,...(reply==="succeeded"?{content:{video_url:"https://cdn.test/synthetic.mp4"},usage:{completion_tokens:123,total_tokens:150}}:{})});});
   const body=JSON.stringify({model:"local-video",prompt:"Synthetic offline river"});
   async function request(method:string,path:string,key?:string){const response=await gatewayApp.request("https://gateway.test"+path,{method,headers:{authorization:"Bearer "+TOKEN,"content-type":"application/json",...(key?{"Idempotency-Key":key}:{})},...(method==="POST"?{body}:{})},env);const out=await response.json() as any;if(response.status!==200)throw Error("fixture request "+response.status+" "+JSON.stringify(out));return out;}
   async function create(){const key="local-perf-"+(++next),task=await request("POST","/videos",key);if(!task.id)throw Error("missing local task");return {id:task.id,key};}
   function due(id:string){db.sql("UPDATE video_tasks SET poll_after=0,poll_lease_until=NULL WHERE id=?",id);}
   async function settle(tasks:{id:string}[]){reply="succeeded";resetVideoReadLimits();for(const task of tasks){due(task.id);const t=await request("GET","/videos/"+task.id);if(t.status!=="completed")throw Error("unsettled fixture");}}
   const reports:any[]=[];
   async function measure(name:string,before:()=>Promise<any>,work:(state:any)=>Promise<void>,after:(state:any)=>Promise<void>){const samples=[];for(let i=0;i<8;i++){resetVideoReadLimits();const state=await before(),cpu=process.cpuUsage(),wall=performance.now();await work(state);const elapsed=performance.now()-wall,diff=process.cpuUsage(cpu);if(i)samples.push({cpu_ms:(diff.user+diff.system)/1000/96,wall_ms:elapsed/96});await after(state);}reports.push({name,iterations_per_batch:96,measured_batches:7,warmup_batches:1,cpu_p50_ms:percentile(samples.map(s=>s.cpu_ms),.5),wall_p50_ms:percentile(samples.map(s=>s.wall_ms),.5),wall_p95_ms:percentile(samples.map(s=>s.wall_ms),.95),samples});}
   await measure("create",async()=>[],async(tasks:any[])=>{for(let i=0;i<96;i++)tasks.push(await create());},settle);
   const terminal=await create();await settle([terminal]);
   await measure("idempotent-replay",async()=>null,async()=>{for(let i=0;i<96;i++)await request("POST","/videos",terminal.key);},async()=>{});
   await measure("completed-get",async()=>null,async()=>{for(let i=0;i<96;i++)await request("GET","/videos/"+terminal.id);},async()=>{});
   const prepare=async()=>{const tasks=[];for(let i=0;i<96;i++)tasks.push(await create());tasks.forEach(t=>due(t.id));return tasks;};
   await measure("due-processing-poll",async()=>{const tasks=await prepare();reply="processing";return tasks;},async(tasks:any[])=>{for(const task of tasks)await request("GET","/videos/"+task.id);},settle);
   await measure("due-success-poll-and-settlement-with-usage",async()=>{const tasks=await prepare();reply="succeeded";return tasks;},async(tasks:any[])=>{for(const task of tasks){const t=await request("GET","/videos/"+task.id);if(t.status!=="completed")throw Error("expected completed");}},async()=>{});
   expect(holdRows(db)).toEqual([]);expect(ledgerRows(db)).toHaveLength(paidPosts);expect(usageRows(db)).toHaveLength(paidPosts);expect(db.row<any>("SELECT COUNT(*) AS n FROM video_tasks WHERE status<>'succeeded'")!.n).toBe(0);
   console.log("DOUBAO_CPU_PERF_REPORT="+JSON.stringify({runtime:process.version,producer:"local-benchmark",scope:"Full warm gateway+auth+crypto+in-memorySQLite+mockResponse+clientJSON. Fixture setup, schema, force-due and cleanup outside timed regions. Node process CPU includes threads/GC; NOT Workers CPU/D1 latency. No R2/service binding/reference material/network/provider compute.",reports,paidPosts,polls,ledger:ledgerRows(db).length,holds:holdRows(db).length,deviceId:DEVICE_ID}));mock.mockRestore();
  }finally{vi.restoreAllMocks();resetVideoReadLimits();db.close();}
 },120000);
});
