import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useModelCategories, ModelCategoryAssignment, ModelCategoryBadges, ModelCategoryFilter, matchesModelCategory, CATEGORY_RENAME_HELP } from "../components/ModelCategories";
import { api } from "../api/client";
import { useAdminFilters } from "../hooks/useAdminFilters";
import { AdminListToolbar } from "../components/AdminListToolbar";
import { invalidateCache } from "../hooks/useQuery";
import { ServiceModelNamesPanel } from "../components/ServiceModelNamesPanel";
import { ModelGroupMergePanel } from "../components/ModelGroupMergePanel";
import type { DeviceItem, ModelGroupItem, ModelItem } from "../types";
import { Badge, Button, Card, Input, Select, Spinner, Textarea } from "../components/ui";
import { useToast } from "../components/Toast";

interface Mapping {
  id?: string;
  model_key: string;
  target_type: "model" | "group";
  target_id: string;
  member_ids: string[] | null;
  pricing: Record<string, unknown> | null;
}
interface ServiceGroup {
  id: string;
  name: string;
  description: string | null;
  public_selectable: boolean | number;
  selectable: boolean | number;
  enabled: boolean | number;
  multiplier: number;
  models?: Array<Omit<Mapping, "member_ids" | "pricing"> & { member_ids_json: string | string[] | null; pricing_json: string | Record<string, unknown> | null }>;
  device_ids?: string[];
}
interface Draft {
  name: string;
  description: string;
  public_selectable: boolean;
  selectable: boolean;
  enabled: boolean;
  multiplier: string;
}
const blank: Draft = { name: "", description: "", public_selectable: false, selectable: true, enabled: true, multiplier: "1" };
const priceFields = [
  ["input_price_per_m", "输入 / 百万 Token"], ["output_price_per_m", "输出 / 百万 Token"],
  ["cache_read_price_per_m", "缓存读取 / 百万 Token"], ["cache_write_price_per_m", "缓存写入 / 百万 Token"],
  ["price_per_call", "每次调用"], ["search_price_per_call", "每次联网搜索"],
] as const;
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1 text-xs text-slate-500 dark:text-slate-400"><span>{label}</span>{children}</label>;
}
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />{label}</label>;
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }

