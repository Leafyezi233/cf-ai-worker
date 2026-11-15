import type { Context } from "hono";
import { VideoReadLifecycle } from "./video_read_lifecycle";
import type { Env } from "../types";
import { authenticateGateway } from "./auth";
import { getVideoTask, type VideoTask } from "../db/video_tasks";
import { isEncryptedSecret, openSecret } from "../utils/crypto";
import { safeVideoUrl, videoCreationEndpoint } from "./video_config";
import { secureVideoEndpoint } from "./secure_skill_video_config";
import { videoUpstreamModel } from "./video_endpoint";
import { BoundedWindow } from "../utils/boundedWindow";
import { signVideoTicket, verifyVideoTicket } from "./video_tickets";

type C = Context<{ Bindings: Env }>;
type Owner = { device_id: string; sub_token_id: string | null };
export const VIDEO_CONTENT_LIMITS = Object.freeze({ maxBytes: 256 * 1024 * 1024, maxChunkBytes: 1024 * 1024,
  deadlineMs: 120_000, idleMs: 15_000, headerMs: 15_000, concurrent: 16, perAccount: 2, rpm: 30 });
const windows = new BoundedWindow(1024, 8192);
const active = new Map<string, number>();
let activeCount = 0;
export function resetVideoContentLimits(): void { windows.clear(); }
const safeId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(v);
const privacyHeaders = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
function error(status: number, code: string): Response {
  return new Response(JSON.stringify({error:code}), {status, headers:{...privacyHeaders,"content-type":"application/json", ...(status === 429 ? {"retry-after":"60"} : {})}});
}
async function allowRequest(env: Env, owner: string): Promise<boolean> {
  if (!windows.hit(owner, VIDEO_CONTENT_LIMITS.rpm)) return false;
  if (!env.RATE_LIMITER) return true;  
  try {
    const ns = env.RATE_LIMITER;
    const r = await ns.get(ns.idFromName("video-content:" + owner)).fetch("https://rate-limiter.internal/consume?rpm=" + VIDEO_CONTENT_LIMITS.rpm, {method:"POST"});
    return r.ok && (await r.json() as {allowed?:boolean}).allowed === true;
  } catch { return false; }
}
function reserve(owner: string): (() => void) | null {
  const count = active.get(owner) || 0;
  if (activeCount >= VIDEO_CONTENT_LIMITS.concurrent || count >= VIDEO_CONTENT_LIMITS.perAccount) return null;
  active.set(owner, count + 1); activeCount++;
  let released = false;
  return () => { if (released) return; released = true; activeCount--; const n = (active.get(owner) || 1) - 1;
    if (n) active.set(owner,n); else active.delete(owner); };
}
function owns(task: VideoTask, owner: Owner): boolean {
  return task.device_id === owner.device_id && (owner.sub_token_id === null || task.sub_token_id === owner.sub_token_id);
}
function contentSource(task: VideoTask): {url: string; credential: string} | null {
  try {
    if (task.status !== "succeeded" || task.error_code || !safeVideoUrl(task.result_url) || !safeId(task.upstream_task_id)) return null;
    const r = JSON.parse(task.route_json);
    if (r.video?.adapter === "secure_skill") {
      if (typeof r.endpoint!=="string" || !r.endpoint.endsWith("/videos") || secureVideoEndpoint(r.endpoint.slice(0,-"/videos".length)) !== r.endpoint || !videoUpstreamModel(r.upstream_model) || r.upstream_model!==r.video.upstream_model || !isEncryptedSecret(r.credential)) return null;
      return {url:r.endpoint + "/" + encodeURIComponent(task.upstream_task_id) + "/content",credential:r.credential};
    }
    if (r.video?.adapter !== "moyuu" || typeof r.endpoint !== "string" || r.endpoint.length > 2048
      || /[\\\s%]/.test(r.endpoint) || /\/\.{1,2}(?:\/|$)/.test(r.endpoint) || !isEncryptedSecret(r.credential)) return null;
    const u = new URL(r.endpoint);
    const h = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.port && u.port !== "443")
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(h)
      || /(?:^|\.)(?:localhost|local|internal|home|lan|onion)$/.test(h)
      || !u.pathname.endsWith("/video/generations")) return null;
    if (videoCreationEndpoint(r.endpoint.slice(0,-"/video/generations".length)) !== r.endpoint) return null;
    const segments = u.pathname.split("/").slice(1);
    if (segments.some(s => !/^[A-Za-z0-9_~-]+$/.test(s))) return null;
    if (!r.endpoint.endsWith(u.pathname)) return null;
    u.pathname = u.pathname.slice(0,-"/video/generations".length) + "/videos/" + task.upstream_task_id + "/content";
    return {url:u.toString(), credential:r.credential};
  } catch { return null; }
}
interface ByteRange { start: number | null; end: number | null; header: string }
function parseRange(value: string | undefined): ByteRange | null | false {
  if (value === undefined) return null;
  if (value.length > 128) return false;
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) return false;
  const start = m[1] ? Number(m[1]) : null, end = m[2] ? Number(m[2]) : null;
  if ((start !== null && (!Number.isSafeInteger(start) || start < 0))
    || (end !== null && (!Number.isSafeInteger(end) || end < 0))
    || (start === null && (!end || end > VIDEO_CONTENT_LIMITS.maxBytes))
    || (start !== null && end !== null && (end < start || end - start + 1 > VIDEO_CONTENT_LIMITS.maxBytes))) return false;
  return {start,end,header:value};
}
async function requestOwner(c: C, id: string): Promise<Owner | null> {
  const tickets = c.req.queries("ticket");
  if (tickets) {
    if (tickets.length !== 1) return null;
    return verifyVideoTicket(c.env,tickets[0],"video",id);
  }
  const device = await authenticateGateway(c);
  return device ? {device_id:device.id,sub_token_id:device.auth_via === "sub" ? (device.sub_token_id ?? null) : null} : null;
}
export async function videoContentTicketHandler(c: C): Promise<Response> {
  if (c.req.method !== "POST") return error(405,"method_not_allowed");
  const id = c.req.param("id");
  if (!safeId(id)) return error(404,"video_not_found");
  const device = await authenticateGateway(c);
  if (!device) return error(401,"unauthorized");
  const owner = {device_id:device.id,sub_token_id:device.auth_via === "sub" ? (device.sub_token_id ?? null) : null};
  if (!await allowRequest(c.env,owner.device_id)) return error(429,"video_content_rate_limited");
  const task = await getVideoTask(c.env,id,owner.device_id);
  if (!task || !owns(task,owner)) return error(404,"video_not_found");
  if (!contentSource(task)) return error(409,"video_content_unavailable");
  try {
    const expires_at = Date.now() + 5 * 60_000;
    const ticket = await signVideoTicket(c.env,{kind:"video",id,...owner,expires_at});
    return new Response(JSON.stringify({url:"/v1/video/generations/" + id + "/content?ticket=" + encodeURIComponent(ticket),expires_at}),
      {headers:{...privacyHeaders,"content-type":"application/json"}});
  } catch { return error(503,"content_ticket_unavailable"); }
}

