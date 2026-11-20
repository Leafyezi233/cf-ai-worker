import type { ReactNode } from "react";
import { BrandMark } from "./ui";
import { highlight } from "./CodeBlock";
import { gatewayBase } from "./ConsoleAccessCard";

const JOURNEY: ReadonlyArray<[string, string]> = [
  ["登录控制台", "使用管理员分配的设备 Token 和控制台密码"],
  ["创建 API 密钥", "每个应用单独一个，随时停用或撤销"],
  ["填进应用，开始调用", "兼容 OpenAI 与 Anthropic 接口，用量实时可查"],
];

const sample = () => [
  "curl " + gatewayBase() + "/v1/chat/completions \\",
  '  -H "Authorization: Bearer $CPG_API_KEY" \\',
  "  -d '{\"model\": \"your-model\", \"messages\": [...]}'",
].join("\n");

export function ConsoleContact({ balance = false }: { balance?: boolean }) {
  return (
    <div className={balance ? "mt-2 space-y-1 text-[11px] leading-relaxed" : "text-sm leading-relaxed"}>
      <p className="text-slate-500 dark:text-slate-400">{balance ? "需要充值请联系管理员" : "还没有账号？请联系管理员获取设备 Token。"}</p>
    </div>
  );
}

export function ConsoleAuthShell({ step, title, description, children }: {
  step: 1 | 2;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-50 px-4 py-10 dark:bg-slate-950 sm:px-6">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 [background-image:radial-gradient(rgb(100_116_139/0.14)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)] dark:[background-image:radial-gradient(rgb(148_163_184/0.08)_1px,transparent_1px)]" />
      <div className="relative grid w-full max-w-4xl items-center gap-8 lg:grid-cols-2 lg:gap-16">
        <section className="px-2 text-center lg:text-left">
          <div className="mb-6 inline-flex items-center gap-2.5 text-sm font-semibold text-slate-900 dark:text-slate-100"><BrandMark className="h-9 w-9" /><span>CPG <span className="font-normal text-slate-500 dark:text-slate-400">用户控制台</span></span></div>
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-slate-900 dark:text-white sm:text-4xl">连接模型，<br className="hidden lg:block" />掌握每一次调用。</h1>
          <p className="mx-auto mt-4 max-w-sm text-sm leading-7 text-slate-500 dark:text-slate-400 lg:mx-0">用量、余额与模型服务，在一个地方清晰管理。</p>
          <ol className="mt-8 hidden space-y-4 text-left lg:block">
            {JOURNEY.map(([title, text], index) => <li key={title} className="flex gap-3">
              <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-brand-200 bg-white text-xs font-semibold text-brand-700 dark:border-brand-800 dark:bg-slate-900 dark:text-brand-300">{index + 1}</span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{title}</span>
                <span className="block text-xs leading-5 text-slate-500 dark:text-slate-400">{text}</span>
              </span>
            </li>)}
          </ol>
          <div aria-hidden="true" className="mt-7 hidden overflow-hidden rounded-xl border border-slate-800 bg-[#0b1020] text-left shadow-pop lg:block">
            <div className="flex items-center gap-1.5 border-b border-white/[0.06] px-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" /><span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" /><span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
            </div>
            <pre className="overflow-hidden whitespace-pre p-4 font-mono text-[11.5px] leading-relaxed text-slate-300"><code>{highlight(sample(), "bash")}</code></pre>
          </div>
        </section>
        <section aria-label={title} className="min-w-0 rounded-2xl border border-slate-200/70 bg-white p-6 shadow-pop dark:border-slate-800 dark:bg-slate-900 dark:shadow-none sm:p-8">
          <ol aria-label="登录步骤" className="mb-7 flex items-center gap-3 text-xs font-medium">
            <li aria-current={step === 1 ? "step" : undefined} className="flex items-center gap-2 text-brand-600 dark:text-brand-400"><span className={"flex h-6 w-6 items-center justify-center rounded-full " + (step === 2 ? "bg-brand-50 dark:bg-brand-500/15" : "bg-brand-600 text-white")}>{step === 2 ? "✓" : "1"}</span>验证 Token</li>
            <li aria-hidden="true" className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            <li aria-current={step === 2 ? "step" : undefined} className={step === 2 ? "flex items-center gap-2 text-brand-600 dark:text-brand-400" : "flex items-center gap-2 text-slate-400"}><span className={"flex h-6 w-6 items-center justify-center rounded-full " + (step === 2 ? "bg-brand-600 text-white" : "bg-slate-100 dark:bg-slate-800")}>2</span>控制台密码</li>
          </ol>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">{title}</h2>
          <p className="mb-6 mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">{description}</p>
          {children}
          <div className="mt-6 border-t border-slate-100 pt-5 dark:border-slate-800"><ConsoleContact /></div>
        </section>
      </div>
    </main>
  );
}
