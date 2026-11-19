import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { parseTokenRoutingPolicy } from "../src/db/token_policies";
import type { TokenRoutingPolicy } from "../src/types";
type TokenPolicyEditorProps = {target?:string;label?:string;value?:{policy:TokenRoutingPolicy|null;effective_policy:TokenRoutingPolicy;source:string;version:string|number;following_token_count?:number}|null;groups?:Array<{id:string;name:string;enabled?:number|boolean;available?:boolean}>;scopeOptions?:Array<{key:string;label:string;compatible_name?:string;group_ids?:string[]}>;onSave?:(policy:TokenRoutingPolicy|null)=>Promise<unknown>;disabled?:boolean;loading?:boolean;error?:string};

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const componentPath = "../../web/src/components/TokenPolicyEditor.tsx";
const { TokenPolicyEditor, newTokenRoutingPolicy, movePolicyGroup, tokenPolicyDraftError, uniquePolicyScopeOptions } = await import(componentPath);

function policy(overrides: Partial<TokenRoutingPolicy> = {}): TokenRoutingPolicy {
  return { mode: "multi", group_ids: ["g2", "g1"], selection: "ordered", failure_fallback: false,
    model_overrides: {}, model_scope: null, ...overrides };
}
const groups = [{ id: "g1", name: "蓝组" }, { id: "g2", name: "绿组" }, { id: "g-new", name: "新增授权组" }];
const scopeOptions = [
  { key: "public:identity-1", label: "共享模型", compatible_name: "shared-model" },
  { key: "model:private-1", label: "独立模型" },
  { key: "group:models-1", label: "模型集合" },
];
function render(p: TokenRoutingPolicy | null = policy(), extra: Partial<TokenPolicyEditorProps> = {}) {
  const onSave = vi.fn(async () => {});
  const html = renderToStaticMarkup(createElement(TokenPolicyEditor, {
    target: "master", value: { policy: p, effective_policy: p ?? policy(), source: p ? "token" : "account", version: "account:2/master:3" },
    groups, scopeOptions, onSave, ...extra,
  }));
  return { html, text: html.replace(/<[^>]*>/g, ""), onSave };
}
function select(html: string, label: string) {
  return html.match(new RegExp('<select[^>]*aria-label="' + label + '"[\\s\\S]*?</select>'))?.[0] ?? "";
}
function scopeCheckboxes(html: string) {
  return html.match(/<div[^>]*aria-label="模型范围勾选"[\s\S]*?<\/div>/)?.[0] ?? "";
}

