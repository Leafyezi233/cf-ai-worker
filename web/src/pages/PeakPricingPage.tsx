import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { ModelGroupItem, ModelItem, PriceWindowItem, PriceWindowsResponse } from "../types";
import { Badge, Button, Card, Empty, Input, Select, Spinner } from "../components/ui";
import { useToast } from "../components/Toast";
import { useQuery, invalidateCache } from "../hooks/useQuery";
import { DAY_LABELS, minuteToHHMM, tzLabel } from "../peakPricing";

import { useAdminFilters } from "../hooks/useAdminFilters";
import { AdminListToolbar } from "../components/AdminListToolbar";
const FILTERS = { q: "", enabled: "", sort: "", peak: "", scope: "", rule_q: "", rule_enabled: "", timezone: "" };
const EMPTY_ROWS: PricingRow[] = [];

export { DAY_LABELS, minuteToHHMM, tzLabel } from "../peakPricing";

interface Draft {
  day_type: string;
  start: string;
  end: string;
  multiplier: string;
  enabled: boolean;
}

function toDrafts(items: PriceWindowItem[]): Draft[] {
  return items.map((w) => ({
    day_type: w.day_type,
    start: minuteToHHMM(w.start_minute),
    end: minuteToHHMM(w.end_minute),
    multiplier: String(w.multiplier),
    enabled: w.enabled === 1,
  }));
}

interface PricingRow extends ModelItem {
  scope?: "model" | "group";
}

