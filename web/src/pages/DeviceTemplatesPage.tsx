import { useCallback, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, fmtTime } from "../api/client";
import type { DeviceItem, DeviceTemplateItem, DeviceTemplatePreview, ModelItem, ModelGroupItem, ModelScope } from "../types";
import { Badge, Button, Card, Empty, Input, Modal, Select, Spinner } from "../components/ui";
import { IconAlertTriangle, IconEdit, IconFileText, IconPlus, IconTrash, IconUpload } from "../components/icons";
import { useToast } from "../components/Toast";
import { invalidateCache, useQuery } from "../hooks/useQuery";

import { useAdminFilters } from "../hooks/useAdminFilters";
import { AdminListToolbar } from "../components/AdminListToolbar";
const FILTERS = { q: "", sort: "", scope: "", group: "" };
const EMPTY_TEMPLATES: DeviceTemplateItem[] = [];

const SCOPE_LABELS: Record<ModelScope, string> = {
  all: "全部模型",
  list: "仅白名单",
  all_and_list: "全部 + 白名单",
};

const SCOPE_HINTS: Record<ModelScope, string> = {
  all: "套用后设备可以调用所有已启用的模型，模板里的勾选一律清空。",
  list: "套用后设备只能调用模板里勾选的模型与分组，其余一律返回 403。",
  all_and_list: "与「全部模型」相同，勾选项仅用于记录，不额外收窄权限。",
};

interface Draft {
  name: string;
  description: string;
  model_scope: ModelScope;
  model_ids: string[];
  model_rpms: Record<string, string>;
  group_ids: string[];
  group_rpms: Record<string, string>;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  description: "",
  model_scope: "list",
  model_ids: [],
  model_rpms: {},
  group_ids: [],
  group_rpms: {},
};

function draftFrom(t: DeviceTemplateItem): Draft {
  const model_rpms: Record<string, string> = {};
  for (const m of t.models) if (m.rpm > 0) model_rpms[m.model_id] = String(m.rpm);
  const group_rpms: Record<string, string> = {};
  for (const g of t.groups) if (g.rpm > 0) group_rpms[g.group_id] = String(g.rpm);
  return {
    name: t.name,
    description: t.description || "",
    model_scope: t.model_scope || "list",
    model_ids: t.models.map((m) => m.model_id),
    model_rpms,
    group_ids: t.groups.map((g) => g.group_id),
    group_rpms,
  };
}

function rpmPayload(map: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, raw] of Object.entries(map)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) out[id] = Math.floor(n);
  }
  return out;
}

