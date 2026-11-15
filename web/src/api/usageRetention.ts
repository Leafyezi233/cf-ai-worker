import { api } from "./client";

export interface UsageRetentionResponse { item: Record<string, unknown> }
export interface UsageRetentionBatch { before: number; limit: number; after?: { createdAt: number; id: number } }
export const USAGE_RETENTION_CONFIRMATION = "DELETE_USAGE_DETAILS" as const;
export const USAGE_RETENTION_DEFAULT_LIMIT = 100;
export const USAGE_RETENTION_MAX_LIMIT = 1000;
export const USAGE_RETENTION_PENDING_KEY = "usage-retention.pending-cleanup.v1";
export interface PendingUsageRetentionCleanup { operationId: string; batch: UsageRetentionBatch }

export function readPendingUsageRetentionCleanup(): PendingUsageRetentionCleanup | null {
  const raw = sessionStorage.getItem(USAGE_RETENTION_PENDING_KEY);
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "batch,operationId"
    || typeof value.operationId !== "string" || !value.operationId || value.operationId.length > 200
    || !value.batch || typeof value.batch !== "object" || Array.isArray(value.batch)
    || Object.keys(value.batch).some(key => !["before", "limit", "after"].includes(key))
    || (value.batch.after !== undefined && (!value.batch.after || typeof value.batch.after !== "object" || Array.isArray(value.batch.after)
      || Object.keys(value.batch.after).sort().join(",") !== "createdAt,id")))
    throw new Error("本标签页的清理恢复记录无效；禁止开始新的清理，请先人工核查");
  return { operationId: value.operationId, batch: validateUsageRetentionBatch(value.batch) };
}

export function persistPendingUsageRetentionCleanup(input: PendingUsageRetentionCleanup): void {
  if (typeof input.operationId !== "string" || !input.operationId || input.operationId.length > 200) throw new Error("缺少清理操作幂等标识");
  const pending = { operationId: input.operationId, batch: validateUsageRetentionBatch(input.batch) };
  const previous = readPendingUsageRetentionCleanup();
  if (previous && (previous.operationId !== pending.operationId || !sameUsageRetentionBatch(previous.batch, pending.batch)))
    throw new Error("尚有未确认的清理操作；禁止覆盖恢复记录");
  const raw = JSON.stringify(pending);
  sessionStorage.setItem(USAGE_RETENTION_PENDING_KEY, raw);
  if (sessionStorage.getItem(USAGE_RETENTION_PENDING_KEY) !== raw) throw new Error("清理恢复记录未成功保存；未发送清理请求");
}

export function clearPendingUsageRetentionCleanup(input: PendingUsageRetentionCleanup): void {
  const previous = readPendingUsageRetentionCleanup();
  if (!previous || previous.operationId !== input.operationId || !sameUsageRetentionBatch(previous.batch, input.batch))
    throw new Error("清理恢复记录不匹配；保留锁定，请人工核查");
  sessionStorage.removeItem(USAGE_RETENTION_PENDING_KEY);
  if (sessionStorage.getItem(USAGE_RETENTION_PENDING_KEY) !== null) throw new Error("清理恢复记录未成功清除；保留同键恢复");
}
const HOUR = 3_600_000;

export function parseUsageRetentionUtcHour(value: string): number {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:00:00Z$/.test(value))
    throw new Error("截止时间须为显式 UTC 整点：YYYY-MM-DDTHH:00:00Z");
  const before = Date.parse(value);
  if (!Number.isSafeInteger(before) || before <= 0 || before % HOUR !== 0 || new Date(before).toISOString() !== value.replace("Z", ".000Z"))
    throw new Error("UTC 截止时间无效；请勿使用本地时间或非整点时间");
  return before;
}