describe("TokenPolicyEditor SSR safety and clarity (not browser E2E)", () => {
  it("shows effective policy, source/version and all four routing modes", () => {
    const { html, text, onSave } = render();
    expect(text).toContain("主 Token 路由策略");
    expect(text).toContain("当前生效：多组选组 · 绿组 → 蓝组");
    expect(text).toContain("来源：此 Token 独立策略 · 版本：account:2/master:3");
    for (const mode of ["auto", "legacy", "fixed", "multi"]) expect(select(html, "路由模式")).toContain('value="' + mode + '"');
    expect(onSave).not.toHaveBeenCalled();
  });

  it("distinguishes whole-policy null inheritance from independent override", () => {
    const { html, text } = render(null);
    expect(select(html, "策略来源")).toContain('<option value="inherit" selected="">');
    expect(text).toContain("保存后将跟随账户默认设置。");
    expect(text).toContain("单独设置");
    expect(html).not.toContain("<fieldset");
    expect(select(html, "路由模式")).toBe("");
    expect(text).toContain("来源：账户默认");
  });

  it("uses distinct account/master/sub-token labels and account-null wording", () => {
    const account = render(null, { target: "account" });
    expect(account.text).toContain("账户默认路由策略");
    expect(account.html).not.toContain("<fieldset");
    expect(select(account.html, "策略来源")).toContain("自定义账户默认");
    expect(render(policy(), { target: "account" }).html).toContain("<fieldset");
    expect(account.text).toContain("保存后将恢复系统默认设置。");
    expect(render(policy(), { target: "child-1", label: "研发子令牌" }).text).toContain("研发子令牌");
    expect(render(policy(), { target: "child-1" }).text).toContain("子 Token 路由策略");
  });

  it("keeps candidate order and supplies accessible up/down controls", () => {
    const { html, text } = render();
    const ordered = html.slice(html.indexOf('aria-label="已选分组顺序"'));
    expect(ordered.indexOf("1. 绿组")).toBeLessThan(ordered.indexOf("2. 蓝组"));
    expect(ordered.match(/<button[^>]*aria-label="上移 绿组"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(ordered.match(/<button[^>]*aria-label="下移 蓝组"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(text).toContain("新增授权不会自动扩张此固定集合");
    const newGroupCheckbox = html.match(/<input[^>]*type="checkbox"[^>]*[/]>新增授权组/)?.[0];
    expect(newGroupCheckbox).toBeDefined();
    expect(newGroupCheckbox).not.toContain('checked=""');
  });

  it("supports input-price choice and disables manual reordering in that mode", () => {
    const { html } = render(policy({ selection: "input_price" }));
    expect(select(html, "候选选择顺序")).toContain('<option value="input_price" selected="">');
    for (const direction of ["上移", "下移"]) for (const group of ["蓝组", "绿组"]) {
      expect(html.match(new RegExp('<button[^>]*aria-label="' + direction + ' ' + group + '"[^>]*>'))?.[0]).toContain('disabled=""');
    }
  });

  it("rejects an existing model exception unavailable in its selected group without deleting it", () => {
    const { html, text } = render(policy({ model_overrides: { "public:identity-1": "g2" } }), {
      scopeOptions: [{ key: "public:identity-1", label: "共享模型", group_ids: ["g1"] }],
    });
    expect(text).toContain("模型例外在所选分组中不可用");
    expect(text).toContain("共享模型"); expect(text).not.toContain("public:identity-1");
    expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it("defaults failure fallback off and makes the price/retry risk prominent", () => {
    const { html, text } = render();
    const fallback = html.match(/<input[^>]*type="checkbox"[^>]*[/]>允许失败后切换分组/)?.[0];
    expect(fallback).toBeDefined();
    expect(fallback).not.toContain('checked=""');
    expect(text).toContain("风险提示：默认关闭");
    expect(text).toContain("价格可能改变");
    expect(text).toContain("费用按成功使用的分组计算");
    expect(text).toContain("视频任务不自动跨组重发");
    expect(render(policy({ failure_fallback: true })).html).toMatch(/<input[^>]*checked=""[^>]*[/]>允许失败后切换分组/);
  });

  it("does not copy historical compatibility fallback into a new independent draft", () => {
    const { html, text } = render(null, { value: { policy: null, effective_policy: policy({ failure_fallback: true }), source: "compatibility", version: "old" } });
    expect(text).toContain("当前失败切组：已开启");
    expect(text).toContain("兼容旧配置");
    expect(text).toContain("请保存继承，明确清除旧选择");
    expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).not.toContain('disabled=""');
    expect(html).not.toContain("<fieldset");
  });

  it("keeps missing/disabled selected groups instead of silently dropping them", () => {
    const p = policy({ group_ids: ["missing-group", "g1"], model_overrides: { "public:identity-1": "missing-group" } });
    const { html, text } = render(p, { groups: [{ id: "g1", name: "蓝组", enabled: false }] });
    expect(text).toContain("1. missing-group（失效或无权限，已保留）");
    expect(text).toContain("2. 蓝组（失效或无权限，已保留）");
    expect(text).toContain("失效或不可用分组已保留：missing-group、g1");
    expect(html).toContain('aria-label="移除分组 missing-group"');
    expect(p.group_ids).toEqual(["missing-group", "g1"]);
    expect(p.model_overrides).toEqual({ "public:identity-1": "missing-group" });
  });

  it("uses stable model override keys and only selected group choices", () => {
    const { html, text } = render(policy({ group_ids: ["g2"], model_overrides: { "public:identity-1": "g2" } }));
    expect(text).toContain("共享模型 → 绿组"); expect(text).not.toContain("public:identity-1");
    expect(select(html, "例外模型")).toContain('value="public:identity-1"');
    expect(select(html, "例外模型")).not.toContain('value="shared-model"');
    expect(select(html, "例外固定分组")).toContain('value="g2"');
    expect(select(html, "例外固定分组")).not.toContain('value="g1"');
    expect(text).toContain("不会增加模型权限");
  });

  it("preserves and explains an override outside selected groups instead of silently repairing it", () => {
    const { text, html } = render(policy({ model_overrides: { "public:identity-1": "g-new" } }));
    expect(text).toContain("新增授权组（不在已选分组中）");
    expect(text).toContain("模型例外必须指向已选分组");
    expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it("distinguishes inherited null scope from explicit no-access []", () => {
    const inherited = render(policy({ model_scope: null }));
    const none = render(policy({ model_scope: [] }));
    expect(select(inherited.html, "模型范围来源")).toContain('<option value="inherit" selected="">');
    expect(scopeCheckboxes(inherited.html)).toBe("");
    expect(select(none.html, "模型范围来源")).toContain('<option value="fixed" selected="">');
    expect(none.text).toContain("尚未勾选模型：保存后将无法调用任何模型，不会自动使用账户默认范围。");
    expect(none.text).toContain("单独设置后，不再跟随账户默认设置。");
    expect(none.text).not.toContain("取交集");
    expect(scopeCheckboxes(none.html).match(/type="checkbox"/g)).toHaveLength(3);
    expect(scopeCheckboxes(none.html)).not.toContain('checked=""');
  });

  it("deduplicates repeated public identities without merging unrelated same-name IDs", () => {
    const { html } = render(policy({ model_scope: ["public:identity-1"] }), { scopeOptions: [scopeOptions[0], scopeOptions[0], { key: "model:other", label: "共享模型" }] });
    const choices = scopeCheckboxes(html);
    expect(choices.match(/type="checkbox"/g)).toHaveLength(2);
    expect(choices.match(/调用名：shared-model/g)).toHaveLength(1);
    expect(choices.match(/checked=""/g)).toHaveLength(1);
    expect(choices).toContain("共享模型"); expect(choices).not.toContain("model:other");
  });

  it("retains missing scope keys and provides an explicit removal control", () => {
    const p = policy({ model_scope: ["model:gone", "group:models-1"] });
    const { html, text } = render(p);
    expect(text).toContain("已失效模型范围（保留，请移除）"); expect(text).not.toContain("model:gone");
    expect(html).toContain('aria-label="移除失效模型范围"');
    expect(p.model_scope).toEqual(["model:gone", "group:models-1"]);
  });

  it("shows loading/error/empty state and locks stale or externally disabled data", () => {
    expect(render(null, { value: null, loading: true }).html).not.toContain("<form");
    expect(render(null, { value: null, loading: true }).text).toContain("正在加载路由策略");
    const failed = render(null, { value: null, error: "需要密码会话" });
    expect(failed.text).toContain("需要密码会话");
    expect(failed.html).not.toContain("<form");
    expect(render(null, { value: null }).text).toContain("暂无策略数据");
    expect(render(policy(), { error: "刷新失败" }).html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(render(policy(), { disabled: true }).html).toMatch(/<fieldset[^>]*disabled=""/);
  });

  it("escapes user-facing names and never writes during render", () => {
    const { html, onSave } = render(policy(), { label: '<script>alert("x")</script>', groups: [{ id: "g1", name: "<unsafe>" }] });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;unsafe&gt;");
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("policy editor pure operations against actual backend parser", () => {
  it("creates fresh complete policies with fallback disabled and scope null", () => {
    const first = newTokenRoutingPolicy();
    expect(first).toEqual({ mode: "auto", group_ids: [], selection: "ordered", failure_fallback: false, model_overrides: {}, model_scope: null });
    expect(parseTokenRoutingPolicy(first)).toEqual(first);
    first.group_ids.push("mutated");
    expect(newTokenRoutingPolicy().group_ids).toEqual([]);
  });

  it("moves groups immutably without altering overrides or fixed scopes", () => {
    const before = policy({ model_overrides: { "public:identity-1": "g1" }, model_scope: ["model:private-1"] });
    const after = movePolicyGroup(before, 0, 1);
    expect(after.group_ids).toEqual(["g1", "g2"]);
    expect(before.group_ids).toEqual(["g2", "g1"]);
    expect(after.model_overrides).toEqual(before.model_overrides);
    expect(after.model_scope).toEqual(before.model_scope);
    expect(after.model_scope).not.toBe(before.model_scope);
    expect(parseTokenRoutingPolicy(after)).toEqual(after);
    expect(movePolicyGroup(before, 0, -1)).toEqual(before);
    expect(movePolicyGroup(before, 99, -1)).toEqual(before);
  });

  it("matches actual backend mode cardinality and override constraints", () => {
    for (const invalid of [policy({ mode: "fixed" }), policy({ mode: "multi", group_ids: [] }), policy({ mode: "auto" }), policy({ mode: "legacy" }), policy({ model_overrides: { "public:identity-1": "g-new" } })]) {
      expect(tokenPolicyDraftError(invalid)).toBeTruthy();
      expect(() => parseTokenRoutingPolicy(invalid)).toThrow();
    }
    for (const valid of [policy(), policy({ mode: "fixed", group_ids: ["g1"] }), newTokenRoutingPolicy(), policy({ mode: "legacy", group_ids: [] }), policy({ model_scope: [] }), policy({ model_overrides: { "group:models-1": "g1" } })]) {
      expect(tokenPolicyDraftError(valid)).toBeNull();
      expect(parseTokenRoutingPolicy(valid)).toEqual(valid);
    }
    expect(parseTokenRoutingPolicy(null)).toBeNull();
  });

  it("deduplicates stable keys only, independent of names and authorization changes", () => {
    const before = policy({ model_scope: ["public:identity-1"] });
    const options = uniquePolicyScopeOptions([...scopeOptions, scopeOptions[0], { key: "public:new-id", label: "共享模型" }]);
    expect(options.map((item: { key: string }) => item.key)).toEqual(["public:identity-1", "model:private-1", "group:models-1", "public:new-id"]);
    expect(before.model_scope).toEqual(["public:identity-1"]);
  });
});
