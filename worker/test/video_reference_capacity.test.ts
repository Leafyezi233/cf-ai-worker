import { describe, expect, it, vi } from "vitest";
import type { AuthedDevice } from "../src/types";
import {
  completeVideoReferenceWrite, discardVideoReferenceAsset, getVideoReferenceAsset,
  markVideoReferenceUploadUncertain, reserveVideoReferenceAsset,
  VIDEO_REFERENCE_GLOBAL_MAX_BYTES, VIDEO_REFERENCE_MAX_BYTES
} from "../src/db/video_reference_assets";
import type { VideoReferenceAsset } from "../src/db/video_reference_assets";
import { makeWalletFixture } from "./helpers/walletFixture";

const device = (id: string): AuthedDevice => ({id,auth_via:"master",sub_token_id:null} as AuthedDevice);
async function setup() {
  return makeWalletFixture({deviceIds:["new-a","new-b",...Array.from({length:10},(_,i)=>"account-"+i)]});
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function seed(f: Fixture, id: string, bytes: number, state: VideoReferenceAsset["state"] = "ready",
  outcome: VideoReferenceAsset["write_outcome"] = "confirmed", owner = "account-0") {
  const old = Date.now()-7_200_000;
  f.d1.sql("INSERT INTO video_reference_assets(id,device_id,object_key,content_type,size_bytes,state,created_at,updated_at,expires_at,upload_lease_until,upload_token,write_outcome) " +
    "VALUES (?,?,?,'image/png',?,?,?,?,?,0,?,?)",id,owner,"video-references/"+id,bytes,state,old,old,old,"token-"+id,outcome);
}
function fill(f: Fixture, bytes: number) {
  for (let i=0;bytes>0;i++) {
    const size = Math.min(bytes,VIDEO_REFERENCE_MAX_BYTES);
    seed(f,"fill-"+i,size,"ready","confirmed","account-"+Math.floor(i/20));
    bytes -= size;
  }
}
function physicalBytes(f: Fixture): number {
  return f.d1.row<{n:number}>("SELECT COALESCE(SUM(size_bytes),0) n FROM video_reference_assets " +
    "WHERE state <> 'deleted' OR write_outcome NOT IN ('confirmed','absent')")!.n;
}

describe("hard global video reference capacity",()=>{
  it("uses decimal 1GB, reserves the full 5MiB, and admits exactly the last global slot",async()=>{
    const f = await setup();
    expect(VIDEO_REFERENCE_GLOBAL_MAX_BYTES).toBe(1_000_000_000);
    expect(VIDEO_REFERENCE_GLOBAL_MAX_BYTES).not.toBe(1024**3);
    fill(f,VIDEO_REFERENCE_GLOBAL_MAX_BYTES-VIDEO_REFERENCE_MAX_BYTES);
    const a = await reserveVideoReferenceAsset(f.env,device("new-a"),"image/png");
    expect(a).toMatchObject({state:"uploading",write_outcome:"pending",size_bytes:5*1024*1024});
    expect(physicalBytes(f)).toBe(VIDEO_REFERENCE_GLOBAL_MAX_BYTES);
    expect(f.d1.row("SELECT object_key FROM video_reference_cleanup WHERE asset_id=?",a!.id))
      .toEqual({object_key:a!.object_key});
    expect(await reserveVideoReferenceAsset(f.env,device("new-b"),"image/png")).toBeNull();
  });

  it("rejects one byte over the boundary across accounts even when caller has no references",async()=>{
    const f = await setup();
    fill(f,VIDEO_REFERENCE_GLOBAL_MAX_BYTES-VIDEO_REFERENCE_MAX_BYTES+1);
    const before = physicalBytes(f);
    Object.assign(f.env,{VIDEO_REFERENCE_GLOBAL_MAX_BYTES:2_000_000_000});
    expect(await reserveVideoReferenceAsset(f.env,device("new-a"),"image/png")).toBeNull();
    expect(physicalBytes(f)).toBe(before);  
    expect(f.d1.row<{n:number}>("SELECT COUNT(*) n FROM video_reference_assets WHERE device_id='new-a'")!.n).toBe(0);
  });

  it("serializes competing cross-account INSERTs for the single remaining reservation",async()=>{
    const f = await setup();
    fill(f,VIDEO_REFERENCE_GLOBAL_MAX_BYTES-VIDEO_REFERENCE_MAX_BYTES);
    const prepare = vi.spyOn(f.env.DB,"prepare");
    const results = await Promise.all(Array.from({length:12},(_,i)=>
      reserveVideoReferenceAsset(f.env,device(i%2 ? "new-a" : "new-b"),"image/png")));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(physicalBytes(f)).toBe(VIDEO_REFERENCE_GLOBAL_MAX_BYTES);
    const sql = prepare.mock.calls.map(([statement])=>String(statement));
    expect(sql.filter(s=>s.startsWith("INSERT INTO video_reference_assets"))).toHaveLength(12);
    expect(sql.filter(s=>s.startsWith("SELECT") && s.includes("SUM(size_bytes)"))).toHaveLength(0);
    prepare.mockRestore();
  });

  it.each([
    ["uploading","pending"], ["uploading","unknown"], ["lost","unknown"],
    ["deleting","confirmed"], ["lost","absent"], ["ready","confirmed"],
    ["deleted","pending"], ["deleted","unknown"]
  ] as const)("keeps %s/%s bytes globally charged even with expired leases",async(state,outcome)=>{
    const f = await setup();
    fill(f,VIDEO_REFERENCE_GLOBAL_MAX_BYTES-2*VIDEO_REFERENCE_MAX_BYTES+1);
    seed(f,"uncertain",VIDEO_REFERENCE_MAX_BYTES,state,outcome);
    expect(await reserveVideoReferenceAsset(f.env,device("new-a"),"image/png")).toBeNull();
  });

  it.each(["confirmed","absent"] as const)("excludes only safely deleted %s tombstones",async(outcome)=>{
    const f = await setup();
    fill(f,VIDEO_REFERENCE_GLOBAL_MAX_BYTES-VIDEO_REFERENCE_MAX_BYTES);
    seed(f,"safe-tombstone",VIDEO_REFERENCE_MAX_BYTES,"deleted",outcome);
    expect(await reserveVideoReferenceAsset(f.env,device("new-a"),"image/png")).not.toBeNull();
    expect(physicalBytes(f)).toBe(VIDEO_REFERENCE_GLOBAL_MAX_BYTES);
  });

  it.each([true,false])("unknown PUT retains global quota after DELETE until settled=%s and safely deleted",async(stored)=>{
    const f = await setup();
    fill(f,VIDEO_REFERENCE_GLOBAL_MAX_BYTES-VIDEO_REFERENCE_MAX_BYTES);
    const remove = vi.fn(async()=>{});
    f.env.VIDEO_REFERENCES = {delete:remove} as unknown as R2Bucket;
    const a = (await reserveVideoReferenceAsset(f.env,device("new-a"),"image/png"))!;
    await markVideoReferenceUploadUncertain(f.env,a);
    expect(await discardVideoReferenceAsset(f.env,a)).toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
    expect((await getVideoReferenceAsset(f.env,a.id))!).toMatchObject({state:"lost",write_outcome:"unknown",size_bytes:VIDEO_REFERENCE_MAX_BYTES});
    expect(await reserveVideoReferenceAsset(f.env,device("new-b"),"image/png")).toBeNull();
    await completeVideoReferenceWrite(f.env,a,stored);
    expect(await reserveVideoReferenceAsset(f.env,device("new-b"),"image/png")).toBeNull();
    expect(await discardVideoReferenceAsset(f.env,a)).toBe(true);
    expect((await getVideoReferenceAsset(f.env,a.id))!.state).toBe("deleted");
    expect(await reserveVideoReferenceAsset(f.env,device("new-b"),"image/png")).not.toBeNull();
    expect(physicalBytes(f)).toBe(VIDEO_REFERENCE_GLOBAL_MAX_BYTES);
  });

  it("failed DELETE of confirmed storage cannot release the global reservation",async()=>{
    const f = await setup();
    fill(f,VIDEO_REFERENCE_GLOBAL_MAX_BYTES-VIDEO_REFERENCE_MAX_BYTES);
    const a = (await reserveVideoReferenceAsset(f.env,device("new-a"),"image/png"))!;
    await completeVideoReferenceWrite(f.env,a,true);
    f.env.VIDEO_REFERENCES = {delete:vi.fn(async()=>{throw new Error("delete failed");})} as unknown as R2Bucket;
    expect(await discardVideoReferenceAsset(f.env,a)).toBe(false);
    expect(await reserveVideoReferenceAsset(f.env,device("new-b"),"image/png")).toBeNull();
  });

  it.each(["ready","uploading","lost","deleted"] as const)("counts legacy %s rows with default unknown outcome before backfill",async(state)=>{
    const f = await setup();
    fill(f,VIDEO_REFERENCE_GLOBAL_MAX_BYTES-2*VIDEO_REFERENCE_MAX_BYTES+1);
    f.d1.sql("INSERT INTO video_reference_assets(id,device_id,object_key,content_type,size_bytes,state,created_at,updated_at,expires_at,upload_lease_until) " +
      "VALUES ('legacy','account-0','legacy-key','image/png',?,?,1,1,1,0)",VIDEO_REFERENCE_MAX_BYTES,state);
    expect(f.d1.row("SELECT upload_token,write_outcome FROM video_reference_assets WHERE id='legacy'"))
      .toEqual({upload_token:null,write_outcome:"unknown"});
    expect(await reserveVideoReferenceAsset(f.env,device("new-a"),"image/png")).toBeNull();
  });

  it("retains the independent per-device byte cap below the global limit",async()=>{
    const f = await setup();
    for(let i=0;i<20;i++)seed(f,"owner-"+i,VIDEO_REFERENCE_MAX_BYTES,"ready","confirmed","new-a");
    expect(await reserveVideoReferenceAsset(f.env,device("new-a"),"image/png")).toBeNull();
    expect(await reserveVideoReferenceAsset(f.env,device("new-b"),"image/png")).not.toBeNull();
  });

  it("fails closed when the capacity INSERT cannot execute",async()=>{
    const f = await setup();
    const original = f.env.DB.prepare.bind(f.env.DB);
    const prepare = vi.spyOn(f.env.DB,"prepare").mockImplementation((sql:string)=>{
      if(sql.startsWith("INSERT INTO video_reference_assets"))throw new Error("capacity DB unavailable");
      return original(sql);
    });
    await expect(reserveVideoReferenceAsset(f.env,device("new-a"),"image/png")).rejects.toThrow("capacity DB unavailable");
    prepare.mockRestore();
    expect(physicalBytes(f)).toBe(0);
  });
});
