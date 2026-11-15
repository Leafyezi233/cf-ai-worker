import { videoExpiryTime } from "./videoReferences";

export interface StandardVideoLimits {
  request_format?: "doubao_content"; default_duration?: number; default_ratio?: string; max_total_refs?: number; allow_tail_only?: boolean; content_available?: boolean;
  resolutions?: string[]; ratios?: string[]; default_resolution?: string; seconds_min?: number; seconds_max?: number;
  min_images?: number; max_images?: number; max_videos?: number; max_audios?: number;
  support_first_last?: boolean; support_video_urls?: boolean; support_audio_urls?: boolean;
  support_audio_only?: boolean; max_audio_only?: number;
}
export interface StandardVideoInput {
  model: string; prompt: string; duration: number; ratio: string; resolution: string;
  reference_image_ids?: string[]; reference_video_ids?: string[]; first_frame_id?: string; last_frame_id?: string; audio_urls?: string[]; image_urls?: string[]; video_urls?: string[];
}
export type StandardVideoStatus = "queued" | "in_progress" | "completed" | "failed" | "submission_unknown";
export interface StandardVideoTask { id: string; status: StandardVideoStatus; model: string; duration: number; ratio: string; resolution: string; result_url?: string; content_available?: boolean; requires_review: boolean; next_poll_at?: number; cost?: number }
export interface StandardVideoAttempt { key: string; body: StandardVideoInput; request_format?: "doubao_content"; task?: StandardVideoTask; conflict?: boolean; rejected?: boolean }
const localId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export function standardVideoResultUrl(raw: unknown, id?: string): string | null {
  if (typeof raw !== "string" || !/^\/v1\/(?:videos|video\/generations)\/[A-Za-z0-9_-]{1,128}\/content$/.test(raw)) return null;
  const parts = raw.split("/");
  return id && parts[parts.length - 2] !== id ? null : raw;
}
export function standardVideoTicketUrl(raw: unknown, path: string): string | null {
  if (!standardVideoResultUrl(path) || typeof raw !== "string" || raw.length > 8192 || !raw.startsWith(path + "?ticket=")) return null;
  const ticket = raw.slice(path.length + 8);
  try { const decoded = decodeURIComponent(ticket); return /^enc:v1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(decoded) && encodeURIComponent(decoded) === ticket ? raw : null; } catch { return null; }
}
export function parseStandardVideoTask(value: unknown): StandardVideoTask {
  if (!value || typeof value !== "object") throw Error("视频任务响应无效");
  const v = value as Record<string, unknown>;
  if (!localId(v.id) || (v.task_id !== undefined && v.task_id !== v.id) || !["queued", "in_progress", "completed", "failed", "submission_unknown"].includes(String(v.status)) || typeof v.model !== "string" || typeof v.ratio !== "string" || typeof v.resolution !== "string" || !Number.isInteger(v.duration) || Number(v.duration) < 4 || Number(v.duration) > 30) throw Error("视频任务响应无效");
  const path = standardVideoResultUrl(v.result_url ?? v.video_url ?? v.url, v.id);
  return { id: v.id, status: v.status as StandardVideoStatus, model: v.model, duration: Number(v.duration), ratio: v.ratio, resolution: v.resolution,
    requires_review: v.requires_review === true || v.status === "submission_unknown", ...(typeof v.content_available === "boolean" ? {content_available:v.content_available} : {}), ...(path && v.content_available !== false ? { result_url: path } : {}),
    ...(typeof v.next_poll_at === "number" && Number.isFinite(v.next_poll_at) ? {next_poll_at: v.next_poll_at} : {}),
    ...(typeof (v.cost_usd ?? v.cost) === "number" && Number.isFinite(v.cost_usd ?? v.cost) && Number(v.cost_usd ?? v.cost) >= 0 ? {cost: Number(v.cost_usd ?? v.cost)} : {}) };
}
export function publicAudioUrl(raw: string): boolean {
  try { const u = new URL(raw); return u.protocol === "https:" && !u.username && !u.password && !u.hash && (!u.port || u.port === "443") && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(u.hostname) && !/(?:^|\.)(?:localhost|local|internal|home|lan|onion|test|invalid|example|arpa)$/i.test(u.hostname); } catch { return false; }
}
export function validateStandardVideoInput(b: StandardVideoInput, limits?: StandardVideoLimits): void {
  const doubao = limits?.request_format === "doubao_content";
  if (!b || typeof b !== "object" || Object.keys(b).some(k => !["model","prompt","duration","ratio","resolution","reference_image_ids","reference_video_ids","first_frame_id","last_frame_id","audio_urls",...(doubao ? ["image_urls","video_urls"] : [])].includes(k)) || typeof b.model !== "string" || typeof b.prompt !== "string" || typeof b.ratio !== "string" || typeof b.resolution !== "string" || [b.reference_image_ids,b.reference_video_ids,b.audio_urls,b.image_urls,b.video_urls].some(v => v !== undefined && (!Array.isArray(v) || v.some(x => typeof x !== "string"))) || [b.first_frame_id,b.last_frame_id].some(v => v !== undefined && (typeof v !== "string" || !/^[a-f0-9]{32}$/.test(v)))) throw Error("视频提交参数无效");
  if (!b.model.trim() || b.model.length > 256 || !b.prompt.trim() || b.prompt.length > 8000 || !Number.isInteger(b.duration) || b.duration < 4 || b.duration > (doubao ? 30 : 15) || !/^[1-9][0-9]?:[1-9][0-9]?$/.test(b.ratio) || !/^[A-Za-z0-9_-]{1,32}$/.test(b.resolution)) throw Error("请填写有效的模型、提示词、所声明的秒数时长、比例与分辨率");
  const images = b.reference_image_ids || [], videos = b.reference_video_ids || [], audio = b.audio_urls || [], frames = [b.first_frame_id, b.last_frame_id].filter((v): v is string => !!v);
  const ids = [...images, ...videos, ...frames];
  if (ids.some(v => !/^[a-f0-9]{32}$/.test(v)) || new Set(ids).size !== ids.length || images.length + frames.length > 9 || videos.length > 3 || audio.length > (doubao ? 10 : 3) || audio.some(v => !publicAudioUrl(v)) || new Set(audio).size !== audio.length) throw Error("参考素材无效或超出限制");
  const externalImages=b.image_urls||[], externalVideos=b.video_urls||[];
  const urls=[...externalImages,...externalVideos,...audio];
  if (doubao && (externalImages.length + images.length + frames.length > 30 || externalVideos.length + videos.length > 10 || externalImages.length + images.length + frames.length + externalVideos.length + videos.length + audio.length > 50)) throw Error("参考素材超出安全上限");
  if (urls.some(v=>!publicAudioUrl(v)) || new Set(urls.map(v=>new URL(v).href)).size!==urls.length || externalImages.length && b.reference_image_ids!==undefined || externalVideos.length && b.reference_video_ids!==undefined) throw Error("参考 URL 无效或重复/混合私有 ID");
  if (frames.length && (images.length || videos.length || externalImages.length || externalVideos.length || (!doubao && audio.length))) throw Error("首尾帧不能与多模态参考混用");
  if (!doubao && b.last_frame_id && !b.first_frame_id) throw Error("尾帧需要先上传首帧");
  if (!limits || limits.resolutions === undefined && limits.seconds_min === undefined) return;
  if (!limits.resolutions?.includes(b.resolution) || !limits.ratios?.includes(b.ratio) || typeof limits.seconds_min !== "number" || typeof limits.seconds_max !== "number" || b.duration < limits.seconds_min || b.duration > limits.seconds_max) throw Error("规格尚未配置或超出管理员限制");
  const count = images.length + frames.length + externalImages.length;
  const videoCount = videos.length + externalVideos.length;
  if (doubao && count + videoCount + audio.length > (limits.max_total_refs ?? 0)) throw Error("参考素材总数超出管理员能力限制");
  if (count > (limits.max_images ?? 0) || count < (limits.min_images ?? 0) || frames.length && !limits.support_first_last || videoCount > (limits.max_videos ?? 0) || videoCount && !limits.support_video_urls || audio.length > (limits.max_audios ?? 0) || audio.length && !limits.support_audio_urls) throw Error("参考素材超出管理员能力限制");
  if (audio.length && !count && !videoCount && (!limits.support_audio_only || audio.length > (limits.max_audio_only ?? 0))) throw Error("管理员未允许此音频单独参考模式");
}
export interface ReferenceUploadLimits { enabled: boolean; formats: string[]; max_bytes: number; max_duration_ms: number }
export interface StandardReference { id: string; bytes: number; content_type: string; duration_ms?: number; expires_at: string | number }
export function precheckStandardReference(file: Pick<File, "type" | "size">, limits: ReferenceUploadLimits): void {
  if (!limits.enabled) throw Error("参考文件上传未配置，请联系管理员");
  if (!limits.formats.includes(file.type)) throw Error("文件格式不在管理员允许列表中");
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > limits.max_bytes) throw Error("文件大小超出管理员限制");
}
export function parseStandardReference(raw: unknown, file: Pick<File, "type" | "size">): StandardReference {
  const v = raw as Partial<StandardReference> | null;
  if (!v || typeof v.id !== "string" || !/^[a-f0-9]{32}$/.test(v.id) || v.bytes !== file.size || v.content_type !== file.type || !Number.isFinite(videoExpiryTime(v.expires_at)) || videoExpiryTime(v.expires_at) <= Date.now()) throw Error("参考文件响应无效；不会创建视频任务");
  return {id:v.id, bytes:v.bytes, content_type:v.content_type, expires_at:v.expires_at!, ...(typeof v.duration_ms === "number" ? {duration_ms:v.duration_ms} : {})};
}
interface JournalStorage { getItem(key:string):string|null; setItem(key:string,value:string):void; removeItem(key:string):void }
async function journalKey(token: string): Promise<string> {
  if (!token) throw Error("需要设备 Token");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return "cpg.standard-video.v1." + Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}
