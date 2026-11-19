import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AdminListToolbar } from "../components/AdminListToolbar";
import { useAdminFilters } from "../hooks/useAdminFilters";
import { api } from "../api/client";
import { readPendingMonthlyAction, runMonthlyAction, type MonthlyAction } from "../api/monthlyPassActions";
import {
  monthlyPassesApi, monthlyLimitFields, monthlyLimitFromText, monthlyPassMoney, monthlyPassStatus, monthlyPassTime,
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
export const monthlyFilterDefaults = { q: "", enabled: "", sort: "", account_q: "", account_enabled: "", account_sort: "", plan: "", status: "", expiry: "", expiry_sort: "" };
const dayMs = 86_400_000;
export function filterMonthlyPlans(plans: MonthlyPlan[], filters: Record<string, string>) {
  const q = filters.q.trim().toLocaleLowerCase();
  const result = plans.filter(plan => (!q || (plan.name + " " + plan.id).toLocaleLowerCase().includes(q)) && (!filters.enabled || String(plan.enabled) === filters.enabled));
  if (filters.sort === "name" || filters.sort === "name-desc") result.sort((a, b) => (a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) * (filters.sort === "name-desc" ? -1 : 1));
  return result;
}
export function filterMonthlyAccounts(accounts: MonthlyAccount[], devices: Choice[], filters: Record<string, string>, now: number) {
  const names = new Map(devices.map(device => [device.id, device.name]));
  const name = (account: MonthlyAccount) => names.get(account.device_id) ?? account.device_id;
  const q = filters.account_q.trim().toLocaleLowerCase();
  const result = accounts.filter(account => {
    const sub = account.subscription;
    if (q && !(name(account) + " " + account.device_id + " " + (sub?.plan_name ?? "")).toLocaleLowerCase().includes(q)) return false;
    if (filters.account_enabled && (!sub || String(sub.enabled) !== filters.account_enabled)) return false;
    if (filters.plan && sub?.plan_id !== filters.plan) return false;
    if (filters.status && monthlyPassStatus(sub, now) !== filters.status) return false;
    if (filters.expiry === "none") return !sub;
    if (filters.expiry === "expired") return !!sub && sub.expires_at <= now;
    if (filters.expiry === "7d" || filters.expiry === "30d") return !!sub && sub.expires_at > now && sub.expires_at <= now + (filters.expiry === "7d" ? 7 : 30) * dayMs;
    return true;
  });
  if (filters.expiry_sort === "asc" || filters.expiry_sort === "desc") result.sort((a, b) => {
    if (!a.subscription || !b.subscription) return Number(!a.subscription) - Number(!b.subscription) || a.device_id.localeCompare(b.device_id);
    return (a.subscription.expires_at - b.subscription.expires_at) * (filters.expiry_sort === "desc" ? -1 : 1) || a.device_id.localeCompare(b.device_id);
  });
  else if (filters.account_sort === "name" || filters.account_sort === "name-desc") result.sort((a, b) => (name(a).localeCompare(name(b)) || a.device_id.localeCompare(b.device_id)) * (filters.account_sort === "name-desc" ? -1 : 1));
  return result;
}
export default function MonthlyPassesPage() {
  const [filters, setFilter, resetFilters] = useAdminFilters(monthlyFilterDefaults);
  const query = useQuery("admin:monthly-passes", loadOverview, { ttlMs: 0 });
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const [deviceId, setDeviceId] = useState("");
  const state = query.data;
  const plan = state?.plans.find(item => item.id === selectedPlan) ?? null;
  const devices = useMemo(() => {
    if (!state) return [];
    const byId = new Map(state.devices.map(device => [device.id, device]));
    for (const account of state.accounts) if (!byId.has(account.device_id)) byId.set(account.device_id, { id: account.device_id, name: account.device_id });
    return [...byId.values()];
  }, [state]);
  const visiblePlans = useMemo(() => filterMonthlyPlans(state?.plans ?? [], filters), [state?.plans, filters]);
  const visibleAccounts = filterMonthlyAccounts(state?.accounts ?? [], devices, filters, Date.now());
  const accountFilters = { q: filters.account_q, enabled: filters.account_enabled, sort: filters.account_sort };
  const accountPlanChoices = new Map((state?.plans ?? []).map(item => [item.id, item.name]));
  for (const account of state?.accounts ?? []) if (account.subscription && !accountPlanChoices.has(account.subscription.plan_id)) accountPlanChoices.set(account.subscription.plan_id, account.subscription.plan_name);
  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-2"><h1 className="text-xl font-semibold">月卡管理</h1><Button type="button" variant="secondary" disabled={query.loading || query.isRefreshing} onClick={() => { void query.refresh().catch(() => {}); }}>刷新</Button></div>
    <Card title="计费与有效期规则"><MonthlyPassRules /></Card>
    {query.error && <p role="alert" className="text-sm text-rose-600">加载失败：{query.error.message}</p>}
    {query.loading && !state ? <Spinner text="正在加载月卡管理…" /> : state && <>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="套餐列表（无删除，仅停用）" action={<Button type="button" size="sm" disabled={query.isRefreshing} onClick={() => { setSelectedPlan(null); setFormRevision(previous => previous + 1); }}>新建套餐</Button>}>
          <AdminListToolbar filters={filters} onChange={setFilter} onReset={resetFilters} total={state.plans.length} count={visiblePlans.length} searchPlaceholder="套餐名称 / ID" />
          <p className="my-2 text-xs text-slate-500">全部套餐的本地筛选；筛选不会切换或清空右侧编辑草稿。</p>
          {!state.plans.length ? <Empty text="暂无套餐，请创建至少一个启用套餐。" /> : !visiblePlans.length ? <Empty text="没有匹配套餐，请调整或清空筛选。" /> : <ul className="space-y-3">{visiblePlans.map(item => <li key={item.id} className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"><div className="flex items-center justify-between gap-2"><span className="font-medium text-sm">{item.name}</span><Badge tone={item.enabled ? "green" : "slate"}>{item.enabled ? "启用" : "停用"}</Badge></div><p className="text-xs text-slate-500">{monthlyLimitFields.map(([key, label]) => label + " " + monthlyPassMoney(item.limits[key])).join(" · ")}</p><Button type="button" size="sm" variant="secondary" disabled={query.isRefreshing} onClick={() => { setSelectedPlan(item.id); setFormRevision(previous => previous + 1); }}>编辑 / 停用</Button></li>)}</ul>}
        </Card>
        <Card title={plan ? "编辑套餐：" + plan.name : "新建套餐"}><fieldset disabled={!!query.error || query.isRefreshing}><MonthlyPassPlanForm key={(selectedPlan ?? "new") + ":" + formRevision} plan={plan} groups={state.groups} onSaved={async () => { await query.refresh(); }} /></fieldset></Card>
      </div>
      <Card title="账户月卡">
        <div className="space-y-4"><label className="block space-y-1 text-xs"><span>选择账户 / 设备</span><Select value={deviceId} onChange={event => setDeviceId(event.target.value)}><option value="">请选择账户</option>{devices.map(device => <option key={device.id} value={device.id}>{device.name}（{device.id}）</option>)}</Select></label>
          {deviceId ? <AccountEditor key={deviceId} deviceId={deviceId} plans={state.plans} onChanged={() => { void query.refresh(true).catch(() => {}); }} /> : <Empty text="选择账户后可开通、停用、续期或设置钱包兜底。" />}
        </div>
      </Card>
      <Card title="账户列表">
        <AdminListToolbar filters={accountFilters} onChange={(key, value) => { setFilter("account_" + key, value); if (key === "sort") setFilter("expiry_sort", ""); }} onReset={resetFilters} total={state.accounts.length} count={visibleAccounts.length} searchPlaceholder="账户名称 / ID / 套餐名称">
          <Select aria-label="账户套餐" className="!w-auto" value={filters.plan} onChange={event => setFilter("plan", event.target.value)}><option value="">全部套餐</option>{[...accountPlanChoices].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select>
          <Select aria-label="月卡状态" className="!w-auto" value={filters.status} onChange={event => setFilter("status", event.target.value)}><option value="">全部月卡状态</option>{["未开通", "已停用", "已过期", "未生效", "额度不足", "有效"].map(status => <option key={status} value={status}>{status}</option>)}</Select>
          <Select aria-label="到期范围" className="!w-auto" value={filters.expiry} onChange={event => setFilter("expiry", event.target.value)}><option value="">全部到期范围</option><option value="7d">未来 7 天内到期</option><option value="30d">未来 30 天内到期</option><option value="expired">已到期</option><option value="none">无月卡</option></Select>
          <Select aria-label="到期排序" className="!w-auto" value={filters.expiry_sort} onChange={event => { setFilter("expiry_sort", event.target.value); setFilter("account_sort", ""); }}><option value="">不按到期排序</option><option value="asc">到期时间升序</option><option value="desc">到期时间降序</option></Select>
        </AdminListToolbar>
        <p className="my-2 text-xs text-slate-500">全部月卡账户记录的本地筛选（不含尚无月卡记录的设备）；启用状态指月卡权益，不是设备状态。到期范围按当前时间计算，不自动轮询；额度状态来自上次读取。清空筛选重置两张列表，不影响账户选择或编辑草稿。</p>
        {!visibleAccounts.length && state.accounts.length ? <Empty text="没有匹配账户，请调整或清空筛选。" /> : <AccountList accounts={visibleAccounts} devices={devices} onSelect={setDeviceId} />}
      </Card>
    </>}
  </div>;
}
export function AccountList({ accounts, devices, onSelect }: { accounts: MonthlyAccount[]; devices: Choice[]; onSelect: (id: string) => void }) {
  const names = new Map(devices.map(device => [device.id, device.name]));
  return !accounts.length ? <Empty text="暂无月卡账户记录；可在上方选择设备开通。" /> : <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{["账户", "套餐", "状态", "到期时间", "钱包兜底", "操作"].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{accounts.map(account => <tr key={account.device_id} className="border-t border-slate-100 dark:border-slate-800"><td className="p-2">{names.get(account.device_id) ?? account.device_id}</td><td className="p-2">{account.subscription?.plan_name ?? "—"}</td><td className="p-2">{monthlyPassStatus(account.subscription)}</td><td className="p-2">{account.subscription ? monthlyPassTime(account.subscription.expires_at) : "—"}</td><td className="p-2">{account.wallet_fallback ? "已开启" : "已关闭"}</td><td className="p-2"><Button type="button" size="sm" variant="ghost" onClick={() => onSelect(account.device_id)}>管理</Button></td></tr>)}</tbody></table></div>;
}