export function validateUsageRetentionBatch(input: UsageRetentionBatch): UsageRetentionBatch {
  if (!Number.isSafeInteger(input.before) || input.before <= 0 || input.before % HOUR !== 0 || !Number.isFinite(new Date(input.before).getTime()))
    throw new Error("截止时间须为 UTC 整点 epoch 毫秒");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > USAGE_RETENTION_MAX_LIMIT)
    throw new Error("单批数量须为 1–1000 的整数");
  if (input.after !== undefined && (!Number.isSafeInteger(input.after.createdAt) || input.after.createdAt < 0 || !Number.isSafeInteger(input.after.id) || input.after.id < 0))
    throw new Error("游标须为 createdAt:id 两个非负安全整数，或留空");
  return { before: input.before, limit: input.limit, ...(input.after === undefined ? {} : { after: { createdAt: input.after.createdAt, id: input.after.id } }) };
}

export function usageRetentionBatchFromText(before: string, limit: string, after: string): UsageRetentionBatch {
  if (!/^[0-9]+$/.test(limit) || (after !== "" && !/^[0-9]+:[0-9]+$/.test(after)))
    throw new Error("单批数量须为整数；游标格式 createdAt:id，首批留空");
  const cursor = after.split(":").map(Number);
  return validateUsageRetentionBatch({ before: parseUsageRetentionUtcHour(before), limit: Number(limit), ...(after === "" ? {} : { after: { createdAt: cursor[0], id: cursor[1] } }) });
}

export function sameUsageRetentionBatch(a: UsageRetentionBatch | null, b: UsageRetentionBatch | null): boolean {
  return a !== null && b !== null && a.before === b.before && a.limit === b.limit && a.after?.createdAt === b.after?.createdAt && a.after?.id === b.after?.id;
}

export function canCleanupUsageRetention(input: {
  enabled: boolean; verified: boolean; confirmed: boolean; busy: boolean;
  batch: UsageRetentionBatch | null; preview: UsageRetentionBatch | null; unknownCleanup: UsageRetentionBatch | null;
}): boolean {
  return input.enabled && input.verified && input.confirmed && !input.busy && sameUsageRetentionBatch(input.batch, input.preview)
    && (input.unknownCleanup === null || sameUsageRetentionBatch(input.batch, input.unknownCleanup));
}

async function retentionResponse(request: Promise<UsageRetentionResponse>): Promise<UsageRetentionResponse> {
  const response = await request;
  if (!response || !response.item || typeof response.item !== "object" || Array.isArray(response.item))
    throw new Error("服务器响应缺少有效 item；结果未知，请刷新状态");
  return response;
}

export const usageRetentionApi = {
  status: () => retentionResponse(api.get<UsageRetentionResponse>("/api/usage-retention/status")),
  backfill: () => retentionResponse(api.post<UsageRetentionResponse>("/api/usage-retention/backfill", { limit: 500 })),
  verify: () => retentionResponse(api.post<UsageRetentionResponse>("/api/usage-retention/verify", {})),
  preview: (input: UsageRetentionBatch) => retentionResponse(api.post<UsageRetentionResponse>("/api/usage-retention/preview", validateUsageRetentionBatch(input))),
  cleanup: (input: UsageRetentionBatch, confirmed: boolean, operationId: string) => {
    if (!operationId || operationId.length > 200) throw new Error("缺少清理操作幂等标识");
    if (confirmed !== true) throw new Error("请先预览并显式确认清理本批明细");
    return retentionResponse(api.post<UsageRetentionResponse>("/api/usage-retention/cleanup", {
      enabled: true, ...validateUsageRetentionBatch(input), confirm: USAGE_RETENTION_CONFIRMATION, operation_id: operationId,
    })).then(response => {
      const r = response.item;
      const cursor = r.next as { createdAt?: number; id?: number } | null;
      if (r.enabled !== true || !Number.isSafeInteger(r.scanned) || !Number.isSafeInteger(r.deleted)
        || Number(r.scanned) < 0 || Number(r.scanned) > input.limit || Number(r.deleted) < 0 || Number(r.deleted) > Number(r.scanned)
        || (cursor !== null && (!cursor || !Number.isSafeInteger(cursor.createdAt) || !Number.isSafeInteger(cursor.id) || Number(cursor.createdAt) < 0 || Number(cursor.id) < 0)))
        throw new Error("清理响应无有效完成凭证；保留原操作标识，结果未知");
      return response;
    });
  },
};
