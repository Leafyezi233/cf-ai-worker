import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthedDevice, Env } from "../types";
import { ensureSchema } from "../db/schema";
import { usageReportSource, validateUsageRange } from "../db/usage_rollups";
import {
  getDeviceMonthlyCost,
  monthStartMs,
  getWallet,
  getSetting,
  listModelProjectionsForDevice,
  listPriceWindowsForModels,
  PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES,
} from "../db/repo";
import { resolveDevice } from "../gateway/auth";
import { peekViaDurableObject } from "../gateway/rate-limiter-do";
import { modelMarketplace, serializeConsoleModel } from "./model_marketplace";
import { attachModelCategories } from "../db/model_categories";
import { ANNOUNCEMENT_SETTING_KEY, normalizeAnnouncement } from "../utils/announcement";
import { accountApp, consoleRateLimit } from "./account";
import { monthlyConsoleApp } from "./monthly-passes";

export const consoleApp = new Hono<{ Bindings: Env }>();

consoleApp.route("/", accountApp);
consoleApp.route("/monthly-pass", monthlyConsoleApp);

const LOW_BALANCE_USD = 1;

const RANGE_PRESETS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

interface DeviceAuth {
  device: AuthedDevice;
}
interface DeviceAuthError {
  response: Response;
}

async function requireDevice(
  c: Context<{ Bindings: Env }>
): Promise<DeviceAuth | DeviceAuthError> {
  const device = await resolveDevice(c);
  if (!device) {
    return {
      response: c.json({ error: "unauthorized", message: "valid device token required" }, 401),
    };
  }
  if (device.auth_via === "sub") {
    return {
      response: c.json(
        {
          error: "sub_token_not_allowed",
          message: "A sub-token cannot open the console. Use the master token.",
        },
        403
      ),
    };
  }
  const limited = await consoleRateLimit(c.env, device);
  if (limited) return { response: limited };
  return { device };
}

interface Range {
  from: number;
  to?: number;
  label: string;
}

function resolveRange(c: Context<{ Bindings: Env }>): Range {
  const q = c.req.query();
  const now = Date.now();
  const to = q.to ? Number(q.to) : undefined;
  let from: number;
  let label: string;
  if (q.from) {
    from = Number(q.from);
    label = "custom";
  } else {
    const preset = RANGE_PRESETS[q.range || "30d"] ?? RANGE_PRESETS["30d"];
    from = now - preset;
    label = q.range || "30d";
  }
  return { from, to, label };
}

