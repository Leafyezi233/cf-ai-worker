import { describe, expect, it } from "vitest";
import { makeWalletFixture } from "./helpers/walletFixture";
import { claimVideoPoll, createVideoTask, finishVideoPoll, getVideoTask, markVideoSubmission, type VideoTask } from "../src/db/video_tasks";
import { ensureSchema, SCHEMA_DEFINITION, resetSchemaCache } from "../src/db/schema";
import { migrateVersionedSchema } from "../src/db/schema_versions";
import { createRealD1 } from "./helpers/realD1";
import type { Env } from "../src/types";
async function fixture() {
  const f = await makeWalletFixture({deviceIds:["dev"]});
  f.d1.sql("INSERT INTO device_wallets VALUES ('dev',100,0,1,1)");
  const now=Date.now(), id="vid_"+crypto.randomUUID();
  const t:VideoTask={id,device_id:"dev",sub_token_id:null,idempotency_key:id,request_hash:"hash",status:"submitting",upstream_task_id:null,route_json:JSON.stringify({provider_id:"p",model:"public-video"}),price_usd:2,pricing_snapshot_json:"{}",result_url:null,error_code:null,poll_after:null,poll_lease_until:null,created_at:now,updated_at:now};
  expect(await createVideoTask(f.env,t)).toBe(true);await markVideoSubmission(f.env,id,"supplier-task");
  const claim=(await claimVideoPoll(f.env,id,now))!;
  return {...f,id,claim,now};
}
describe("separate durable video usage evidence",()=>{
  it("stores original usage with the terminal sale once, never as text tokens",async()=>{
    const f=await fixture();
    await finishVideoPoll(f.env,f.id,{status:"succeeded",result_url:"https://download.example/video",upstream_usage_json:'{"completion_tokens":200,"total_tokens":250}'},f.claim);
    expect((await getVideoTask(f.env,f.id))?.upstream_usage_json).toBe('{"completion_tokens":200,"total_tokens":250}');
    const settled=f.d1.rows("SELECT * FROM video_tasks");
    await finishVideoPoll(f.env,f.id,{status:"failed",upstream_usage_json:'{"total_tokens":999}'},f.claim);
    expect(f.d1.rows("SELECT * FROM video_tasks")).toEqual(settled);
    expect(f.d1.row("SELECT balance_usd,reserved_usd FROM device_wallets WHERE device_id='dev'")).toEqual({balance_usd:98,reserved_usd:0});
    expect(f.d1.rows("SELECT cost_usd,input_tokens,output_tokens FROM usage")).toEqual([{cost_usd:2,input_tokens:0,output_tokens:0}]);
    expect(f.d1.rows("SELECT * FROM wallet_ledger")).toHaveLength(1);
  });
  it("retains known pending usage across missing later usage; a stale lease cannot change it",async()=>{
    const f=await fixture();
    await finishVideoPoll(f.env,f.id,{status:"pending",upstream_usage_json:'{"total_tokens":17}'},f.claim);
    const next=(await claimVideoPoll(f.env,f.id,f.now+60000))!;
    expect(next).toEqual(expect.any(String));
    await finishVideoPoll(f.env,f.id,{status:"succeeded",result_url:"https://download.example/video",upstream_usage_json:'{"total_tokens":999}'},f.claim);
    expect((await getVideoTask(f.env,f.id))?.upstream_usage_json).toBe('{"total_tokens":17}');
    await finishVideoPoll(f.env,f.id,{status:"succeeded",result_url:"https://download.example/video"},next);
    expect((await getVideoTask(f.env,f.id))?.upstream_usage_json).toBe('{"total_tokens":17}');
  });
  it.each(['{}','[]','{"total_tokens":-1}','{"total_tokens":1.5}','{"total_tokens":9007199254740992}','{"total_tokens":1,"url":"https://secret.example"}','null'])('refuses invalid evidence %s without writes',async raw=>{
    const f=await fixture();const before=f.d1.rows("SELECT * FROM video_tasks");
    await expect(finishVideoPoll(f.env,f.id,{status:"succeeded",result_url:"https://download.example/video",upstream_usage_json:raw},f.claim)).rejects.toThrow();
    expect(f.d1.rows("SELECT * FROM video_tasks")).toEqual(before);
    expect(f.d1.rows("SELECT * FROM wallet_ledger")).toHaveLength(0);
  });
  it("rolls back evidence together with a failed financial batch, then same lease settles once",async()=>{
    const f=await fixture();const batch=f.env.DB.batch.bind(f.env.DB);
    f.d1.sql("CREATE TABLE fail_usage(n INTEGER CHECK(n=0))");
    f.env.DB.batch=(async ss=>batch([...ss,f.env.DB.prepare("INSERT INTO fail_usage VALUES(1)")])) as typeof f.env.DB.batch;
    await expect(finishVideoPoll(f.env,f.id,{status:"succeeded",result_url:"https://download.example/video",upstream_usage_json:'{"total_tokens":33}'},f.claim)).rejects.toThrow();
    expect((await getVideoTask(f.env,f.id))?.upstream_usage_json).toBeNull();
    expect(f.d1.rows("SELECT * FROM wallet_ledger")).toHaveLength(0);f.env.DB.batch=batch;
    await finishVideoPoll(f.env,f.id,{status:"succeeded",result_url:"https://download.example/video",upstream_usage_json:'{"total_tokens":33}'},f.claim);
    expect((await getVideoTask(f.env,f.id))?.upstream_usage_json).toBe('{"total_tokens":33}');
  });
  it("adds exactly one stage to the existing ten-stage DB without rewriting prior claims; old version rejects",async()=>{
    const d=createRealD1({init:[],alters:[]});try{
      const old={...SCHEMA_DEFINITION,extensions:SCHEMA_DEFINITION.extensions.slice(0,-1)};
      await migrateVersionedSchema(d.DB,old);
      const before=d.rows("SELECT * FROM cpg_schema_versions ORDER BY id");expect(before).toHaveLength(10);
      await ensureSchema({DB:d.DB} as Env);
      expect(d.rows("SELECT * FROM cpg_schema_versions WHERE id <> 'video/0001-upstream-usage' ORDER BY id")).toEqual(before);
      expect(d.rows("PRAGMA table_info(video_tasks)").some(x=>x.name==="upstream_usage_json")).toBe(true);
      await expect(migrateVersionedSchema(d.DB,old)).rejects.toThrow(/Unknown core schema version/);
    }finally{resetSchemaCache(d.DB);d.close();}
  });
});
