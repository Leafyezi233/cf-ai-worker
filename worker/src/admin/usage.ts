import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env, MonthlyReport, UsageRow } from "../types";
import {
  listUsage,
  statsSummary,
  statsByProvider,
  statsByModel,
  statsTrend,
  aggregateDailyStats,
  getLatestUsage,
  statsCacheAnalytics,
  statsModelLatency,
  generateMonthlyReport,
  statsCostAnalytics,
} from "../db/repo";
import { sendWebhookNotification } from "../utils/webhook";
import { sanitizeCsvCell } from "../utils/csv";

export const usageApp = new Hono<{ Bindings: Env }>();
usageApp.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  if (error.message === "usage_history_granularity_required") return c.json({ error: error.message, granularity: "hour" }, 400);
  throw error;
});

const DAY_MS = 24 * 60 * 60 * 1000;

export function getTzOffsetMinutes(c: { req: { header: (k: string) => string | undefined; query: (k: string) => string | undefined } }): number {
  const header = c.req.header("x-timezone-offset");
  if (header !== undefined && header !== "") {
    const n = parseInt(header, 10);
    if (!isNaN(n) && n >= -840 && n <= 840) return n;
  }
  const q = c.req.query("tzOffset");
  if (q !== undefined && q !== "") {
    const n = parseInt(q, 10);
    if (!isNaN(n) && n >= -840 && n <= 840) return n;
  }
  return -480;
}

export function startOfToday(offsetDays = 0, tzOffsetMinutes = -480): number {
  const now = Date.now();
  const localTime = now - tzOffsetMinutes * 60 * 1000;
  const localMidnight = Math.floor(localTime / DAY_MS) * DAY_MS;
  const utcMidnight = localMidnight + tzOffsetMinutes * 60 * 1000;
  return utcMidnight - offsetDays * DAY_MS;
}

export function formatSqlTimezoneModifier(tzOffsetMinutes: number): string {
  const shiftMinutes = -tzOffsetMinutes;
  const sign = shiftMinutes >= 0 ? "+" : "-";
  return `${sign}${Math.abs(shiftMinutes)} minutes`;
}

export function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = sanitizeCsvCell(val);
  if (str === "") return "";
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatUsageCsv(items: UsageRow[]): string {
  const headers = [
    "ID",
    "Time (UTC)",
    "Provider",
    "Model",
    "Device ID",
    "Input Tokens",
    "Output Tokens",
    "Total Tokens",
    "Web Searches",
    "Cost (CNY)",
    "Latency (ms)",
    "Status Code",
    "Cache Hit",
    "Request ID",
  ];

  const lines = [headers.join(",")];
  for (const item of items) {
    const timeIso = item.created_at ? new Date(item.created_at).toISOString() : "";
    const row = [
      item.id,
      escapeCsvField(timeIso),
      escapeCsvField(item.provider_name || item.provider_id || ""),
      escapeCsvField(item.model || ""),
      escapeCsvField(item.device_id || ""),
      item.input_tokens ?? 0,
      item.output_tokens ?? 0,
      item.total_tokens ?? 0,
      item.search_calls ?? 0,
      (item.cost_usd || 0).toFixed(6),
      item.latency_ms ?? "",
      item.status_code ?? "",
      item.cache_hit ? "YES" : "NO",
      escapeCsvField(item.request_id || ""),
    ];
    lines.push(row.join(","));
  }

  return "\uFEFF" + lines.join("\r\n");
}

