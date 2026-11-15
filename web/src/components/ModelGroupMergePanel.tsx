import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { Button, Card } from "./ui";

export interface ModelGroupMergePanelProps {
  groups: { id: string; name: string }[];
  onChanged: () => void | Promise<void>;
}
type LegacyAction = "retain" | "disable";
type Preview = {
  fingerprint: string;
  can_commit: boolean;
  blockers: { code: string; message: string }[];
  source?: { id: string; name: string };
  target?: { id: string; name: string };
  comparison?: { source: Record<string, unknown>; target: Record<string, unknown>; merged_members: unknown[] };
  references?: Record<string, unknown[]>;
  mapping_changes?: Record<string, unknown>[];
  legacy?: { description: string; pool_changes: boolean; source_remains: boolean };
  warnings?: string[];
};
const rateLabels: Record<string, string> = { input_price_per_m: "输入 / 百万 token", output_price_per_m: "输出 / 百万 token",
  cache_read_price_per_m: "缓存读 / 百万 token", cache_write_price_per_m: "缓存写 / 百万 token", price_per_call: "每次调用", search_price_per_call: "每次搜索" };
const referenceLabels: Record<string, string> = { mappings: "独立公开报价 / mappings", aliases: "服务组别名（含停用）", identities: "公共模型稳定身份",
  policies: "Token 路由策略（完整审查）", device_grants: "账户内部组授权", template_grants: "模板内部组引用", devices: "账户范围 / 启用状态",
  templates: "模板范围", template_bindings: "模板账户绑定", service_grants: "服务组账户授权", tokens: "子令牌启用 / 撤销状态", policy_groups: "策略服务组引用" };
function JsonDetails({ title, value, open = false }: { title: string; value: unknown; open?: boolean }) {
  return <details open={open} className="rounded border p-3"><summary className="cursor-pointer font-medium">{title}</summary>
    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(value, null, 2)}</pre></details>;
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }

