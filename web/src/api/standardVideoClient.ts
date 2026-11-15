import { getConsoleToken } from "./consoleClient";
import { parseStandardVideoTask, parseStandardReference, precheckStandardReference, standardVideoResultUrl, standardVideoTicketUrl, validateStandardVideoInput, type StandardVideoAttempt, type StandardReference, type ReferenceUploadLimits } from "../utils/standardVideoTask";
import { videoExpiryTime, type VideoContentTicket } from "../utils/videoReferences";
export class StandardVideoApiError extends Error {
  constructor(readonly status: number, readonly retryAt = 0, readonly notDispatched = false) {
    super(status === 409 ? "提交记录冲突，请管理员人工复核；禁止重新付费提交" : status === 429 ? "视频接口限流，请稍后手动查询" : "视频请求未获确认（HTTP " + status + "）；请查询记录，勿更换 key 重发");
  }
}
const MAX_JSON = 65536;
export async function boundedStandardVideoJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length") || 0) > MAX_JSON) { await response.body?.cancel(); throw Error("视频响应超出安全大小限制"); }
  const reader = response.body?.getReader(); if (!reader) throw Error("视频响应为空");
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_JSON) { await reader.cancel(); throw Error("视频响应超出安全大小限制"); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw Error("视频响应无效；保留提交记录，不会自动重新生成"); }
}
const readBackoff = new Map<string, number>();
async function request(token: string, path: string, init: RequestInit = {}, authenticated = true): Promise<unknown> {
  if (!token || token !== getConsoleToken()) throw Error("设备 Token 已变化，请重新查询");
  const isGet = !init.method || init.method === "GET";
  if (isGet && Date.now() < (readBackoff.get(token) || 0)) throw new StandardVideoApiError(429, readBackoff.get(token));
  const response = await fetch(path, {...init, credentials:"omit", redirect:"error", headers:{...(authenticated ? {Authorization:"Bearer " + token} : {}), ...init.headers}});
  if (token !== getConsoleToken() || init.signal?.aborted) { await response.body?.cancel(); throw Error("设备 Token 已变化，请重新查询"); }
  let retryAt = 0;
  if (response.status === 429) { const raw = response.headers.get("Retry-After"), seconds = Number(raw); retryAt = Math.max(Date.now() + 15000, raw && Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(raw || "") || Date.now() + 60000); if (isGet) readBackoff.set(token, retryAt); }
  const notDispatched = path === "/v1/videos" && init.method === "POST" && response.status >= 400 && response.status < 500 && response.status !== 409 && response.headers.get("X-Cpg-Video-Dispatch") === "not-started";
  let data: unknown;
  try { data = await boundedStandardVideoJson(response); } catch { if (!response.ok) throw new StandardVideoApiError(response.status, retryAt, notDispatched); throw Error("视频响应无效；保留提交记录，请手动查询"); }
  if (!response.ok) throw new StandardVideoApiError(response.status, retryAt, notDispatched);
  if (token !== getConsoleToken() || init.signal?.aborted) throw Error("设备 Token 已变化，请重新查询");
  return data;
}
export const standardVideoApi = {
  async limits(token: string, kind: "videos" | "images", signal?: AbortSignal): Promise<ReferenceUploadLimits> {
    const data = await request(token, "/v1/videos/reference-" + kind + "/limits", {signal}) as {item?: Partial<ReferenceUploadLimits>};
    const v = data?.item;
    if (!v || v.enabled !== true) return {enabled:false, formats:[], max_bytes:0, max_duration_ms:0};
    if (!Array.isArray(v.formats) || !v.formats.length || v.formats.some(f => typeof f !== "string") || !Number.isSafeInteger(v.max_bytes) || Number(v.max_bytes) <= 0 || kind === "videos" && (!Number.isSafeInteger(v.max_duration_ms) || Number(v.max_duration_ms) <= 0)) throw Error("参考上传限制未正确配置");
    return {enabled:true, formats:v.formats, max_bytes:Number(v.max_bytes), max_duration_ms:Number(v.max_duration_ms || 0)};
  },
  async upload(token: string, kind: "videos" | "images", file: File, limits: ReferenceUploadLimits, signal?: AbortSignal): Promise<StandardReference> {
    precheckStandardReference(file, limits);
    const asset = parseStandardReference(await request(token, "/v1/videos/reference-" + kind, {method:"POST", headers:{"Content-Type":file.type}, body:file, signal}), file);
    if (kind === "videos" && (!Number.isSafeInteger(asset.duration_ms) || Number(asset.duration_ms) <= 0 || Number(asset.duration_ms) > limits.max_duration_ms)) throw Error("服务器返回的参考视频时长无效");
    return asset;
  },
  async remove(token: string, kind: "videos" | "images", id: string, signal?: AbortSignal): Promise<void> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw Error("参考 ID 无效");
    await request(token, "/v1/videos/reference-" + kind + "/" + id, {method:"DELETE", signal});
  },
  async create(token: string, attempt: StandardVideoAttempt, signal?: AbortSignal) {
    if (attempt.task || attempt.conflict || attempt.rejected === true) throw Error("已确认或冲突的提交只能查询，禁止重发");
    validateStandardVideoInput(attempt.body, attempt.request_format ? {request_format:attempt.request_format} : undefined);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(attempt.key)) throw Error("提交 key 无效");
    return parseStandardVideoTask(await request(token, "/v1/videos", {method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":attempt.key},body:JSON.stringify(attempt.body),signal}));
  },
  async list(token: string, signal?: AbortSignal) {
    const v = await request(token, "/v1/videos", {signal}) as {data?: unknown[]};
    if (!Array.isArray(v?.data)) throw Error("视频任务列表无效"); return v.data.slice(0,30).map(parseStandardVideoTask);
  },
  async get(token: string, id: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw Error("任务 ID 无效");
    return parseStandardVideoTask(await request(token, "/v1/videos/" + encodeURIComponent(id), {signal}));
  },
  async ticket(token: string, id: string, result: string, signal?: AbortSignal): Promise<VideoContentTicket> {
    const path = standardVideoResultUrl(result, id); if (!path) throw Error("仅允许当前任务同源结果");
    const v = await request(token, path + "-ticket", {method:"POST",signal}) as Partial<VideoContentTicket>;
    const url = standardVideoTicketUrl(v?.url,path);
    if (!url || !Number.isFinite(videoExpiryTime(v.expires_at)) || videoExpiryTime(v.expires_at) <= Date.now()) throw Error("视频票据无效或过期，请手动重新获取");
    return {url, expires_at:v.expires_at!};
  },
};