export default function DeviceTemplatesPage() {
  const toast = useToast();
  const [filters, setFilter, resetFilters] = useAdminFilters(FILTERS);

  const fetchTemplates = useCallback(async () => {
    const res = await api.get<{ items: DeviceTemplateItem[] }>("/api/device-templates");
    return res.items || [];
  }, []);
  const { data: templates = EMPTY_TEMPLATES, loading, isRefreshing, error: listError, refresh } = useQuery("device-templates", fetchTemplates);

  const fetchModels = useCallback(async () => {
    const res = await api.get<{ items: ModelItem[] }>("/api/models");
    return res.items || [];
  }, []);
  const { data: models = [] } = useQuery("device-templates-models", fetchModels);

  const fetchGroups = useCallback(async () => {
    const res = await api.get<{ items: ModelGroupItem[] }>("/api/model-groups");
    return res.items || [];
  }, []);
  const { data: groups = [] } = useQuery("device-templates-groups", fetchGroups);

  const fetchDevices = useCallback(async () => {
    const res = await api.get<{ items: DeviceItem[] }>("/api/devices");
    return (res.items || []).filter((d) => !d.revoked_at);
  }, []);
  const { data: devices = [] } = useQuery("device-templates-devices", fetchDevices);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [modelFilter, setModelFilter] = useState("");

  const [applyFor, setApplyFor] = useState<DeviceTemplateItem | null>(null);
  const [applyAll, setApplyAll] = useState(false);
  const [applyIds, setApplyIds] = useState<string[]>([]);
  const [applyMode, setApplyMode] = useState<"replace" | "merge">("replace");
  const [preview, setPreview] = useState<DeviceTemplatePreview["item"] | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState("");

  const [fromDeviceOpen, setFromDeviceOpen] = useState(false);
  const [fromDeviceId, setFromDeviceId] = useState("");
  const [fromDeviceName, setFromDeviceName] = useState("");
  const [fromDeviceBusy, setFromDeviceBusy] = useState(false);

  const enabledModels = useMemo(() => models.filter((m) => m.enabled), [models]);

  function openCreate() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setModelFilter("");
    setFormError("");
    setFormOpen(true);
  }

  function openEdit(t: DeviceTemplateItem) {
    setEditingId(t.id);
    setDraft(draftFrom(t));
    setModelFilter("");
    setFormError("");
    setFormOpen(true);
  }

  function toggleModel(id: string) {
    setDraft((d) => ({
      ...d,
      model_ids: d.model_ids.includes(id) ? d.model_ids.filter((x) => x !== id) : [...d.model_ids, id],
    }));
  }

  function toggleGroup(id: string) {
    setDraft((d) => ({
      ...d,
      group_ids: d.group_ids.includes(id) ? d.group_ids.filter((x) => x !== id) : [...d.group_ids, id],
    }));
  }

  function setRpm(kind: "model" | "group", id: string, value: string) {
    setDraft((d) =>
      kind === "model"
        ? { ...d, model_rpms: { ...d.model_rpms, [id]: value } }
        : { ...d, group_rpms: { ...d.group_rpms, [id]: value } }
    );
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      setFormError("模板名称不能为空");
      return;
    }
    if (draft.model_scope !== "all" && draft.model_ids.length === 0 && draft.group_ids.length === 0) {
      setFormError("受限模式下至少需要勾选一个模型或一个分组，或把模型范围设为「全部模型」");
      return;
    }

    const payload = {
      name,
      description: draft.description.trim() || null,
      model_scope: draft.model_scope,
      model_ids: draft.model_scope === "all" ? [] : draft.model_ids,
      model_rpms: draft.model_scope === "all" ? {} : rpmPayload(draft.model_rpms),
      group_ids: draft.model_scope === "all" ? [] : draft.group_ids,
      group_rpms: draft.model_scope === "all" ? {} : rpmPayload(draft.group_rpms),
    };

    setSaving(true);
    setFormError("");
    try {
      if (editingId) await api.put(`/api/device-templates/${editingId}`, payload);
      else await api.post("/api/device-templates", payload);
      invalidateCache("device-templates");
      await refresh(true);
      setFormOpen(false);
      toast.success(editingId ? "模板已更新" : "模板已创建");
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(t: DeviceTemplateItem) {
    const ok = confirm(`删除模板「${t.name}」？\n已经套用过的设备会保留它们当前的白名单，不会被清空。`);
    if (!ok) return;
    try {
      await api.del(`/api/device-templates/${t.id}`);
      invalidateCache("device-templates");
      await refresh(true);
      toast.success("模板已删除");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "删除失败");
    }
  }

  function openApply(t: DeviceTemplateItem) {
    setApplyFor(t);
    setApplyAll(false);
    setApplyIds([]);
    setApplyMode("replace");
    setPreview(null);
    setApplyError("");
  }

  const applyBody = () => ({
    device_ids: applyAll ? "all" : applyIds,
    mode: applyMode,
  });

  function applyErrorMessage(err: unknown, fallback: string) {
    if (!(err instanceof ApiError)) return fallback;
    switch (err.message) {
      case "too_many_statements":
        return "这次套用要改的设备太多，超过单次上限，请分批勾选设备再套用";
      case "no_targets":
        return "没有可套用的设备";
      case "unknown_device_ids":
        return "选中的设备里有已经不存在的，请刷新后重新选择";
      case "device_revoked":
        return "选中的设备里有已撤销的，撤销的设备不能套用模板";
      default:
        return err.message;
    }
  }

  async function onPreview() {
    if (!applyFor) return;
    if (!applyAll && applyIds.length === 0) {
      setApplyError("先选择要套用的设备，或勾选「全部设备」");
      return;
    }
    setApplyBusy(true);
    setApplyError("");
    try {
      const res = await api.post<DeviceTemplatePreview>(
        `/api/device-templates/${applyFor.id}/preview`,
        applyBody()
      );
      setPreview(res.item);
    } catch (err) {
      setPreview(null);
      setApplyError(applyErrorMessage(err, "预览失败"));
    } finally {
      setApplyBusy(false);
    }
  }

  async function onApply() {
    if (!applyFor) return;
    if (!applyAll && applyIds.length === 0) {
      setApplyError("先选择要套用的设备，或勾选「全部设备」");
      return;
    }
    setApplyBusy(true);
    setApplyError("");
    try {
      const res = await api.post<{ applied: number }>(
        `/api/device-templates/${applyFor.id}/apply`,
        applyBody()
      );
      invalidateCache("device-templates");
      invalidateCache("devices-list");
      await refresh(true);
      setApplyFor(null);
      setPreview(null);
      toast.success(`已套用到 ${res.applied} 台设备`);
    } catch (err) {
      setApplyError(applyErrorMessage(err, "套用失败"));
    } finally {
      setApplyBusy(false);
    }
  }

  async function onSaveFromDevice(e: FormEvent) {
    e.preventDefault();
    if (!fromDeviceId) {
      toast.error("先选择一台设备");
      return;
    }
    setFromDeviceBusy(true);
    try {
      const q = fromDeviceName.trim() ? `?name=${encodeURIComponent(fromDeviceName.trim())}` : "";
      await api.post(`/api/device-templates/from-device/${fromDeviceId}${q}`);
      invalidateCache("device-templates");
      await refresh(true);
      setFromDeviceOpen(false);
      setFromDeviceId("");
      setFromDeviceName("");
      toast.success("已存为模板");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setFromDeviceBusy(false);
    }
  }

  const grantGroups = useMemo(() => Array.from(new Map(templates.flatMap(t => t.groups.map(g => [g.group_id, g.display_name || g.name || g.group_id] as const)))).sort((a, b) => a[1].localeCompare(b[1])), [templates]);
  const visibleTemplates = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const result = templates.filter(t => (!q || [t.name, t.description, ...t.models.flatMap(m => [m.model_name, m.display_name]), ...t.groups.flatMap(g => [g.name, g.display_name])].some(v => v?.toLowerCase().includes(q)))
      && (!filters.scope || t.model_scope === filters.scope)
      && (!filters.group || t.groups.some(g => g.group_id === filters.group)));
    if (filters.sort) result.sort((a, b) => (a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) * (filters.sort === "name-desc" ? -1 : 1));
    return result;
  }, [templates, filters]);

  if (loading && !templates.length) return <Spinner text="正在加载设备模板…" />;

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">账户模板</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            把一份「能调用哪些模型」的名单存成模板，一次套用到多个账户。不会改账户的余额和限额。
          </p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <Button variant="secondary" onClick={() => setFromDeviceOpen(true)} className="flex-1 sm:flex-none">
            <IconFileText />
            <span>从设备保存</span>
          </Button>
          <Button onClick={openCreate} className="shadow-sm flex-1 sm:flex-none">
            <IconPlus />
            <span>新建模板</span>
          </Button>
        </div>
      </div>

      <div className="[&_[aria-label=启用状态]]:hidden">
      <AdminListToolbar filters={filters} onChange={setFilter} onReset={resetFilters} total={templates.length} count={visibleTemplates.length} loading={loading || isRefreshing} error={listError?.message} onRefresh={() => { void refresh(); }} searchPlaceholder="搜索模板 / 授权模型 / 分组（勿输入密钥）">
        <Select aria-label="模板范围" className="!w-auto" value={filters.scope} onChange={e => setFilter("scope", e.target.value)}><option value="">全部模型范围</option>{Object.entries(SCOPE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select>
        <Select aria-label="授权模型分组" className="!w-auto" value={filters.group} onChange={e => setFilter("group", e.target.value)}><option value="">全部授权模型分组</option>{grantGroups.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select>
      </AdminListToolbar>
      </div>
      <p className="text-xs text-slate-400">模板没有启停状态或服务分组归属；状态条件不适用。刷新仅更新列表，不重置编辑草稿或套用目标。</p>
      <Card>
        {visibleTemplates.length ? (
          <div className="overflow-x-auto -mx-4 -my-4 sm:mx-0 sm:my-0">
            <table className="w-full text-left text-xs sm:text-sm min-w-[640px]">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 dark:text-slate-500 font-medium">
                  <th className="pb-3 px-3 whitespace-nowrap">模板名称</th>
                  <th className="pb-3 px-2 whitespace-nowrap">模型范围</th>
                  <th className="pb-3 px-2 whitespace-nowrap">授权内容</th>
                  <th className="pb-3 px-2 whitespace-nowrap">已套用设备</th>
                  <th className="pb-3 px-2 whitespace-nowrap">更新时间</th>
                  <th className="pb-3 px-3 text-right whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {visibleTemplates.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/50 transition-colors">
                    <td className="py-3 px-3">
                      <div className="font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">{t.name}</div>
                      {t.description ? (
                        <div className="text-[11px] text-slate-400 dark:text-slate-500 max-w-[260px] truncate">{t.description}</div>
                      ) : null}
                    </td>
                    <td className="py-3 px-2">
                      <Badge tone={t.model_scope === "all" ? "slate" : "blue"}>
                        {SCOPE_LABELS[t.model_scope] || t.model_scope}
                      </Badge>
                    </td>
                    <td className="py-3 px-2">
                      {t.model_scope === "all" ? (
                        <span className="text-slate-400 dark:text-slate-500">不限（不记录勾选）</span>
                      ) : (
                        <div className="flex flex-wrap gap-1 max-w-[320px]">
                          {t.models.slice(0, 4).map((m) => (
                            <Badge key={m.model_id} tone="blue">
                              {(m.display_name || m.model_name || m.model_id) + (m.rpm > 0 ? ` · ${m.rpm}/min` : "")}
                            </Badge>
                          ))}
                          {t.models.length > 4 ? <Badge tone="slate">+{t.models.length - 4}</Badge> : null}
                          {t.groups.map((g) => (
                            <Badge key={g.group_id} tone="purple">
                              {(g.display_name || g.name || g.group_id) + (g.rpm > 0 ? ` · ${g.rpm}/min` : "")}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-2 whitespace-nowrap text-slate-600 dark:text-slate-300">
                      {t.device_count || 0} 台
                    </td>
                    <td className="py-3 px-2 whitespace-nowrap text-slate-500 dark:text-slate-400">
                      {fmtTime(t.updated_at || t.created_at)}
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openApply(t)} title="套用到设备">
                          <IconUpload />
                          <span>套用</span>
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(t)} title="编辑">
                          <IconEdit />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => onDelete(t)} title="删除">
                          <IconTrash />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text={listError && !templates.length ? "模板列表加载失败，请重试" : templates.length ? "没有符合筛选条件的模板" : "还没有设备模板（新建一个，或从现有设备保存一份）"} icon={<IconFileText />} />
        )}
      </Card>

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editingId ? "编辑模板" : "新建模板"}
        maxWidth="max-w-2xl"
      >
        <form onSubmit={onSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">模板名称</label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="例如：实习生只读"
                maxLength={100}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">备注（可选）</label>
              <Input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="这份模板给谁用"
                maxLength={500}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-2">模型范围</label>
            <div className="space-y-2">
              {(Object.keys(SCOPE_LABELS) as ModelScope[]).map((scope) => (
                <label
                  key={scope}
                  className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <input
                    type="radio"
                    name="model_scope"
                    checked={draft.model_scope === scope}
                    onChange={() => setDraft({ ...draft, model_scope: scope })}
                    className="mt-0.5 accent-indigo-600"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">{SCOPE_LABELS[scope]}</span>
                    <span className="block text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">{SCOPE_HINTS[scope]}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className={draft.model_scope === "all" ? "opacity-50 pointer-events-none" : ""}>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                模型（{draft.model_ids.length} 已选）
              </label>
              <Input
                value={modelFilter}
                onChange={(e) => setModelFilter(e.target.value)}
                placeholder="筛选模型…"
                className="max-w-[180px]"
              />
            </div>
            <div className="max-h-56 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
              {enabledModels
                .filter((m) => {
                  const q = modelFilter.trim().toLowerCase();
                  if (!q) return true;
                  return [m.model_name, m.display_name, m.alias]
                    .filter(Boolean)
                    .some((v) => String(v).toLowerCase().includes(q));
                })
                .map((m) => {
                  const checked = draft.model_ids.includes(m.id);
                  return (
                    <div key={m.id} className="flex items-center gap-2 px-2.5 py-1.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleModel(m.id)}
                        className="accent-indigo-600"
                      />
                      <span className="flex-1 min-w-0 text-xs text-slate-700 dark:text-slate-200 truncate">
                        {m.display_name || m.model_name}
                      </span>
                      <Input
                        value={draft.model_rpms[m.id] || ""}
                        onChange={(e) => setRpm("model", m.id, e.target.value)}
                        placeholder="不限"
                        disabled={!checked}
                        className="w-20 text-xs"
                      />
                    </div>
                  );
                })}
              {enabledModels.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-slate-400 dark:text-slate-500">没有可选的模型</div>
              ) : null}
            </div>
          </div>

          <div className={draft.model_scope === "all" ? "opacity-50 pointer-events-none" : ""}>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-2">
              分组（{draft.group_ids.length} 已选）
            </label>
            {groups.length ? (
              <div className="max-h-40 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
                {groups.map((g) => {
                  const checked = draft.group_ids.includes(g.id);
                  return (
                    <div key={g.id} className="flex items-center gap-2 px-2.5 py-1.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleGroup(g.id)}
                        className="accent-indigo-600"
                      />
                      <span className="flex-1 min-w-0 text-xs text-slate-700 dark:text-slate-200 truncate">
                        {g.display_name || g.name}
                      </span>
                      <Badge tone="purple">分组</Badge>
                      <Input
                        value={draft.group_rpms[g.id] || ""}
                        onChange={(e) => setRpm("group", g.id, e.target.value)}
                        placeholder="不限"
                        disabled={!checked}
                        className="w-20 text-xs"
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-[11px] text-slate-400 dark:text-slate-500">还没有模型分组。</p>
            )}
          </div>

          {formError ? (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 p-2.5 rounded-lg">
              {formError}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button type="button" variant="ghost" onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(applyFor)}
        onClose={() => setApplyFor(null)}
        title={applyFor ? `套用模板：${applyFor.name}` : "套用模板"}
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-2">套用方式</label>
            <div className="space-y-2">
              <label className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <input
                  type="radio"
                  name="apply_mode"
                  checked={applyMode === "replace"}
                  onChange={() => {
                    setApplyMode("replace");
                    setPreview(null);
                  }}
                  className="mt-0.5 accent-indigo-600"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">替换（默认）</span>
                  <span className="block text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                    设备原有的白名单被模板完全覆盖，模板里没有的模型会被收回。
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <input
                  type="radio"
                  name="apply_mode"
                  checked={applyMode === "merge"}
                  onChange={() => {
                    setApplyMode("merge");
                    setPreview(null);
                  }}
                  className="mt-0.5 accent-indigo-600"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">合并</span>
                  <span className="block text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                    只增加不删除：设备已有的授权保留，模板的授权叠加进去，同名取更大的每分钟上限。范围只会收窄
                    （受限模板会把「全部模型」设备改成受限）。
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                目标设备（{applyAll ? "全部" : `${applyIds.length} 已选`}）
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={applyAll}
                  onChange={(e) => {
                    setApplyAll(e.target.checked);
                    setPreview(null);
                  }}
                  className="accent-indigo-600"
                />
                <span>全部设备</span>
              </label>
            </div>
            <div className="max-h-48 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
              {devices.map((d) => (
                <label key={d.id} className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={applyAll}
                    checked={applyAll || applyIds.includes(d.id)}
                    onChange={() => {
                      setPreview(null);
                      setApplyIds((ids) => (ids.includes(d.id) ? ids.filter((x) => x !== d.id) : [...ids, d.id]));
                    }}
                    className="accent-indigo-600"
                  />
                  <span className="flex-1 min-w-0 text-xs text-slate-700 dark:text-slate-200 truncate">{d.name}</span>
                  <Badge tone={d.model_scope === "all" ? "slate" : "blue"}>
                    {SCOPE_LABELS[d.model_scope || "all"]}
                  </Badge>
                </label>
              ))}
              {devices.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-slate-400 dark:text-slate-500">没有可套用的设备</div>
              ) : null}
            </div>
          </div>

          {preview ? (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-600 dark:text-slate-300 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  目标 <strong>{preview.device_count}</strong> 台
                </span>
                <span>
                  模型 <strong>{preview.model_grants}</strong> 项
                </span>
                <span>
                  分组 <strong>{preview.group_grants}</strong> 项
                </span>
                {preview.scope_change_count > 0 ? (
                  <Badge tone="amber">{preview.scope_change_count} 台的范围会变</Badge>
                ) : null}
                {preview.statements > preview.statement_limit ? (
                  <Badge tone="red">
                    语句 {preview.statements} 条，超过单次上限 {preview.statement_limit} 条，套用会被拒绝
                  </Badge>
                ) : null}
              </div>
              <div className="max-h-48 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                {preview.items.map((row) => (
                  <div key={row.device_id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="flex-1 min-w-0 text-slate-700 dark:text-slate-200 truncate">{row.name}</span>
                    {row.revoked ? <Badge tone="red">已撤销</Badge> : null}
                    {row.from_scope === row.to_scope ? (
                      <span className="text-slate-400 dark:text-slate-500">{SCOPE_LABELS[row.to_scope]}</span>
                    ) : (
                      <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <IconAlertTriangle />
                        <span>
                          {SCOPE_LABELS[row.from_scope]} → {SCOPE_LABELS[row.to_scope]}
                        </span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {applyError ? (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 p-2.5 rounded-lg">
              {applyError}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button type="button" variant="ghost" onClick={() => setApplyFor(null)}>
              取消
            </Button>
            <Button type="button" variant="secondary" onClick={onPreview} disabled={applyBusy}>
              预览影响
            </Button>
            <Button type="button" onClick={onApply} disabled={applyBusy}>
              {applyBusy ? "处理中…" : "确认套用"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={fromDeviceOpen}
        onClose={() => setFromDeviceOpen(false)}
        title="从设备保存为模板"
        maxWidth="max-w-lg"
      >
        <form onSubmit={onSaveFromDevice} className="space-y-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            把某台设备当前的白名单（含每模型 / 每分组的每分钟上限）另存为一份模板，之后可以套用到其他设备。
            限速与月限额不会被复制。
          </p>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">来源设备</label>
            <Select value={fromDeviceId} onChange={(e) => setFromDeviceId(e.target.value)}>
              <option value="">请选择…</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}（{SCOPE_LABELS[d.model_scope || "all"]}）
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              模板名称（留空则用「设备名 + 的模板」）
            </label>
            <Input
              value={fromDeviceName}
              onChange={(e) => setFromDeviceName(e.target.value)}
              placeholder="例如：实习生只读"
              maxLength={100}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button type="button" variant="ghost" onClick={() => setFromDeviceOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={fromDeviceBusy}>
              {fromDeviceBusy ? "保存中…" : "保存为模板"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}