function safeInt(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

consoleApp.get("/me", async (c) => {
  const auth = await requireDevice(c);
  if ("response" in auth) return auth.response;
  const device = auth.device;
  const monthStart = monthStartMs();
  const monthlyCost = await getDeviceMonthlyCost(c.env, device.id, monthStart);
  const wallet = await getWallet(c.env, device.id);
  return c.json({
    device: {
      id: device.id,
      name: device.name,
      enabled: Boolean(device.enabled),
      rate_limit_rpm: device.rate_limit_rpm,
      cost_limit_monthly: device.cost_limit_monthly,
      current_month_cost: monthlyCost,
      balance_usd: wallet.balance_usd,
      reserved_usd: wallet.reserved_usd,
      available_usd: Number((wallet.balance_usd - wallet.reserved_usd).toFixed(4)),
      low_balance_warning: LOW_BALANCE_USD > 0 && wallet.balance_usd - wallet.reserved_usd <= LOW_BALANCE_USD,
      last_used_at: device.last_used_at ?? null,
      created_at: device.created_at,
      password_setup_required: !device.password_hash,
      calls_enabled: Number(device.calls_enabled ?? 1) !== 0,
    },
  });
});

consoleApp.get("/quota", async (c) => {
  const auth = await requireDevice(c);
  if ("response" in auth) return auth.response;
  const device = auth.device;
  let rpm: { remaining: number | null; used?: number; reset_ms: number; window_ms?: number } | null = null;
  try {
    rpm = await peekViaDurableObject(c.env, device.id, device.rate_limit_rpm);
  } catch {
    rpm = null;
  }
  const monthlyCost = await getDeviceMonthlyCost(c.env, device.id);
  const costLimit = device.cost_limit_monthly ?? 0;
  const wallet = await getWallet(c.env, device.id);
  const availableUsd = Number((wallet.balance_usd - wallet.reserved_usd).toFixed(4));
  return c.json({
    rpm: {
      limit: device.rate_limit_rpm,
      remaining: rpm?.remaining ?? null,
      used: rpm?.used ?? null,
      reset_ms: rpm?.reset_ms ?? null,
      window_ms: rpm?.window_ms ?? null,
    },
    monthly_cost_usd: monthlyCost,
    monthly_cost_limit_usd: costLimit,
    monthly_cost_exceeded: costLimit > 0 && monthlyCost >= costLimit,
    balance_usd: wallet.balance_usd,
    reserved_usd: wallet.reserved_usd,
    available_usd: availableUsd,
    low_balance_warning: LOW_BALANCE_USD > 0 && availableUsd <= LOW_BALANCE_USD,
  });
});

consoleApp.get("/usage", async (c) => {
  const auth = await requireDevice(c);
  if ("response" in auth) return auth.response;
  const device = auth.device;
  await ensureSchema(c.env);
  const range = resolveRange(c);
  const limit = safeInt(c.req.query("limit"), 50, 1, 200);
  const offset = safeInt(c.req.query("offset"), 0, 0, 100_000);

  const subTokenId = (c.req.query("sub_token_id") || "").trim();
  const subClause = subTokenId ? " AND sub_token_id = ?" : "";
  const rangeBindsWithSub = (tail: unknown[] = []) => {
    const head: unknown[] =
      range.to === undefined ? [device.id, range.from] : [device.id, range.from, range.to];
    return subTokenId ? [...head, subTokenId, ...tail] : [...head, ...tail];
  };

  const toExclusive = range.to === undefined ? undefined : range.to + 1;
  try { await validateUsageRange(c.env, range.from, toExclusive); }
  catch (error) { if (error instanceof Error && error.message === "usage_history_granularity_required") return c.json({ error: error.message, granularity: "hour" }, 400); throw error; }
  const source = usageReportSource(range.from, toExclusive);
  const reportBinds = subTokenId ? [...source.binds, device.id, subTokenId] : [...source.binds, device.id];
  const reportWhere = " WHERE device_id = ?" + subClause;
  const [summary, byModel, daily, rows] = await Promise.all([
    c.env.DB.prepare(
      "SELECT COALESCE(SUM(request_count),0) as request_count, " +
      "COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens, " +
      "COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(cost_usd),0) as cost_usd, " +
      "COALESCE(SUM(cache_hit_count),0) as cache_hit_count, COALESCE(SUM(pricing_missing_count),0) as pricing_missing_count, " +
      "COALESCE(SUM(search_calls),0) as search_calls, COALESCE(1.0*SUM(latency_sum)/NULLIF(SUM(latency_count),0),0) as avg_latency_ms, " +
      "COALESCE(SUM(error_count),0) as error_count FROM " + source.sql + reportWhere
    ).bind(...reportBinds).first(),
    c.env.DB.prepare(
      "SELECT COALESCE(model,'unknown') as model, SUM(request_count) as request_count, " +
      "COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(cost_usd),0) as cost_usd, " +
      "COALESCE(SUM(pricing_missing_count),0) as pricing_missing_count, COALESCE(SUM(search_calls),0) as search_calls FROM " + source.sql + reportWhere +
      " GROUP BY model ORDER BY cost_usd DESC"
    ).bind(...reportBinds).all(),
    c.env.DB.prepare(
      "SELECT strftime('%Y-%m-%d',created_at/1000,'unixepoch','+480 minutes') as date, " +
      "SUM(request_count) as request_count, COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(cost_usd),0) as cost_usd FROM " + source.sql + reportWhere +
      " GROUP BY date ORDER BY date ASC"
    ).bind(...reportBinds).all(),
    c.env.DB.prepare(
      "SELECT id, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit, pricing_missing, status_code, latency_ms, created_at, sub_token_id " +
      "FROM usage WHERE device_id = ? AND created_at >= ?" + (range.to === undefined ? "" : " AND created_at <= ?") + subClause +
      " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
    ).bind(...rangeBindsWithSub([limit, offset])).all(),
  ]);
  try { await validateUsageRange(c.env, range.from, toExclusive); }
  catch (error) { if (error instanceof Error && error.message === "usage_history_granularity_required") return c.json({ error: error.message, granularity: "hour" }, 400); throw error; }

  return c.json({
    range: { label: range.label, from: range.from, to: range.to ?? Date.now() },
    summary: summary ?? {},
    by_model: byModel.results ?? [],
    daily: daily.results ?? [],
    items: (rows.results ?? []).map((r: any) => ({
      ...r,
      cost_usd: Number(r.cost_usd || 0),
      pricing_missing: Boolean(r.pricing_missing),
    })),
    page: { limit, offset },
    sub_token_id: subTokenId || null,
  });
});



consoleApp.get("/models", async (c) => {
  const auth = await requireDevice(c);
  if ("response" in auth) return auth.response;
  const device = auth.device;
  const items = await listModelProjectionsForDevice(c.env, device);
  const bandsByModel = await listPriceWindowsForModels(
    c.env,
    items.filter((m) => Number(m.peak_pricing_enabled || 0) === 1).map((m) => m.id)
  );
  const nowMs = Date.now();
  const tzOffsetMinutes = PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES;
  const videoServices = new Map<string, { multiplier: number; scalarOverride: boolean }>();
  const selection = device.service_group_id ?? device.default_service_group_id;
  if (selection && selection !== "auto" && selection !== "legacy" && items.some(m => {
    try { return ["secure_skill","doubao"].includes(JSON.parse(m.config_json || "{}").video?.adapter); } catch { return false; }
  })) {
    const rates = await c.env.DB.prepare("SELECT m.model_key, m.pricing_json, g.multiplier FROM service_group_models m JOIN service_groups g ON g.id = m.service_group_id WHERE g.id = ?").bind(selection).all<{ model_key: string; pricing_json: string | null; multiplier: number }>();
    for (const row of rates.results || []) videoServices.set(row.model_key, { multiplier: row.multiplier, scalarOverride: row.pricing_json != null });
  }
  return c.json({
    model_scope: device.model_scope || "all",
    model_count: items.length,
    peak_pricing_tz_offset_minutes: tzOffsetMinutes,
    items: await attachModelCategories(c.env, items.map((m) => serializeConsoleModel(m, bandsByModel, nowMs, tzOffsetMinutes, videoServices.get(m.model_name)))),
  });
});


consoleApp.get("/model-marketplace", async (c) => {
  const auth = await requireDevice(c);
  if ("response" in auth) return auth.response;
  const directory = await modelMarketplace(c.env, auth.device);
  return c.json({ ...directory, items: await attachModelCategories(c.env, directory.items) });
});


consoleApp.get("/announcement", async (c) => {
  const auth = await requireDevice(c);
  if ("response" in auth) return auth.response;
  return c.json(normalizeAnnouncement(await getSetting(c.env, ANNOUNCEMENT_SETTING_KEY)));
});


consoleApp.post("/chat", async (c) => {
  const auth = await requireDevice(c);
  if ("response" in auth) return auth.response;

  const raw = (await c.req.json().catch(() => null)) as Record<string, any> | null;
  if (!raw || typeof raw.model !== "string" || !raw.model.trim()) {
    return c.json({ error: "model_required", message: "请选择一个模型" }, 400);
  }

  const endpoint = raw.endpoint === "/v1/messages" ? "messages" : "chat/completions";
  const { endpoint: _endpoint, ...body } = raw;

  const url = new URL(c.req.url);
  url.pathname = endpoint === "messages" ? "/messages" : "/chat/completions";
  url.search = "";

  const forwardHeaders = new Headers(c.req.raw.headers);
  forwardHeaders.set("Content-Type", "application/json");
  forwardHeaders.delete("Content-Length");

  const forwarded = new Request(url.toString(), {
    method: "POST",
    headers: forwardHeaders,
    body: JSON.stringify(body),
  });

  const { gatewayApp } = await import("../gateway");
  let executionCtx: Parameters<typeof gatewayApp.fetch>[2];
  try {
    executionCtx = c.executionCtx as unknown as Parameters<typeof gatewayApp.fetch>[2];
  } catch {
    executionCtx = undefined;
  }
  return gatewayApp.fetch(forwarded, c.env, executionCtx);
});

consoleApp.all("*", (c) => c.json({ error: "not_found" }, 404));
