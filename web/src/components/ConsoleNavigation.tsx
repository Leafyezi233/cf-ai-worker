import { useCallback, useEffect, useState, type ReactNode } from "react";
import { IconDashboard, IconFileText, IconKey, IconModels, IconPlayground, IconShield, IconUsage } from "./icons";

export type ConsoleSection = "overview" | "models" | "video" | "guide" | "keys" | "usage" | "security";
export const CONSOLE_SECTIONS = [
  { key: "overview", label: "账户概览", hint: "余额、额度与快速开始", description: "查看余额、本月花费和月卡。" },
  { key: "models", label: "模型广场", hint: "查看模型能力与价格", description: "查看你可以使用的模型、能力和价格。" },
  { key: "video", label: "视频任务", hint: "创建、查询与下载", description: "创建视频任务，查看进度并下载结果；不要重复付费提交，异常请联系管理员。" },
  { key: "guide", label: "接入指南", hint: "配置客户端与 API", description: "几步完成客户端接入，并在线测试；密钥请勿放进公开链接。" },
  { key: "keys", label: "API 密钥", hint: "为应用创建独立子 Token", description: "为每个应用创建独立的 API 密钥（子 Token）。" },
  { key: "usage", label: "用量与账单", hint: "按时间核对调用与花费", description: "按时间范围查看调用次数、Token 和花费。" },
  { key: "security", label: "账户与安全", hint: "主 Token 调用与账户控制", description: "管理主 Token 的调用权限和登录状态。" },
] as const;

/** Sidebar grouping follows the user's journey: get started → build → pay & manage. */
export const CONSOLE_SECTION_GROUPS: ReadonlyArray<{ label: string; sections: readonly ConsoleSection[] }> = [
  { label: "开始使用", sections: ["overview", "models", "guide"] },
  { label: "开发调用", sections: ["keys", "video"] },
  { label: "账单与账户", sections: ["usage", "security"] },
];

const ICONS: Record<ConsoleSection, (props: { className?: string }) => ReactNode> = {
  overview: IconDashboard,
  models: IconModels,
  video: IconPlayground,
  guide: IconFileText,
  keys: IconKey,
  usage: IconUsage,
  security: IconShield,
};

export function consoleSectionMeta(section: ConsoleSection) {
  return CONSOLE_SECTIONS.find(item => item.key === section)!;
}

export function readConsoleSection(search: string): ConsoleSection {
  const value = new URLSearchParams(search).get("section");
  return CONSOLE_SECTIONS.some(item => item.key === value) ? value as ConsoleSection : "overview";
}

export function useConsoleSection(): [ConsoleSection, (value: ConsoleSection) => void] {
  const [section, setSection] = useState<ConsoleSection>(() => typeof window === "undefined" ? "overview" : readConsoleSection(window.location.search));
  useEffect(() => {
    const restore = () => setSection(readConsoleSection(window.location.search));
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const navigate = useCallback((value: ConsoleSection) => {
    if (!CONSOLE_SECTIONS.some(item => item.key === value)) return;
    const url = new URL(window.location.href);
    url.searchParams.set("section", value);
    window.history.pushState(null, "", url.pathname + url.search + url.hash);
    setSection(value);
    if (typeof window.scrollTo === "function") window.scrollTo({ top: 0 });
  }, []);
  return [section, navigate];
}

function NavButton({ section, active, vertical, onChange }: { section: ConsoleSection; active: boolean; vertical: boolean; onChange: (section: ConsoleSection) => void }) {
  const item = consoleSectionMeta(section);
  const Icon = ICONS[section];
  if (!vertical) {
    return <button type="button" data-section={section} aria-current={active ? "page" : undefined} title={item.hint}
      onClick={() => onChange(section)}
      className={"inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 " + (active
        ? "bg-brand-600 text-white"
        : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700")}>
      <Icon className="h-4 w-4 shrink-0" />
      <span>{item.label}</span>
      <span className="sr-only">：{item.hint}</span>
    </button>;
  }
  return <button type="button" data-section={section} aria-current={active ? "page" : undefined}
    onClick={() => onChange(section)}
    className={"group flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 " + (active
      ? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-200"
      : "text-slate-600 hover:bg-slate-100/70 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100")}>
    <Icon className={"mt-0.5 h-4 w-4 shrink-0 " + (active ? "text-brand-600 dark:text-brand-300" : "text-slate-400 group-hover:text-slate-600 dark:text-slate-500 dark:group-hover:text-slate-300")} />
    <span className="min-w-0">
      <span className={"block text-sm " + (active ? "font-semibold" : "font-medium")}>{item.label}</span>
      {/* The hint explains where you are; listing it under every item made the menu hard to scan. */}
      <span className={active ? "block truncate text-xs text-brand-600/80 dark:text-brand-300/70" : "sr-only"}>{item.hint}</span>
    </span>
  </button>;
}

/**
 * Desktop: grouped vertical list. Mobile: one compact, horizontally scrollable row so the
 * sticky header never grows to several rows of navigation.
 */
export function ConsoleNavigation({ active, onChange, vertical = false }: { active: ConsoleSection; onChange: (section: ConsoleSection) => void; vertical?: boolean }) {
  if (!vertical) {
    return <nav aria-label="控制台导航" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:-mx-6 sm:px-6">
      {CONSOLE_SECTION_GROUPS.flatMap(group => group.sections).map(section =>
        <NavButton key={section} section={section} active={active === section} vertical={false} onChange={onChange} />)}
    </nav>;
  }
  return <nav aria-label="控制台导航" className="space-y-5">
    {CONSOLE_SECTION_GROUPS.map(group => <div key={group.label}>
      <div className="mb-1 px-3 text-[11px] font-semibold tracking-wider text-slate-400 dark:text-slate-500">{group.label}</div>
      <div className="space-y-0.5">
        {group.sections.map(section => <NavButton key={section} section={section} active={active === section} vertical onChange={onChange} />)}
      </div>
    </div>)}
  </nav>;
}

export function ConsoleSectionIntro({ section, actions }: { section: ConsoleSection; actions?: ReactNode }) {
  const current = consoleSectionMeta(section);
  return <div className="flex flex-wrap items-end justify-between gap-3">
    <div className="min-w-0 max-w-3xl">
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">{current.label}</h2>
      <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">{current.description}</p>
    </div>
    {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
  </div>;
}
