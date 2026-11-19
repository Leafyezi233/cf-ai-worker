import { useCallback, useEffect, useState } from "react";

export type ConsoleSection = "overview" | "models" | "video" | "guide" | "keys" | "usage" | "security";
export const CONSOLE_SECTIONS = [
  { key: "overview", label: "账户概览", hint: "余额、额度与快速开始", description: "查看钱包与月卡权益，选择下一步操作。" },
  { key: "models", label: "模型广场", hint: "查看模型能力与价格", description: "比较你有权限使用的模型与服务分组，调用前请确认计价单位。" },
  { key: "video", label: "视频任务", hint: "创建、查询与下载", description: "创建任务后请查询原任务。提交结果未知时，不要重复付费提交；下载未配置时请联系管理员。" },
  { key: "guide", label: "接入指南", hint: "配置客户端与 API", description: "按协议选择接入地址；Token 是调用凭证，请勿放进公开链接或分享给他人。" },
  { key: "keys", label: "API 密钥", hint: "为应用创建独立子 Token", description: "按应用管理子 Token、调用策略与服务组。主 Token 用于账户身份验证，不建议交给第三方应用。" },
  { key: "usage", label: "用量与账单", hint: "按时间核对调用与花费", description: "按同一时间范围查看汇总和请求明细；历史费用以请求发生时记录为准。" },
  { key: "security", label: "账户与安全", hint: "主 Token 调用与账户控制", description: "管理主 Token 的调用状态。禁止主 Token 新调用不会停用独立子 Token。" },
] as const;

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
  }, []);
  return [section, navigate];
}

export function ConsoleNavigation({ active, onChange, vertical = false }: { active: ConsoleSection; onChange: (section: ConsoleSection) => void; vertical?: boolean }) {
  return <nav aria-label="控制台导航" className={vertical ? "grid grid-cols-1 gap-1" : "grid grid-cols-2 gap-2 sm:grid-cols-4"}>
    {CONSOLE_SECTIONS.map(item => <button key={item.key} type="button" aria-current={active === item.key ? "page" : undefined}
      onClick={() => onChange(item.key)}
      className={"min-w-0 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 " + (active === item.key
        ? "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-200"
        : "border-transparent text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")}>
      <span className="block text-sm font-semibold">{item.label}</span>
      <span className="mt-0.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">{item.hint}</span>
    </button>)}
  </nav>;
}

export function ConsoleSectionIntro({ section }: { section: ConsoleSection }) {
  const current = CONSOLE_SECTIONS.find(item => item.key === section)!;
  return <div className="mb-5 max-w-3xl"><h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">{current.label}</h2>
    <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-400">{current.description}</p></div>;
}
