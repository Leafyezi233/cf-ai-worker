import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Badge, Button, Card, Empty, Input, Spinner } from "../components/ui";
import { AccountPanel, PasswordScreen } from "../components/ConsoleAccount";
import { ConsoleChatCard } from "../components/ConsoleChatCard";
import { ConsoleModelsSquare } from "../components/ConsoleModelsSquare";
import { ConsoleGuide } from "../components/ConsoleGuide";
import { ConsoleVideoCard } from "../components/ConsoleVideoCard";
import { ConsoleStandardVideoCard } from "../components/ConsoleStandardVideoCard";
import ConsoleMonthlyPass from "../components/ConsoleMonthlyPass";
import { ConsoleAuthShell, ConsoleContact } from "../components/ConsoleAuthShell";
import { ConsoleNavigation, ConsoleSectionIntro } from "../components/ConsoleNavigation";

const RANGES = [
  { key: "24h", label: "近 24 小时" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
] as const;


function fmtUsd(v: number | null | undefined): string {
  const n = v ?? 0;
  const body = `¥${Math.abs(n).toFixed(4)}`;
  return n < 0 ? `-${body}` : body;
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

function AnnouncementBanner({ notice }: { notice: ConsoleAnnouncement }) {
  const tones: Record<ConsoleAnnouncement["level"], string> = {
    info: "border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300",
    warning: "border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300",
    danger: "border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300",
  };
  const icons: Record<ConsoleAnnouncement["level"], string> = {
    info: "📢",
    warning: "⚠️",
    danger: "⛔",
  };
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${tones[notice.level] || tones.info}`}>
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="shrink-0 leading-5">{icons[notice.level] || icons.info}</span>
        <div className="min-w-0 flex-1">
          {notice.title ? <div className="font-semibold">{notice.title}</div> : null}
          { 
}
          <div className="whitespace-pre-wrap break-words">{notice.message}</div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, children }: { label: string; value: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="px-4 py-3.5 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40">
      <div className="text-xs font-medium text-slate-600 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100 tracking-tight">{value}</div>
      {hint ? <div className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</div> : null}
      {children}
    </div>
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
          onChange={(e) => setValue(e.target.value)} placeholder="ccs_..." autoFocus
          autoCapitalize="none" spellCheck={false} aria-describedby="console-token-hint" className="!py-3" />
        <p id="console-token-hint" className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">Token 将发送至当前网关进行身份验证，请妥善保管，勿与他人分享。</p>
        { }
        <Button type="submit" size="lg" className="w-full">继续验证 →</Button>
      </form>
    </ConsoleAuthShell>
  );
}

export default function ConsolePage() {
  const [token, setToken] = useState(getConsoleToken());
  const [range, setRange] = useState<string>("30d");
  const [tab, setTab] = useState<"overview" | "models" | "guide" | "video">("overview");
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

  const meQuery = useQuery<ConsoleMe>(token ? `console:${scope}:me` : null, () => fetcher("/console/me"), {
    enabled: Boolean(token),
  });
  const quotaQuery = useQuery<ConsoleQuota>(token ? `console:${scope}:quota` : null, () => fetcher("/console/quota"), {
    enabled: Boolean(token),
    ttlMs: 15_000,
  });
  const usageQuery = useQuery<ConsoleUsage>(
    token ? `console:${scope}:usage:${range}:${offset}` : null,
    () => fetcher(`/console/usage?range=${range}&limit=50&offset=${offset}`),
    { enabled: Boolean(token) }
  );
  const usageDaily = usageQuery.data?.daily || [];
  const localToday = new Date().toISOString().slice(0, 10);
  const todayBucket =
    usageDaily.find((d) => d.date === localToday) ?? (usageDaily.length ? usageDaily[usageDaily.length - 1] : null);
  const todayCost = todayBucket?.cost_usd ?? 0;
  const todayCostIsExact = Boolean(todayBucket && todayBucket.date === localToday);
  const modelsQuery = useQuery<ConsoleModels>(token ? `console:${scope}:models` : null, () => fetcher("/console/models"), {
    enabled: Boolean(token),
  });
  const marketplaceQuery = useQuery<ConsoleModelMarketplace>(
    token ? `console:${scope}:model-marketplace` : null,
    () => fetcher("/console/model-marketplace"),
    { enabled: Boolean(token) }
  );
  const announcementQuery = useQuery<ConsoleAnnouncement>(
    token ? "console:announcement" : null,
    () => fetcher("/console/announcement"),
    { enabled: Boolean(token), ttlMs: 30_000 }
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
  const me = meQuery.data?.device;
  const quota = quotaQuery.data;
  const usage = usageQuery.data;
  const models = modelsQuery.data;

  return (
    <div className="flex min-h-screen bg-slate-50/50 dark:bg-slate-950">
      <a href="#console-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-3 focus:text-blue-700">跳到主要内容</a>
      <aside className="hidden md:flex w-64 shrink-0 border-r border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 flex-col">
        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800">
          <div className="font-bold text-slate-900 dark:text-slate-100 text-sm tracking-tight">用户控制台</div>
          <div className="text-[11px] text-slate-400 dark:text-slate-500 font-medium truncate">
            {me?.name || "正在读取账户"}
          </div>
        </div>
        <div className="p-4 space-y-2 text-xs text-slate-500 dark:text-slate-400">
          <div>设备 ID</div>
          <div className="font-mono text-[11px] break-all text-slate-700 dark:text-slate-300">{me?.id || "-"}</div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={logout}
          >
            退出 / 更换 Token
          </Button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/95 sm:px-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">用户控制台</h1>
              {me ? <Badge tone={me.enabled ? "green" : "red"}>{me.enabled ? "账户已启用" : "账户已停用"}</Badge> : null}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => {
                meQuery.refresh(true); quotaQuery.refresh(true); usageQuery.refresh(true);
                modelsQuery.refresh(true); marketplaceQuery.refresh(true); announcementQuery.refresh(true);
              }}>刷新数据</Button>
              <Button variant="ghost" size="sm" className="md:hidden" onClick={logout}>退出 / 更换 Token</Button>
            </div>
          </div>
          <ConsoleNavigation active={tab} onChange={setTab} />
        </header>

        <main id="console-main" className="mx-auto w-full max-w-7xl flex-1 space-y-5 p-4 sm:p-6">
          <ConsoleSectionIntro section={tab} />
          { }
          <div hidden={tab !== "video"}>
            <ConsoleStandardVideoCard key={"standard:" + token} token={token} models={modelsQuery.data ?? null} active={tab === "video"} />
            <ConsoleVideoCard key={token} token={token} models={modelsQuery.data ?? null} active={tab === "video"} />
          </div>
          {tab === "guide" ? (
            <ConsoleGuide models={modelsQuery.data} onOpenModels={() => setTab("models")} />
          ) : tab === "models" ? (
            <ConsoleModelsSquare
              models={marketplaceQuery.data}
              loading={marketplaceQuery.loading}
              error={marketplaceQuery.error}
            />
          ) : tab === "video" ? null : (
            <>
          { 

}
          {announcementQuery.data?.enabled && announcementQuery.data.message ? (
            <AnnouncementBanner notice={announcementQuery.data} />
          ) : null}

          {meQuery.error ? (
            <Card>
              <div className="text-sm text-rose-600 dark:text-rose-400">{meQuery.error.message}</div>
            </Card>
          ) : null}

          <section aria-labelledby="console-balance-heading" className="space-y-3">
            <div><h3 id="console-balance-heading" className="font-semibold text-slate-900 dark:text-slate-100">余额与额度</h3>
              <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">钱包余额与月卡额度分开管理；用量花费不等同于钱包扣款。</p></div>
            {quotaQuery.error ? <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">余额与额度读取失败，请点击“刷新数据”重试。未读取到的数据以 — 显示。</p> : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="可用余额" value={quota ? fmtUsd(quota.available_usd) : "—"}
                hint={quota && quota.reserved_usd > 0 ? `预占中 ${fmtUsd(quota.reserved_usd)}（进行中请求暂时保留的金额）` : undefined}>
                <ConsoleContact balance />
              </Stat>
              <Stat label="今日消费" value={usage ? fmtUsd(todayCost) : "—"}
                hint={todayCostIsExact ? "按服务端统计日期" : "按服务端日期，取最近一天"} />
              <Stat label="本月花费" value={quota ? fmtUsd(quota.monthly_cost_usd) : "—"}
                hint={quota ? quota.monthly_cost_limit_usd > 0 ? `上限 ${fmtUsd(quota.monthly_cost_limit_usd)}` : "未设置上限" : "等待读取额度"} />
            </div>
          </section>

          <section aria-labelledby="console-usage-heading" className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 id="console-usage-heading" className="font-semibold text-slate-900 dark:text-slate-100">用量统计 · {RANGES.find(r => r.key === range)?.label}</h3>
                <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">以下汇总、按模型用量和请求明细使用同一时间范围，不影响本月额度。</p></div>
              <div role="group" aria-label="用量时间范围" className="flex flex-wrap gap-1">
                {RANGES.map(r => <Button key={r.key} size="sm" aria-pressed={range === r.key}
                  variant={range === r.key ? "primary" : "secondary"} onClick={() => { setRange(r.key); setOffset(0); }}>{r.label}</Button>)}
              </div>
            </div>
            {usageQuery.error ? <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">用量读取失败，请刷新重试；无法读取不代表没有调用记录。</p> : null}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Stat label="请求数" value={usage ? fmtInt(usage.summary.request_count) : "—"} />
              <Stat label="总花费" value={usage ? fmtUsd(usage.summary.cost_usd) : "—"} hint="所选时间范围的用量金额" />
              <Stat label="错误数" value={usage ? fmtInt(usage.summary.error_count) : "—"} />
              <Stat label="总 Token" value={usage ? fmtInt(usage.summary.total_tokens) : "—"} />
              <Stat label="输入 Token" value={usage ? fmtInt(usage.summary.input_tokens) : "—"} />
              <Stat label="输出 Token" value={usage ? fmtInt(usage.summary.output_tokens) : "—"} />
            </div>
          </section>

          {quota?.low_balance_warning ? (
            <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
              {quota.available_usd < 0
                ? `已透支 ${fmtUsd(Math.abs(quota.available_usd))}：超出预占的部分已按实际用量记账，充值后先抵扣欠款。`
                : `钱包可用余额仅 ${fmtUsd(quota.available_usd)}。月卡覆盖的文本请求仍可使用月卡额度；其他请求或钱包兜底需要足够余额。`}
            </div>
          ) : null}

          {quota?.monthly_cost_exceeded ? (
            <div className="rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
              本月花费已达到上限 {fmtUsd(quota.monthly_cost_limit_usd)}，后续请求可能被网关拒绝。
            </div>
          ) : null}

          {(usage?.summary?.pricing_missing_count || 0) > 0 ? (
            <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
              有 {usage?.summary?.pricing_missing_count} 条记录缺少价格配置，其花费按 0 计入，统计偏低。
            </div>
          ) : null}

          {me && me.calls_enabled === false ? (
            <div className="rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
              主 Token 当前处于「禁止调用」状态，网关会拒绝新请求（子 Token 不受影响）。
              在下方「Token 管理」里可以自行恢复。
            </div>
          ) : null}

          <ConsoleMonthlyPass scope={scope} onChange={() => { void quotaQuery.refresh(true).catch(() => {}); }} />

          <AccountPanel
            scope={scope}
            onServiceGroupsChange={() => {
              void meQuery.refresh(true).catch(() => {});
              void modelsQuery.refresh(true).catch(() => {});
              void marketplaceQuery.refresh(true).catch(() => {});
            }}
            onCallsChange={() => {
              meQuery.refresh(true);
            }}
          />

          <ConsoleChatCard models={models || null} />

          <Card title="按模型用量">
            <p className="mb-3 text-xs leading-5 text-slate-500 dark:text-slate-400">统计范围：{RANGES.find(r => r.key === range)?.label}。Token 为用量单位，花费以各模型计价规则为准。</p>
            {usageQuery.loading ? (
              <Spinner text="正在加载用量…" />
            ) : (usage?.by_model?.length ? (
              <div className="overflow-x-auto" role="region" aria-label="可横向滚动的用量表格" tabIndex={0}>
                <table className="w-full min-w-[32rem] text-sm tabular-nums">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                      <th scope="col" className="py-2 pr-3 font-medium">模型</th>
                      <th scope="col" className="py-2 pr-3 font-medium">请求数</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Token</th>
                      <th scope="col" className="py-2 font-medium">花费</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.by_model.map((m) => (
                      <tr key={m.model} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="py-2 pr-3 text-slate-800 dark:text-slate-200">
                          {m.model}
                          {m.pricing_missing_count > 0 ? (
                            <Badge tone="amber" className="ml-2">
                              缺价
                            </Badge>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3">{fmtInt(m.request_count)}</td>
                        <td className="py-2 pr-3">{fmtInt(m.total_tokens)}</td>
                        <td className="py-2">{fmtUsd(m.cost_usd)}</td>
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
            <p className="mb-3 text-xs leading-5 text-slate-500 dark:text-slate-400">所选时间范围内的调用记录，每页最多 50 条；花费与钱包扣款可能因月卡等权益而不同。</p>
            {usageQuery.loading ? (
              <Spinner text="正在加载明细…" />
            ) : (usage?.items?.length ? (
              <div className="overflow-x-auto" role="region" aria-label="可横向滚动的用量表格" tabIndex={0}>
                <table className="w-full min-w-[32rem] text-sm tabular-nums">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                      <th scope="col" className="py-2 pr-3 font-medium">时间</th>
                      <th scope="col" className="py-2 pr-3 font-medium">模型</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Token</th>
                      <th scope="col" className="py-2 pr-3 font-medium">耗时</th>
                      <th scope="col" className="py-2 font-medium">花费</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.items.map((it) => (
                      <tr key={it.id} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="py-2 pr-3 whitespace-nowrap text-slate-600 dark:text-slate-300">
                          {fmtTime(it.created_at)}
                        </td>
                        <td className="py-2 pr-3 text-slate-800 dark:text-slate-200">
                          {it.model || "-"}
                        </td>
                        <td className="py-2 pr-3">{fmtInt(it.total_tokens)}</td>
                        <td className="py-2 pr-3">{it.latency_ms ? `${it.latency_ms} ms` : "-"}</td>
                        <td className="py-2">
                          {fmtUsd(it.cost_usd)}
                          {it.pricing_missing ? (
                            <Badge tone="amber" className="ml-2">
                              缺价
                            </Badge>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty text={usageQuery.error ? "暂时无法显示用量，请刷新重试" : "所选时间范围内暂无调用记录"} />
            ))}
            <div className="mt-3 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>
                {usage ? `第 ${Math.floor(offset / (usage.page.limit || 50)) + 1} 页` : ""}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!usage || usage.items.length < (usage.page.limit || 50)}
                  onClick={() => setOffset(offset + 50)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </Card>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
