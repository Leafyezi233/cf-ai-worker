import { useEffect, useRef, useState } from "react";
import { consoleApi } from "../api/consoleClient";
import { TokenPolicyEditor } from "./TokenPolicyEditor";
import type { TokenPolicyGroup, TokenPolicyScopeOption, TokenPolicyState, TokenRoutingPolicy } from "./TokenPolicyEditor";
import { Button, Card, Input, Select } from "./ui";

export interface ConsoleTokenPoliciesProps {
  tokens: Array<{ id: string; name?: string; revoked_at?: number | null }>;
  onChanged?: () => void;
}
export interface ConsolePolicyResponse extends TokenPolicyState {
  groups: TokenPolicyGroup[];
  models: Array<{ scope_key: string; model_name: string; display_name?: string | null; group_ids: string[] }>;
}
export interface ConsoleRoutingPreview {
  available: boolean;
  model: string;
  public_name: string | null;
  identity: string | null;
  source: string | null;
  version: string | null;
  effective_policy: TokenRoutingPolicy | null;
  routes: Array<{ order: number; service_group: { id: string; name: string } | null; public_name: string; identity: string;
    price: { pricing_mode: string; billing_unit: "token" | "call"; input_price_per_m: number; output_price_per_m: number;
      cache_read_price_per_m: number; cache_write_price_per_m: number; price_per_call: number; search_price_per_call: number; multiplier: number } }>;
  legacy_fallback: boolean;
  explanation: string;
  error?: string;
  notice: string;
}
const ACCOUNT = "/console";
export function routingPolicyPath(target: string): string {
  return target === "account" ? ACCOUNT + "/routing-policy" : ACCOUNT + "/tokens/" + encodeURIComponent(target) + "/routing-policy";
}
export function policyScopeOptions(models: ConsolePolicyResponse["models"]): TokenPolicyScopeOption[] {
  return models.map(model => ({ key: model.scope_key, label: model.display_name || model.model_name,
    compatible_name: model.model_name, group_ids: [...model.group_ids] }));
}
export function policyTargets(tokens: ConsoleTokenPoliciesProps["tokens"]): Array<{ id: string; label: string }> {
  return [{ id: "account", label: "账户默认" }, { id: "master", label: "主 Token" },
    ...tokens.filter(token => !token.revoked_at && token.id !== "account" && token.id !== "master")
      .map(token => ({ id: token.id, label: "子 Token · " + (token.name || token.id) }))];
}
export async function loadConsoleTokenPolicy(target: string): Promise<ConsolePolicyResponse> {
  return consoleApi.get<ConsolePolicyResponse>(routingPolicyPath(target));
}
export async function saveConsoleTokenPolicy(target: string, policy: TokenRoutingPolicy | null): Promise<ConsolePolicyResponse> {
  await consoleApi.put(routingPolicyPath(target), { policy });
  return loadConsoleTokenPolicy(target);
}
export async function loadConsoleRoutingPreview(target: string, model: string): Promise<ConsoleRoutingPreview> {
  return consoleApi.post<ConsoleRoutingPreview>(ACCOUNT + "/routing-preview", { token_id: target, model });
}
function sourceLabel(source: string | null): string {
  return source === "account" ? "账户默认" : source === "token" ? "Token 独立策略" : source === "compatibility" ? "兼容旧配置" : "不可用";
}

export function ConsoleRoutingPreviewResult({ preview }: { preview: ConsoleRoutingPreview }) {
  const routes = preview.routes.filter((route, index, all) => route.service_group !== null || all.findIndex(item => item.service_group === null) === index);
  return <div className="space-y-2 text-sm" aria-live="polite">
    <p>{preview.available ? "可用" : "不可用"}{preview.error ? " · " + preview.error : ""}</p>
    <p>来源：{sourceLabel(preview.source)} · 版本：{preview.version || "—"}</p>
    {preview.public_name && <p>公开调用名：{preview.public_name}</p>}
    <p>{preview.explanation}</p>
    {preview.legacy_fallback && <p>没有分组报价，使用默认路由。</p>}
    <ol aria-label="解析候选及报价" className="space-y-2">
      {routes.map(route => <li key={route.order + ":" + (route.service_group?.id || route.identity)} className="rounded border border-slate-200 dark:border-slate-700 p-2">
        <p>{route.order}. {route.service_group?.name || "旧版默认路由"} · {route.public_name}</p>
        <p>{route.price.pricing_mode === "free" ? "免费" : "计价"} · 计费单位：{route.price.billing_unit === "call" ? "按次" : "Token"}</p>
        {route.price.billing_unit === "call" ? <p>USD {route.price.price_per_call}/次</p> : <p>
          USD/百万 Token：输入 {route.price.input_price_per_m} · 输出 {route.price.output_price_per_m} · 缓存读取 {route.price.cache_read_price_per_m} · 缓存写入 {route.price.cache_write_price_per_m}
        </p>}
        <p>搜索附加价：USD {route.price.search_price_per_call}/次 · 当前峰谷倍率：{route.price.multiplier}（以上已计入，搜索附加价不随倍率）</p>
      </li>)}
    </ol>
    <p>{preview.notice}</p>
  </div>;
}

