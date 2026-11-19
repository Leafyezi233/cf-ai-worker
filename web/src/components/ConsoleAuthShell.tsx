import type { ReactNode } from "react";

export function ConsoleContact({ balance = false }: { balance?: boolean }) {
  return (
    <div className={balance ? "mt-2 space-y-1 text-[11px] leading-relaxed" : "rounded-2xl border border-blue-100 bg-blue-50/70 p-4 text-sm leading-relaxed dark:border-blue-900/60 dark:bg-blue-950/30"}>
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
      <div aria-hidden="true" className="pointer-events-none absolute -top-32 left-0 h-96 w-96 rounded-full bg-blue-200/40 blur-3xl dark:bg-blue-900/20" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-40 right-0 h-96 w-96 rounded-full bg-indigo-200/40 blur-3xl dark:bg-indigo-900/20" />
      <div className="relative grid w-full max-w-4xl items-center gap-8 lg:grid-cols-2 lg:gap-16">
        <section className="px-2 text-center lg:text-left">
          <div className="mb-5 inline-flex items-center gap-2 text-sm font-semibold tracking-wide text-blue-600 dark:text-blue-400"><span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-xs font-bold text-white shadow-lg shadow-blue-600/20">CPG</span> 用户控制台</div>
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-slate-900 dark:text-white sm:text-4xl">连接模型，<br className="hidden lg:block" />掌握每一次调用。</h1>
          <p className="mx-auto mt-4 max-w-sm text-sm leading-7 text-slate-500 dark:text-slate-400 lg:mx-0">用量、余额与模型服务，在一个地方清晰管理。</p>
          <div className="mt-6 hidden flex-wrap gap-2 lg:flex">{["用量与账单", "模型广场", "令牌管理"].map(label => <span key={label} className="rounded-full border border-slate-200 bg-white/70 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-400">{label}</span>)}</div>
        </section>
        <section aria-label={title} className="min-w-0 rounded-3xl border border-white bg-white/95 p-6 shadow-xl shadow-slate-200/60 dark:border-slate-800 dark:bg-slate-900/95 dark:shadow-black/20 sm:p-8">
          <ol aria-label="登录步骤" className="mb-7 flex items-center gap-3 text-xs font-medium">
            <li aria-current={step === 1 ? "step" : undefined} className="flex items-center gap-2 text-blue-600 dark:text-blue-400"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-50 dark:bg-blue-950">{step === 2 ? "✓" : "1"}</span>验证 Token</li>
            <li aria-hidden="true" className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            <li aria-current={step === 2 ? "step" : undefined} className={step === 2 ? "flex items-center gap-2 text-blue-600 dark:text-blue-400" : "flex items-center gap-2 text-slate-400"}><span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800">2</span>控制台密码</li>
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
