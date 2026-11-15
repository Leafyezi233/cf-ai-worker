import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedDevice, Env } from "../src/types";
import type { VideoTask } from "../src/db/video_tasks";
import { createVideoTask } from "../src/db/video_tasks";
import { INIT_STATEMENTS, MIGRATION_ALTERS } from "../src/db/schema";
import {
  backfillVideoReferenceCleanup, completeVideoReferenceWrite, discardVideoReferenceAsset,
  finishVideoReferenceAsset, getVideoReferenceAsset, markVideoReferenceUploadUncertain,
  pruneVideoReferenceAssets, reserveVideoReferenceAsset, VIDEO_REFERENCE_DUE_SQL,
  VIDEO_REFERENCE_MAX_BYTES, VIDEO_REFERENCE_TOMBSTONES_SQL, videoReferenceRetryDelay
} from "../src/db/video_reference_assets";
import { makeWalletFixture } from "./helpers/walletFixture";
import { createRealD1 } from "./helpers/realD1";

afterEach(()=>vi.useRealTimers());
const device = {id:"dev-1",auth_via:"master",sub_token_id:null} as AuthedDevice;
async function setup() {
  const f = await makeWalletFixture();
  const objects = new Set<string>();
  const remove = vi.fn(async (key:string)=>{objects.delete(key);});
  f.env.VIDEO_REFERENCES = {delete:remove} as unknown as R2Bucket;
  return {...f,objects,remove};
}
async function reserved(f:Awaited<ReturnType<typeof setup>>) {
  const a=await reserveVideoReferenceAsset(f.env,device,"image/png");expect(a).not.toBeNull();return a!;
}
async function ready(f:Awaited<ReturnType<typeof setup>>) {
  const a=await reserved(f);f.objects.add(a.object_key);
  await completeVideoReferenceWrite(f.env,a,true);
  expect(await finishVideoReferenceAsset(f.env,a,64,32,24,null)).toBe(true);
  return (await getVideoReferenceAsset(f.env,a.id))!;
}
function task(ids:string[],patch:Partial<VideoTask>={}):VideoTask {
  const id=crypto.randomUUID();return {id,device_id:device.id,sub_token_id:null,idempotency_key:id,request_hash:"hash",status:"submitting",
    upstream_task_id:null,route_json:JSON.stringify({reference_image_ids:ids}),price_usd:0,pricing_snapshot_json:"{}",result_url:null,
    error_code:null,poll_after:null,poll_lease_until:null,created_at:Date.now(),updated_at:Date.now(),...patch};
}
function seed(f:Awaited<ReturnType<typeof setup>>,id:string,state="ready",outcome="confirmed",created=Date.now()-7200000) {
  f.d1.sql("INSERT INTO video_reference_assets(id,device_id,object_key,content_type,size_bytes,state,created_at,updated_at,expires_at,upload_lease_until,upload_token,write_outcome) " +
    "VALUES (?,'dev-1',?,'image/png',?,?,?,?,1,0,?,?)",id,"video-references/"+id,VIDEO_REFERENCE_MAX_BYTES,state,created,created,"token-"+id,outcome);
}
async function flush() {for(let i=0;i<100;i++)await Promise.resolve();}

