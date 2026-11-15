import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { readPendingMonthlyAction, runMonthlyAction, type MonthlyAction } from "../api/monthlyPassActions";
import {
  monthlyPassesApi, monthlyLimitFields, monthlyLimitFromText, monthlyPassMoney, monthlyPassStatus,
  validateMonthlyPlanInput, type MonthlyPlan, type MonthlyPlanInput, type MonthlyAccount, type MonthlyLimits,
} from "../api/monthlyPasses";
import { MonthlyPassRules, MonthlyPassSummary, MonthlyPassWalletControl } from "../components/ConsoleMonthlyPass";
import { Badge, Button, Card, Empty, Input, Select, Spinner } from "../components/ui";
import { useToast } from "../components/Toast";
import { useQuery } from "../hooks/useQuery";

interface Choice { id: string; name: string; enabled?: number | boolean }
function message(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }

export function MonthlyPassPlanForm({ plan, groups, onSaved }: {
  plan: MonthlyPlan | null; groups: Choice[]; onSaved: () => Promise<unknown>;
}) {
  const toast = useToast();
  const [name, setName] = useState(plan?.name ?? "");
  const [enabled, setEnabled] = useState(plan?.enabled !== 0);
  const [limits, setLimits] = useState<Record<keyof MonthlyLimits, string>>({
    daily_usd: String(plan?.limits.daily_usd ?? ""), weekly_usd: String(plan?.limits.weekly_usd ?? ""),
    five_hour_usd: String(plan?.limits.five_hour_usd ?? ""), total_usd: String(plan?.limits.total_usd ?? ""),
  });
  const [restricted, setRestricted] = useState(plan?.service_group_ids !== null && plan?.service_group_ids !== undefined);
  const [groupIds, setGroupIds] = useState<string[]>(plan?.service_group_ids ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const choices = [...groups, ...groupIds.filter(id => !groups.some(group => group.id === id)).map(id => ({ id, name: id + "（已失效，保留原值）", enabled: false }))];
  async function save(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const input: MonthlyPlanInput = validateMonthlyPlanInput({ name: name.trim(), enabled: enabled ? 1 : 0,
        limits: { daily_usd: monthlyLimitFromText(limits.daily_usd), weekly_usd: monthlyLimitFromText(limits.weekly_usd), five_hour_usd: monthlyLimitFromText(limits.five_hour_usd), total_usd: monthlyLimitFromText(limits.total_usd) },
        service_group_ids: restricted ? [...groupIds] : null,
      });
      if (plan) await monthlyPassesApi.updatePlan(plan.id, input); else await monthlyPassesApi.createPlan(input);
      if (!mounted.current) return;
      await onSaved();
      if (mounted.current) toast.success("套餐已保存");
    } catch (err) { if (mounted.current) { setError(message(err)); toast.error(message(err)); } }
    finally { if (mounted.current) setBusy(false); }
  }
  return <form className="space-y-4" onSubmit={event => void save(event)}>
    <fieldset disabled={busy} className="space-y-4">
      <label className="block space-y-1 text-xs"><span>套餐名称</span><Input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用套餐</label>
      <div className="grid gap-3 sm:grid-cols-2">{monthlyLimitFields.map(([key, label]) => <label key={key} className="block space-y-1 text-xs"><span>{label}限额（¥，与网关计费币种一致）</span><Input type="number" step="any" max={1e9} value={limits[key]} placeholder="留空表示不限额" onChange={event => setLimits(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}</div>
      <p className="text-xs text-slate-500">至少一项正限额；金额必须有限、大于 0 且不超过 1e9。空白发送 null，不会发送 0。</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={restricted} onChange={event => setRestricted(event.target.checked)} />限制月卡可计费服务分组</label>
      <p className="text-xs text-slate-500">不勾选发送 null；勾选但不选择发送 []（无分组可用）。最多 100 个。此处不授予账户路由权限。</p>
      {restricted && <div aria-label="月卡服务分组" className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-3 dark:border-slate-700">{choices.length ? choices.map(group => <label key={group.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={groupIds.includes(group.id)} disabled={!groupIds.includes(group.id) && groupIds.length >= 100} onChange={event => setGroupIds(previous => event.target.checked ? [...previous, group.id] : previous.filter(id => id !== group.id))} />{group.name}{group.enabled === 0 || group.enabled === false ? "（停用）" : ""}</label>) : <p className="text-xs text-slate-500">暂无服务分组</p>}</div>}
      {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
      <Button type="submit" disabled={busy}>{busy ? "保存中…" : plan ? "保存完整套餐" : "创建套餐"}</Button>
      <p className="text-xs text-slate-500">不提供删除；可取消启用后保存以停用套餐。</p>
    </fieldset>
  </form>;
}

export function AccountEditor({ deviceId, plans, onChanged }: { deviceId: string; plans: MonthlyPlan[]; onChanged: () => void }) {
  const query = useQuery("admin:monthly-pass:account:" + deviceId, () => monthlyPassesApi.account(deviceId), { ttlMs: 0 });
  const [planId, setPlanId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function pendingState() {
    try { return { pending: readPendingMonthlyAction(deviceId), error: "" }; }
    catch (err) { return { pending: null, error: message(err) }; }
  }
  const [pending, setPending] = useState(pendingState);
  const submitting = useRef(false);
  async function action(request: MonthlyAction, replay?: ReturnType<typeof readPendingMonthlyAction>) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const result = await runMonthlyAction(deviceId, request, () => query.refresh(), replay ?? undefined);
      if (!mounted.current) return;
      setPending(pendingState());
      if (result.status === "committed") {
        toast.success(request.kind === "issue" ? "月卡已开通" : "月卡已续期");
        setError(result.refreshError ?? ""); onChanged();
      } else { setError(result.message); toast.error(result.message); }
    } finally { submitting.current = false; if (mounted.current) setBusy(false); }
  }
  async function stop(id: string) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try { await monthlyPassesApi.stop(id); }
    catch (err) { if (mounted.current) { setError(message(err)); toast.error(message(err)); } return; }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
    if (!mounted.current) return;
    toast.success("月卡权益已停用"); onChanged();
    try { await query.refresh(); } catch (err) { if (mounted.current) setError("停用已成功，账户刷新失败，请仅重新读取：" + message(err)); }
  }
  async function wallet(enabled: boolean, confirmed: boolean) {
    setBusy(true);
    try {
      const result = await monthlyPassesApi.walletFallback(deviceId, enabled, confirmed);
      if (mounted.current) { query.mutate(result); onChanged(); }
    } finally { if (mounted.current) setBusy(false); }
  }
  const account = query.data?.item;
  const subscription = account?.subscription;
  const blocked = busy || query.isRefreshing || !!query.error || !!pending.pending || !!pending.error;
  return <div className="space-y-4">
    {query.error && <p role="alert" className="text-sm text-rose-600">账户加载失败：{query.error.message}</p>}
    <Button type="button" size="sm" variant="ghost" disabled={busy || query.loading || query.isRefreshing} onClick={() => { void query.refresh().catch(() => {}); }}>刷新账户</Button>
    {query.loading && !account ? <Spinner text="正在加载账户月卡…" /> : account && <>
      <MonthlyPassSummary account={account} />
      <div className="flex flex-wrap items-end gap-2"><label className="min-w-48 flex-1 space-y-1 text-xs"><span>选择开通套餐</span><Select value={planId} disabled={blocked} onChange={event => setPlanId(event.target.value)}><option value="">请选择启用套餐</option>{plans.filter(plan => plan.enabled === 1).map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</Select></label>
        <Button type="button" disabled={blocked || !plans.some(plan => plan.id === planId && plan.enabled === 1)} onClick={() => void action({ kind: "issue", planId })}>开通 30 天</Button></div>
      {subscription && <div className="flex flex-wrap gap-2"><Button type="button" variant="danger" disabled={blocked || !subscription.enabled} onClick={() => void stop(subscription.id)}>停用权益</Button>
        <Button type="button" variant="secondary" disabled={blocked} onClick={() => void action({ kind: "renew", subscriptionId: subscription.id })}>续期 30 天</Button></div>}
      <p className="text-xs text-slate-500">开通不授予路由权限。停用仅影响月卡权益，不停用账户。有效期内续期不清桶；过期续期为新 ID。</p>
      {subscription && <MonthlyPassWalletControl enabled={account.wallet_fallback} disabled={blocked} onSave={wallet} />}
    </>}
    {pending.pending && <div className="space-y-2"><p role="status" className="text-sm text-amber-600">存在提交结果未确认的原操作；请核实或重试原操作，不要重复开卡／续期。</p><Button type="button" disabled={busy} onClick={() => { if (pending.pending) void action(pending.pending.action, pending.pending); }}>核实 / 重试原操作</Button></div>}
    {pending.error && <p role="alert" className="text-sm text-rose-600">{pending.error}</p>}
    {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
  </div>;
}
async function loadOverview() {
  const [plans, accounts, devices, groups] = await Promise.all([
    monthlyPassesApi.plans(), monthlyPassesApi.accounts(), api.get<{ items: Choice[] }>("/api/devices"), api.get<{ items: Choice[] }>("/api/service-groups"),
  ]);
  return { plans: plans.items, accounts: accounts.items, devices: devices.items, groups: groups.items };
}
export default function MonthlyPassesPage() {
  const query = useQuery("admin:monthly-passes", loadOverview, { ttlMs: 0 });
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const [deviceId, setDeviceId] = useState("");
  const state = query.data;
  const plan = state?.plans.find(item => item.id === selectedPlan) ?? null;
  const devices = state ? [...state.devices, ...state.accounts.filter(account => !state.devices.some(device => device.id === account.device_id)).map(account => ({ id: account.device_id, name: account.device_id }))] : [];
  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-2"><h1 className="text-xl font-semibold">月卡管理</h1><Button type="button" variant="secondary" disabled={query.loading || query.isRefreshing} onClick={() => { void query.refresh().catch(() => {}); }}>刷新</Button></div>
    <Card title="计费与有效期规则"><MonthlyPassRules /></Card>
    {query.error && <p role="alert" className="text-sm text-rose-600">加载失败：{query.error.message}</p>}
    {query.loading && !state ? <Spinner text="正在加载月卡管理…" /> : state && <>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="套餐列表（无删除，仅停用）" action={<Button type="button" size="sm" disabled={query.isRefreshing} onClick={() => { setSelectedPlan(null); setFormRevision(previous => previous + 1); }}>新建套餐</Button>}>
          {!state.plans.length ? <Empty text="暂无套餐，请创建至少一个启用套餐。" /> : <ul className="space-y-3">{state.plans.map(item => <li key={item.id} className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"><div className="flex items-center justify-between gap-2"><span className="font-medium text-sm">{item.name}</span><Badge tone={item.enabled ? "green" : "slate"}>{item.enabled ? "启用" : "停用"}</Badge></div><p className="text-xs text-slate-500">{monthlyLimitFields.map(([key, label]) => label + " " + monthlyPassMoney(item.limits[key])).join(" · ")}</p><Button type="button" size="sm" variant="secondary" disabled={query.isRefreshing} onClick={() => { setSelectedPlan(item.id); setFormRevision(previous => previous + 1); }}>编辑 / 停用</Button></li>)}</ul>}
        </Card>
        <Card title={plan ? "编辑套餐：" + plan.name : "新建套餐"}><fieldset disabled={!!query.error || query.isRefreshing}><MonthlyPassPlanForm key={(selectedPlan ?? "new") + ":" + formRevision} plan={plan} groups={state.groups} onSaved={async () => { await query.refresh(); }} /></fieldset></Card>
      </div>
      <Card title="账户月卡">
        <div className="space-y-4"><label className="block space-y-1 text-xs"><span>选择账户 / 设备</span><Select value={deviceId} onChange={event => setDeviceId(event.target.value)}><option value="">请选择账户</option>{devices.map(device => <option key={device.id} value={device.id}>{device.name}（{device.id}）</option>)}</Select></label>
          {deviceId ? <AccountEditor key={deviceId} deviceId={deviceId} plans={state.plans} onChanged={() => { void query.refresh(true).catch(() => {}); }} /> : <Empty text="选择账户后可开通、停用、续期或设置钱包兜底。" />}
        </div>
      </Card>
      <Card title="账户列表"><AccountList accounts={state.accounts} devices={devices} onSelect={setDeviceId} /></Card>
    </>}
  </div>;
}
export function AccountList({ accounts, devices, onSelect }: { accounts: MonthlyAccount[]; devices: Choice[]; onSelect: (id: string) => void }) {
  return !accounts.length ? <Empty text="暂无月卡账户记录；可在上方选择设备开通。" /> : <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{["账户", "套餐", "状态", "钱包兜底", "操作"].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{accounts.map(account => <tr key={account.device_id} className="border-t border-slate-100 dark:border-slate-800"><td className="p-2">{devices.find(device => device.id === account.device_id)?.name ?? account.device_id}</td><td className="p-2">{account.subscription?.plan_name ?? "—"}</td><td className="p-2">{monthlyPassStatus(account.subscription)}</td><td className="p-2">{account.wallet_fallback ? "已开启" : "已关闭"}</td><td className="p-2"><Button type="button" size="sm" variant="ghost" onClick={() => onSelect(account.device_id)}>管理</Button></td></tr>)}</tbody></table></div>;
}
