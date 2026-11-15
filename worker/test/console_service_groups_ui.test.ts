import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const fixture = vi.hoisted(() => ({
  state: { items: [{ id: "g1", name: "蓝组", description: null, multiplier: 1 }], default_service_group_id: "g1", service_group_id: null, sub_tokens: [{ id: "sub-inherit", service_group_id: null }, { id: "sub-legacy", service_group_id: "legacy" }] },
}));
vi.mock("../../web/src/hooks/useQuery", () => ({
  useQuery: (key: string | null) => ({ data: key?.includes(":service-groups") ? fixture.state : undefined, loading: false, isRefreshing: false, error: null, refresh: vi.fn(), mutate: vi.fn() }),
}));
vi.mock("../../web/src/api/consoleClient", () => ({ consoleAccountApi: { serviceGroups: vi.fn(), previewServiceGroup: vi.fn(), setServiceGroups: vi.fn(), setTokenServiceGroup: vi.fn() } }));
vi.mock("../../web/src/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const componentPath = "../../web/src/components/ConsoleServiceGroups.tsx";
const { ConsoleServiceGroups } = await import(componentPath);
function render() {
  const html = renderToStaticMarkup(React.createElement(ConsoleServiceGroups, {
    scope: "test", onTokensChange: async () => {}, tokens: [
      { id: "sub-inherit", name: "继承子令牌", enabled: true, revoked: false, service_group_id: null, last_used_at: null, created_at: 0 },
      { id: "sub-legacy", name: "旧版子令牌", enabled: true, revoked: false, service_group_id: "legacy", last_used_at: null, created_at: 0 },
    ],
  }));
  return html.replace(/<[^>]*>/g, "");
}
describe("console service-group clarity (SSR)", () => {
  it("distinguishes effective choices from inheritance and legacy routing", () => {
    const text = render();
    expect(text).toContain("账户默认 · 当前生效蓝组");
    expect(text).toContain("主 Token · 当前生效蓝组继承账户默认");
    expect(text).toContain("子 Token · 继承子令牌 · 当前生效蓝组继承账户默认");
    expect(text).toContain("子 Token · 旧版子令牌 · 当前生效旧版默认路由使用此子 Token 的独立选择");
    expect(text).toContain("更改账户默认");
    expect(text).toContain("只读");
    expect(text).toContain("失败时可能改用下一候选");
    expect(text).toContain("费用按成功使用的分组计算");
  });
});
