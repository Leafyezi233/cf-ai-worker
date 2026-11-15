import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { VideoUploadLifetime } from "../src/gateway/video_upload_lifecycle";
import { uploadVideoReferenceImage } from "../src/gateway/video_reference_assets";
import { makeWalletFixture } from "./helpers/walletFixture";
import { sha256Hex } from "../src/utils/crypto";
import type { Env } from "../src/types";

function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (e:Error)=>void;
  const promise = new Promise<T>((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
function png() { const b=new Uint8Array(64); b.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  const v=new DataView(b.buffer);v.setUint32(16,32);v.setUint32(20,24);b[24]=8;b[25]=6;return b; }
async function setup() {
  const f=await makeWalletFixture({deviceIds:["dev-1"]});
  f.d1.sql("UPDATE devices SET token_hash=? WHERE id='dev-1'",await sha256Hex("master"));
  const app=new Hono<{Bindings:Env}>();app.post("/upload",uploadVideoReferenceImage);
  const upload=(signal?:AbortSignal)=>app.request(new Request("https://gw.test/upload",{method:"POST",headers:{authorization:"Bearer master","content-type":"image/png","content-length":"64"},body:png(),signal}),{},f.env);
  return {...f,app,upload};
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

describe("upload foreground lifetime and real in-flight accounting",()=>{
  it("expires a never-settling operation without freeing its real slot",async()=>{
    vi.useFakeTimers();const release=vi.fn(),d=deferred<number>(),ac=new AbortController();
    const l=new VideoUploadLifetime(ac.signal,release,()=>new Error("deadline"),()=>new Error("abort"));
    const wait=l.wait(l.track(d.promise));const assertion=expect(wait).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(60000);await assertion;l.returnedResponse();expect(release).not.toHaveBeenCalled();
    d.resolve(1);await Promise.resolve();expect(release).toHaveBeenCalledTimes(1);
  });
  it("removes completed per-operation waiters instead of retaining all read results",async()=>{
    const ac=new AbortController(),release=vi.fn();const l=new VideoUploadLifetime(ac.signal,release,()=>Error("timeout"),()=>Error("abort"));
    for(let i=0;i<10000;i++)expect(await l.wait(Promise.resolve(i))).toBe(i);
    expect((l as unknown as {waiters:Set<unknown>}).waiters.size).toBe(0);l.returnedResponse();expect(release).toHaveBeenCalledTimes(1);
  });
  it("aborts all current waiters and disposes listeners exactly once",async()=>{
    const ac=new AbortController(),release=vi.fn(),stop=vi.fn();const l=new VideoUploadLifetime(ac.signal,release,()=>Error("timeout"),()=>Error("abort"));
    l.onStop(stop);const wait=l.wait(new Promise(()=>{}));const assertion=expect(wait).rejects.toThrow("abort");ac.abort();await assertion;
    l.stop(Error("again"));l.returnedResponse();l.returnedResponse();expect(stop).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledTimes(1);
  });
  it.each(["timeout","abort"] as const)("returns on %s while PUT hangs, and never publishes late success",async mode=>{
    const f=await setup(),entered=deferred<void>(),put=deferred<{size:number}>();let key="";const objects=new Set<string>();
    f.env.VIDEO_REFERENCES={put:async(k:string,body:ReadableStream)=>{key=k;await new Response(body).arrayBuffer();entered.resolve();const out=await put.promise;objects.add(k);return out;},delete:async(k:string)=>{objects.delete(k);}} as unknown as R2Bucket;
    vi.useFakeTimers();const ac=new AbortController();const pending=f.upload(ac.signal);await entered.promise;
    if(mode==="abort")ac.abort();else await vi.advanceTimersByTimeAsync(60001);
    const response=await pending;expect(response.status).toBe(400);expect(await response.text()).toContain(mode==="abort"?"reference_upload_interrupted":"reference_upload_timeout");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.d1.row<any>("SELECT COUNT(*) n FROM video_reference_assets WHERE state='ready'")!.n).toBe(0);
    put.resolve({size:64});await vi.advanceTimersByTimeAsync(0);
    expect(objects.has(key)).toBe(false);expect(f.d1.row<any>("SELECT COUNT(*) n FROM video_reference_assets WHERE state='ready'")!.n).toBe(0);
  });
  it("never publishes an expired upload after PUT finally acknowledges",async()=>{
    const f=await setup(),put=deferred<{size:number}>(),entered=deferred<void>();
    f.env.VIDEO_REFERENCES={put:async(_k:string,body:ReadableStream)=>{await new Response(body).arrayBuffer();entered.resolve();return put.promise;},delete:async()=>{}} as unknown as R2Bucket;
    vi.useFakeTimers();const pending=f.upload();await entered.promise;await vi.advanceTimersByTimeAsync(60001);expect((await pending).status).toBe(400);
    put.resolve({size:64});await vi.advanceTimersByTimeAsync(0);expect(f.d1.row<any>("SELECT COUNT(*) n FROM video_reference_assets WHERE state='ready'")!.n).toBe(0);
  });
  it("keeps all eight hanging PUTs counted after HTTP timeout and releases only after acknowledgement",async()=>{
    const f=await makeWalletFixture({deviceIds:Array.from({length:8},(_,i)=>"upload-owner-"+i)});
    for(let i=0;i<8;i++)f.d1.sql("UPDATE devices SET token_hash=? WHERE id=?",await sha256Hex("token-"+i),"upload-owner-"+i);
    const app=new Hono<{Bindings:Env}>();app.post("/upload",uploadVideoReferenceImage);
    const puts=Array.from({length:8},()=>deferred<{size:number}>());let entered=0;const allEntered=deferred<void>(),deletion=deferred<void>();
    f.env.VIDEO_REFERENCES={put:async(_k:string,body:ReadableStream)=>{await new Response(body).arrayBuffer();const n=entered++;if(entered===8)allEntered.resolve();return puts[n]?.promise ?? {size:64};},delete:()=>deletion.promise} as unknown as R2Bucket;
    const upload=(i:number)=>app.request("https://gw.test/upload",{method:"POST",headers:{authorization:"Bearer token-"+i,"content-type":"image/png","content-length":"64"},body:png()},f.env);
    vi.useFakeTimers();const responses=Array.from({length:8},(_,i)=>upload(i));await allEntered.promise;
    await vi.advanceTimersByTimeAsync(60001);for(const r of await Promise.all(responses))expect(r.status).toBe(400);
    expect((await upload(0)).status).toBe(429);expect(entered).toBe(8);
    puts[0].resolve({size:64});await vi.advanceTimersByTimeAsync(0);
    expect((await upload(0)).status).toBe(429);  
    deletion.resolve();await vi.advanceTimersByTimeAsync(0);
    const next=upload(0);await vi.advanceTimersByTimeAsync(0);  
    for(const p of puts)p.resolve({size:64});await vi.advanceTimersByTimeAsync(0);expect((await next).status).toBe(201);
    await vi.advanceTimersByTimeAsync(0);
  });
  it("does not dispatch a PUT when reservation acknowledgement arrives after timeout",async()=>{
    const f=await setup(),gate=deferred<void>(),entered=deferred<void>();const prepare=f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare=((sql:string)=>{
      const statement=prepare(sql);if(!/^INSERT(?: OR \w+)? INTO video_reference_assets/.test(sql))return statement;
      return {...statement,bind(...values:unknown[]){const bound=statement.bind(...values);return {...bound,run(){entered.resolve();return gate.promise.then(()=>bound.run());}};}};
    }) as typeof f.env.DB.prepare;
    const put=vi.fn(async()=>({size:64}));f.env.VIDEO_REFERENCES={put,delete:async()=>{}} as unknown as R2Bucket;
    vi.useFakeTimers();const pending=f.upload();await entered.promise;await vi.advanceTimersByTimeAsync(60001);expect((await pending).status).toBe(400);
    gate.resolve();await vi.advanceTimersByTimeAsync(0);expect(put).not.toHaveBeenCalled();
    expect(f.d1.row<any>("SELECT COUNT(*) n FROM video_reference_assets WHERE state IN ('uploading','ready')")!.n).toBe(0);
  });
  it("does not resurrect ready when its database acknowledgement arrives after timeout",async()=>{
    const f=await setup(),entered=deferred<void>(),ack=deferred<void>();const prepare=f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare=((sql:string)=>{const statement=prepare(sql);
      if(!sql.startsWith("UPDATE video_reference_assets SET state = 'ready'"))return statement;
      return {...statement,bind(...values:unknown[]){const bound=statement.bind(...values);return {...bound,async run(){
        const result=await bound.run();entered.resolve();await ack.promise;return result;
      }};}};
    }) as typeof f.env.DB.prepare;
    const objects=new Set<string>();f.env.VIDEO_REFERENCES={put:async(k:string,body:ReadableStream)=>{await new Response(body).arrayBuffer();objects.add(k);return {size:64};},delete:async(k:string)=>{objects.delete(k);}} as unknown as R2Bucket;
    vi.useFakeTimers();const pending=f.upload();await entered.promise;
    await vi.advanceTimersByTimeAsync(60001);expect((await pending).status).toBe(400);
    ack.resolve();await vi.advanceTimersByTimeAsync(0);
    expect(f.d1.row<{n:number}>("SELECT COUNT(*) n FROM video_reference_assets WHERE state='ready'")!.n).toBe(0);
    expect(objects.size).toBe(0);
  });
  it("keeps all eight slots while stalled request-reader cancellation is unacknowledged",async()=>{
    const f=await makeWalletFixture({deviceIds:Array.from({length:8},(_,i)=>"reader-owner-"+i)});
    for(let i=0;i<8;i++)f.d1.sql("UPDATE devices SET token_hash=? WHERE id=?",await sha256Hex("reader-token-"+i),"reader-owner-"+i);
    const app=new Hono<{Bindings:Env}>();
    const cancels=Array.from({length:8},()=>deferred<void>()),allReading=deferred<void>();let reading=0;
    app.post("/upload",c=>{
      const body=c.req.raw.body!;const get=body.getReader.bind(body);
      Object.defineProperty(body,"getReader",{value:()=>{const reader=get();const read=reader.read.bind(reader),cancel=reader.cancel.bind(reader);
        const index=Number(c.req.header("authorization")!.split("-").pop());
        reader.read=()=>{if(++reading===8)allReading.resolve();return read();};
        reader.cancel=async()=>{const pending=cancel();await cancels[index].promise;await pending;};return reader;}});
      return uploadVideoReferenceImage(c);
    });
    const put=vi.fn(async(_k:string,body:ReadableStream)=>{await new Response(body).arrayBuffer();return {size:64};});
    f.env.VIDEO_REFERENCES={put,delete:async()=>{}} as unknown as R2Bucket;
    vi.useFakeTimers();const requests=Array.from({length:8},(_,i)=>{
      const body=new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});},cancel(){return cancels[i].promise;}},{highWaterMark:0});
      const init={method:"POST",headers:{authorization:"Bearer reader-token-"+i,"content-type":"image/png","content-length":"64"},body,duplex:"half"} as RequestInit;
      return app.request(new Request("https://gw.test/upload",init),{},f.env);
    });
    await allReading.promise;await vi.advanceTimersByTimeAsync(60001);
    for(const response of await Promise.all(requests))expect(response.status).toBe(400);
    const normal=()=>app.request("https://gw.test/upload",{method:"POST",headers:{authorization:"Bearer reader-token-0","content-type":"image/png","content-length":"64"},body:png()},f.env);
    expect((await normal()).status).toBe(429);expect(put).not.toHaveBeenCalled();
    for(const cancel of cancels)cancel.resolve();await vi.advanceTimersByTimeAsync(0);
    expect((await normal()).status).toBe(201);
  });
  it("does not await a hung failure-delete before returning the original validation error",async()=>{
    const f=await setup(),deleting=deferred<void>(),entered=deferred<void>();
    f.env.VIDEO_REFERENCES={put:async()=>null,delete:()=>{entered.resolve();return deleting.promise;}} as unknown as R2Bucket;
    vi.useFakeTimers();const pending=f.app.request("https://gw.test/upload",{method:"POST",headers:{authorization:"Bearer master","content-type":"image/png","content-length":"64"},body:new Uint8Array(64)},f.env);
    await entered.promise;await vi.advanceTimersByTimeAsync(251);expect((await pending).status).toBe(415);
    deleting.resolve();await vi.advanceTimersByTimeAsync(0);
  });
});