function PolicyTargetPanel({ target, label, onChanged }: { target: string; label: string; onChanged?: () => void }) {
  const [data, setData] = useState<ConsolePolicyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    let current = true;
    loadConsoleTokenPolicy(target).then(value => { if (current) { setData(value); setError(null); } })
      .catch(err => { if (current) setError(err instanceof Error ? err.message : "策略加载失败"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; alive.current = false; };
  }, [target]);
  const save = async (policy: TokenRoutingPolicy | null) => {
    setError(null);
    try {
      const value = await saveConsoleTokenPolicy(target, policy);
      if (alive.current) { setData(value); onChanged?.(); }
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : "策略保存或刷新失败，请重新加载确认。");
      throw err;
    }
  };
  return <div className="space-y-4">
    <TokenPolicyEditor target={target} label={target === "account" ? "账户默认路由策略" : target === "master" ? "主 Token 路由策略" : label + " 路由策略"}
      value={data} groups={data?.groups || []} scopeOptions={policyScopeOptions(data?.models || [])} loading={loading} disabled={!data || loading}
      error={error} onSave={save} />
    {data?.following_token_count !== undefined && <p className="text-sm">当前继承账户默认的 Token 数：{data.following_token_count}</p>}
    {error && !loading && <Button variant="secondary" type="button" onClick={() => {
      setLoading(true); setError(null);
      loadConsoleTokenPolicy(target).then(value => { if (alive.current) setData(value); })
        .catch(err => { if (alive.current) setError(err instanceof Error ? err.message : "策略加载失败"); })
        .finally(() => { if (alive.current) setLoading(false); });
    }}>重新加载策略</Button>}

  </div>;
}


function RoutingPreviewPanel({ target, label }: { target: string; label: string }) {
  const [model, setModel] = useState("");
  const [preview, setPreview] = useState<ConsoleRoutingPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const alive = useRef(false);
  const previewSequence = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; previewSequence.current++; };
  }, []);
  const runPreview = async () => {
    const sequence = ++previewSequence.current;
    setPreview(null); setPreviewError(null); setPreviewLoading(true);
    try {
      const value = await loadConsoleRoutingPreview(target, model);
      if (alive.current && sequence === previewSequence.current) setPreview(value);
    } catch (err) {
      if (alive.current && sequence === previewSequence.current) setPreviewError(err instanceof Error ? err.message : "解析预览失败");
    } finally { if (alive.current && sequence === previewSequence.current) setPreviewLoading(false); }
  };
  return (
    <section aria-label="路由预览" className="space-y-2 border-t border-slate-200 dark:border-slate-700 pt-3">
      <h3 className="font-medium">路由预览 · {label}</h3>
      <label className="block text-sm">公开调用名（含兼容名）
        <Input aria-label="预览公开调用名" value={model} onChange={event => {
          setModel(event.target.value); setPreview(null); setPreviewError(null); previewSequence.current++; setPreviewLoading(false);
        }} placeholder="输入客户端 model 字段" />
      </label>
      <Button type="button" variant="secondary" disabled={!model.trim() || previewLoading} onClick={runPreview}>
        {previewLoading ? "解析中…" : "预览路由"}
      </Button>
      {previewError && <p role="alert">{previewError}</p>}
      {preview && <ConsoleRoutingPreviewResult preview={preview} />}
    </section>
  );
}

export function ConsoleTokenPolicies({ tokens, onChanged }: ConsoleTokenPoliciesProps) {
  const targets = policyTargets(tokens);
  const [selected, setSelected] = useState("");
  const [previewTarget, setPreviewTarget] = useState("");
  const [savedVersion, setSavedVersion] = useState(0);
  const previewActive = targets.find(target => target.id === previewTarget);
  const active = targets.find(target => target.id === selected);
  return <div className="space-y-4"><Card title="令牌调用策略与模型范围">
    <div className="space-y-4">
      <p className="text-sm">主 Token 和子 Token 默认沿用账户默认设置，也可以单独设置。子 Token 不会跟随主 Token 的单独设置。</p>
      <label className="block text-sm">编辑对象
        <Select aria-label="策略编辑对象" value={active?.id || ""} onChange={event => setSelected(event.target.value)}>
          <option value="">请选择编辑对象…</option>
          {targets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}
        </Select>
      </label>
      {active ? <section aria-label={active.label + "设置"} className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-700 dark:bg-slate-900/30 sm:p-5">
        <h3 className="font-medium">{active.label}设置</h3>
        <PolicyTargetPanel key={active.id} target={active.id} label={active.label} onChanged={() => { setSavedVersion(version => version + 1); onChanged?.(); }} />
      </section> : <p className="text-sm text-slate-500">选择后将在下方展开该对象的设置。</p>}
    </div>
  </Card>
  <Card title="路由预览">
    <div className="space-y-4">
      <p className="text-sm text-slate-500">输入模型名，查看请求会路由到哪个分组以及对应价格。</p>
      <label className="block text-sm">预览对象
        <Select aria-label="路由预览对象" value={previewActive?.id || ""} onChange={event => setPreviewTarget(event.target.value)}>
          <option value="">请选择预览对象…</option>
          {targets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}
        </Select>
      </label>
      {previewActive && <RoutingPreviewPanel key={previewActive.id + ":" + savedVersion} target={previewActive.id} label={previewActive.label} />}
    </div>
  </Card></div>;
}
