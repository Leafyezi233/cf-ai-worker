import { Hono } from "hono";
import { gatewayApp } from "../src/gateway";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import type { Env } from "../src/types";
import { createDoubaoVideoHandler,getDoubaoVideoHandler,listDoubaoVideoHandler,readDoubaoVideoPoll } from "../src/gateway/doubao_video";
import { resetVideoReadLimits } from "../src/gateway/video";
import { videoContentHandler,resetVideoContentLimits } from "../src/gateway/video_content";
import { sha256Hex } from "../src/utils/crypto";
import { createServiceGroup,upsertServiceGroupModel } from "../src/db/service_groups";
import { createRealD1,makeEnv,seedDevice,seedProvider,seedModel,wallet,holdRows,usageRows,ledgerRows,TOKEN,DEVICE_ID,type RealD1 } from "./helpers/realGatewayEnv";
const app = new Hono<{Bindings:Env}>();
app.post("/videos",createDoubaoVideoHandler);app.get("/videos",listDoubaoVideoHandler);app.get("/videos/:id",getDoubaoVideoHandler);app.get("/videos/:id/content",videoContentHandler);
const upstreamModel="vendor/custom-video-v1";
const endpoint="https://video.vendor.example/api/v3/contents/generations/tasks";
const config={model_type:"video",video:{adapter:"doubao",upstream_model:upstreamModel,ratios:["16:9","9:16"],resolutions:["720p","1080p"],default_resolution:"720p",default_ratio:"16:9",default_duration:4,seconds_min:4,seconds_max:15,max_images:30,max_videos:10,max_audios:10,max_total_refs:50,support_first_last:true,support_video_urls:true,support_audio_urls:true,support_audio_only:true,max_audio_only:3,use_asset_library:false,poll_interval_ms:15000,quotes:[{resolution:"720p",has_reference_video:false,unit:"second",price:0.1},{resolution:"1080p",has_reference_video:false,unit:"call",price:2},{resolution:"720p",has_reference_video:true,unit:"call",price:3}]}};
const input={model:"public-video",prompt:"A quiet river"};
let db:RealD1,env:Env;
function mock(reply:unknown={id:"private-upstream"},status=202){return vi.spyOn(globalThis,"fetch").mockImplementation(async()=>Response.json(reply,{status}));}
async function req(method="POST",body:unknown=input,path="/videos",key="doubao-key-0001",token=TOKEN){return app.request("https://gw.test"+path,{method,headers:{authorization:"Bearer "+token,"content-type":"application/json","Idempotency-Key":key},...(method==="POST"?{body:JSON.stringify(body)}:{})},env);}
async function create(body:unknown=input){const r=await req("POST",body);expect(r.status).toBe(200);return await r.json() as any;}
function due(id:string){db.sql("UPDATE video_tasks SET poll_after=0,poll_lease_until=NULL WHERE id=?",id);}
async function get(id:string){return await (await req("GET",null,"/videos/"+id)).json() as any;}
function cfg(video:Record<string,unknown>){db.sql("UPDATE models SET config_json=?",JSON.stringify({...config,video:{...config.video,...video}}));}
function references(bindFails=false){
 env.VIDEO_REFERENCE_IMAGE_ORIGIN="https://images.cpg.org";
 env.VIDEO_REFERENCE_IMAGES={fetch:vi.fn(async(request:Request)=>{
  const url=new URL(request.url),video=url.pathname.includes("video-assets");
  if(url.pathname.endsWith("/limits"))return Response.json({enabled:true,formats:["video/mp4"],max_bytes:100000,max_duration_ms:10000});
  const id=url.pathname.split("/")[3];
  if(request.method==="GET"){
   expect(holdRows(db)).toEqual([]);expect(JSON.parse(url.searchParams.get("owner")!)).toEqual([DEVICE_ID,null]);
   return Response.json({id,bytes:16,content_type:video?"video/mp4":"image/png",...(video?{duration_ms:1000}:{}),expires_at:Math.floor(Date.now()/1000)+1000});
  }
  expect(holdRows(db)).toHaveLength(1);const b=await request.json() as any;
  expect(b.owner).toBe(JSON.stringify([DEVICE_ID,null]));expect(db.row("SELECT id FROM video_tasks WHERE id=?",b.task_id)).toBeTruthy();
  return bindFails?new Response(null,{status:503}):Response.json({id,expires_at:b.expires_at,url:"https://images.cpg.org/"+(video?"video-assets/":"assets/")+id+"?signed=opaque"});
 })} as any;
}
beforeEach(async()=>{resetVideoReadLimits();resetVideoContentLimits();db=createRealD1();env=makeEnv(db);env.ENCRYPTION_KEY="doubao-test-key";await seedDevice(db,{balance_usd:10});seedProvider(db,{endpoint:"https://video.vendor.example/api/v3",api_key:"private-key"});seedModel(db,{model_name:input.model,billing_unit:"call",price_per_call:99,input_price_per_m:0,output_price_per_m:0,config_json:JSON.stringify(config)});});
afterEach(()=>{vi.restoreAllMocks();db.close();});
describe("Doubao real SQLite and mock fetch",()=>{
 it("accepts HTTP202 id-only and creates sealed frozen route at exact fixed sale",async()=>{
  const f=mock(),t=await create();expect(t.id).toMatch(/^vid_[0-9a-f-]{36}$/);
  expect(t).toMatchObject({model:input.model,status:"in_progress",duration:4,ratio:"16:9",resolution:"720p",price_per_call:0.4,content_available:false,url:null});
  expect(wallet(db)?.reserved_usd).toBeCloseTo(0.4);expect(usageRows(db)).toEqual([]);expect(holdRows(db)).toHaveLength(1);
  const [url,init]=f.mock.calls[0];expect(url).toBe(endpoint);expect(init?.redirect).toBe("manual");expect(new Headers(init?.headers).get("idempotency-key")).toBe("cpg-video-"+t.id);
  expect(JSON.parse(String(init?.body))).toEqual({model:upstreamModel,content:[{type:"text",text:input.prompt}],duration:4,ratio:"16:9",resolution:"720p",use_asset_library:false});
  const r=JSON.parse(db.row<any>("SELECT route_json FROM video_tasks WHERE id=?",t.id).route_json);
  expect(r).toMatchObject({protocol_version:"doubao-video-v1",upstream_model:upstreamModel,sub_token_id:null});expect(r.credential).toMatch(/^enc:v1:/);expect(JSON.stringify(r)).not.toContain("private-key");expect(r.inputs).toBeUndefined();expect(JSON.stringify(r)).not.toContain(input.prompt);
  expect(JSON.stringify(t)).not.toMatch(/private-upstream|private-key|secure-skill|doubao/);
 });
 it("normalizes shorthand, official content, aliases and explicit defaults before replay hash",async()=>{
  const f=mock(),t=await create();expect((await create({model:input.model,content:[{text:input.prompt,type:"text"}],seconds:4,aspect_ratio:"16:9",resolution:"720p",use_asset_library:false})).id).toBe(t.id);
  expect((await req("POST",{...input,duration:5})).status).toBe(409);expect(f).toHaveBeenCalledTimes(1);
 });
 it("replays frozen defaults after operator config/model/provider changes",async()=>{
  const f=mock(),t=await create();cfg({default_duration:8,default_ratio:"9:16",default_resolution:"1080p"});db.sql("UPDATE providers SET endpoint='https://wrong.test',api_key='changed'");
  expect((await create()).id).toBe(t.id);expect(f).toHaveBeenCalledTimes(1);expect(wallet(db)?.reserved_usd).toBeCloseTo(0.4);
 });
 it("concurrent idempotency claims dispatch once",async()=>{const f=mock();const results=await Promise.all(Array.from({length:5},()=>req()));expect(results.every(r=>r.status===200)).toBe(true);expect(f).toHaveBeenCalledTimes(1);expect(holdRows(db)).toHaveLength(1);});
 it("settles succeeded actuals atomically while all public downloads stay closed",async()=>{
  const f=mock(),t=await create();db.sql("UPDATE models SET config_json='{}',price_per_call=100");db.sql("UPDATE providers SET endpoint='https://wrong.test',api_key='changed'");due(t.id);
  f.mockImplementation(async(url,init)=>{expect(url).toBe(endpoint+"/private-upstream");expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-key");return Response.json({id:"private-upstream",status:"succeeded",content:{video_url:"https://cdn.test/secret.mp4"},usage:{completion_tokens:123,total_tokens:150,prompt_tokens:27,secret:"private"},error:"private-error"});});
  const view=await get(t.id);expect(view).toMatchObject({status:"completed",content_available:false,url:null,video_url:null,result_url:null,output:[],result:null,cost_usd:0.4});expect(view.error).toBeUndefined();expect(JSON.stringify(view)).not.toMatch(/cdn.test|private|usage|tokens|doubao/);
  expect(wallet(db)).toMatchObject({balance_usd:9.6,reserved_usd:0});expect(usageRows(db)[0]).toMatchObject({cost_usd:0.4,input_tokens:0,output_tokens:0});expect(ledgerRows(db)).toHaveLength(1);
  expect(JSON.parse(db.row<any>("SELECT upstream_usage_json FROM video_tasks WHERE id=?",t.id).upstream_usage_json)).toEqual({completion_tokens:123,total_tokens:150});
  await get(t.id);expect(ledgerRows(db)).toHaveLength(1);
  const count=f.mock.calls.length;const content=await req("GET",null,"/videos/"+t.id+"/content");expect(content.status).toBe(409);expect(await content.json()).toEqual({error:"video_content_unavailable"});expect(f).toHaveBeenCalledTimes(count);
 });
 it.each([{}, {video_url:"https://cdn.test/wrong"}, {content:{}}, {content:{video_url:"http://cdn.test/a"}},{content:{video_url:"https://u:p@cdn.test/a"}},{content:{video_url:"https://cdn.test/a#x"}}])("succeeded without known content.video_url stays pending %j",async fields=>{const f=mock(),t=await create();due(t.id);f.mockResolvedValue(Response.json({id:"private-upstream",status:"succeeded",...fields}));expect((await get(t.id)).status).toBe("in_progress");expect(wallet(db)?.reserved_usd).toBeCloseTo(0.4);expect(ledgerRows(db)).toEqual([]);});
 it.each([{id:"wrong",status:"failed"},{id:"private-upstream",task_id:"wrong",status:"failed"},{task_id:"private-upstream",status:"failed"},{data:{id:"private-upstream"},status:"failed"},{id:"private-upstream",status:"FAILED"}])("only strict root matching failures release the hold %j",async reply=>{const f=mock(),t=await create();due(t.id);f.mockResolvedValue(Response.json(reply));expect((await get(t.id)).status).toBe("in_progress");expect(wallet(db)?.reserved_usd).toBeCloseTo(0.4);expect(ledgerRows(db)).toEqual([]);});
 it("known failure releases zero charge and sanitizes upstream errors",async()=>{const f=mock(),t=await create();due(t.id);f.mockResolvedValue(Response.json({id:"private-upstream",status:"failed",error:{message:"private-key secret"}}));expect(await get(t.id)).toMatchObject({status:"failed",cost_usd:0,error:{code:"video_generation_failed"}});expect(wallet(db)).toMatchObject({balance_usd:10,reserved_usd:0});expect(usageRows(db)[0].cost_usd).toBe(0);});
 it.each([200,400,401,429,500])("POST HTTP%s is ambiguous and never retried/refunded",async status=>{const f=mock({id:"private-upstream",error:"private"},status),t=await create();expect(t.status).toBe("submission_unknown");await create();expect(f).toHaveBeenCalledTimes(1);expect(wallet(db)?.reserved_usd).toBeCloseTo(0.4);expect(usageRows(db)).toEqual([]);});
 it.each([{}, {task_id:"x"},{id:"x",task_id:"y"},{data:{id:"x"}}])("unconfirmed HTTP202 root ID remains unknown %j",async reply=>{const f=mock(reply);expect((await create()).status).toBe("submission_unknown");await create();expect(f).toHaveBeenCalledTimes(1);});
 it("network loss holds liability, no paid failover",async()=>{const f=mock();f.mockRejectedValue(Error("private"));expect((await create()).status).toBe("submission_unknown");await create();expect(f).toHaveBeenCalledTimes(1);expect(holdRows(db)).toHaveLength(1);});
 it("queries are lease bounded and lists are DB-only, adapter filtered",async()=>{const f=mock(),t=await create();await get(t.id);expect(f).toHaveBeenCalledTimes(1);due(t.id);f.mockResolvedValue(Response.json({id:"private-upstream",status:"processing"}));await get(t.id);await get(t.id);expect(f).toHaveBeenCalledTimes(2);const list=await (await req("GET")).json() as any;expect(list.data).toHaveLength(1);db.sql("UPDATE video_tasks SET route_json=json_set(route_json,'$.video.adapter','secure_skill')");expect((await (await req("GET")).json() as any).data).toEqual([]);expect((await req("GET",null,"/videos/"+t.id)).status).toBe(404);expect(usageRows(db)).toEqual([]);});
 it("account and sub-token authorization precedes reads and replay",async()=>{
  const f=mock();for(const id of ["sub-a","sub-b"])db.sql("INSERT INTO device_sub_tokens (id,device_id,name,token_hash,created_at) VALUES (?,?,?,?,1)",id,DEVICE_ID,id,await sha256Hex(id));
  const t=await (await req("POST",input,"/videos","doubao-sub-key","sub-a")).json() as any;
  expect((await req("GET",null,"/videos/"+t.id,"unused","sub-b")).status).toBe(404);expect((await req("POST",input,"/videos","doubao-sub-key","sub-b")).status).toBe(409);
  expect((await (await req("GET",null,"/videos","unused","sub-b")).json() as any).data).toEqual([]);expect((await req("GET",null,"/videos/"+t.id)).status).toBe(200);
  await seedDevice(db,{id:"other",token_hash:await sha256Hex("other-token")});expect((await req("GET",null,"/videos/"+t.id,"unused","other-token")).status).toBe(404);expect(f).toHaveBeenCalledTimes(1);
 });
 it("missing auth and Auto selection reject before any POST",async()=>{const f=mock();expect((await req("POST",input,"/videos","doubao-key-0001","invalid")).status).toBe(401);db.sql("UPDATE devices SET service_group_id='auto'");expect(await (await req()).json()).toEqual({error:"doubao_video_explicit_route_required"});expect(f).not.toHaveBeenCalled();expect(holdRows(db)).toEqual([]);});
 it("insufficient funds and missing declared price mode reject before dispatch",async()=>{const f=mock();db.sql("UPDATE device_wallets SET balance_usd=0.1");expect((await req()).status).toBe(402);db.sql("UPDATE device_wallets SET balance_usd=10");db.sql("UPDATE models SET pricing_mode='unset'");expect((await req()).status).toBe(400);db.sql("UPDATE models SET pricing_mode='free'");expect((await req()).status).toBe(400);expect(f).not.toHaveBeenCalled();});
 it("explicit free zero-rate quote reserves no money",async()=>{mock();db.sql("UPDATE models SET pricing_mode='free'");cfg({quotes:config.video.quotes.map(q=>({...q,price:0}))});expect((await create()).price_per_call).toBe(0);expect(wallet(db)?.reserved_usd).toBe(0);});
 it("service multiplier scales exact variant and call quotes do not multiply seconds",async()=>{const sg=await createServiceGroup(env,{name:"fixed",enabled:1,selectable:1,public_selectable:1,multiplier:2});await upsertServiceGroupModel(env,sg.id,{model_key:input.model,target_type:"model",target_id:"model_a"});db.sql("UPDATE devices SET service_group_id=?",sg.id);mock();expect((await create({...input,resolution:"1080p",duration:15})).price_per_call).toBe(4);});
 it("scalar service override is unsupported",async()=>{const sg=await createServiceGroup(env,{name:"fixed",enabled:1,selectable:1,public_selectable:1});await upsertServiceGroupModel(env,sg.id,{model_key:input.model,target_type:"model",target_id:"model_a",pricing_json:JSON.stringify({price_per_call:1})});db.sql("UPDATE devices SET service_group_id=?",sg.id);const f=mock();expect(await (await req()).json()).toEqual({error:"doubao_video_scalar_override_not_supported"});expect(f).not.toHaveBeenCalled();});
 it("mixed external official refs retain roles/known flags and video-specific quote",async()=>{const f=mock();const t=await create({...input,images:["https://cdn.org/image"],videos:["https://cdn.org/video"],audios:["https://cdn.org/audio"],generate_audio:true,watermark:false,return_last_frame:true,seed:0});expect(t.price_per_call).toBe(3);const body=JSON.parse(String(f.mock.calls[0][1]?.body));expect(body).toMatchObject({model:upstreamModel,generate_audio:true,watermark:false,return_last_frame:true,seed:0});expect(body.content.map((p:any)=>p.role??p.type)).toEqual(["text","reference_image","reference_video","reference_audio"]);const frozen=db.row<any>("SELECT route_json FROM video_tasks WHERE id=?",t.id).route_json;expect(frozen).not.toContain(input.prompt);expect(frozen).not.toContain("cdn.org");expect(JSON.parse(frozen).inputs).toBeUndefined();});
 it("private image and video IDs bind after durable hold and replace only internal markers",async()=>{references();const f=mock(),image="a".repeat(32),video="b".repeat(32);await create({...input,reference_image_ids:[image],reference_video_ids:[video]});const content=JSON.parse(String(f.mock.calls[0][1]?.body)).content;expect(content[1]).toEqual({type:"image_url",image_url:{url:"https://images.cpg.org/assets/"+image+"?signed=opaque"},role:"reference_image"});expect(content[2]).toEqual({type:"video_url",video_url:{url:"https://images.cpg.org/video-assets/"+video+"?signed=opaque"},role:"reference_video"});});
 it("private first/tail frames preserve ordering",async()=>{references();const f=mock();await create({...input,first_frame_id:"a".repeat(32),last_frame_id:"b".repeat(32)});expect(JSON.parse(String(f.mock.calls[0][1]?.body)).content.map((p:any)=>p.role??p.type)).toEqual(["text","first_frame","last_frame"]);});
 it("known pre-POST bind failure settles zero and replay never rebinds",async()=>{references(true);const f=mock(),body={...input,reference_image_ids:["a".repeat(32)]};expect(await create(body)).toMatchObject({status:"failed",cost_usd:0});await create(body);expect(f).not.toHaveBeenCalled();expect(wallet(db)).toMatchObject({balance_usd:10,reserved_usd:0});expect(holdRows(db)).toEqual([]);expect(usageRows(db)[0].cost_usd).toBe(0);expect(ledgerRows(db)).toHaveLength(1);});
 it.each([{reference_image_ids:Array.from({length:10},(_,i)=>i.toString(16).padStart(32,"0"))},{reference_video_ids:Array.from({length:4},(_,i)=>i.toString(16).padStart(32,"0"))}])("private first-release caps reject before even validation %j",async extra=>{references();const f=mock();expect((await req("POST",{...input,...extra})).status).toBe(400);expect(f).not.toHaveBeenCalled();expect(env.VIDEO_REFERENCE_IMAGES!.fetch).not.toHaveBeenCalled();expect(holdRows(db)).toEqual([]);});
 it.each([{duration:4,seconds:5},{ratio:"16:9",aspect_ratio:"9:16"},{content:[],prompt:"x"},{content:[{type:"text",text:"x"},{type:"image_url",image_url:{url:"cpg-image:"+"a".repeat(32)}}]},{first_frame:"https://cdn.org/a",images:["https://cdn.org/b"]},{first_frame:"https://cdn.org/a",videos:["https://cdn.org/v"]},{upstream_model:upstreamModel},{stream:true},{images:["http://cdn.org/a"]}])("rejects conflicts/forged content before hold %j",async extra=>{const f=mock();expect((await req("POST",{...input,...extra})).status).toBe(400);expect(f).not.toHaveBeenCalled();expect(holdRows(db)).toEqual([]);});
 it("create rollback leaves no task/hold/POST",async()=>{const f=mock();db.sql("CREATE TRIGGER fail_doubao_hold BEFORE INSERT ON reserve_holds BEGIN SELECT RAISE(ABORT,'doubao_create_rollback'); END");expect((await req()).status).toBe(500);expect(wallet(db)).toMatchObject({balance_usd:10,reserved_usd:0});expect(db.rows("SELECT * FROM video_tasks")).toEqual([]);expect(f).not.toHaveBeenCalled();});
 it("settlement rollback retains liability and raw actuals do not leak through partial commit",async()=>{const f=mock(),t=await create();due(t.id);db.sql("CREATE TRIGGER fail_doubao_usage BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT,'doubao_settle_rollback'); END");f.mockResolvedValue(Response.json({id:"private-upstream",status:"succeeded",content:{video_url:"https://cdn.org/a"},usage:{completion_tokens:12}}));expect((await get(t.id)).status).toBe("in_progress");expect(wallet(db)).toMatchObject({balance_usd:10,reserved_usd:0.4});expect(ledgerRows(db)).toEqual([]);expect(db.row<any>("SELECT upstream_usage_json FROM video_tasks WHERE id=?",t.id).upstream_usage_json).toBeNull();});
 it("per-second quantity times service and peak multipliers is frozen through settlement",async()=>{
  db.sql("UPDATE models SET peak_pricing_enabled=1");
  for(const day of ["weekday","weekend"])db.sql("INSERT INTO price_windows (id,model_id,day_type,start_minute,end_minute,multiplier,enabled,created_at,updated_at) VALUES (?,? ,?,0,1440,3,1,1,1)","band-"+day,"model_a",day);
  const sg=await createServiceGroup(env,{name:"peak-fixed",enabled:1,selectable:1,public_selectable:1,multiplier:2});await upsertServiceGroupModel(env,sg.id,{model_key:input.model,target_type:"model",target_id:"model_a"});db.sql("UPDATE devices SET service_group_id=?",sg.id);
  const f=mock(),t=await create({...input,duration:5});expect(t.price_per_call).toBe(3);
  const snap=JSON.parse(db.row<any>("SELECT pricing_snapshot_json FROM video_tasks WHERE id=?",t.id).pricing_snapshot_json);expect(snap).toMatchObject({quote:{unit:"second",price:0.1},quote_quantity:5,service_multiplier:2,price_multiplier:3,price_usd:3});
  db.sql("UPDATE price_windows SET multiplier=9");db.sql("UPDATE service_groups SET multiplier=9");due(t.id);f.mockResolvedValue(Response.json({id:"private-upstream",status:"succeeded",content:{video_url:"https://cdn.org/a"}}));expect((await get(t.id)).cost_usd).toBe(3);expect(wallet(db)).toMatchObject({balance_usd:7,reserved_usd:0});
 });
 it("external operator caps are independent of private service image ceiling",async()=>{const f=mock();await create({...input,images:Array.from({length:10},(_,i)=>"https://cdn.org/image-"+i)});expect(JSON.parse(String(f.mock.calls[0][1]?.body)).content).toHaveLength(11);});
 it("oversized POST response body remains unknown and never retries",async()=>{const f=mock();f.mockResolvedValue(new Response(JSON.stringify({id:"private-upstream",pad:"x".repeat(65536)}),{status:202,headers:{"content-type":"application/json"}}));expect((await create()).status).toBe("submission_unknown");await create();expect(f).toHaveBeenCalledTimes(1);expect(wallet(db)?.reserved_usd).toBeCloseTo(0.4);});
 it("HTTP query failure retains hold even when the error body claims failed",async()=>{const f=mock(),t=await create();due(t.id);f.mockResolvedValue(Response.json({id:"private-upstream",status:"failed"},{status:500}));expect((await get(t.id)).status).toBe("in_progress");expect(wallet(db)?.reserved_usd).toBeCloseTo(0.4);expect(ledgerRows(db)).toEqual([]);});
 it("unsafe provider endpoint cannot dispatch",async()=>{const f=mock();db.sql("UPDATE providers SET endpoint='http://other.org/v1'");expect((await req()).status).toBe(400);expect(f).not.toHaveBeenCalled();});
});
describe("actual shared gateway routes",()=>{
 async function gateway(method="POST",body:unknown=input,path="/videos",key="shared-key-0001"){
  return gatewayApp.request("https://gw.test"+path,{method,headers:{authorization:"Bearer "+TOKEN,"content-type":"application/json","Idempotency-Key":key},...(method==="POST"?{body:JSON.stringify(body)}:{})},env);
 }
 it.each([input,{...input,duration:6,ratio:"16:9"},{model:input.model,content:[{type:"text",text:input.prompt}]}])("dispatches shorthand/overlapping Minimax shape/content by authorized config %j",async body=>{
  const f=mock(),response=await gateway("POST",body);expect(response.status).toBe(200);const t=await response.json() as any;
  expect(t.content_available).toBe(false);expect(f).toHaveBeenCalledTimes(1);expect(f.mock.calls[0][0]).toBe(endpoint);
  expect((await gateway("POST",body)).status).toBe(200);expect(f).toHaveBeenCalledTimes(1);
  const list=await (await gateway("GET")).json() as any;expect(list.data.map((x:any)=>x.id)).toEqual([t.id]);
  due(t.id);f.mockResolvedValue(Response.json({id:"private-upstream",status:"succeeded",content:{video_url:"https://cdn.org/private"},usage:{total_tokens:77}}));
  const completed=await (await gateway("GET",null,"/videos/"+t.id)).json() as any;expect(completed).toMatchObject({status:"completed",content_available:false,result_url:null});
  const oldView=await (await gateway("GET",null,"/video/generations/"+t.id)).json() as any;expect(oldView).toMatchObject({status:"completed",content_available:false,result_url:null});
  const oldList=await (await gateway("GET",null,"/video/generations")).json() as any;expect(JSON.stringify(oldList)).not.toMatch(/cdn.org|private-upstream|private-key|secure-skill|upstream_usage/);
  expect((await gateway("GET",null,"/videos/"+t.id+"/content")).status).toBe(409);expect(ledgerRows(db)).toHaveLength(1);
 });
 it("persists known usage when succeeded lacks content, retaining liability until proof",async()=>{
  const f=mock(),t=await (await gateway()).json() as any;due(t.id);f.mockResolvedValue(Response.json({id:"private-upstream",status:"succeeded",usage:{total_tokens:13}}));
  expect((await (await gateway("GET",null,"/videos/"+t.id)).json() as any).status).toBe("in_progress");
  expect(db.row<any>("SELECT upstream_usage_json FROM video_tasks WHERE id=?",t.id).upstream_usage_json).toBe('{"total_tokens":13}');expect(ledgerRows(db)).toEqual([]);
 });
 it("enforces one account RPM admission and frozen replay before another charge",async()=>{
  db.sql("UPDATE devices SET rate_limit_rpm=1");const f=mock(),body={...input,duration:6,ratio:"16:9"};
  expect((await gateway("POST",body)).status).toBe(200);expect((await gateway("POST",body)).status).toBe(200);
  expect((await gateway("POST",body,"/videos","shared-other-key")).status).toBe(429);expect(f).toHaveBeenCalledTimes(1);expect(holdRows(db)).toHaveLength(1);
 });
});
describe("strict official poll and raw actual sanitation",()=>{
 it("does not inspect nested IDs or alternative URL aliases",()=>{expect(readDoubaoVideoPoll({data:{id:"x"},status:"succeeded"})).toEqual({id:null,status:null,result:null});expect(readDoubaoVideoPoll({id:"x",status:"succeeded",video_url:"https://cdn.org/a"},"x").result).toBeNull();});
 it("retains only known valid nonnegative safe integer actuals, never invents them",()=>{
  expect(readDoubaoVideoPoll({id:"x",status:"succeeded",usage:{completion_tokens:12,total_tokens:20,extra:"secret"}}).upstream_usage_json).toBe('{"completion_tokens":12,"total_tokens":20}');
  for(const usage of [undefined,{}, {completion_tokens:-1,total_tokens:"20"},{completion_tokens:1.5,total_tokens:Infinity}])expect(readDoubaoVideoPoll({id:"x",status:"succeeded",usage}).upstream_usage_json).toBeUndefined();
  expect(readDoubaoVideoPoll({id:"x",status:"failed",usage:{completion_tokens:0,total_tokens:null}}).upstream_usage_json).toBe('{"completion_tokens":0}');
 });
});