export default function ServiceGroupsPage() {
  const toast = useToast();
  const categories = useModelCategories();
  const [categoryFilter, setCategoryFilter] = useState("");
  const [categorySelection, setCategorySelection] = useState<string[]>([]);
  const [filters, setFilter, resetFilters] = useAdminFilters({ q: "", enabled: "", sort: "", public: "", selectable: "", target: "" });
  const [groups, setGroups] = useState<ServiceGroup[]>([]);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [modelGroups, setModelGroups] = useState<ModelGroupItem[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [grants, setGrants] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [accountFilter, setAccountFilter] = useState("");

  const [loadError, setLoadError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number>();
  const loadSequence = useRef(0);
  async function load(includeOptions = false) {
    const sequence = ++loadSequence.current;
    setLoading(true); setLoadError("");
    try {
      const [sg, options] = await Promise.all([
        api.get<{ items: ServiceGroup[] }>("/api/service-groups"),
        includeOptions ? Promise.all([
          api.get<{ items: ModelItem[] }>("/api/models"),
          api.get<{ items: ModelGroupItem[] }>("/api/model-groups"),
          api.get<{ items: DeviceItem[] }>("/api/devices/choices"),
        ]) : undefined,
      ]);
      if (sequence !== loadSequence.current) return;
      setGroups(sg.items);
      if (options) { setModels(options[0].items); setModelGroups(options[1].items); setDevices(options[2].items); }
      setUpdatedAt(Date.now());
      return sg.items;
    } catch (err) { if (sequence === loadSequence.current) setLoadError(errorMessage(err)); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }
  useEffect(() => { void load(true); return () => { loadSequence.current++; }; }, []);
  const filteredGroups = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const result = groups.filter(g => (!filters.enabled || !!g.enabled === (filters.enabled === "1")) &&
      (!filters.public || !!g.public_selectable === (filters.public === "1")) &&
      (!filters.selectable || !!g.selectable === (filters.selectable === "1")) &&
      (!filters.target || g.models?.some(m => m.target_type === filters.target)) &&
      (!q || [g.id, g.name, g.description, ...(g.models ?? []).flatMap(m => [m.model_key, m.target_id])].some(value => value?.toLowerCase().includes(q))));
    if (filters.sort) result.sort((a, b) => (a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) * (filters.sort === "name-desc" ? -1 : 1));
    return result;
  }, [groups, filters]);
  function invalidateRelated() {
    invalidateCache("admin-service-groups");
    invalidateCache("devices-");
    invalidateCache("dashboard-");
  }

  function open(group: ServiceGroup | null) {
    setSelected(group?.id ?? null); setError(""); setCategorySelection([]); setCategoryFilter("");
    setDraft(group ? { name: group.name, description: group.description ?? "", public_selectable: !!group.public_selectable,
      selectable: !!group.selectable, enabled: !!group.enabled, multiplier: String(group.multiplier) } : { ...blank });
    setMappings((group?.models ?? []).map(m => ({ id: m.id, model_key: m.model_key, target_type: m.target_type, target_id: m.target_id,
      member_ids: typeof m.member_ids_json === "string" ? JSON.parse(m.member_ids_json) : m.member_ids_json,
      pricing: typeof m.pricing_json === "string" ? JSON.parse(m.pricing_json) : m.pricing_json })));
    setGrants([...(group?.device_ids ?? [])]);
  }
  function patch(index: number, update: Partial<Mapping>) {
    setMappings(rows => rows.map((row, i) => i === index ? { ...row, ...update } : row));
  }
  async function saveGroup(event: FormEvent) {
    event.preventDefault();
    const multiplier = Number(draft.multiplier);
    if (!draft.name.trim() || !draft.multiplier.trim() || !Number.isFinite(multiplier) || multiplier < 0) {
      setError("请填写名称及非负、有限的倍率"); return;
    }
    setBusy(true); setError("");
    try {
      const body = { name: draft.name.trim(), description: draft.description.trim() || null, multiplier,
        public_selectable: Number(draft.public_selectable), selectable: Number(draft.selectable), enabled: Number(draft.enabled) };
      if (selected) await api.put("/api/service-groups/" + encodeURIComponent(selected), body);
      else {
        const result = await api.post<{ item: ServiceGroup }>("/api/service-groups", body);
        open(result.item);
      }
      invalidateRelated(); toast.success("服务分组已保存"); await load();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  async function saveSection(section: "models" | "accounts") {
    if (!selected) return;
    if (section === "models") {
      const keys = mappings.map(m => m.model_key.trim());
      if (keys.some(k => !k) || new Set(keys).size !== keys.length || mappings.some(m => !m.target_id)) {
        setError("每条映射需填写唯一的模型调用名并选择目标"); return;
      }
    }
    if (section === "models" && mappings.some(m => (m.member_ids !== null && (!m.member_ids.length || m.member_ids.some(id => !id.trim()) || new Set(m.member_ids).size !== m.member_ids.length)) || (m.pricing !== null && priceFields.some(([key]) => typeof m.pricing?.[key] !== "number" || !Number.isFinite(m.pricing[key]) || Number(m.pricing[key]) < 0)))) {
      setError("成员列表不可为空或重复；覆盖价格需填写全部六项非负有限数值"); return;
    }
    setBusy(true); setError("");
    try {
      await api.put("/api/service-groups/" + encodeURIComponent(selected) + "/" + section,
        section === "models" ? { models: mappings.map(m => ({ ...(m.id ? { id: m.id } : {}), model_key: m.model_key.trim(), target_type: m.target_type, target_id: m.target_id, pricing_json: m.pricing, member_ids_json: m.member_ids })) } : { device_ids: grants });
      invalidateRelated(); toast.success(section === "models" ? "模型映射已保存" : "账户授权已保存"); await load();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  async function deleteGroup() {
    if (!selected || !window.confirm("确定删除此服务分组？已绑定账户或 Token 的分组无法删除。")) return;
    setBusy(true); setError("");
    try { await api.del("/api/service-groups/" + encodeURIComponent(selected)); open(null); invalidateRelated(); await load(); toast.success("服务分组已删除"); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  const chosenGroup = groups.find(g => g.id === selected);
  const categoryMappingId = (m: Mapping) => chosenGroup?.models?.find(saved => saved.model_key === m.model_key && (!m.id || saved.id === m.id))?.id;
  return <div className="space-y-5">
    <div className="flex items-start justify-between gap-3"><div><h1 className="text-xl font-semibold">服务分组</h1><p className="mt-1 text-sm text-slate-500">服务分组决定用户能看到哪些模型、按什么价格调用。公开分组所有账户可选；私有分组要给账户授权。</p></div><Button variant="secondary" disabled={busy || loading} onClick={() => void load(true)}>刷新列表</Button></div>
    {error && <div role="alert" className="rounded-lg bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-600">{error}</div>}
    <AdminListToolbar filters={filters} onChange={setFilter} onReset={resetFilters} total={groups.length} count={filteredGroups.length} loading={loading} error={loadError ? "读取失败：" + loadError + "；如有旧数据仍予保留" : null} searchPlaceholder="搜索服务分组 / 公开模型名 / 目标 ID">
      <Select aria-label="公开范围" className="!w-auto" value={filters.public} onChange={e => setFilter("public", e.target.value)}><option value="">公开与私有</option><option value="1">公开</option><option value="0">私有</option></Select>
      <Select aria-label="可自选状态" className="!w-auto" value={filters.selectable} onChange={e => setFilter("selectable", e.target.value)}><option value="">全部自选状态</option><option value="1">可自选</option><option value="0">不可自选</option></Select>
      <Select aria-label="映射目标类型" className="!w-auto" value={filters.target} onChange={e => setFilter("target", e.target.value)}><option value="">全部目标类型</option><option value="group">模型组</option><option value="model">供应商模型</option></Select>
    </AdminListToolbar>
    {updatedAt && <p className="text-xs text-slate-500">上次成功更新：{new Date(updatedAt).toLocaleTimeString()} · 刷新列表不会覆盖编辑草稿</p>}
    {loading && !groups.length && <Spinner text="正在读取服务分组…" />}
    <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card title="分组列表" action={<Button size="sm" disabled={busy} onClick={() => open(null)}>新建</Button>}>
        <div className="space-y-2">{filteredGroups.length === 0 && !loading && !loadError && <p className="text-sm text-slate-500">{groups.length ? "无匹配服务分组，请调整筛选" : "暂无服务分组"}</p>}{filteredGroups.map(g => <button type="button" disabled={busy} key={g.id} onClick={() => open(g)} className={"w-full rounded-lg border p-3 text-left " + (selected === g.id ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30" : "border-slate-200 dark:border-slate-700")}>
          <div className="font-medium break-all">{g.name}</div><div className="mt-1 flex flex-wrap gap-1"><Badge tone={g.enabled ? "green" : "slate"}>{g.enabled ? "启用" : "停用"}</Badge><Badge>{g.public_selectable ? "公开" : "私有"}</Badge><Badge>{g.selectable ? "可自选" : "不可自选"}</Badge><span className="text-xs text-slate-500">{g.models?.length ?? 0} 条映射</span><span className="text-xs text-slate-500">× {g.multiplier}</span></div>
        </button>)}</div>
      </Card>
      <div className="min-w-0 space-y-5">
        <Card title={selected ? "编辑：" + (chosenGroup?.name ?? draft.name) : "新建服务分组"}>
          <form onSubmit={saveGroup} className="space-y-4"><fieldset disabled={busy || loading} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2"><Field label="名称"><Input required maxLength={100} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="计费倍率"><Input type="number" min="0" step="any" required value={draft.multiplier} onChange={e => setDraft({ ...draft, multiplier: e.target.value })} /></Field></div>
            <Field label="说明"><Textarea rows={2} maxLength={2000} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></Field>
            <div className="flex flex-wrap gap-4"><Toggle label="启用" value={draft.enabled} onChange={enabled => setDraft({ ...draft, enabled })} /><Toggle label="允许用户选择" value={draft.selectable} onChange={selectable => setDraft({ ...draft, selectable })} /><Toggle label="公开可选（否则需账户授权）" value={draft.public_selectable} onChange={public_selectable => setDraft({ ...draft, public_selectable })} /></div>
            <div className="flex gap-2"><Button type="submit">{busy ? "保存中…" : selected ? "保存分组设置" : "创建分组"}</Button>{selected && <Button type="button" variant="danger" onClick={() => void deleteGroup()}>删除分组</Button>}</div>
          </fieldset></form>
        </Card>
        {selected ? <>
          <ServiceModelNamesPanel key={selected} serviceGroupId={selected} models={(chosenGroup?.models ?? []).filter((m): m is typeof m & {id:string} => !!m.id)} onChanged={async () => { const updated=await load(); const current=updated?.find(g=>g.id===selected); if(current)open(current); categories.refresh(true); }} />
          <Card title="模型映射" action={<Button size="sm" disabled={busy || loading} onClick={() => setMappings([...mappings, { model_key: "", target_type: "model", target_id: "", member_ids: null, pricing: null }])}>添加映射</Button>}>
            <p className="mb-4 text-xs text-slate-500">模型组目标允许自定义客户端调用名：不同服务组可使用同一调用名绑定不同模型组。供应商模型目标仍需匹配模型名或别名。关闭价格覆盖时继承各自目标价格并乘服务组倍率；倍率 1 表示原价继承。开启覆盖后须填写全部六项（不修改计费单位及定价模式）。成员顺序按下方列表保存。供应商模型未指定成员时仅绑定所选目标；不同组可配置不同实际模型，请在分组说明中向用户说明。</p>
            <div className="mb-3 flex flex-wrap items-center gap-2"><ModelCategoryFilter state={categories} value={categoryFilter} onChange={setCategoryFilter} />
              <Button type="button" size="sm" variant="secondary" onClick={() => setCategorySelection(mappings.filter(m => categoryMappingId(m) && matchesModelCategory(categories.data, m.model_key, categoryFilter)).map(m => categoryMappingId(m)!))}>选择当前已保存映射</Button>
              <ModelCategoryAssignment state={categories} modelNames={mappings.filter(m => { const id = categoryMappingId(m); return id && categorySelection.includes(id); }).map(m => m.model_key)} label="批量分类" disabled={busy || loading} />
              <Button type="button" size="sm" variant="ghost" onClick={() => setCategorySelection([])}>清除选择</Button>
            </div>
            <p className="mb-3 text-xs text-slate-500">分类独立保存，按公开调用名影响所有服务组；筛选只隐藏编辑项，保存映射仍包含完整列表。{CATEGORY_RENAME_HELP}</p>
            <fieldset disabled={busy || loading} className="space-y-4">{mappings.map((m, index) => {
              if (!matchesModelCategory(categories.data, m.model_key, categoryFilter)) return null;
              const targetGroup = modelGroups.find(g => g.id === m.target_id);
              return <div key={index} className="space-y-3 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                <div className="flex items-center justify-between"><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" aria-label={"选择映射分类 " + m.model_key} disabled={!categoryMappingId(m)} checked={!!categoryMappingId(m) && categorySelection.includes(categoryMappingId(m)!)} onChange={e => { const id = categoryMappingId(m); if (id) setCategorySelection(e.target.checked ? [...categorySelection, id] : categorySelection.filter(value => value !== id)); }} />映射 {index + 1}</label><Button size="sm" variant="ghost" onClick={() => setMappings(mappings.filter((_, i) => i !== index))}>移除</Button></div>
                <div className="grid gap-3 sm:grid-cols-3"><Field label="客户端模型调用名"><Input value={m.model_key} onChange={e => patch(index, { model_key: e.target.value })} /></Field>
                  <Field label="目标类型"><Select value={m.target_type} onChange={e => patch(index, { target_type: e.target.value as Mapping["target_type"], target_id: "", member_ids: null })}><option value="model">供应商模型</option><option value="group">模型组</option></Select></Field>
                  <Field label="路由目标"><Select value={m.target_id} onChange={e => { const id = e.target.value; const model = models.find(row => row.id === id); const group = modelGroups.find(row => row.id === id); patch(index, { target_id: id, member_ids: null, ...(!m.model_key ? { model_key: m.target_type === "model" ? model?.alias || model?.model_name || "" : group?.name || "" } : {}) }); }}><option value="">请选择目标</option>{m.target_type === "model" ? models.map(row => <option key={row.id} value={row.id}>{row.provider_name || row.provider_id} / {row.display_name || row.model_name}{row.enabled ? "" : "（停用）"}</option>) : modelGroups.map(row => <option key={row.id} value={row.id}>{row.display_name || row.name}{row.enabled ? "" : "（停用）"}</option>)}{m.target_id && !(m.target_type === "model" ? models : modelGroups).some(row => row.id === m.target_id) && <option value={m.target_id}>当前目标不可用：{m.target_id}</option>}</Select></Field>
                </div>
                <div className="flex flex-wrap items-center gap-2"><ModelCategoryBadges data={categories.data} modelName={m.model_key} /><ModelCategoryAssignment state={categories} modelNames={[m.model_key]} disabled={busy || loading || !categoryMappingId(m)} /></div>
                {m.target_type === "group" && <p className="text-xs text-slate-500">继承来源：原模型组 {targetGroup?.name ?? m.target_id}；客户端调用名：{m.model_key || "（未填写）"}。{m.pricing === null ? "价格跟随该目标与服务组倍率。" : "使用独立覆盖价格。"}{m.member_ids === null ? "成员、顺序和重试配置跟随原组；变更只影响新请求。" : "使用下方指定成员顺序，重试配置继承原组。"}</p>}
                {m.target_type === "group" && <div className="space-y-2"><Toggle label="继承模型组全部成员及默认顺序" value={m.member_ids === null} onChange={inherit => patch(index, { member_ids: inherit ? null : targetGroup?.members.map(member => member.model_id) ?? [] })} />
                  {m.member_ids !== null && <><Field label="成员 ID（每行一个，首行优先；保留输入顺序）"><Textarea rows={3} value={m.member_ids.join("\n")} onChange={e => patch(index, { member_ids: e.target.value.split("\n") })} onBlur={() => patch(index, { member_ids: [...new Set((m.member_ids ?? []).map(id => id.trim()).filter(Boolean))] })} /></Field><Select aria-label="添加模型组成员" value="" onChange={e => { if (e.target.value) patch(index, { member_ids: [...(m.member_ids ?? []), e.target.value] }); }}><option value="">从模型组中添加成员…</option>{targetGroup?.members.filter(member => !m.member_ids?.includes(member.model_id)).map(member => <option key={member.model_id} value={member.model_id}>{member.provider_name} / {member.display_name || member.model_name} ({member.model_id})</option>)}</Select></>}
                </div>}
                <Toggle label="覆盖目标价格" value={m.pricing !== null} onChange={override => patch(index, { pricing: override ? Object.fromEntries(priceFields.map(([key]) => [key, 0])) : null })} />
                {m.pricing !== null && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {priceFields.map(([key, label]) => <Field key={key} label={label + "（人民币 CNY）"}><Input type="number" min="0" step="any" placeholder="必填" value={m.pricing?.[key] === undefined ? "" : String(m.pricing[key])} onChange={e => { const pricing = { ...m.pricing }; if (e.target.value === "") delete pricing[key]; else pricing[key] = Number(e.target.value); patch(index, { pricing }); }} /></Field>)}
                </div>}
              </div>;
            })}
              {categoryFilter && mappings.length > 0 && !mappings.some(m => matchesModelCategory(categories.data, m.model_key, categoryFilter)) && <p className="text-sm text-slate-500">当前分类没有映射，请切换分类筛选。</p>}
              {mappings.length === 0 && <p className="text-sm text-slate-500">暂无映射；保存空列表将清空此分组的模型映射。</p>}
              <Button onClick={() => void saveSection("models")}>保存全部模型映射</Button>
            </fieldset>
          </Card>
          <Card title="私有账户授权"><p className="mb-3 text-xs text-slate-500">公开分组无需逐个授权；私有分组仅授权账户可选择。保存会替换整个授权列表。</p><fieldset disabled={busy || loading} className="space-y-3">
            <Input aria-label="搜索账户" placeholder="搜索账户名称 / ID" value={accountFilter} onChange={e => setAccountFilter(e.target.value)} />
            <div className="max-h-64 overflow-y-auto space-y-2">{devices.filter(d => (d.name + " " + d.id).toLowerCase().includes(accountFilter.toLowerCase())).map(d => <label key={d.id} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={grants.includes(d.id)} onChange={e => setGrants(e.target.checked ? [...grants, d.id] : grants.filter(id => id !== d.id))} /><span>{d.name} <span className="text-xs text-slate-500">{d.id}{d.enabled ? "" : "（停用）"}</span></span></label>)}
              {grants.filter(id => !devices.some(d => d.id === id)).map(id => <label key={id} className="flex gap-2 text-sm"><input type="checkbox" checked onChange={() => setGrants(grants.filter(g => g !== id))} />不可用账户：{id}</label>)}
            </div><Button onClick={() => void saveSection("accounts")}>保存账户授权（{grants.length}）</Button>
          </fieldset></Card>
        </> : <p className="text-sm text-slate-500">先创建分组，再配置模型映射和账户授权。</p>}
      </div>
    </div>
    <details className="rounded-xl border border-slate-200 dark:border-slate-800 p-3"><summary className="cursor-pointer text-sm font-medium text-slate-600 dark:text-slate-300">高级：合并两个模型池的成员</summary><div className="mt-3">
    <ModelGroupMergePanel groups={modelGroups} onChanged={async () => { const updated=await load(); const current=updated?.find(g=>g.id===selected); if(current)open(current); }} />
    </div></details>
  </div>;
}
