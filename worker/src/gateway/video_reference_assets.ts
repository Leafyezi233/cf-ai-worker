import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthedDevice, Env } from "../types";
import { authenticateGateway } from "./auth";
import { signVideoTicket, verifyVideoTicket } from "./video_tickets";
import { openReferenceBody, reserveReferenceRead } from "./video_reference_stream";
import { BoundedWindow } from "../utils/boundedWindow";
import { VideoUploadLifetime } from "./video_upload_lifecycle";
import { withVideoReferenceR2Budget } from "../db/video_reference_budget";
const readWindows = new BoundedWindow(1024,8192);
import { completeVideoReferenceWrite, markVideoReferenceUploadUncertain, discardVideoReferenceAsset, finishVideoReferenceAsset, getVideoReferenceAsset, getVideoReferenceAssets, referenceOwner, reserveVideoReferenceAsset, VIDEO_REFERENCE_MAX_BYTES, type VideoReferenceAsset } from "../db/video_reference_assets";
export type { VideoReferenceAsset } from "../db/video_reference_assets";
export { pruneVideoReferenceAssets } from "../db/video_reference_assets";
function fail(status: 400 | 401 | 404 | 411 | 413 | 415 | 429 | 502 | 503, code: string): never { throw new HTTPException(status,{message:code}); }
const validId = (id: unknown): id is string => typeof id === "string" && /^vref_[a-f0-9]{32}$/.test(id);
const headers = {"Cache-Control":"no-store", "X-Content-Type-Options":"nosniff"};
function bucket(env: Env): R2Bucket { return env.VIDEO_REFERENCES || fail(503,"video_references_unavailable"); }
function publicAsset(a: VideoReferenceAsset) { return {id:a.id,content_type:a.content_type,size_bytes:a.size_bytes,expires_at:a.expires_at}; }
function owned(a: VideoReferenceAsset, d: AuthedDevice) { return a.device_id === d.id && a.sub_token_id === referenceOwner(d); }
export async function validateVideoReferences(env: Env, device: AuthedDevice, ids: string[]): Promise<VideoReferenceAsset[]> {
  if (!Array.isArray(ids) || ids.length > 3 || new Set(ids).size !== ids.length || ids.some(id => !validId(id))) fail(400,"invalid_video_references");
  if (!ids.length) return [];
  bucket(env);
  const out: VideoReferenceAsset[] = [];
  const rows = new Map((await getVideoReferenceAssets(env,ids)).map(a => [a.id,a]));
  for (const id of ids) {
    const a = rows.get(id);
    if (!a || !owned(a,device) || a.state !== "ready" || a.expires_at <= Date.now() || a.task_id !== null) fail(400,"invalid_video_references");
    out.push(a);
  }
  if (out.reduce((n,a) => n + a.size_bytes,0) > 15 * 1024 * 1024) fail(400,"invalid_video_references");
  return out;
}
export async function buildVideoReferenceUrls(env: Env, device: AuthedDevice, assets: VideoReferenceAsset[], origin: string): Promise<string[]> {
  if (!assets.length) return [];
  bucket(env);
  let base: URL;
  try { base = new URL(origin); } catch { fail(503,"video_reference_origin_unavailable"); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) fail(503,"video_reference_origin_unavailable");
  if (assets.length > 3 || new Set(assets.map(a=>a.id)).size !== assets.length) fail(400,"invalid_video_references");
  const urls: string[] = [];
  const rows = new Map((await getVideoReferenceAssets(env,assets.map(a => a.id))).map(a => [a.id,a]));
  for (const given of assets) {
    const a = rows.get(given.id);
    if (!a || !owned(a,device) || a.state !== "ready" || a.expires_at <= Date.now()) fail(400,"invalid_video_references");
    const ticket = await signVideoTicket(env,{kind:"reference",id:a.id,device_id:device.id,sub_token_id:referenceOwner(device),expires_at:a.expires_at});
    urls.push(base.origin + "/video/reference-images/" + a.id + "/content?ticket=" + encodeURIComponent(ticket));
  }
  return urls;
}
function dimensions(b: Uint8Array, type: string): [number,number] | null {
  const n = b.length; const view = new DataView(b.buffer,b.byteOffset,b.byteLength);
  const text = (o:number,l:number) => String.fromCharCode(...b.subarray(o,o+l));
  const check = (w:number,h:number): [number,number] => {
    if (!w || !h || w > 32768 || h > 32768 || w*h > 64_000_000) fail(400,"invalid_reference_dimensions");
    return [w,h];
  };
  if (type === "image/png") {
    if (n < 33) return null;
    if (text(0,8) !== "\x89PNG\r\n\x1a\n" || view.getUint32(8) !== 13 || text(12,4) !== "IHDR") fail(415,"invalid_reference_image");
    const depths: Record<number, number[]> = {0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
    if (!depths[b[25]]?.includes(b[24]) || b[26] !== 0 || b[27] !== 0 || b[28] > 1) fail(415,"invalid_reference_image");
    return check(view.getUint32(16),view.getUint32(20));
  }
  if (type === "image/webp") {
    if (n < 30) return null;
    if (text(0,4) !== "RIFF" || text(8,4) !== "WEBP" || view.getUint32(4,true)+8 > VIDEO_REFERENCE_MAX_BYTES) fail(415,"invalid_reference_image");
    const u24 = (o:number) => b[o] | b[o+1]<<8 | b[o+2]<<16;
    if (text(12,4) === "VP8X" && view.getUint32(16,true) === 10) return check(u24(24)+1,u24(27)+1);
    if (text(12,4) === "VP8L" && b[20] === 0x2f) return check(1+((b[22]&63)<<8|b[21]),1+((b[24]&15)<<10|b[23]<<2|b[22]>>6));
    if (text(12,4) === "VP8 " && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a) return check(view.getUint16(26,true)&16383,view.getUint16(28,true)&16383);
    fail(415,"invalid_reference_image");
  }
  if (n < 4) return null;
  if (b[0] !== 255 || b[1] !== 216) fail(415,"invalid_reference_image");
  let o = 2;
  while (o + 4 <= n) {
    if (b[o++] !== 255) fail(415,"invalid_reference_image");
    while (o < n && b[o] === 255) o++;
    if (o + 3 > n) return null;
    const marker = b[o++];
    if (marker === 0xda || marker === 0xd9 || marker === 0 || marker === 0xd8) fail(415,"invalid_reference_image");
    if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
    const len = view.getUint16(o); if (len < 2) fail(415,"invalid_reference_image");
    if (o + len > n) return null;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (len < 8 || !b[o+7] || len !== 8+3*b[o+7]) fail(415,"invalid_reference_image");
      return check(view.getUint16(o+5),view.getUint16(o+3));
    }
    o += len;
  }
  return null;
}
const MAX_TRANSPORT_CHUNK = 1024 * 1024;
let activeUploads = 0;
export async function uploadVideoReferenceImage(c: Context<{Bindings:Env}>): Promise<Response> {
  if (activeUploads >= 8) { c.header("Retry-After","60"); fail(429,"reference_upload_busy"); }
  activeUploads++;
  const life = new VideoUploadLifetime(c.req.raw.signal, () => { activeUploads--; },
    () => new HTTPException(400,{message:"reference_upload_timeout"}),
    () => new HTTPException(400,{message:"reference_upload_interrupted"}));
  try { return await uploadReferenceImage(c,life); }
  catch (error) { life.stop(error instanceof Error ? error : new Error("reference_storage_unavailable")); throw error; }
  finally { life.returnedResponse(); }
}

