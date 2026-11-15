export type ConsoleSection = "overview" | "models" | "video" | "guide";
export const CONSOLE_SECTIONS = [
  { key: "overview", label: "账户概览", hint: "余额、额度与调用记录", description: "先查看账户余额和额度，再按时间范围了解调用情况。" },
  { key: "models", label: "模型广场", hint: "查看模型能力与价格", description: "比较你有权限使用的模型与服务分组，调用前请确认计价单位。" },
  { key: "video", label: "视频任务", hint: "创建、查询与下载", description: "创建任务后请查询原任务。提交结果未知时，不要重复付费提交；下载未配置时请联系管理员。" },
  { key: "guide", label: "接入指南", hint: "配置客户端与 API", description: "按协议选择接入地址；Token 是调用凭证，请勿放进公开链接或分享给他人。" },
] as const;

export function ConsoleNavigation({ active, onChange }: { active: ConsoleSection; onChange: (section: ConsoleSection) => void }) {
  return <nav aria-label="控制台导航" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
