import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthedDevice, Env } from "../types";
import { authenticateGateway } from "./auth";
import { readBoundedBody } from "./embeddings";
import { VideoUploadLifetime } from "./video_upload_lifecycle";

export { call as callReferenceService, referenceOrigin as referenceServiceOrigin };
const MAX_BYTES = 5 * 1024 * 1024;
const ID = /^[a-f0-9]{32}$/;
const TYPES = ["image/png", "image/jpeg", "image/webp"];
function fail(status: 400 | 401 | 404 | 409 | 411 | 413 | 415 | 429 | 503, code: string): never { throw new HTTPException(status, { message: code }); }
export function referenceServiceOwner(device: AuthedDevice): string {
  return JSON.stringify([device.id, device.auth_via === "sub" ? device.sub_token_id : null]);
}
function service(env: Env): Fetcher {
  return env.VIDEO_REFERENCE_IMAGES ?? fail(503, "reference_service_unavailable");
}
function checkedIds(ids: string[]): void {
  if (!Array.isArray(ids) || ids.length > 9 || ids.some(id => typeof id !== "string" || !ID.test(id)) || new Set(ids).size !== ids.length) fail(400, "invalid_video_references");
}
function metadata(value: any, expectedId?: string): { id: string; bytes: number; content_type: string; expires_at: number } {
  if (!value || !ID.test(value.id) || (expectedId && value.id !== expectedId) || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_BYTES || !TYPES.includes(value.content_type) || !Number.isSafeInteger(value.expires_at) || value.expires_at <= Date.now()/1000) fail(503, "invalid_reference_service_result");
  return { id: value.id, bytes: value.bytes, content_type: value.content_type, expires_at: value.expires_at };
}
async function call(env: Env, path: string, init: RequestInit = {}, life?: VideoUploadLifetime, timeoutMs = 30_000): Promise<any> {
  const target = service(env);
  const controller = new AbortController();
  const remove = life?.onStop(() => controller.abort());
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const work = (async () => {
    const response = await target.fetch(new Request("https://reference-images.internal" + path, { ...init, signal: controller.signal, redirect: "manual", ...(init.body instanceof ReadableStream ? { duplex: "half" } : {}) }));
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 404) fail(404, "video_reference_not_found");
      if (response.status === 409) fail(409, "video_reference_bound");
      if (response.status === 429) fail(429, "reference_service_quota_exceeded");
      if (response.status === 400 || response.status === 415) fail(415, "invalid_reference_image");
      if (response.status === 413) fail(413, "reference_image_too_large");
      fail(503, "reference_service_unavailable");
    }
    const raw = await readBoundedBody(response.body, 8192, controller.signal);
    try { return JSON.parse(raw); } catch { fail(503, "invalid_reference_service_result"); }
  })();
  try {
    return life ? await life.wait(life.track(work)) : await work;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    fail(503, "reference_service_unavailable");
  } finally { clearTimeout(timer); remove?.(); }
}
export async function validateServiceImageIds(env: Env, device: AuthedDevice, ids: string[]): Promise<void> {
  checkedIds(ids);
  if (ids.length) referenceOrigin(env);
  for (const id of ids) metadata(await call(env, "/v1/assets/" + id + "?owner=" + encodeURIComponent(referenceServiceOwner(device))), id);
}
export async function bindServiceImageIds(env: Env, device: AuthedDevice, ids: string[], taskId: string): Promise<string[]> {
  checkedIds(ids);
  if (!/^vid_[A-Za-z0-9_-]{8,160}$/.test(taskId)) fail(400, "invalid_video_task");
  if (!ids.length) return [];
  const origin = referenceOrigin(env);
  const expires = Math.floor(Date.now()/1000) + 86400;
  const urls: string[] = [];
  for (const id of ids) {
    const result = await call(env, "/v1/assets/" + id + "/bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: referenceServiceOwner(device), task_id: taskId, expires_at: expires }) });
    let u: URL;
    try { u = new URL(result.url); } catch { fail(503, "invalid_reference_service_result"); }
    if (result.id !== id || result.expires_at !== expires || u.origin !== origin || u.username || u.password || u.hash || u.pathname !== "/assets/" + id || u.search.length > 2048) fail(503, "invalid_reference_service_result");
    urls.push(u.toString());
  }
  return urls;
}
function referenceOrigin(env: Env): string {
  try {
    const u = new URL(env.VIDEO_REFERENCE_IMAGE_ORIGIN ?? "");
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/" || (u.port && u.port !== "443") || !/^[a-z0-9.-]+\.[a-z]+$/i.test(u.hostname) || /(?:^|\.)(?:localhost|local|internal|lan)$/.test(u.hostname)) throw new Error();
    return u.origin;
  } catch { fail(503, "reference_origin_unavailable"); }
}
let uploads = 0;
export async function uploadServiceReferenceImage(c: Context<{ Bindings: Env }>): Promise<Response> {
  c.header("Cache-Control", "no-store");
  if (uploads >= 2) fail(429, "reference_upload_busy");
  uploads++;
  const life = new VideoUploadLifetime(c.req.raw.signal, () => { uploads--; }, () => new HTTPException(400, { message: "reference_upload_timeout" }), () => new HTTPException(400, { message: "reference_upload_interrupted" }), 30_000);
  try {
    const device = await life.wait(life.track(authenticateGateway(c)));
    if (!device) fail(401, "unauthorized");
    service(c.env); life.check();
    const type = (c.req.header("content-type") ?? "").split(";")[0].toLowerCase().trim();
    if (!TYPES.includes(type)) fail(415, "unsupported_reference_content_type");
    const header = c.req.header("content-length");
    if (!header) fail(411, "reference_content_length_required");
    const length = /^\d+$/.test(header) ? Number(header) : NaN;
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BYTES) fail(413, "reference_image_too_large");
    if (!c.req.raw.body) fail(400, "invalid_reference_image");
    const reader = c.req.raw.body.getReader();
    const remove = life.onStop(() => { void reader.cancel().catch(() => {}); });
    let bytes = new Uint8Array(length); let offset = 0;
    try {
      while (true) {
        life.check(); const item = await life.wait(life.track(reader.read()));
        if (item.done) break;
        if (!(item.value instanceof Uint8Array) || offset + item.value.length > length) fail(413, "reference_image_too_large");
        bytes.set(item.value, offset); offset += item.value.length;
      }
      if (offset !== length) fail(400, "reference_length_mismatch");
    } finally { remove(); void reader.cancel().catch(() => {}); }
    life.check();
    const result = metadata(await call(c.env, "/v1/assets", { method: "POST", headers: { "content-type": type, "content-length": String(bytes.length), "x-cpg-owner": referenceServiceOwner(device), "x-cpg-account": device.id }, body: bytes }, life));
    bytes = new Uint8Array(0); life.check();
    return c.json(result, 201);
  } catch (error) {
    life.stop(error instanceof Error ? error : new Error("reference_service_unavailable")); throw error;
  } finally { life.returnedResponse(); }
}
export async function deleteServiceReferenceImage(c: Context<{ Bindings: Env }>): Promise<Response> {
  c.header("Cache-Control", "no-store");
  const device = await authenticateGateway(c); if (!device) fail(401, "unauthorized");
  const id = c.req.param("id") || ""; checkedIds([id]);
  const result = await call(c.env, "/v1/assets/" + id, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: referenceServiceOwner(device) }) });
  if (result?.deleted !== true) fail(503, "invalid_reference_service_result");
  return c.json({ deleted: true });
}
