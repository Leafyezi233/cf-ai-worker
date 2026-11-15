import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AuthedDevice, Env } from "../src/types";
import type { VideoTask } from "../src/db/video_tasks";
import { createVideoTask } from "../src/db/video_tasks";
import { finishVideoReferenceAsset, getVideoReferenceAsset, pruneVideoReferenceAssets, reserveVideoReferenceAsset, VIDEO_REFERENCE_MAX_BYTES } from "../src/db/video_reference_assets";
import { buildVideoReferenceUrls, getVideoReferenceContent, getVideoReferenceMetadata, uploadVideoReferenceImage, validateVideoReferences } from "../src/gateway/video_reference_assets";
import { makeWalletFixture } from "./helpers/walletFixture";
import { sha256Hex } from "../src/utils/crypto";

class MemoryR2 {
  objects=new Map<string,Uint8Array>(); maxChunk=0; failDelete=false;
  async put(key:string,body:ReadableStream<Uint8Array>) {
    const parts:Uint8Array[]=[];let size=0;const reader=body.getReader();
    while(true) {const r=await reader.read();if(r.done) break;this.maxChunk=Math.max(this.maxChunk,r.value.length);parts.push(r.value.slice());size+=r.value.length;}
    const all=new Uint8Array(size);let o=0;for(const p of parts){all.set(p,o);o+=p.length;}this.objects.set(key,all);
    return {size,checksums:{sha256:await crypto.subtle.digest("SHA-256",all)}};
  }
  async delete(key:string) {if(this.failDelete) throw Error("private key secret");this.objects.delete(key);}
  async get(key:string) {const b=this.objects.get(key);return b?{size:b.length,body:new Blob([b]).stream()}:null;}
}
function png(size=64,w=32,h=24) {const b=new Uint8Array(size);b.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);const v=new DataView(b.buffer);v.setUint32(16,w);v.setUint32(20,h);b[24]=8;b[25]=6;return b;}
function jpeg() {return new Uint8Array([255,216,255,192,0,11,8,0,24,0,32,1,1,17,0,255,217]);}
function webp() {const b=new Uint8Array(30);b.set(new TextEncoder().encode("RIFF"));new DataView(b.buffer).setUint32(4,22,true);b.set(new TextEncoder().encode("WEBPVP8X"),8);b[16]=10;b[24]=31;b[27]=23;return b;}
async function setup() {
  const f=await makeWalletFixture({deviceIds:["dev-1","other"]});const r2=new MemoryR2();
  f.env.VIDEO_REFERENCES=r2 as unknown as R2Bucket;f.env.ENCRYPTION_KEY="reference-test-key";
  f.d1.sql("UPDATE devices SET token_hash = ? WHERE id = 'dev-1'",await sha256Hex("master"));
  f.d1.sql("INSERT INTO device_sub_tokens(id,device_id,name,token_hash,created_at) VALUES ('sub-1','dev-1','sub',?,1)",await sha256Hex("sub"));
  const app=new Hono<{Bindings:Env}>();app.post("/video/reference-images",uploadVideoReferenceImage);app.get("/video/reference-images/:id/content",getVideoReferenceContent);app.get("/video/reference-images/:id",getVideoReferenceMetadata);
  const device={id:"dev-1",auth_via:"master",sub_token_id:null} as AuthedDevice;
  const upload=(bytes:Uint8Array,type="image/png",token="master",extra:Record<string,string>={})=>{
    let offset=0;
    const body=bytes.length>65536 ? new ReadableStream<Uint8Array>({pull(c){ if(offset===bytes.length){c.close();return;} const end=Math.min(offset+65536,bytes.length);c.enqueue(bytes.slice(offset,end));offset=end; }},{highWaterMark:0}) : bytes;
    return app.request(new Request("https://gateway.test/video/reference-images",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":type,"content-length":String(bytes.byteLength),...extra},body,duplex:"half"} as RequestInit),{},f.env);
  };
  return {...f,r2,app,device,upload};
}
function task(ids:string[],patch:Partial<VideoTask>={}):VideoTask {const id=crypto.randomUUID();return {id,device_id:"dev-1",sub_token_id:null,idempotency_key:id,request_hash:"hash",status:"submitting",upstream_task_id:null,route_json:JSON.stringify({reference_image_ids:ids}),price_usd:0,pricing_snapshot_json:"{}",result_url:null,error_code:null,poll_after:null,poll_lease_until:null,created_at:Date.now(),updated_at:Date.now(),...patch};}
async function uploaded(f:Awaited<ReturnType<typeof setup>>,token="master") {const r=await f.upload(png(),"image/png",token);expect(r.status).toBe(201);return await r.json() as {id:string;content_type:string;size_bytes:number;expires_at:number};}

describe("private video references: real SQLite plus streamed in-memory R2",()=>{
  it("fails closed without R2 and accepts only authenticated binary image uploads",async()=>{
    const f=await setup();expect((await f.upload(png(),"image/png","wrong")).status).toBe(401);
    expect((await f.upload(png(),"text/plain")).status).toBe(415);
    delete f.env.VIDEO_REFERENCES;expect((await f.upload(png())).status).toBe(503);
  });
  it("rejects lengthless streams before storage reservation",async()=>{
    const f=await setup();const res=await f.app.request("https://gateway.test/video/reference-images",{method:"POST",headers:{authorization:"Bearer master","content-type":"image/png"},body:png()},f.env);
    expect(res.status).toBe(411);expect(f.r2.objects.size).toBe(0);expect(f.d1.row<any>("SELECT COUNT(*) n FROM video_reference_assets")!.n).toBe(0);
  });
  it("validates PNG JPEG WebP headers and dimensions, returns metadata only, stores actual checksum",async()=>{
    const f=await setup();for(const [b,type] of [[png(),"image/png"],[jpeg(),"image/jpeg"],[webp(),"image/webp"]] as const) {
      const r=await f.upload(b,type);expect(r.status).toBe(201);expect(r.headers.get("cache-control")).toBe("no-store");const a=await r.json() as any;
      expect(Object.keys(a).sort()).toEqual(["content_type","expires_at","id","size_bytes"]);expect(a.size_bytes).toBe(b.length);
      const row=await getVideoReferenceAsset(f.env,a.id);expect(row).toMatchObject({width:32,height:24,state:"ready"});expect(row!.checksum_sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect((await f.upload(new Uint8Array(64))).status).toBe(415);expect((await f.upload(png(64,0,1))).status).toBe(400);
    expect((await f.upload(png(64,32768,32768))).status).toBe(400);expect((await f.upload(png(),"image/webp")).status).toBe(415);
  });
  it("checks actual streamed bytes, bounds output chunks, rejects declared lies and overflow",async()=>{
    const f=await setup();const big=png(VIDEO_REFERENCE_MAX_BYTES);expect((await f.upload(big)).status).toBe(201);expect(f.r2.maxChunk).toBeLessThanOrEqual(65536);
    expect((await f.upload(png(VIDEO_REFERENCE_MAX_BYTES+1))).status).toBe(413);
    expect((await f.upload(png(),"image/png","master",{"content-length":"1"})).status).toBe(413);
    expect((await f.upload(png(),"image/png","master",{"content-length":"100"})).status).toBe(400);
    expect(f.d1.row<any>("SELECT COUNT(*) n FROM video_reference_assets WHERE state='uploading'")!.n).toBe(0);
  });
  it("handles split streams with explicit length without whole-image buffering",async()=>{
    const f=await setup();const b=png(200000);let offset=0;
    const stream=new ReadableStream({pull(c){if(offset===b.length){c.close();return;}const end=Math.min(offset+7,b.length);c.enqueue(b.slice(offset,end));offset=end;}});
    const req=new Request("https://gateway.test/video/reference-images",{method:"POST",headers:{authorization:"Bearer master","content-type":"image/png","content-length":"200000"},body:stream,duplex:"half"} as RequestInit);
    const r=await f.app.request(req,{},f.env);expect(r.status).toBe(201);expect((await r.json() as any).size_bytes).toBe(b.length);expect(f.r2.maxChunk).toBeLessThanOrEqual(65536);
  });
  it("stops multi-chunk overflow and bounds malicious JPEG header search",async()=>{
    const f=await setup();let sent=0,cancelled=false;
    const stream=new ReadableStream({pull(c){if(sent===0){c.enqueue(png(65536));sent+=65536;return;}c.enqueue(new Uint8Array(65536));sent+=65536;},cancel(){cancelled=true;}},{highWaterMark:0});
    const req=new Request("https://gateway.test/video/reference-images",{method:"POST",headers:{authorization:"Bearer master","content-type":"image/png","content-length":String(VIDEO_REFERENCE_MAX_BYTES)},body:stream,duplex:"half"} as RequestInit);
    const r=await f.app.request(req,{},f.env);expect(r.status).toBe(413); 
    expect(sent).toBeLessThanOrEqual(VIDEO_REFERENCE_MAX_BYTES+2*65536);expect(f.r2.maxChunk).toBeLessThanOrEqual(65536);expect(cancelled).toBe(true);expect(f.r2.objects.size).toBe(0);
    const b=new Uint8Array(70000);b.set([255,216,255,225,255,255]);expect((await f.upload(b,"image/jpeg")).status).toBe(415);
  });
  it("rejects oversized single transport chunks without storing an image",async()=>{
    const f=await setup();const bytes=png(1024*1024+1);
    const res=await f.app.request("https://gateway.test/video/reference-images",{method:"POST",headers:{authorization:"Bearer master","content-type":"image/png","content-length":String(bytes.length)},body:bytes},f.env);
    expect(res.status).toBe(413);expect(f.r2.objects.size).toBe(0);
    expect(f.d1.row<any>("SELECT COUNT(*) n FROM video_reference_assets WHERE state = 'uploading'")!.n).toBe(0);
  });
  it("reads three reference identities with one SELECT per validation/signing phase",async()=>{
    const f=await setup();const ids=[(await uploaded(f)).id,(await uploaded(f)).id,(await uploaded(f)).id].reverse();
    const prepare=vi.spyOn(f.env.DB,"prepare");
    const assets=await validateVideoReferences(f.env,f.device,ids);
    expect(assets.map(a=>a.id)).toEqual(ids);
    const urls=await buildVideoReferenceUrls(f.env,f.device,assets,"https://gateway.test");
    expect(urls.map(url=>new URL(url).pathname.split("/").at(-2))).toEqual(ids);
    expect(prepare.mock.calls.filter(([sql])=>String(sql).startsWith("SELECT * FROM video_reference_assets WHERE id IN"))).toHaveLength(2);
    prepare.mockRestore();
  });
  it("fails closed when the authoritative reference read limiter denies or malforms its response",async()=>{
    const f=await setup();const a=await uploaded(f);const [url]=await buildVideoReferenceUrls(f.env,f.device,await validateVideoReferences(f.env,f.device,[a.id]),"https://gateway.test");
    for(const reply of [Response.json({allowed:false}),Response.json({}),Response.json({allowed:true},{status:503})]) {
      f.env.RATE_LIMITER={idFromName:(s:string)=>s,get:()=>({fetch:async()=>reply})} as unknown as DurableObjectNamespace;
      const res=await f.app.request(url,{},f.env);expect(res.status).toBe(429);expect(res.headers.get("retry-after")).toBe("60");
    }
    delete f.env.RATE_LIMITER;const ok=await f.app.request(url,{},f.env);expect(ok.status).toBe(200);await ok.arrayBuffer();
  });
  it("caps simultaneous uploads across accounts before allocating body buffers",async()=>{
    const f=await setup();const prepare=f.env.DB.prepare.bind(f.env.DB);let entered=0;let resume!:()=>void;
    const gate=new Promise<void>(resolve=>{resume=resolve;});
    const spy=vi.spyOn(f.env.DB,"prepare").mockImplementation((...args:unknown[])=>{const statement=prepare(String(args[0]));if(String(args[0]).startsWith("INSERT INTO video_reference_assets")){const run=statement.run;statement.run=async()=>{entered++;await gate;return run();};}return statement;});
    const pending=Array.from({length:8},()=>f.upload(png()));
    try {
      for(let i=0;i<50 && entered<8;i++)await new Promise(resolve=>setTimeout(resolve,1));
      expect(entered).toBe(8);const rejected=await f.upload(png());expect(rejected.status).toBe(429);expect(rejected.headers.get("retry-after")).toBe("60");
    } finally {resume();await Promise.all(pending);spy.mockRestore();}
    expect((await f.upload(png())).status).toBe(201);
  });
  it("rejects expired binding and more than 15MiB aggregate in atomic SQL",async()=>{
    const f=await setup();const a=await uploaded(f);
    f.d1.sql("UPDATE video_reference_assets SET expires_at=? WHERE id=?",Date.now()-1,a.id);
    await expect(createVideoTask(f.env,task([a.id]),undefined,[a.id])).rejects.toThrow("invalid_video_references");
    f.d1.sql("UPDATE video_reference_assets SET expires_at=?,size_bytes=? WHERE id=?",Date.now()+10000,15728641,a.id);
    await expect(createVideoTask(f.env,task([a.id]),undefined,[a.id])).rejects.toThrow("invalid_video_references");expect(f.holds.size).toBe(0);
  });
  it("isolates master/sub and sibling accounts and rejects duplicates, URL inputs, and >3 refs",async()=>{
    const f=await setup();const a=await uploaded(f);const s=await uploaded(f,"sub");const sub={...f.device,auth_via:"sub",sub_token_id:"sub-1"} as AuthedDevice;
    expect((await validateVideoReferences(f.env,f.device,[a.id]))[0].id).toBe(a.id);
    for(const [d,ids] of [[sub,[a.id]],[f.device,[s.id]],[{...f.device,id:"other"},[a.id]],[f.device,[a.id,a.id]],[f.device,["https://evil/"]],[f.device,[a.id,a.id,a.id,a.id]]] as [AuthedDevice,string[]][]) await expect(validateVideoReferences(f.env,d,ids)).rejects.toThrow("invalid_video_references");
    expect((await f.app.request("https://gateway.test/video/reference-images/"+s.id,{headers:{authorization:"Bearer master"}},f.env)).status).toBe(404);
  });
  it("atomically enforces shared account concurrency, 100MiB live bytes and 20/hour quotas",async()=>{
    const f=await setup();const reservations=await Promise.all(Array.from({length:8},()=>reserveVideoReferenceAsset(f.env,f.device,"image/png")));
    expect(reservations.filter(Boolean)).toHaveLength(2);
    f.d1.sql("UPDATE video_reference_assets SET state='ready',size_bytes=52428800");expect(await reserveVideoReferenceAsset(f.env,f.device,"image/png")).toBeNull();
    f.d1.sql("UPDATE video_reference_assets SET state='deleted',size_bytes=0");
    for(let i=0;i<18;i++) {const a=await reserveVideoReferenceAsset(f.env,f.device,"image/png");expect(a).not.toBeNull();f.d1.sql("UPDATE video_reference_assets SET state='deleted' WHERE id=?",a!.id);}
    expect(await reserveVideoReferenceAsset(f.env,{...f.device,auth_via:"sub",sub_token_id:"sub-1"},"image/png")).toBeNull();
  });
  it("binds only task-insert winner, rejects concurrent reuse and rolls back hold/wallet on invalid owner",async()=>{
    const f=await setup();const a=await uploaded(f);const t=task([a.id]);const loser=task([a.id]);
    const results=await Promise.allSettled([createVideoTask(f.env,t,undefined,[a.id]),createVideoTask(f.env,loser,undefined,[a.id])]);
    expect(results.filter(r=>r.status==="fulfilled" && r.value)).toHaveLength(1);expect(f.d1.row<any>("SELECT COUNT(*) n FROM video_tasks")!.n).toBe(1);
    expect(f.holds.size).toBe(1);expect((await getVideoReferenceAsset(f.env,a.id))!.task_id).toBe(t.id);
    expect(await createVideoTask(f.env,t,undefined,[a.id])).toBe(false);
    const b=await uploaded(f);const bad=task([b.id],{sub_token_id:"sub-1",price_usd:2});f.d1.sql("UPDATE device_wallets SET balance_usd=10");
    await expect(createVideoTask(f.env,bad,undefined,[b.id])).rejects.toThrow("invalid_video_references");
    expect((await getVideoReferenceAsset(f.env,b.id))!.task_id).toBeNull();expect(f.holds.size).toBe(1);expect(f.d1.row<any>("SELECT reserved_usd FROM device_wallets")!.reserved_usd).toBe(0);
    await expect(createVideoTask(f.env,task([b.id]),undefined,[])).rejects.toThrow("invalid_video_references");
  });
  it("ignored idempotency collision leaves new assets unbound; failed hold rolls binding back",async()=>{
    const f=await setup();const a=await uploaded(f);const b=await uploaded(f);const t=task([a.id]);expect(await createVideoTask(f.env,t,undefined,[a.id])).toBe(true);
    expect(await createVideoTask(f.env,task([b.id],{idempotency_key:t.idempotency_key}),undefined,[b.id])).toBe(false);
    expect((await getVideoReferenceAsset(f.env,b.id))!.task_id).toBeNull();
    f.d1.sql("CREATE TRIGGER reject_reference_hold BEFORE INSERT ON reserve_holds BEGIN SELECT RAISE(ABORT,'hold_failed'); END");
    await expect(createVideoTask(f.env,task([b.id]),undefined,[b.id])).rejects.toThrow("hold_failed");expect((await getVideoReferenceAsset(f.env,b.id))!.task_id).toBeNull();
  });
  it("provider tickets need no browser credential; reject tampering, wrong id, expiry and current revocation",async()=>{
    const f=await setup();const a=await uploaded(f);const assets=await validateVideoReferences(f.env,f.device,[a.id]);const [url]=await buildVideoReferenceUrls(f.env,f.device,assets,"https://gateway.test");
    const ok=await f.app.request(url,{},f.env);expect(ok.status).toBe(200);expect(new Uint8Array(await ok.arrayBuffer())).toEqual(png());expect(ok.headers.get("cache-control")).toBe("no-store");
    const tampered=new URL(url);tampered.searchParams.set("ticket",tampered.searchParams.get("ticket")!.slice(0,-4)+"AAAA");expect((await f.app.request(tampered,{},f.env)).status).toBe(404);
    expect((await f.app.request(url.replace(a.id,"vref_"+"0".repeat(32)),{},f.env)).status).toBe(404);
    f.d1.sql("UPDATE devices SET enabled=0 WHERE id='dev-1'");expect((await f.app.request(url,{},f.env)).status).toBe(404);f.d1.sql("UPDATE devices SET enabled=1 WHERE id='dev-1'");
    const s=await uploaded(f,"sub");const sub={...f.device,auth_via:"sub",sub_token_id:"sub-1"} as AuthedDevice;const [su]=await buildVideoReferenceUrls(f.env,sub,await validateVideoReferences(f.env,sub,[s.id]),"https://gateway.test");
    f.d1.sql("UPDATE device_sub_tokens SET revoked_at=1 WHERE id='sub-1'");expect((await f.app.request(su,{},f.env)).status).toBe(404);
    f.d1.sql("UPDATE video_reference_assets SET expires_at=1 WHERE id=?",a.id);expect((await f.app.request(url,{},f.env)).status).toBe(404);
  });
  it("cleanup retains active short-TTL content, expires unbound/terminal, hard-stops unknown at seven days",async()=>{
    const f=await setup();const day=86400000;const old=Date.now()-2*day;const a=await uploaded(f);const b=await uploaded(f);const c=await uploaded(f);const t=task([b.id]);const u=task([c.id]);
    await createVideoTask(f.env,t,undefined,[b.id]);await createVideoTask(f.env,u,undefined,[c.id]);
    f.d1.sql("UPDATE video_reference_assets SET created_at=?,expires_at=?",old,old+day);
    f.d1.sql("UPDATE video_tasks SET status='succeeded',updated_at=? WHERE id=?",old,t.id);
    f.d1.sql("UPDATE video_tasks SET status='submission_unknown' WHERE id=?",u.id);
    expect(await pruneVideoReferenceAssets(f.env)).toBe(2);expect((await getVideoReferenceAsset(f.env,c.id))!.state).toBe("ready");
    f.d1.sql("UPDATE video_reference_assets SET created_at=? WHERE id=?",Date.now()-8*day,c.id);expect(await pruneVideoReferenceAssets(f.env)).toBe(1);
    expect(f.d1.row<any>("SELECT error_code,poll_attempts FROM video_tasks WHERE id=?",u.id)).toEqual({error_code:"reference_assets_expired",poll_attempts:20});
  });
  it("failed cleanup retains storage reservation and is retried; immutable ready cannot be finalized twice",async()=>{
    const f=await setup();const a=await uploaded(f);const row=(await getVideoReferenceAsset(f.env,a.id))!;
    expect(await finishVideoReferenceAsset(f.env,row,1,1,1,null)).toBe(false);
    f.d1.sql("UPDATE video_reference_assets SET expires_at=1 WHERE id=?",a.id);f.r2.failDelete=true;expect(await pruneVideoReferenceAssets(f.env)).toBe(0);
    expect((await getVideoReferenceAsset(f.env,a.id))!).toMatchObject({state:"lost",size_bytes:64});f.r2.failDelete=false;
    expect(await pruneVideoReferenceAssets(f.env)).toBe(0);  
    f.d1.sql("UPDATE video_reference_cleanup SET next_attempt_at=0 WHERE asset_id=?",a.id);
    expect(await pruneVideoReferenceAssets(f.env)).toBe(1);
  });
});
