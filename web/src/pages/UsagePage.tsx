import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtNum, fmtTime } from "../api/client";
import type {
  Provider,
  UsageItem,
  MonthlyReport,
  CostAnalytics,
} from "../types";
import { Badge, Button, Card, Empty, Input, Select, Spinner, CopyButton } from "../components/ui";
import {
  IconUsage,
  IconSearch,
  IconRefresh,
  IconDownload,
  IconZap,
  IconAlertTriangle,
  IconInfo,
} from "../components/icons";
import { useToast } from "../components/Toast";
import { useQuery } from "../hooks/useQuery";
import { useLocation, useNavigate } from "react-router-dom";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_VISIBLE_LOGS = 1000;
const LOG_DEFAULTS = { range: "24h", provider: "", model: "", device: "", status: "", requestid: "", servicegroup: "" };
type LogFilters = typeof LOG_DEFAULTS;
type LogPage = { items: UsageItem[]; has_more: boolean; next_cursor: string | null };
function readLogFilters(search: string): LogFilters {
  const q = new URLSearchParams(search);
  const values = { ...LOG_DEFAULTS };
  for (const key of Object.keys(values) as (keyof LogFilters)[]) values[key] = q.get("list_" + key) ?? values[key];
  if (!["today", "24h", "7d", "30d"].includes(values.range)) values.range = "24h";
  return values;
}
function logSnapshot(filters: LogFilters) {
  const to = Date.now();
  const span = filters.range === "30d" ? 30 * DAY_MS : filters.range === "7d" ? 7 * DAY_MS : DAY_MS;
  const midnight = new Date(to); midnight.setHours(0, 0, 0, 0);
  if (filters.range === "7d") midnight.setDate(midnight.getDate() - 6);
  if (filters.range === "30d") midnight.setDate(midnight.getDate() - 29);
  const start = filters.range === "24h" ? to - span : midnight.getTime();
  const q = new URLSearchParams({ from: String(start), to: String(to) });
  for (const [key, field] of [["provider", "provider_id"], ["model", "model"], ["device", "device_id"], ["status", "status"], ["requestid", "request_id"], ["servicegroup", "service_group_id"]] as const) {
    if (filters[key].trim()) q.set(field, filters[key].trim());
  }
  return q.toString();
}