export function formatMonthlyReportCsv(report: MonthlyReport): string {
  const lines: string[] = [];
  lines.push(`CPG AI 网关月度账单报表 - ${report.month}`);
  lines.push("");
  lines.push("=== 核心概览 ===");
  lines.push(`统计月份,${report.month}`);
  lines.push(`总消耗金额 (CNY),¥${report.total_cost_usd.toFixed(4)}`);
  lines.push(`总请求次数,${report.total_requests}`);
  lines.push(`输入 Token,${report.total_input_tokens}`);
  lines.push(`输出 Token,${report.total_output_tokens}`);
  lines.push(`总 Token,${report.total_tokens}`);
  lines.push(`缓存命中次数,${report.cache_hit_count}`);
  lines.push(`缓存节省金额 (CNY),¥${report.cache_saved_cost_usd.toFixed(4)}`);
  lines.push(`环比上月费用涨跌,${report.mom_growth.cost_growth_percent}%`);
  lines.push(`环比上月请求涨跌,${report.mom_growth.request_growth_percent}%`);
  lines.push("");

  lines.push("=== 模型消费构成 ===");
  lines.push("模型名称,请求次数,输入 Token,输出 Token,总 Token,消费金额 (CNY),占比 (%)");
  for (const m of report.by_model) {
    lines.push(
      [
        escapeCsvField(m.name),
        m.request_count,
        m.input_tokens,
        m.output_tokens,
        m.total_tokens,
        m.cost_usd.toFixed(4),
        `${m.share_percent}%`,
      ].join(",")
    );
  }
  lines.push("");

  lines.push("=== 服务商消费构成 ===");
  lines.push("服务商,请求次数,输入 Token,输出 Token,总 Token,消费金额 (CNY),占比 (%)");
  for (const p of report.by_provider) {
    lines.push(
      [
        escapeCsvField(p.name),
        p.request_count,
        p.input_tokens,
        p.output_tokens,
        p.total_tokens,
        p.cost_usd.toFixed(4),
        `${p.share_percent}%`,
      ].join(",")
    );
  }
  lines.push("");

  lines.push("=== 设备/客户端消费构成 ===");
  lines.push("设备名称,请求次数,输入 Token,输出 Token,总 Token,消费金额 (CNY),占比 (%)");
  for (const d of report.by_device) {
    lines.push(
      [
        escapeCsvField(d.name),
        d.request_count,
        d.input_tokens,
        d.output_tokens,
        d.total_tokens,
        d.cost_usd.toFixed(4),
        `${d.share_percent}%`,
      ].join(",")
    );
  }
  lines.push("");

  lines.push("=== 每日消费走势 ===");
  lines.push("日期,请求次数,总 Token,消费金额 (CNY)");
  for (const t of report.daily_trend) {
    lines.push([t.date, t.request_count, t.total_tokens, t.cost_usd.toFixed(4)].join(","));
  }

  return "\uFEFF" + lines.join("\r\n");
}

usageApp.get("/latest", async (c) => {
  const afterId = c.req.query("after_id") ? parseInt(c.req.query("after_id")!, 10) : undefined;
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 20;
  const items = await getLatestUsage(c.env, afterId, limit);
  return c.json({ items, count: items.length });
});

usageApp.get("/cache-stats", async (c) => {
  const range = c.req.query("range") || "today";
  const tzOffset = getTzOffsetMinutes(c);
  let since: number;
  if (range === "7d") since = startOfToday(6, tzOffset);
  else if (range === "30d") since = startOfToday(29, tzOffset);
  else since = startOfToday(0, tzOffset);

  const analytics = await statsCacheAnalytics(c.env, since);
  return c.json(analytics);
});

usageApp.get("/model-latency", async (c) => {
  const range = c.req.query("range") || "today";
  const tzOffset = getTzOffsetMinutes(c);
  let since: number;
  if (range === "7d") since = startOfToday(6, tzOffset);
  else if (range === "30d") since = startOfToday(29, tzOffset);
  else since = startOfToday(0, tzOffset);

  const benchmark = await statsModelLatency(c.env, since);
  return c.json({ items: benchmark });
});

usageApp.get("/monthly-report", async (c) => {
  const month = c.req.query("month");
  const tzOffset = getTzOffsetMinutes(c);
  const tzModifier = formatSqlTimezoneModifier(tzOffset);
  const report = await generateMonthlyReport(c.env, month, tzModifier);
  return c.json(report);
});

