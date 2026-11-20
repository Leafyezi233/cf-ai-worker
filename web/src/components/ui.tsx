import { useState, type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes, type ButtonHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { IconCheck, IconCopy } from "./icons";

export function Card({
  id,
  title,
  action,
  children,
  className = "",
}: {
  id?: string;
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div id={id} className={`bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/70 dark:border-slate-800 shadow-card dark:shadow-none overflow-hidden ${className}`}>
      {title || action ? (
        <div className="px-4 pt-4 sm:px-5 flex items-center justify-between gap-3 min-h-[2.25rem]">
          {title ? <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</div> : <div />}
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div className={title || action ? "px-4 pb-4 pt-3 sm:px-5 sm:pb-5" : "p-4 sm:p-5"}>{children}</div>
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "secondary" | "outline" | "success" | "warning";
  size?: "sm" | "md" | "lg";
}) {
  const sizeCls =
    size === "sm"
      ? "px-2.5 py-1.5 text-xs gap-1.5"
      : size === "lg"
      ? "px-4 py-2.5 text-base gap-2"
      : "px-3.5 py-2 text-sm gap-2";

  const variantCls =
    variant === "primary"
      ? "bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white shadow-xs"
      : variant === "danger"
      ? "bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white shadow-xs"
      : variant === "success"
      ? "bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white shadow-xs"
      : variant === "warning"
      ? "bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white shadow-xs"
      : variant === "secondary"
      ? "bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:active:bg-slate-600 dark:text-slate-200"
      : variant === "outline"
      ? "border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 text-slate-700 shadow-xs dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800 dark:text-slate-200"
      : "bg-transparent hover:bg-slate-100 text-slate-600 dark:hover:bg-slate-800 dark:text-slate-300";

  return (
    <button
      className={`inline-flex items-center justify-center font-medium rounded-lg transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-900 disabled:opacity-50 disabled:pointer-events-none touch-manipulation ${sizeCls} ${variantCls} ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/90 shadow-xs dark:shadow-none px-3 py-2 sm:py-1.5 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 transition-all focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/10 dark:focus:ring-brand-500/20 disabled:bg-slate-50 disabled:text-slate-400 dark:disabled:bg-slate-900/50 dark:disabled:text-slate-600 ${className}`}
      {...props}
    />
  );
}

export function Select({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/90 shadow-xs dark:shadow-none px-3 py-2 sm:py-1.5 text-sm text-slate-800 dark:text-slate-100 transition-all focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/10 dark:focus:ring-brand-500/20 disabled:bg-slate-50 dark:disabled:bg-slate-900/50 ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/90 shadow-xs dark:shadow-none px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 font-mono transition-all focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/10 dark:focus:ring-brand-500/20 disabled:bg-slate-50 dark:disabled:bg-slate-900/50 ${className}`}
      {...props}
    />
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  maxWidth = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: string;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/40 dark:bg-slate-950/70 backdrop-blur-[2px] animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className={`w-full ${maxWidth} max-h-[92vh] flex flex-col rounded-2xl bg-white dark:bg-slate-900 shadow-pop border border-slate-200/70 dark:border-slate-800 overflow-hidden transform transition-all animate-in zoom-in-95 duration-150`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 px-4 py-3 sm:px-5 sm:py-3.5 shrink-0">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-base">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="w-8 h-8 -mr-1.5 rounded-lg inline-flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="p-4 sm:p-5 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 dark:bg-slate-950/70 backdrop-blur-[2px] animate-in fade-in duration-150" onClick={onClose}>
      <div
        className={`absolute inset-y-0 right-0 w-full ${width} max-w-[92vw] flex flex-col bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-100 dark:border-slate-800 animate-in slide-in-from-right duration-200`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 px-4 py-3 sm:px-5 sm:py-3.5 shrink-0">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-base">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="w-8 h-8 -mr-1.5 rounded-lg inline-flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="p-4 sm:p-5 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  );
}

export function Badge({
  tone = "slate",
  children,
  dot = false,
  className = "",
  title,
}: {
  tone?: "green" | "red" | "slate" | "blue" | "amber" | "purple";
  children: ReactNode;
  dot?: boolean;
  className?: string;
  title?: string;
}) {
  const tones = {
    green: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20 dark:bg-emerald-950/50 dark:text-emerald-400 dark:ring-emerald-500/30",
    red: "bg-rose-50 text-rose-700 ring-1 ring-rose-600/20 dark:bg-rose-950/50 dark:text-rose-400 dark:ring-rose-500/30",
    slate: "bg-slate-100 text-slate-600 ring-1 ring-slate-400/20 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
    blue: "bg-brand-50 text-brand-700 ring-1 ring-brand-600/20 dark:bg-brand-950/50 dark:text-brand-400 dark:ring-brand-500/30",
    amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20 dark:bg-amber-950/50 dark:text-amber-400 dark:ring-amber-500/30",
    purple: "bg-purple-50 text-purple-700 ring-1 ring-purple-600/20 dark:bg-purple-950/50 dark:text-purple-400 dark:ring-purple-500/30",
  };

  const dots = {
    green: "bg-emerald-500",
    red: "bg-rose-500",
    slate: "bg-slate-400",
    blue: "bg-brand-500",
    amber: "bg-amber-500",
    purple: "bg-purple-500",
  };

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]} ${className}`}
    >
      {dot ? <span className={`w-1.5 h-1.5 rounded-full ${dots[tone]}`} /> : null}
      {children}
    </span>
  );
}

export function CopyButton({
  text,
  label,
  className = "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 p-1 rounded",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium transition-colors cursor-pointer ${className}`}
      title="复制"
      aria-label={label ? undefined : "复制"}
    >
      {copied ? <IconCheck className="text-emerald-600 dark:text-emerald-400" /> : <IconCopy />}
      {label ? <span>{copied ? "已复制" : label}</span> : null}
    </button>
  );
}

export function Empty({ text = "暂无数据", icon }: { text?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-slate-400 dark:text-slate-500 text-center">
      {icon ? <div className="mb-2 text-slate-300 dark:text-slate-600">{icon}</div> : null}
      <div className="text-sm font-medium">{text}</div>
    </div>
  );
}

export function Spinner({ text = "加载中…" }: { text?: string }) {
  return (
    <div className="flex items-center justify-center py-16 text-slate-400 dark:text-slate-500 gap-2">
      <div className="w-5 h-5 border-2 border-slate-300 dark:border-slate-700 border-t-brand-600 rounded-full animate-spin" />
      <span className="text-sm">{text}</span>
    </div>
  );
}

export const chartTheme = {
  grid: (dark: boolean) => (dark ? "#334155" : "#f1f5f9"),
  axis: (dark: boolean) => (dark ? "#64748b" : "#94a3b8"),
  tooltip: {
    backgroundColor: (dark: boolean) => (dark ? "#0f172a" : "#ffffff"),
    borderColor: (dark: boolean) => (dark ? "#334155" : "#e2e8f0"),
  },
  series: {
    blue: "#5f69f1",
    purple: "#8b5cf6",
    emerald: "#10b981",
    amber: "#f59e0b",
    rose: "#f43f5e",
    cyan: "#06b6d4",
  },
} as const;

/**
 * Renders a money string with its decimals de-emphasised ("¥50" + ".0000"), so balances stay
 * precise without the zeros dominating. Other values render as-is; text content is unchanged.
 */
export function Figure({ value, className = "" }: { value: string; className?: string }) {
  const match = /^(-?¥[\d,]+)(\.\d+)(.*)$/.exec(value);
  if (!match) return <span className={className}>{value}</span>;
  return (
    <span className={className}>
      {match[1]}
      <span className="text-[0.62em] font-medium text-slate-400 dark:text-slate-500">{match[2]}</span>
      {match[3]}
    </span>
  );
}

/** The product mark: the same bolt as the favicon, shared by the admin shell, user console and login pages. */
export function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className={`shrink-0 ${className}`}>
      <rect width="32" height="32" rx="9" className="fill-brand-600" />
      <path d="M17.5 5L7.5 17h7l-1 10 10-12h-7l1-10z" fill="#fff" />
    </svg>
  );
}

export function BrandLockup({ subtitle, compact = false }: { subtitle: string; compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <BrandMark className={compact ? "h-7 w-7" : "h-8 w-8"} />
      <div className="min-w-0 leading-tight">
        <div className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">CPG</div>
        <div className="truncate text-[11px] font-medium text-slate-500 dark:text-slate-400">{subtitle}</div>
      </div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = "slate",
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "blue" | "green" | "red" | "purple" | "amber" | "slate";
  icon?: ReactNode;
}) {
  // Colour is reserved for status (red / amber); other tones stay neutral so a row of numbers
  // reads as one set instead of a rainbow.
  const valueTone = tone === "red" ? "text-rose-600 dark:text-rose-400" : tone === "amber" ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-slate-50";
  return (
    <div className="rounded-2xl border border-slate-200/70 dark:border-slate-800 bg-white dark:bg-slate-900 px-3.5 py-3 sm:px-5 sm:py-4 shadow-card dark:shadow-none">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 truncate">
        {icon}
        {label}
      </div>
      <div className={`mt-1.5 text-xl sm:text-2xl font-semibold tracking-tight tabular-nums truncate ${valueTone}`}><Figure value={value} /></div>
      {sub ? (
        <div className="mt-1 text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 truncate">{sub}</div>
      ) : null}
    </div>
  );
}
