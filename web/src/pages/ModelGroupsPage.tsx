import { useCallback, useMemo, useState, type FormEvent } from "react";
import { useModelCategories, ModelCategoryAssignment, ModelCategoryBadges, ModelCategoryFilter, matchesModelCategory, CATEGORY_RENAME_HELP } from "../components/ModelCategories";
import { api, ApiError } from "../api/client";
import { ModelCatalogVisibility, ModelCatalogVisibilityBadge, setCatalogVisible } from "../components/ModelCatalogVisibility";
import type { ModelGroupItem, ModelItem } from "../types";
import { Badge, Button, Card, Empty, Input, Modal, Select, Spinner, Textarea } from "../components/ui";
import { IconEdit, IconModels, IconPlus, IconTrash } from "../components/icons";
import { useToast } from "../components/Toast";
import { useQuery, invalidateCache } from "../hooks/useQuery";

import { parseModelTypeConfig, resolvedModelType, validateModelBilling, videoReferenceConfirmation, EMBEDDING_HELP, VIDEO_HELP } from "../utils/modelType";

interface Draft {
  name: string;
  display_name: string;
  description: string;
  pricing_mode: "unset" | "free" | "priced";
  input_price_per_m: string;
  output_price_per_m: string;
  cache_read_price_per_m: string;
  cache_write_price_per_m: string;
  billing_unit: "token" | "call";
  price_per_call: string;
  search_price_per_call: string;
  cache_enabled: boolean;
  cache_ttl: string;
  peak_pricing_enabled: boolean;
  enabled: boolean;
  model_public: boolean;
  config_json: string;
  member_retries: string;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  display_name: "",
  description: "",
  pricing_mode: "priced",
  input_price_per_m: "0",
  output_price_per_m: "0",
  cache_read_price_per_m: "0",
  cache_write_price_per_m: "0",
  billing_unit: "token",
  price_per_call: "0",
  search_price_per_call: "0",
  cache_enabled: false,
  cache_ttl: "3600",
  peak_pricing_enabled: false,
  enabled: true,
  model_public: false,
  config_json: "",
  member_retries: "0",
};

function draftFrom(group: ModelGroupItem): Draft {
  return {
    name: group.name,
    display_name: group.display_name || "",
    description: group.description || "",
    pricing_mode: group.pricing_mode || "unset",
    input_price_per_m: String(group.input_price_per_m ?? 0),
    output_price_per_m: String(group.output_price_per_m ?? 0),
    cache_read_price_per_m: String(group.cache_read_price_per_m ?? 0),
    cache_write_price_per_m: String(group.cache_write_price_per_m ?? 0),
    billing_unit: group.billing_unit === "call" ? "call" : "token",
    price_per_call: String(group.price_per_call ?? 0),
    search_price_per_call: String(group.search_price_per_call ?? 0),
    cache_enabled: Boolean(group.cache_enabled),
    cache_ttl: String(group.cache_ttl ?? 3600),
    peak_pricing_enabled: Boolean(group.peak_pricing_enabled),
    enabled: Boolean(group.enabled),
    model_public: Boolean(group.model_public),
    config_json: group.config_json || "",
    member_retries: (() => {
      try {
        const parsed = JSON.parse(group.config_json || "{}");
        const raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).member_retries : undefined;
        return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "0";
      } catch {
        return "0";
      }
    })(),
  };
}

