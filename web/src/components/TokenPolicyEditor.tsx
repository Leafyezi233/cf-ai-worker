import { useRef, useState } from "react";
import { Button, Select } from "./ui";

export interface TokenRoutingPolicy {
  mode: "auto" | "legacy" | "fixed" | "multi";
  group_ids: string[];
  selection: "ordered" | "input_price";
  failure_fallback: boolean;
  model_overrides: Record<string, string>;
  model_scope: string[] | null;
}

export interface TokenPolicyState {
  policy: TokenRoutingPolicy | null;
  effective_policy: TokenRoutingPolicy;
  source: string;
  version: string | number;
  following_token_count?: number;
}

export interface TokenPolicyGroup {
  id: string;
  name: string;
  enabled?: boolean;
  available?: boolean;
}

export interface TokenPolicyScopeOption {
  key: string;
  label: string;
  compatible_name?: string;
  group_ids?: string[];
}

export interface TokenPolicyEditorProps {
  target?: string;
  label?: string;
  value?: TokenPolicyState | null;
  groups: TokenPolicyGroup[];
  scopeOptions: TokenPolicyScopeOption[];
  onSave: (policy: TokenRoutingPolicy | null) => Promise<unknown>;
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
}

export function newTokenRoutingPolicy(): TokenRoutingPolicy {
  return { mode: "auto", group_ids: [], selection: "ordered", failure_fallback: false, model_overrides: {}, model_scope: null };
}

function copyPolicy(policy: TokenRoutingPolicy): TokenRoutingPolicy {
  return { ...policy, group_ids: [...policy.group_ids], model_overrides: { ...policy.model_overrides },
    model_scope: policy.model_scope === null ? null : [...policy.model_scope] };
}

export function uniquePolicyScopeOptions(options: TokenPolicyScopeOption[]): TokenPolicyScopeOption[] {
  return Array.from(new Map(options.map(option => [option.key, option])).values());
}

export function movePolicyGroup(policy: TokenRoutingPolicy, index: number, direction: -1 | 1): TokenRoutingPolicy {
  const next = copyPolicy(policy);
  const destination = index + direction;
  if (index < 0 || index >= next.group_ids.length || destination < 0 || destination >= next.group_ids.length) return next;
  [next.group_ids[index], next.group_ids[destination]] = [next.group_ids[destination], next.group_ids[index]];
  return next;
}

export function tokenPolicyDraftError(policy: TokenRoutingPolicy): string | null {
  if (policy.mode === "fixed" && policy.group_ids.length !== 1) return "固定模式必须选择一个分组。";
  if (policy.mode === "multi" && policy.group_ids.length < 1) return "多组模式至少选择一个分组。";
  if ((policy.mode === "auto" || policy.mode === "legacy") && policy.group_ids.length) return "自动或旧版模式不能指定固定分组。";
  if (Object.values(policy.model_overrides).some(id => !policy.group_ids.includes(id))) return "模型例外必须指向已选分组；请修改或移除失效例外。";
  return null;
}

const modeNames: Record<TokenRoutingPolicy["mode"], string> = {
  auto: "自动选择", legacy: "旧版默认路由", fixed: "固定单组", multi: "多组选组",
};

function groupAvailable(group: TokenPolicyGroup | undefined): boolean {
  return !!group && group.enabled !== false && group.available !== false;
}

export function TokenPolicyEditor(props: TokenPolicyEditorProps) {
  const target = props.target ?? "account";
  const title = props.label ?? (target === "account" ? "账户默认路由策略" : target === "master" ? "主 Token 路由策略" : "子 Token 路由策略");
  return <section aria-label={title} className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
    <h3 className="text-sm font-medium">{title}</h3>
    {props.error && <p role="alert" className="text-sm text-rose-600">{props.error}</p>}
    {props.loading && <p role="status" className="text-sm text-slate-500">正在加载路由策略…</p>}
    {!props.value ? (!props.loading && !props.error && <p className="text-sm text-slate-500">暂无策略数据，请刷新后重试。</p>) :
      <PolicyForm key={target + ":" + JSON.stringify(props.value)} {...props} value={props.value} target={target} />}
  </section>;
}

