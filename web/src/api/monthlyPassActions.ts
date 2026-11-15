import { ApiError } from "./client";
import { monthlyPassesApi } from "./monthlyPasses";

export type MonthlyAction = { kind: "issue"; planId: string } | { kind: "renew"; subscriptionId: string };
export interface PendingMonthlyAction { operationId: string; action: MonthlyAction }
export type MonthlyActionResult = { status: "committed"; refreshError: string | null } | { status: "unknown" | "rejected"; message: string };
const key = (accountId: string) => "admin:monthly-pending:" + encodeURIComponent(accountId);
const active = new Set<string>();
const message = (err: unknown) => err instanceof Error ? err.message : "操作失败";
export function readPendingMonthlyAction(accountId: string): PendingMonthlyAction | null {
  const raw = sessionStorage.getItem(key(accountId));
  if (!raw) return null;
  const value = JSON.parse(raw) as PendingMonthlyAction;
  if (!value || typeof value.operationId !== "string" || !value.operationId || !value.action ||
      !(value.action.kind === "issue" && typeof value.action.planId === "string" && value.action.planId ||
        value.action.kind === "renew" && typeof value.action.subscriptionId === "string" && value.action.subscriptionId))
    throw new Error("待核实操作记录损坏，请勿重新开卡或续期；先核对管理审计");
  return value;
}
export async function runMonthlyAction(accountId: string, action: MonthlyAction, refresh: () => Promise<unknown>, replay?: PendingMonthlyAction): Promise<MonthlyActionResult> {
  if (active.has(accountId)) return { status: "rejected", message: "该账户操作正在提交，请稍候" };
  active.add(accountId);
  let pending: PendingMonthlyAction;
  try {
    const stored = readPendingMonthlyAction(accountId);
    if (replay && stored && replay.operationId !== stored.operationId) return { status: "rejected", message: "待核实操作已变化，请重新读取原操作" };
    pending = replay ?? stored ?? { operationId: crypto.randomUUID(), action };
    if (JSON.stringify(pending.action) !== JSON.stringify(action)) return { status: "rejected", message: "存在结果未确认的原操作，请先核实或重试原操作" };
    sessionStorage.setItem(key(accountId), JSON.stringify(pending));
    if (sessionStorage.getItem(key(accountId)) !== JSON.stringify(pending)) throw new Error("无法保存操作凭据，未提交请求");
    try {
      if (pending.action.kind === "issue") await monthlyPassesApi.issue(accountId, pending.action.planId, pending.operationId);
      else await monthlyPassesApi.renew(pending.action.subscriptionId, pending.operationId);
    } catch (err) {
      const definitive = new Set(["monthly_subscription_not_current", "monthly_pass_already_active", "monthly_scope_not_found", "monthly_plan_not_found", "monthly_account_not_found", "monthly_invalid_plan", "monthly_subscription_not_found"]);
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && definitive.has(err.message)) {
        if (readPendingMonthlyAction(accountId)?.operationId === pending.operationId) sessionStorage.removeItem(key(accountId));
        return { status: "rejected", message: message(err) };
      }
      return { status: "unknown", message: "提交结果尚未确认，请核实或使用原操作重试：" + message(err) };
    }
    let refreshError: string | null = null;
    try { if (readPendingMonthlyAction(accountId)?.operationId === pending.operationId) sessionStorage.removeItem(key(accountId)); } catch (err) { refreshError = "本地操作凭据清理失败：" + message(err); }
    try { await refresh(); } catch (err) { refreshError = "操作已成功，账户数据刷新失败；请仅重新读取：" + message(err); }
    return { status: "committed", refreshError };
  } catch (err) { return { status: "rejected", message: message(err) }; }
  finally { active.delete(accountId); }
}
