import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import { pollVideoTasks, validateVideoRequest, videoTaskView } from "../src/gateway/video";
import { releaseStaleReserves } from "../src/db/repo";
import { sha256Hex } from "../src/utils/crypto";
import { createServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import type { Env } from "../src/types";
import { createRealD1, makeEnv, seedDevice, seedModel, seedProvider, seedGroup, seedGroupMembers, seedDeviceGroups, wallet, holdRows, usageRows, ledgerRows, TOKEN, DEVICE_ID, type RealD1 } from "./helpers/realGatewayEnv";
const MODEL = "gemini-omni-1.2-flash";
const cfg = {model_type:"video", video:{adapter:"generic",task_id_path:"data.task_id",sizes:["1280x720","1920x1080"],seconds_min:3,seconds_max:15,failed_statuses:["FAILED"]}};
const input = {model:MODEL,prompt:"A quiet river",seconds:5,size:"1920x1080"};
let db:RealD1, env:Env;
const calls: {url:string;method:string;body:any;auth:string|null}[] = [];
function upstream(reply:unknown={data:{task_id:"private-id"}}, status=200) {
  return vi.spyOn(globalThis,"fetch").mockImplementation(async(url,init)=>{
    calls.push({url:String(url),method:init?.method || "GET",body:init?.body ? JSON.parse(String(init.body)) : undefined,auth:new Headers(init?.headers).get("authorization")});
    return Response.json(reply,{status});
  });
}
async function request(method="POST",body:unknown=input,key="video-key-0001",token=TOKEN,path="/video/generations") {
  return gatewayApp.request("https://gw.test"+path,{method,headers:{authorization:"Bearer "+token,"content-type":"application/json","Idempotency-Key":key},...(method==="POST"?{body:JSON.stringify(body)}:{})},env);
}
async function create() {const res=await request();expect(res.status).toBe(202);return await res.json() as any;}
function due(id:string) {db.sql("UPDATE video_tasks SET poll_after=0, poll_lease_until=NULL WHERE id=?",id);}
function settled(balance:number) {expect(wallet(db)?.balance_usd).toBeCloseTo(balance,8);expect(wallet(db)?.reserved_usd).toBeCloseTo(0,8);expect(holdRows(db)).toEqual([]);}
beforeEach(async()=>{db=createRealD1();env=makeEnv(db);env.ENCRYPTION_KEY="unit-test-video-encryption-only";await seedDevice(db,{balance_usd:10});seedProvider(db,{endpoint:"https://video.test/v1",api_key:"private-provider-key"});seedModel(db,{model_name:MODEL,billing_unit:"call",price_per_call:2,input_price_per_m:0,output_price_per_m:0,config_json:JSON.stringify(cfg)});calls.length=0;});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();db.close();});
describe("video async gateway with real SQLite and fetch-only mock",()=>{
  it("reserves once before POST, freezes route and hides private data",async()=>{
    upstream();const task=await create();expect(task.status).toBe("pending");expect(task.price_per_call).toBe(2);expect(task.cost_usd).toBe(0);expect(wallet(db)).toMatchObject({balance_usd:10,reserved_usd:2});expect(usageRows(db)).toEqual([]);
    expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({url:"https://video.test/v1/video/generations",method:"POST",body:input,auth:"Bearer private-provider-key"});
    const persisted=db.row<any>("SELECT * FROM video_tasks WHERE id=?",task.id)!;expect(persisted.route_json).toContain("enc:v1:");expect(persisted.route_json).not.toContain("private-provider-key");expect(persisted.route_json).not.toContain(input.prompt);expect(JSON.stringify(task)).not.toMatch(/private-id|private-provider-key|route_json|provider_id|task_id_path/);
  });
  it("same key/body returns the existing task with no second POST or hold",async()=>{upstream();const t=await create();const replay=await request();expect(replay.status).toBe(200);expect((await replay.json() as any).id).toBe(t.id);expect(calls).toHaveLength(1);expect(holdRows(db)).toHaveLength(1);});
  it("same key/different payload is a conflict",async()=>{upstream();await create();expect((await request("POST",{...input,seconds:6})).status).toBe(409);expect(calls).toHaveLength(1);});
  it("concurrent same-key submissions dispatch at most once",async()=>{upstream();const rs=await Promise.all(Array.from({length:5},()=>request()));expect(rs.every(r=>r.status===200||r.status===202)).toBe(true);expect(calls).toHaveLength(1);expect(holdRows(db)).toHaveLength(1);});
  it("SUCCESS with valid URL charges frozen price once and creates atomic usage/daily/ledger",async()=>{const mock=upstream();const t=await create();db.sql("UPDATE models SET price_per_call=9 WHERE model_name=?",MODEL);db.sql("UPDATE providers SET endpoint='https://changed.test/v1',api_key='changed' WHERE id='prov_a'");due(t.id);mock.mockImplementation(async(url,init)=>{expect(String(url)).toBe("https://video.test/v1/video/generations/private-id");expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-provider-key");return Response.json({status:"SUCCESS",result_url:"https://cdn.test/video.mp4?sig=123"});});
    const res=await request("GET",null,"unused-key",TOKEN,"/video/generations/"+t.id);const view=await res.json() as any;expect(view).toMatchObject({status:"succeeded",cost_usd:2,price_per_call:2,result_url:"/v1/video/generations/"+t.id+"/content"});settled(8);expect(usageRows(db)).toMatchObject([{model:MODEL,cost_usd:2,input_tokens:0,output_tokens:0}]);expect(ledgerRows(db)).toHaveLength(1);expect(db.row<any>("SELECT SUM(cost_usd) AS cost,SUM(request_count) AS n FROM daily_stats")).toEqual({cost:2,n:1});await request("GET",null,"unused-key",TOKEN,"/video/generations/"+t.id);expect(ledgerRows(db)).toHaveLength(1);
  });
  it("accepts nested data.video_url without fetching or buffering video bytes",async()=>{const m=upstream();const t=await create();due(t.id);m.mockResolvedValue(Response.json({status:"SUCCESS",data:{video_url:"https://cdn.test/movie.mp4"}}));expect((await (await request("GET",null,"unused-key",TOKEN,"/video/generations/"+t.id)).json() as any).status).toBe("succeeded");expect(m).toHaveBeenCalledTimes(2);settled(8);});
  it.each([undefined,"http://cdn.test/x","https://user:pw@cdn.test/x","javascript:alert(1)","https://cdn.test/x#fragment"," https://cdn.test/x"])("does not charge a SUCCESS with unconfirmed URL %s",async(result)=>{const m=upstream();const t=await create();due(t.id);m.mockResolvedValue(Response.json({status:"SUCCESS",result_url:result}));const view=await (await request("GET",null,"unused-key",TOKEN,"/video/generations/"+t.id)).json() as any;expect(view.status).toBe("pending");expect(wallet(db)).toMatchObject({balance_usd:10,reserved_usd:2});expect(ledgerRows(db)).toEqual([]);});
  it("only configured terminal failure releases the hold with zero charge",async()=>{const m=upstream();const t=await create();due(t.id);m.mockResolvedValue(Response.json({status:"FAILED",error:{message:"private"}}));const res=await request("GET",null,"unused-key",TOKEN,"/video/generations/"+t.id);expect(await res.json()).toMatchObject({status:"failed",error_code:"upstream_generation_failed",cost_usd:0});settled(10);expect(usageRows(db)[0].cost_usd).toBe(0);});
  it.each(["UNKNOWN","CANCELED","RUNNING","success"])("unknown/unconfigured status %s keeps the hold",async status=>{const m=upstream();const t=await create();due(t.id);m.mockResolvedValue(Response.json({status}));expect((await (await request("GET",null,"unused-key",TOKEN,"/video/generations/"+t.id)).json() as any).status).toBe("pending");expect(wallet(db)?.reserved_usd).toBe(2);});
  it("query errors are not generation failures",async()=>{const m=upstream();const t=await create();due(t.id);m.mockRejectedValue(Error("network"));expect((await (await request("GET",null,"unused-key",TOKEN,"/video/generations/"+t.id)).json() as any).status).toBe("pending");expect(wallet(db)?.reserved_usd).toBe(2);expect(usageRows(db)).toEqual([]);});
  it.each([{id:"wrong-field"},{data:{task_id:""}},{data:{task_id:123}},{data:{task_id:".."}},{data:{task_id:"."}}])("never guesses the creation ID field %j",async reply=>{upstream(reply);const t=await create();expect(t.status).toBe("submission_unknown");await request();expect(calls).toHaveLength(1);expect(wallet(db)?.reserved_usd).toBe(2);});
  it("lost submission response retains reservation and never retries POST",async()=>{const m=upstream();m.mockRejectedValue(Error("network"));const t=await create();expect(t.status).toBe("submission_unknown");await request();expect(m).toHaveBeenCalledTimes(1);expect(wallet(db)?.reserved_usd).toBe(2);});
  it("HTTP rejection without documented semantics stays unconfirmed",async()=>{upstream({error:"unconfirmed"},400);expect((await create()).status).toBe("submission_unknown");expect(wallet(db)?.reserved_usd).toBe(2);});
  it("list is a bounded database-only snapshot; detail GET obeys poll throttle",async()=>{const m=upstream();const t=await create();const list=await request("GET");expect((await list.json() as any).data).toHaveLength(1);expect(m).toHaveBeenCalledTimes(1);await request("GET",null,"unused-key",TOKEN,"/video/generations/"+t.id);expect(m).toHaveBeenCalledTimes(1);});
  it("anonymous and different accounts cannot read tasks",async()=>{upstream();const t=await create();await seedDevice(db,{id:"other",token_hash:await sha256Hex("other-token")});expect((await request("GET",null,"unused-key","other-token","/video/generations/"+t.id)).status).toBe(404);expect((await request("GET",null,"unused-key","missing","/video/generations/"+t.id)).status).toBe(401);});
  it("sub-token tasks are scoped to their own token; owner can inspect",async()=>{upstream();for(const id of ["sub-a","sub-b"])db.sql("INSERT INTO device_sub_tokens (id,device_id,name,token_hash,created_at) VALUES (?,?,?,?,1)",id,DEVICE_ID,id,await sha256Hex(id));const r=await request("POST",input,"sub-key-0001","sub-a");expect(r.status).toBe(202);const t=await r.json() as any;expect((await request("GET",null,"unused-key","sub-b","/video/generations/"+t.id)).status).toBe(404);expect((await request("GET",null,"unused-key",TOKEN,"/video/generations/"+t.id)).status).toBe(200);expect((await (await request("GET",null,"unused-key","sub-b")).json() as any).data).toEqual([]);});
  it("sub-token filtering happens before the latest-30 task limit",async()=>{
    upstream(); const t=await create(); const sub="list-sub";
    db.sql("INSERT INTO device_sub_tokens (id,device_id,name,token_hash,created_at) VALUES (?,?,?,?,1)",sub,DEVICE_ID,sub,await sha256Hex(sub));
    db.sql("UPDATE video_tasks SET sub_token_id=?,created_at=1 WHERE id=?",sub,t.id);
    for(let i=0;i<35;i++) db.sql("INSERT INTO video_tasks (id,device_id,sub_token_id,idempotency_key,request_hash,status,route_json,price_usd,pricing_snapshot_json,created_at,updated_at) SELECT ?,device_id,NULL,?,request_hash,status,route_json,price_usd,pricing_snapshot_json,?,updated_at FROM video_tasks WHERE id=?","newer-"+i,"newer-key-"+i,i+2,t.id);
    const view=await (await request("GET",null,"unused-key",sub)).json() as any;
    expect(view.data.map((x:any)=>x.id)).toEqual([t.id]);
    expect((await (await request("GET")).json() as any).data).toHaveLength(30);
  });
  it("stale-reserve reaper does not release a live/unknown video hold",async()=>{upstream({bad:"id"});await create();db.sql("UPDATE reserve_holds SET created_at=1");await releaseStaleReserves(env);expect(wallet(db)?.reserved_usd).toBe(2);expect(holdRows(db)).toHaveLength(1);});
  it("cron marks interrupted submission unknown and polls pending jobs",async()=>{const m=upstream();const t=await create();due(t.id);m.mockResolvedValue(Response.json({status:"SUCCESS",result_url:"https://cdn.test/x.mp4"}));await pollVideoTasks(env);expect(db.row<any>("SELECT status FROM video_tasks WHERE id=?",t.id)?.status).toBe("succeeded");settled(8);});
  it("rejects low balance, disabled master calls and missing credentials before POST",async()=>{const m=upstream();db.sql("UPDATE device_wallets SET balance_usd=1");expect((await request()).status).toBe(402);db.sql("UPDATE device_wallets SET balance_usd=10");db.sql("UPDATE devices SET calls_enabled=0");expect((await request()).status).toBe(403);db.sql("UPDATE devices SET calls_enabled=1");env.ENCRYPTION_KEY="";expect((await request()).status).toBe(503);expect(m).not.toHaveBeenCalled();expect(holdRows(db)).toEqual([]);});
  it.each([{...input,stream:true},{...input,image:"https://cdn.test/i.png"},{...input,seconds:2},{...input,prompt:""},{...input,size:"4096x4096"}])("rejects invalid or unconfigured request %j",async body=>{const m=upstream();expect((await request("POST",body)).status).toBe(400);expect(m).not.toHaveBeenCalled();expect(holdRows(db)).toEqual([]);});
  it("requires idempotency key and enforces bounded request bytes",async()=>{const m=upstream();expect((await request("POST",input,"")).status).toBe(400);expect((await request("POST",{...input,prompt:"x".repeat(40000)})).status).toBe(413);expect(m).not.toHaveBeenCalled();});
  it("normal text endpoints reject video models",async()=>{const m=upstream();expect((await request("POST",{model:MODEL,messages:[{role:"user",content:"hi"}]},"unused-key",TOKEN,"/chat/completions")).status).toBe(400);expect(m).not.toHaveBeenCalled();});
  it("never falls back to default OpenAI endpoint for video",async()=>{const m=upstream();db.sql("UPDATE providers SET endpoint=NULL");expect((await request()).status).toBe(400);expect(m).not.toHaveBeenCalled();});
  it("supports zero-price free video without token fees",async()=>{upstream();db.sql("UPDATE models SET pricing_mode='free',price_per_call=99");db.sql("UPDATE device_wallets SET balance_usd=0");const t=await create();expect(t.price_per_call).toBe(0);});
  it("fixed model pools and fixed service groups reserve their quote and never POST a fallback",async()=>{
    seedModel(db,{id:"video-second",model_name:"channel-2",billing_unit:"call",price_per_call:4,input_price_per_m:0,output_price_per_m:0,config_json:JSON.stringify(cfg)});
    seedGroup(db,{id:"video-pool",name:"video-pool",billing_unit:"call",price_per_call:3,input_price_per_m:0,output_price_per_m:0,config_json:JSON.stringify(cfg)});
    seedGroupMembers(db,"video-pool",["model_a","video-second"]);
    const sg=await createServiceGroup(env,{name:"fixed-video",enabled:1,selectable:1,public_selectable:1});
    await upsertServiceGroupModel(env,sg.id,{model_key:MODEL,target_type:"group",target_id:"video-pool"});
    db.sql("UPDATE devices SET service_group_id=?",sg.id);
    const m=upstream();m.mockRejectedValue(Error("unconfirmed dispatch"));
    const t=await create();expect(t).toMatchObject({status:"submission_unknown",price_per_call:3});expect(m).toHaveBeenCalledTimes(1);expect(wallet(db)?.reserved_usd).toBe(3);
  });
  it("Auto preserves video type and safe public limits without exposing adapter config", async()=>{
    const group=await createServiceGroup(env,{name:"Video",enabled:1,selectable:1,public_selectable:1});
    await upsertServiceGroupModel(env,group.id,{model_key:MODEL,target_type:"model",target_id:"model_a",member_ids_json:null,pricing_json:null});
    db.sql("UPDATE devices SET service_group_id='auto'");
    const catalog=await request("GET",null,"unused-key",TOKEN,"/models");
    const entries=(await catalog.json() as any).data;
    expect(entries.find((x:any)=>x.id===MODEL)).toMatchObject({model_type:"video",chat_endpoint:"/v1/video/generations",video:{sizes:cfg.video.sizes,seconds_min:3,seconds_max:15}});
    expect(JSON.stringify(entries)).not.toMatch(/task_id_path|adapter|failed_statuses|private-provider-key/);
    upstream(); expect((await create()).status).toBe("pending");
  });
  it("Auto without service offers calls a catalogued authorized legacy video model exactly once",async()=>{
    db.sql("UPDATE devices SET service_group_id='auto'");
    const m=upstream(); const list=await request("GET",null,"unused-key",TOKEN,"/models");
    expect((await list.json() as any).data.some((r:any)=>r.id===MODEL)).toBe(true);
    const task=await create(); expect(task.status).toBe("pending"); await request();
    expect(m).toHaveBeenCalledTimes(1); expect(holdRows(db)).toHaveLength(1);
  });
  it("account Auto inherited by a sub-token uses the authorized legacy group quote and settles once",async()=>{
    db.sql("UPDATE models SET model_name='private-video-member'");
    seedGroup(db,{id:"legacy-video",name:MODEL,billing_unit:"call",price_per_call:1.8,input_price_per_m:0,output_price_per_m:0,model_public:0,config_json:JSON.stringify(cfg)});
    seedGroupMembers(db,"legacy-video",["model_a"]); seedDeviceGroups(db,["legacy-video"]);
    db.sql("UPDATE devices SET model_scope='list',default_service_group_id='auto',service_group_id=NULL");
    const sub="inherit-auto-video"; db.sql("INSERT INTO device_sub_tokens (id,device_id,name,token_hash,created_at) VALUES (?,?,?,?,1)",sub,DEVICE_ID,sub,await sha256Hex(sub));
    const m=upstream(); const result=await request("POST",input,"inherit-video-key",sub); expect(result.status).toBe(202);
    const task=await result.json() as any; expect(task.price_per_call).toBe(1.8); due(task.id);
    m.mockResolvedValue(Response.json({status:"SUCCESS",result_url:"https://cdn.test/video.mp4"}));
    const view=await request("GET",null,"unused-key",sub,"/video/generations/"+task.id); expect((await view.json() as any).cost_usd).toBe(1.8);
    await request("POST",input,"inherit-video-key",sub); settled(8.2); expect(ledgerRows(db)).toHaveLength(1);
    expect(db.rows("SELECT sub_token_id,cost_usd FROM usage")).toMatchObject([{sub_token_id:sub,cost_usd:1.8}]); expect(calls.filter(c=>c.method==="POST")).toHaveLength(1);
  });
  it("Auto legacy fallback still rejects an ungranted private group before dispatch",async()=>{
    db.sql("UPDATE models SET model_name='private-video-member'");
    seedGroup(db,{id:"private-video",name:MODEL,model_public:0,billing_unit:"call",price_per_call:2,input_price_per_m:0,output_price_per_m:0,config_json:JSON.stringify(cfg)});
    seedGroupMembers(db,"private-video",["model_a"]);db.sql("UPDATE devices SET model_scope='list',service_group_id='auto'");
    const m=upstream(); expect((await request()).status).toBe(403);expect(m).not.toHaveBeenCalled();expect(holdRows(db)).toEqual([]);
  });
  it("Auto still rejects a missing legacy video model without reservation",async()=>{
    db.sql("UPDATE devices SET service_group_id='auto'"); const m=upstream();
    expect((await request("POST",{...input,model:"missing-video"})).status).toBe(404);expect(m).not.toHaveBeenCalled();expect(holdRows(db)).toEqual([]);
  });
  it("fixed service selection never escapes to an unmapped legacy video model",async()=>{
    const sg=await createServiceGroup(env,{name:"empty-fixed-video",public_selectable:1});db.sql("UPDATE devices SET service_group_id=?",sg.id);
    const m=upstream();expect((await request()).status).toBe(404);expect(m).not.toHaveBeenCalled();expect(holdRows(db)).toEqual([]);
  });
  it("allows the Idempotency-Key browser preflight header",async()=>{const res=await gatewayApp.request("https://gw.test/video/generations",{method:"OPTIONS"},env);expect(res.headers.get("access-control-allow-headers")).toContain("Idempotency-Key");});
});
