import { useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import { useQuery, invalidateCache } from "../hooks/useQuery";
import { Badge, Button, Card, Input, Modal, Select, Spinner, Textarea } from "./ui";

export const CATEGORY_COLORS = ["slate", "blue", "green", "amber", "red", "purple"] as const;
export interface CategoryRow {
  id: string;
  name: string;
  description: string;
  sort_order: number;
  color: typeof CATEGORY_COLORS[number];
  enabled: 0 | 1;
  model_count: number;
}
export interface ModelCategoriesData {
  items: CategoryRow[];
  bindings: { model_name: string; category_id: string }[];
}
export type CategoryOperation = "add" | "remove" | "replace";
const EMPTY: ModelCategoriesData = { items: [], bindings: [] };
export const CATEGORY_SCOPE_HELP = "分类按公开调用名全局共享，影响所有服务组中的同名模型；不改变模型类型、能力、路由、授权或计费。";
export const CATEGORY_RENAME_HELP = "请先保存模型或映射，再编辑分类。通过公开名称管理执行全局改名时，分类随稳定身份一并原子迁移；目标名已有分类关联时拒绝改名。直接修改上游模型名不会自动迁移分类。";
export const CATEGORY_DELETE_HELP = "仅删除分类及其关联，不删除模型，不停用路由或报价。";

export function categoryModelName(model: { alias?: string | null; model_name: string }): string {
  return model.alias?.trim() || model.model_name.trim();
}
const bindingIndexes = new WeakMap<ModelCategoriesData, Map<string, Set<string>>>();
export function categoryIdsForModel(data: ModelCategoriesData, name: string): string[] {
  let index = bindingIndexes.get(data);
  if (!index) {
    index = new Map();
    for (const b of data.bindings) {
      if (!index.has(b.model_name)) index.set(b.model_name, new Set());
      index.get(b.model_name)!.add(b.category_id);
    }
    bindingIndexes.set(data, index);
  }
  return [...(index.get(name) ?? [])];
}
export function matchesModelCategory(data: ModelCategoriesData, name: string, filter: string): boolean {
  if (!filter) return true;
  const ids = categoryIdsForModel(data, name);
  return filter === "__uncategorized__" ? ids.length === 0 : ids.includes(filter);
}
export function categoryBindingPayload(modelNames: string[], categoryIds: string[], operation: CategoryOperation) {
  const model_names = [...new Set(modelNames.map(n => n.trim()).filter(Boolean))];
  const category_ids = [...new Set(categoryIds)];
  if (!model_names.length) throw new Error("请先选择公开调用名");
  if (operation !== "replace" && !category_ids.length) throw new Error("请选择至少一个分类");
  return { model_names, category_ids, operation };
}
export function categoryBindingConfirmation(modelNames: string[], categoryIds: string[], operation: CategoryOperation): string {
  const payload = categoryBindingPayload(modelNames, categoryIds, operation);
  const action = { add: "添加", remove: "移除", replace: "替换全部" }[operation];
  return "确定对 " + payload.model_names.length + " 个公开调用名" + action + "分类？\n" + payload.model_names.join("、") + "\n" +
    (operation === "replace" ? "替换全部会移除原有分类；未选择分类将清空全部关联。\n" : "") + CATEGORY_SCOPE_HELP;
}
export async function applyModelCategoryBindings(modelNames: string[], categoryIds: string[], operation: CategoryOperation, confirmChange: (message: string) => boolean): Promise<boolean> {
  const body = categoryBindingPayload(modelNames, categoryIds, operation);
  if (!confirmChange(categoryBindingConfirmation(modelNames, categoryIds, operation))) return false;
  await api.post("/api/model-categories/bindings", body);
  invalidateCache("admin-model-categories");
  return true;
}
export function useModelCategories() {
  const query = useQuery<ModelCategoriesData>("admin-model-categories", () => api.get("/api/model-categories"), { ttlMs: 0 });
  const invalid = query.data && (!Array.isArray(query.data.items) || !Array.isArray(query.data.bindings));
  const data = invalid ? EMPTY : query.data ?? EMPTY;
  return { ...query, data, error: query.error || (invalid ? new Error("模型分类返回格式无效") : null) };
}
export type ModelCategoriesState = ReturnType<typeof useModelCategories>;
const message = (err: unknown) => err instanceof Error ? err.message : "分类操作失败";
const sorted = (items: CategoryRow[]) => [...items].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

export function ModelCategoryBadges({ data, modelName }: { data: ModelCategoriesData; modelName: string }) {
  const ids = new Set(categoryIdsForModel(data, modelName));
  const categories = sorted(data.items).filter(c => ids.has(c.id));
  return <div className="flex flex-wrap gap-1">{categories.length ? categories.map(c =>
    <Badge key={c.id} tone={c.color} title={c.description}>{c.name}{c.enabled ? "" : "（停用）"}</Badge>) : <span className="text-xs text-slate-400">未分类</span>}</div>;
}
export function ModelCategoryFilter({ state, value, onChange }: { state: ModelCategoriesState; value: string; onChange: (value: string) => void }) {
  return <div className="space-y-1"><Select aria-label="按模型分类筛选" value={value} onChange={e => onChange(e.target.value)} disabled={state.loading || !!state.error}>
    <option value="">全部分类</option><option value="__uncategorized__">未分类</option>
    {sorted(state.data.items).map(c => <option key={c.id} value={c.id}>{c.name}{c.enabled ? "" : "（停用）"}</option>)}
  </Select>{state.error && <div role="alert" className="text-xs text-red-600">分类加载失败：{state.error.message} <Button type="button" size="sm" variant="ghost" onClick={() => void state.refresh().catch(() => {})}>重试分类</Button></div>}</div>;
}

export function ModelCategoryBindingFields({ data, names, ids, operation, busy = false, setIds, setOperation }: {
  data: ModelCategoriesData; names: string[]; ids: string[]; operation: CategoryOperation; busy?: boolean;
  setIds: (ids: string[]) => void; setOperation: (operation: CategoryOperation) => void;
}) {
  return <>
        <p className="text-sm">已选 {names.length} 个公开调用名：{names.join("、")}</p><p className="text-xs text-amber-700 dark:text-amber-300">{CATEGORY_SCOPE_HELP}</p>
        <Select aria-label="分类操作" value={operation} disabled={busy} onChange={e => setOperation(e.target.value as CategoryOperation)}><option value="add">添加分类（保留原有）</option><option value="remove">移除所选分类</option><option value="replace">替换全部分类</option></Select>
        {operation === "replace" && <p className="text-xs text-red-600">替换全部将移除原有分类；不勾选任何分类即清空关联。保存前需确认。</p>}
        <fieldset disabled={busy} className="max-h-64 overflow-y-auto space-y-2"><legend className="text-sm mb-2">分类多选</legend>{sorted(data.items).map(c => <label key={c.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ids.includes(c.id)} onChange={e => setIds(e.target.checked ? [...ids, c.id] : ids.filter(id => id !== c.id))} /><Badge tone={c.color}>{c.name}{c.enabled ? "" : "（停用）"}</Badge><span className="text-xs text-slate-500">{c.description}</span></label>)}{!data.items.length && <p className="text-sm text-slate-500">暂无分类，请在模型页的分类管理面板中新建。</p>}</fieldset>
  </>;
}

export function ModelCategoryAssignment({ state, modelNames, disabled = false, label = "编辑分类" }: {
  state: ModelCategoriesState; modelNames: string[]; disabled?: boolean; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [operation, setOperation] = useState<CategoryOperation>("replace");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const names = [...new Set(modelNames.map(n => n.trim()).filter(Boolean))];
  function start() {
    setIds(names.length === 1 ? categoryIdsForModel(state.data, names[0]) : []);
    setOperation(names.length === 1 ? "replace" : "add"); setError(""); setOpen(true);
  }
  async function save() {
    try {
      setBusy(true); setError("");
      if (!await applyModelCategoryBindings(names, ids, operation, text => window.confirm(text))) return;
      await state.refresh(); setOpen(false);
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  return <><Button type="button" size="sm" variant="outline" disabled={disabled || !names.length || state.loading || !!state.error} onClick={start}>{label}{names.length > 1 ? "（" + names.length + " 个公开名）" : ""}</Button>
    {open && typeof document !== "undefined" && createPortal(<Modal open={open} onClose={() => { if (!busy) setOpen(false); }} title="公开模型分类（独立保存）">
      <div className="space-y-3" onClick={e => e.stopPropagation()}>
        <ModelCategoryBindingFields data={state.data} names={names} ids={ids} operation={operation} busy={busy} setIds={setIds} setOperation={setOperation} />
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2"><Button type="button" disabled={busy || (operation !== "replace" && !ids.length)} onClick={() => void save()}>{busy ? "保存中…" : "确认并保存分类"}</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>取消</Button></div>
      </div>
    </Modal>, document.body)}</>;
}

type CategoryDraft = Omit<CategoryRow, "id" | "model_count">;
const blank: CategoryDraft = { name: "", description: "", sort_order: 0, color: "slate", enabled: 1 };
export function ModelCategoryManager({ state }: { state: ModelCategoriesState }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<CategoryDraft>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (!draft.name.trim() || !Number.isSafeInteger(draft.sort_order)) { setError("名称不能为空，顺序须为整数"); return; }
    setBusy(true); setError("");
    try {
      const body = { ...draft, name: draft.name.trim(), description: draft.description.trim() };
      if (editing) await api.put("/api/model-categories/" + encodeURIComponent(editing), body);
      else await api.post("/api/model-categories", body);
      invalidateCache("admin-model-categories"); await state.refresh(); setEditing(null); setDraft(blank);
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  async function remove(c: CategoryRow) {
    if (!window.confirm("确定删除分类「" + c.name + "」？" + CATEGORY_DELETE_HELP)) return;
    setBusy(true); setError("");
    try { await api.del("/api/model-categories/" + encodeURIComponent(c.id)); invalidateCache("admin-model-categories"); await state.refresh(); if (editing === c.id) { setEditing(null); setDraft(blank); } }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  return <Card title="模型分类管理"><details><summary className="cursor-pointer text-sm font-medium">管理分类定义（名称、说明、顺序、颜色、启停）</summary><div className="mt-3 space-y-3">
    <p className="text-xs text-slate-500">{CATEGORY_SCOPE_HELP} {CATEGORY_DELETE_HELP} 停用仅隐藏用户侧分类，不删除现有关联。</p>
    {state.loading && <Spinner text="正在加载分类…" />}{state.error && <p role="alert" className="text-sm text-red-600">{state.error.message}</p>}
    <Button type="button" size="sm" variant="secondary" disabled={busy || state.loading} onClick={() => void state.refresh().catch(err => setError(message(err)))}>刷新分类</Button>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>分类</th><th>说明</th><th>顺序</th><th>关联模型数（全局公开名）</th><th>状态</th><th>操作</th></tr></thead><tbody>{sorted(state.data.items).map(c => <tr key={c.id} className="border-b border-slate-100 dark:border-slate-800"><td className="py-2"><Badge tone={c.color}>{c.name}</Badge></td><td className="break-all">{c.description || "—"}</td><td>{c.sort_order}</td><td>{c.model_count}</td><td>{c.enabled ? "启用" : "停用"}</td><td><div className="flex gap-1"><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(c.id); setDraft({ name: c.name, description: c.description, sort_order: c.sort_order, color: c.color, enabled: c.enabled }); setError(""); }}>编辑</Button><Button type="button" size="sm" variant="danger" disabled={busy} onClick={() => void remove(c)}>删除</Button></div></td></tr>)}</tbody></table></div>
    {!state.loading && !state.data.items.length && <p className="text-sm text-slate-500">暂无分类，既有模型默认未分类。</p>}
    <fieldset disabled={busy || state.loading || !!state.error} className="grid gap-3 sm:grid-cols-2"><legend className="text-sm font-medium mb-2">{editing ? "编辑分类" : "新建分类"}</legend>
      <label className="text-xs space-y-1">名称<Input value={draft.name} required maxLength={80} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="text-xs space-y-1">顺序<Input type="number" step="1" value={draft.sort_order} onChange={e => setDraft({ ...draft, sort_order: Number(e.target.value) })} /></label>
      <label className="text-xs space-y-1">简短说明<Textarea rows={2} maxLength={500} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
      <label className="text-xs space-y-1">预设颜色<Select value={draft.color} onChange={e => setDraft({ ...draft, color: e.target.value as CategoryRow["color"] })}>{CATEGORY_COLORS.map(color => <option key={color} value={color}>{color}</option>)}</Select></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked ? 1 : 0 })} />启用分类</label>
      <div className="flex gap-2"><Button type="button" onClick={() => void save()}>{busy ? "保存中…" : editing ? "保存分类" : "创建分类"}</Button>{editing && <Button type="button" variant="secondary" onClick={() => { setEditing(null); setDraft(blank); setError(""); }}>取消编辑</Button>}</div>
    </fieldset>{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </div></details></Card>;
}