function PolicyForm({ target, value, groups, scopeOptions, onSave, disabled, loading, error }: TokenPolicyEditorProps & { target: string; value: TokenPolicyState }) {
  const account = target === "account";
  const [inherit, setInherit] = useState(value.policy === null);
  const [draft, setDraft] = useState(() => value.policy ? copyPolicy(value.policy) : { ...copyPolicy(value.effective_policy), failure_fallback: false });
  const [baseline, setBaseline] = useState(() => JSON.stringify(value.policy));
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmAccount, setConfirmAccount] = useState(false);
  const [overrideKey, setOverrideKey] = useState("");
  const [overrideGroup, setOverrideGroup] = useState("");
  const options = uniquePolicyScopeOptions(scopeOptions);
  const groupMap = new Map(groups.map(group => [group.id, group]));
  const optionMap = new Map(options.map(option => [option.key, option]));
  const locked = !!disabled || !!loading || !!error || busy;
  const payload = inherit ? null : draft;
  const compatibilityReset = inherit && value.policy === null && value.source === "compatibility" && !saved;
  const changed = JSON.stringify(payload) !== baseline || compatibilityReset;
  const overrideAvailable = (key: string, id: string) => optionMap.get(key)?.group_ids?.includes(id) ?? true;
  const validation = inherit ? null : tokenPolicyDraftError(draft) ?? (Object.entries(draft.model_overrides).some(([key, id]) => !overrideAvailable(key, id)) ? "模型例外在所选分组中不可用；请修改或移除该例外。" : null);
  const groupName = (id: string) => groupMap.get(id)?.name ?? id;
  const optionName = (key: string) => optionMap.get(key)?.label ?? "已失效模型";
  const update = (next: TokenRoutingPolicy) => { setDraft(next); setSaveError(""); setSaved(false); setConfirmAccount(false); };
  const sourceName = value.source === "token" ? "此 Token 独立策略" : value.source === "account" ? "账户默认" : value.source === "compatibility" ? "兼容旧配置" : value.source;
  const effective = value.effective_policy;
  const missingGroups = [...new Set([...draft.group_ids, ...Object.values(draft.model_overrides)])].filter(id => !groupAvailable(groupMap.get(id)));
  const missingKeys = [...new Set([...(draft.model_scope ?? []), ...Object.keys(draft.model_overrides)])].filter(key => !optionMap.has(key));

  async function save() {
    if (saving.current || locked || !changed || validation) return;
    saving.current = true;
    setBusy(true); setSaveError(""); setSaved(false);
    const submitted = payload === null ? null : copyPolicy(payload);
    try {
      await onSave(submitted);
      setBaseline(JSON.stringify(submitted)); setSaved(true); setConfirmAccount(false);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "保存失败，请重试。");
    } finally { saving.current = false; setBusy(false); }
  }

  return <form className="space-y-4" onSubmit={event => {
    event.preventDefault();
    if (!changed || locked || validation) return;
    if (account && !confirmAccount) { setConfirmAccount(true); return; }
    void save();
  }}>
    <div className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed dark:bg-slate-800/60">
      <p>当前生效：{modeNames[effective.mode]}{effective.group_ids.length ? " · " + effective.group_ids.map(groupName).join(" → ") : ""}</p>
      <p>来源：{sourceName} · 版本：{value.version}</p>
      <p>当前失败切组：{effective.failure_fallback ? "已开启" : "关闭"}；当前模型范围：{effective.model_scope === null ? "继承账户授权范围" : effective.model_scope.length === 0 ? "无模型权限" : effective.model_scope.map(optionName).join("、")}</p>
      {effective.group_ids.some(id => !groupAvailable(groupMap.get(id))) && <p className="text-amber-700 dark:text-amber-300">当前生效策略包含不可用分组：{effective.group_ids.filter(id => !groupAvailable(groupMap.get(id))).join("、")}。不会自动替换或删除。</p>}
    </div>
    <label className="block space-y-1 text-sm">策略来源
      <Select aria-label="策略来源" value={inherit ? "inherit" : "override"} disabled={locked} onChange={event => {
        setInherit(event.target.value === "inherit"); setSaved(false); setSaveError(""); setConfirmAccount(false);
      }}>
        <option value="inherit">{account ? "沿用系统默认" : "跟随账户默认"}</option>
        <option value="override">{account ? "自定义账户默认" : "单独设置"}</option>
      </Select>
    </label>
    <p className="text-xs leading-relaxed text-slate-500">{inherit ? (account ? "保存后将恢复系统默认设置。" : "保存后将跟随账户默认设置。") : account ? "保存后，跟随账户默认的 Token 将使用这些设置。" : "单独设置后，不再跟随账户默认设置。"}</p>
    {compatibilityReset && !account && <p className="text-xs text-amber-700 dark:text-amber-300">当前仍可能沿用旧版单组覆盖；请保存继承，明确清除旧选择后才会整份继承账户默认。</p>}
    {!inherit && <fieldset disabled={locked} className="space-y-4 rounded-lg border border-slate-200 p-3 disabled:opacity-60 dark:border-slate-700">
      <legend className="px-1 text-sm font-medium">{account ? "自定义账户默认" : "单独设置"}</legend>
      <label className="block space-y-1 text-sm">路由模式
        <Select aria-label="路由模式" value={draft.mode} onChange={event => {
          const mode = event.target.value as TokenRoutingPolicy["mode"];
          const ids = mode === "auto" || mode === "legacy" ? [] : mode === "fixed" ? draft.group_ids.slice(0, 1) : [...draft.group_ids];
          update({ ...draft, mode, group_ids: ids, model_overrides: Object.fromEntries(Object.entries(draft.model_overrides).filter(([, id]) => ids.includes(id))) });
        }}>
          <option value="auto">自动（全部已授权可用组）</option><option value="legacy">旧版默认（原路由）</option>
          <option value="fixed">固定单组</option><option value="multi">多组（固定候选集合）</option>
        </Select>
      </label>
      <p className="text-xs text-slate-500">切换自动或旧版模式会清空固定组及模型例外；切换固定单组只保留首组及该组例外。</p>
      {(draft.mode === "fixed" || draft.mode === "multi") && <div className="space-y-2">
        <h4 className="text-sm font-medium">选择分组（固定候选集合）</h4>
        <p className="text-xs text-slate-500">新增授权不会自动扩张此固定集合；如需使用新组，请手动勾选并保存。</p>
        <div className="grid gap-2 sm:grid-cols-2">{groups.map(group => <label key={group.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.group_ids.includes(group.id)} disabled={!groupAvailable(group) && !draft.group_ids.includes(group.id)} onChange={event => {
            const ids = event.target.checked ? draft.mode === "fixed" ? [group.id] : [...draft.group_ids, group.id] : draft.group_ids.filter(id => id !== group.id);
            update({ ...draft, group_ids: ids });
          }} />{group.name}{!groupAvailable(group) && "（不可用）"}
        </label>)}</div>
        {!groups.length && <p className="text-xs text-slate-500">暂无可选分组。</p>}
        <ol aria-label="已选分组顺序" className="space-y-2">{draft.group_ids.map((id, index) => <li key={id} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{index + 1}. {groupName(id)}{!groupAvailable(groupMap.get(id)) && "（失效或无权限，已保留）"}</span>
          <Button type="button" size="sm" variant="ghost" aria-label={"上移 " + groupName(id)} disabled={index === 0 || draft.selection !== "ordered"} onClick={() => update(movePolicyGroup(draft, index, -1))}>上移</Button>
          <Button type="button" size="sm" variant="ghost" aria-label={"下移 " + groupName(id)} disabled={index === draft.group_ids.length - 1 || draft.selection !== "ordered"} onClick={() => update(movePolicyGroup(draft, index, 1))}>下移</Button>
          <Button type="button" size="sm" variant="ghost" aria-label={"移除分组 " + groupName(id)} onClick={() => update({ ...draft, group_ids: draft.group_ids.filter(group => group !== id) })}>移除</Button>
        </li>)}</ol>
      </div>}
      {draft.mode !== "legacy" && <label className="block space-y-1 text-sm">候选选择顺序
        <Select aria-label="候选选择顺序" value={draft.selection} onChange={event => update({ ...draft, selection: event.target.value as TokenRoutingPolicy["selection"] })}>
          <option value="ordered">按已选顺序（可上下排序）</option><option value="input_price">按输入价优先，再比较输出价</option>
        </Select>
      </label>}
      <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.failure_fallback} onChange={event => update({ ...draft, failure_fallback: event.target.checked })} />允许失败后切换分组</label>
        <p>风险提示：默认关闭。开启后，仅在服务端允许重试时改用其他候选组，价格可能改变，费用按成功使用的分组计算；不保证所有失败都能重试。视频任务不自动跨组重发。</p>
      </div>
      {missingGroups.length > 0 && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">失效或不可用分组已保留：{missingGroups.join("、")}。请明确修改或移除；不会静默删除或自动切换。</p>}
      <div className="space-y-2">
        <h4 className="text-sm font-medium">按模型固定例外</h4>
        <p className="text-xs text-slate-500">例外仅能固定到已选分组，不会增加模型权限。</p>
        <ul className="space-y-2">{Object.entries(draft.model_overrides).map(([key, id]) => <li key={key} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{optionName(key)} → {groupName(id)}{!draft.group_ids.includes(id) && "（不在已选分组中）"}</span>
          <Button type="button" size="sm" variant="ghost" aria-label={"移除模型例外 " + optionName(key)} onClick={() => update({ ...draft, model_overrides: Object.fromEntries(Object.entries(draft.model_overrides).filter(([model]) => model !== key)) })}>移除例外</Button>
        </li>)}</ul>
        <div className="grid gap-2 sm:grid-cols-3">
          <Select aria-label="例外模型" value={overrideKey} onChange={event => setOverrideKey(event.target.value)}>
            <option value="">选择模型…</option>{options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          </Select>
          <Select aria-label="例外固定分组" value={overrideGroup} onChange={event => setOverrideGroup(event.target.value)}>
            <option value="">选择已选分组…</option>{draft.group_ids.map(id => <option key={id} value={id} disabled={!groupAvailable(groupMap.get(id)) || (!!overrideKey && !overrideAvailable(overrideKey, id))}>{groupName(id)}{!groupAvailable(groupMap.get(id)) && "（不可用）"}</option>)}
          </Select>
          <Button type="button" size="sm" variant="secondary" disabled={!overrideKey || !optionMap.has(overrideKey) || !draft.group_ids.includes(overrideGroup) || !groupAvailable(groupMap.get(overrideGroup)) || !overrideAvailable(overrideKey, overrideGroup)} onClick={() => {
            update({ ...draft, model_overrides: { ...draft.model_overrides, [overrideKey]: overrideGroup } }); setOverrideKey(""); setOverrideGroup("");
          }}>设置模型例外</Button>
        </div>
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">可调用的模型</h4>
        <label className="block space-y-1 text-sm">范围来源
          <Select aria-label="模型范围来源" value={draft.model_scope === null ? "inherit" : "fixed"} onChange={event => update({ ...draft, model_scope: event.target.value === "inherit" ? null : [] })}>
            <option value="inherit">{"使用账户已获授权的全部模型"}</option><option value="fixed">只允许调用勾选的模型</option>
          </Select>
        </label>
        <p className="text-xs leading-relaxed text-slate-500">仅限账户已获授权的模型；新授权的模型需手动加入勾选范围。</p>
        {draft.model_scope !== null && <>
          {draft.model_scope.length === 0 && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">尚未勾选模型：保存后将无法调用任何模型，不会自动使用账户默认范围。</p>}
          <div className="grid gap-2 sm:grid-cols-2" aria-label="模型范围勾选">{options.map(option => <label key={option.key} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={draft.model_scope!.includes(option.key)} onChange={event => update({ ...draft, model_scope: event.target.checked ? [...draft.model_scope!, option.key] : draft.model_scope!.filter(key => key !== option.key) })} />
            <span>{option.label}{option.compatible_name && option.compatible_name !== option.label && <span className="text-xs text-slate-500">（调用名：{option.compatible_name}）</span>}</span>
          </label>)}</div>
          {!options.length && <p className="text-xs text-slate-500">暂无可选模型范围。</p>}
          {draft.model_scope.filter(key => !optionMap.has(key)).map(key => <div key={key} className="flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-300"><span>已失效模型范围（保留，请移除）</span><Button type="button" size="sm" variant="ghost" aria-label="移除失效模型范围" onClick={() => update({ ...draft, model_scope: draft.model_scope!.filter(item => item !== key) })}>移除范围</Button></div>)}
        </>}
      </div>
      {missingKeys.length > 0 && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">有 {missingKeys.length} 个模型范围已失效并保留，请明确移除后再保存。</p>}
    </fieldset>}
    {!inherit && validation && <p role="alert" className="text-xs text-rose-600">{validation}</p>}
    {saveError && <p role="alert" className="text-sm text-rose-600">保存失败：{saveError}</p>}
    {saved && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">策略已保存。</p>}
    {confirmAccount && <p role="alert" className="rounded-lg border border-amber-300 p-3 text-xs text-amber-800 dark:text-amber-200">更改账户默认将影响继承它的主 Token 和子 Token{value.following_token_count !== undefined ? `（当前 ${value.following_token_count} 个）` : ""}；已单独设置的 Token 不受影响。请确认影响后保存。</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" size="sm" disabled={locked || !changed || !!validation}>{busy ? "保存中…" : confirmAccount ? "确认更改账户默认" : "保存策略"}</Button>
      {confirmAccount && <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmAccount(false)}>返回修改</Button>}
    </div>
  </form>;
}