async function uploadReferenceImage(c: Context<{Bindings:Env}>, life: VideoUploadLifetime): Promise<Response> {
  c.header("Cache-Control","no-store"); const storage = bucket(c.env); life.check();
  const background = (work: () => Promise<unknown>): Promise<unknown> => {
    const pending = life.track(Promise.resolve().then(work));
    void pending.catch(() => {});
    try { c.executionCtx.waitUntil(pending.catch(() => {})); } catch {   }
    return pending;
  };
  const discard = async (asset: VideoReferenceAsset, outcome: "stored" | "not_stored" | "unknown") => {
    if (outcome !== "unknown") await completeVideoReferenceWrite(c.env,asset,outcome === "stored");
    else await markVideoReferenceUploadUncertain(c.env,asset);
    await discardVideoReferenceAsset(c.env,asset);
  };
  const device = await life.wait(life.track(authenticateGateway(c))); if (!device) fail(401,"unauthorized");
  const type = (c.req.header("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!["image/jpeg","image/png","image/webp"].includes(type)) fail(415,"unsupported_reference_content_type");
  const lengthHeader = c.req.header("content-length");
  if (lengthHeader === undefined) fail(411,"reference_content_length_required");
  const declared = /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > VIDEO_REFERENCE_MAX_BYTES) fail(413,"reference_image_too_large");
  if (!c.req.raw.body) fail(400,"invalid_reference_image");
  const reservation = life.track(reserveVideoReferenceAsset(c.env,device,type).then(asset => {
    if (asset && life.error) void background(() => discard(asset,"not_stored"));
    return asset;
  }));
  const asset = await life.wait(reservation); if (!asset) fail(429,"reference_upload_quota_exceeded");
  life.check();
  const reader = c.req.raw.body.getReader(); const prefix = new Uint8Array(65536);
  let used = 0, total = 0, offset = 0, ended = false;
  const state: {chunk: Uint8Array | null} = {chunk:null};
  let putStarted = false, putSettled = false, putStored = false, cancelled = false;
  let inputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const pipeAbort = new AbortController();
  const cancelReader = () => {
    if (cancelled) return; cancelled = true;
    try { void life.track(reader.cancel()).catch(() => {}); } catch {   }
  };
  const removeStop = life.onStop(() => {
    pipeAbort.abort(); cancelReader(); state.chunk = null;
    try { inputController?.error(life.error); } catch {   }
  });
  async function next() {
    life.check();
    const part = await life.wait(life.track(reader.read())); life.check();
    if (part.done) {ended=true;state.chunk=null;return;}
    if (part.value.byteLength > MAX_TRANSPORT_CHUNK) fail(413,"reference_transport_chunk_too_large");
    total += part.value.byteLength;
    if (total > VIDEO_REFERENCE_MAX_BYTES || total > declared) fail(413,"reference_image_too_large");
    state.chunk=part.value;offset=0;
  }
  try {
    let dims: [number,number] | null = null;
    while (!dims) {
      if (!state.chunk || offset === state.chunk.byteLength) await next();
      if (ended || !state.chunk) fail(415,"invalid_reference_image");
      const take = Math.min(state.chunk.byteLength-offset,prefix.length-used);
      prefix.set(state.chunk.subarray(offset,offset+take),used); used+=take;offset+=take;
      dims=dimensions(prefix.subarray(0,used),type);
      if (!dims && used === prefix.length) fail(415,"reference_header_too_large");
    }
    let sentPrefix=false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { inputController = controller; },
      async pull(controller) {
        try {
          life.check();
          if (!sentPrefix) {sentPrefix=true;controller.enqueue(prefix.subarray(0,used));return;}
          while (!state.chunk || offset === state.chunk.byteLength) {await next();if (ended) break;}
          if (ended) {
            if (total !== declared || type === "image/webp" && new DataView(prefix.buffer).getUint32(4,true)+8 !== total) fail(400,"reference_size_mismatch");
            controller.close();return;
          }
          const end=Math.min(offset+65536,state.chunk!.byteLength);controller.enqueue(state.chunk!.slice(offset,end));offset=end;
        } catch(error) { try { controller.error(error); } catch {} cancelReader(); }
      },
      cancel() { cancelReader(); }
    },{highWaterMark:0});
    let body: ReadableStream = stream;
    let piping: Promise<void> | null = null;
    if (typeof FixedLengthStream !== "undefined") {
      const fixed = new FixedLengthStream(declared); body=fixed.readable;
      piping=life.track(stream.pipeTo(fixed.writable,{signal:pipeAbort.signal})); void piping.catch(()=>{});
    }
    life.check();
    const putting = life.track(withVideoReferenceR2Budget(c.env,"put",() => {
      life.check(); putStarted=true;
      return storage.put(asset.object_key,body,{storageClass:"Standard",httpMetadata:{contentType:type,cacheControl:"no-store"}});
    }).then(stored => {
      putSettled=true; putStored=!!stored;
      if (life.error) void background(() => discard(asset,putStored ? "stored" : "not_stored"));
      return stored;
    },error => { putSettled=true; if (life.error) void background(() => discard(asset,"not_stored")); throw error; }));
    const stored = await life.wait(putting);
    if (piping) await life.wait(piping);
    life.check();
    if (!stored || !ended || stored.size !== total) fail(503,"reference_storage_unavailable");
    await life.wait(life.track(completeVideoReferenceWrite(c.env,asset,true))); life.check();
    const sum = stored.checksums?.sha256;
    const checksum = sum ? Array.from(new Uint8Array(sum),x=>x.toString(16).padStart(2,"0")).join("") : null;
    const finishing = life.track(finishVideoReferenceAsset(c.env,asset,total,dims[0],dims[1],checksum).then(ready => {
      if (life.error) void background(() => discard(asset,"stored"));
      return ready;
    }));
    if (!await life.wait(finishing)) fail(503,"reference_storage_unavailable");
    life.check(); removeStop(); reader.releaseLock();
    return c.json(publicAsset({...asset,size_bytes:total}),201,headers);
  } catch(error) {
    const alreadyStopped = !!life.error;
    life.stop(error instanceof Error ? error : new Error("reference_storage_unavailable"));
    const cleanup = background(() => discard(asset,!putStarted ? "not_stored" : !putSettled ? "unknown" : putStored ? "stored" : "not_stored"));
    if (!alreadyStopped) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([cleanup.catch(()=>{}),new Promise<void>(resolve=>{timer=setTimeout(resolve,250);})]); }
      finally { if(timer !== undefined) clearTimeout(timer); }
    }
    if (error instanceof HTTPException) throw error;
    fail(503,"reference_storage_unavailable");
  }
}

