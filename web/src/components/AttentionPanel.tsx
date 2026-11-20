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

export interface SetupStep {
  key: string;
  done: boolean;
  text: string;
  hint: string;
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

/** First-run checklist. Renders nothing once every step is done. */
export function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  const doneCount = steps.filter(step => step.done).length;
  if (!steps.length || doneCount === steps.length) return null;
  const next = steps.find(step => !step.done);
  return <section aria-labelledby="setup-heading" className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-card dark:border-slate-800 dark:bg-slate-900 dark:shadow-none sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 id="setup-heading" className="text-sm font-semibold text-slate-900 dark:text-slate-100">开站清单</h3>
        <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">按顺序完成这几步，用户就能正常调用。全部完成后这里会自动隐藏。</p>
      </div>
      <span className="text-xs font-medium tabular-nums text-slate-500 dark:text-slate-400">已完成 {doneCount} / {steps.length}</span>
    </div>
    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="progressbar" aria-label="开站进度"
      aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount}>
      <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
    </div>
    <ol className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
      {steps.map((step, index) => {
        const current = step === next;
        return <li key={step.key}>
          <Link to={step.link} aria-current={current ? "step" : undefined}
            className={"flex h-full items-start gap-3 rounded-xl border p-3 text-left transition-colors " + (current
              ? "border-brand-300 bg-brand-50/60 hover:bg-brand-50 dark:border-brand-700 dark:bg-brand-500/10"
              : step.done
              ? "border-slate-200/70 text-slate-400 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
              : "border-slate-200/70 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50")}>
            <span aria-hidden="true" className={"flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold " + (step.done
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
              : current ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400")}>
              {step.done ? "✓" : index + 1}
            </span>
            <span className="min-w-0">
              <span className={"block text-sm font-medium " + (step.done ? "line-through decoration-slate-300 dark:decoration-slate-600" : "text-slate-900 dark:text-slate-100")}>
                {step.text}<span className="sr-only">{step.done ? "（已完成）" : "（未完成）"}</span>
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">{step.hint}</span>
            </span>
          </Link>
        </li>;
      })}
    </ol>
  </section>;
}

export function AttentionPanel() {
  const load = useCallback(() => api.get<{ items: AttentionItem[]; setup?: SetupStep[] }>("/api/attention"), []);
  const { data, error } = useQuery("admin-attention", load, { ttlMs: 30_000 });
  return <>
    {data?.setup ? <SetupChecklist steps={data.setup} /> : null}
    <section aria-labelledby="attention-heading" className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-card dark:border-slate-800 dark:bg-slate-900 dark:shadow-none sm:p-5">
      <h3 id="attention-heading" className="mb-2.5 text-sm font-semibold text-slate-900 dark:text-slate-100">需要处理</h3>
      {data ? <AttentionList items={data.items} />
        : error ? <p role="alert" className="text-sm text-rose-600">读取失败：{error.message}</p>
        : <p className="text-sm text-slate-400">正在检查…</p>}
    </section>
  </>;
}
