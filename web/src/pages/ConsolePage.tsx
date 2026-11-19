import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  consoleAccountApi,
  consoleApi,
  getConsoleToken,
  setConsoleToken,
  setConsoleUnauthorizedHandler,
  type ConsoleAccountSession,
  type ConsoleAnnouncement,
  type ConsoleMe,
  type ConsoleModels,
  type ConsoleModelMarketplace,
  type ConsoleQuota,
  type ConsoleUsage,
} from "../api/consoleClient";
import { invalidateCache, useQuery } from "../hooks/useQuery";
import { Badge, Button, Card, CopyButton, Empty, Input, Spinner } from "../components/ui";
import { IconAlertTriangle, IconInfo, IconLogOut, IconRefresh } from "../components/icons";
import { ThemeToggle } from "../components/ThemeToggle";
import { AccountPanel, PasswordScreen } from "../components/ConsoleAccount";
import { ConsoleChatCard } from "../components/ConsoleChatCard";
import { ConsoleModelsSquare } from "../components/ConsoleModelsSquare";
import { ConsoleGuide } from "../components/ConsoleGuide";
import { ConsoleVideoCard } from "../components/ConsoleVideoCard";
import { ConsoleStandardVideoCard } from "../components/ConsoleStandardVideoCard";
import ConsoleMonthlyPass from "../components/ConsoleMonthlyPass";
import { ConsoleAuthShell, ConsoleContact } from "../components/ConsoleAuthShell";
import { ConsoleNavigation, ConsoleSectionIntro, useConsoleSection, type ConsoleSection } from "../components/ConsoleNavigation";

