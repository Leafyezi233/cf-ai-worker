export interface VideoGenerationInput {
  readonly model: string;
  readonly prompt: string;
  readonly seconds: number;
  readonly size: string;
  readonly reference_image_ids?: readonly string[];
}

export type VideoTaskStatus = "submitting" | "submission_unknown" | "pending" | "succeeded" | "failed";
export interface VideoTaskView {
  id: string;
  model: string;
  status: VideoTaskStatus;
  seconds: number;
  size: string;
  price_per_call: number;
  cost_usd: number;
  result_url?: string;
  error_code?: string;
  next_poll_at?: string | number;
  requires_review?: boolean;
  created_at: string | number;
  updated_at: string | number;
}

export interface VideoPublicLimits {
  sizes: readonly string[];
  seconds_min?: number;
  seconds_max?: number;
  reference_images?: { max_images: number };
}

export const VIDEO_POLL_INTERVAL_MS = 15_000;
export const VIDEO_STATUS_LABELS: Record<VideoTaskStatus, string> = {
  submitting: "正在提交",
  submission_unknown: "提交结果未知（禁止重新付费提交）",
  pending: "生成中",
  succeeded: "成功",
  failed: "失败",
};

export function videoNeedsPolling(status: VideoTaskStatus): boolean {
  return status === "submitting" || status === "pending";
}

export function safeVideoResultUrl(raw: string | undefined, taskId?: string): string | null {
  if (!raw || !/^\/v1\/video\/generations\/[A-Za-z0-9_-]{1,128}\/content$/.test(raw)) return null;
  return taskId === undefined || raw === `/v1/video/generations/${encodeURIComponent(taskId)}/content` ? raw : null;
}

export function validateVideoInput(input: VideoGenerationInput, limits?: VideoPublicLimits): void {
  if (!input || typeof input.model !== "string" || !input.model.trim() || input.model.length > 256) throw new Error("请选择视频模型（最多 256 字符）");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 8000) throw new Error("请输入视频提示词（最多 8000 字符）");
  if (!Number.isInteger(input.seconds) || input.seconds < 3 || input.seconds > 15) {
    throw new Error("视频时长必须是 3–15 秒的整数；仍须符合管理员限制");
  }
  if (typeof input.size !== "string" || !/^[1-9][0-9]{2,3}x[1-9][0-9]{2,3}$/.test(input.size)) throw new Error("分辨率请填写宽x高，例如 1280x720；不代表管理员已允许该规格");
  if (input.reference_image_ids !== undefined) {
    const ids = input.reference_image_ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3 || ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error("参考图必须为 1–3 个不重复的网关图片 ID");
    const max = limits?.reference_images?.max_images;
    if (limits && (!Number.isInteger(max) || !max || max < 1 || max > 3 || ids.length > max)) throw new Error("管理员未声明参考图能力或图片数量超出限制");
  }
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 32 * 1024) throw new Error("视频请求 JSON 的 UTF-8 大小不能超过 32 KiB");
  if (limits && (!limits.sizes.includes(input.size) || input.seconds < (limits.seconds_min ?? 3) || input.seconds > (limits.seconds_max ?? 15))) {
    throw new Error("视频规格不在管理员允许范围内");
  }
}

export interface VideoAttempt {
  readonly key: string;
  readonly body: VideoGenerationInput;
  readonly taskId?: string;
  readonly taskStatus?: VideoTaskStatus;
  readonly possible_sent: boolean;
}

export function createVideoAttempt(input: VideoGenerationInput, randomUUID: () => string = () => crypto.randomUUID()): VideoAttempt {
  validateVideoInput(input);
  return Object.freeze({ key: randomUUID(), body: Object.freeze({ model: input.model, prompt: input.prompt, seconds: input.seconds, size: input.size, ...(input.reference_image_ids !== undefined ? { reference_image_ids: Object.freeze([...input.reference_image_ids]) } : {}) }), possible_sent: false });
}

export function confirmVideoAttempt(attempt: VideoAttempt, task: VideoTaskView): VideoAttempt {
  return Object.freeze({ ...attempt, possible_sent: true, taskId: task.id, taskStatus: task.status });
}

export function canRetryVideoAttempt(attempt: VideoAttempt): boolean {
  return !attempt.taskId;
}

export function canStartNewVideoAttempt(attempt: VideoAttempt): boolean {
  return attempt.taskStatus === "succeeded" || attempt.taskStatus === "failed";
}

export async function prepareVideoAttemptForPost(attempt: VideoAttempt, persist: (next: VideoAttempt) => Promise<void>): Promise<VideoAttempt> {
  if (!canRetryVideoAttempt(attempt)) throw new Error("任务已确认，禁止重新提交");
  validateVideoInput(attempt.body);
  const uncertain = Object.freeze({ ...attempt, possible_sent: true });
  await persist(uncertain);
  return uncertain;
}

export function canReleaseUnsentVideoAttempt(attempt: VideoAttempt): boolean {
  return attempt.possible_sent === false && !attempt.taskId;
}

