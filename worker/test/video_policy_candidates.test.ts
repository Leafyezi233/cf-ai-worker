import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway";
import { ensureSchema } from "../src/db/schema";
import { DEFAULT_ROUTING_POLICY, putTokenRoutingPolicy } from "../src/db/token_policies";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import type { Env, TokenRoutingPolicy } from "../src/types";
import type { VideoRequest } from "../src/gateway/video";
import { createRealD1, makeEnv, seedDevice, seedModel, seedProvider, seedGroup, seedGroupMembers,
  seedDeviceModels, wallet, holdRows, TOKEN, DEVICE_ID, type RealD1 } from "./helpers/realGatewayEnv";

const input: VideoRequest = { model:"public-video", prompt:"A quiet river", seconds:8, size:"1920x1080" };
const auth = { authorization:"Bearer " + TOKEN };
type Limits = { sizes?:string[]; seconds_min?:number; seconds_max?:number; references?:number };
function config(limits: Limits = {}) {
  return JSON.stringify({ model_type:"video", video:{ adapter:"moyuu", task_id_path:"data.task_id",
    sizes:limits.sizes ?? [input.size], seconds_min:limits.seconds_min ?? 3, seconds_max:limits.seconds_max ?? 15,
    ...(limits.references ? { reference_images:{mapping:"image_images_url",max_images:limits.references} } : {}) } });
}
class MemoryR2 {
  objects = new Map<string, Uint8Array>();
  async put(key:string, body:ReadableStream<Uint8Array>) { const bytes=new Uint8Array(await new Response(body).arrayBuffer()); this.objects.set(key,bytes); return {size:bytes.length}; }
  async get(key:string) { const bytes=this.objects.get(key); return bytes ? {size:bytes.length,body:new Blob([bytes]).stream()} : null; }
  async delete(key:string) { this.objects.delete(key); }
}
let db:RealD1, env:Env;
function model(id:string, limits:Limits = {}, price=1, name=id, alias:string|null=null) {
  seedModel(db,{ id, model_name:name, alias, billing_unit:"call", price_per_call:price,
    input_price_per_m:0, output_price_per_m:0, config_json:config(limits) });
}
function group(id:string, members:string[], limits:Limits = {}, price=7) {
  seedGroup(db,{ id, name:id, billing_unit:"call", price_per_call:price,
    input_price_per_m:0, output_price_per_m:0, config_json:config(limits) });
  seedGroupMembers(db,id,members);
}
function offer(id:string, target:string, price:number, members?:string[], targetType:"model"|"group"="model") {
  db.sql("INSERT INTO service_groups(id,name,enabled,selectable,public_selectable,multiplier,revision) VALUES(?,?,1,1,1,1,1)",id,id);
  db.sql("INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id,pricing_json,member_ids_json) VALUES(?,?,?,?,?,?,?)",
    "map-"+id,id,input.model,targetType,target,JSON.stringify({price_per_call:price}),members ? JSON.stringify(members) : null);
  db.sql("INSERT OR IGNORE INTO public_model_identities(id,name,enabled) VALUES('video-identity',?,1)",input.model);
}
async function policy(patch:Partial<TokenRoutingPolicy>) {
  await putTokenRoutingPolicy(env,DEVICE_ID,"master",{...structuredClone(DEFAULT_ROUTING_POLICY),...patch});
}
function submit(body:VideoRequest=input, key="video-policy-key-0001") {
  return gatewayApp.request("https://gw.test/video/generations",{method:"POST",headers:{...auth,"content-type":"application/json","Idempotency-Key":key},body:JSON.stringify(body)},env);
}
function upstream(fail=false) {
  return vi.spyOn(globalThis,"fetch").mockImplementation(async()=>{
    if(fail) throw Error("simulated lost response");
    return Response.json({data:{task_id:"accepted-once"}});
  });
}
function assertSelected(mock:ReturnType<typeof upstream>, groupId:string|null, upstreamModel:string, price:number) {
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock.mock.calls[0][1]?.method).toBe("POST");
  expect(JSON.parse(String(mock.mock.calls[0][1]?.body)).model).toBe(upstreamModel);
  const task=db.row<{route_json:string;pricing_snapshot_json:string;price_usd:number}>("SELECT route_json,pricing_snapshot_json,price_usd FROM video_tasks")!;
  expect(JSON.parse(task.route_json)).toMatchObject({service_group_id:groupId,upstream_model:upstreamModel});
  expect(JSON.parse(task.pricing_snapshot_json)).toMatchObject({service_group_id:groupId,price_per_call:price,price_usd:price});
  expect(task.price_usd).toBe(price);
  expect(wallet(db)).toMatchObject({balance_usd:100,reserved_usd:price});
  expect(holdRows(db)).toHaveLength(1);
  expect(db.rows("SELECT id FROM video_tasks")).toHaveLength(1);
}
async function assertRejected(response:Response, mock:ReturnType<typeof upstream>, error:string) {
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({dispatch:"not_started",error});
  expect(mock).not.toHaveBeenCalled();
  expect(holdRows(db)).toEqual([]);
  expect(wallet(db)?.reserved_usd).toBe(0);
  expect(db.rows("SELECT id FROM video_tasks")).toEqual([]);
}
async function references(count=2) {
  const ids:string[]=[];
  for(let i=0;i<count;i++) {
    const bytes=new Uint8Array(64); bytes.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
    const view=new DataView(bytes.buffer); view.setUint32(16,32); view.setUint32(20,24); bytes[24]=8; bytes[25]=6;
    const response=await gatewayApp.request("https://gw.test/video/reference-images",{method:"POST",headers:{...auth,"content-type":"image/png","content-length":String(bytes.length)},body:bytes},env);
    expect(response.status).toBe(201); ids.push((await response.json() as {id:string}).id);
  }
  return ids;
}
const mismatches: {name:string;limits:Limits;error:string}[] = [
  {name:"size",limits:{sizes:["1280x720"]},error:"video_spec_not_allowed"},
  {name:"seconds",limits:{seconds_max:5},error:"video_spec_not_allowed"},
  {name:"reference count",limits:{references:1},error:"video_references_not_allowed"},
];
beforeEach(async()=>{
  resetRateLimitMemory(); db=createRealD1(); env=makeEnv(db); env.ENCRYPTION_KEY="video-policy-test-key";
  env.VIDEO_REFERENCES=new MemoryR2() as unknown as R2Bucket;
  await seedDevice(db,{balance_usd:100}); await ensureSchema(env);
  seedProvider(db,{endpoint:"https://video-policy.test/v1",api_key:"local-stub-only"});
});