const RANGES = [
  { key: "24h", label: "近 24 小时" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
] as const;
const PAGE_SIZE = 50;

function fmtUsd(v: number | null | undefined): string {
  const n = v ?? 0;
  const body = `¥${Math.abs(n).toFixed(4)}`;
  return n < 0 ? `-${body}` : body;
}

/** Short form for the always-visible header chip; full precision stays on the overview. */
function fmtMoneyShort(v: number): string {
  const body = `¥${Math.abs(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return v < 0 ? `-${body}` : body;
}

function fmtInt(v: number | null | undefined): string {
  return (v ?? 0).toLocaleString();
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function fingerprint(token: string): string {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h * 33) ^ token.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

type Tone = "info" | "warning" | "danger";
const NOTICE_TONES: Record<Tone, string> = {
  info: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200",
  warning: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200",
  danger: "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200",
};

function Notice({ tone, title, children, action }: { tone: Tone; title?: ReactNode; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === "info" ? IconInfo : IconAlertTriangle;
  return (
    <div role={tone === "info" ? "status" : "alert"} className={`flex flex-wrap items-start gap-3 rounded-xl border px-4 py-3 text-sm ${NOTICE_TONES[tone]}`}>
      <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 leading-6">
        {title ? <div className="font-semibold">{title}</div> : null}
        <div className="whitespace-pre-wrap break-words">{children}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function AnnouncementBanner({ notice }: { notice: ConsoleAnnouncement }) {
  const tone: Tone = notice.level === "danger" || notice.level === "warning" ? notice.level : "info";
  return <Notice tone={tone} title={notice.title || undefined}>{notice.message}</Notice>;
}

function Stat({ label, value, hint, tone, id, children }: {
  label: string; value: string; hint?: ReactNode; tone?: "danger" | "muted"; id?: string; children?: ReactNode;
}) {
  return (
    <div data-stat={id} className="min-w-0 rounded-xl border border-slate-200/80 bg-white px-4 py-3.5 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div className={"mt-1 truncate text-xl font-semibold tabular-nums tracking-tight " + (tone === "danger" ? "text-rose-600 dark:text-rose-400" : tone === "muted" ? "text-slate-500 dark:text-slate-400" : "text-slate-900 dark:text-slate-100")}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</div> : null}
      {children}
    </div>
  );
}

function SpendMeter({ used, limit }: { used: number; limit: number }) {
  const ratio = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
  const tone = ratio >= 1 ? "bg-rose-500" : ratio >= 0.8 ? "bg-amber-500" : "bg-blue-500";
  return (
    <div className="mt-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="progressbar" aria-label="本月花费占上限比例"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
        <div className={"h-full rounded-full transition-all " + tone} style={{ width: `${ratio * 100}%` }} />
      </div>
      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">已用 {Math.round(ratio * 100)}% · 上限 {fmtUsd(limit)}</div>
    </div>
  );
}

const QUICK_START: ReadonlyArray<{ section: ConsoleSection; title: string; text: string }> = [
  { section: "models", title: "选择模型", text: "比较可用模型、能力与价格" },
  { section: "keys", title: "创建 API 密钥", text: "为每个应用单独创建子 Token" },
  { section: "guide", title: "配置客户端", text: "生成配置，并在线试一句" },
  { section: "usage", title: "查看用量与账单", text: "按时间核对调用与花费" },
];

function QuickStart({ onOpen }: { onOpen: (section: ConsoleSection) => void }) {
  return (
    <Card title="快速开始">
      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {QUICK_START.map((step, index) => <li key={step.section}>
          <button type="button" onClick={() => onOpen(step.section)}
            className="group flex h-full w-full items-start gap-3 rounded-lg border border-slate-200 p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-slate-800 dark:hover:border-blue-800 dark:hover:bg-blue-950/30">
            <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700 group-hover:bg-blue-600 group-hover:text-white dark:bg-blue-950 dark:text-blue-300">{index + 1}</span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{step.title}</span>
              <span className="mt-0.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">{step.text}</span>
            </span>
          </button>
        </li>)}
      </ol>
    </Card>
  );
}

type AccountBalance = Omit<ConsoleQuota, "rpm">;

export function accountBalance(me: ConsoleMe["device"] | undefined): AccountBalance | undefined {
  if (!me) return undefined;
  const limit = me.cost_limit_monthly ?? 0;
  return { balance_usd: me.balance_usd, reserved_usd: me.reserved_usd, available_usd: me.available_usd,
    low_balance_warning: me.low_balance_warning, monthly_cost_usd: me.current_month_cost,
    monthly_cost_limit_usd: limit, monthly_cost_exceeded: limit > 0 && me.current_month_cost >= limit };
}

function BalanceChip({ quota, onOpen }: { quota: AccountBalance | undefined; onOpen: () => void }) {
  if (!quota) return null;
  const danger = quota.available_usd < 0;
  const warn = !danger && quota.low_balance_warning;
  return (
    <button type="button" onClick={onOpen} title="可用余额（点击查看余额与额度）"
      className={"inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 " + (danger
        ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300"
        : warn ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800")}>
      <span className="text-slate-500 dark:text-slate-400">余额</span>
      <span>{fmtMoneyShort(quota.available_usd)}</span>
    </button>
  );
}

export function TokenGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  const formRef = useRef<HTMLFormElement | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const box = formRef.current ? formRef.current.querySelector("input") : null;
    const raw = box ? box.value : value;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (raw !== value) setValue(raw);
    setConsoleToken(trimmed);
    onSaved();
  };

  return (
    <ConsoleAuthShell step={1} title="欢迎回来" description="使用负责人分配的设备 Token，登录你的用户控制台。">
      <form ref={formRef} onSubmit={submit} className="space-y-4">
        <label htmlFor="console-token" className="block text-sm font-medium text-slate-700 dark:text-slate-200">设备 Token</label>
        <Input id="console-token" name="token" type="password" value={value}
          onChange={(e) => setValue(e.target.value)} placeholder="ccs_..." autoFocus autoComplete="current-password"
          autoCapitalize="none" spellCheck={false} aria-describedby="console-token-hint" className="!py-3" />
        <p id="console-token-hint" className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">由管理员分配，以 ccs_ 开头。</p>
        <Button type="submit" size="lg" className="w-full">继续验证 →</Button>
      </form>
    </ConsoleAuthShell>
  );
}

export default function ConsolePage() {
  const [token, setToken] = useState(getConsoleToken());
  const [range, setRange] = useState<string>("30d");
  const [tab, setTab] = useConsoleSection();
  const [accountSection, setAccountSection] = useState<"keys" | "security" | null>(null);
  useEffect(() => { if (tab === "keys" || tab === "security") setAccountSection(tab); }, [tab]);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setConsoleUnauthorizedHandler(() => {
      setConsoleToken("");
      setToken("");
    });
    return () => setConsoleUnauthorizedHandler(null);
  }, []);

  const fetcher = useCallback(<T,>(path: string) => consoleApi.get<T>(path), []);

  const scope = useMemo(() => (token ? fingerprint(token) : "none"), [token]);

  const sessionQuery = useQuery<ConsoleAccountSession>(
    token ? `console:${scope}:session` : null,
    () => consoleAccountApi.session(),
    { enabled: Boolean(token), ttlMs: 0 }
  );

  const authenticated = Boolean(token && sessionQuery.data?.authenticated);
  const needsModels = tab === "guide" || tab === "video";
  const needsQuota = tab === "overview" || tab === "usage";
  const meQuery = useQuery<ConsoleMe>(token ? `console:${scope}:me` : null, () => fetcher("/console/me"), {
    enabled: Boolean(token),
  });
  // Other sections reuse /me for their balance chip and alerts; only account/usage details need quota.
  const quotaQuery = useQuery<ConsoleQuota>(token ? `console:${scope}:quota` : null, () => fetcher("/console/quota"), {
    enabled: authenticated && needsQuota,
    ttlMs: 15_000,
  });
  const usageQuery = useQuery<ConsoleUsage>(
    token ? `console:${scope}:usage:${range}:${offset}` : null,
    () => fetcher(`/console/usage?range=${range}&limit=${PAGE_SIZE}&offset=${offset}`),
    { enabled: authenticated && tab === "usage" }
  );
  const modelsQuery = useQuery<ConsoleModels>(token ? `console:${scope}:models` : null, () => fetcher("/console/models"), {
    enabled: authenticated && needsModels,
  });
  const marketplaceQuery = useQuery<ConsoleModelMarketplace>(
    token ? `console:${scope}:model-marketplace` : null,
    () => fetcher("/console/model-marketplace"),
    { enabled: authenticated && tab === "models" }
  );
  const announcementQuery = useQuery<ConsoleAnnouncement>(
    token ? "console:announcement" : null,
    () => fetcher("/console/announcement"),
    { enabled: authenticated && tab === "overview", ttlMs: 30_000 }
  );

  if (!token) return <TokenGate onSaved={() => setToken(getConsoleToken())} />;

  if (sessionQuery.loading && !sessionQuery.data) return <Spinner text="正在校验…" />;
  if (sessionQuery.error) {
    const code = (sessionQuery.error as Error & { code?: string }).code;
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50/50 dark:bg-slate-950 p-6">
        <div className="w-full max-w-sm">
          <Card title="无法进入控制台">
            <div className="space-y-3 text-sm text-slate-600 dark:text-slate-400">
              <div>{sessionQuery.error.message}</div>
              {code === "sub_token_not_allowed" ? (
                <div className="text-xs">
                  你输入的是子 Token。子 Token 只能用于调用模型，不能登录控制台；请改用主 Token。
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => { void sessionQuery.refresh(true).catch(() => {}); }}>重试</Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setConsoleToken("");
                    setToken("");
                  }}
                >
                  换一个 Token
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    );
  }
  const session = sessionQuery.data;
  if (session && session.password_setup_required) {
    return (
      <PasswordScreen
        mode="setup"
        deviceName={session.device_name}
        onDone={() => {
          invalidateCache(`console:${scope}`);
          sessionQuery.refresh(true);
        }}
        onChangeToken={() => {
          consoleAccountApi.logout().catch(() => {});
          setConsoleToken("");
          setToken("");
        }}
      />
    );
  }
  if (session && !session.authenticated) {
    return (
      <PasswordScreen
        mode="login"
        deviceName={session.device_name}
        onDone={() => {
          invalidateCache(`console:${scope}`);
          sessionQuery.refresh(true);
        }}
        onChangeToken={() => {
          setConsoleToken("");
          setToken("");
        }}
      />
    );
  }

  const logout = () => {
    consoleAccountApi.logout().catch(() => {});
    setConsoleToken("");
    setToken("");
  };
  const refreshAll = () => {
    const requests: Promise<unknown>[] = [meQuery.refresh(true)];
    if (needsQuota) requests.push(quotaQuery.refresh(true));
    if (tab === "usage") requests.push(usageQuery.refresh(true));
    if (needsModels) requests.push(modelsQuery.refresh(true));
    if (tab === "models") requests.push(marketplaceQuery.refresh(true));
    if (tab === "overview") requests.push(announcementQuery.refresh(true));
    void Promise.allSettled(requests);
  };
  const me = meQuery.data?.device;
  const quota: AccountBalance | undefined = needsQuota ? quotaQuery.data : accountBalance(me);
  const usage = usageQuery.data;
  const models = modelsQuery.data;
  const rangeLabel = RANGES.find(r => r.key === range)?.label;
  const refreshing = meQuery.isRefreshing || quotaQuery.isRefreshing || usageQuery.isRefreshing || modelsQuery.isRefreshing || marketplaceQuery.isRefreshing;

  const accountAlerts = <>
    {me && me.calls_enabled === false && tab !== "security" ? (
      <Notice tone="danger" title="主 Token 已禁止调用"
        action={<Button size="sm" variant="outline" onClick={() => setTab("security")}>前往恢复</Button>}>
        主 Token 发起的新请求会被拒绝，子 Token 不受影响。
      </Notice>
    ) : null}
    {quota?.monthly_cost_exceeded ? (
      <Notice tone="danger" title="本月花费已达上限">
        已达到本月上限 {fmtUsd(quota.monthly_cost_limit_usd)}，新请求可能被拒绝。如需提高上限，请联系管理员。
      </Notice>
    ) : null}
    {quota?.low_balance_warning ? (
      <Notice tone="warning" title={quota.available_usd < 0 ? "账户已透支" : "余额不足"}>
        {quota.available_usd < 0
          ? `已透支 ${fmtUsd(Math.abs(quota.available_usd))}，充值后会先抵扣欠款。`
          : `可用余额仅剩 ${fmtUsd(quota.available_usd)}，请联系管理员充值。月卡覆盖的文本请求不受影响。`}
      </Notice>
    ) : null}
  </>;

  return (
    <div className="flex min-h-screen bg-slate-50 dark:bg-slate-950">
      <a href="#console-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-3 focus:text-blue-700">跳到主要内容</a>
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-slate-200/80 bg-white dark:border-slate-800 dark:bg-slate-900 md:flex">
        <div className="flex items-center gap-2.5 px-5 py-4">
          <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-[11px] font-bold text-white shadow-sm shadow-blue-600/30">CPG</span>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">用户控制台</div>
            <div className="truncate text-xs text-slate-400 dark:text-slate-500">AI 网关</div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2"><ConsoleNavigation active={tab} onChange={setTab} vertical /></div>
        <div className="border-t border-slate-100 p-3 dark:border-slate-800">
          <div className="rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 truncate text-sm font-medium text-slate-800 dark:text-slate-100">{me?.name || "正在读取账户"}</div>
              {me ? <span className={"h-2 w-2 shrink-0 rounded-full " + (me.enabled ? "bg-emerald-500" : "bg-rose-500")} title={me.enabled ? "账户已启用" : "账户已停用"} /> : null}
            </div>
            <div className="mt-0.5 flex items-center gap-1">
              <span className="min-w-0 truncate font-mono text-[11px] text-slate-500 dark:text-slate-400" title="设备 ID">{me?.id || "-"}</span>
              {me?.id ? <CopyButton text={me.id} /> : null}
            </div>
          </div>
          <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={logout}>
            <IconLogOut className="h-3.5 w-3.5" />退出登录
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 px-4 py-2.5 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90 sm:px-6">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-[10px] font-bold text-white md:hidden">CPG</span>
              <h1 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                <span className="md:hidden">用户控制台</span>
                <span className="hidden md:inline">{me?.name || "用户控制台"}</span>
              </h1>
              {me ? <Badge tone={me.enabled ? "green" : "red"} className="hidden sm:inline-flex">{me.enabled ? "账户已启用" : "账户已停用"}</Badge> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <BalanceChip quota={quota} onOpen={() => setTab("overview")} />
              <Button variant="ghost" size="sm" onClick={refreshAll} disabled={refreshing} aria-label="刷新数据" title="刷新数据">
                <IconRefresh className={"h-3.5 w-3.5" + (refreshing ? " animate-spin" : "")} /><span className="hidden sm:inline">刷新数据</span>
              </Button>
              <ThemeToggle />
              <Button variant="ghost" size="sm" className="md:hidden" onClick={logout} aria-label="退出登录"><IconLogOut className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
          <div className="mt-2.5 md:hidden"><ConsoleNavigation active={tab} onChange={setTab} /></div>
        </header>

        <main id="console-main" className="mx-auto w-full max-w-7xl flex-1 space-y-5 p-4 sm:p-6 lg:p-8">
          <ConsoleSectionIntro section={tab} />
          {meQuery.error ? <Notice tone="danger" title="账户信息读取失败">{meQuery.error.message}</Notice> : null}
          {accountAlerts}

          <div hidden={tab !== "video"}><div className="space-y-5">
            <ConsoleStandardVideoCard key={"standard:" + token} token={token} models={modelsQuery.data ?? null} active={tab === "video"} />
            <ConsoleVideoCard key={token} token={token} models={modelsQuery.data ?? null} active={tab === "video"} />
          </div></div>

          {tab === "guide" ? (
            <ConsoleGuide models={modelsQuery.data} onOpenModels={() => setTab("models")} onOpenKeys={() => setTab("keys")}
              playground={<ConsoleChatCard models={models || null} />} />
          ) : null}

          {tab === "models" ? (
            <ConsoleModelsSquare
              models={marketplaceQuery.data}
              loading={marketplaceQuery.loading}
              error={marketplaceQuery.error}
            />
          ) : null}

          {tab === "overview" ? <>
            {announcementQuery.data?.enabled && announcementQuery.data.message ? (
              <AnnouncementBanner notice={announcementQuery.data} />
            ) : null}
            <section aria-labelledby="console-balance-heading" className="space-y-3">
              <div>
                <h3 id="console-balance-heading" className="font-semibold text-slate-900 dark:text-slate-100">余额与额度</h3>
                <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">月卡额度与钱包余额分开计算，用量花费不等同于钱包扣款。</p>
              </div>
              {quotaQuery.error ? <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">余额读取失败，请点击“刷新数据”重试。</p> : null}
              <div className="grid gap-3 md:grid-cols-3">
                <Stat id="available-balance" label="可用余额" value={quota ? fmtUsd(quota.available_usd) : "—"} tone={quota && quota.available_usd < 0 ? "danger" : undefined}
                  hint={quota && quota.reserved_usd > 0 ? `其中预占中 ${fmtUsd(quota.reserved_usd)}` : undefined}>
                  <ConsoleContact balance />
                </Stat>
                <Stat label="本月花费" value={quota ? fmtUsd(quota.monthly_cost_usd) : "—"} tone={quota?.monthly_cost_exceeded ? "danger" : undefined}
                  hint={quota ? (quota.monthly_cost_limit_usd > 0 ? undefined : "未设置上限") : "等待读取额度"}>
                  {quota && quota.monthly_cost_limit_usd > 0 ? <SpendMeter used={quota.monthly_cost_usd} limit={quota.monthly_cost_limit_usd} /> : null}
                </Stat>
                <Stat label="请求预占金额" value={quota ? fmtUsd(quota.reserved_usd) : "—"} tone={quota && quota.reserved_usd === 0 ? "muted" : undefined}
                  hint="进行中的请求暂扣，结束后按实际用量结算" />
              </div>
            </section>
            <QuickStart onOpen={setTab} />
            <ConsoleMonthlyPass scope={scope} onChange={() => { void quotaQuery.refresh(true).catch(() => {}); }} />
          </> : null}

          {tab === "usage" ? <>
            <section aria-labelledby="console-usage-heading" className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h3 id="console-usage-heading" className="font-semibold text-slate-900 dark:text-slate-100">用量统计 · {rangeLabel}</h3>
                <div role="group" aria-label="用量时间范围" className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900">
                  {RANGES.map(r => <button key={r.key} type="button" aria-pressed={range === r.key}
                    onClick={() => { setRange(r.key); setOffset(0); }}
                    className={"rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 " + (range === r.key
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")}>{r.label}</button>)}
                </div>
              </div>
              {usageQuery.error ? <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">用量读取失败，请刷新重试；无法读取不代表没有调用记录。</p> : null}
              {(usage?.summary?.pricing_missing_count || 0) > 0 ? (
                <Notice tone="warning">有 {usage?.summary?.pricing_missing_count} 条记录缺少价格配置，其花费按 0 计入，统计偏低。</Notice>
              ) : null}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                <Stat label="请求数" value={usage ? fmtInt(usage.summary.request_count) : "—"} />
                <Stat label="总花费" value={usage ? fmtUsd(usage.summary.cost_usd) : "—"} />
                <Stat label="错误数" value={usage ? fmtInt(usage.summary.error_count) : "—"} tone={(usage?.summary.error_count ?? 0) > 0 ? "danger" : undefined}
                  hint={usage && (usage.summary.request_count ?? 0) > 0 ? `错误率 ${((usage.summary.error_count ?? 0) / (usage.summary.request_count ?? 1) * 100).toFixed(1)}%` : undefined} />
                <Stat label="总 Token" value={usage ? fmtInt(usage.summary.total_tokens) : "—"} />
                <Stat label="输入 Token" value={usage ? fmtInt(usage.summary.input_tokens) : "—"} />
                <Stat label="输出 Token" value={usage ? fmtInt(usage.summary.output_tokens) : "—"} />
              </div>
            </section>

            <Card title="按模型用量">
              {usageQuery.loading ? (
                <Spinner text="正在加载用量…" />
              ) : (usage?.by_model?.length ? (
                <div className="overflow-x-auto" role="region" aria-label="可横向滚动的用量表格" tabIndex={0}>
                  <table className="w-full min-w-[32rem] text-sm tabular-nums">
                    <thead>
                      <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                        <th scope="col" className="py-2 pr-3 font-medium">模型</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">请求数</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">Token</th>
                        <th scope="col" className="py-2 text-right font-medium">花费</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.by_model.map((m) => (
                        <tr key={m.model} className="border-t border-slate-100 dark:border-slate-800">
                          <td className="py-2 pr-3 text-slate-800 dark:text-slate-200">
                            {m.model}
                            {m.pricing_missing_count > 0 ? <Badge tone="amber" className="ml-2">缺价</Badge> : null}
                          </td>
                          <td className="py-2 pr-3 text-right">{fmtInt(m.request_count)}</td>
                          <td className="py-2 pr-3 text-right">{fmtInt(m.total_tokens)}</td>
                          <td className="py-2 text-right">{fmtUsd(m.cost_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty text={usageQuery.error ? "暂时无法显示用量，请刷新重试" : "所选时间范围内暂无调用记录"} />
              ))}
            </Card>

            <Card title="请求明细">
              <p className="mb-3 text-xs leading-5 text-slate-500 dark:text-slate-400">每页最多 50 条。月卡覆盖的请求不从钱包扣款。</p>
              {usageQuery.loading ? (
                <Spinner text="正在加载明细…" />
              ) : (usage?.items?.length ? (
                <div className="overflow-x-auto" role="region" aria-label="可横向滚动的用量表格" tabIndex={0}>
                  <table className="w-full min-w-[32rem] text-sm tabular-nums">
                    <thead>
                      <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                        <th scope="col" className="py-2 pr-3 font-medium">时间</th>
                        <th scope="col" className="py-2 pr-3 font-medium">模型</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">Token</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">耗时</th>
                        <th scope="col" className="py-2 text-right font-medium">花费</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.items.map((it) => (
                        <tr key={it.id} className="border-t border-slate-100 dark:border-slate-800">
                          <td className="whitespace-nowrap py-2 pr-3 text-slate-600 dark:text-slate-300">{fmtTime(it.created_at)}</td>
                          <td className="py-2 pr-3 text-slate-800 dark:text-slate-200">{it.model || "-"}</td>
                          <td className="py-2 pr-3 text-right">{fmtInt(it.total_tokens)}</td>
                          <td className="py-2 pr-3 text-right">{it.latency_ms ? `${it.latency_ms} ms` : "-"}</td>
                          <td className="whitespace-nowrap py-2 text-right">
                            {fmtUsd(it.cost_usd)}
                            {it.pricing_missing ? <Badge tone="amber" className="ml-2">缺价</Badge> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty text={usageQuery.error ? "暂时无法显示用量，请刷新重试" : "所选时间范围内暂无调用记录"} />
              ))}
              {usage && (offset > 0 || usage.items.length >= (usage.page.limit || PAGE_SIZE)) ? (
                <div className="mt-3 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                  <span>第 {Math.floor(offset / (usage.page.limit || PAGE_SIZE)) + 1} 页</span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</Button>
                    <Button size="sm" variant="outline" disabled={usage.items.length < (usage.page.limit || PAGE_SIZE)} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</Button>
                  </div>
                </div>
              ) : null}
            </Card>
          </> : null}

          {tab === "security" ? (
            <Card title="登录信息">
              <dl className="grid gap-4 text-sm sm:grid-cols-3">
                <div className="min-w-0"><dt className="text-xs text-slate-500 dark:text-slate-400">账户名称</dt><dd className="mt-1 truncate font-medium text-slate-900 dark:text-slate-100">{me?.name || "—"}</dd></div>
                <div className="min-w-0"><dt className="text-xs text-slate-500 dark:text-slate-400">设备 ID</dt>
                  <dd className="mt-1 flex items-center gap-1"><span className="min-w-0 truncate font-mono text-xs">{me?.id || "—"}</span>{me?.id ? <CopyButton text={me.id} /> : null}</dd></div>
                <div className="min-w-0"><dt className="text-xs text-slate-500 dark:text-slate-400">账户状态</dt><dd className="mt-1">{me ? <Badge tone={me.enabled ? "green" : "red"}>{me.enabled ? "已启用" : "已停用"}</Badge> : "—"}</dd></div>
              </dl>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
                <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">忘记控制台密码需联系管理员重置。</p>
                <Button variant="outline" size="sm" onClick={logout}><IconLogOut className="h-3.5 w-3.5" />退出登录</Button>
              </div>
            </Card>
          ) : null}

          {(accountSection || tab === "keys" || tab === "security") ? <div hidden={tab !== "keys" && tab !== "security"}>
            <AccountPanel
              scope={scope}
              active={tab === "keys" || tab === "security"}
              section={tab === "security" || tab === "keys" ? tab : accountSection ?? "keys"}
              onOpenGuide={() => setTab("guide")}
              onServiceGroupsChange={() => {
                void meQuery.refresh(true).catch(() => {});
                void modelsQuery.refresh(true).catch(() => {});
                void marketplaceQuery.refresh(true).catch(() => {});
              }}
              onCallsChange={() => {
                meQuery.refresh(true);
              }}
            />
          </div> : null}
        </main>
      </div>
    </div>
  );
}
