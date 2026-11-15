import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AuthedDevice, Env } from "../src/types";
import { withVideoReferenceR2Budget, VIDEO_REFERENCE_R2_LIMITS } from "../src/db/video_reference_budget";
import { getVideoReferenceAsset, discardVideoReferenceAsset } from "../src/db/video_reference_assets";
import { uploadVideoReferenceImage, getVideoReferenceContent, buildVideoReferenceUrls, validateVideoReferences } from "../src/gateway/video_reference_assets";
import { openReferenceBody } from "../src/gateway/video_reference_stream";
import { makeWalletFixture } from "./helpers/walletFixture";
import { sha256Hex } from "../src/utils/crypto";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const period = () => new Date(Date.now()).toISOString().slice(0,7);
function seed(f: Awaited<ReturnType<typeof makeWalletFixture>>, put: number, get: number, month = period()) {
  f.d1.sql("INSERT OR REPLACE INTO video_reference_r2_budget(period,put_attempts,get_attempts) VALUES (?,?,?)",month,put,get);
}
function counts(f: Awaited<ReturnType<typeof makeWalletFixture>>, month = period()) {
  return f.d1.row<{put_attempts:number;get_attempts:number}>("SELECT put_attempts,get_attempts FROM video_reference_r2_budget WHERE period=?",month);
}
async function gateway() {
  const f=await makeWalletFixture(); f.env.ENCRYPTION_KEY="budget-test-key";
  f.d1.sql("UPDATE devices SET token_hash=? WHERE id='dev-1'",await sha256Hex("master"));
  const put=vi.fn(async(_key:string,body:ReadableStream<Uint8Array>)=>{const bytes=await new Response(body).arrayBuffer();return {size:bytes.byteLength};});
  const get=vi.fn(async()=>({size:64,body:new Blob([png()]).stream()}));
  const del=vi.fn(async()=>{});
  f.env.VIDEO_REFERENCES={put,get,delete:del} as unknown as R2Bucket;
  const app=new Hono<{Bindings:Env}>();app.post("/video/reference-images",uploadVideoReferenceImage);app.get("/video/reference-images/:id/content",getVideoReferenceContent);
  const upload=()=>app.request("https://gateway.test/video/reference-images",{method:"POST",headers:{authorization:"Bearer master","content-type":"image/png","content-length":"64"},body:png()},f.env);
  const device={id:"dev-1",auth_via:"master",sub_token_id:null} as AuthedDevice;
  return {...f,app,put,get,del,upload,device};
}
function png() {const b=new Uint8Array(64);b.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);const v=new DataView(b.buffer);v.setUint32(16,32);v.setUint32(20,24);b[24]=8;b[25]=6;return b;}

