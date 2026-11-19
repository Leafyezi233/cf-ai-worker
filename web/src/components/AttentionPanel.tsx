import { useCallback } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";

export interface AttentionItem {
  key: string;
  level: "block" | "warn";
  count: number;
  text: string;
  link: string;
}

export function AttentionList({ items }: { items: AttentionItem[] }) {
  if (!items.length) {
    return <p className="rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">没有需要处理的事项。</p>;
  }
  return <ul className="space-y-1.5">
    {items.map(item => (
      <li key={item.key}>
        <Link to={item.link} className={"flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors " + (item.level === "block"
          ? "bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/50"
          : "bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50")}>
          <span>{item.text}</span>
          <span aria-hidden="true" className="shrink-0 text-xs font-medium opacity-80">去处理 →</span>
        </Link>
      </li>
    ))}
  </ul>;
}

export function AttentionPanel() {
  const load = useCallback(() => api.get<{ items: AttentionItem[] }>("/api/attention"), []);
  const { data, error } = useQuery("admin-attention", load, { ttlMs: 30_000 });
  return <section aria-labelledby="attention-heading" className="rounded-2xl border border-slate-200/80 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
    <h3 id="attention-heading" className="mb-2.5 text-sm font-semibold text-slate-900 dark:text-slate-100">需要处理</h3>
    {data ? <AttentionList items={data.items} />
      : error ? <p role="alert" className="text-sm text-rose-600">读取失败：{error.message}</p>
      : <p className="text-sm text-slate-400">正在检查…</p>}
  </section>;
}
