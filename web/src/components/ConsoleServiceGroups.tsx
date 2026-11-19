import { useState } from "react";
import { consoleAccountApi, type ConsoleServiceGroup, type ConsoleSubToken } from "../api/consoleClient";
import { useQuery } from "../hooks/useQuery";
import { Button, Empty, Select, Spinner } from "./ui";
import { useToast } from "./Toast";

function selectionName(id: string | null, groups: ConsoleServiceGroup[]) {
  if (id === null || id === "legacy") return "旧版默认路由";
  if (id === "auto") return "自动路由";
  return groups.find(group => group.id === id)?.name ?? "不可用的分组（" + id + "）";
}

function GroupSelection({ label, current, groups, inheritLabel, disabled, confirmText, onSave }: {
  label: string; current: string | null; groups: ConsoleServiceGroup[]; inheritLabel: string;
  disabled: boolean; confirmText?: string; onSave: (id: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const toast = useToast();
  async function save() {
    setBusy(true);
    try { await onSave(value || null); toast.success("服务分组已更新"); setConfirming(false); }
    catch (error) { toast.error(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  }
  const changed = value !== (current ?? "");
  return <div className="space-y-1.5">
    <label className="block text-sm"><span>{label}</span>
      <Select className="mt-1" value={value} disabled={disabled || busy} onChange={event => { setValue(event.target.value); setConfirming(false); }}>
        <option value="">{inheritLabel}</option>
        <option value="legacy">旧版默认路由（原模型路由与价格）</option><option value="auto">自动（候选顺序由令牌路由策略决定）</option>
        {groups.map(group => <option key={group.id} value={group.id}>{group.name}（× {group.multiplier}）</option>)}
        {value && value !== "auto" && value !== "legacy" && !groups.some(group => group.id === value) && <option value={value} disabled>当前分组不可选：{value}</option>}
      </Select>
    </label>
    {confirming && confirmText ? <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200" role="alert">
      <p>{confirmText}</p><div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "确认更改"}</Button><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>返回修改</Button></div>
    </div> : <Button type="button" size="sm" variant="secondary" disabled={disabled || busy || !changed} onClick={() => confirmText ? setConfirming(true) : void save()}>{busy ? "保存中…" : "保存选择"}</Button>}
  </div>;
}

function formatPrice(value: number) {
  return "¥" + value.toLocaleString("zh-CN", { maximumFractionDigits: 8 });
}

export function ConsoleServiceGroups({ scope, tokens, onTokensChange, onChange }: {
  scope: string; tokens: ConsoleSubToken[]; onTokensChange: () => Promise<unknown>; onChange?: () => void;
}) {
  const groupsQuery = useQuery("console:" + scope + ":service-groups", consoleAccountApi.serviceGroups, { ttlMs: 0 });
  const [previewId, setPreviewId] = useState("");
  const preview = useQuery(previewId ? "console:" + scope + ":service-group-preview:" + previewId : null,
    () => consoleAccountApi.previewServiceGroup(previewId), { ttlMs: 0 });
  const state = groupsQuery.data;
  const groups = state?.items ?? [];
  const inheriting = (state?.service_group_id === null ? 1 : 0) + tokens.filter(token => {
    const configured = state?.sub_tokens.find(item => item.id === token.id);
    return !token.revoked && (configured ? configured.service_group_id : token.service_group_id) === null;
  }).length;
  async function saveAccount(selection: { default_service_group_id?: string | null; service_group_id?: string | null }) {
    await consoleAccountApi.setServiceGroups(selection);
    groupsQuery.mutate(previous => ({ ...previous!, ...selection }));
    onChange?.();
  }
  return <section className="space-y-4 border-t border-slate-200 dark:border-slate-800 pt-4">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">服务分组</h3><Button type="button" size="sm" variant="ghost" disabled={groupsQuery.loading || groupsQuery.isRefreshing} onClick={() => { void groupsQuery.refresh().catch(() => {}); }}>刷新</Button></div>
    <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">先核对当前生效设置，再单独修改账户默认、主 Token 或子 Token。空值表示沿用上一级；若账户默认也为空，则使用旧版默认路由。自动路由的候选顺序与失败切换由令牌策略决定，不保证选择最低报价。模型广场仅供比较，不会更改任何 Token。</p>
    {groupsQuery.error && <p role="alert" className="text-sm text-rose-600">分组信息加载失败：{groupsQuery.error.message}</p>}
    {groupsQuery.loading && !state ? <Spinner text="正在加载服务分组…" /> : state && <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed dark:border-slate-800 dark:bg-slate-900/60"><div className="font-medium">账户默认 · 当前值</div><div className="mt-1">{selectionName(state.default_service_group_id, groups)}</div><div className="mt-1 text-slate-500 dark:text-slate-400">主 Token 和未单独指定分组的子 Token 将使用此默认值。</div></div>
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed dark:border-slate-800 dark:bg-slate-900/60"><div className="font-medium">主 Token · 有效配置</div><div className="mt-1">{selectionName(state.service_group_id ?? state.default_service_group_id, groups)}</div><div className="mt-1 text-slate-500 dark:text-slate-400">{state.service_group_id === null ? "继承账户默认" : "使用主 Token 自己的选择"}</div></div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <GroupSelection key={"default:" + state.default_service_group_id} label="更改账户默认" current={state.default_service_group_id} groups={groups} inheritLabel="不设账户默认（使用旧版默认路由）" disabled={!!groupsQuery.error} confirmText={inheriting ? "更改后将影响 " + inheriting + " 个使用账户默认分组的 Token（包括未单独设置分组的主 Token）；已设置独立分组的 Token 不受影响。" : undefined} onSave={id => saveAccount({ default_service_group_id: id })} />
        <GroupSelection key={"master:" + state.service_group_id} label="更改主 Token" current={state.service_group_id} groups={groups} inheritLabel="继承账户默认" disabled={!!groupsQuery.error} onSave={id => saveAccount({ service_group_id: id })} />
      </div>
      <div className="space-y-3">{tokens.filter(token => !token.revoked).map(token => {
        const configured = state.sub_tokens.find(item => item.id === token.id);
        const tokenSelection = configured ? configured.service_group_id : token.service_group_id;
        const effectiveId = tokenSelection ?? state.default_service_group_id;
        return <div key={token.id} className="grid gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800 sm:grid-cols-2 sm:items-start">
          <div className="text-xs leading-relaxed"><div className="font-medium">子 Token · {token.name} · 有效配置</div><div className="mt-1">{selectionName(effectiveId, groups)}</div><div className="mt-1 text-slate-500 dark:text-slate-400">{tokenSelection === null ? "继承账户默认" : "使用此子 Token 的独立选择"}</div></div>
          <GroupSelection key={token.id + ":" + token.service_group_id} label="更改此子 Token" current={tokenSelection} groups={groups} inheritLabel="继承账户默认" disabled={!!groupsQuery.error} onSave={async id => {
            await consoleAccountApi.setTokenServiceGroup(token.id, id);
            await onTokensChange();
          }} />
        </div>;
      })}</div>
      {!groups.length && <Empty text="暂无固定分组，可选择自动或旧版默认路由。" />}
      <div className="space-y-3 rounded-lg border border-slate-200 dark:border-slate-800 p-3">
        <div><h4 className="text-sm font-medium">查看分组报价（只读）</h4><p className="mt-1 text-xs leading-relaxed text-slate-500">这里只查看报价，不会更改任何 Token 的分组。模型按账户权限展示；自动报价供比较，不代表固定选择最低价。实际费用按请求命中的分组与价格计算。视频任务固定提交渠道，不自动重发。</p></div>
        <label className="block text-sm">选择要查看的分组<Select className="mt-1" value={previewId} onChange={event => setPreviewId(event.target.value)}><option value="">选择分组…</option><option value="legacy">旧版默认路由（原模型路由与价格）</option><option value="auto">自动（候选顺序由令牌路由策略决定）</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</Select></label>
        {preview.loading && <Spinner text="正在加载报价…" />}
        {preview.error && <p role="alert" className="text-sm text-rose-600">报价加载失败：{preview.error.message}</p>}
        {previewId && preview.data && !preview.loading && !preview.error && <><p className="text-xs text-slate-600 dark:text-slate-400">{preview.data.model_count} 个可用模型 · 人民币。Token 价格按百万 Token 计；按次价格按调用计。</p>
          {!preview.data.items.length ? <Empty text="此分组暂无你可用的模型。试试其他分组，或联系管理员确认权限。" /> : <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-left text-slate-500">{["模型调用名", "计价状态", "输入 / 百万 Token", "输出 / 百万 Token", "缓存读 / 百万 Token", "缓存写 / 百万 Token", "每次调用", "联网搜索附加费"].map(label => <th key={label} className="p-2 whitespace-nowrap">{label}</th>)}</tr></thead><tbody>{preview.data.items.map(model => {
            const unset = model.pricing_mode === "unset";
            const free = model.pricing_mode === "free";
            const tokenPrice = (value: number) => unset ? "—" : free ? "免费" : formatPrice(value);
            const callPrice = unset ? "—" : free ? "免费" : formatPrice(model.price_per_call);
            const searchPrice = model.model_type === "video" ? "不适用" : model.search_price_per_call > 0 ? formatPrice(model.search_price_per_call) + " / 次" : "已包含";
            return <tr key={model.id} className="border-t border-slate-100 dark:border-slate-800"><td className="p-2">{model.alias || model.model_name}</td><td className="p-2">{unset ? "未定价" : free ? "免费" : "已定价"}</td><td className="p-2 tabular-nums">{model.billing_unit === "call" ? "—" : tokenPrice(model.input_price_per_m)}</td><td className="p-2 tabular-nums">{model.billing_unit === "call" ? "—" : tokenPrice(model.output_price_per_m)}</td><td className="p-2 tabular-nums">{model.billing_unit === "call" ? "—" : unset ? "—" : free ? "免费" : model.cache_read_price_per_m > 0 ? formatPrice(model.cache_read_price_per_m) : "按输入价"}</td><td className="p-2 tabular-nums">{model.billing_unit === "call" ? "—" : unset ? "—" : free ? "免费" : model.cache_write_price_per_m > 0 ? formatPrice(model.cache_write_price_per_m) : "按输入价"}</td><td className="p-2 tabular-nums">{model.billing_unit === "call" ? callPrice + (model.model_type === "video" ? " / 成功任务次" : "") : "—"}</td><td className="p-2 tabular-nums">{searchPrice}</td></tr>;
          })}</tbody></table></div>}
          <p className="text-xs text-slate-500">未单独设置缓存价格时，按输入价计费；联网搜索另收费。这里展示的是报价，实际费用按请求时价格计算。</p>
        </>}
      </div>
    </>}
  </section>;
}
