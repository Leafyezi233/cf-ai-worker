import { Hono } from "hono";
import type { Env, ModelWithProvider } from "../types";
import { getCurrentMonthSpend, getSetting, listDevices } from "../db/repo";
import { resolveRowPricingMode } from "../gateway/pricing";

/**
 * "Needs attention" items for the admin dashboard: things an operator has to act on.
 * Each item carries a count and the admin page (with list filters) where it can be fixed.
 */
export interface AttentionItem {
  key: string;
  level: "block" | "warn";
  count: number;
  text: string;
  link: string;
}

const DAY_MS = 86_400_000;

export async function attentionItems(env: Env, now = Date.now()): Promise<AttentionItem[]> {
  const [devices, models, groups, review, expiring, budget] = await Promise.all([
    listDevices(env),
    env.DB.prepare("SELECT id, pricing_mode, input_price_per_m, output_price_per_m FROM models WHERE enabled = 1").all<ModelWithProvider>(),
    env.DB.prepare("SELECT id, pricing_mode, input_price_per_m, output_price_per_m FROM model_groups WHERE enabled = 1").all<ModelWithProvider>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM video_tasks WHERE status IN ('submission_unknown', 'pending') AND created_at < ?")
      .bind(now - 30 * 60_000).first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM monthly_pass_accounts a JOIN monthly_pass_subscriptions s ON s.id = a.subscription_id " +
      "WHERE s.enabled = 1 AND s.expires_at > ? AND s.expires_at <= ?").bind(now, now + 7 * DAY_MS).first<{ n: number }>(),
    getSetting<{ monthly_budget_usd?: number; budget_action?: string; alert_threshold_pct?: number }>(env, "budget_config"),
  ]);
  const items: AttentionItem[] = [];
  const live = devices.filter(d => !d.revoked_at && d.enabled);
  const overLimit = live.filter(d => (Number(d.cost_limit_monthly) || 0) > 0
    && (Number((d as { current_month_cost?: number }).current_month_cost) || 0) >= Number(d.cost_limit_monthly)).length;
  const noBalance = live.filter(d => {
    const w = d as { balance_usd?: number; reserved_usd?: number };
    return (Number(w.balance_usd) || 0) - (Number(w.reserved_usd) || 0) <= 0;
  }).length;
  const callsOff = live.filter(d => d.calls_enabled === 0).length;
  const unpricedModels = (models.results ?? []).filter(m => resolveRowPricingMode(m) === "unset").length;
  const unpricedGroups = (groups.results ?? []).filter(m => resolveRowPricingMode(m) === "unset").length;

  if (budget && Number(budget.monthly_budget_usd) > 0) {
    const spent = await getCurrentMonthSpend(env);
    const limit = Number(budget.monthly_budget_usd);
    const threshold = (Number(budget.alert_threshold_pct) || 80) / 100;
    if (spent >= limit) {
      items.push({ key: "site_budget", level: budget.budget_action === "block" ? "block" : "warn", count: 1,
        text: budget.budget_action === "block" ? "全站本月预算已用完，所有请求正在被拦截" : "全站本月预算已用完",
        link: "/settings" });
    } else if (spent >= limit * threshold) {
      items.push({ key: "site_budget", level: "warn", count: 1, text: "全站本月花费已超过预算的 " + Math.round(threshold * 100) + "%", link: "/settings" });
    }
  }
  if (overLimit) items.push({ key: "accounts_over_limit", level: "block", count: overLimit, text: overLimit + " 个账户本月额度已用完，调用会被拒绝", link: "/devices?list_state=blocked" });
  if (noBalance) items.push({ key: "accounts_no_balance", level: "warn", count: noBalance, text: noBalance + " 个账户余额为 0，需要充值", link: "/devices?list_state=nobalance" });
  if (callsOff) items.push({ key: "accounts_calls_off", level: "warn", count: callsOff, text: callsOff + " 个账户的主 Token 被禁止调用", link: "/devices?list_calls=0" });
  if (unpricedModels) items.push({ key: "models_unpriced", level: "block", count: unpricedModels, text: unpricedModels + " 个已启用的模型没有定价，调用会失败", link: "/models?list_enabled=1&list_pricing=unset" });
  if (unpricedGroups) items.push({ key: "groups_unpriced", level: "block", count: unpricedGroups, text: unpricedGroups + " 个已启用的模型池没有定价，调用会失败", link: "/model-groups?list_pricing=unset" });
  const reviewCount = Number(review?.n) || 0;
  if (reviewCount) items.push({ key: "video_review", level: "warn", count: reviewCount, text: reviewCount + " 个视频任务超过 30 分钟还没有结果，需要核对", link: "/video-tasks" });
  const expiringCount = Number(expiring?.n) || 0;
  if (expiringCount) items.push({ key: "passes_expiring", level: "warn", count: expiringCount, text: expiringCount + " 张月卡 7 天内到期", link: "/monthly-passes?list_expiry=7d" });
  return items;
}

export const attentionApp = new Hono<{ Bindings: Env }>();
attentionApp.get("/", async c => {
  c.header("Cache-Control", "no-store");
  return c.json({ items: await attentionItems(c.env), checked_at: Date.now() });
});
