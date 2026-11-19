import { useCallback, useMemo, useState } from "react";
import { api, fmtTime } from "../api/client";
import type { DeviceItem } from "../types";
import { useQuery } from "../hooks/useQuery";
import { Badge, Button, Drawer, Empty, Spinner } from "./ui";

interface AccessPrice {
  pricing_mode: "free" | "priced";
  billing_unit: "token" | "call";
  input_price_per_m: number;
  output_price_per_m: number;
  price_per_call: number;
  multiplier: number;
}
export interface AccountAccessReport {
  device_id: string;
  issues: { key: string; level: "block" | "warn"; text: string; fix: string }[];
  monthly_pass: null | { plan_name: string; enabled: boolean; expires_at: number; active: boolean };
  wallet: { balance_usd: number; reserved_usd: number; available_usd: number };
  month_cost_usd: number;
  cost_limit_monthly: number;
  models: { name: string; display_name: string | null; available: boolean; reason: string | null; service_group: string | null; price: AccessPrice | null }[];
  truncated: boolean;
  checked_at: number;
}

const yuan = (value: number, digits = 2) => (value < 0 ? "-" : "") + "¥" + Math.abs(value).toFixed(digits);
const num = (value: number) => String(Number(value.toFixed(6)));

export function priceText(price: AccessPrice | null): string {
  if (!price) return "—";
  if (price.pricing_mode === "free") return "免费";
  const base = price.billing_unit === "call"
    ? "¥" + num(price.price_per_call) + " / 次"
    : price.output_price_per_m > 0
      ? "¥" + num(price.input_price_per_m) + " / ¥" + num(price.output_price_per_m) + " 每百万 Token"
      : "¥" + num(price.input_price_per_m) + " 每百万输入 Token";
  return price.multiplier !== 1 ? base + "（含 ×" + num(price.multiplier) + "）" : base;
}