export async function videoContentHandler(c: C): Promise<Response> {
  if (c.req.method !== "GET") return error(405,"method_not_allowed");
  const id = c.req.param("id");
  if (!safeId(id)) return error(404,"video_not_found");
  const owner = await requestOwner(c,id);
  if (!owner) return error(401,"unauthorized");
  if (!await allowRequest(c.env,owner.device_id)) return error(429,"video_content_rate_limited");
  const task = await getVideoTask(c.env,id,owner.device_id);
  if (!task || !owns(task,owner)) return error(404,"video_not_found");
  const source = contentSource(task);
  if (!source) return error(409,"video_content_unavailable");
  if (!c.env.ENCRYPTION_KEY?.trim()) return error(503,"video_content_unavailable");
  const key = await openSecret(source.credential,c.env.ENCRYPTION_KEY);
  if (!key || /[\r\n]/.test(key)) return error(503,"video_content_unavailable");
  const range = parseRange(c.req.header("range"));
  if (range === false) return error(416,"invalid_video_range");
  const release = reserve(owner.device_id);
  if (!release) return error(429,"video_content_busy");
  const abort = new AbortController();
  const prefetched: Uint8Array[] = [];
  const lifetime = new VideoReadLifecycle({signal:c.req.raw.signal, release, error:"video_content_interrupted",
    totalMs:VIDEO_CONTENT_LIMITS.deadlineMs, idleMs:VIDEO_CONTENT_LIMITS.idleMs, headerMs:VIDEO_CONTENT_LIMITS.headerMs,
    onStop:() => { abort.abort(); prefetched.length = 0; }});
  const stop = lifetime.stop;
  try {
    if (lifetime.stopped) return error(499,"video_content_interrupted");
    const upstream = await lifetime.open(() => fetch(source.url,{method:"GET",redirect:"manual",signal:abort.signal,
      headers:{authorization:"Bearer " + key,accept:"video/mp4","accept-encoding":"identity",...(range ? {range:range.header} : {})}}), response => response.body);
    if (lifetime.stopped) throw new Error("video_content_interrupted");
    lifetime.armIdle();
    const reject = (status = 502, code = "video_content_upstream_error") => {stop(); return error(status,code);};
    if (upstream.status !== 200 && upstream.status !== 206) return reject();
    if (!upstream.body || upstream.headers.get("content-type")?.trim().toLowerCase() !== "video/mp4"
      || (upstream.headers.has("content-encoding") && upstream.headers.get("content-encoding")?.toLowerCase() !== "identity")) return reject();
    const lengthText = upstream.headers.get("content-length");
    const length = lengthText === null ? null : Number(lengthText);
    if (lengthText !== null && (!/^\d+$/.test(lengthText) || !Number.isSafeInteger(length) || length! <= 0 || length! > VIDEO_CONTENT_LIMITS.maxBytes)) return reject();
    if (upstream.status === 200 && length !== null && length < 12) return reject();
    const headers = new Headers({...privacyHeaders,"content-type":"video/mp4","content-disposition":'inline; filename="' + id + '.mp4"'});
    let start = 0;
    let expected = length;
    if (upstream.status === 206) {
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(upstream.headers.get("content-range") || "");
      if (!range || !m) return reject();
      const a = Number(m[1]), b = Number(m[2]), total = Number(m[3]);
      if (![a,b,total].every(Number.isSafeInteger) || a < 0 || b < a || total <= b || b-a+1 > VIDEO_CONTENT_LIMITS.maxBytes
        || (length !== null && length !== b-a+1)
        || (range.start !== null && (a !== range.start || b !== Math.min(range.end ?? total-1,total-1)))
        || (range.start === null && (a !== Math.max(0,total-range.end!) || b !== total-1))) return reject();
      start=a; expected=b-a+1;
      headers.set("content-range",m[0]); headers.set("accept-ranges","bytes");
    } else if (!range && upstream.headers.get("accept-ranges") === "bytes") headers.set("accept-ranges","bytes");
    else if (upstream.headers.get("accept-ranges") === "none") headers.set("accept-ranges","none");
    if (lengthText !== null) headers.set("content-length",lengthText);
    let received = 0, emptyChunks = 0;
    const read = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      const result = await lifetime.read();
      if (lifetime.stopped) throw new Error("video_content_interrupted");
      if (!result.done) {
        if (!result.value.byteLength) { if (++emptyChunks > 16) throw new Error("video_content_interrupted"); }
        else emptyChunks = 0;
        received += result.value.byteLength;
        if (result.value.byteLength > VIDEO_CONTENT_LIMITS.maxChunkBytes || received > VIDEO_CONTENT_LIMITS.maxBytes
          || (expected !== null && received > expected)) throw new Error("video_content_interrupted");
      } else if (expected !== null && received !== expected) throw new Error("video_content_interrupted");
      return result;
    };
    if (start === 0 && (expected === null || expected >= 12)) {
      const signature = new Uint8Array(12); let size=0;
      while (size < 12) {
        const next = await read();
        if (next.done) return reject();
        if (!next.value.byteLength) continue;
        prefetched.push(next.value);
        const count=Math.min(12-size,next.value.byteLength); signature.set(next.value.subarray(0,count),size); size+=count;
      }
      if (signature[4] !== 102 || signature[5] !== 116 || signature[6] !== 121 || signature[7] !== 112) return reject();
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { lifetime.bind(controller); },
      async pull(controller) {
        try {
          if (lifetime.stopped) return;
          const buffered=prefetched.shift();
          if (buffered) {controller.enqueue(buffered); return;}
          const next=await read();
          if (lifetime.stopped) return;
          if (next.done) {lifetime.finish(); controller.close();}
          else controller.enqueue(next.value);
        } catch {stop();}
      },
      cancel() {stop();}
    },{highWaterMark:0});
    return new Response(stream,{status:upstream.status,headers});
  } catch { stop(); return error(502,"video_content_upstream_error"); }
}
