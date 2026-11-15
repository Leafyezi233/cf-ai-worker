import { parseVideoReferenceUpload, validateVideoReferenceFiles, parseVideoContentTicket, type VideoReferenceUpload, type VideoContentTicket } from "../utils/videoReferences";
import { safeVideoResultUrl } from "../utils/videoTask";
import { getConsoleToken } from "./consoleClient";
import { canRetryVideoAttempt, parseVideoTaskView, validateVideoInput, VIDEO_POLL_INTERVAL_MS, type VideoAttempt, type VideoTaskView } from "../utils/videoTask";

export class VideoApiError extends Error {
  readonly response: { status: number };
  constructor(message: string, readonly status: number, readonly dispatch?: "not_started", readonly retryAt?: number) {
    super(message);
    this.name = "VideoApiError";
    this.response = { status };
  }
}
export function videoDefinitelyNotDispatched(error: unknown): boolean {
  return error instanceof VideoApiError && error.dispatch === "not_started" &&
    error.status >= 400 && error.status < 500 && error.status !== 409;
}
export function videoErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { status?: unknown; response?: { status?: unknown } };
  const status = value.response?.status ?? value.status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}
function retryTime(raw: string | null, now: number): number {
  const seconds = raw !== null && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
  const parsed = Number.isFinite(seconds) ? now + seconds * 1000 : raw ? Date.parse(raw) : NaN;
  return Math.max(now + VIDEO_POLL_INTERVAL_MS, Number.isFinite(parsed) ? parsed : now + 60_000);
}
let readRetryAt = 0;
let readRetryToken = "";

async function videoRequest(path: string, init?: RequestInit): Promise<unknown> {
  const token = getConsoleToken();
  if (!token) throw new Error("请先登录设备 Token");
  const isGet = !init?.method || init.method === "GET";
  if (isGet && token === readRetryToken && Date.now() < readRetryAt) {
    throw new VideoApiError("视频查询限流，请遵守退避后再刷新", 429, undefined, readRetryAt);
  }
  const response = await fetch(path, {
    ...init,
    credentials: "omit",
    headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const retryAt = isGet && response.status === 429 ? retryTime(response.headers.get("Retry-After"), Date.now()) : undefined;
  if (retryAt) { readRetryToken = token; readRetryAt = retryAt; }
  let data: unknown;
  try { data = await response.json(); } catch {
    throw new VideoApiError(`视频 API 未返回 JSON（HTTP ${response.status}）；请查询任务，勿使用新 key 重发`, response.status, undefined, retryAt);
  }
  if (!response.ok) {
    const obj = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const error = obj.error && typeof obj.error === "object" ? obj.error as Record<string, unknown> : obj;
    const message = typeof error.message === "string" ? error.message : typeof error.error === "string" ? error.error : `HTTP ${response.status}`;
    const dispatch = error.dispatch === "not_started" || obj.dispatch === "not_started" ? "not_started" : undefined;
    throw new VideoApiError(`视频 API：${message}`, response.status, dispatch, retryAt);
  }
  return data;
}

export const videoApi = {
  async uploadReference(file: File, signal?: AbortSignal): Promise<VideoReferenceUpload> {
    validateVideoReferenceFiles([file], 3);
    const data = await videoRequest("/v1/video/reference-images", { method: "POST", headers: { "Content-Type": file.type }, body: file, signal });
    return parseVideoReferenceUpload(data, file);
  },
  async contentTicket(id: string, resultUrl: string, signal?: AbortSignal): Promise<VideoContentTicket> {
    const path = safeVideoResultUrl(resultUrl, id);
    if (!path) throw new Error("视频结果必须是当前任务的同源内容端点，禁止上游链接回退");
    return parseVideoContentTicket(await videoRequest(path + "-ticket", { method: "POST", signal }), path);
  },
  async create(attempt: VideoAttempt, signal?: AbortSignal): Promise<VideoTaskView> {
    if (!canRetryVideoAttempt(attempt)) throw new Error("服务端已确认任务，仅可查询状态，禁止重新提交");
    validateVideoInput(attempt.body);
    const data = await videoRequest("/v1/video/generations", {
      method: "POST", headers: { "Idempotency-Key": attempt.key }, body: JSON.stringify(attempt.body), signal,
    });
    return parseVideoTaskView(data);
  },
  async list(signal?: AbortSignal): Promise<VideoTaskView[]> {
    const data = await videoRequest("/v1/video/generations", { signal });
    if (!data || typeof data !== "object" || !Array.isArray((data as { data?: unknown }).data)) throw new Error("视频列表 API 必须返回 {data: VideoTaskView[]}");
    return ((data as { data: unknown[] }).data).slice(0, 30).map(parseVideoTaskView);
  },
  async get(id: string, signal?: AbortSignal): Promise<VideoTaskView> {
    return parseVideoTaskView(await videoRequest(`/v1/video/generations/${encodeURIComponent(id)}`, { signal }));
  },
};