export default function UsagePage() {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<"logs" | "monthly" | "analytics">("logs");

  const fetchProviders = useCallback(async () => {
    const res = await api.get<{ items: Provider[] }>("/api/providers");
    return res.items || [];
  }, []);
  const { data: providers = [] } = useQuery("providers-list", fetchProviders);

  const location = useLocation();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(() => readLogFilters(location.search));
  const { range, provider: providerId, model } = draft;
  const setRange = (value: string) => setDraft(d => ({ ...d, range: value }));
  const setProviderId = (value: string) => setDraft(d => ({ ...d, provider: value }));
  const setModel = (value: string) => setDraft(d => ({ ...d, model: value }));
  const [query, setQuery] = useState(() => logSnapshot(readLogFilters(location.search)));
  const [items, setItems] = useState<UsageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedQuery, setLoadedQuery] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const logsSequence = useRef(0);
  const morePending = useRef(false);
  const monthlySequence = useRef(0);
  const analyticsSequence = useRef(0);
  const [reportError, setReportError] = useState("");
  const [analyticsError, setAnalyticsError] = useState("");
  const [reportMonth, setReportMonth] = useState("");
  const [loadedAnalyticsRange, setLoadedAnalyticsRange] = useState("");
  const [observedSearch, setObservedSearch] = useState(location.search);
  if (observedSearch !== location.search) {
    const values = readLogFilters(location.search);
    setObservedSearch(location.search);
    setDraft(values);
    logsSequence.current++;
    setQuery(logSnapshot(values));
  }
  const applyFilters = (values = draft) => {
    const q = new URLSearchParams(location.search);
    for (const key of Object.keys(LOG_DEFAULTS) as (keyof LogFilters)[]) {
      if (values[key] === LOG_DEFAULTS[key]) q.delete("list_" + key);
      else q.set("list_" + key, values[key].trim());
    }
    const search = q.toString() ? "?" + q.toString() : "";
    logsSequence.current++;
    if (search === location.search) setQuery(logSnapshot(values));
    else navigate({ pathname: location.pathname, search, hash: location.hash }, { replace: true });
  };
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");

  const currentMonthStr = new Date().toISOString().slice(0, 7);  
  const [selectedMonth, setSelectedMonth] = useState(currentMonthStr);
  const [monthlyReport, setMonthlyReport] = useState<MonthlyReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [pushingWebhook, setPushingWebhook] = useState(false);
  const [exportingReport, setExportingReport] = useState(false);
  const [breakdownView, setBreakdownView] = useState<"model" | "provider" | "device">("model");

  const [analyticsRange, setAnalyticsRange] = useState("30d");
  const [costAnalytics, setCostAnalytics] = useState<CostAnalytics | null>(null);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);

  const scopes = useRef({ logs: "", monthly: "", analytics: "" });
  const logScope = activeTab + ":" + query;
  const monthScope = activeTab + ":" + selectedMonth;
  const analyticsScope = activeTab + ":" + analyticsRange;
  if (scopes.current.logs !== logScope) { scopes.current.logs = logScope; logsSequence.current++; }
  if (scopes.current.monthly !== monthScope) { scopes.current.monthly = monthScope; monthlySequence.current++; }
  if (scopes.current.analytics !== analyticsScope) { scopes.current.analytics = analyticsScope; analyticsSequence.current++; }

  const monthOptions = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - i);
    const val = d.toISOString().slice(0, 7);
    const label = `${d.getUTCFullYear()}年 ${String(d.getUTCMonth() + 1).padStart(2, "0")}月${i === 0 ? " (当月)" : ""}`;
    return { val, label };
  });

  const refreshLogs = useCallback(async () => {
    const sequence = ++logsSequence.current;
    setLoading(true);
    setLoadingMore(false);
    morePending.current = false;
    setHasMore(false);
    setError("");
    try {
      const res = await api.get<LogPage>(`/api/usage?${query}&limit=50`);
      if (sequence !== logsSequence.current) return;
      setItems(res.items || []);
      setLoadedQuery(query);
      setNextCursor(res.next_cursor);
      setHasMore(res.has_more);
    } catch (err) {
      if (sequence === logsSequence.current) setError(err instanceof Error ? err.message : "加载日志失败");
    } finally {
      if (sequence === logsSequence.current) setLoading(false);
    }
  }, [query]);

  const loadMonthlyReport = useCallback(async (m: string) => {
    const sequence = ++monthlySequence.current;
    setReportError("");
    setLoadingReport(true);
    try {
      const res = await api.get<MonthlyReport>(`/api/usage/monthly-report?month=${m}`);
      if (sequence !== monthlySequence.current) return;
      setMonthlyReport(res);
      setReportMonth(m);
    } catch (err) {
      if (sequence === monthlySequence.current) setReportError(err instanceof Error ? err.message : "获取月度账单失败");
    } finally {
      if (sequence === monthlySequence.current) setLoadingReport(false);
    }
  }, []);

  const loadCostAnalytics = useCallback(async (r: string) => {
    const sequence = ++analyticsSequence.current;
    setAnalyticsError("");
    setLoadingAnalytics(true);
    try {
      const res = await api.get<CostAnalytics>(`/api/usage/cost-analytics?range=${r}`);
      if (sequence !== analyticsSequence.current) return;
      setCostAnalytics(res);
      setLoadedAnalyticsRange(r);
    } catch (err) {
      if (sequence === analyticsSequence.current) setAnalyticsError(err instanceof Error ? err.message : "获取成本分析数据失败");
    } finally {
      if (sequence === analyticsSequence.current) setLoadingAnalytics(false);
    }
  }, []);

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      await api.download(`/api/usage/export?${query}&limit=20000`, "usage-export.csv");
      toast.success("已导出同一时间快照的明细（最多 20,000 条，超出请缩小时间范围）");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "导出 CSV 失败");
    } finally {
      setExporting(false);
    }
  };

  const handleExportMonthlyCsv = async () => {
    setExportingReport(true);
    try {
      await api.download(`/api/usage/monthly-report/export?month=${selectedMonth}`, `monthly-bill-${selectedMonth}.csv`);
      toast.success(`${selectedMonth} 月度账单 CSV 已成功导出`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "导出月度账单失败");
    } finally {
      setExportingReport(false);
    }
  };

  const handlePushMonthlyWebhook = async () => {
    setPushingWebhook(true);
    try {
      const res = await api.post<{ ok: boolean; message: string }>(`/api/usage/monthly-report/push-webhook?month=${selectedMonth}`);
      if (res.ok) {
        toast.success(res.message || "月度账单已成功推送到 Webhook");
      } else {
        toast.error(res.message || "推送失败，请在设置页检查 Webhook 配置");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "推送 Webhook 失败");
    } finally {
      setPushingWebhook(false);
    }
  };

  const loadMore = async () => {
    if (morePending.current || loading || loadedQuery !== query || !nextCursor || !hasMore || items.length >= MAX_VISIBLE_LOGS) return;
    morePending.current = true;
    const sequence = logsSequence.current;
    setLoadingMore(true);
    try {
      const res = await api.get<LogPage>(`/api/usage?${query}&limit=50&cursor=${encodeURIComponent(nextCursor)}`);
      if (sequence !== logsSequence.current) return;
      setItems(prev => {
        const ids = new Set(prev.map(row => row.id));
        const added = res.items.filter(row => {
          if (ids.has(row.id)) return false;
          ids.add(row.id); return true;
        });
        return [...prev, ...added].slice(0, MAX_VISIBLE_LOGS);
      });
      setNextCursor(res.next_cursor);
      setHasMore(res.has_more);
    } catch (err) {
      if (sequence === logsSequence.current) setError(err instanceof Error ? err.message : "加载更多失败");
    } finally {
      if (sequence === logsSequence.current) { morePending.current = false; setLoadingMore(false); }
    }
  };

  useEffect(() => {
    if (activeTab === "logs") void refreshLogs();
    return () => { logsSequence.current++; };
  }, [activeTab, refreshLogs]);
  useEffect(() => {
    if (activeTab === "monthly") void loadMonthlyReport(selectedMonth);
    return () => { monthlySequence.current++; };
  }, [activeTab, loadMonthlyReport, selectedMonth]);
  useEffect(() => {
    if (activeTab === "analytics") void loadCostAnalytics(analyticsRange);
    return () => { analyticsSequence.current++; };
  }, [activeTab, loadCostAnalytics, analyticsRange]);
  const resetFilters = () => { setDraft({ ...LOG_DEFAULTS }); applyFilters({ ...LOG_DEFAULTS }); };

  return (
    <div className="space-y-4 sm:space-y-6">
      { }
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">
            用量与账单
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            监控透传请求日志、月度对账报表、模型消费排行榜与成本突增异常告警
          </p>
        </div>

        { }
        <div className="flex items-center gap-1.5 p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl border border-slate-200/60 dark:border-slate-700/60 self-start sm:self-auto text-xs font-semibold">
          <button
            onClick={() => setActiveTab("logs")}
            className={`px-3 py-1.5 rounded-lg transition-all ${
              activeTab === "logs"
                ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm"
                : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
            }`}
          >
            📋 调用日志
          </button>
          <button
            onClick={() => setActiveTab("monthly")}
            className={`px-3 py-1.5 rounded-lg transition-all ${
              activeTab === "monthly"
                ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm"
                : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
            }`}
          >
            📅 月度报表
          </button>
          <button
            onClick={() => setActiveTab("analytics")}
            className={`px-3 py-1.5 rounded-lg transition-all ${
              activeTab === "analytics"
                ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm"
                : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
            }`}
          >
            🏆 消费排行与异常
          </button>
        </div>
      </div>

      { }
      {activeTab === "logs" && (
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 mb-4 border-b border-slate-100 dark:border-slate-800">
            { }
            <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2.5 sm:gap-3 flex-1">
              <div className="w-full sm:w-40">
                <Select value={range} onChange={(e) => setRange(e.target.value)}>
                  <option value="today">今日（浏览器时区）</option>
                  <option value="24h">最近 24 小时</option>
                  <option value="7d">近 7 自然日（含今日）</option>
                  <option value="30d">近 30 自然日（含今日）</option>

                </Select>
              </div>
              <div className="w-full sm:w-48">
                <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                  <option value="">全部 Provider</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-full sm:w-56 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400 dark:text-slate-500">
                  <IconSearch />
                </div>
                <Input
                  className="pl-9"
                  placeholder="按模型名筛选…"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>
              {([['device', '设备 ID'], ['status', '状态 success / error / HTTP'], ['requestid', 'Request ID'], ['servicegroup', '服务分组 ID']] as const).map(([key, label]) => (
                <Input key={key} aria-label={label} placeholder={label} value={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} />
              ))}
              <Button size="sm" onClick={() => applyFilters()}>应用筛选</Button>
              {(JSON.stringify(draft) !== JSON.stringify(LOG_DEFAULTS)) && (
                <Button variant="ghost" size="sm" onClick={resetFilters} className="self-start sm:self-auto">
                  重置筛选
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={exporting || loading || loadedQuery !== query || !!error}>
                <IconDownload />
                <span>{exporting ? "导出中…" : "导出 CSV"}</span>
              </Button>
              <Button variant="outline" size="sm" onClick={() => { logsSequence.current++; setQuery(logSnapshot(readLogFilters(location.search))); }}>
                <IconRefresh />
                <span>刷新记录</span>
              </Button>
            </div>
          </div>

          {error ? (
            <div className="mb-4 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 p-3 rounded-lg">
              {error}
            </div>
          ) : null}

          <p className="text-xs text-slate-500 mb-3">仅保留的原始明细；列表、翻页与导出共用固定时间快照：{fmtTime(Number(new URLSearchParams(query).get("from")))} — {fmtTime(Number(new URLSearchParams(query).get("to")))}。月报及分析不受本页筛选影响。无自动轮询。</p>
          {JSON.stringify(draft) !== JSON.stringify(readLogFilters(location.search)) && <p role="status">筛选修改尚未应用；当前数据与导出仍使用已应用条件。</p>}
          {(loading || loadedQuery !== query || error) && items.length > 0 && <p role="status">旧数据（待更新 / 已过期），不代表当前筛选结果。</p>}
          {loading && !items.length ? (
            <Spinner text="正在获取日志数据…" />
          ) : items.length ? (
            <>
              <div className="overflow-x-auto -mx-4 -my-4 sm:mx-0 sm:my-0">
                <table className="w-full text-left text-xs sm:text-sm min-w-[860px]">
                  <thead>
                    <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 dark:text-slate-500 font-medium">
                      <th className="pb-3 px-3 whitespace-nowrap">请求时间</th>
                      <th className="pb-3 px-2 whitespace-nowrap">状态 / 缓存</th>
                      <th className="pb-3 px-2 whitespace-nowrap">模型</th>
                      <th className="pb-3 px-2 whitespace-nowrap">Provider</th>
                      <th className="pb-3 px-2 whitespace-nowrap">设备来源</th>
                      <th className="pb-3 px-2 text-right whitespace-nowrap">In Tokens</th>
                      <th className="pb-3 px-2 text-right whitespace-nowrap">Out Tokens</th>
                      <th className="pb-3 px-2 text-right whitespace-nowrap">总 Tokens</th>
                      <th className="pb-3 px-2 text-right whitespace-nowrap">预估费用</th>
                      <th className="pb-3 px-2 text-right whitespace-nowrap">响应延迟</th>
                      <th className="pb-3 px-3 whitespace-nowrap">Request ID</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {items.map((u) => (
                      <tr key={u.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/50 transition-colors">
                        <td className="py-3 px-3 text-slate-500 dark:text-slate-400 whitespace-nowrap text-xs">
                          {fmtTime(u.created_at)}
                        </td>
                        <td className="py-3 px-2 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <Badge
                              tone={
                                u.status_code && u.status_code >= 500
                                  ? "red"
                                  : u.status_code && u.status_code >= 400
                                  ? "amber"
                                  : "green"
                              }
                              dot
                            >
                              {u.status_code ?? "-"}
                            </Badge>
                            {u.cache_hit ? (
                              <Badge tone="purple" title="该请求命中 Cloudflare KV 响应缓存">
                                ⚡ HIT
                              </Badge>
                            ) : null}
                          </div>
                        </td>
                        <td className="py-3 px-2 font-mono font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                          {u.model || "-"}
                        </td>
                        <td className="py-3 px-2 text-slate-600 dark:text-slate-400 whitespace-nowrap">
                          {u.provider_name || "-"}
                        </td>
                        <td className="py-3 px-2 text-slate-400 dark:text-slate-500 text-xs truncate max-w-[120px]">
                          {u.device_id || "-"}
                        </td>
                        <td className="py-3 px-2 text-right font-mono text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">
                          {fmtNum(u.input_tokens)}
                        </td>
                        <td className="py-3 px-2 text-right font-mono text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">
                          {fmtNum(u.output_tokens)}
                        </td>
                        <td className="py-3 px-2 text-right font-mono font-semibold text-slate-800 dark:text-slate-200 text-xs whitespace-nowrap">
                          {fmtNum(u.total_tokens)}
                        </td>
                        <td className="py-3 px-2 text-right font-mono text-xs font-medium whitespace-nowrap">
                          {u.cache_hit ? (
                            <span className="text-emerald-600 dark:text-emerald-400" title="命中缓存，无需向上游计费">
                              ¥0.0000
                            </span>
                          ) : u.cost_usd ? (
                            <span className="text-purple-600 dark:text-purple-400">¥{u.cost_usd.toFixed(4)}</span>
                          ) : (
                            <span className="text-slate-500 dark:text-slate-400">¥0.0000</span>
                          )}
                        </td>
                        <td className="py-3 px-2 text-right text-xs whitespace-nowrap">
                          {u.latency_ms != null ? (
                            <span
                              className={`font-mono ${
                                u.cache_hit
                                  ? "text-purple-600 dark:text-purple-400 font-semibold"
                                  : u.latency_ms > 5000
                                  ? "text-amber-600 dark:text-amber-400"
                                  : u.latency_ms > 15000
                                  ? "text-rose-600 dark:text-rose-400"
                                  : "text-slate-600 dark:text-slate-400"
                              }`}
                            >
                              {u.latency_ms}ms
                            </span>
                          ) : (
                            <span className="text-slate-400 dark:text-slate-500">-</span>
                          )}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          {u.request_id ? (
                            <div className="flex items-center gap-1 font-mono text-[11px] text-slate-400 dark:text-slate-500">
                              <span className="truncate max-w-[100px]">{u.request_id}</span>
                              <CopyButton text={u.request_id} />
                            </div>
                          ) : (
                            <span className="text-slate-400 dark:text-slate-500 text-xs">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {hasMore ? (
                <div className="mt-6 text-center">
                  <Button variant="secondary" onClick={loadMore} disabled={loadingMore || loading || loadedQuery !== query || !!error || items.length >= MAX_VISIBLE_LOGS}>
                    {items.length >= MAX_VISIBLE_LOGS ? "列表已达 1,000 条上限，请缩小筛选范围或导出（最多 20,000 条）" : loadingMore ? "正在加载…" : "加载更多历史数据"}
                  </Button>
                </div>
              ) : (
                <div className="mt-6 text-center text-xs text-slate-400 dark:text-slate-500">已加载全部结果</div>
              )}
            </>
          ) : (
            <Empty text="未找到符合条件的用量记录" icon={<IconUsage className="w-8 h-8" />} />
          )}
        </Card>
      )}

      { }
      {activeTab === "monthly" && (
        <div className="space-y-4 sm:space-y-6">
          { }
          <Card>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap">
                  统计月份：
                </span>
                <div className="w-48">
                  <Select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)}>
                    {monthOptions.map((opt) => (
                      <option key={opt.val} value={opt.val}>
                        {opt.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExportMonthlyCsv}
                  disabled={exportingReport || loadingReport}
                >
                  <IconDownload />
                  <span>{exportingReport ? "导出中…" : "📥 导出月度 CSV"}</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePushMonthlyWebhook}
                  disabled={pushingWebhook || loadingReport}
                  title="将本月账单摘要以 Markdown 格式推送到 Webhook (飞书/钉钉/企业微信/Slack)"
                >
                  <span>{pushingWebhook ? "推送中…" : "🔔 推送账单至 Webhook"}</span>
                </Button>
                <Button variant="outline" size="sm" onClick={() => loadMonthlyReport(selectedMonth)}>
                  <IconRefresh />
                  <span>刷新</span>
                </Button>
              </div>
            </div>
          </Card>

          <p className="text-xs text-slate-500">月报独立范围：所选月份全部服务商、模型与设备，不使用日志筛选。</p>
          {(reportError || loadingReport || reportMonth !== selectedMonth) && <p role="status">{reportError || "月报待更新"}；已有数据为旧快照。</p>}
          {loadingReport && !monthlyReport ? (
            <Spinner text="正在生成月度账单报表…" />
          ) : monthlyReport ? (
            <>
              { }
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 sm:gap-4">
                <div className="p-4 rounded-2xl bg-white border border-slate-200/70 shadow-card dark:bg-slate-900 dark:border-slate-800 dark:shadow-none">
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400">当月总消耗费用</div>
                  <div className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums text-slate-900 dark:text-slate-50 mt-1">
                    ¥{monthlyReport.total_cost_usd.toFixed(2)}
                  </div>
                  <div className="flex items-center gap-1.5 mt-2 text-xs font-medium">
                    <span className="text-slate-500 dark:text-slate-400">环比上月:</span>
                    <Badge
                      tone={
                        monthlyReport.mom_growth.cost_growth_percent > 0
                          ? "red"
                          : monthlyReport.mom_growth.cost_growth_percent < 0
                          ? "green"
                          : "slate"
                      }
                    >
                      {monthlyReport.mom_growth.cost_growth_percent > 0 ? "+" : ""}
                      {monthlyReport.mom_growth.cost_growth_percent}%
                    </Badge>
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-white border border-slate-200/70 shadow-card dark:bg-slate-900 dark:border-slate-800 dark:shadow-none">
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400">总调用次数</div>
                  <div className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums text-slate-900 dark:text-slate-50 mt-1">
                    {monthlyReport.total_requests.toLocaleString()} <span className="text-sm font-normal">次</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-2 text-xs font-medium">
                    <span className="text-slate-500 dark:text-slate-400">环比上月:</span>
                    <Badge
                      tone={
                        monthlyReport.mom_growth.request_growth_percent > 0
                          ? "blue"
                          : monthlyReport.mom_growth.request_growth_percent < 0
                          ? "green"
                          : "slate"
                      }
                    >
                      {monthlyReport.mom_growth.request_growth_percent > 0 ? "+" : ""}
                      {monthlyReport.mom_growth.request_growth_percent}%
                    </Badge>
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-white border border-slate-200/70 shadow-card dark:bg-slate-900 dark:border-slate-800 dark:shadow-none">
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400">累计消耗 Tokens</div>
                  <div className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums text-slate-900 dark:text-slate-50 mt-1">
                    {fmtNum(monthlyReport.total_tokens)}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-2 font-mono">
                    入: {fmtNum(monthlyReport.total_input_tokens)} | 出: {fmtNum(monthlyReport.total_output_tokens)}
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-white border border-slate-200/70 shadow-card dark:bg-slate-900 dark:border-slate-800 dark:shadow-none">
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400">KV 响应缓存节省</div>
                  <div className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums text-slate-900 dark:text-slate-50 mt-1">
                    ¥{monthlyReport.cache_saved_cost_usd.toFixed(2)}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-2 font-medium">
                    命中 {monthlyReport.cache_hit_count} 次 ({fmtNum(monthlyReport.cache_saved_tokens)} Tokens)
                  </div>
                </div>
              </div>

              { }
              <Card>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 mb-4 border-b border-slate-100 dark:border-slate-800">
                  <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                    💰 成本构成深度分析 ({selectedMonth})
                  </h3>
                  <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg text-xs font-medium">
                    <button
                      onClick={() => setBreakdownView("model")}
                      className={`px-2.5 py-1 rounded-md transition-all ${
                        breakdownView === "model"
                          ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm font-semibold"
                          : "text-slate-600 dark:text-slate-400"
                      }`}
                    >
                      按模型 ({monthlyReport.by_model.length})
                    </button>
                    <button
                      onClick={() => setBreakdownView("provider")}
                      className={`px-2.5 py-1 rounded-md transition-all ${
                        breakdownView === "provider"
                          ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm font-semibold"
                          : "text-slate-600 dark:text-slate-400"
                      }`}
                    >
                      按服务商 ({monthlyReport.by_provider.length})
                    </button>
                    <button
                      onClick={() => setBreakdownView("device")}
                      className={`px-2.5 py-1 rounded-md transition-all ${
                        breakdownView === "device"
                          ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm font-semibold"
                          : "text-slate-600 dark:text-slate-400"
                      }`}
                    >
                      按设备/客户端 ({monthlyReport.by_device.length})
                    </button>
                  </div>
                </div>

                { }
                {(() => {
                  const currentList =
                    breakdownView === "model"
                      ? monthlyReport.by_model
                      : breakdownView === "provider"
                      ? monthlyReport.by_provider
                      : monthlyReport.by_device;

                  if (!currentList.length) {
                    return <Empty text="当月无对应维度消费数据" />;
                  }

                  return (
                    <div className="overflow-x-auto -mx-4 -my-4 sm:mx-0 sm:my-0">
                      <table className="w-full text-left text-xs sm:text-sm min-w-[700px]">
                        <thead>
                          <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 dark:text-slate-500 font-medium">
                            <th className="pb-3 px-3 whitespace-nowrap">名称</th>
                            <th className="pb-3 px-2 text-right whitespace-nowrap">调用请求</th>
                            <th className="pb-3 px-2 text-right whitespace-nowrap">消耗 Tokens</th>
                            <th className="pb-3 px-2 text-right whitespace-nowrap">消费金额 (CNY)</th>
                            <th className="pb-3 px-3 whitespace-nowrap min-w-[150px]">费用占比</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {currentList.map((item, idx) => (
                            <tr
                              key={item.key || idx}
                              className="hover:bg-slate-50/60 dark:hover:bg-slate-800/50 transition-colors"
                            >
                              <td className="py-3 px-3 font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                                {item.name}
                              </td>
                              <td className="py-3 px-2 text-right font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                                {item.request_count.toLocaleString()}
                              </td>
                              <td className="py-3 px-2 text-right font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                                {fmtNum(item.total_tokens)}
                              </td>
                              <td className="py-3 px-2 text-right font-mono font-bold text-purple-600 dark:text-purple-400 whitespace-nowrap">
                                ¥{item.cost_usd.toFixed(4)}
                              </td>
                              <td className="py-3 px-3 whitespace-nowrap">
                                <div className="space-y-1">
                                  <div className="flex items-center justify-between text-xs font-mono">
                                    <span className="text-slate-500 dark:text-slate-400">{item.share_percent}%</span>
                                  </div>
                                  <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                    <div
                                      className="h-full bg-purple-500 dark:bg-purple-400 rounded-full transition-all duration-300"
                                      style={{ width: `${Math.min(100, item.share_percent)}%` }}
                                    />
                                  </div>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </Card>

              { }
              <Card>
                <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 pb-3 mb-3 border-b border-slate-100 dark:border-slate-800">
                  📈 当月每日调用与费用走势
                </h3>
                {monthlyReport.daily_trend.length ? (
                  <div className="overflow-x-auto -mx-4 -my-4 sm:mx-0 sm:my-0">
                    <table className="w-full text-left text-xs min-w-[500px]">
                      <thead>
                        <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 dark:text-slate-500 font-medium">
                          <th className="pb-2.5 px-3">日期</th>
                          <th className="pb-2.5 px-2 text-right">请求数</th>
                          <th className="pb-2.5 px-2 text-right">总 Tokens</th>
                          <th className="pb-2.5 px-3 text-right">当日费用 (CNY)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {monthlyReport.daily_trend.map((d) => (
                          <tr key={d.date} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                            <td className="py-2.5 px-3 font-mono font-medium text-slate-700 dark:text-slate-300">
                              {d.date}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono text-slate-600 dark:text-slate-400">
                              {d.request_count.toLocaleString()}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono text-slate-600 dark:text-slate-400">
                              {fmtNum(d.total_tokens)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono font-semibold text-purple-600 dark:text-purple-400">
                              ¥{d.cost_usd.toFixed(4)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty text="当月无每日走势记录" />
                )}
              </Card>
            </>
          ) : (
            <Empty text="未找到月度报表数据" />
          )}
        </div>
      )}

      { }
      {activeTab === "analytics" && (
        <div className="space-y-4 sm:space-y-6">
          { }
          {costAnalytics?.anomaly_alert?.is_anomaly ? (
            <div className="p-4 rounded-2xl bg-gradient-to-r from-amber-500/10 via-rose-500/10 to-transparent border border-amber-300 dark:border-amber-700/60 flex items-start gap-3">
              <IconAlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="text-sm font-bold text-amber-900 dark:text-amber-200">
                  ⚠️ 检测到成本异常突增预警
                </div>
                <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                  {costAnalytics.anomaly_alert.message}
                </p>
                <div className="text-[11px] text-amber-700 dark:text-amber-400 font-mono">
                  突增发生日: {costAnalytics.anomaly_alert.spike_date} | 突增倍率:{" "}
                  {costAnalytics.anomaly_alert.spike_ratio}x | 当日消费: ¥
                  {costAnalytics.anomaly_alert.spike_cost_usd?.toFixed(2)} (基线均值: ¥
                  {costAnalytics.anomaly_alert.baseline_avg_usd?.toFixed(2)})
                </div>
              </div>
            </div>
          ) : (
            <div className="p-3.5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-900/40 flex items-center gap-2.5 text-xs text-emerald-800 dark:text-emerald-300">
              <span className="text-base">✅</span>
              <span>近期未检测到消费异常突增，每日调用成本曲线保持平稳健康。</span>
            </div>
          )}

          { }
          <Card>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 mb-4 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  🏆 模型消费排行榜 (过去 30 天)
                </h3>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                  全方位评估各模型的消耗总金额、费用占比及千次请求平均成本
                </p>
              </div>

              <Button variant="outline" size="sm" onClick={() => loadCostAnalytics(analyticsRange)}>
                <IconRefresh />
                <span>刷新排行</span>
              </Button>
            </div>

            <p className="text-xs text-slate-500">分析独立范围：所选时段全部服务商、模型与设备，不使用日志筛选。</p>
            {(analyticsError || loadingAnalytics || loadedAnalyticsRange !== analyticsRange) && <p role="status">{analyticsError || "分析待更新"}；已有数据为旧快照。</p>}
            {loadingAnalytics && !costAnalytics ? (
              <Spinner text="正在计算模型消费排行与成本结构…" />
            ) : costAnalytics?.model_ranking?.length ? (
              <div className="overflow-x-auto -mx-4 -my-4 sm:mx-0 sm:my-0">
                <table className="w-full text-left text-xs sm:text-sm min-w-[760px]">
                  <thead>
                    <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 dark:text-slate-500 font-medium">
                      <th className="pb-3 px-3 whitespace-nowrap">排名</th>
                      <th className="pb-3 px-3 whitespace-nowrap">模型名称</th>
                      <th className="pb-3 px-2 text-right whitespace-nowrap">总请求数</th>
                      <th className="pb-3 px-2 text-right whitespace-nowrap">消耗 Tokens</th>
                      <th className="pb-3 px-2 text-right whitespace-nowrap">总费用 (CNY)</th>
                      <th className="pb-3 px-2 text-right whitespace-nowrap">单次请求均价</th>
                      <th className="pb-3 px-3 whitespace-nowrap min-w-[140px]">费用占比</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {costAnalytics.model_ranking.map((m, idx) => (
                      <tr key={m.model} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/50 transition-colors">
                        <td className="py-3 px-3 whitespace-nowrap font-bold">
                          {idx === 0 ? (
                            <span className="text-amber-500 text-sm">🥇 #1</span>
                          ) : idx === 1 ? (
                            <span className="text-slate-400 text-sm">🥈 #2</span>
                          ) : idx === 2 ? (
                            <span className="text-amber-700 text-sm">🥉 #3</span>
                          ) : (
                            <span className="text-slate-400 font-mono">#{idx + 1}</span>
                          )}
                        </td>
                        <td className="py-3 px-3 font-semibold font-mono text-slate-900 dark:text-slate-100 whitespace-nowrap">
                          {m.model}
                        </td>
                        <td className="py-3 px-2 text-right font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                          {m.request_count.toLocaleString()}
                        </td>
                        <td className="py-3 px-2 text-right font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                          {fmtNum(m.total_tokens)}
                        </td>
                        <td className="py-3 px-2 text-right font-mono font-bold text-purple-600 dark:text-purple-400 whitespace-nowrap">
                          ¥{m.cost_usd.toFixed(4)}
                        </td>
                        <td className="py-3 px-2 text-right font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">
                          ¥{m.avg_cost_per_request.toFixed(4)}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-xs font-mono">
                              <span className="text-slate-600 dark:text-slate-400">{m.share_percent}%</span>
                            </div>
                            <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                              <div
                                className="h-full bg-brand-500 dark:bg-brand-400 rounded-full transition-all duration-300"
                                style={{ width: `${Math.min(100, m.share_percent)}%` }}
                              />
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty text="暂无模型消费排行数据" />
            )}
          </Card>
        </div>
      )}
    </div>
  );
}