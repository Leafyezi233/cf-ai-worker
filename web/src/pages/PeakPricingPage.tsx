import { useCallback, useRef, useState } from "react";
import { api } from "../api/client";
import type { ModelGroupItem, ModelItem, PriceWindowItem, PriceWindowsResponse } from "../types";
import { Badge, Button, Card, Empty, Input, Select, Spinner } from "../components/ui";
import { useToast } from "../components/Toast";
import { useQuery, invalidateCache } from "../hooks/useQuery";
import { DAY_LABELS, minuteToHHMM, tzLabel } from "../peakPricing";

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
  const [modelId, setModelId] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
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
      api.get<{ items: ModelGroupItem[] }>("/api/model-groups").catch(() => ({ items: [] as ModelGroupItem[] })),
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
  const { data: models, loading: modelsLoading, refresh: refreshModels } = useQuery("peak-pricing-models", fetchModels);

  const loadWindows = useCallback(
    async (id: string): Promise<PriceWindowsResponse> => {
      const res = await api.get<PriceWindowsResponse>(basePathFor(id) + "/" + id + "/price-windows");
      setDrafts(toDrafts(res.items || []));
      return res;
    },
    [basePathFor]
  );
  const {
    data: windows,
    loading: windowsLoading,
    error,
    refresh,
  } = useQuery("peak-pricing:" + modelId, () => loadWindows(modelId), { enabled: Boolean(modelId), ttlMs: 0 });


  async function saveWindows() {
    if (!modelId) return;
    const bad = drafts.find((d) => !/^\d{1,2}:\d{2}$/.test(d.start) || !/^\d{1,2}:\d{2}$/.test(d.end));
    if (bad) {
      toast.error("时段格式必须是 HH:MM");
      return;
    }
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
      await Promise.all([refreshModels(true), refresh(true)]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setSavingToggle(false);
    }
  }

  const list = models || [];
  const selected = list.find((m) => m.id === modelId);
  const tz = windows?.tz_offset_minutes;

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
        {modelsLoading ? (
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
                {list.map((m) => (
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
        <p className="mt-3 text-xs text-slate-400">
          只有 <code>pricing_mode = priced</code> 的模型或分组可以开峰谷；unset 会被网关拒绝调用，free 记 0 元。
          分组的时段只作用于分组自己（成员自己的时段对它不生效），所以组与成员可以给不同倍率。
        </p>
      </Card>

      <Card
        title={modelId ? "时段配置 — " + (selected?.model_name || modelId) : "时段配置"}
        action={
          <div className="flex items-center gap-2">
            <Select value={modelId} onChange={(e) => setModelId(e.target.value)} className="w-56">
              <option value="">选择模型或分组…</option>
              {list.filter((m) => m.pricing_mode === "priced").map((m) => (
                <option key={m.id} value={m.id}>{m.model_name}</option>
              ))}
            </Select>
            <Button size="sm" disabled={saving || !modelId} onClick={saveWindows}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        }
      >
        {!modelId ? (
          <Empty text="先在上方表格或这里选择一个模型或分组，才能配置它的峰谷时段" />
        ) : windowsLoading ? (
          <Spinner text="加载时段…" />
        ) : error ? (
          <div className="text-sm text-red-500">{String(error)}</div>
        ) : (
          <div className="space-y-3">
            {tz !== undefined ? (
              <p className="text-xs text-slate-400">
                所有时段按服务端时区 <strong>{tzLabel(tz)}</strong> 计算（北京时间 UTC+8）。改错时区会让全部时段整体偏移。
              </p>
            ) : null}
            {drafts.length === 0 ? (
              <Empty text="尚未配置时段，未命中任何时段即按基础价计费" />
            ) : (
              drafts.map((d, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end border border-slate-200 dark:border-slate-800 rounded-lg p-3"
                >
                  <div className="sm:col-span-3">
                    <label className="block text-xs text-slate-500 mb-1">适用日</label>
                    <Select
                      value={d.day_type}
                      onChange={(e) =>
                        setDrafts((prev) => prev.map((p, i) => (i === idx ? { ...p, day_type: e.target.value } : p)))
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
                        setDrafts((prev) => prev.map((p, i) => (i === idx ? { ...p, start: e.target.value } : p)))
                      }
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-slate-500 mb-1">结束</label>
                    <Input
                      value={d.end}
                      placeholder="24:00 / 02:00"
                      onChange={(e) =>
                        setDrafts((prev) => prev.map((p, i) => (i === idx ? { ...p, end: e.target.value } : p)))
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
                        setDrafts((prev) => prev.map((p, i) => (i === idx ? { ...p, multiplier: e.target.value } : p)))
                      }
                    />
                  </div>
                  <div className="sm:col-span-2 flex items-center gap-2">
                    <label className="flex items-center gap-1 text-xs text-slate-500">
                      <input
                        type="checkbox"
                        checked={d.enabled}
                        onChange={(e) =>
                          setDrafts((prev) => prev.map((p, i) => (i === idx ? { ...p, enabled: e.target.checked } : p)))
                        }
                      />
                      启用
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== idx))}
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
                setDrafts((prev) => [...prev, { day_type: "weekday", start: "20:00", end: "24:00", multiplier: "2", enabled: true }])
              }
            >
              添加时段
            </Button>
            <p className="text-xs text-slate-400">
              结束时间早于开始时间表示跨午夜（如 22:00 → 02:00）。具体某天的时段优先于「工作日/周末」分组；
              同优先级重叠时，开始时间更晚的时段胜出。
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
