import { useEffect, useRef, useState } from "react";
import {
  consoleMonthlyPassApi, monthlyLimitFields, monthlyPassMoney, monthlyPassStatus, monthlyPassTime,
  monthlyWindowLabels, WALLET_FALLBACK_CONFIRMATION, type MonthlyAccount,
} from "../api/monthlyPasses";
import { useQuery } from "../hooks/useQuery";
import { Badge, Button, Empty, Spinner } from "./ui";
import { useToast } from "./Toast";

export function MonthlyPassSummary({ account }: { account: MonthlyAccount }) {
  const subscription = account.subscription;
  const status = monthlyPassStatus(subscription);
  return <div className="space-y-3 text-sm">
    <div className="flex flex-wrap items-center gap-2"><Badge tone={status === "有效" ? "green" : "amber"}>{status}</Badge>
      <span>{subscription?.plan_name ?? "暂无月卡"}</span><span className="text-xs text-slate-500">账户：{account.device_id}</span></div>
    {subscription && <>
      <p className="text-xs text-slate-500 break-all">订阅 ID：{subscription.id} · 套餐 ID：{subscription.plan_id}</p>
      <dl className="grid gap-2 text-xs sm:grid-cols-2"><div><dt>生效时间</dt><dd>{monthlyPassTime(subscription.starts_at)}</dd></div><div><dt>到期时间</dt><dd>{monthlyPassTime(subscription.expires_at)}</dd></div></dl>
      <p className="text-xs">套餐限额：{monthlyLimitFields.map(([key, label]) => label + " " + monthlyPassMoney(subscription.limits[key])).join(" · ")}</p>
      <p className="text-xs break-all">可计费服务分组：{subscription.service_group_ids === null ? "不额外限制（仍须原有路由授权）" : subscription.service_group_ids.length ? subscription.service_group_ids.join("、") : "无"}</p>
      {!subscription.windows.length ? <Empty text="暂无已建立的额度桶；5 小时桶从首请求开始建立。" /> : <div className="overflow-x-auto"><table className="w-full text-left text-xs"><caption className="sr-only">月卡额度桶（网关计费金额）</caption>
        <thead><tr>{["额度桶", "限额", "已用", "预占", "剩余", "窗口开始", "窗口结束"].map(label => <th className="p-2 whitespace-nowrap" key={label}>{label}</th>)}</tr></thead>
        <tbody>{subscription.windows.map(window => <tr key={window.kind + ":" + window.starts_at} className="border-t border-slate-100 dark:border-slate-800">
          <td className="p-2 whitespace-nowrap">{monthlyWindowLabels[window.kind] ?? window.kind}</td><td className="p-2">{monthlyPassMoney(window.limit_usd)}</td><td className="p-2">{monthlyPassMoney(window.used_usd)}</td><td className="p-2">{monthlyPassMoney(window.reserved_usd)}</td>
          <td className={"p-2 whitespace-nowrap " + (window.remaining_usd < 0 ? "text-rose-600 font-semibold" : "")}>{monthlyPassMoney(window.remaining_usd)}{window.remaining_usd < 0 && "（已超额）"}</td>
          <td className="p-2 whitespace-nowrap">{monthlyPassTime(window.starts_at)}</td><td className="p-2 whitespace-nowrap">{monthlyPassTime(window.ends_at)}</td>
        </tr>)}</tbody></table></div>}
    </>}
    <p className="text-xs">钱包兜底：<strong>{account.wallet_fallback ? "已开启" : "已关闭（默认）"}</strong></p>
  </div>;
}
export function MonthlyPassRules() {
  return <div className="space-y-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
    <p>月卡有效期 30 天，不自动付款。仅 Chat / Responses / Messages 文本请求适用；图片、视频、向量仍按原钱包计费。</p>
    <p>每日北京时间 00:00、每周一 00:00 重置；5 小时为首请求开始的固定窗口，不是滚动窗口。</p>
    <p>实际费用超出预估时整笔记入月卡，剩余可为负数，不暗扣钱包；无可用月卡且显式开启兜底后，整笔请求才走钱包。</p>
    <p>有效期内续期增加 30 天，不清空额度桶；过期后续期建立新周期、新订阅 ID。停用仅停止月卡权益；开通月卡不会授予路由权限。</p>
  </div>;
}
export function MonthlyPassWalletControl({ enabled, disabled = false, onSave }: {
  enabled: boolean; disabled?: boolean; onSave: (enabled: boolean, confirmed: boolean) => Promise<unknown>;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save(next: boolean, confirmed = false) {
    setBusy(true); setError("");
    try {
      await onSave(next, confirmed);
      if (!mounted.current) return;
      setConfirming(false); toast.success("钱包兜底已更新");
    } catch (err) {
      if (!mounted.current) return;
      const message = err instanceof Error ? err.message : "保存失败";
      setError(message); toast.error(message);
    } finally { if (mounted.current) setBusy(false); }
  }
  return <div className="space-y-2">
    <p className="text-xs text-slate-500">默认关闭。开启会允许无可用月卡的整笔请求消耗钱包余额。</p>
    {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
    {!enabled && confirming ? <div role="alert" className="space-y-2 rounded-lg border border-amber-300 p-3 text-xs text-amber-800 dark:text-amber-300">
      <p>{WALLET_FALLBACK_CONFIRMATION}</p><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="warning" disabled={disabled || busy} onClick={() => void save(true, true)}>确认开启钱包兜底</Button><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>取消</Button></div>
    </div> : <Button type="button" size="sm" variant="secondary" disabled={disabled || busy} onClick={() => enabled ? void save(false) : setConfirming(true)}>{busy ? "保存中…" : enabled ? "关闭钱包兜底" : "开启钱包兜底…"}</Button>}
  </div>;
}
function ScopedMonthlyPass({ scope, onChange }: { scope: string; onChange?: () => void }) {
  const query = useQuery("console:" + scope + ":monthly-pass", consoleMonthlyPassApi.account, { ttlMs: 0 });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save(enabled: boolean, confirmed: boolean) {
    const result = await consoleMonthlyPassApi.walletFallback(enabled, confirmed);
    if (!mounted.current) return;
    query.mutate(result); onChange?.();
  }
  return <section className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800" aria-label="月卡">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">月卡</h3><Button type="button" size="sm" variant="ghost" disabled={query.loading || query.isRefreshing} onClick={() => { void query.refresh().catch(() => {}); }}>刷新</Button></div>
    <MonthlyPassRules />
    {query.error && <p role="alert" className="text-sm text-rose-600">月卡加载失败：{query.error.message}</p>}
    {query.loading && !query.data ? <Spinner text="正在加载月卡…" /> : query.data && <>
      <MonthlyPassSummary account={query.data.item} />
      {query.data.item.subscription && <MonthlyPassWalletControl key={query.data.item.device_id} enabled={query.data.item.wallet_fallback} disabled={!!query.error || query.isRefreshing} onSave={save} />}
    </>}
  </section>;
}
export default function ConsoleMonthlyPass({ scope, onChange }: { scope: string; onChange?: () => void }) {
  return <ScopedMonthlyPass key={scope} scope={scope} onChange={onChange} />;
}