function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function GroupReasoningCell({ group }: { group: ModelGroupItem }) {
  const reasoning = group.reasoning;
  if (!reasoning) return <span className="text-xs text-slate-400">—</span>;
  if (!reasoning.supported) {
    return (
      <Badge tone="slate" title="config_json.supports_reasoning = false：整组不接受推理等级">
        已关闭
      </Badge>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {reasoning.levels.map((level) => (
        <Badge key={level.effort} tone={level.effort === reasoning.default_level ? "blue" : "slate"}>
          {level.effort}
        </Badge>
      ))}
      <span className="text-[11px] text-slate-400">
        {reasoning.source === "group_levels" ? "组配置" : "默认五档"}
      </span>
    </div>
  );
}

export default function ModelGroupsPage() {
  const toast = useToast();
  const categories = useModelCategories();
  const [categoryFilter, setCategoryFilter] = useState("");
  const [categorySelection, setCategorySelection] = useState<string[]>([]);

  const fetchGroups = useCallback(async () => {
    const res = await api.get<{ items: ModelGroupItem[] }>("/api/model-groups");
    return res.items || [];
  }, []);
  const { data: groups = [], loading, refresh } = useQuery("model-groups", fetchGroups);

  const fetchModels = useCallback(async () => {
    const res = await api.get<{ items: ModelItem[] }>("/api/models");
    return res.items || [];
  }, []);
  const { data: models = [] } = useQuery("model-groups-models", fetchModels);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const [membersFor, setMembersFor] = useState<ModelGroupItem | null>(null);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [memberEnabled, setMemberEnabled] = useState<Record<string, boolean>>({});
  const [membersSaving, setMembersSaving] = useState(false);
  const [membersError, setMembersError] = useState("");

  const modelById = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);

  function openCreate() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFormError("");
    setFormOpen(true);
  }

  function openEdit(group: ModelGroupItem) {
    setEditingId(group.id);
    setDraft(draftFrom(group));
    setFormError("");
    setFormOpen(true);
  }

  function openMembers(group: ModelGroupItem) {
    setMembersFor(group);
    setMembersError("");
    setMemberIds(group.members.map((m) => m.model_id));
    const enabled: Record<string, boolean> = {};
    for (const m of group.members) enabled[m.model_id] = m.enabled !== 0;
    setMemberEnabled(enabled);
  }

  async function onSaveGroup(e: FormEvent) {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      setFormError("名称不能为空：这是调用方在 model 字段里填的名字");
      return;
    }
    let configObj: Record<string, unknown> = {};
    if (draft.config_json.trim()) {
      try {
        configObj = parseModelTypeConfig(draft.config_json);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "config_json 必须是合法的 JSON 对象");
        return;
      }
    }
    try { validateModelBilling(draft.config_json, resolvedModelType(draft.config_json, draft.billing_unit) === "video" ? "call" : draft.billing_unit); }
    catch (err) { setFormError(err instanceof Error ? err.message : "模型类型与计费单位不匹配"); return; }
    const referenceConfirmation = videoReferenceConfirmation(draft.config_json);
    if (referenceConfirmation && !confirm(referenceConfirmation)) return;
    const retries = Math.max(0, Math.min(3, Math.floor(Number(draft.member_retries) || 0)));
    if (retries > 0) configObj.member_retries = retries;
    else delete configObj.member_retries;
    setSaving(true);
    setFormError("");
    const embedding = resolvedModelType(draft.config_json, draft.billing_unit) === "embedding";
    const video = resolvedModelType(draft.config_json, draft.billing_unit) === "video";
    const payload = {
      name,
      display_name: draft.display_name.trim() || null,
      description: draft.description.trim() || null,
      pricing_mode: draft.pricing_mode,
      input_price_per_m: video ? 0 : num(draft.input_price_per_m),
      output_price_per_m: embedding ? 0 : video ? 0 : num(draft.output_price_per_m),
      cache_read_price_per_m: embedding ? 0 : video ? 0 : num(draft.cache_read_price_per_m),
      cache_write_price_per_m: embedding ? 0 : video ? 0 : num(draft.cache_write_price_per_m),
      billing_unit: video ? "call" : draft.billing_unit,
      price_per_call: embedding ? 0 : num(draft.price_per_call),
      search_price_per_call: embedding ? 0 : video ? 0 : num(draft.search_price_per_call),
      cache_enabled: !embedding && !video && draft.cache_enabled,
      cache_ttl: Math.max(60, Math.floor(num(draft.cache_ttl) || 3600)),
      peak_pricing_enabled: draft.peak_pricing_enabled,
      enabled: draft.enabled,
      model_public: draft.model_public,
      config_json: Object.keys(configObj).length > 0 ? JSON.stringify(configObj, null, 2) : null,
    };
    try {
      if (editingId) await api.put("/api/model-groups/" + editingId, payload);
      else await api.post("/api/model-groups", payload);
      setFormOpen(false);
      invalidateCache("model-groups");
      invalidateCache("peak-pricing");
      invalidateCache("models-page-data");
      await refresh(true);
      toast.success(editingId ? "分组已更新" : "分组已创建");
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(group: ModelGroupItem) {
    if (!confirm("删除分组「" + group.name + "」？组内模型本身不会被删除，调用这个组名的请求会开始返回 404。")) return;
    try {
      await api.del("/api/model-groups/" + group.id);
      invalidateCache("model-groups");
      await refresh(true);
      toast.success("分组已删除");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "删除失败");
    }
  }

  function moveMember(index: number, delta: number) {
    setMemberIds((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  }

  function toggleMember(id: string) {
    setMemberIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
    setMemberEnabled((prev) => ({ ...prev, [id]: prev[id] !== false }));
  }

  async function onSaveMembers(e: FormEvent) {
    e.preventDefault();
    if (!membersFor) return;
    if (memberIds.length === 0) {
      setMembersError("至少要有一个成员，否则这个组名下的每次调用都必然失败");
      return;
    }
    setMembersSaving(true);
    setMembersError("");
    try {
      await api.put("/api/model-groups/" + membersFor.id + "/members", {
        members: memberIds.map((id, index) => ({
          model_id: id,
          position: index,
          enabled: memberEnabled[id] !== false,
        })),
      });
      setMembersFor(null);
      invalidateCache("model-groups");
      invalidateCache("peak-pricing");
      await refresh(true);
      toast.success("成员顺序已保存");
    } catch (err) {
      setMembersError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setMembersSaving(false);
    }
  }

  const memberFamilies = useMemo(() => {
    const families = new Set<string>();
    for (const id of memberIds) {
      const m = modelById.get(id);
      families.add(m?.provider_type === "anthropic" ? "anthropic" : "openai");
    }
    return families;
  }, [memberIds, modelById]);

  const costliestMember = useMemo(() => {
    let inMax = 0;
    let outMax = 0;
    for (const id of memberIds) {
      const m = modelById.get(id);
      if (!m) continue;
      inMax = Math.max(inMax, Number(m.input_price_per_m) || 0);
      outMax = Math.max(outMax, Number(m.output_price_per_m) || 0);
    }
    return { inMax, outMax };
  }, [memberIds, modelById]);

  const list = groups.filter(g => matchesModelCategory(categories.data, g.name, categoryFilter));

  return (
    <div className="space-y-4">
      <Card
        title="模型分组"
        action={
          <Button size="sm" onClick={openCreate}>
            <IconPlus className="w-3.5 h-3.5" /> 新建分组
          </Button>
        }
      >
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          一个组是调用方在 <code>model</code> 字段里直接填的名字，与模型完全等价：同样的价格、同样的缓存、
          同样的推理等级选项。组默认声明支持五档推理（low / medium / high / xhigh / max），成员不支持时静默退化：
          能推理的成员收到它的次高档，不能推理的成员收不到 effort、由上游用自己的默认。只有在编辑弹窗的
          <code>config_json</code> 里写 <code>{'{"supports_reasoning": false}'}</code> 才会关掉整组。
          组内成员按下面的顺序依次尝试，失败（5xx / 429 / 网络错误）就换下一个，
          4xx 直接透传——那是调用方自己的问题，换人只会重放错误并多烧一次钱。
          在 config_json 里写 <code>{'{"member_retries": 2}'}</code>（0–3，默认 0）可让每个成员
          在换下一个之前先对这类瞬时失败原地重试最多 2 次，适合时好时坏的上游。
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <ModelCategoryFilter state={categories} value={categoryFilter} onChange={setCategoryFilter} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="选择当前筛选全部模型组" checked={list.length > 0 && list.every(g => categorySelection.includes(g.id))} onChange={e => setCategorySelection(e.target.checked ? [...new Set([...categorySelection, ...list.map(g => g.id)])] : categorySelection.filter(id => !list.some(g => g.id === id)))} />选择当前筛选</label>
          <span className="text-xs text-slate-500">已选 {groups.filter(g => categorySelection.includes(g.id)).length} 个模型组</span>
          <ModelCategoryAssignment state={categories} modelNames={groups.filter(g => categorySelection.includes(g.id)).map(g => g.name)} label="批量分类" />
          <Button type="button" size="sm" variant="ghost" onClick={() => setCategorySelection([])}>清除选择</Button>
        </div>
        {loading ? (
          <Spinner text="加载分组…" />
        ) : list.length === 0 ? (
          <Empty text={categoryFilter ? "当前分类没有模型组，请切换分类筛选。" : "还没有分组。先新建一个，再把模型按顺序加进去。"} icon={<IconModels className="w-8 h-8" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <th className="py-2 pr-3">选择</th>
                  <th className="py-2 pr-3">组名</th>
                  <th className="py-2 pr-3">模型分类（公开名）</th>
                  <th className="py-2 pr-3">成员（按尝试顺序）</th>
                  <th className="py-2 pr-3">定价</th>
                  <th className="py-2 pr-3">缓存</th>
                  <th className="py-2 pr-3">推理</th>
                  <th className="py-2 pr-3">峰谷</th>
                  <th className="py-2 pr-3">状态</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {list.map((g) => (
                  <tr key={g.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2 pr-3"><input type="checkbox" aria-label={"选择模型组 " + g.name} checked={categorySelection.includes(g.id)} onChange={e => setCategorySelection(e.target.checked ? [...categorySelection, g.id] : categorySelection.filter(id => id !== g.id))} /></td>
                    <td className="py-2 pr-3">
                      <div className="font-medium text-slate-700 dark:text-slate-200">{g.name}</div>
                      <div className="text-xs text-slate-400">{g.display_name || "—"}</div>
                    </td>
                    <td className="py-2 pr-3 space-y-1"><ModelCategoryBadges data={categories.data} modelName={g.name} /><ModelCategoryAssignment state={categories} modelNames={[g.name]} /></td>
                    <td className="py-2 pr-3">
                      {g.members.length === 0 ? (
                        <Badge tone="amber">空组</Badge>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {g.members
                            .slice()
                            .sort((a, b) => a.position - b.position)
                            .map((m, i) => {
                              const providerName = m.provider_name || modelById.get(m.model_id)?.provider_name || "";
                              return (
                                <Badge
                                  key={m.model_id}
                                  tone={m.enabled === 0 ? "slate" : "blue"}
                                  title={providerName ? providerName + " · " + (m.provider_type || "") : undefined}
                                >
                                  {i + 1}. {m.model_name || m.model_id}
                                  {providerName ? (
                                    <span className="font-normal opacity-70"> · {providerName}</span>
                                  ) : null}
                                </Badge>
                              );
                            })}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1">
                        {g.pricing_mode === "priced" ? (
                          <Badge tone="green">priced</Badge>
                        ) : g.pricing_mode === "free" ? (
                          <Badge tone="blue">free</Badge>
                        ) : (
                          <Badge tone="amber">unset</Badge>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono">
                        {resolvedModelType(g.config_json, g.billing_unit) === "embedding"
                          ? `输入 ¥${g.input_price_per_m}/M · 仅输入计费`
                          : resolvedModelType(g.config_json, g.billing_unit) === "video"
                          ? `¥${g.price_per_call || 0}/成功任务次`
                          : g.billing_unit === "call"
                          ? `¥${g.price_per_call || 0}/次`
                          : `¥${g.input_price_per_m}/M · ¥${g.output_price_per_m}/M`}
                        {!["embedding", "video"].includes(resolvedModelType(g.config_json, g.billing_unit)) && g.search_price_per_call ? ` · +${g.search_price_per_call}/搜索` : ""}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-500">
                      {["embedding", "video"].includes(resolvedModelType(g.config_json, g.billing_unit)) ? "不适用" : g.cache_enabled ? "开 · " + g.cache_ttl + "s" : "关"}
                    </td>
                    <td className="py-2 pr-3">
                      <GroupReasoningCell group={g} />
                    </td>
                    <td className="py-2 pr-3">
                      {g.peak_pricing_enabled ? <Badge tone="purple">峰段涨价</Badge> : <span className="text-xs text-slate-400">未开启</span>}
                    </td>
                    <td className="py-2 pr-3">
                      {g.enabled ? <Badge tone="green" dot>启用</Badge> : <Badge tone="slate">停用</Badge>}
                      {g.model_public ? <Badge tone="blue">公开</Badge> : null}
                      <ModelCatalogVisibilityBadge configJson={g.config_json} />
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <Button variant="ghost" size="sm" onClick={() => openMembers(g)}>
                        成员
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(g)}>
                        <IconEdit className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(g)}>
                        <IconTrash className="w-3.5 h-3.5 text-rose-500" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-400">
          组名与模型名共用一套命名空间：任何一个名字被模型占用了，就不能再拿来当组名，反之亦然。两者会进同一个缓存前缀，撞名只会串答案。
        </p>
      </Card>

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editingId ? "编辑分组" : "新建分组"}
        maxWidth="max-w-2xl"
      >
        <form onSubmit={onSaveGroup} className="space-y-4">
          <div className="space-y-2 rounded-lg border border-slate-200 dark:border-slate-700 p-3"><p className="text-xs text-slate-500">{CATEGORY_RENAME_HELP}</p><ModelCategoryBadges data={categories.data} modelName={draft.name} /><ModelCategoryAssignment state={categories} modelNames={[draft.name]} disabled={!editingId || !groups.some(g => g.id === editingId && g.name === draft.name) || saving} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">组名</label>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如 coding" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">显示名</label>
              <Input
                value={draft.display_name}
                onChange={(e) => setDraft({ ...draft, display_name: e.target.value })}
                placeholder="可选，控制台里展示的名字"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">模型简介</label>
            <Input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              maxLength={200}
              placeholder="可选，显示在模型广场卡片上（200 字以内）"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">模型类型</label>
            <Select value={resolvedModelType(draft.config_json, draft.billing_unit)} onChange={(e) => {
              try {
                const config = parseModelTypeConfig(draft.config_json, false);
                const modelType = e.target.value as "text" | "image" | "embedding" | "video";
                setDraft({ ...draft, billing_unit: modelType === "image" || modelType === "video" ? "call" : modelType === "embedding" ? "token" : draft.billing_unit,
                  ...(modelType === "video" ? { input_price_per_m: "0", output_price_per_m: "0", cache_read_price_per_m: "0", cache_write_price_per_m: "0", search_price_per_call: "0", cache_enabled: false } : {}),
                  ...(modelType === "embedding" ? { cache_enabled: false, output_price_per_m: "0", cache_read_price_per_m: "0", cache_write_price_per_m: "0", price_per_call: "0", search_price_per_call: "0" } : {}),
                  config_json: JSON.stringify({ ...config, model_type: modelType, ...(modelType === "video" && !config.video ? { video: { adapter: "moyuu", task_id_path: "", sizes: [], seconds_min: 3, seconds_max: 15, failed_statuses: [] } } : {}) }, null, 2) });
              } catch (err) { setFormError(err instanceof Error ? err.message : "高级配置不是合法的 JSON 对象"); }
            }}>
              <option value="text">文本 / 推理模型</option>
              <option value="image">图片模型</option>
              <option value="embedding">向量 / Embedding 模型</option>
              <option value="video">视频模型（按成功任务次）</option>
            </Select>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">未声明类型的旧配置沿用原规则：按次为图片，其余为文本。文本类型与计费单位独立；图片仅按次，向量仅按输入 Token，视频仅按成功任务次数计费。</p>
            {resolvedModelType(draft.config_json, draft.billing_unit) === "embedding" ? <p className="mt-2 text-xs text-blue-600 dark:text-blue-400">{EMBEDDING_HELP}</p> : null}
            {resolvedModelType(draft.config_json, draft.billing_unit) === "video" ? <p className="mt-2 text-xs text-blue-600 dark:text-blue-400">{VIDEO_HELP}</p> : null}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">计费单位</label>
              <Select
                value={draft.billing_unit}
                onChange={(e) => {
                  try {
                    const config = parseModelTypeConfig(draft.config_json, false);
                    setDraft({ ...draft, billing_unit: e.target.value as "token" | "call",
                      config_json: JSON.stringify({ ...config, model_type: resolvedModelType(draft.config_json, draft.billing_unit) }, null, 2) });
                  } catch (err) { setFormError(err instanceof Error ? err.message : "config_json 不是合法的 JSON 对象"); }
                }}
              >
                <option value="token" disabled={["image", "video"].includes(resolvedModelType(draft.config_json, draft.billing_unit))}>按 Token</option>
                <option value="call" disabled={resolvedModelType(draft.config_json, draft.billing_unit) === "embedding"}>按请求次数（文本 / 推理、图片或视频）</option>
              </Select>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{resolvedModelType(draft.config_json, draft.billing_unit) === "video" ? "视频按成功任务次数收费，不按秒；未知、等待或失败状态不扣费。" : "每个成功 API 请求收一次基础费，错误或中断不收基础费。工具续接每个新的 API 请求分别计次；单个请求内部续接不重复收基础费。"}</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">{resolvedModelType(draft.config_json, draft.billing_unit) === "video" ? "成功任务价格（/成功任务次）" : "单次价格"}</label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                disabled={resolvedModelType(draft.config_json, draft.billing_unit) === "embedding"}
                value={draft.price_per_call}
                onChange={(e) => setDraft({ ...draft, price_per_call: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                联网搜索单价（/次，可选）
              </label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                disabled={["embedding", "video"].includes(resolvedModelType(draft.config_json, draft.billing_unit))}
                value={draft.search_price_per_call}
                onChange={(e) => setDraft({ ...draft, search_price_per_call: e.target.value })}
              />
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                加在组价之外，按上游真实搜索次数收，不乘峰谷倍率。留 0 表示搜索不额外收费。
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">定价模式</label>
              <Select
                value={draft.pricing_mode}
                onChange={(e) => setDraft({ ...draft, pricing_mode: e.target.value as Draft["pricing_mode"] })}
              >
                <option value="unset">unset（拒服务）</option>
                <option value="free">free（记 0 元）</option>
                <option value="priced">priced（按下面价格）</option>
              </Select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">输入价 / M</label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                disabled={resolvedModelType(draft.config_json, draft.billing_unit) === "video"}
                value={draft.input_price_per_m}
                onChange={(e) => setDraft({ ...draft, input_price_per_m: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">输出价 / M</label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                disabled={["embedding", "video"].includes(resolvedModelType(draft.config_json, draft.billing_unit))}
                value={draft.output_price_per_m}
                onChange={(e) => setDraft({ ...draft, output_price_per_m: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">缓存读价 / M</label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                disabled={["embedding", "video"].includes(resolvedModelType(draft.config_json, draft.billing_unit))}
                value={draft.cache_read_price_per_m}
                onChange={(e) => setDraft({ ...draft, cache_read_price_per_m: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">缓存写价 / M</label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                disabled={["embedding", "video"].includes(resolvedModelType(draft.config_json, draft.billing_unit))}
                value={draft.cache_write_price_per_m}
                onChange={(e) => setDraft({ ...draft, cache_write_price_per_m: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">缓存 TTL（秒）</label>
              <Input
                type="number"
                step="60"
                min="60"
                disabled={["embedding", "video"].includes(resolvedModelType(draft.config_json, draft.billing_unit))}
                value={draft.cache_ttl}
                onChange={(e) => setDraft({ ...draft, cache_ttl: e.target.value })}
              />
            </div>
          </div>

          <ModelCatalogVisibility configJson={draft.config_json} onChange={visible => setDraft(current => {
            try { return { ...current, config_json: setCatalogVisible(current.config_json, visible) }; }
            catch { return current; }  
          })} />

          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 dark:text-slate-300">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" disabled={["embedding", "video"].includes(resolvedModelType(draft.config_json, draft.billing_unit))} checked={!["embedding", "video"].includes(resolvedModelType(draft.config_json, draft.billing_unit)) && draft.cache_enabled} onChange={(e) => setDraft({ ...draft, cache_enabled: e.target.checked })} />
              启用缓存
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.peak_pricing_enabled}
                onChange={(e) => setDraft({ ...draft, peak_pricing_enabled: e.target.checked })}
              />
              峰谷定价
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
              启用
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.model_public}
                onChange={(e) => setDraft({ ...draft, model_public: e.target.checked })}
              />
              公开（无 Token 也可以列举）
            </label>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              组内重试次数 <span className="font-normal text-slate-400">（0–3，默认 0 = 失败即换下一个成员）</span>
            </label>
            <Input
              type="number"
              min="0"
              max="3"
              step="1"
              value={draft.member_retries}
              onChange={(e) => setDraft({ ...draft, member_retries: e.target.value })}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              成员遇到瞬时失败（5xx / 429 / 408 / 网络错误）时，先对<b>同一成员</b>重试至多 N 次再换下一个。
              4xx 与按次计费的组永远不重试。会自动写进下方 config_json 的 <code>member_retries</code>。
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              config_json <span className="font-normal text-slate-400">（可选，与模型的同名配置同义：capabilities、推理等级等）</span>
            </label>
            <Textarea
              rows={4}
              value={draft.config_json}
              onChange={(e) => setDraft({ ...draft, config_json: e.target.value })}
              placeholder='{"capabilities":["tool_call","reasoning"],"supported_reasoning_levels":["low","medium","high"]}'
              className="font-mono text-xs"
            />
          </div>

          {formError ? (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 p-2.5 rounded-lg">
              {formError}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button type="button" variant="secondary" onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "正在保存…" : editingId ? "保存修改" : "创建分组"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(membersFor)}
        onClose={() => setMembersFor(null)}
        title={"成员顺序 — " + (membersFor?.name || "")}
        maxWidth="max-w-2xl"
      >
        <form onSubmit={onSaveMembers} className="space-y-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            从上到下依次尝试。第一个是主选，后面的都是故障转移：只有 5xx / 429 / 网络异常才会往下走，
            4xx 直接回给调用方。取消勾选「启用」可以让一个成员暂时跳过而不删除它。
          </p>

          {membersFor && resolvedModelType(membersFor.config_json, membersFor.billing_unit) === "embedding" && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{EMBEDDING_HELP}</p>
          )}

          {memberIds.length === 0 ? (
            <Empty text="还没选成员，从下面添加" />
          ) : (
            <div className="rounded-lg border border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
              {memberIds.map((id, index) => {
                const m = modelById.get(id);
                return (
                  <div key={id} className="flex items-center gap-2 px-3 py-2">
                    <span className="w-6 shrink-0 text-xs font-mono text-slate-400">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                        {m?.display_name || m?.model_name || id}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 truncate">
                        {m?.model_name || id} · {m?.provider_name || m?.provider_type || "?"}
                      </div>
                    </div>
                    <label className="flex items-center gap-1 text-[11px] text-slate-500">
                      <input
                        type="checkbox"
                        checked={memberEnabled[id] !== false}
                        onChange={(e) => setMemberEnabled({ ...memberEnabled, [id]: e.target.checked })}
                      />
                      启用
                    </label>
                    <Button type="button" variant="ghost" size="sm" onClick={() => moveMember(index, -1)} disabled={index === 0}>
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => moveMember(index, 1)}
                      disabled={index === memberIds.length - 1}
                    >
                      ↓
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => toggleMember(id)}>
                      <IconTrash className="w-3.5 h-3.5 text-rose-500" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {memberFamilies.size > 1 ? (
            <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 p-2.5 rounded-lg">
              已选成员来自不同供应商类型，允许保存。每次请求只选择支持该入站协议的成员；供应商类型不再代表唯一协议。
            </div>
          ) : null}

          {draft.pricing_mode === "priced" &&
          (num(draft.input_price_per_m) < costliestMember.inMax || num(draft.output_price_per_m) < costliestMember.outMax) ? (
            <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 p-2.5 rounded-lg">
              组价低于某个成员的价格（成员最高 ¥{costliestMember.inMax}/M 入 · ¥{costliestMember.outMax}/M 出）。
              可以这么做，但那部分调用是亏的。
            </div>
          ) : null}

          <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">添加成员</label>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">已选 {memberIds.length}</span>
            </div>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
              {models.length === 0 ? (
                <div className="p-3 text-xs text-slate-400">还没有模型</div>
              ) : (
                models.map((m) => (
                  <div key={m.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <input
                      type="checkbox"
                      className="shrink-0 cursor-pointer"
                      checked={memberIds.includes(m.id)}
                      onChange={() => toggleMember(m.id)}
                    />
                    <label className="min-w-0 flex-1 cursor-pointer">
                      <span className="block text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                        {m.display_name || m.model_name}
                      </span>
                      <span className="block text-[11px] font-mono text-slate-400 truncate">
                        {m.model_name} · {m.provider_name || m.provider_type || "?"} · ¥{m.input_price_per_m}/M · ¥{m.output_price_per_m}/M
                      </span>
                    </label>
                  </div>
                ))
              )}
            </div>
          </div>

          {membersError ? (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 p-2.5 rounded-lg">
              {membersError}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button type="button" variant="secondary" onClick={() => setMembersFor(null)}>
              取消
            </Button>
            <Button type="submit" disabled={membersSaving}>
              {membersSaving ? "正在保存…" : "保存成员"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
