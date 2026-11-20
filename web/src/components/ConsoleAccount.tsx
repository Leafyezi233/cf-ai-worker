import { useEffect, useRef, useState } from "react";
import {
  consoleAccountApi,
  ConsoleError,
  type ConsoleAccountSession,
  type ConsoleSubToken,
} from "../api/consoleClient";
import { useQuery } from "../hooks/useQuery";
import { Badge, Button, Card, CopyButton, Empty, Input, Spinner } from "./ui";
import { useToast } from "./Toast";
import { ConsoleTokenPolicies } from "./ConsoleTokenPolicies";
import { IconCheck, IconKey, IconShield } from "./icons";
import { relativeTime } from "../utils/relativeTime";
import { ConsoleAuthShell } from "./ConsoleAuthShell";

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 20;
const PASSWORD_ALLOWED = /^[A-Za-z0-9!@#$%^&*()_\-+=.,:;?\/[\]{}|~]+$/;

export function PasswordScreen({
  mode,
  deviceName,
  onDone,
  onChangeToken,
}: {
  mode: "setup" | "login";
  deviceName?: string;
  onDone: () => void;
  onChangeToken: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement | null>(null);

  const isSetup = mode === "setup";
  const tooShort = isSetup && password.length > 0 && password.length < PASSWORD_MIN;
  const badChar = isSetup && password.length > 0 && !PASSWORD_ALLOWED.test(password);
  const mismatch = isSetup && confirm.length > 0 && confirm !== password;

  const readFields = () => {
    const boxes = formRef.current
      ? Array.from(formRef.current.querySelectorAll<HTMLInputElement>("input[type=password]"))
      : [];
    const typedPassword = boxes[0] ? boxes[0].value : password;
    const typedConfirm = boxes[1] ? boxes[1].value : confirm;
    if (typedPassword !== password) setPassword(typedPassword);
    if (typedConfirm !== confirm) setConfirm(typedConfirm);
    return { typedPassword, typedConfirm };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const { typedPassword, typedConfirm } = readFields();
    if (!typedPassword) {
      setError("请输入密码");
      return;
    }
    if (isSetup) {
      if (typedPassword.length < PASSWORD_MIN) {
        setError("密码至少 " + PASSWORD_MIN + " 位");
        return;
      }
      if (typedPassword.length > PASSWORD_MAX) {
        setError("密码不能超过 " + PASSWORD_MAX + " 位");
        return;
      }
      if (!PASSWORD_ALLOWED.test(typedPassword)) {
        setError("只能用字母、数字和常见英文符号（不能有空格或中文）");
        return;
      }
      if (typedConfirm !== typedPassword) {
        setError("两次输入不一致");
        return;
      }
    }
    setBusy(true);
    setError("");
    try {
      if (isSetup) await consoleAccountApi.setupPassword(typedPassword);
      else await consoleAccountApi.login(typedPassword);
      const check = await consoleAccountApi.session();
      if (!check.authenticated) {
        setError(
          "登录状态未能保存。请使用 https:// 访问，并确认浏览器允许 Cookie。"
        );
        return;
      }
      setPassword("");
      setConfirm("");
      onDone();
    } catch (err) {
      const code = err instanceof ConsoleError ? (err as ConsoleError & { code?: string }).code : undefined;
      if (code === "locked") setError("尝试次数过多，已临时锁定，请稍后再试。");
      else if (code === "invalid_password") setError("密码错误，请重试。");
      else if (code === "unauthorized") setError("Token 已失效，请换一个 Token。");
      else if (code === "password_already_set" || code === "password_setup_conflict") {
        setPassword("");
        setConfirm("");
        setError("密码状态已变化，请重新验证。");
        onDone();
        return;
      } else setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConsoleAuthShell step={2} title={isSetup ? "设置控制台密码" : "输入控制台密码"}
      description={isSetup ? "首次使用，设置密码以保护你的账户管理操作。" : "完成密码验证，继续管理用量与模型服务。"}>
          <form ref={formRef} onSubmit={submit} className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {isSetup ? (
                <>
                  Token 已验证{deviceName ? "（" + deviceName + "）" : ""}。
                  请设置 {PASSWORD_MIN}-{PASSWORD_MAX} 位控制台密码，可用字母、数字和常见英文符号。忘记密码需联系管理员重置。
                </>
              ) : (
                <>请输入该设备 Token 对应的控制台密码。</>
              )}
            </p>
            <label htmlFor="console-password" className="block text-sm font-medium text-slate-700 dark:text-slate-200">{isSetup ? "设置密码" : "控制台密码"}</label>
            <Input
              id="console-password"
              name="password"
              autoComplete={isSetup ? "new-password" : "current-password"}
              className="!py-3"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isSetup ? `${PASSWORD_MIN}-${PASSWORD_MAX} 位` : "控制台密码"}
              maxLength={isSetup ? PASSWORD_MAX : undefined}
              autoFocus
            />
            {tooShort ? (
              <div className="text-xs text-rose-600 dark:text-rose-400">密码至少 {PASSWORD_MIN} 位</div>
            ) : null}
            {badChar ? (
              <div className="text-xs text-rose-600 dark:text-rose-400">
                只能用字母、数字和常见英文符号（不能有空格或中文）
              </div>
            ) : null}
            {isSetup ? (
              <>
                <label htmlFor="console-password-confirm" className="block text-sm font-medium text-slate-700 dark:text-slate-200">确认密码</label>
                <Input
                  id="console-password-confirm"
                  name="confirm-password"
                  autoComplete="new-password"
                  className="!py-3"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="再输入一次"
                  maxLength={PASSWORD_MAX}
                />
                {mismatch ? <div className="text-xs text-rose-600 dark:text-rose-400">两次输入不一致</div> : null}
              </>
            ) : null}
            {error ? <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:bg-rose-950/30 dark:text-rose-400">{error}</div> : null}
            <Button type="submit" disabled={busy} size="lg" className="w-full">
              {busy ? "处理中…" : isSetup ? "设置并进入" : "进入控制台"}
            </Button>
            <button
              type="button"
              onClick={onChangeToken}
              className="block text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              换一个 Token
            </button>
          </form>
    </ConsoleAuthShell>
  );
}

export function AccountPanel({ scope, section, active = true, onCallsChange, onServiceGroupsChange, onOpenGuide }: {
  scope: string;
  section?: "keys" | "security";
  active?: boolean;
  onCallsChange: (enabled: boolean) => void;
  onServiceGroupsChange?: () => void;
  onOpenGuide?: () => void;
}) {
  const showKeys = section !== "security";
  const showSecurity = section !== "keys";
  const toast = useToast();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [freshToken, setFreshToken] = useState<{ name: string; token: string; epoch: number } | null>(null);
  const secretActive = active && showKeys;
  const secretContext = useRef({ scope, showKeys: secretActive, epoch: 0 });
  if (secretContext.current.scope !== scope || secretContext.current.showKeys !== secretActive) {
    secretContext.current = { scope, showKeys: secretActive, epoch: secretContext.current.epoch + 1 };
  }
  useEffect(() => {
    setFreshToken(null);
    return () => { secretContext.current.epoch++; };
  }, [scope, secretActive]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const tokensQuery = useQuery(
    "console:" + scope + (showRevoked ? ":tokens:with-revoked" : ":tokens"),
    () => consoleAccountApi.tokens(showRevoked),
    { ttlMs: 0, enabled: active && showKeys }
  );
  const callsQuery = useQuery(
    "console:" + scope + ":calls",
    () => consoleAccountApi.calls(),
    { ttlMs: 0, enabled: active && showSecurity }
  );

  const refreshTokens = useRef(tokensQuery.refresh);
  refreshTokens.current = tokensQuery.refresh;

  const list = tokensQuery.data;
  const callsEnabled = callsQuery.data?.calls_enabled ?? true;

  const toggleCalls = async () => {
    const next = !callsEnabled;
    setBusyId("calls");
    try {
      const res = await consoleAccountApi.setCalls(next);
      callsQuery.mutate({ calls_enabled: res.calls_enabled });
      onCallsChange(res.calls_enabled);
      toast.success(res.calls_enabled ? "已恢复主 Token 调用" : "已禁止主 Token 新调用（子 Token 不受影响）");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating || !secretActive) return;
    const epoch = secretContext.current.epoch;
    setCreating(true);
    try {
      const res = await consoleAccountApi.createToken(trimmed);
      if (secretContext.current.epoch === epoch && secretContext.current.showKeys) {
        setFreshToken({ name: res.item.name, token: res.token, epoch });
        refreshTokens.current(true);
        toast.success("已创建子 Token，明文只显示这一次");
      } else {
        toast.success("已创建子 Token；已离开密钥页面，明文已清除。如未保存，请撤销后重新创建。");
      }
      setName("");
    } catch (err) {
      const code = err instanceof ConsoleError ? (err as ConsoleError & { code?: string }).code : undefined;
      toast.error(code === "sub_token_limit_reached" ? "最多只能有 5 个可用子 Token" : err instanceof Error ? err.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const setEnabled = async (row: ConsoleSubToken, enabled: boolean) => {
    setBusyId(row.id);
    try {
      await consoleAccountApi.setTokenEnabled(row.id, enabled);
      refreshTokens.current(true);
      toast.success(enabled ? "已启用" : "已禁用");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (row: ConsoleSubToken) => {
    if (!window.confirm("撤销后无法恢复，且该子 Token 的明文不能再取回。确定撤销「" + row.name + "」？")) return;
    setBusyId(row.id);
    try {
      await consoleAccountApi.revokeToken(row.id);
      refreshTokens.current(true);
      toast.success("已撤销");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  };

  const rows = list?.items ?? [];
  const remaining = list?.remaining ?? 0;
  const limit = list?.limit ?? 5;
  const atLimit = Boolean(list) && remaining <= 0;
  const title = section === "keys" ? "API 密钥与 Token" : section === "security" ? "账户安全" : "账户与 Token";

  const securityBlock = showSecurity && <div className="flex flex-wrap items-start justify-between gap-4">
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
        主 Token 调用
        {callsEnabled ? <Badge tone="green" dot>允许</Badge> : <Badge tone="red" dot>已禁止</Badge>}
      </div>
      <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500 dark:text-slate-400">
        禁止后，主 Token 发起的新请求会被拒绝；子 Token 和控制台登录不受影响，进行中的请求不会中断。
      </p>
    </div>
    <Button variant={callsEnabled ? "outline" : "primary"} size="sm" disabled={busyId === "calls"} onClick={toggleCalls}>
      {callsEnabled ? "禁止调用" : "恢复调用"}
    </Button>
  </div>;

  const keysBlock = showKeys && <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-brand-200/80 bg-brand-50/60 p-3.5 dark:border-brand-900/60 dark:bg-brand-500/10">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-50">
          <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand-600 text-white"><IconKey className="h-3.5 w-3.5" /></span>
          API 密钥（子 Token）
        </div>
        <p className="mt-1.5 text-xs leading-5 text-slate-600 dark:text-slate-300">填进应用和代码里调用模型。每个应用单独创建一个，泄露时只需撤销那一个；花费计入本账户。</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 dark:border-slate-800 dark:bg-slate-800/30">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-50">
          <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-lg bg-slate-700 text-white dark:bg-slate-600"><IconShield className="h-3.5 w-3.5" /></span>
          登录 Token（主 Token）
        </div>
        <p className="mt-1.5 text-xs leading-5 text-slate-600 dark:text-slate-300">用来登录这个控制台，由管理员分配。不要填进第三方应用；子 Token 不能用来登录。</p>
      </div>
    </div>
    <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <Input
        aria-label="新子 Token 的用途备注"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="用途备注，例如 ci-runner"
        maxLength={100}
        disabled={atLimit}
      />
      <Button type="button" className="shrink-0 whitespace-nowrap" disabled={creating || !name.trim() || remaining <= 0} onClick={create}>
        {creating ? "创建中…" : "新建"}
      </Button>
    </form>
    {atLimit ? <p className="text-xs text-amber-700 dark:text-amber-300">已达到 {limit} 个可用子 Token 的上限；撤销不再使用的子 Token 后可再创建。</p> : null}
    {freshToken && freshToken.epoch === secretContext.current.epoch ? (
      <div role="status" className="overflow-hidden rounded-xl border border-emerald-300/80 bg-white shadow-card dark:border-emerald-800/70 dark:bg-slate-900 dark:shadow-none">
        <div className="flex items-start gap-2.5 border-b border-emerald-200/70 bg-emerald-50 px-4 py-3 dark:border-emerald-900/60 dark:bg-emerald-950/30">
          <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white"><IconCheck className="h-3 w-3" /></span>
          <div className="min-w-0 text-sm font-medium text-emerald-900 dark:text-emerald-200">
            「{freshToken.name}」已创建，明文只显示这一次，请立即复制保存：
          </div>
        </div>
        <div className="p-4">
        <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-[#0b1020] px-3 py-2.5">
          <code className="m-0 min-w-0 flex-1 break-all rounded-none border-0 bg-transparent p-0 font-mono text-[13px] text-emerald-300 dark:bg-transparent dark:text-emerald-300">{freshToken.token}</code>
          <CopyButton text={freshToken.token} label="复制" className="rounded-md bg-white/10 px-2.5 py-1 text-white hover:bg-white/20" />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span>粘贴到应用的“API Key / API 密钥”一栏。</span>
          <CopyButton text={'export CPG_API_KEY="' + freshToken.token + '"'} label="复制为环境变量" className="rounded px-1 py-0.5 text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-500/10" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setFreshToken(null)}>我已保存</Button>
          {onOpenGuide && <Button type="button" size="sm" onClick={() => { setFreshToken(null); onOpenGuide(); }}>前往接入指南</Button>}
        </div>
        </div>
      </div>
    ) : null}

    <div>
      {tokensQuery.loading ? (
        <Spinner text="正在加载子 Token…" />
      ) : tokensQuery.error ? (
        <div role="alert" className="text-sm text-rose-600 dark:text-rose-400">{tokensQuery.error.message}</div>
      ) : rows.length === 0 ? (
        <Empty text={showRevoked ? "还没有子 Token" : "还没有可用的子 Token，填写用途备注后点击“新建”"} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                <th scope="col" className="py-2 pr-3 font-medium">备注</th>
                <th scope="col" className="py-2 pr-3 font-medium">状态</th>
                <th scope="col" className="py-2 pr-3 font-medium">最近使用</th>
                <th scope="col" className="py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={"border-t border-slate-100 dark:border-slate-800" + (row.revoked ? " text-slate-400 dark:text-slate-500" : "")}>
                  <td className="py-2.5 pr-3">
                    <div className={"font-medium " + (row.revoked ? "" : "text-slate-800 dark:text-slate-200")}>{row.name}</div>
                    {row.created_at ? <div className="text-[11px] text-slate-400 dark:text-slate-500">创建于 {new Date(row.created_at).toLocaleDateString()}</div> : null}
                  </td>
                  <td className="py-2 pr-3">
                    {row.revoked ? (
                      <Badge tone="slate">已撤销</Badge>
                    ) : row.enabled ? (
                      <Badge tone="green">启用</Badge>
                    ) : (
                      <Badge tone="amber">已禁用</Badge>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-500 dark:text-slate-400">
                    {row.last_used_at ? <span title={new Date(row.last_used_at).toLocaleString()}>{relativeTime(row.last_used_at)}</span> : "从未使用"}
                  </td>
                  <td className="whitespace-nowrap py-2 text-right">
                    {row.revoked ? null : (
                      <>
                        <Button variant="ghost" size="sm" disabled={busyId === row.id} onClick={() => setEnabled(row, !row.enabled)}>
                          {row.enabled ? "禁用" : "启用"}
                        </Button>
                        <Button variant="ghost" size="sm" className="text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40" disabled={busyId === row.id} onClick={() => revoke(row)}>
                          撤销
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  </div>;

  const keysAction = showKeys ? <div className="flex items-center gap-3">
    <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
      <input
        type="checkbox"
        checked={showRevoked}
        onChange={(e) => setShowRevoked(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
      />
      <span>显示已撤销</span>
    </label>
    <Badge tone={atLimit ? "amber" : "slate"}>剩余名额 {remaining} / {limit}</Badge>
  </div> : undefined;

  return (
    <div className="space-y-5">
      <Card title={title} action={keysAction}>
        <div className="space-y-5">
          {showKeys && <div className="text-sm font-medium text-slate-800 dark:text-slate-100">子 Token</div>}
          {keysBlock}
          {showKeys && showSecurity ? <div className="border-t border-slate-100 dark:border-slate-800" /> : null}
          {securityBlock}
        </div>
      </Card>
      {showKeys && <details className="group rounded-xl border border-slate-200/60 bg-white dark:border-slate-800 dark:bg-slate-900">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 sm:px-5 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">高级：调用策略与模型范围</span>
            <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">为某个 Token 单独指定服务分组和可用模型；不设置则沿用账户默认。</span>
          </span>
          <span aria-hidden="true" className="shrink-0 text-slate-400 transition-transform group-open:rotate-90">›</span>
        </summary>
        <div className="border-t border-slate-100 p-4 dark:border-slate-800 sm:p-5">
          <ConsoleTokenPolicies key={scope} onChanged={onServiceGroupsChange} tokens={rows.filter(row => !row.revoked).map(row => ({ id: row.id, name: row.name }))} />
        </div>
      </details>}
    </div>
  );
}

export type { ConsoleAccountSession };
