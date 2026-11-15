import { useCallback, useRef, useState } from "react";
import {
  consoleAccountApi,
  ConsoleError,
  type ConsoleAccountSession,
  type ConsoleSubToken,
} from "../api/consoleClient";
import { useQuery } from "../hooks/useQuery";
import { Badge, Button, Card, Empty, Input, Spinner } from "./ui";
import { useToast } from "./Toast";
import { ConsoleTokenPolicies } from "./ConsoleTokenPolicies";
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
          "登录状态无法保存：会话凭证没有被保存（可能通过 http:// 访问、浏览器禁用了 Cookie，或所在网络剥离了登录状态）。请使用 https:// 直连后重试。"
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
                  请设置一个控制台密码，{PASSWORD_MIN}-{PASSWORD_MAX} 位，只能用字母、数字和常见英文符号。之后新建、停用 Token 等操作都需要它。
                  密码忘记无法自助重置，需要联系管理员。
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
            { 


}
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

export function AccountPanel({ scope, onCallsChange, onServiceGroupsChange }: { scope: string; onCallsChange: (enabled: boolean) => void; onServiceGroupsChange?: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [freshToken, setFreshToken] = useState<{ name: string; token: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const tokensQuery = useQuery(
    "console:" + scope + (showRevoked ? ":tokens:with-revoked" : ":tokens"),
    () => consoleAccountApi.tokens(showRevoked),
    { ttlMs: 0 }
  );
  const callsQuery = useQuery(
    "console:" + scope + ":calls",
    () => consoleAccountApi.calls(),
    { ttlMs: 0 }
  );

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
    if (!trimmed) return;
    setCreating(true);
    try {
      const res = await consoleAccountApi.createToken(trimmed);
      setFreshToken({ name: res.item.name, token: res.token });
      setName("");
      tokensQuery.refresh(true);
      toast.success("已创建子 Token，明文只显示这一次");
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
      tokensQuery.refresh(true);
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
      tokensQuery.refresh(true);
      toast.success("已撤销");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  };

  const rows = list?.items ?? [];
  const remaining = list?.remaining ?? 0;

  return (
    <Card title="账户与 Token">
      <div className="space-y-5">
        <ConsoleTokenPolicies key={scope} onChanged={onServiceGroupsChange} tokens={rows.filter(row => !row.revoked).map(row => ({ id: row.id, name: row.name }))} />
        <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-200/80 dark:border-slate-800 px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
              主 Token 调用
              {callsEnabled ? <Badge tone="green" className="ml-2">允许</Badge> : <Badge tone="red" className="ml-2">已禁止</Badge>}
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
              关掉后，用主 Token 发起的调用会被拒绝；子 Token 照常可用，控制台也照常可登录，
              正在流式返回的响应不会被打断。
            </div>
          </div>
          <Button variant="outline" size="sm" disabled={busyId === "calls"} onClick={toggleCalls}>
            {callsEnabled ? "禁止调用" : "恢复调用"}
          </Button>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-slate-800 dark:text-slate-100">子 Token</div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 select-none cursor-pointer">
                <input
                  type="checkbox"
                  checked={showRevoked}
                  onChange={(e) => setShowRevoked(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span>显示已撤销</span>
              </label>
              <div className="text-[11px] text-slate-400 dark:text-slate-500">
                剩余名额 {remaining} / {list?.limit ?? 5}
              </div>
            </div>
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-2 leading-relaxed">
            子 Token 的花费全部记在主 Token 的账上，用量页可以按子 Token 拆开看。
            子 Token 不能登录控制台。
          </div>
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="用途备注，例如 ci-runner"
              maxLength={100}
            />
            <Button size="sm" disabled={creating || !name.trim() || remaining <= 0} onClick={create}>
              {creating ? "创建中…" : "新建"}
            </Button>
          </div>
          {freshToken ? (
            <div className="mt-2 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
              <div className="text-[11px] text-amber-700 dark:text-amber-300 mb-1">
                「{freshToken.name}」的明文如下，只显示这一次，请立即复制保存：
              </div>
              <code className="block break-all font-mono text-xs text-amber-900 dark:text-amber-200">{freshToken.token}</code>
              <button
                type="button"
                className="mt-1 text-[11px] underline text-amber-700 dark:text-amber-300"
                onClick={() => setFreshToken(null)}
              >
                我已保存
              </button>
            </div>
          ) : null}

          <div className="mt-3">
            {tokensQuery.loading ? (
              <Spinner text="正在加载子 Token…" />
            ) : tokensQuery.error ? (
              <div className="text-sm text-rose-600 dark:text-rose-400">{tokensQuery.error.message}</div>
            ) : rows.length === 0 ? (
              <Empty text={showRevoked ? "还没有子 Token" : "还没有可用的子 Token"} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                      <th className="py-2 pr-3 font-medium">备注</th>
                      <th className="py-2 pr-3 font-medium">状态</th>
                      <th className="py-2 pr-3 font-medium">最近使用</th>
                      <th className="py-2 font-medium text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="py-2 pr-3 text-slate-800 dark:text-slate-200">{row.name}</td>
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
                          {row.last_used_at ? new Date(row.last_used_at).toLocaleString() : "-"}
                        </td>
                        <td className="py-2 text-right whitespace-nowrap">
                          {row.revoked ? null : (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyId === row.id}
                                onClick={() => setEnabled(row, !row.enabled)}
                              >
                                {row.enabled ? "禁用" : "启用"}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyId === row.id}
                                onClick={() => revoke(row)}
                              >
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
        </div>
      </div>
    </Card>
  );
}

export type { ConsoleAccountSession };