import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { Badge, Button, Card, Input, Select, Spinner } from "./ui";

export interface ServiceModelNamesPanelProps {
  serviceGroupId: string;
  models: { id: string; model_key: string }[];
  onChanged: () => void | Promise<void>;
}

type Alias = { name: string; mapping_id: string; enabled: number; canonical_name?: string | null };
type Identity = { name?: string; id?: string; [key: string]: unknown };
type AliasResponse = { items: Alias[]; identities: Identity[] };

function messageFor(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "操作失败";
}

export function ServiceModelNamesPanel({ serviceGroupId, models, onChanged }: ServiceModelNamesPanelProps) {
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [newName, setNewName] = useState("");
  const [newMapping, setNewMapping] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [legacyRisk, setLegacyRisk] = useState<{ kind: "alias" | "rename"; name?: string } | null>(null);
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});
  const [keepOldNames, setKeepOldNames] = useState<Record<string, boolean>>({});

  const path = "/api/service-groups/" + encodeURIComponent(serviceGroupId);
  async function load() {
    setLoading(true); setError("");
    try {
      const result = await api.get<AliasResponse>(path + "/aliases");
      setAliases(result.items ?? []); setIdentities(result.identities ?? []);
    } catch (err) { setError(messageFor(err)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [serviceGroupId]);

  function addAlias() {
    const name = newName.trim();
    if (!name || !newMapping) { setError("请填写兼容名并选择稳定模型映射"); return; }
    if (aliases.some(alias => alias.name === name)) { setError("兼容名不能重复"); return; }
    setAliases(current => [...current, { name, mapping_id: newMapping, enabled: 1 }]);
    setNewName(""); setNewMapping(""); setError("");
  }
  function body() {
    return { aliases: aliases.map(({ name, mapping_id, enabled }) => ({ name, mapping_id, enabled: enabled ? 1 : 0 })), allow_legacy_shadow: false };
  }
  async function saveAliases(allowLegacyShadow = false) {
    setBusy(true); setError("");
    try {
      await api.put(path + "/aliases", { ...body(), allow_legacy_shadow: allowLegacyShadow });
      setLegacyRisk(null); await load(); await onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.message === "legacy_name_conflict" && !allowLegacyShadow) {
        setLegacyRisk({ kind: "alias" });
      } else setError(messageFor(err));
    } finally { setBusy(false); }
  }
  async function rename(mappingId: string) {
    const name = (renameDrafts[mappingId] ?? "").trim();
    if (!name) { setError("请填写新的公开名"); return; }
    if (!window.confirm("这是跨服务组同一公开身份的全局改名。价格和授权不会合并，是否继续？")) return;
    setBusy(true); setError("");
    try {
      await api.post(path + "/models/" + encodeURIComponent(mappingId) + "/rename", { new_name: name, keep_old_alias: keepOldNames[mappingId] !== false, allow_legacy_shadow: false });
      setRenameDrafts(current => ({ ...current, [mappingId]: "" })); setLegacyRisk(null); await load(); await onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.message === "legacy_name_conflict") setLegacyRisk({ kind: "rename", name });
      else setError(messageFor(err));
    } finally { setBusy(false); }
  }
  async function confirmRename() {
    if (!legacyRisk?.name) return;
    const mapping = models.find(model => (renameDrafts[model.id] ?? "").trim() === legacyRisk.name);
    if (!mapping) { setLegacyRisk(null); return; }
    setBusy(true); setError("");
    try {
      await api.post(path + "/models/" + encodeURIComponent(mapping.id) + "/rename", { new_name: legacyRisk.name, keep_old_alias: keepOldNames[mapping.id] !== false, allow_legacy_shadow: true });
      setLegacyRisk(null); setRenameDrafts(current => ({ ...current, [mapping.id]: "" })); await load(); await onChanged();
    } catch (err) { setError(messageFor(err)); }
    finally { setBusy(false); }
  }
  const modelName = (id: string) => models.find(model => model.id === id)?.model_key ?? id;

  return <Card title="兼容名与公开名">
    <div className="space-y-5">
      <p className="text-xs text-slate-500">兼容名只绑定稳定的服务组映射 ID，不独立拥有价格、成员或授权。停用只关闭解析，记录会保留，状态显示为“已停用（记录保留）”，避免旧名被 legacy 路由接管。</p>
      {loading ? <Spinner text="正在读取兼容名…" /> : <>
        {error && <div role="alert" className="rounded-lg bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-600">{error}</div>}
        {legacyRisk && <div role="alert" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
          <p>名称与 legacy 名称冲突，继续可能改变旧请求的接管关系。只有明确确认风险后才会重试。</p>
          <div className="flex gap-2"><Button size="sm" variant="warning" disabled={busy} onClick={() => legacyRisk.kind === "alias" ? void saveAliases(true) : void confirmRename()}>确认仍要保存</Button><Button size="sm" variant="secondary" onClick={() => setLegacyRisk(null)}>取消</Button></div>
        </div>}
        <div className="space-y-2"><div className="text-sm font-medium">本服务组兼容名</div>
          {aliases.length === 0 && <p className="text-sm text-slate-500">暂无兼容名</p>}
          {aliases.map((alias, index) => <div key={alias.name + index} className="grid gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0"><div className="break-all font-medium">{alias.name}</div><div className="text-xs text-slate-500">映射：{modelName(alias.mapping_id)}</div></div>
            <div className="text-xs text-slate-500">{alias.enabled ? <Badge tone="green">启用</Badge> : <Badge tone="slate">已停用（记录保留）</Badge>}</div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!alias.enabled} disabled={busy} onChange={event => setAliases(current => current.map((item, i) => i === index ? { ...item, enabled: event.target.checked ? 1 : 0 } : item))} />启用</label>
          </div>)}
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"><Input aria-label="新增兼容名" placeholder="旧客户端名称" value={newName} disabled={busy} onChange={event => setNewName(event.target.value)} /><Select aria-label="兼容名映射" value={newMapping} disabled={busy} onChange={event => setNewMapping(event.target.value)}><option value="">选择稳定映射</option>{models.map(model => <option key={model.id} value={model.id}>{model.model_key}（{model.id}）</option>)}</Select><Button type="button" variant="secondary" disabled={busy} onClick={addAlias}>添加</Button></div>
          <Button type="button" disabled={busy} onClick={() => void saveAliases()}>保存兼容名</Button>
        </div>
      </>}
        <div className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-700"><div className="text-sm font-medium">公开名改名</div><p className="text-xs text-amber-700 dark:text-amber-300">这是跨服务组同一公开身份的全局改名；价格、授权不会合并。不会自动改名、探测名称或调用模型。</p>
          {models.map(model => <div key={model.id} className="space-y-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={keepOldNames[model.id] !== false} disabled={busy || loading} onChange={event => setKeepOldNames(current => ({ ...current, [model.id]: event.target.checked }))} />保留旧名可调用（取消勾选则停用旧名但保留记录）</label><div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center"><div className="min-w-0"><span className="break-all">{model.model_key}</span><span className="ml-2 text-xs text-slate-500">映射 {model.id}</span></div><Input aria-label={"新的公开名 " + model.model_key} value={renameDrafts[model.id] ?? ""} disabled={busy} onChange={event => setRenameDrafts(current => ({ ...current, [model.id]: event.target.value }))} placeholder="新的全局公开名" /><Button type="button" variant="warning" disabled={busy} onClick={() => void rename(model.id)}>确认全局改名</Button></div></div>)}
        </div>
        {identities.length > 0 && <p className="text-xs text-slate-500">已发现公开身份记录：{identities.map(identity => identity.name).filter(Boolean).join("、")}</p>}
    </div>
  </Card>;
}

export default ServiceModelNamesPanel;