export function routingText(d: Pick<DeviceItem, "routing_policy_mode" | "selected_service_group_name" | "routing_group_ids">): string {
  switch (d.routing_policy_mode) {
    case "fixed": return "固定分组：" + (d.selected_service_group_name || "未命名分组");
    case "auto": return "自动选择分组";
    case "multi": return "按模型使用 " + (d.routing_group_ids?.length || 0) + " 个分组";
    case "legacy": case undefined: return "默认路由（不经过服务分组）";
    default: return "路由配置异常";
  }
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "red" | "amber" }) {
  return <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/40">
    <div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div>
    <div className={"mt-0.5 text-sm font-semibold " + (tone === "red" ? "text-rose-600 dark:text-rose-400" : tone === "amber" ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-slate-100")}>{value}</div>
  </div>;
}

export function AccountAccessView({ device, report, onlyBlocked, onToggleOnlyBlocked }: {
  device: DeviceItem;
  report: AccountAccessReport;
  onlyBlocked: boolean;
  onToggleOnlyBlocked: (value: boolean) => void;
}) {
  const usable = report.models.filter(m => m.available).length;
  const blocked = report.issues.filter(i => i.level === "block");
  const rows = onlyBlocked ? report.models.filter(m => !m.available) : report.models;
  const limit = report.cost_limit_monthly;
  const pass = report.monthly_pass;
  return <div className="space-y-5">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <Fact label="可用余额" value={yuan(report.wallet.available_usd, 4)} tone={report.wallet.available_usd <= 0 ? "red" : undefined} />
      <Fact label="本月花费 / 上限" value={yuan(report.month_cost_usd) + " / " + (limit > 0 ? yuan(limit) : "不限")} tone={limit > 0 && report.month_cost_usd >= limit ? "red" : undefined} />
      <Fact label="月卡" value={pass ? (pass.active ? pass.plan_name + " · " + fmtTime(pass.expires_at) + " 到期" : pass.plan_name + "（未生效）") : "未开通"} tone={pass && !pass.active ? "amber" : undefined} />
      <Fact label="路由方式" value={routingText(device)} />
      <Fact label="限流" value={device.rate_limit_rpm ? device.rate_limit_rpm + " 次/分" : "不限"} />
      <Fact label="能调用的模型" value={usable + " / " + report.models.length} tone={usable === 0 ? "red" : undefined} />
    </div>

    <section aria-label="账户检查" className="space-y-2">
      {report.issues.length === 0 ? (
        <div className="rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">账户正常，可以发起调用。</div>
      ) : report.issues.map(issue => (
        <div key={issue.key} role={issue.level === "block" ? "alert" : undefined} className={"rounded-xl px-3 py-2.5 text-sm " + (issue.level === "block"
          ? "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
          : "bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300")}>
          <span className="font-semibold">{issue.text}</span><span className="ml-1 opacity-90">{issue.fix}</span>
        </div>
      ))}
      {blocked.length ? <p className="text-xs text-slate-500 dark:text-slate-400">上面的问题会挡住所有模型；下表只按权限和价格判断。</p> : null}
    </section>

    <section aria-label="可调用模型" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">能调用哪些模型（主 Token）</h4>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <input type="checkbox" checked={onlyBlocked} onChange={e => onToggleOnlyBlocked(e.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300" />
          只看不能用的
        </label>
      </div>
      {rows.length ? <div className="overflow-x-auto rounded-xl border border-slate-100 dark:border-slate-800">
        <table className="w-full min-w-[520px] text-left text-xs">
          <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
            <tr><th scope="col" className="px-3 py-2 font-medium">模型</th><th scope="col" className="px-3 py-2 font-medium">能否调用</th><th scope="col" className="px-3 py-2 font-medium">经过分组</th><th scope="col" className="px-3 py-2 font-medium">单价</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map(m => <tr key={m.name}>
              <td className="px-3 py-2"><div className="font-mono text-slate-900 dark:text-slate-100">{m.name}</div>{m.display_name && m.display_name !== m.name ? <div className="text-[11px] text-slate-400">{m.display_name}</div> : null}</td>
              <td className="px-3 py-2">{m.available ? <Badge tone="green">可以</Badge> : <div className="space-y-0.5"><Badge tone="red">不能</Badge><div className="text-[11px] text-slate-500 dark:text-slate-400">{m.reason}</div></div>}</td>
              <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{m.available ? (m.service_group || "默认路由") : "—"}</td>
              <td className="px-3 py-2 font-mono text-slate-700 dark:text-slate-300">{m.available ? priceText(m.price) : "—"}</td>
            </tr>)}
          </tbody>
        </table>
      </div> : <Empty text={onlyBlocked ? "所有模型都能调用" : "还没有启用的模型"} />}
      {report.truncated ? <p className="text-xs text-slate-500">模型太多，只检查了前 300 个名称。</p> : null}
      <p className="text-xs text-slate-400 dark:text-slate-500">价格已含服务分组倍率和当前峰谷倍率。检查时间 {fmtTime(report.checked_at)}。</p>
    </section>
  </div>;
}

export function AccountDetailDrawer({ device, onClose, onTopup, onEdit, onScope, onSubTokens }: {
  device: DeviceItem | null;
  onClose: () => void;
  onTopup: (d: DeviceItem) => void;
  onEdit: (d: DeviceItem) => void;
  onScope: (d: DeviceItem) => void;
  onSubTokens: (d: DeviceItem) => void;
}) {
  const [onlyBlocked, setOnlyBlocked] = useState(false);
  const id = device?.id ?? null;
  const load = useCallback(() => api.get<AccountAccessReport>("/api/devices/" + encodeURIComponent(id!) + "/access"), [id]);
  const { data, loading, error, refresh } = useQuery(id ? "device-access:" + id : null, load, { enabled: Boolean(id), ttlMs: 5000 });
  const report = data && data.device_id === id ? data : null;
  const title = useMemo(() => device ? "账户详情 · " + device.name : "账户详情", [device]);
  return <Drawer open={Boolean(device)} onClose={onClose} title={title} width="max-w-3xl">
    {device ? <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-slate-400">ID: {device.id}</span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {!device.revoked_at ? <>
            <Button size="sm" onClick={() => onTopup(device)}>充值</Button>
            <Button size="sm" variant="secondary" onClick={() => onEdit(device)}>改限额</Button>
            <Button size="sm" variant="secondary" onClick={() => onScope(device)}>模型范围</Button>
            <Button size="sm" variant="secondary" onClick={() => onSubTokens(device)}>子 Token</Button>
          </> : null}
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>重新检查</Button>
        </div>
      </div>
      {report ? <AccountAccessView device={device} report={report} onlyBlocked={onlyBlocked} onToggleOnlyBlocked={setOnlyBlocked} />
        : error ? <div role="alert" className="rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">检查失败：{error.message}。请点「重新检查」。</div>
        : <Spinner text="正在检查这个账户能调用哪些模型…" />}
    </div> : null}
  </Drawer>;
}