export async function getVideoReferenceMetadata(c: Context<{Bindings:Env}>): Promise<Response> {
  c.header("Cache-Control","no-store");bucket(c.env);
  const d=await authenticateGateway(c);if (!d) fail(401,"unauthorized");
  const a=await getVideoReferenceAsset(c.env,(c.req.param("id") || ""));
  if (!a || !owned(a,d) || a.state !== "ready" || a.expires_at <= Date.now()) fail(404,"reference_not_found");
  return c.json(publicAsset(a),200,headers);
}
export async function getVideoReferenceContent(c: Context<{Bindings:Env}>): Promise<Response> {
  c.header("Cache-Control","no-store"); const storage=bucket(c.env);const id=c.req.param("id");
  if (!validId(id)) fail(404,"reference_not_found");
  const ticket=await verifyVideoTicket(c.env,c.req.query("ticket") || "","reference",id);
  if (!ticket) fail(404,"reference_not_found");
  c.header("Referrer-Policy","no-referrer");
  const limited = () => { c.header("Retry-After","60"); return fail(429,"reference_content_rate_limited"); };
  if (!readWindows.hit(ticket.device_id,120)) limited();
  if (c.env.RATE_LIMITER) {
    try {
      const ns = c.env.RATE_LIMITER;
      const response = await ns.get(ns.idFromName("video-reference:"+ticket.device_id)).fetch("https://rate-limiter.internal/consume?rpm=120",{method:"POST"});
      if (!response.ok || (await response.json() as {allowed?:boolean}).allowed !== true) limited();
    } catch { limited(); }
  }
  const a=await getVideoReferenceAsset(c.env,id);
  if (!a || a.device_id !== ticket.device_id || a.sub_token_id !== ticket.sub_token_id || a.state !== "ready" || a.expires_at <= Date.now()) fail(404,"reference_not_found");
  if (a.task_id) {
    const task=await c.env.DB.prepare("SELECT id FROM video_tasks WHERE id = ? AND device_id = ? AND sub_token_id IS ? AND EXISTS " +
      "(SELECT 1 FROM json_each(route_json,'$.reference_image_ids') WHERE value = ?)").bind(a.task_id,a.device_id,a.sub_token_id,a.id).first();
    if (!task) fail(404,"reference_not_found");
  }
  const release = reserveReferenceRead(a.device_id);
  if (!release) limited();
  try {
    const stream = await openReferenceBody(signal => withVideoReferenceR2Budget(c.env,"get",() => {
      if (signal.aborted) throw new Error("reference_content_interrupted");
      return storage.get(a.object_key);
    }),a.size_bytes,c.req.raw.signal,release!);
    return new Response(stream,{headers:{...headers,"Referrer-Policy":"no-referrer","Content-Type":a.content_type,"Content-Length":String(a.size_bytes)}});
  } catch (error) { if (error instanceof HTTPException) throw error; fail(502,"reference_content_unavailable"); }
}
