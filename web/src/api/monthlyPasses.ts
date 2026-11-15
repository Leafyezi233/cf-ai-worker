import { api } from "./client";
import { consoleApi } from "./consoleClient";

export interface MonthlyLimits {
  daily_usd: number | null;
  weekly_usd: number | null;
  five_hour_usd: number | null;
  total_usd: number | null;
}
export interface MonthlyPlanInput {
  name: string;
  enabled: 0 | 1;
  limits: MonthlyLimits;
  service_group_ids: string[] | null;
}
export interface MonthlyPlan extends MonthlyPlanInput { id: string }
export type MonthlyWindowKind = keyof MonthlyLimits;
export interface MonthlyWindow {
  kind: MonthlyWindowKind;
  limit_usd: number;
  used_usd: number;
  reserved_usd: number;
  remaining_usd: number;
  starts_at: number;
  ends_at: number;
}
export interface MonthlySubscription {
  id: string;
  device_id: string;
  plan_id: string;
  plan_name: string;
  enabled: 0 | 1;
  starts_at: number;
  expires_at: number;
  limits: MonthlyLimits;
  service_group_ids: string[] | null;
  windows: MonthlyWindow[];
}
export type MonthlySubscriptionRecord = Omit<MonthlySubscription, "windows">;
export interface MonthlyAccount {
  device_id: string;
  wallet_fallback: boolean;
  subscription: MonthlySubscription | null;
}
export const monthlyLimitFields = [
  ["daily_usd", "每日"], ["weekly_usd", "每周"], ["five_hour_usd", "5 小时"], ["total_usd", "总额"],
] as const;
export const monthlyWindowLabels: Record<MonthlyWindowKind, string> = {
  daily_usd: "每日", weekly_usd: "每周", five_hour_usd: "5 小时", total_usd: "总额",
};

export function validateMonthlyPlanInput(input: MonthlyPlanInput): MonthlyPlanInput {
  if (typeof input.name !== "string" || input.name.trim().length < 1 || input.name.length > 100)
    throw new Error("套餐名称须为 1–100 个字符");
  if (input.enabled !== 0 && input.enabled !== 1) throw new Error("套餐启用状态无效");
  let positive = false;
  for (const [key] of monthlyLimitFields) {
    const value = input.limits?.[key];
    if (value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1e9)
      throw new Error("金额须为大于 0 且不超过 1e9 的有限数值；留空表示不限额");
    positive = true;
  }
  if (!positive) throw new Error("至少设置一项正限额");
  if (input.service_group_ids !== null && (!Array.isArray(input.service_group_ids) || input.service_group_ids.length > 100 || input.service_group_ids.some(id => typeof id !== "string" || !id.trim())))
    throw new Error("服务分组 ID 最多 100 个，且须为非空字符串");
  return input;
}
export function monthlyLimitFromText(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 1e9)
    throw new Error("金额须为大于 0 且不超过 1e9 的有限数值");
  return value;
}
export function monthlyPassStatus(subscription: MonthlySubscription | null, now = Date.now()): string {
  if (!subscription) return "未开通";
  if (!subscription.enabled) return "已停用";
  if (subscription.expires_at <= now) return "已过期";
  if (subscription.starts_at > now) return "未生效";
  if (subscription.windows.some(window => window.remaining_usd <= 0)) return "额度不足";
  return "有效";
}
export function monthlyPassTime(value: number): string {
  return Number.isFinite(value) ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) + "（北京时间）" : "—";
}
export function monthlyPassMoney(value: number | null): string {
  return value === null ? "不限额" : "¥" + value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}
export const WALLET_FALLBACK_CONFIRMATION = "开启后，无可用月卡时整笔请求将从钱包扣费，不会拆分支付。确认允许使用钱包余额？";
export function requireWalletFallbackConfirmation(enabled: boolean, confirmed: boolean): void {
  if (enabled && !confirmed) throw new Error("请先显式确认开启钱包兜底");
}
const base = "/api/monthly-passes";
const segment = encodeURIComponent;
export const monthlyPassesApi = {
  plans: () => api.get<{ items: MonthlyPlan[] }>(base + "/plans"),
  createPlan: (input: MonthlyPlanInput) => api.post<{ item: MonthlyPlan }>(base + "/plans", validateMonthlyPlanInput(input)),
  updatePlan: (id: string, input: MonthlyPlanInput) => api.put<{ item: MonthlyPlan }>(base + "/plans/" + segment(id), validateMonthlyPlanInput(input)),
  accounts: () => api.get<{ items: MonthlyAccount[] }>(base + "/accounts"),
  account: (deviceId: string) => api.get<{ item: MonthlyAccount }>(base + "/accounts/" + segment(deviceId)),
  issue: (deviceId: string, planId: string, operationId: string) => api.post<{ item: MonthlySubscriptionRecord }>(base + "/accounts/" + segment(deviceId) + "/issue", { plan_id: planId, operation_id: operationId }),
  stop: (id: string) => api.post<{ item: MonthlySubscriptionRecord }>(base + "/subscriptions/" + segment(id) + "/stop", {}),
  renew: (id: string, operationId: string) => api.post<{ item: MonthlySubscriptionRecord }>(base + "/subscriptions/" + segment(id) + "/renew", { operation_id: operationId }),
  walletFallback: (deviceId: string, enabled: boolean, confirmed = false) => {
    requireWalletFallbackConfirmation(enabled, confirmed);
    return api.put<{ item: MonthlyAccount }>(base + "/accounts/" + segment(deviceId) + "/wallet-fallback", { enabled });
  },
};
export const consoleMonthlyPassApi = {
  account: () => consoleApi.get<{ item: MonthlyAccount }>("/console/monthly-pass"),
  walletFallback: (enabled: boolean, confirmed = false) => {
    requireWalletFallbackConfirmation(enabled, confirmed);
    return consoleApi.put<{ item: MonthlyAccount }>("/console/monthly-pass/wallet-fallback", { enabled });
  },
};
