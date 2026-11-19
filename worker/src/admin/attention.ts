import { Hono } from "hono";
import type { Env } from "../types";
import { getCurrentMonthSpend, getSetting, monthStartMs } from "../db/repo";
import { ensureSchema } from "../db/schema";

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
  await ensureSchema(env);
  const monthStart = monthStartMs(undefined, now);
  const cutoff = now - 30 * 60_000;
  // Aggregate month rollups + unreceipted raw usage once, not once per account.
  // Match repo.usageCostExpression: receipts prevent double-counting rolled-up usage.
  const [accounts, unpriced, review, expiring, budget] = await Promise.all([
    env.DB.prepare(
      "WITH costs AS (SELECT device_id, SUM(cost_usd) AS cost FROM (" +
      "SELECT device_id, cost_usd FROM usage_monthly_rollups WHERE month_start >= ? UNION ALL " +
      "SELECT u.device_id, u.cost_usd FROM usage u WHERE u.created_at >= ? " +
      "AND NOT EXISTS (SELECT 1 FROM usage_rollup_receipts r WHERE r.id=u.id)" +
      ") GROUP BY device_id) SELECT " +
      "COALESCE(SUM(CASE WHEN COALESCE(d.cost_limit_monthly,0)>0 AND COALESCE(c.cost,0)>=d.cost_limit_monthly THEN 1 ELSE 0 END),0) AS over_limit," +
      "COALESCE(SUM(CASE WHEN COALESCE(w.balance_usd,0)-COALESCE(w.reserved_usd,0)<=0 THEN 1 ELSE 0 END),0) AS no_balance," +
      "COALESCE(SUM(CASE WHEN d.calls_enabled=0 THEN 1 ELSE 0 END),0) AS calls_off " +
      "FROM devices d LEFT JOIN device_wallets w ON w.device_id=d.id LEFT JOIN costs c ON c.device_id=d.id " +
      "WHERE d.revoked_at IS NULL AND d.enabled<>0"
    ).bind(monthStart, monthStart).first<{ over_limit: number; no_balance: number; calls_off: number }>(),
    // Keep the resolver's explicit declaration and legacy input/output fallback semantics.
    env.DB.prepare(
      "SELECT kind, COUNT(*) AS n FROM (SELECT 'model' AS kind, pricing_mode, input_price_per_m, output_price_per_m FROM models WHERE enabled=1 " +
      "UNION ALL SELECT 'group', pricing_mode, input_price_per_m, output_price_per_m FROM model_groups WHERE enabled=1) " +
      "WHERE CASE WHEN pricing_mode IN ('free','priced','unset') THEN pricing_mode " +
      "WHEN COALESCE(input_price_per_m,0)>0 OR COALESCE(output_price_per_m,0)>0 THEN 'priced' ELSE 'unset' END='unset' GROUP BY kind"
    ).all<{ kind: string; n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM video_tasks WHERE status IN ('submission_unknown', 'pending') AND created_at < ?")
      .bind(cutoff).first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM monthly_pass_accounts a JOIN monthly_pass_subscriptions s ON s.id = a.subscription_id " +
      "WHERE s.enabled = 1 AND s.expires_at > ? AND s.expires_at <= ?").bind(now, now + 7 * DAY_MS).first<{ n: number }>(),
    getSetting<{ monthly_budget_usd?: number; budget_action?: string; alert_threshold_pct?: number }>(env, "budget_config"),
  ]);
  const items: AttentionItem[] = [];
  const overLimit = Number(accounts?.over_limit) || 0;
  const noBalance = Number(accounts?.no_balance) || 0;
  const callsOff = Number(accounts?.calls_off) || 0;
  const unpricedModels = Number(unpriced.results?.find(row => row.kind === "model")?.n) || 0;
  const unpricedGroups = Number(unpriced.results?.find(row => row.kind === "group")?.n) || 0;

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
  if (reviewCount) items.push({ key: "video_review", level: "warn", count: reviewCount, text: reviewCount + " 个视频任务超过 30 分钟还没有结果，需要核对", link: "/video-tasks?list_task_attention_before=" + cutoff });
  const expiringCount = Number(expiring?.n) || 0;
  if (expiringCount) items.push({ key: "passes_expiring", level: "warn", count: expiringCount, text: expiringCount + " 张月卡 7 天内到期", link: "/monthly-passes?list_expiry=7d" });
  return items;
}

export const attentionApp = new Hono<{ Bindings: Env }>();
attentionApp.get("/", async c => {
  c.header("Cache-Control", "no-store");
  return c.json({ items: await attentionItems(c.env), checked_at: Date.now() });
});
