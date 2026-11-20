import type { ReactNode } from "react";
import { Card, CopyButton } from "./ui";

const FALLBACK_BASE = "http://127.0.0.1:8787";

/**
 * The console is served by the same Worker as the /v1 gateway, so in a browser the page origin is
 * the gateway address users must configure. Outside a browser (SSR, tests) the local default is used.
 */
export function gatewayBase(): string {
  try {
    const origin = typeof window !== "undefined" ? window.location?.origin : undefined;
    if (origin && /^https?:\/\/[^/]+$/.test(origin)) return origin;
  } catch {
    // fall through to the local default
  }
  return FALLBACK_BASE;
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">{children}</code>;
}

export function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/40">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</div>
        <CopyButton text={value} label="复制" className="-mr-1 shrink-0 rounded-md px-1.5 py-0.5 text-slate-500 hover:bg-white hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-white" />
      </div>
      <div className="break-all font-mono text-[13px] leading-5 text-slate-900 dark:text-slate-100">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{hint}</div> : null}
    </div>
  );
}

/** The three address forms apps ask for, with copy buttons. Also shown on the overview. */
export function ConsoleAccessCard({ onOpenGuide }: { onOpenGuide?: () => void }) {
  const base = gatewayBase();
  const rows = [
    { label: "OpenAI 兼容 Base URL", value: base + "/v1", hint: "OpenAI SDK、Codex CLI" },
    { label: "根地址", value: base, hint: "Anthropic SDK、Claude Code、Cherry Studio、Chatbox" },
    { label: "完整对话地址", value: base + "/v1/chat/completions", hint: "沉浸式翻译等要求完整 URL 的应用" },
  ];
  return <Card title="接入地址" action={onOpenGuide ? <button type="button" onClick={onOpenGuide} className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">接入指南 →</button> : undefined}>
    <div className="space-y-2">
      {rows.map((row) => <CopyRow key={row.label} {...row} />)}
    </div>
    <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
      鉴权请求头 <Mono>Authorization: Bearer &lt;API 密钥&gt;</Mono>，Anthropic 客户端也可用 <Mono>x-api-key</Mono>。
    </p>
  </Card>;
}