describe("durable reference cleanup and physical-capacity safety",()=>{
  it("records intent before PUT and refuses ready without confirmed same-owner live write",async()=>{
    const f=await setup();const a=await reserved(f);
    expect(f.d1.row("SELECT object_key,next_attempt_at FROM video_reference_cleanup WHERE asset_id=?",a.id))
      .toEqual({object_key:a.object_key,next_attempt_at:a.upload_lease_until});
    expect(await finishVideoReferenceAsset(f.env,a,64,1,1,null)).toBe(false);
    const wrong={...a,upload_token:"not-the-owner"};
    await completeVideoReferenceWrite(f.env,wrong,true);await markVideoReferenceUploadUncertain(f.env,wrong);
    expect((await getVideoReferenceAsset(f.env,a.id))!).toMatchObject({write_outcome:"pending",cancelled_at:null});
    await completeVideoReferenceWrite(f.env,a,true);
    expect(await finishVideoReferenceAsset(f.env,wrong,64,1,1,null)).toBe(false);
    expect(await finishVideoReferenceAsset(f.env,a,64,1,1,null)).toBe(true);
    expect(await finishVideoReferenceAsset(f.env,a,64,1,1,null)).toBe(false);
  });
  it("discard does not act on a wrong upload owner or an already-bound task even when due",async()=>{
    const f=await setup();const a=await ready(f);
    f.d1.sql("UPDATE video_reference_assets SET expires_at=1 WHERE id=?",a.id);
    expect(await discardVideoReferenceAsset(f.env,{...a,upload_token:"wrong-owner"})).toBe(false);
    expect(f.remove).not.toHaveBeenCalled();
    f.d1.sql("UPDATE video_reference_assets SET expires_at=? WHERE id=?",Date.now()+100000,a.id);
    const t=task([a.id]);await createVideoTask(f.env,t,undefined,[a.id]);
    f.d1.sql("UPDATE video_reference_assets SET created_at=? WHERE id=?",Date.now()-8*86400000,a.id);
    expect(await discardVideoReferenceAsset(f.env,a)).toBe(false);expect(f.remove).not.toHaveBeenCalled();
  });
  it("counts only live logical leases, while expired unresolved bytes still count physically",async()=>{
    const f=await setup();const a=await reserved(f);const b=await reserved(f);
    expect(await reserveVideoReferenceAsset(f.env,device,"image/png")).toBeNull();
    f.d1.sql("UPDATE video_reference_assets SET upload_lease_until=0 WHERE id IN (?,?)",a.id,b.id);
    expect(await reserveVideoReferenceAsset(f.env,device,"image/png")).not.toBeNull();
    expect((await getVideoReferenceAsset(f.env,a.id))!.size_bytes).toBe(VIDEO_REFERENCE_MAX_BYTES);
  });
  it("enforces 100MiB physical and 20/hour independently, including unknown deleted legacy rows",async()=>{
    const f=await setup();for(let i=0;i<20;i++)seed(f,"quota"+i,"lost","unknown");
    expect(await reserveVideoReferenceAsset(f.env,device,"image/png")).toBeNull();
    f.d1.sql("UPDATE video_reference_assets SET state='deleted' WHERE id='quota0'");
    expect(await reserveVideoReferenceAsset(f.env,device,"image/png")).toBeNull();  
    f.d1.sql("UPDATE video_reference_assets SET write_outcome='absent' WHERE id='quota0'");
    expect(await reserveVideoReferenceAsset(f.env,device,"image/png")).not.toBeNull();
    f.d1.sql("UPDATE video_reference_assets SET created_at=?,size_bytes=1,state='deleted',write_outcome='absent'",Date.now());
    expect(await reserveVideoReferenceAsset(f.env,device,"image/png")).toBeNull();  
  });
  it.each(["pending","unknown"] as const)("successful delete cannot free an unresolved %s write",async(outcome)=>{
    const f=await setup();const a=await reserved(f);
    if(outcome==="unknown")await markVideoReferenceUploadUncertain(f.env,a);
    expect(await discardVideoReferenceAsset(f.env,a)).toBe(false);
    expect((await getVideoReferenceAsset(f.env,a.id))!).toMatchObject({state:"lost",size_bytes:VIDEO_REFERENCE_MAX_BYTES,write_outcome:outcome});
    expect(f.d1.row<{n:number}>("SELECT COUNT(*) n FROM video_reference_cleanup WHERE asset_id=?",a.id)!.n).toBe(1);
    expect(f.d1.row<{next_attempt_at:number}>("SELECT next_attempt_at FROM video_reference_cleanup WHERE asset_id=?",a.id)!.next_attempt_at).toBeGreaterThan(Date.now());
  });
  it.each([true,false])("late PUT settlement %s requeues cleanup after earlier delete, never ready",async(stored)=>{
    const f=await setup();const a=await reserved(f);await markVideoReferenceUploadUncertain(f.env,a);
    expect(await discardVideoReferenceAsset(f.env,a)).toBe(false);
    if(stored)f.objects.add(a.object_key);  
    await completeVideoReferenceWrite(f.env,a,stored);
    expect(await finishVideoReferenceAsset(f.env,a,64,1,1,null)).toBe(false);
    expect((await getVideoReferenceAsset(f.env,a.id))!).toMatchObject({state:"lost",write_outcome:stored?"confirmed":"absent"});
    expect(await pruneVideoReferenceAssets(f.env)).toBe(1);expect(f.objects.has(a.object_key)).toBe(false);
    expect((await getVideoReferenceAsset(f.env,a.id))!.state).toBe("deleted");
    await completeVideoReferenceWrite(f.env,a,stored);await markVideoReferenceUploadUncertain(f.env,a);
    expect((await getVideoReferenceAsset(f.env,a.id))!.state).toBe("deleted");
  });
  it("settlement is idempotent and late success after an expired lease cannot publish",async()=>{
    const f=await setup();const a=await reserved(f);
    f.d1.sql("UPDATE video_reference_assets SET upload_lease_until=0 WHERE id=?",a.id);
    await completeVideoReferenceWrite(f.env,a,true);
    expect(await finishVideoReferenceAsset(f.env,a,64,1,1,null)).toBe(false);
    f.d1.sql("UPDATE video_reference_cleanup SET lease_token='new-owner',lease_until=?,next_attempt_at=? WHERE asset_id=?",Date.now()+30000,Date.now()+30000,a.id);
    await completeVideoReferenceWrite(f.env,a,true);await completeVideoReferenceWrite(f.env,a,false);
    expect(f.d1.row("SELECT lease_token FROM video_reference_cleanup WHERE asset_id=?",a.id)).toEqual({lease_token:"new-owner"});
    expect((await getVideoReferenceAsset(f.env,a.id))!.write_outcome).toBe("confirmed");
  });
  it("oldest50 persistent failures back off, allowing the51st good object next tick",async()=>{
    const f=await setup();for(let i=0;i<51;i++)seed(f,"batch"+String(i).padStart(2,"0"));
    f.remove.mockImplementation(async(key)=>{if(!key.endsWith("batch50"))throw Error("delete failed");f.objects.delete(key);});
    expect(await pruneVideoReferenceAssets(f.env)).toBe(0);expect(f.remove).toHaveBeenCalledTimes(50);
    expect(await pruneVideoReferenceAssets(f.env)).toBe(1);expect(f.remove).toHaveBeenCalledTimes(51);
    expect((await getVideoReferenceAsset(f.env,"batch50"))!.state).toBe("deleted");
    expect(f.d1.row<{n:number}>("SELECT COUNT(*) n FROM video_reference_cleanup WHERE next_attempt_at > ?",Date.now())!.n).toBe(50);
  });
  it("caps retry jitter at one hour and never yields immediate failure retries",()=>{
    for(let n=1;n<100;n++)for(let i=0;i<20;i++){
      const delay=videoReferenceRetryDelay(n);expect(delay).toBeGreaterThanOrEqual(54000);expect(delay).toBeLessThanOrEqual(3600000);
    }
  });
  it("binding wins atomically against a stale due candidate; terminal scheduling respects hard TTL",async()=>{
    const f=await setup();const a=await ready(f);const original=f.env.DB.prepare.bind(f.env.DB);const t=task([a.id]);let bound=false;
    const spy=vi.spyOn(f.env.DB,"prepare").mockImplementation((sql:string)=>{
      const stmt=original(sql);if(sql===VIDEO_REFERENCE_DUE_SQL){stmt.all=(async()=>{
        const snapshot={results:[{asset_id:a.id}]};if(!bound){bound=true;await createVideoTask(f.env,t,undefined,[a.id]);}return snapshot;
      }) as typeof stmt.all;}return stmt;
    });
    try{expect(await pruneVideoReferenceAssets(f.env)).toBe(0);}finally{spy.mockRestore();}
    expect(f.remove).not.toHaveBeenCalled();expect((await getVideoReferenceAsset(f.env,a.id))!.task_id).toBe(t.id);
    const terminal=Date.now()-2*86400000;
    f.d1.sql("UPDATE video_tasks SET status='succeeded',updated_at=? WHERE id=?",terminal,t.id);
    expect(f.d1.row<{next_attempt_at:number}>("SELECT next_attempt_at FROM video_reference_cleanup WHERE asset_id=?",a.id)!.next_attempt_at).toBe(terminal+86400000);
    expect(await pruneVideoReferenceAssets(f.env)).toBe(1);
  });
  it("cleanup wins before binding: task and hold insertion roll back",async()=>{
    const f=await setup();const a=await ready(f);f.d1.sql("UPDATE video_reference_assets SET expires_at=1 WHERE id=?",a.id);
    f.remove.mockImplementation(async()=>{await expect(createVideoTask(f.env,task([a.id]),undefined,[a.id])).rejects.toThrow("invalid_video_references");});
    expect(await pruneVideoReferenceAssets(f.env)).toBe(1);expect(f.holds.size).toBe(0);
    expect(f.d1.row<{n:number}>("SELECT COUNT(*) n FROM video_tasks")!.n).toBe(0);
  });
  it("a superseded delete owner cannot finish metadata or clear the new lease",async()=>{
    const f=await setup();const a=await ready(f);f.d1.sql("UPDATE video_reference_assets SET expires_at=1 WHERE id=?",a.id);
    let release!:()=>void;f.remove.mockImplementation(()=>new Promise<void>(r=>{release=r;}));
    const prune=pruneVideoReferenceAssets(f.env);await flush();expect(f.remove).toHaveBeenCalledTimes(1);
    f.d1.sql("UPDATE video_reference_cleanup SET lease_token='successor',lease_until=?,next_attempt_at=? WHERE asset_id=?",Date.now()+30000,Date.now()+30000,a.id);
    release();expect(await prune).toBe(0);
    expect(f.d1.row("SELECT lease_token FROM video_reference_cleanup WHERE asset_id=?",a.id)).toEqual({lease_token:"successor"});
    expect((await getVideoReferenceAsset(f.env,a.id))!.state).toBe("deleting");
  });
  it("an expired delete lease cannot publish completion even without a successor",async()=>{
    const f=await setup();const a=await ready(f);f.d1.sql("UPDATE video_reference_assets SET expires_at=1 WHERE id=?",a.id);
    f.remove.mockImplementation(async()=>{f.d1.sql("UPDATE video_reference_cleanup SET lease_until=0 WHERE asset_id=?",a.id);});
    expect(await pruneVideoReferenceAssets(f.env)).toBe(0);expect((await getVideoReferenceAsset(f.env,a.id))!.state).toBe("deleting");
  });
  it("hung DELETEs retain both real slots after5s; next cron cannot start a third",async()=>{
    const f=await setup();for(let i=0;i<3;i++)seed(f,"hung"+i);
    vi.useFakeTimers();const releases:Array<()=>void>=[];
    f.remove.mockImplementation(()=>new Promise<void>(r=>{releases.push(r);}));
    try{
      const first=pruneVideoReferenceAssets(f.env);await flush();expect(releases).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(5001);expect(await first).toBe(0);
      expect(await pruneVideoReferenceAssets(f.env)).toBe(0);expect(releases).toHaveLength(2);
      for(const release of releases)release();await flush();f.remove.mockImplementation(async()=>{});
      expect(await pruneVideoReferenceAssets(f.env)).toBe(1);
    }finally{for(const release of releases)release();await flush();vi.useRealTimers();}
  });
  it("bounds foreground discard and whole cron even when D1 does not settle",async()=>{
    const f=await setup();const a=await reserved(f);vi.useFakeTimers();const original=f.env.DB.batch;
    let release!:()=>void;f.env.DB.batch=()=>new Promise(r=>{release=()=>r([]);});
    try{
      const discard=discardVideoReferenceAsset(f.env,a);await vi.advanceTimersByTimeAsync(5001);expect(await discard).toBe(false);
      release();await flush();expect(f.remove).not.toHaveBeenCalled();
    }finally{f.env.DB.batch=original;vi.useRealTimers();}
    vi.useFakeTimers();const prepare=f.env.DB.prepare.bind(f.env.DB);let releaseDue!:()=>void;
    const spy=vi.spyOn(f.env.DB,"prepare").mockImplementation((sql:string)=>{const stmt=prepare(sql);if(sql===VIDEO_REFERENCE_DUE_SQL)stmt.all=(()=>new Promise<unknown>(r=>{releaseDue=()=>r({results:[{asset_id:a.id}]});})) as typeof stmt.all;return stmt;});
    try{
      const prune=pruneVideoReferenceAssets(f.env);await flush();await vi.advanceTimersByTimeAsync(20001);expect(await prune).toBe(0);
      releaseDue();await flush();expect(f.remove).not.toHaveBeenCalled();
    }finally{spy.mockRestore();vi.useRealTimers();}
  });
  it("keeps old unknown tombstones indefinitely; only confirmed deleted rows age out",async()=>{
    const f=await setup();seed(f,"unknown","lost","unknown",Date.now()-30*86400000);
    seed(f,"settled","deleted","confirmed",Date.now()-30*86400000);
    expect(await pruneVideoReferenceAssets(f.env)).toBe(0);
    expect(await getVideoReferenceAsset(f.env,"unknown")).not.toBeNull();expect(await getVideoReferenceAsset(f.env,"settled")).toBeNull();
  });
  it("never purges legacy unknown deleted rows beyond the current50-row backfill window",async()=>{
    const f=await setup();for(let i=0;i<51;i++)seed(f,"legacy-unknown"+i,"deleted","unknown",Date.now()-30*86400000);
    f.d1.sql("UPDATE video_reference_assets SET upload_token=NULL");
    expect(await pruneVideoReferenceAssets(f.env)).toBe(0);
    expect(f.d1.row<{n:number}>("SELECT COUNT(*) n FROM video_reference_assets")!.n).toBe(51);
    expect(await reserveVideoReferenceAsset(f.env,device,"image/png")).toBeNull();
  });
  it("concurrent cron rounds do not claim the same live lease twice",async()=>{
    const f=await setup();seed(f,"single");
    const results=await Promise.all([pruneVideoReferenceAssets(f.env),pruneVideoReferenceAssets(f.env)]);
    expect(results.reduce((sum,n)=>sum+n,0)).toBe(1);expect(f.remove).toHaveBeenCalledTimes(1);
  });
  it("legacy ready can bind immediately without waiting for the backfill cursor",async()=>{
    const f=await setup();const a=await ready(f);
    f.d1.sql("UPDATE video_reference_assets SET upload_token=NULL,write_outcome='unknown' WHERE id=?",a.id);
    expect(await createVideoTask(f.env,task([a.id]),undefined,[a.id])).toBe(true);
    expect((await getVideoReferenceAsset(f.env,a.id))!).toMatchObject({write_outcome:"confirmed",upload_token:"legacy:"+a.id});
  });
  it("uses due and tombstone indexes with10000 historical rows and no temporary ordering",async()=>{
    const f=await setup();for(let i=0;i<10000;i++)seed(f,"history"+i,"deleted","confirmed");
    for(let i=0;i<51;i++)seed(f,"due"+i);
    const due=f.d1.rows<{detail:string}>("EXPLAIN QUERY PLAN "+VIDEO_REFERENCE_DUE_SQL,Date.now()).map(r=>r.detail).join("\n");
    expect(due).toMatch(/SEARCH .*idx_video_reference_due/);expect(due).not.toMatch(/SCAN |TEMP B-TREE/);
    const tomb=f.d1.rows<{detail:string}>("EXPLAIN QUERY PLAN "+VIDEO_REFERENCE_TOMBSTONES_SQL,Date.now()).map(r=>r.detail).join("\n");
    expect(tomb).toMatch(/SEARCH .*idx_video_reference_settled_tombstone/);expect(tomb).not.toMatch(/SCAN |TEMP B-TREE/);
    expect(f.d1.rows(VIDEO_REFERENCE_DUE_SQL,Date.now())).toHaveLength(50);
  });
  it("upgrades old asset table without data loss and backfills only50 rows per persisted cursor",async()=>{
    const oldAssets=INIT_STATEMENTS.find(s=>s.startsWith("CREATE TABLE IF NOT EXISTS video_reference_assets"))!
      .replace(",\n    upload_token TEXT, write_outcome TEXT NOT NULL DEFAULT 'unknown', cancelled_at INTEGER","");
    const oldInit=INIT_STATEMENTS.filter(s=>!s.includes("video_reference_cleanup") && !s.startsWith("CREATE TABLE IF NOT EXISTS video_reference_assets"));
    const d1=createRealD1({init:[oldAssets,...oldInit],alters:MIGRATION_ALTERS.filter(s=>!s.includes("video_reference_"))});
    try{
      for(let i=0;i<120;i++)d1.sql("INSERT INTO video_reference_assets(id,device_id,object_key,content_type,size_bytes,state,created_at,updated_at,expires_at,upload_lease_until) " +
        "VALUES (?,'dev-1',?,'image/png',64,?,1,1,1,0)","old"+i,"old-key"+i,i===119?"deleted":"ready");
      const deferred=(sql:string)=>{
        let values:unknown[]=[];
        const statement={sql,bind:(...v:unknown[])=>{values=v;return statement;},
          first:()=>d1.DB.prepare(sql).bind(...values).first(),
          all:()=>d1.DB.prepare(sql).bind(...values).all(),
          run:()=>d1.DB.prepare(sql).bind(...values).run()};return statement;
      };
      const env={DB:{...d1.DB,prepare:deferred}} as Env;
      vi.resetModules();const migrated=await import("../src/db/schema");await migrated.ensureSchema(env);
      expect(await backfillVideoReferenceCleanup(env)).toBe(50);expect(d1.row<{n:number}>("SELECT COUNT(*) n FROM video_reference_cleanup")!.n).toBe(50);
      expect(await backfillVideoReferenceCleanup(env)).toBe(50);expect(await backfillVideoReferenceCleanup(env)).toBe(20);
      expect(await backfillVideoReferenceCleanup(env)).toBe(0);expect(await backfillVideoReferenceCleanup(env)).toBe(0);
      expect(d1.row<{n:number}>("SELECT COUNT(*) n FROM video_reference_assets")!.n).toBe(120);
      expect(d1.row("SELECT state,write_outcome FROM video_reference_assets WHERE id='old0'")).toEqual({state:"ready",write_outcome:"confirmed"});
      expect(d1.row("SELECT state,write_outcome FROM video_reference_assets WHERE id='old119'")).toEqual({state:"lost",write_outcome:"unknown"});
      expect(d1.row<{done:number}>("SELECT done FROM video_reference_cleanup_backfill")!.done).toBe(1);
    }finally{d1.close();}
  });
});