export function canReleaseRejectedVideoAttempt(attempt: VideoAttempt, definitelyNotDispatched: boolean): boolean {
  return definitelyNotDispatched && canReleaseUnsentVideoAttempt(attempt);
}

function validVideoPollTime(value: unknown): value is string | number {
  return (typeof value === "number" && Number.isFinite(value) && value >= 0) ||
    (typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value)));
}
export function videoTaskPollDue(task: VideoTaskView, now = Date.now()): boolean {
  if (!videoNeedsPolling(task.status) || task.requires_review) return false;
  return videoTaskReadDue(task, now);
}
export function videoTaskReadDue(task: VideoTaskView, now = Date.now()): boolean {
  if (task.next_poll_at == null) return true;
  const at = typeof task.next_poll_at === "number" ? task.next_poll_at : Date.parse(task.next_poll_at);
  return Number.isFinite(at) && now >= at;
}

export const VIDEO_TASK_HISTORY_CAP = 60;
export function mergeVideoTaskHistory(previous: readonly VideoTaskView[], incoming: readonly VideoTaskView[], currentId?: string): VideoTaskView[] {
  const unique = new Map<string, VideoTaskView>();
  for (const task of [...incoming, ...previous]) if (!unique.has(task.id)) unique.set(task.id, task);
  const all = [...unique.values()];
  const current = all.filter(task => task.id === currentId);
  const rest = all.filter(task => task.id !== currentId);
  const active = (task: VideoTaskView) => task.status !== "succeeded" && task.status !== "failed";
  return [...current, ...rest.filter(active), ...rest.filter(task => !active(task))].slice(0, VIDEO_TASK_HISTORY_CAP);
}

async function attemptStorageKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return "cpg.video.attempt." + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,"0")).join("");
}
interface VideoAttemptStorage { getItem(key:string):string|null; setItem(key:string,value:string):void; removeItem(key:string):void }
export async function saveVideoAttempt(token: string, attempt: VideoAttempt | null, storage:VideoAttemptStorage): Promise<void> {
  const key = await attemptStorageKey(token);
  if (attempt) storage.setItem(key, JSON.stringify(attempt));
  else storage.removeItem(key);
}
export async function loadVideoAttempt(token: string, storage:VideoAttemptStorage): Promise<VideoAttempt | null> {
  const raw = storage.getItem(await attemptStorageKey(token));
  if (raw === null) return null;
  const value = JSON.parse(raw) as VideoAttempt;
  if (!value || !/^[A-Za-z0-9_-]{8,128}$/.test(value.key)) throw new Error("视频提交记录无效；请联系管理员核对任务，勿重新提交");
  validateVideoInput(value.body);
  if (value.taskId !== undefined && (typeof value.taskId !== "string" || !value.taskId)) throw new Error("视频任务记录无效");
  if (value.taskStatus !== undefined && !Object.prototype.hasOwnProperty.call(VIDEO_STATUS_LABELS,value.taskStatus)) throw new Error("视频任务状态无效");
  if (value.possible_sent !== undefined && typeof value.possible_sent !== "boolean") throw new Error("视频派发记录无效");
  return Object.freeze({...value, possible_sent: value.possible_sent !== false || !!value.taskId, body:Object.freeze({...value.body, ...(value.body.reference_image_ids !== undefined ? { reference_image_ids: Object.freeze([...value.body.reference_image_ids]) } : {})})});
}

export function parseVideoTaskView(value: unknown): VideoTaskView {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("视频 API 返回了无效任务；请查询任务列表，勿创建新任务");
  const task = value as Record<string, unknown>;
  const statuses = Object.keys(VIDEO_STATUS_LABELS);
  if (typeof task.id !== "string" || !task.id || typeof task.model !== "string" ||
      typeof task.status !== "string" || !statuses.includes(task.status) ||
      typeof task.seconds !== "number" || !Number.isFinite(task.seconds) || typeof task.size !== "string" ||
      typeof task.price_per_call !== "number" || !Number.isFinite(task.price_per_call) || task.price_per_call < 0 ||
      typeof task.cost_usd !== "number" || !Number.isFinite(task.cost_usd) || task.cost_usd < 0 ||
      !(typeof task.created_at === "number" || typeof task.created_at === "string") ||
      !(typeof task.updated_at === "number" || typeof task.updated_at === "string") ||
      (task.result_url != null && typeof task.result_url !== "string") ||
      (task.error_code != null && typeof task.error_code !== "string") ||
      (task.requires_review != null && typeof task.requires_review !== "boolean") ||
      (task.next_poll_at != null && !validVideoPollTime(task.next_poll_at))) {
    throw new Error("视频 API 返回了无效任务；请查询任务列表，勿创建新任务");
  }
  const normalized = { ...task };
  if (normalized.result_url === null) delete normalized.result_url;
  if (normalized.error_code === null) delete normalized.error_code;
  if (normalized.next_poll_at === null) delete normalized.next_poll_at;
  if (normalized.requires_review === null) delete normalized.requires_review;
  return normalized as unknown as VideoTaskView;
}
