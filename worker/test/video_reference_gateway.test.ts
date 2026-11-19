import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {gatewayApp} from "../src/gateway";
import {pollVideoTasks,readGenericVideoPoll} from "../src/gateway/video";
import {pruneVideoReferenceAssets} from "../src/db/video_reference_assets";
import {getVideoDiagnostics} from "../src/db/video_diagnostics";
import {parseVideoContentTicket} from "../../web/src/utils/videoReferences";
import {createRealD1,makeEnv,seedDevice,seedModel,seedProvider,wallet,usageRows,ledgerRows,holdRows,TOKEN,DEVICE_ID,CollectingExecutionContext,type RealD1} from "./helpers/realGatewayEnv";
import type {Env} from "../src/types";
class MemoryR2 {
  objects=new Map<string,Uint8Array>();
  async put(key:string,body:ReadableStream<Uint8Array>){const bytes=new Uint8Array(await new Response(body).arrayBuffer());this.objects.set(key,bytes);return {size:bytes.length};}
  async get(key:string){const bytes=this.objects.get(key);return bytes?{size:bytes.length,body:new Blob([bytes]).stream()}:null;}
  async delete(key:string){this.objects.delete(key);}
}
let db:RealD1,env:Env,r2:MemoryR2;
const input={model:"video",prompt:"private test prompt",seconds:5,size:"1920x1080"};
const cfg={model_type:"video",video:{adapter:"generic",task_id_path:"data.task_id",sizes:[input.size],failed_statuses:["FAILED"],reference_images:{mapping:"image_images_url",max_images:3}}};
const auth={authorization:"Bearer "+TOKEN};
function png(){const b=new Uint8Array(64);b.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);new DataView(b.buffer).setUint32(16,32);new DataView(b.buffer).setUint32(20,24);b[24]=8;b[25]=6;return b;}
async function upload(){const b=png();const r=await gatewayApp.request("https://gw.test/video/reference-images",{method:"POST",headers:{...auth,"content-type":"image/png","content-length":String(b.length)},body:b},env);expect(r.status).toBe(201);return await r.json() as any;}
async function submit(ids?:string[],key="reference-e2e-0001",exec?:CollectingExecutionContext){return gatewayApp.request("https://gw.test/video/generations",{method:"POST",headers:{...auth,"content-type":"application/json","Idempotency-Key":key},body:JSON.stringify({...input,...(ids?{reference_image_ids:ids}:{})})},env,exec);}
async function detail(id:string){return gatewayApp.request("https://gw.test/video/generations/"+id,{headers:auth},env);}
function due(id:string){db.sql("UPDATE video_tasks SET poll_after=0,poll_lease_until=NULL WHERE id=?",id);}
beforeEach(async()=>{db=createRealD1();env=makeEnv(db);env.ENCRYPTION_KEY="video-e2e-key";r2=new MemoryR2();env.VIDEO_REFERENCES=r2 as unknown as R2Bucket;await seedDevice(db,{balance_usd:10});seedProvider(db,{endpoint:"https://upstream.test/v1",api_key:"private-upstream-key"});seedModel(db,{model_name:"video",billing_unit:"call",price_per_call:2,input_price_per_m:0,output_price_per_m:0,config_json:JSON.stringify(cfg)});});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();db.close();});
describe("video references and hidden content integrated gateway",()=>{
  it.each([1,2,3])("uploads and atomically binds %i ordered references, emits only image/images once",async(count)=>{
    const images=[];for(let i=0;i<count;i++)images.push(await upload());
    const sent:any[]=[];const mock=vi.spyOn(globalThis,"fetch").mockImplementation(async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return Response.json({data:{task_id:"task_verified"}});});
    const result=await submit(images.map(x=>x.id));expect(result.status).toBe(202);const task=await result.json() as any;
    expect(mock).toHaveBeenCalledTimes(1);const body=sent[0];expect(body.reference_image_ids).toBeUndefined();expect(body.prompt).toBe(input.prompt);
    const urls=count===1?[body.image]:body.images;expect(urls).toHaveLength(count);expect(count===1?body.images:body.image).toBeUndefined();
    for(let i=0;i<count;i++){
      expect(urls[i]).toContain("/video/reference-images/"+images[i].id+"/content?ticket=");
      expect(urls[i]).not.toMatch(/private-upstream-key|Bearer/);
      const img=await gatewayApp.request(urls[i],{},env);expect(img.status).toBe(200);expect(new Uint8Array(await img.arrayBuffer())).toEqual(png());
      const row=db.row<any>("SELECT * FROM video_reference_assets WHERE id=?",images[i].id)!;expect(row.task_id).toBe(task.id);expect(row.expires_at-row.created_at).toBe(7*86400000);
    }
    expect((await submit(images.map(x=>x.id))).status).toBe(200);expect(mock).toHaveBeenCalledTimes(1);
    expect((await submit(images.map(x=>x.id),"different-e2e-key")).status).toBeGreaterThanOrEqual(400);expect(mock).toHaveBeenCalledTimes(1);
    if(count>1)expect((await submit(images.map(x=>x.id).reverse())).status).toBe(409);
    const frozen=db.row<any>("SELECT route_json FROM video_tasks WHERE id=?",task.id)!.route_json;
    expect(JSON.parse(frozen).reference_image_ids).toEqual(images.map(x=>x.id));expect(frozen).not.toMatch(/ticket=|private test prompt/);
  });
  it("leaves zero-image legacy body and idempotency untouched",async()=>{const mock=vi.spyOn(globalThis,"fetch").mockImplementation(async(_u,init)=>{expect(JSON.parse(String(init?.body))).toEqual(input);return Response.json({data:{task_id:"task_ok"}});});expect((await submit()).status).toBe(202);expect((await submit()).status).toBe(200);expect(mock).toHaveBeenCalledTimes(1);});
  it("uses documented nested identity/status, charges once, then serves only frozen-source MP4 with a real UI-compatible ticket",async()=>{
    const image=await upload();let produced=0;const total=10*1024*1024;
    const mock=vi.spyOn(globalThis,"fetch").mockImplementation(async(url,init)=>{
      if(init?.method==="POST")return Response.json({code:"success",data:{task_id:"task_verified"}});
      if(String(url).endsWith("/video/generations/task_verified"))return Response.json({code:"success",data:{task_id:"task_verified",status:"SUCCESS",result_url:"https://private.invalid/signed-secret",data:{video_url:"https://private.invalid/other"}}});
      expect(String(url)).toBe("https://upstream.test/v1/videos/task_verified/content");expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-upstream-key");expect(new Headers(init?.headers).get("x-forwarded-for")).toBeNull();
      return new Response(new ReadableStream<Uint8Array>({pull(c){if(produced===total){c.close();return;}const b=new Uint8Array(Math.min(65536,total-produced));if(!produced)b.set([0,0,0,24,102,116,121,112,105,115,111,109]);produced+=b.length;c.enqueue(b);}},{highWaterMark:0}),{headers:{"content-type":"video/mp4","content-length":String(total),location:"https://private.invalid",server:"secret-channel"}});
    });
    const created=await (await submit([image.id])).json() as any;due(created.id);const result=await (await detail(created.id)).json() as any;
    expect(result).toMatchObject({status:"succeeded",cost_usd:2,result_url:"/v1/video/generations/"+created.id+"/content"});expect(JSON.stringify(result)).not.toContain("private.invalid");expect(wallet(db)?.balance_usd).toBe(8);expect(holdRows(db)).toHaveLength(0);
    const tr=await gatewayApp.request("https://gw.test/video/generations/"+created.id+"/content-ticket",{method:"POST",headers:auth},env);expect(tr.status).toBe(200);const ticket=parseVideoContentTicket(await tr.json(),result.result_url);
    const res=await gatewayApp.request("https://gw.test"+ticket.url.replace(/^\/v1\//,"/"),{headers:{"x-forwarded-for":"192.0.2.1"}},env);expect(res.status).toBe(200);expect(res.headers.get("location")).toBeNull();expect(res.headers.get("server")).toBeNull();expect(res.headers.get("cache-control")).toBe("private, no-store");
    const reader=res.body!.getReader();let consumed=0;for(;;){const p=await reader.read();if(p.done)break;consumed+=p.value.length;expect(p.value.length).toBeLessThanOrEqual(1024*1024);expect(produced-consumed).toBeLessThanOrEqual(2*65536);}expect(consumed).toBe(total);
    expect(usageRows(db)).toHaveLength(1);expect(ledgerRows(db)).toHaveLength(1);expect(mock).toHaveBeenCalledTimes(3);
  });
  it.each(["SUCCESS","FAILED"])("never settles a nested %s response identifying a different task",async(status)=>{const mock=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({data:{task_id:"task_A"}}));const t=await (await submit()).json() as any;due(t.id);mock.mockResolvedValue(Response.json({code:"success",data:{task_id:"task_B",status,result_url:"https://cdn.test/x"}}));expect((await (await detail(t.id)).json() as any).status).toBe("pending");expect(wallet(db)?.balance_usd).toBe(10);expect(wallet(db)?.reserved_usd).toBe(2);expect(usageRows(db)).toHaveLength(0);});
  it("refuses invalid envelopes and does not recursively guess nested terminal states",()=>{for(const reply of [{code:"error",data:{task_id:"task_A",status:"SUCCESS"}},{code:"success",data:{status:"SUCCESS"}},{code:"success",data:{task_id:"task_A",data:{status:"SUCCESS"}}}])expect(readGenericVideoPoll(reply,"task_A").status).toBeNull();});
  it("preserves hard-expired reference review until genuine task completion",async()=>{const a=await upload();const mock=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({data:{task_id:"task_A"}}));const t=await (await submit([a.id])).json() as any;db.sql("UPDATE video_reference_assets SET created_at=?",Date.now()-8*86400000);expect(await pruneVideoReferenceAssets(env)).toBe(1);due(t.id);mock.mockResolvedValue(Response.json({code:"success",data:{task_id:"task_A",status:"RUNNING"}}));const view=await (await detail(t.id)).json() as any;expect(view).toMatchObject({requires_review:true,error_code:"reference_assets_expired",status:"pending"});expect(wallet(db)?.reserved_usd).toBe(2);});
  it.each(["https://127.0.0.1/v1","https://private.local/v1","https://public.example:8443/v1","https://public.example/api.v1","https://public.example/v1/../hidden"])("rejects non-downloadable endpoint before paid POST %s",async(endpoint)=>{db.sql("UPDATE providers SET endpoint=?",endpoint);const mock=vi.spyOn(globalThis,"fetch");expect((await submit()).status).toBe(400);expect(mock).not.toHaveBeenCalled();expect(holdRows(db)).toHaveLength(0);});
  it("retains an opted-in create sample after a delayed claim finishes after mark-submission",async()=>{
    db.sql("INSERT INTO video_diagnostic_arms(device_id,arm_id,armed_at,task_rowid_floor,enabled_until) VALUES(?,?,?,?,?)",DEVICE_ID,"test-arm",Date.now()-1000,0,Date.now()+86400000);
    const batch=env.DB.batch.bind(env.DB);let release!:()=>void;let entered=false;const gate=new Promise<void>(resolve=>{release=resolve;});
    vi.spyOn(env.DB,"batch").mockImplementation(async(statements)=>{if((statements[0] as any).sql?.includes("UPDATE video_diagnostic_arms")){entered=true;await gate;}return batch(statements);});
    const exec=new CollectingExecutionContext();vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({data:{task_id:"task_late"},prompt:input.prompt,authorization:"Bearer private-upstream-key"}));
    const res=await submit(undefined,"late-diagnostic-01",exec);expect(entered).toBe(true);expect(res.status).toBe(202);const t=await res.json() as any;expect(t.status).toBe("pending");release();await Promise.all(exec.pending);
    const diag=await getVideoDiagnostics(env,t.id);expect(diag.samples).toHaveLength(1);expect(JSON.stringify(diag)).toContain("task_late");expect(JSON.stringify(diag)).not.toMatch(/private test prompt|private-upstream-key/);expect(wallet(db)?.reserved_usd).toBe(2);
  });
});