export default function PeakPricingPage() {
  const toast = useToast();
  const [filters, setFilter, resetFilters] = useAdminFilters(FILTERS);
  const dirty = useRef(false);
  const editVersion = useRef(0);
  const [modelId, setModelId] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const updateDrafts = (next: Draft[] | ((prev: Draft[]) => Draft[])) => {
    dirty.current = true;
    editVersion.current++;
    setDrafts(next);
  };
  function selectModel(id: string) {
    if (dirty.current && !confirm("切换配置会放弃未保存时段，继续？")) return;
    dirty.current = false;
    editVersion.current++;
    setDrafts([]);
    setModelId(id);
  }
  const [saving, setSaving] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);

  const scopeById = useRef<Record<string, "model" | "group">>({});
  const basePathFor = useCallback(
    (id: string) => (scopeById.current[id] === "group" ? "/api/model-groups" : "/api/models"),
    []
  );

  const fetchModels = useCallback(async () => {
    const [models, groups] = await Promise.all([
      api.get<{ items: ModelItem[] }>("/api/models"),
      api.get<{ items: ModelGroupItem[] }>("/api/model-groups"),
    ]);
    const modelRows: PricingRow[] = (models.items || []).map((m) => ({ ...m, scope: "model" as const }));
    const groupRows: PricingRow[] = (groups.items || []).map((g) => ({
      id: g.id,
      provider_id: "",
      model_name: g.name,
      display_name: g.display_name,
      alias: null,
      fallback_model_id: null,
      input_price_per_m: g.input_price_per_m,
      output_price_per_m: g.output_price_per_m,
      cache_read_price_per_m: g.cache_read_price_per_m,
      cache_write_price_per_m: g.cache_write_price_per_m,
      cache_enabled: g.cache_enabled,
      cache_ttl: g.cache_ttl,
      model_public: g.model_public,
      pricing_mode: g.pricing_mode,
      peak_pricing_enabled: g.peak_pricing_enabled,
      enabled: g.enabled,
      config_json: g.config_json,
      provider_name: g.members?.length ? `${g.members.length} 个成员` : "空分组",
      scope: "group" as const,
    }));
    scopeById.current = Object.fromEntries(
      [...modelRows, ...groupRows].map((r) => [r.id, r.scope === "group" ? "group" : "model"] as const)
    );
    return [...modelRows, ...groupRows];
  }, []);
  const { data: models, loading: modelsLoading, isRefreshing: modelsRefreshing, error: modelsError, refresh: refreshModels } = useQuery("peak-pricing-models", fetchModels);

  const loadWindows = useCallback(
    async (id: string): Promise<PriceWindowsResponse> => {
      const res = await api.get<PriceWindowsResponse>(basePathFor(id) + "/" + id + "/price-windows");
      return res;
    },
    [basePathFor]
  );
  const {
    data: windows,
    loading: windowsLoading,
    isRefreshing: windowsRefreshing,
    error,
    refresh,
  } = useQuery("peak-pricing:" + modelId, () => loadWindows(modelId), { enabled: Boolean(modelId), ttlMs: 0 });


  useEffect(() => {
    if (windows && !dirty.current) setDrafts(toDrafts(windows.items || []));
  }, [windows, modelId]);

  async function refreshLists() {
    if (saving || savingToggle) return;
    try {
      await refreshModels();
      if (dirty.current) {
        toast.error("时段存在未保存草稿，已保留；仅刷新模型列表");
        return;
      }
      if (modelId) await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? `刷新失败：${err.message}` : "刷新失败，已保留当前数据与草稿");
    }
  }

  async function saveWindows() {
    if (!modelId) return;
    const bad = drafts.find((d) => !/^\d{1,2}:\d{2}$/.test(d.start) || !/^\d{1,2}:\d{2}$/.test(d.end));
    if (bad) {
      toast.error("时段格式必须是 HH:MM");
      return;
    }
    const version = editVersion.current;
    setSaving(true);
    try {
      await api.put(basePathFor(modelId) + "/" + modelId + "/price-windows", {
        windows: drafts.map((d) => ({
          day_type: d.day_type,
          start: d.start,
          end: d.end,
          multiplier: Number(d.multiplier) || 0,
          enabled: d.enabled,
        })),
      });
      toast.success("峰谷时段已保存");
      invalidateCache("peak-pricing:");
      if (editVersion.current === version) dirty.current = false;
      await refresh(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function togglePeak(model: PricingRow, next: boolean) {
    setSavingToggle(true);
    try {
      await api.put((model.scope === "group" ? "/api/model-groups" : "/api/models") + "/" + model.id, {
        peak_pricing_enabled: next,
      });
      toast.success(next ? "已开启峰谷定价" : "已关闭峰谷定价");
      invalidateCache("peak-pricing-models");
      invalidateCache("models-page-data");
      invalidateCache("peak-pricing:");
      await refreshModels(true);  
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setSavingToggle(false);
    }
  }

  const list = models || EMPTY_ROWS;
  scopeById.current = useMemo(() => Object.fromEntries(list.map(m => [m.id, m.scope === "group" ? "group" as const : "model" as const])), [list]);
  const visibleList = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const result = list.filter(m => (!q || [m.model_name, m.display_name, m.alias, m.provider_name].some(v => v?.toLowerCase().includes(q)))
      && (!filters.enabled || String(Number(Boolean(m.enabled))) === filters.enabled)
      && (!filters.peak || String(Number(m.peak_pricing_enabled === 1)) === filters.peak)
      && (!filters.scope || m.scope === filters.scope));
    if (filters.sort) result.sort((a, b) => (a.model_name.localeCompare(b.model_name) || a.id.localeCompare(b.id)) * (filters.sort === "name-desc" ? -1 : 1));
    return result;
  }, [list, filters]);
  const selected = list.find((m) => m.id === modelId);
  const tz = windows?.tz_offset_minutes;
  const visibleDrafts = useMemo(() => {
    const q = filters.rule_q.trim().toLowerCase();
    const rows = drafts.map((draft, index) => ({ draft, index })).filter(({ draft: d }) =>
      (!filters.rule_enabled || String(Number(d.enabled)) === filters.rule_enabled)
      && (!filters.timezone || (tz !== undefined && String(tz) === filters.timezone))
      && (!q || [d.day_type, DAY_LABELS[d.day_type], d.start, d.end, d.multiplier].some(v => v?.toLowerCase().includes(q))));
    return rows;
  }, [drafts, filters.rule_q, filters.rule_enabled, filters.timezone, tz]);

  return (
    <div className="space-y-4">
      <Card
        title="峰谷定价"
        action={
          <span className="text-xs text-slate-400">每个模型或分组独立配置</span>
        }
      >
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          开启后，命中时段的请求按乘数计费（乘数作用于输入/输出基础价）。一个请求按它<strong>开始时</strong>命中的时段计费，
          预占与结算用同一份快照，不会因为跨越时段边界而错账。
        </p>
        <AdminListToolbar filters={filters} onChange={setFilter} onReset={resetFilters} total={list.length} count={visibleList.length} loading={modelsLoading || modelsRefreshing || windowsRefreshing || saving || savingToggle} error={modelsError?.message} onRefresh={() => { void refreshLists(); }} searchPlaceholder="搜索模型 / 分组 / 服务商（勿输入密钥）">
          <Select aria-label="峰谷状态" className="!w-auto" value={filters.peak} onChange={e => setFilter("peak", e.target.value)}><option value="">全部峰谷状态</option><option value="1">峰谷开启</option><option value="0">峰谷关闭</option></Select>
          <Select aria-label="定价对象" className="!w-auto" value={filters.scope} onChange={e => setFilter("scope", e.target.value)}><option value="">模型与分组</option><option value="model">模型</option><option value="group">分组</option></Select>
        </AdminListToolbar>
        {modelsLoading && !list.length ? (
          <Spinner text="加载模型…" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <th className="py-2 pr-3">模型 / 分组</th>
                  <th className="py-2 pr-3">定价模式</th>
                  <th className="py-2 pr-3">峰谷</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {visibleList.map((m) => (
                  <tr key={m.id} className={"border-b border-slate-100 dark:border-slate-800/60 " + (m.id === modelId ? "bg-slate-50 dark:bg-slate-800/40" : "")}>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-700 dark:text-slate-200">{m.model_name}</span>
                        {m.scope === "group" ? <Badge tone="purple">分组</Badge> : null}
                      </div>
                      <div className="text-xs text-slate-400">{m.provider_name}</div>
                    </td>
                    <td className="py-2 pr-3">
                      {m.pricing_mode === "priced" ? (
                        <Badge tone="green">priced</Badge>
                      ) : m.pricing_mode === "free" ? (
                        <Badge tone="blue">free</Badge>
                      ) : (
                        <Badge tone="amber">unset</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {m.peak_pricing_enabled === 1 ? <Badge tone="purple">峰段涨价</Badge> : <span className="text-xs text-slate-400">未开启</span>}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={savingToggle || m.pricing_mode !== "priced"}
                        onClick={() => togglePeak(m, m.peak_pricing_enabled !== 1)}
                      >
                        {m.peak_pricing_enabled === 1 ? "关闭" : "开启"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!visibleList.length && !modelsLoading ? <Empty text={modelsError && !list.length ? "定价列表加载失败，请重试" : list.length ? "没有符合筛选条件的定价对象" : "尚无定价对象"} /> : null}
        <p className="mt-3 text-xs text-slate-400">
          只有 <code>pricing_mode = priced</code> 的模型或分组可以开峰谷；unset 会被网关拒绝调用，free 记 0 元。
          分组的时段只作用于分组自己（成员自己的时段对它不生效），所以组与成员可以给不同倍率。
        </p>
      </Card>

      <Card
        title={modelId ? "时段配置 — " + (selected?.model_name || modelId) : "时段配置"}
        action={
          <div className="flex items-center gap-2">
            <Select disabled={saving || windowsLoading || windowsRefreshing} value={modelId} onChange={(e) => selectModel(e.target.value)} className="w-56">
              <option value="">选择模型或分组…</option>
              {list.filter((m) => m.pricing_mode === "priced").map((m) => (
                <option key={m.id} value={m.id}>{m.model_name}</option>
              ))}
            </Select>
            <Button size="sm" disabled={saving || windowsLoading || windowsRefreshing || !windows || !modelId} onClick={saveWindows}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2 mb-3" aria-label="时段筛选">
          <Input aria-label="时段关键词" className="sm:!w-56" value={filters.rule_q} onChange={e => setFilter("rule_q", e.target.value)} placeholder="搜索适用日 / 时间 / 乘数" />
          <Select aria-label="时段状态" className="!w-auto" value={filters.rule_enabled} onChange={e => setFilter("rule_enabled", e.target.value)}><option value="">全部时段状态</option><option value="1">启用</option><option value="0">停用</option></Select>
          <Select aria-label="服务端时区" className="!w-auto" value={filters.timezone} onChange={e => setFilter("timezone", e.target.value)}><option value="">全部时区</option>{tz !== undefined ? <option value={String(tz)}>{tzLabel(tz)}</option> : null}{filters.timezone && filters.timezone !== String(tz) ? <option value={filters.timezone}>UTC 偏移 {filters.timezone} 分钟（不匹配）</option> : null}</Select>
          <span role="status" className="text-xs text-slate-400">显示 {visibleDrafts.length} / {drafts.length} 时段；保存包含隐藏时段</span>
        </div>
        {error ? <p role="alert" className="text-sm text-red-500">{error.message}{windows ? "（保留上次数据与草稿）" : ""}</p> : null}
        {!modelId ? (
          <Empty text="先在上方表格或这里选择一个模型或分组，才能配置它的峰谷时段" />
        ) : windowsLoading && !windows ? (
          <Spinner text="加载时段…" />
        ) : error && !windows ? (
          <Empty text="时段加载失败，请刷新重试" />
        ) : (
          <fieldset disabled={saving || windowsRefreshing} className="space-y-3">
            {tz !== undefined ? (
              <p className="text-xs text-slate-400">
                所有时段按服务端时区 <strong>{tzLabel(tz)}</strong> 计算（北京时间 UTC+8）。改错时区会让全部时段整体偏移。
              </p>
            ) : null}
            {visibleDrafts.length === 0 ? (
              <Empty text={drafts.length ? "没有符合筛选条件的时段" : "尚未配置时段，未命中任何时段即按基础价计费"} />
            ) : (
              visibleDrafts.map(({ draft: d, index: idx }) => (
                <div
                  key={idx}
                  className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end border border-slate-200 dark:border-slate-800 rounded-lg p-3"
                >
                  <div className="sm:col-span-3">
                    <label className="block text-xs text-slate-500 mb-1">适用日</label>
                    <Select
                      value={d.day_type}
                      onChange={(e) =>
                        updateDrafts((prev) => prev.map((p, i) => (i === idx ? { ...p, day_type: e.target.value } : p)))
                      }
                    >
                      {Object.keys(DAY_LABELS).map((k) => (
                        <option key={k} value={k}>{DAY_LABELS[k]}</option>
                      ))}
                    </Select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-slate-500 mb-1">开始</label>
                    <Input
                      value={d.start}
                      placeholder="20:00"
                      onChange={(e) =>
                        updateDrafts((prev) => prev.map((p, i) => (i === idx ? { ...p, start: e.target.value } : p)))
                      }
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-slate-500 mb-1">结束</label>
                    <Input
                      value={d.end}
                      placeholder="24:00 / 02:00"
                      onChange={(e) =>
                        updateDrafts((prev) => prev.map((p, i) => (i === idx ? { ...p, end: e.target.value } : p)))
                      }
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-slate-500 mb-1">乘数</label>
                    <Input
                      type="number"
                      step="0.1"
                      min="0"
                      value={d.multiplier}
                      onChange={(e) =>
                        updateDrafts((prev) => prev.map((p, i) => (i === idx ? { ...p, multiplier: e.target.value } : p)))
                      }
                    />
                  </div>
                  <div className="sm:col-span-2 flex items-center gap-2">
                    <label className="flex items-center gap-1 text-xs text-slate-500">
                      <input
                        type="checkbox"
                        checked={d.enabled}
                        onChange={(e) =>
                          updateDrafts((prev) => prev.map((p, i) => (i === idx ? { ...p, enabled: e.target.checked } : p)))
                        }
                      />
                      启用
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => updateDrafts((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              ))
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                updateDrafts((prev) => [...prev, { day_type: "weekday", start: "20:00", end: "24:00", multiplier: "2", enabled: true }])
              }
            >
              添加时段
            </Button>
            <p className="text-xs text-slate-400">
              结束时间早于开始时间表示跨午夜（如 22:00 → 02:00）。具体某天的时段优先于「工作日/周末」分组；
              同优先级重叠时，开始时间更晚的时段胜出。
            </p>
          </fieldset>
        )}
      </Card>
    </div>
  );
}