afterEach(()=>{vi.restoreAllMocks();db.close();});

describe("video pre-dispatch authorized policy candidates (real SQLite, fetch stub only)",()=>{
  for(const mode of ["auto","multi"] as const) for(const selection of ["ordered","input_price"] as const) {
    it.each(mismatches)(mode+" "+selection+" skips incompatible $name offer and freezes first compatible quote",async({limits,name})=>{
      model("bad",limits); model("good",{references:3}); model("other",{references:3});
      offer("bad-offer","bad",1); offer("good-offer","good",selection==="ordered" ? 4 : 2); offer("other-offer","other",3);
      await policy({mode,selection,group_ids:mode==="multi" ? (selection==="ordered" ? ["bad-offer","good-offer","other-offer"] : ["other-offer","good-offer","bad-offer"]) : []});
      if(mode==="auto") db.sql("UPDATE service_groups SET name=CASE id WHEN 'bad-offer' THEN '1' WHEN 'good-offer' THEN '2' ELSE '3' END");
      const body={...input,...(name==="reference count" ? {reference_image_ids:await references()} : {})};
      const mock=upstream(); const response=await submit(body); expect(response.status).toBe(202);
      assertSelected(mock,"good-offer","good",selection==="ordered" ? 4 : 2);
      expect((await submit(body)).status).toBe(200); expect(mock).toHaveBeenCalledTimes(1); expect(holdRows(db)).toHaveLength(1);
    });
  }
  it.each(mismatches)("all incompatible $name offers reject without same-name legacy escape",async({limits,name,error})=>{
    model("bad",limits); model("legacy",{references:3},1,input.model); offer("selected","bad",2);
    await policy({mode:"multi",group_ids:["selected"],failure_fallback:true});
    const mock=upstream(); await assertRejected(await submit({...input,...(name==="reference count" ? {reference_image_ids:await references()} : {})}),mock,error);
  });
  it("fixed selection cannot escape to another compatible group or legacy",async()=>{
    model("bad",{seconds_max:5}); model("good"); model("legacy",{},1,input.model);
    offer("fixed","bad",2); offer("outside","good",1); await policy({mode:"fixed",group_ids:["fixed"],failure_fallback:true});
    const mock=upstream(); await assertRejected(await submit(),mock,"video_spec_not_allowed");
  });
  it("multi selection cannot add a compatible unselected group",async()=>{
    model("bad",{seconds_max:5}); model("good"); offer("selected","bad",2); offer("outside","good",1);
    await policy({mode:"multi",group_ids:["selected"]}); const mock=upstream();
    await assertRejected(await submit(),mock,"video_spec_not_allowed");
  });
  it("account target grants exclude a compatible service offer before spec filtering",async()=>{
    model("bad",{seconds_max:5}); model("private-good"); db.sql("UPDATE models SET model_public=0 WHERE id='private-good'");
    db.sql("UPDATE devices SET model_scope='list'"); seedDeviceModels(db,["bad"]);
    offer("selected","bad",2); offer("denied","private-good",1); await policy({mode:"multi",group_ids:["selected","denied"]});
    const mock=upstream(); expect((await submit()).status).toBe(503);
    expect(mock).not.toHaveBeenCalled(); expect(holdRows(db)).toEqual([]); expect(wallet(db)?.reserved_usd).toBe(0);
  });
  it("token scope cannot be widened by compatible service or legacy candidates",async()=>{
    model("good",{},1,input.model); offer("selected","good",1);
    await policy({mode:"multi",group_ids:["selected"],model_scope:[]}); const mock=upstream();
    expect((await submit()).status).toBe(503); expect(mock).not.toHaveBeenCalled(); expect(holdRows(db)).toEqual([]);
  });
  it("a lost POST response never dispatches the next compatible offer, even with fallback enabled",async()=>{
    model("first"); model("second"); offer("first-offer","first",4); offer("second-offer","second",2);
    await policy({mode:"multi",group_ids:["first-offer","second-offer"],failure_fallback:true});
    const mock=upstream(true); const response=await submit(); expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({status:"submission_unknown"}); assertSelected(mock,"first-offer","first",4);
    expect((await submit()).status).toBe(200); expect(mock).toHaveBeenCalledTimes(1); expect(holdRows(db)).toHaveLength(1);
  });
  it.each(mismatches)("legacy group skips incompatible $name member but reserves only group quote",async({limits,name})=>{
    model("first",limits); model("second",{references:3},2); group("legacy-pool",["first","second"],{references:3});
    db.sql("UPDATE model_groups SET config_json=? WHERE id='legacy-pool'",JSON.stringify({...JSON.parse(config({references:3})),model_rewrite:"pool-upstream"}));
    await policy({mode:"legacy"}); const mock=upstream();
    expect((await submit({...input,model:"legacy-pool",...(name==="reference count" ? {reference_image_ids:await references()} : {})})).status).toBe(202);
    assertSelected(mock,null,"pool-upstream",7);
    expect(JSON.parse(db.row<{route_json:string}>("SELECT route_json FROM video_tasks")!.route_json).provider_id).toBe("prov_a");
  });
  it.each(mismatches)("legacy group with all incompatible $name members rejects before reserving",async({limits,name,error})=>{
    model("first",limits); model("second",limits); group("legacy-pool",["first","second"],{references:3});
    await policy({mode:"legacy"}); const mock=upstream();
    await assertRejected(await submit({...input,model:"legacy-pool",...(name==="reference count" ? {reference_image_ids:await references()} : {})}),mock,error);
  });
  it("legacy same-name models filter specs only within account and token authorized candidates",async()=>{
    model("a-bad",{seconds_max:5},1,input.model); model("b-good",{},3,input.model); model("c-denied",{},1,input.model);
    db.sql("UPDATE models SET model_public=0 WHERE id='c-denied'"); db.sql("UPDATE devices SET model_scope='list'"); seedDeviceModels(db,["a-bad","b-good"]);
    await policy({mode:"legacy",model_scope:["model:a-bad","model:b-good"]}); const mock=upstream();
    expect((await submit()).status).toBe(202); assertSelected(mock,null,input.model,3);
    expect(JSON.parse(db.row<{pricing_snapshot_json:string}>("SELECT pricing_snapshot_json FROM video_tasks")!.pricing_snapshot_json).policy_version).toBe("account:0/master:1");
  });
  it.each(["account","token"])("legacy spec filtering cannot escape the %s scope",async(scope)=>{
    model("a-bad",{seconds_max:5},1,input.model); model("b-good",{},3,input.model);
    if(scope==="account") { db.sql("UPDATE models SET model_public=0"); db.sql("UPDATE devices SET model_scope='list'"); seedDeviceModels(db,["a-bad"]); }
    await policy({mode:"legacy",model_scope:scope==="token" ? ["model:a-bad"] : null}); const mock=upstream();
    await assertRejected(await submit(),mock,"video_spec_not_allowed");
  });
  it("legacy group billing limits cannot be widened by a more capable member",async()=>{
    model("wide"); group("legacy-pool",["wide"],{seconds_max:5}); await policy({mode:"legacy"}); const mock=upstream();
    await assertRejected(await submit({...input,model:"legacy-pool"}),mock,"video_spec_not_allowed");
  });
  const heterogeneousSpecs = [
    {name:"size", bad:{sizes:["1280x720"]} as Limits, body:{}},
    {name:"seconds", bad:{seconds_max:5} as Limits, body:{}},
    {name:"ref_count", bad:{references:1} as Limits, body:{reference_image_ids:"refs"}},
  ] as const;

  for (const mode of ["fixed","auto","multi"] as const) for (const spec of heterogeneousSpecs) {
    it(mode+" skips a structurally valid heterogeneous member incompatible with request "+spec.name+" and freezes the group quote",async()=>{
      model("bad",spec.bad); model("good",{references:3});
      const pool="hetero-"+mode+"-"+spec.name;
      group(pool,["bad","good"],{references:3},6);
      offer("hetero-offer",pool,6,["bad","good"],"group");
      await policy({mode,selection:"ordered",group_ids:mode==="auto" ? [] : ["hetero-offer"]});
      const body={...input,...(spec.name === "ref_count" ? {reference_image_ids:await references(3)} : {})};
      const mock=upstream(); const response=await submit(body); expect(response.status).toBe(202);
      assertSelected(mock,"hetero-offer","good",6);
      expect((await submit(body)).status).toBe(200); expect(mock).toHaveBeenCalledTimes(1); expect(holdRows(db)).toHaveLength(1);
    });
  }

  it("all heterogeneous members incompatible fail closed without POST or hold",async()=>{
    model("bad",{seconds_max:5}); model("also-bad",{sizes:["1280x720"]});
    group("hetero-all-bad",["bad","also-bad"],{references:3},6);
    offer("hetero-all-bad-offer","hetero-all-bad",6,["bad","also-bad"],"group");
    await policy({mode:"multi",group_ids:["hetero-all-bad-offer"]});
    const mock=upstream(); const response=await submit();
    expect([400,404,503]).toContain(response.status); expect(mock).not.toHaveBeenCalled();
    expect(holdRows(db)).toEqual([]); expect(wallet(db)?.reserved_usd).toBe(0); expect(db.rows("SELECT id FROM video_tasks")).toEqual([]);
  });

  it("malformed heterogeneous member configuration fails closed before dispatch",async()=>{
    model("bad"); model("good",{references:3});
    db.sql("UPDATE models SET config_json=? WHERE id='bad'", "{\"model_type\":\"video\",\"video\":");
    group("hetero-malformed",["bad","good"],{references:3},6);
    offer("hetero-malformed-offer","hetero-malformed",6,["bad","good"],"group");
    await policy({mode:"multi",group_ids:["hetero-malformed-offer"]});
    const mock=upstream(); const response=await submit();
    expect([400,404,503]).toContain(response.status); expect(mock).not.toHaveBeenCalled();
    expect(holdRows(db)).toEqual([]); expect(wallet(db)?.reserved_usd).toBe(0); expect(db.rows("SELECT id FROM video_tasks")).toEqual([]);
  });

});