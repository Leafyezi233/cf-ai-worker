import { useState } from "react";
import type { ConsoleUsage } from "../api/consoleClient";
import { Card } from "./ui";

type Day = ConsoleUsage["daily"][number];
export type TrendMetric = "cost" | "requests" | "tokens";

const DAY_MS = 86_400_000;
/** The usage API groups days in UTC+8. */
const DAY_OFFSET_MS = 8 * 3_600_000;

/** One row per calendar day from `from` to `to`, with days that had no calls filled with zeros. */
export function fillDailyUsage(daily: readonly Day[], from: number, to: number): Day[] {
  const byDate = new Map(daily.map((row) => [row.date, row]));
  const first = Math.floor((from + DAY_OFFSET_MS) / DAY_MS);
  const last = Math.floor((to + DAY_OFFSET_MS) / DAY_MS);
  const out: Day[] = [];
  for (let day = first; day <= last && out.length < 400; day++) {
    const date = new Date(day * DAY_MS).toISOString().slice(0, 10);
    const row = byDate.get(date);
    out.push({ date, request_count: Number(row?.request_count ?? 0), total_tokens: Number(row?.total_tokens ?? 0), cost_usd: Number(row?.cost_usd ?? 0) });
  }
  return out;
}

/** Rounds an axis maximum up to 1, 2, 2.5 or 5 times a power of ten. */
export function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

function compact(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, "") + " 亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, "") + " 万";
  return n.toLocaleString();
}

function yuan(n: number): string {
  return "¥" + n.toFixed(n === 0 ? 0 : n >= 100 ? 0 : n >= 1 ? 2 : 4);
}

const METRICS: { key: TrendMetric; label: string; value: (day: Day) => number; format: (n: number) => string }[] = [
  { key: "cost", label: "花费", value: (day) => day.cost_usd, format: yuan },
  { key: "requests", label: "请求数", value: (day) => day.request_count, format: compact },
  { key: "tokens", label: "Token", value: (day) => day.total_tokens, format: compact },
];

const shortDate = (date: string) => date.slice(5).replace("-", "/");

/** Daily bars for the selected usage range: one metric at a time, hover for the exact value. */
export function UsageTrend({ daily, from, to }: { daily: readonly Day[]; from: number; to: number }) {
  const [metricKey, setMetricKey] = useState<TrendMetric>("cost");
  const metric = METRICS.find((item) => item.key === metricKey) ?? METRICS[0];
  const days = fillDailyUsage(daily, from, to);
  const values = days.map(metric.value);
  const total = values.reduce((sum, v) => sum + v, 0);
  const peak = Math.max(0, ...values);
  const top = niceCeiling(peak);
  const peakDay = days[values.indexOf(peak)];
  const labelAt = new Set([0, Math.floor((days.length - 1) / 2), days.length - 1]);

  return <Card title="每日趋势" action={
    <div role="tablist" aria-label="趋势指标" className="inline-flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
      {METRICS.map((item) => <button key={item.key} type="button" role="tab" aria-selected={item.key === metric.key} onClick={() => setMetricKey(item.key)}
        className={"rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 " + (item.key === metric.key
          ? "bg-white text-slate-900 shadow-xs dark:bg-slate-700 dark:text-white"
          : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")}>{item.label}</button>)}
    </div>}>
    <div className="mb-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
      <span>合计 <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{metric.format(total)}</span></span>
      <span>日均 <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{metric.format(days.length ? total / days.length : 0)}</span></span>
      {peak > 0 && peakDay ? <span>最高 <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{metric.format(peak)}</span>（{shortDate(peakDay.date)}）</span> : null}
    </div>
    <div aria-hidden="true" className="flex gap-2">
      <div className="flex h-40 w-12 shrink-0 flex-col justify-between text-right text-[10px] tabular-nums leading-none text-slate-400 dark:text-slate-500">
        <span>{metric.format(top)}</span><span>{metric.format(top / 2)}</span><span>0</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative h-40">
          <div className="absolute inset-x-0 top-0 border-t border-dashed border-slate-100 dark:border-slate-800" />
          <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-slate-100 dark:border-slate-800" />
          <div className="absolute inset-x-0 bottom-0 border-t border-slate-200 dark:border-slate-700" />
          <div className="absolute inset-0 flex items-end">
            {days.map((day, index) => {
              const value = values[index];
              const pct = (value / top) * 100;
              const align = index < 3 ? "left-0" : index > days.length - 4 ? "right-0" : "left-1/2 -translate-x-1/2";
              return <div key={day.date} className="group relative flex h-full min-w-0 flex-1 items-end justify-center px-px">
                <div className={"w-full max-w-[1.75rem] rounded-t-[4px] transition-colors " + (value > 0 ? "bg-brand-500 group-hover:bg-brand-600 dark:bg-brand-400 dark:group-hover:bg-brand-300" : "bg-slate-200 dark:bg-slate-700")}
                  style={{ height: value > 0 ? `max(${pct}%, 3px)` : "2px" }} />
                <div className={"pointer-events-none absolute z-10 hidden whitespace-nowrap rounded-lg bg-slate-900 px-2 py-1 text-[11px] leading-4 text-white shadow-pop group-hover:block dark:bg-slate-700 " + align}
                  style={{ bottom: `calc(${Math.min(pct, 100)}% + 6px)` }}>
                  <div className="text-slate-300">{day.date}</div>
                  <div className="font-semibold tabular-nums">{metric.label} {metric.format(value)}</div>
                </div>
              </div>;
            })}
          </div>
        </div>
        <div className="mt-1.5 flex text-[10px] tabular-nums text-slate-400 dark:text-slate-500">
          {days.map((day, index) => <span key={day.date} className={"min-w-0 flex-1 " + (index === 0 ? "text-left" : index === days.length - 1 ? "text-right" : "text-center")}>
            {labelAt.has(index) ? <span className="whitespace-nowrap">{shortDate(day.date)}</span> : null}
          </span>)}
        </div>
      </div>
    </div>
    <table className="sr-only">
      <caption>每日{metric.label}</caption>
      <thead><tr><th scope="col">日期</th><th scope="col">{metric.label}</th></tr></thead>
      <tbody>{days.map((day, index) => <tr key={day.date}><td>{day.date}</td><td>{metric.format(values[index])}</td></tr>)}</tbody>
    </table>
  </Card>;
}
