import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
vi.doMock((requireWeb as any).resolve("react-router-dom"), () => ({ Link: ({ children, to }: any) => requireWeb("react").createElement("a", { href: to }, children) }));
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const drawerPath = "../../web/src/components/AccountDetailDrawer";
const attentionPath = "../../web/src/components/AttentionPanel";
const { AccountAccessView, priceText, routingText } = await import(drawerPath);
const { AttentionList } = await import(attentionPath);

const device = { id: "acct", name: "张三", enabled: 1, rate_limit_rpm: 0, routing_policy_mode: "fixed", selected_service_group_name: "标准", last_used_at: null, created_at: 1, revoked_at: null };
const report = {
  device_id: "acct", checked_at: 1, truncated: false, month_cost_usd: 3, cost_limit_monthly: 10,
  wallet: { balance_usd: 0, reserved_usd: 0, available_usd: 0 },
  monthly_pass: null,
  issues: [{ key: "no_balance", level: "block", text: "钱包余额不足", fix: "点「充值」。" }],
  models: [
    { name: "cheap-chat", display_name: "Cheap", available: true, reason: null, service_group: "标准", price: { pricing_mode: "priced", billing_unit: "token", input_price_per_m: 1, output_price_per_m: 2, price_per_call: 0, multiplier: 1.5 } },
    { name: "locked", display_name: null, available: false, reason: "没有权限：不在账户的模型范围或服务分组授权里", service_group: null, price: null },
  ],
};

describe("admin account detail and attention UI (SSR)", () => {
  it("shows blockers, per-model availability, route and price in plain words", () => {
    const html = renderToStaticMarkup(React.createElement(AccountAccessView, { device, report, onlyBlocked: false, onToggleOnlyBlocked: () => {} }));
    for (const text of ["钱包余额不足", "点「充值」。", "固定分组：标准", "1 / 2", "cheap-chat", "可以", "不能", "没有权限", "¥1 / ¥2 每百万 Token（含 ×1.5）"]) expect(html).toContain(text);
    expect(html).toContain('role="alert"');
    const blockedOnly = renderToStaticMarkup(React.createElement(AccountAccessView, { device, report, onlyBlocked: true, onToggleOnlyBlocked: () => {} }));
    expect(blockedOnly).not.toContain("cheap-chat");
    expect(blockedOnly).toContain("locked");
  });

  it("formats prices and routing modes", () => {
    expect(priceText(null)).toBe("—");
    expect(priceText({ pricing_mode: "free", billing_unit: "token", input_price_per_m: 0, output_price_per_m: 0, price_per_call: 0, multiplier: 1 })).toBe("免费");
    expect(priceText({ pricing_mode: "priced", billing_unit: "call", input_price_per_m: 0, output_price_per_m: 0, price_per_call: 0.2, multiplier: 1 })).toBe("¥0.2 / 次");
    expect(priceText({ pricing_mode: "priced", billing_unit: "token", input_price_per_m: 0.14, output_price_per_m: 0, price_per_call: 0, multiplier: 1 })).toBe("¥0.14 每百万输入 Token");
    expect(routingText({ routing_policy_mode: "legacy" })).toContain("默认路由");
    expect(routingText({ routing_policy_mode: "multi", routing_group_ids: ["a", "b"] })).toBe("按模型使用 2 个分组");
  });

  it("links each attention item to the page that fixes it", () => {
    expect(renderToStaticMarkup(React.createElement(AttentionList, { items: [] }))).toContain("没有需要处理的事项");
    const html = renderToStaticMarkup(React.createElement(AttentionList, { items: [{ key: "models_unpriced", level: "block", count: 2, text: "2 个已启用的模型没有定价，调用会失败", link: "/models?list_pricing=unset" }] }));
    expect(html).toContain('href="/models?list_pricing=unset"');
    expect(html).toContain("2 个已启用的模型没有定价");
  });
});