export async function saveStandardVideoAttempt(token: string, attempt: StandardVideoAttempt | null, storage: JournalStorage): Promise<void> {
  const key = await journalKey(token);
  if (attempt) { validateStandardVideoInput(attempt.body, attempt.request_format ? {request_format:attempt.request_format} : undefined); storage.setItem(key, JSON.stringify(attempt)); if (storage.getItem(key) !== JSON.stringify(attempt)) throw Error("无法可靠保存提交记录，禁止创建"); }
  else storage.removeItem(key);
}
export async function loadStandardVideoAttempt(token: string, storage: JournalStorage): Promise<StandardVideoAttempt | null> {
  const raw = storage.getItem(await journalKey(token)); if (raw === null) return null;
  try { const a = JSON.parse(raw) as StandardVideoAttempt; if (!/^[A-Za-z0-9_-]{8,128}$/.test(a.key)) throw Error(); validateStandardVideoInput(a.body, a.request_format === "doubao_content" ? {request_format:a.request_format} : undefined); if (a.task) a.task = parseStandardVideoTask(a.task); return a; }
  catch { throw Error("持久提交记录损坏；请联系管理员复核，不可清空后重新付费提交"); }
}
export function newStandardVideoAttempt(body: StandardVideoInput, limits?: StandardVideoLimits): StandardVideoAttempt { validateStandardVideoInput(body,limits); return {key:crypto.randomUUID(), body:JSON.parse(JSON.stringify(body)) as StandardVideoInput, ...(limits?.request_format ? {request_format:limits.request_format} : {})}; }
export function standardAttemptFinished(a: StandardVideoAttempt): boolean { return !a.conflict && (a.rejected === true && !a.task || !!a.task && !a.task.requires_review && ["completed", "failed"].includes(a.task.status)); }