describe("durable immutable R2 operation budget",()=>{
  it("has conservative non-overridable constants and independent PUT/GET counters",async()=>{
    expect(VIDEO_REFERENCE_R2_LIMITS).toEqual({put:10000,get:100000});expect(Object.isFrozen(VIDEO_REFERENCE_R2_LIMITS)).toBe(true);
    const f=await makeWalletFixture();await withVideoReferenceR2Budget(f.env,"put",async()=>1);await withVideoReferenceR2Budget(f.env,"get",async()=>2);
    expect(counts(f)).toEqual({put_attempts:1,get_attempts:1});
  });
  for(const kind of ["put","get"] as const) it("atomically admits only final "+kind+" permit across concurrent callers",async()=>{
    const f=await makeWalletFixture();seed(f,kind==="put"?9999:0,kind==="get"?99999:0);const dispatch=vi.fn(async()=>true);
    const results=await Promise.allSettled(Array.from({length:20},()=>withVideoReferenceR2Budget({...f.env},kind,dispatch)));
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(dispatch).toHaveBeenCalledTimes(1);
    expect(counts(f)?.[kind==="put"?"put_attempts":"get_attempts"]).toBe(VIDEO_REFERENCE_R2_LIMITS[kind]);
  });
  it("never refunds rejected, null, cancelled or still pending operations",async()=>{
    const f=await makeWalletFixture();await expect(withVideoReferenceR2Budget(f.env,"put",async()=>{throw Error("R2 failed");})).rejects.toThrow("R2 failed");
    await withVideoReferenceR2Budget(f.env,"get",async()=>null);
    let release!:()=>void;const held=withVideoReferenceR2Budget(f.env,"put",()=>new Promise<void>(resolve=>{release=resolve;}));
    while(!release) await Promise.resolve();expect(counts(f)).toEqual({put_attempts:2,get_attempts:1});release();await held;
    expect(counts(f)).toEqual({put_attempts:2,get_attempts:1});
  });
  it("rejects a DB failure without invoking R2",async()=>{
    const f=await makeWalletFixture();const dispatch=vi.fn(async()=>1);vi.spyOn(f.env.DB,"prepare").mockImplementation(()=>{throw Error("D1 unavailable");});
    await expect(withVideoReferenceR2Budget(f.env,"get",dispatch)).rejects.toThrow("reference_r2_budget_unavailable");expect(dispatch).not.toHaveBeenCalled();
  });
  it("does not dispatch or replay when a committed reservation loses its acknowledgement",async()=>{
    const f=await makeWalletFixture();const prepare=f.env.DB.prepare.bind(f.env.DB);const dispatch=vi.fn(async()=>1);
    vi.spyOn(f.env.DB,"prepare").mockImplementation(sql=>{const st=prepare(sql);if(sql.startsWith("INSERT INTO video_reference_r2_budget")){const run=st.run.bind(st);st.run=async()=>{await run();throw Error("lost ack");};}return st;});
    await expect(withVideoReferenceR2Budget(f.env,"put",dispatch)).rejects.toThrow("reference_r2_budget_unavailable");expect(dispatch).not.toHaveBeenCalled();expect(counts(f)?.put_attempts).toBe(1);
  });
  it("rejects a success=false acknowledgement even if it reports changes",async()=>{
    const f=await makeWalletFixture();const prepare=f.env.DB.prepare.bind(f.env.DB);const dispatch=vi.fn(async()=>1);
    vi.spyOn(f.env.DB,"prepare").mockImplementation(sql=>{const st=prepare(sql);if(sql.startsWith("INSERT INTO video_reference_r2_budget")){const run=st.run.bind(st);st.run=(async()=>({...await run(),success:false})) as unknown as D1PreparedStatement["run"];}return st;});
    await expect(withVideoReferenceR2Budget(f.env,"get",dispatch)).rejects.toThrow("reference_r2_budget_unavailable");expect(dispatch).not.toHaveBeenCalled();
  });
  it("opens a new UTC month without clearing the exhausted prior month",async()=>{
    const f=await makeWalletFixture();vi.spyOn(Date,"now").mockReturnValue(Date.parse("2026-12-31T23:59:59Z"));seed(f,10000,100000);const dispatch=vi.fn(async()=>true);
    await expect(withVideoReferenceR2Budget(f.env,"put",dispatch)).rejects.toThrow();vi.mocked(Date.now).mockReturnValue(Date.parse("2027-01-01T00:00:00Z"));
    await withVideoReferenceR2Budget(f.env,"put",dispatch);expect(dispatch).toHaveBeenCalledTimes(1);expect(counts(f,"2026-12")).toEqual({put_attempts:10000,get_attempts:100000});expect(counts(f,"2027-01")?.put_attempts).toBe(1);
  });
  it("does not spend an old-month permit after a delayed database acknowledgement",async()=>{
    const f=await makeWalletFixture();vi.spyOn(Date,"now").mockReturnValue(Date.parse("2026-12-31T23:59:59Z"));const prepare=f.env.DB.prepare.bind(f.env.DB),dispatch=vi.fn(async()=>true);
    vi.spyOn(f.env.DB,"prepare").mockImplementation(sql=>{const st=prepare(sql);if(sql.startsWith("INSERT INTO video_reference_r2_budget")){const run=st.run.bind(st);st.run=async<T>()=>{const r=await run() as D1Result<T>;vi.mocked(Date.now).mockReturnValue(Date.parse("2027-01-01T00:00:00Z"));return r;};}return st;});
    await expect(withVideoReferenceR2Budget(f.env,"put",dispatch)).rejects.toThrow();expect(dispatch).not.toHaveBeenCalled();expect(counts(f,"2026-12")?.put_attempts).toBe(1);expect(counts(f,"2027-01")).toBeNull();
  });
  it("keeps schema-level ceilings as a second guard",async()=>{
    const f=await makeWalletFixture();seed(f,10000,100000);expect(()=>f.d1.sql("UPDATE video_reference_r2_budget SET put_attempts=10001")).toThrow();expect(()=>f.d1.sql("UPDATE video_reference_r2_budget SET get_attempts=-1")).toThrow();
  });
  it("forces Standard storage instead of inheriting a potentially paid Infrequent Access default",async()=>{
    const f=await gateway();expect((await f.upload()).status).toBe(201);expect((f.put.mock.calls[0] as unknown as unknown[])[2]).toMatchObject({storageClass:"Standard"});
  });
  it("prevents real handler PUT at limit and preserves deletion at exhausted quotas",async()=>{
    const f=await gateway();seed(f,10000,100000);const res=await f.upload();expect(res.status).toBe(503);expect(f.put).not.toHaveBeenCalled();expect(f.del).toHaveBeenCalled();expect(counts(f)).toEqual({put_attempts:10000,get_attempts:100000});
    expect(f.d1.row<{n:number}>("SELECT COUNT(*) n FROM video_reference_assets WHERE state='ready'")?.n).toBe(0);
  });
  it("blocks real handler GET at limit; metadata validation itself does not consume R2",async()=>{
    const f=await gateway();const res=await f.upload();expect(res.status).toBe(201);const a=await res.json() as {id:string};
    const [url]=await buildVideoReferenceUrls(f.env,f.device,await validateVideoReferences(f.env,f.device,[a.id]),"https://gateway.test");seed(f,1,100000);
    for(let i=0;i<5;i++){expect((await f.app.request(url,{},f.env)).status).toBe(503);}expect(f.get).not.toHaveBeenCalled();
    seed(f,1,99999);const ok=await f.app.request(url,{},f.env);expect(ok.status).toBe(200);await ok.arrayBuffer();expect(f.get).toHaveBeenCalledTimes(1);expect(counts(f)?.get_attempts).toBe(100000);
    expect(await discardVideoReferenceAsset(f.env,(await getVideoReferenceAsset(f.env,a.id))!)).toBe(true);
  });
  for (const abort of [false,true]) it("does not start PUT after " + (abort ? "abort" : "timeout") + " and a committed budget acknowledgement arrives late",async()=>{
    const f=await gateway();const prepare=f.env.DB.prepare.bind(f.env.DB);let resume!:()=>void;const gate=new Promise<void>(resolve=>{resume=resolve;});let markEntered!:()=>void;const entered=new Promise<void>(resolve=>{markEntered=resolve;});
    vi.spyOn(f.env.DB,"prepare").mockImplementation(sql=>{const st=prepare(sql);if(sql.startsWith("INSERT INTO video_reference_r2_budget")){const run=st.run.bind(st);st.run=async<T>()=>{const r=await run() as D1Result<T>;markEntered();await gate;return r;};}return st;});
    vi.useFakeTimers();const controller=new AbortController();
    const waiting=f.app.request(new Request("https://gateway.test/video/reference-images",{method:"POST",headers:{authorization:"Bearer master","content-type":"image/png","content-length":"64"},body:png(),signal:controller.signal}),{},f.env);
    await entered;expect(counts(f)?.put_attempts).toBe(1);
    if(abort)controller.abort();else await vi.advanceTimersByTimeAsync(60001);
    const response=await waiting;expect(response.status).toBe(400);expect(f.put).not.toHaveBeenCalled();
    resume();await vi.advanceTimersByTimeAsync(0);expect(f.put).not.toHaveBeenCalled();expect(counts(f)?.put_attempts).toBe(1);
    expect(f.d1.row<{n:number}>("SELECT COUNT(*) n FROM video_reference_assets WHERE state='ready'")?.n).toBe(0);
  });
  it("does not start a late GET after the reader times out while reserving its budget",async()=>{
    const f=await makeWalletFixture();const prepare=f.env.DB.prepare.bind(f.env.DB);let resume!:()=>void;const gate=new Promise<void>(resolve=>{resume=resolve;});let markEntered!:()=>void;const entered=new Promise<void>(resolve=>{markEntered=resolve;});
    vi.spyOn(f.env.DB,"prepare").mockImplementation(sql=>{const st=prepare(sql);if(sql.startsWith("INSERT INTO video_reference_r2_budget")){const run=st.run.bind(st);st.run=async()=>{markEntered();await gate;return run();};}return st;});
    vi.useFakeTimers();const get=vi.fn(async()=>({size:1,body:new Blob([new Uint8Array(1)]).stream()})),release=vi.fn();
    const waiting=openReferenceBody(signal=>withVideoReferenceR2Budget(f.env,"get",()=>{if(signal.aborted)throw Error("stopped");return get();}),1,new AbortController().signal,release);
    const caught=waiting.catch(e=>e);await entered;await vi.advanceTimersByTimeAsync(15001);expect(await caught).toBeInstanceOf(Error);expect(release).not.toHaveBeenCalled();
    resume();await vi.advanceTimersByTimeAsync(0);expect(get).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);expect(counts(f)?.get_attempts).toBe(1);
  });
});