usageApp.get("/monthly-report/export", async (c) => {
  const month = c.req.query("month");
  const tzOffset = getTzOffsetMinutes(c);
  const tzModifier = formatSqlTimezoneModifier(tzOffset);
  const report = await generateMonthlyReport(c.env, month, tzModifier);
  const csv = formatMonthlyReportCsv(report);
  const filename = `monthly-bill-${report.month}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-cache",
    },
  });
});

usageApp.post("/monthly-report/push-webhook", async (c) => {
  const month = c.req.query("month");
  const tzOffset = getTzOffsetMinutes(c);
  const tzModifier = formatSqlTimezoneModifier(tzOffset);
  const report = await generateMonthlyReport(c.env, month, tzModifier);

  const topModels = report.by_model.slice(0, 3).map((m) => `• **${m.name}**: ¥${m.cost_usd.toFixed(2)} (${m.share_percent}%)`).join("\n");
  const topProviders = report.by_provider.slice(0, 3).map((p) => `• **${p.name}**: ¥${p.cost_usd.toFixed(2)} (${p.share_percent}%)`).join("\n");

  const msg = [
    `### 📊【AI Gateway】${report.month} 月度用量账单汇总`,
    `> **当月总消耗**: **¥${report.total_cost_usd.toFixed(2)}** (环比上月: ${report.mom_growth.cost_growth_percent >= 0 ? "+" : ""}${report.mom_growth.cost_growth_percent}%)`,
    `> **总请求数**: **${report.total_requests.toLocaleString()}** 次 | **总 Token**: **${report.total_tokens.toLocaleString()}**`,
    report.cache_saved_cost_usd > 0 ? `> **KV 缓存节省**: 命中 **${report.cache_hit_count}** 次，节省 **¥${report.cache_saved_cost_usd.toFixed(2)}**` : "",
    "",
    "**🏆 模型消费 Top 3**:",
    topModels || "• 无消耗记录",
    "",
    "**🏢 服务商消费 Top 3**:",
    topProviders || "• 无消耗记录",
  ].filter(Boolean).join("\n");

  const result = await sendWebhookNotification(c.env, {
    event: "monthly_report",
    title: `📊【AI Gateway】${report.month} 月度账单摘要`,
    message: msg,
    details: {
      month: report.month,
      total_cost_usd: report.total_cost_usd,
      total_requests: report.total_requests,
      total_tokens: report.total_tokens,
      mom_growth_cost_pct: report.mom_growth.cost_growth_percent,
    },
  });

  return c.json({ ok: result.ok, message: result.ok ? "月度账单已成功推送到 Webhook" : (result.error || "Webhook 推送失败或未配置"), details: result });
});

usageApp.get("/cost-analytics", async (c) => {
  const requested = c.req.query("range") || "30d";
  const range = requested === "7d" || requested === "90d" ? requested : "30d";
  const tzOffset = getTzOffsetMinutes(c);
  let since: number;
  if (range === "7d") since = startOfToday(6, tzOffset);
  else if (range === "90d") since = startOfToday(89, tzOffset);
  else since = startOfToday(29, tzOffset);

  const tzModifier = formatSqlTimezoneModifier(tzOffset);
  const analytics = await statsCostAnalytics(c.env, since, tzModifier, range);
  return c.json(analytics);
});

