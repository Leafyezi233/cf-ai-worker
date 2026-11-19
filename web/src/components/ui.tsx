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
    <div id={id} className={`bg-white dark:bg-slate-900 rounded-xl border border-slate-200/60 dark:border-slate-800 shadow-xs hover:shadow-sm transition-shadow overflow-hidden ${className}`}>
      {title || action ? (
        <div className="px-4 py-3 sm:px-5 sm:py-3.5 border-b border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2">
          {title ? <div className="text-[13px] font-medium tracking-wide text-slate-500 dark:text-slate-400">{title}</div> : <div />}
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div className="p-4 sm:p-5">{children}</div>
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
      ? "bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-sm shadow-blue-600/20"
      : variant === "danger"
      ? "bg-red-600 hover:bg-red-700 active:bg-red-800 text-white shadow-sm shadow-red-600/20"
      : variant === "success"
      ? "bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white shadow-sm shadow-emerald-600/20"
      : variant === "warning"
      ? "bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white shadow-sm shadow-amber-500/20"
      : variant === "secondary"
      ? "bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:active:bg-slate-600 dark:text-slate-200"
      : variant === "outline"
      ? "border border-slate-200 hover:bg-slate-50 text-slate-700 dark:border-slate-700 dark:hover:bg-slate-800 dark:text-slate-200"
      : "bg-transparent hover:bg-slate-100 text-slate-600 dark:hover:bg-slate-800 dark:text-slate-300";

  return (
    <button
      className={`inline-flex items-center justify-center font-medium rounded-lg transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none touch-manipulation ${sizeCls} ${variantCls} ${className}`}
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
      className={`w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/90 px-3 py-2 sm:py-1.5 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 transition-all focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/10 dark:focus:ring-blue-500/20 disabled:bg-slate-50 disabled:text-slate-400 dark:disabled:bg-slate-900/50 dark:disabled:text-slate-600 ${className}`}
      {...props}
    />
  );
}

export function Select({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/90 px-3 py-2 sm:py-1.5 text-sm text-slate-800 dark:text-slate-100 transition-all focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/10 dark:focus:ring-blue-500/20 disabled:bg-slate-50 dark:disabled:bg-slate-900/50 ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/90 px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 font-mono transition-all focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/10 dark:focus:ring-blue-500/20 disabled:bg-slate-50 dark:disabled:bg-slate-900/50 ${className}`}
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
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 dark:bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className={`w-full ${maxWidth} max-h-[92vh] flex flex-col rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-100 dark:border-slate-800 overflow-hidden transform transition-all animate-in zoom-in-95 duration-150`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 px-4 py-3 sm:px-5 sm:py-4 bg-slate-50/50 dark:bg-slate-800/40 shrink-0">
          <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm sm:text-base">{title}</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg inline-flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
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
    <div className="fixed inset-0 z-50 bg-slate-900/60 dark:bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150" onClick={onClose}>
      <div
        className={`absolute inset-y-0 right-0 w-full ${width} max-w-[92vw] flex flex-col bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-100 dark:border-slate-800 animate-in slide-in-from-right duration-200`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 px-4 py-3 sm:px-5 sm:py-4 bg-slate-50/50 dark:bg-slate-800/40 shrink-0">
          <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm sm:text-base">{title}</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg inline-flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
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
    blue: "bg-blue-50 text-blue-700 ring-1 ring-blue-600/20 dark:bg-blue-950/50 dark:text-blue-400 dark:ring-blue-500/30",
    amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20 dark:bg-amber-950/50 dark:text-amber-400 dark:ring-amber-500/30",
    purple: "bg-purple-50 text-purple-700 ring-1 ring-purple-600/20 dark:bg-purple-950/50 dark:text-purple-400 dark:ring-purple-500/30",
  };

  const dots = {
    green: "bg-emerald-500",
    red: "bg-rose-500",
    slate: "bg-slate-400",
    blue: "bg-blue-500",
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
      <div className="w-5 h-5 border-2 border-slate-300 dark:border-slate-700 border-t-blue-600 rounded-full animate-spin" />
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
    blue: "#3b82f6",
    purple: "#8b5cf6",
    emerald: "#10b981",
    amber: "#f59e0b",
    rose: "#f43f5e",
    cyan: "#06b6d4",
  },
} as const;

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
  const tones = {
    blue: "text-blue-600 dark:text-blue-400",
    green: "text-emerald-600 dark:text-emerald-400",
    red: "text-rose-600 dark:text-rose-400",
    purple: "text-purple-600 dark:text-purple-400",
    amber: "text-amber-600 dark:text-amber-400",
    slate: "text-slate-800 dark:text-slate-100",
  };
  return (
    <div className="rounded-xl sm:rounded-2xl border border-slate-200/60 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 sm:p-5 shadow-xs transition-all hover:shadow-md hover:border-slate-300/60 dark:hover:border-slate-700">
      <div className="flex items-center gap-1.5 text-[11px] sm:text-xs font-medium text-slate-400 dark:text-slate-500 truncate">
        {icon}
        {label}
      </div>
      <div className={`mt-1.5 sm:mt-2 text-lg sm:text-2xl lg:text-3xl font-bold tracking-tight truncate ${tones[tone]}`}>{value}</div>
      {sub ? (
        <div className="mt-0.5 sm:mt-1 text-[10px] sm:text-[11px] font-medium text-slate-400 dark:text-slate-500 truncate">{sub}</div>
      ) : null}
    </div>
  );
}
