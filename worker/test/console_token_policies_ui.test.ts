import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { TokenRoutingPolicy } from "../src/types";

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const componentPath = "../../web/src/components/ConsoleTokenPolicies.tsx";
const editorPath = "../../web/src/components/TokenPolicyEditor.tsx";
const clientPath = "../../web/src/api/consoleClient.ts";
const { ConsoleTokenPolicies, ConsoleRoutingPreviewResult, policyTargets, policyScopeOptions, routingPolicyPath,
  loadConsoleTokenPolicy, saveConsoleTokenPolicy, loadConsoleRoutingPreview } = await import(componentPath);
const { TokenPolicyEditor } = await import(editorPath);
const { setConsoleToken, setConsoleSession } = await import(clientPath);
type ConsoleRequestInit = RequestInit & { credentials?: "same-origin" | "include" | "omit" };
const policy: TokenRoutingPolicy = { mode: "multi", group_ids: ["g2", "g1"], selection: "ordered", failure_fallback: false, model_overrides: {}, model_scope: null };
function response(version = "account:2/master:3") {
  return { policy: null, effective_policy: policy, source: "account", version, following_token_count: 4,
    groups: [{ id: "g1", name: "蓝组" }, { id: "g2", name: "绿组" }],
    models: [{ scope_key: "public:identity-1", model_name: "compatible-name", display_name: "公开模型", group_ids: ["g2", "g1"] }] };
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
function storage() {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
  setConsoleToken("master-test-credential"); setConsoleSession("signed-session-test");
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("ConsoleTokenPolicies SSR and pure request helpers (not browser E2E)", () => {
  it("exposes account, master and live sub-tokens, never revoked tokens or eager SSR requests", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const tokens = [{ id: "live", name: "研发" }, { id: "unnamed" }, { id: "dead", name: "已撤销", revoked_at: 7 }];
    expect(policyTargets(tokens)).toEqual([{ id: "account", label: "账户默认" }, { id: "master", label: "主 Token" },
      { id: "live", label: "子 Token · 研发" }, { id: "unnamed", label: "子 Token · unnamed" }]);
    const html = renderToStaticMarkup(createElement(ConsoleTokenPolicies, { tokens }));
    expect(html).toContain('aria-label="策略编辑对象"'); expect(html).toContain('value="account" selected=""');
    expect(html).toContain('value="master"'); expect(html).toContain('value="live"'); expect(html).not.toContain('value="dead"');
    expect(html).toContain("不调用上游、不计费、不占生成 RPM"); expect(html).toContain("真实请求仍重查");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("maps stable scope keys, compatible names and group availability to the final editor contract", () => {
    const data = response();
    data.effective_policy = { ...policy, model_scope: ["public:identity-1"] };
    const options = policyScopeOptions(data.models);
    expect(options).toEqual([{ key: "public:identity-1", label: "公开模型", compatible_name: "compatible-name", group_ids: ["g2", "g1"] }]);
    expect(options[0].group_ids).not.toBe(data.models[0].group_ids);
    expect(policyScopeOptions([{ scope_key: "model:private", model_name: "raw-name", group_ids: [] }])[0].label).toBe("raw-name");
    const html = renderToStaticMarkup(createElement(TokenPolicyEditor, { target: "account", value: data, groups: data.groups,
      scopeOptions: options, onSave: vi.fn() }));
    expect(html).toContain("公开模型"); expect(html).toContain("调用名：compatible-name");
    expect(html).toContain("account:2/master:3"); expect(html).toContain("4"); expect(html).toContain("账户默认");
  });
  it("uses exact same-origin account paths with encoded sub-token IDs, not a guessed base prefix", () => {
    expect(routingPolicyPath("account")).toBe("/console/routing-policy");
    expect(routingPolicyPath("master")).toBe("/console/tokens/master/routing-policy");
    expect(routingPolicyPath("sub/a ?")).toBe("/console/tokens/sub%2Fa%20%3F/routing-policy");
  });
  it("uses existing authenticated consoleClient GET, PUT {policy}, then GET for the refreshed inheritance snapshot", async () => {
    storage();
    const fetcher = vi.fn().mockResolvedValueOnce(json(response("before"))).mockResolvedValueOnce(json({ ignored: true }))
      .mockResolvedValueOnce(json(response("after")));
    vi.stubGlobal("fetch", fetcher);
    expect((await loadConsoleTokenPolicy("master")).version).toBe("before");
    expect((await saveConsoleTokenPolicy("master", policy)).version).toBe("after");
    expect(fetcher.mock.calls.map((call: unknown[]) => [call[0], (call[1] as ConsoleRequestInit).method || "GET"]))
      .toEqual([[routingPolicyPath("master"), "GET"], [routingPolicyPath("master"), "PUT"], [routingPolicyPath("master"), "GET"]]);
    const init = fetcher.mock.calls[1][1] as ConsoleRequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ policy }); expect(init.credentials).toBe("same-origin");
    expect(init.headers).toMatchObject({ Authorization: "Bearer master-test-credential", "X-Console-Session": "signed-session-test", "Content-Type": "application/json" });
  });
  it("preserves whole-policy null and does not GET or pretend to save after PUT rejection", async () => {
    storage(); const fetcher = vi.fn().mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json(response()));
    vi.stubGlobal("fetch", fetcher); await saveConsoleTokenPolicy("child", null);
    expect(JSON.parse((fetcher.mock.calls[0][1] as ConsoleRequestInit).body as string)).toEqual({ policy: null });
    fetcher.mockReset().mockResolvedValueOnce(json({ error: "not allowed" }, 403));
    await expect(saveConsoleTokenPolicy("child", policy)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("posts the explicit readonly preview envelope through authenticated transport", async () => {
    storage(); const value = { available: false, error: "routing_unavailable" };
    const fetcher = vi.fn().mockResolvedValue(json(value)); vi.stubGlobal("fetch", fetcher);
    expect(await loadConsoleRoutingPreview("child", "old-name")).toEqual(value);
    expect(fetcher).toHaveBeenCalledTimes(1); const [path, init] = fetcher.mock.calls[0] as [string, ConsoleRequestInit];
    expect(path).toBe("/console/routing-preview"); expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ token_id: "child", model: "old-name" });
    expect(init.credentials).toBe("same-origin"); expect(init.headers).toMatchObject({ Authorization: "Bearer master-test-credential" });
  });
  it("renders user-selected groups and prices without internal identities or legacy candidate enumeration", () => {
    const price = { pricing_mode: "priced", billing_unit: "token", input_price_per_m: 1, output_price_per_m: 2,
      cache_read_price_per_m: 0.5, cache_write_price_per_m: 0.75, price_per_call: 0, search_price_per_call: 0.01, multiplier: 2 };
    const preview = { available: true, model: "old-name", public_name: "public-model", identity: "public:identity-1", source: "account", version: "v3",
      effective_policy: policy, legacy_fallback: false, explanation: "首选落组：绿组", notice: "不调用上游、不计费；真实请求重查",
      provider_api_key: "TOP_SECRET", endpoint: "https://secret.invalid", members: [{ provider_key: "SEALED" }],
      routes: [{ order: 1, service_group: { id: "g2", name: "绿组" }, public_name: "public-model", identity: "public:identity-1", price },
        { order: 2, service_group: { id: "g1", name: "蓝组" }, public_name: "public-model", identity: "public:identity-1", price }] };
    const html = renderToStaticMarkup(createElement(ConsoleRoutingPreviewResult, { preview }));
    expect(html.indexOf("1. 绿组")).toBeLessThan(html.indexOf("2. 蓝组"));
    for (const text of ["public-model", "输入 1", "输出 2", "缓存读取 0.5", "缓存写入 0.75", "搜索附加价", "0.01", "v3"]) expect(html).toContain(text);
    for (const secret of ["TOP_SECRET", "https://secret.invalid", "SEALED", "provider_api_key", "endpoint", "members", "稳定身份", "public:identity-1"]) expect(html).not.toContain(secret);
    const legacyHtml = renderToStaticMarkup(createElement(ConsoleRoutingPreviewResult, { preview: { ...preview, legacy_fallback: true,
      routes: [{ ...preview.routes[0], service_group: null, price: { ...price, billing_unit: "call", price_per_call: 0.25 } },
        { ...preview.routes[1], service_group: null, public_name: "HIDDEN_BACKEND_ALTERNATIVE", identity: "model:PRIVATE_BACKEND_ID" }] } }));
    expect(legacyHtml).toContain("旧版默认路由"); expect(legacyHtml).toContain("无服务报价"); expect(legacyHtml).toContain("USD 0.25/次");
    expect(legacyHtml.match(/<li /g)).toHaveLength(1);
    for (const text of ["HIDDEN_BACKEND_ALTERNATIVE", "PRIVATE_BACKEND_ID", "稳定身份"]) expect(legacyHtml).not.toContain(text);
  });
  it("shows unavailable failures clearly instead of a successful fallback", () => {
    const html = renderToStaticMarkup(createElement(ConsoleRoutingPreviewResult, { preview: { available: false, model: "broken", public_name: null,
      identity: null, source: "token", version: "v4", effective_policy: policy, routes: [], legacy_fallback: false, error: "routing_unavailable",
      explanation: "坏报价不可用，不回退", notice: "不调用上游、不计费" } }));
    expect(html).toContain("解析不可用"); expect(html).toContain("routing_unavailable"); expect(html).toContain("坏报价不可用，不回退");
    expect(html).not.toContain("无服务报价，使用已授权");
  });
});
