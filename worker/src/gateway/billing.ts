import type { Context } from "hono";
import type { AuthedDevice, Env } from "../types";
import { resolveDevice } from "./auth";
import { checkDeviceRateLimit, getWallet } from "../db/repo";
import { monthStartMs } from "../db/repo";
import { usageReportSource, validateUsageRange } from "../db/usage_rollups";


export const BILLING_RATE_LIMIT_RPM = 3;

function openaiError(type: string, message: string, status: number, retryAfter?: string): Response {
  return new Response(JSON.stringify({ error: { message, type, code: type } }), {
    status,
    headers: {
      "content-type": "application/json",
      ...(retryAfter ? { "Retry-After": retryAfter } : {}),
    },
  });
}

async function billingDevice(c: Context<{ Bindings: Env }>): Promise<AuthedDevice | Response> {
  const device = await resolveDevice(c);
  if (!device) {
    return openaiError("invalid_request_error", "Invalid API key", 401);
  }
  const allowed = await checkDeviceRateLimit(c.env, "billing::" + device.id, BILLING_RATE_LIMIT_RPM);
  if (!allowed) {
    return openaiError(
      "rate_limit_error",
      "Billing rate limit exceeded. Poll at most " + BILLING_RATE_LIMIT_RPM + " times per minute.",
      429,
      "20"
    );
  }
  return device;
}

export async function billingUserBalanceHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = await billingDevice(c);
  if (auth instanceof Response) return auth;
  const wallet = await getWallet(c.env, auth.id);
  const total = wallet.balance_usd.toFixed(2);
  return c.json({
    is_available: wallet.balance_usd - wallet.reserved_usd > 0,
    balance_infos: [
      {
        currency: "CNY",
        total_balance: total,
        granted_balance: "0.00",
        topped_up_balance: total,
      },
    ],
  });
}

export async function billingSubscriptionHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = await billingDevice(c);
  if (auth instanceof Response) return auth;
  const wallet = await getWallet(c.env, auth.id);
  const available = Number((wallet.balance_usd - wallet.reserved_usd).toFixed(4));
  return c.json({
    object: "billing_subscription",
    has_payment_method: true,
    hard_limit_usd: wallet.balance_usd,
    soft_limit_usd: available,
    system_hard_limit_usd: wallet.balance_usd,
    access_until: null,
  });
}

export async function billingUsageHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = await billingDevice(c);
  if (auth instanceof Response) return auth;

  const q = c.req.query();
  const nowMs = Date.now();
  const monthStart = monthStartMs();
  const parseDay = (v: string | undefined, fallback: number, endOfDay: boolean): number => {
    if (!v) return fallback;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
    if (!m) return fallback;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
    if (!Number.isFinite(ms)) return fallback;
    return endOfDay ? ms + 24 * 60 * 60 * 1000 - 1 : ms;
  };
  const from = parseDay(q.start_date, monthStart, false);
  const to = parseDay(q.end_date, nowMs, true);

  try { await validateUsageRange(c.env, from, to + 1); }
  catch (error) { if (error instanceof Error && error.message === "usage_history_granularity_required") return c.json({ error: error.message, granularity: "hour" }, 400); throw error; }
  const source = usageReportSource(from, to + 1);
  const res = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) as total_cost FROM " + source.sql + " WHERE device_id = ?"
  )
    .bind(...source.binds, auth.id)
    .first<{ total_cost: number }>();
  try { await validateUsageRange(c.env, from, to + 1); }
  catch (error) { if (error instanceof Error && error.message === "usage_history_granularity_required") return c.json({ error: error.message, granularity: "hour" }, 400); throw error; }
  const spent = Number(res?.total_cost || 0);
  return c.json({
    object: "list",
    total_usage: Number((spent * 100).toFixed(4)),
  });
}
