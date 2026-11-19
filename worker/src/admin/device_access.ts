import type { DeviceRow, Env } from "../types";
import { getCurrentMonthSpend, getDeviceById, getDeviceMonthlyCost, getSetting, getWallet } from "../db/repo";
import { getMonthlyPassAccount } from "../db/monthly_passes";
import { previewTokenRouting } from "../console/routing_preview";

/** One problem that stops (or limits) every call from an account, independent of the model. */
export interface AccountIssue {
  key: string;
  level: "block" | "warn";
  text: string;
  fix: string;
}

export interface AccountModelAccess {
  name: string;
  display_name: string | null;
  available: boolean;
  /** Plain-language reason when unavailable. */
  reason: string | null;
  service_group: string | null;
  price: null | {
    pricing_mode: "free" | "priced";
    billing_unit: "token" | "call";
    input_price_per_m: number;
    output_price_per_m: number;
    price_per_call: number;
    multiplier: number;
  };
}

export interface AccountAccessReport {
  device_id: string;
  issues: AccountIssue[];
  monthly_pass: null | { plan_name: string; enabled: boolean; expires_at: number; active: boolean };
  wallet: { balance_usd: number; reserved_usd: number; available_usd: number };
  month_cost_usd: number;
  cost_limit_monthly: number;
  models: AccountModelAccess[];
  truncated: boolean;
  checked_at: number;
}

const MAX_NAMES = 300;
const REASONS: Record<string, string> = {
  model_not_in_scope: "没有权限：不在账户的模型范围或服务分组授权里",
  model_not_found: "当前路由里没有这个模型",
  routing_conflict: "分组配置冲突（计费方式不一致）",
  routing_unavailable: "未定价或配置不可用",
  invalid_model: "名称无效",
};

async function catalogNames(env: Env): Promise<{ names: { name: string; display_name: string | null }[]; truncated: boolean }> {
  const rows = await env.DB.prepare(
    "SELECT name, MAX(display_name) AS display_name FROM (" +
      "SELECT model_name AS name, display_name FROM models WHERE enabled = 1 " +
      "UNION ALL SELECT name, display_name FROM model_groups WHERE enabled = 1 " +
      "UNION ALL SELECT m.model_key AS name, NULL AS display_name FROM service_group_models m " +
      "JOIN service_groups g ON g.id = m.service_group_id WHERE g.enabled = 1" +
    ") GROUP BY name ORDER BY name LIMIT ?"
  ).bind(MAX_NAMES + 1).all<{ name: string; display_name: string | null }>();
  const list = rows.results ?? [];
  return { names: list.slice(0, MAX_NAMES), truncated: list.length > MAX_NAMES };
}

export async function accountIssues(env: Env, device: DeviceRow, wallet: { available: number }, monthCost: number,
  passActive: boolean): Promise<AccountIssue[]> {
  const issues: AccountIssue[] = [];
  if (device.revoked_at) issues.push({ key: "revoked", level: "block", text: "账户已撤销", fix: "撤销不可恢复，请重新开一个账户。" });
  if (!device.enabled) issues.push({ key: "paused", level: "block", text: "账户已暂停", fix: "在操作里点「恢复」。" });
  if (device.calls_enabled === 0) issues.push({ key: "calls_disabled", level: "block", text: "主 Token 已禁止调用", fix: "在操作里点「恢复调用」。子 Token 不受影响。" });
  const limit = Number(device.cost_limit_monthly) || 0;
  if (limit > 0 && monthCost >= limit) {
    issues.push({ key: "month_limit", level: "block", text: "本月花费已到账户上限", fix: "在「编辑」里调高月度限额，或等下个月。" });
  }
  if (wallet.available <= 0) {
    issues.push(passActive
      ? { key: "no_balance", level: "warn", text: "钱包余额为 0", fix: "月卡覆盖的文本请求还能用，其他请求需要先充值。" }
      : { key: "no_balance", level: "block", text: "钱包余额不足", fix: "点「充值」。免费模型不受影响。" });
  }
  const budget = await getSetting<{ monthly_budget_usd?: number; budget_action?: string }>(env, "budget_config");
  if (budget?.budget_action === "block" && Number(budget.monthly_budget_usd) > 0
      && await getCurrentMonthSpend(env) >= Number(budget.monthly_budget_usd)) {
    issues.push({ key: "site_budget", level: "block", text: "全站本月预算已用完，所有请求都会被拦截", fix: "在「系统设置 → 预算与告警」里调高预算。" });
  }
  return issues;
}

export async function deviceAccessReport(env: Env, id: string): Promise<AccountAccessReport | null> {
  const device = await getDeviceById(env, id);
  if (!device) return null;
  const now = Date.now();
  const [walletRow, monthCost, monthly, catalog] = await Promise.all([
    getWallet(env, id), getDeviceMonthlyCost(env, id), getMonthlyPassAccount(env, id), catalogNames(env),
  ]);
  const balance = Number(walletRow?.balance_usd) || 0, reserved = Number(walletRow?.reserved_usd) || 0;
  const sub = monthly.subscription;
  const passActive = Boolean(sub && sub.enabled && sub.starts_at <= now && sub.expires_at > now);
  const issues = await accountIssues(env, device, { available: balance - reserved }, monthCost, passActive);

  const models: AccountModelAccess[] = [];
  const queue = [...catalog.names];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const preview = await previewTokenRouting(env, device, "master", item.name);
      const route = preview.routes[0];
      models.push({
        name: item.name,
        display_name: item.display_name,
        available: preview.available,
        reason: preview.available ? null : REASONS[preview.error || ""] || "不可用",
        service_group: route?.service_group?.name ?? null,
        price: route ? {
          pricing_mode: route.price.pricing_mode, billing_unit: route.price.billing_unit,
          input_price_per_m: route.price.input_price_per_m, output_price_per_m: route.price.output_price_per_m,
          price_per_call: route.price.price_per_call, multiplier: route.price.multiplier,
        } : null,
      });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  models.sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));

  return {
    device_id: id, issues,
    monthly_pass: sub ? { plan_name: sub.plan_name, enabled: Boolean(sub.enabled), expires_at: sub.expires_at, active: passActive } : null,
    wallet: { balance_usd: balance, reserved_usd: reserved, available_usd: balance - reserved },
    month_cost_usd: monthCost, cost_limit_monthly: Number(device.cost_limit_monthly) || 0,
    models, truncated: catalog.truncated, checked_at: now,
  };
}