const MAX_USAGE_WINDOW_MS = 31 * DAY_MS;
function usageBadQuery(message: string): never { throw new HTTPException(400, { message }); }
function usageInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) usageBadQuery("invalid_usage_number");
  return Number(value);
}
export function parseUsageQuery(q: Record<string, string>, exporting = false) {
  let cursor: { from: number; to: number; created_at: number; id: number; scope: string } | undefined;
  if (q.cursor) {
    try {
      if (q.cursor.length > 4096) throw new Error();
      cursor = JSON.parse(q.cursor);
      if (!cursor || ![cursor.from, cursor.to, cursor.created_at, cursor.id].every(n => Number.isSafeInteger(n) && n >= 0) || cursor.id < 1 || typeof cursor.scope !== "string") throw new Error();
    } catch { usageBadQuery("invalid_usage_cursor"); }
  }
  const to = usageInteger(q.to, cursor?.to ?? Date.now());
  const from = usageInteger(q.from, cursor?.from ?? Math.max(0, to - DAY_MS));
  if (from > to || to - from > MAX_USAGE_WINDOW_MS) usageBadQuery("usage_window_must_be_at_most_31_days");
  const filters: { provider_id?: string; model?: string; device_id?: string; service_group_id?: string; request_id?: string; status?: "success" | "error" | number } = {};
  for (const key of ["provider_id", "model", "device_id", "service_group_id", "request_id"] as const) {
    const value = q[key]?.trim();
    if (value && value.length > 256) usageBadQuery("usage_filter_too_long");
    if (value) filters[key] = value;
  }
  if (q.status) {
    if (q.status === "success" || q.status === "error") filters.status = q.status;
    else if (/^[1-5]\d{2}$/.test(q.status)) filters.status = Number(q.status);
    else usageBadQuery("invalid_usage_status");
  }
  const scope = JSON.stringify(filters);
  if (cursor && (cursor.from !== from || cursor.to !== to || cursor.scope !== scope || cursor.created_at < from || cursor.created_at > to)) usageBadQuery("usage_cursor_scope_mismatch");
  const limit = Math.max(1, Math.min(usageInteger(q.limit, exporting ? 5000 : 50), exporting ? 20000 : 200));
  const offset = usageInteger(q.offset, 0);
  if (offset > 10000) usageBadQuery("usage_offset_limit_use_cursor");
  if (cursor && offset) usageBadQuery("usage_cursor_offset_conflict");
  return { from, to, ...filters, cursor, limit, offset, scope };
}
function usageNextCursor(opts: ReturnType<typeof parseUsageQuery>, last: UsageRow | undefined, hasMore: boolean) {
  return hasMore && last ? JSON.stringify({ from: opts.from, to: opts.to, scope: opts.scope, created_at: last.created_at, id: last.id }) : null;
}
usageApp.get("/export", async (c) => {
  const opts = parseUsageQuery(c.req.query(), true);
  const rows = await listUsage(c.env, { ...opts, limit: opts.limit + 1 });
  const items = rows.slice(0, opts.limit);
  const hasMore = rows.length > opts.limit;
  const filename = "usage-export-" + opts.from + "-" + opts.to + ".csv";
  return new Response(formatUsageCsv(items), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="' + filename + '"',
      "Cache-Control": "no-store",
      "X-Usage-From": String(opts.from), "X-Usage-To": String(opts.to),
      "X-Usage-Truncated": String(hasMore),
      "X-Usage-Next-Cursor": encodeURIComponent(usageNextCursor(opts, items[items.length - 1], hasMore) || ""),
    },
  });
});

usageApp.get("/", async (c) => {
  const opts = parseUsageQuery(c.req.query());
  const rows = await listUsage(c.env, { ...opts, limit: opts.limit + 1 });
  const items = rows.slice(0, opts.limit);
  const has_more = rows.length > opts.limit;
  return c.json({ items, limit: opts.limit, offset: opts.offset, from: opts.from, to: opts.to, has_more,
    next_cursor: usageNextCursor(opts, items[items.length - 1], has_more), scope: "retained_raw_details" });
});

usageApp.get("/stats", async (c) => {
  const range = c.req.query("range") || "today";
  const tzOffset = getTzOffsetMinutes(c);
  let since: number;
  if (range === "7d") since = startOfToday(6, tzOffset);
  else if (range === "30d") since = startOfToday(29, tzOffset);
  else since = startOfToday(0, tzOffset);

  const tzModifier = formatSqlTimezoneModifier(tzOffset);

  const [summary, byProvider, byModel, trend] = await Promise.all([
    statsSummary(c.env, since, tzOffset),
    statsByProvider(c.env, since, tzOffset),
    statsByModel(c.env, since, tzOffset),
    statsTrend(c.env, since, tzModifier, tzOffset),
  ]);

  return c.json({
    range,
    since,
    summary,
    byProvider,
    byModel,
    trend,
  });
});

usageApp.post("/aggregate", async (c) => {
  const tzOffset = getTzOffsetMinutes(c);
  const tzModifier = formatSqlTimezoneModifier(tzOffset);
  const body = (await c.req.json().catch(() => ({}))) as { targetDate?: string };
  const res = await aggregateDailyStats(c.env, body?.targetDate, tzModifier);
  return c.json({ ok: true, aggregated: res.aggregated });
});