export function ModelGroupMergePanel({ groups, onChanged }: ModelGroupMergePanelProps) {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [legacy, setLegacy] = useState<LegacyAction | "">("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmedPrices, setConfirmedPrices] = useState(false);
  const [confirmedPermissions, setConfirmedPermissions] = useState(false);
  const [confirmationName, setConfirmationName] = useState("");
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  const selectionKey = JSON.stringify([source, target, legacy, groups]);
  const currentSelection = useRef(selectionKey);
  const previewSelection = useRef<string | null>(null);
  currentSelection.current = selectionKey;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestVersion.current += 1; }; }, []);
  useEffect(() => {
    requestVersion.current += 1;
    previewSelection.current = null;
    setPreview(null); setConfirmedPrices(false); setConfirmedPermissions(false); setConfirmationName(""); setError("");
    setBusy(value => value === "commit" ? value : null);
  }, [selectionKey]);
  const resetPreview = () => { previewSelection.current = null; setPreview(null); setConfirmedPrices(false); setConfirmedPermissions(false); setConfirmationName(""); };
  const validSelection = !!source && !!target && source !== target && !!legacy && groups.some(group => group.id === source) && groups.some(group => group.id === target);
  async function loadPreview() {
    if (!validSelection || busy) return;
    const version = ++requestVersion.current, key = selectionKey;
    resetPreview(); setError(""); setNotice(""); setBusy("preview");
    try {
      const result = await api.post<Preview>("/api/model-group-merge/preview", { source_id: source, target_id: target, legacy_action: legacy });
      if (mounted.current && requestVersion.current === version && currentSelection.current === key) { previewSelection.current = key; setPreview(result); }
    } catch (err) {
      if (mounted.current && requestVersion.current === version && currentSelection.current === key) setError(errorMessage(err));
    } finally { if (mounted.current && requestVersion.current === version) setBusy(null); }
  }
  async function commit() {
    if (previewSelection.current !== selectionKey || !preview?.can_commit || busy || !validSelection || !confirmedPrices || !confirmedPermissions || confirmationName !== preview.target?.name) return;
    requestVersion.current += 1;
    setBusy("commit"); setError(""); setNotice("");
    try {
      await api.post("/api/model-group-merge/commit", { source_id: source, target_id: target, legacy_action: legacy,
        fingerprint: preview.fingerprint, confirm_prices: true, confirm_permissions: true });
      if (!mounted.current) return;
      resetPreview(); setNotice("内部成员池已原子合并；源组未删除，公开报价、别名与账户授权保持独立。");
      try { await onChanged(); } catch (refreshError) { if (mounted.current) setError("合并成功，但刷新失败：" + errorMessage(refreshError)); }
    } catch (err) {
      if (!mounted.current) return;
      resetPreview();
      setError(err instanceof ApiError && err.status === 409 ? "配置或权限快照已失效 / 安全校验拒绝：" + err.message + "。请重新预览并确认。" : errorMessage(err));
    } finally { if (mounted.current) setBusy(null); }
  }
  const left = preview?.comparison?.source, right = preview?.comparison?.target;
  return <Card>
    <section className="space-y-4" aria-label="模型组内部池合并向导">
      <div><h2 className="text-lg font-semibold">内部成员池合并向导</h2>
        <p className="text-sm text-gray-500">不合并公开身份、报价或账户授权，不自动选最低价，不删除源组。存在无法安全解释的引用时只提供阻止原因。</p></div>
      <fieldset disabled={!!busy} className="grid gap-3 md:grid-cols-3">
        <label className="space-y-1"><span>1. 源组</span><select className="w-full rounded border bg-transparent p-2" value={source} onChange={event => setSource(event.target.value)}>
          <option value="">请选择源组</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <label className="space-y-1"><span>2. 目标组</span><select className="w-full rounded border bg-transparent p-2" value={target} onChange={event => setTarget(event.target.value)}>
          <option value="">请选择目标组</option>{groups.map(group => <option key={group.id} value={group.id} disabled={group.id === source}>{group.name}</option>)}</select></label>
        <label className="space-y-1"><span>3. 源 legacy 旧名处理（必选）</span><select className="w-full rounded border bg-transparent p-2" value={legacy} onChange={event => setLegacy(event.target.value as LegacyAction | "")}>
          <option value="">必须明确选择</option><option value="retain">保留源壳 / 旧名，改用合并池</option><option value="disable">停用旧名，保留 disabled tombstone</option></select></label>
      </fieldset>
      {source && source === target && <p role="alert" className="text-red-600">源组和目标组不能相同。</p>}
      {legacy === "retain" && <p className="text-sm">保留源完整定价与名称，但源 legacy 入口的内部成员池也会扩大为合并池；这不是保持原池不变。</p>}
      {legacy === "disable" && <p className="text-sm">源 legacy 入口停用。源记录、原成员和历史引用保留，不执行删除；独立公开 mappings 迁移到目标内部池。</p>}
      <Button onClick={loadPreview} disabled={!validSelection || !!busy}>{busy === "preview" ? "正在只读预览…" : "4. 只读预览全部影响"}</Button>
      {error && <p role="alert" className="text-red-600">{error}</p>}{notice && <p role="status" className="text-green-600">{notice}</p>}
      {preview && <div className="space-y-4">
        <h3 className="font-semibold">{preview.source?.name} → {preview.target?.name}</h3>
        {preview.blockers.length > 0 && <div role="alert" className="rounded border border-red-400 p-3"><strong>无法安全迁移，禁止提交</strong>
          <ul className="list-inside list-disc">{preview.blockers.map((blocker, index) => <li key={index}>{blocker.message} <code>({blocker.code})</code></li>)}</ul></div>}
        {(preview.warnings || []).map((warning, index) => <p key={index} className="text-sm text-amber-700">{warning}</p>)}
        {preview.legacy && <p className="rounded border p-3">{preview.legacy.description}</p>}
        {left && right && <>
          <div className="overflow-auto"><table className="w-full text-left text-sm"><caption className="text-left font-medium">单位、类型、模式与完整基础价格对比（USD）</caption>
            <thead><tr><th>字段</th><th>源</th><th>目标</th></tr></thead><tbody>
              {["unit", "model_type", "pricing_mode", "model_public", "cache_enabled", "cache_ttl", "peak_pricing_enabled"].map(key => <tr key={key}><td>{key}</td><td>{String(left[key] ?? "-")}</td><td>{String(right[key] ?? "-")}</td></tr>)}
              {Object.entries(rateLabels).map(([key, label]) => <tr key={key}><td>{label}</td><td>{String((left.prices as Record<string, unknown> | undefined)?.[key] ?? "-")}</td><td>{String((right.prices as Record<string, unknown> | undefined)?.[key] ?? "-")}</td></tr>)}
            </tbody></table></div>
          <div className="grid gap-3 md:grid-cols-2"><JsonDetails title="源成员、能力、协议、配置、高峰窗口" value={left} open /><JsonDetails title="目标成员、能力、协议、配置、高峰窗口" value={right} open /></div>
          <JsonDetails title="合并后的成员顺序 / 启用状态" value={preview.comparison?.merged_members} open />
        </>}
        <JsonDetails title="各 mapping 迁移前后独立完整报价 / 显式成员（逐条核对，不合并 model_key）" value={preview.mapping_changes || []} open />
        <h4 className="font-semibold">全部相关引用（含停用与阻塞引用；未折叠为“无影响”）</h4>
        {Object.entries(preview.references || {}).map(([key, rows]) => <JsonDetails key={key} title={(referenceLabels[key] || key) + "（" + rows.length + "）"} value={rows} open={rows.length > 0} />)}
        <fieldset disabled={!preview.can_commit || !!busy} className="space-y-3 rounded border p-3">
          <legend className="font-semibold">5. 显式确认价格与权限影响</legend>
          <label className="flex gap-2"><input type="checkbox" checked={confirmedPrices} onChange={event => setConfirmedPrices(event.target.checked)} />
            <span>已核对每条公开报价保持独立；源继承价格冻结为完整价格，目标报价不取最低值，配置/能力/rewrite 不被悄改。</span></label>
          <label className="flex gap-2"><input type="checkbox" checked={confirmedPermissions} onChange={event => setConfirmedPermissions(event.target.checked)} />
            <span>已核对引用、旧名选择、默认成员池变化与内部 quotaId/限流桶合并；不自动扩大账户授权，阻塞引用须另行处理。</span></label>
          <label className="block">输入目标组名称 <strong>{preview.target?.name}</strong> 再确认：
            <input className="mt-1 block w-full rounded border bg-transparent p-2" aria-label="确认目标组名称" value={confirmationName} onChange={event => setConfirmationName(event.target.value)} /></label>
          <Button onClick={commit} disabled={previewSelection.current !== selectionKey || !preview.can_commit || !!busy || !confirmedPrices || !confirmedPermissions || confirmationName !== preview.target?.name}>
            {busy === "commit" ? "原子迁移中…" : "6. 确认并原子迁移"}</Button>
        </fieldset>
      </div>}
    </section>
  </Card>;
}
