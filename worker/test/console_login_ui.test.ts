import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const fixture = vi.hoisted(() => ({
  session: { authenticated: true, password_setup_required: false },
  quota: { available_usd: 12.5, reserved_usd: 1, monthly_cost_usd: 0, monthly_cost_limit_usd: 0 },
}));
vi.mock("../../web/src/hooks/useQuery", () => ({
  useQuery: (key: string | null) => ({
    data: key?.endsWith(":session") ? fixture.session : key?.endsWith(":quota") ? fixture.quota : undefined,
    loading: false, isRefreshing: false, error: null, refresh: vi.fn(), mutate: vi.fn(),
  }),
  invalidateCache: vi.fn(),
}));

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const authShellPath = "../../web/src/components/ConsoleAuthShell.tsx";
const accountPath = "../../web/src/components/ConsoleAccount.tsx";
const consolePagePath = "../../web/src/pages/ConsolePage.tsx";
const toastPath = "../../web/src/components/Toast.tsx";
const { ConsoleAuthShell, ConsoleContact } = await import(authShellPath);
const { PasswordScreen } = await import(accountPath);
const { default: ConsolePage, TokenGate } = await import(consolePagePath);
const { ToastProvider } = await import(toastPath);

afterEach(() => vi.unstubAllGlobals());

function render(element: unknown) {
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

function text(html: string) {
  return html.replace(/<[^>]*>/g, "");
}

describe("console login and balance contact UI (SSR)", () => {
  it("shows generic operator guidance without mail links", () => {
    const html = render(React.createElement(ConsoleContact));
    expect(text(html)).toContain("若无账号，可联系负责人获取。");
    expect(text(html)).toContain("请通过部署方提供的联系渠道联系管理员。");
    expect(html).not.toContain("mailto:");
    expect(text(html)).toContain("请勿通过公开渠道发送 Token 或密码。");
    expect(html).not.toContain("subject=");
    expect(html).not.toContain("body=");
  });

  it("shows the balance recharge contact beneath the balance value", () => {
    const html = render(React.createElement(ConsoleContact, { balance: true }));
    expect(text(html)).toContain("联系负责人添加余额");
    expect(text(html)).toContain("请通过部署方提供的联系渠道联系管理员。");
    expect(text(html)).not.toContain("Token");
    expect(html).not.toContain("mailto:");
  });

  it("renders the two-step shell with the active step and accessible labels", () => {
    const html = render(React.createElement(ConsoleAuthShell, {
      step: 2,
      title: "输入控制台密码",
      description: "完成密码验证",
      children: React.createElement("div", null, "form"),
    }));
    expect(text(html)).toContain("验证 Token");
    expect(text(html)).toContain("控制台密码");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('aria-label="输入控制台密码"');
  });

  it("keeps login compatible with existing long passwords while limiting setup", () => {
    const login = render(React.createElement(PasswordScreen, { mode: "login", onDone: () => {}, onChangeToken: () => {} }));
    expect(login).toMatch(/autocomplete="current-password"/i);
    expect(login).not.toMatch(/maxlength="20"/i);
    expect(text(login)).toContain("请输入该设备 Token 对应的控制台密码。");

    const setup = render(React.createElement(PasswordScreen, { mode: "setup", onDone: () => {}, onChangeToken: () => {} }));
    expect(setup).toMatch(/autocomplete="new-password"/i);
    expect(setup.match(/maxlength="20"/gi)).toHaveLength(2);
    expect(text(setup)).toContain("确认密码");
  });

  it("renders an enabled token gate for password-manager autofill", () => {
    const html = render(React.createElement(TokenGate, { onSaved: () => {} }));
    expect(text(html)).toContain("若无账号，可联系负责人获取。");
    expect(text(html)).toContain("Token 将发送至当前网关进行身份验证");
    expect(html).toContain('name="token"');
    expect(html).toContain('type="password"');
    expect(text(html)).toContain("继续验证");
    const submitButton = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0];
    expect(submitButton).toBeDefined();
    expect(submitButton!.replace(/"[^"]*"/g, '""')).not.toMatch(/\sdisabled(?:\s|=|>)/);
  });

  it("places the contact inside the actual available balance card", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => key === "cpg.console.token" ? "test-token" : null,
      setItem: () => {}, removeItem: () => {},
    });
    const html = render(React.createElement(ToastProvider, null, React.createElement(ConsolePage)));
    const balanceCard = html.match(/<div class="px-4 py-3\.5 rounded-xl[^>]*>.*?可用余额.*?<\/div><\/div>/s)?.[0];
    expect(balanceCard).toBeDefined();
    expect(text(balanceCard!)).toContain("可用余额");
    expect(text(balanceCard!)).toContain("12.50");
    expect(text(balanceCard!)).toContain("预占中");
    expect(text(balanceCard!)).toContain("联系负责人添加余额");
    expect(text(balanceCard!)).toContain("请通过部署方提供的联系渠道联系管理员。");
    expect(balanceCard).not.toContain("mailto:");
  });
});
