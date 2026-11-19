import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const apiPath = "../../web/src/api/monthlyPasses.ts";
const clientPath = "../../web/src/api/consoleClient.ts";
const { monthlyPassesApi, consoleMonthlyPassApi, monthlyLimitFromText, monthlyPassStatus, monthlyPassTime,
  requireWalletFallbackConfirmation, validateMonthlyPlanInput } = await import(apiPath);
const { ConsoleError, setConsoleSession, setConsoleToken, setConsoleUnauthorizedHandler } = await import(clientPath);
interface MonthlyPlanInput {
  name: string; enabled: 0 | 1;
  limits: { daily_usd: number | null; weekly_usd: number | null; five_hour_usd: number | null; total_usd: number | null };
  service_group_ids: string[] | null;
}
interface MonthlyPlan extends MonthlyPlanInput { id: string }
interface MonthlySubscription {
  id: string; device_id: string; plan_id: string; plan_name: string; enabled: 0 | 1;
  starts_at: number; expires_at: number; limits: MonthlyPlanInput["limits"]; service_group_ids: string[] | null;
  windows: Array<{ kind: string; limit_usd: number; used_usd: number; reserved_usd: number; remaining_usd: number; starts_at: number; ends_at: number }>;
}
interface MonthlyAccount { device_id: string; wallet_fallback: boolean; subscription: MonthlySubscription | null }

const fixture = vi.hoisted(() => ({ data: new Map<string, unknown>(), keys: [] as string[], error: null as Error | null, loading: false }));
vi.mock("../../web/src/hooks/useQuery", () => ({
  useQuery: (key: string) => {
    fixture.keys.push(key);
    return { data: fixture.data.get(key), error: fixture.error, loading: fixture.loading, isRefreshing: false, refresh: vi.fn(), mutate: vi.fn() };
  },
}));
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("../../web/src/components/Toast", () => ({ useToast: () => notifications }));
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
vi.doMock((requireWeb as any).resolve("react-router-dom"), () => ({ useLocation: () => ({ pathname: "/monthly-passes", search: "", hash: "" }), useNavigate: () => vi.fn() }));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const consolePath = "../../web/src/components/ConsoleMonthlyPass.tsx";
const adminPath = "../../web/src/pages/MonthlyPassesPage.tsx";
const { default: ConsoleMonthlyPass, MonthlyPassSummary, MonthlyPassWalletControl } = await import(consolePath);
const { default: MonthlyPassesPage, MonthlyPassPlanForm, AccountList } = await import(adminPath);
function render(component: unknown, props: object = {}) {
  const html = renderToStaticMarkup(createElement(component, props));
  return { html, text: html.replace(/<[^>]*>/g, "") };
}
function input(): MonthlyPlanInput {
  return { name: "文本月卡", enabled: 1, limits: { daily_usd: 10, weekly_usd: null, five_hour_usd: 2, total_usd: 100 }, service_group_ids: null };
}
function subscription(overrides: Partial<MonthlySubscription> = {}): MonthlySubscription {
  return { id: "sub-1", device_id: "device-1", plan_id: "plan-1", plan_name: "文本月卡", enabled: 1,
    starts_at: 1_700_000_000_000, expires_at: 4_000_000_000_000, limits: input().limits, service_group_ids: null,
    windows: [{ kind: "daily_usd", limit_usd: 10, used_usd: 11, reserved_usd: 0.5, remaining_usd: -1.5, starts_at: 1_700_000_000_000, ends_at: 1_700_086_400_000 }], ...overrides };
}
function account(overrides: Partial<MonthlyAccount> = {}): MonthlyAccount {
  return { device_id: "device-1", wallet_fallback: false, subscription: subscription(), ...overrides };
}
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("window", { location: { pathname: "/admin-prefix-example/monthly-passes" } });
  fixture.data.clear(); fixture.keys = []; fixture.error = null; fixture.loading = false;
  notifications.success.mockClear(); notifications.error.mockClear();
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ item: account(), items: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { setConsoleUnauthorizedHandler(null); vi.unstubAllGlobals(); });

describe("monthly-pass validation and status helpers (pure, not browser E2E)", () => {
  it("requires a name, complete limits, binary enabled and at least one positive limit", () => {
    expect(validateMonthlyPlanInput(input())).toEqual(input());
    expect(() => validateMonthlyPlanInput({ ...input(), name: " " })).toThrow("1–100");
    expect(() => validateMonthlyPlanInput({ ...input(), name: "a".repeat(101) })).toThrow("1–100");
    expect(() => validateMonthlyPlanInput({ ...input(), enabled: 2 as 1 })).toThrow("状态");
    expect(() => validateMonthlyPlanInput({ ...input(), limits: { daily_usd: null, weekly_usd: null, five_hour_usd: null, total_usd: null } })).toThrow("至少");
    expect(() => validateMonthlyPlanInput({ ...input(), limits: {} as MonthlyPlanInput["limits"] })).toThrow("金额");
  });
  it.each([0, -1, NaN, Infinity, -Infinity, 1e9 + 1])("rejects invalid amount %s without serializing it", value => {
    expect(() => validateMonthlyPlanInput({ ...input(), limits: { ...input().limits, daily_usd: value } })).toThrow("金额");
    expect(() => monthlyPassesApi.createPlan({ ...input(), limits: { ...input().limits, daily_usd: value } })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("accepts boundaries, blank null limits, and preserves null versus empty group scope", () => {
    expect(monthlyLimitFromText(" ")).toBeNull();
    expect(monthlyLimitFromText("1e9")).toBe(1e9);
    expect(monthlyLimitFromText("0.000001")).toBe(0.000001);
    expect(() => monthlyLimitFromText("Infinity")).toThrow();
    expect(() => monthlyLimitFromText("oops")).toThrow();
    expect(validateMonthlyPlanInput({ ...input(), name: "a".repeat(100), service_group_ids: [] }).service_group_ids).toEqual([]);
    expect(validateMonthlyPlanInput({ ...input(), service_group_ids: Array.from({ length: 100 }, (_, i) => "g" + i) }).service_group_ids).toHaveLength(100);
    expect(() => validateMonthlyPlanInput({ ...input(), service_group_ids: Array(101).fill("g") })).toThrow("100");
    expect(() => validateMonthlyPlanInput({ ...input(), service_group_ids: [""] })).toThrow();
  });
  it("distinguishes missing, disabled, expired, future, exhausted and valid subscriptions", () => {
    const now = 2_000_000_000_000;
    expect(monthlyPassStatus(null, now)).toBe("未开通");
    expect(monthlyPassStatus(subscription({ enabled: 0 }), now)).toBe("已停用");
    expect(monthlyPassStatus(subscription({ expires_at: now }), now)).toBe("已过期");
    expect(monthlyPassStatus(subscription({ starts_at: now + 1 }), now)).toBe("未生效");
    expect(monthlyPassStatus(subscription(), now)).toBe("额度不足");
    expect(monthlyPassStatus(subscription({ windows: [] }), now)).toBe("有效");
    expect(monthlyPassTime(Date.UTC(2026, 0, 1, 16))).toContain("2026/1/2 00:00:00");
  });
  it("guards fallback enabling before network IO and permits explicitly confirmed enable/disable", () => {
    expect(() => requireWalletFallbackConfirmation(true, false)).toThrow("显式确认");
    expect(() => consoleMonthlyPassApi.walletFallback(true)).toThrow("显式确认");
    expect(() => monthlyPassesApi.walletFallback("d", true)).toThrow("显式确认");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => requireWalletFallbackConfirmation(true, true)).not.toThrow();
    expect(() => requireWalletFallbackConfirmation(false, false)).not.toThrow();
  });
});

describe("monthly-pass API helpers (mock fetch, no live production requests)", () => {
  it("uses exact admin routes, full PUT data, list envelopes and encoded IDs without DELETE", async () => {
    const plan: MonthlyPlan = { ...input(), id: "p" };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ item: plan }), { status: 201 }));
    expect(await monthlyPassesApi.createPlan(input())).toEqual({ item: plan });
    await monthlyPassesApi.plans(); await monthlyPassesApi.updatePlan("p/a", { ...input(), enabled: 0, service_group_ids: [] });
    await monthlyPassesApi.accounts(); await monthlyPassesApi.account("d/a"); await monthlyPassesApi.issue("d/a", "p", "issue-op");
    await monthlyPassesApi.stop("s/a"); await monthlyPassesApi.renew("s/a", "renew-op"); await monthlyPassesApi.walletFallback("d/a", false);
    expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method ?? "GET"])).toEqual([
      ["/admin-prefix-example/api/monthly-passes/plans", "POST"], ["/admin-prefix-example/api/monthly-passes/plans", "GET"], ["/admin-prefix-example/api/monthly-passes/plans/p%2Fa", "PUT"],
      ["/admin-prefix-example/api/monthly-passes/accounts", "GET"], ["/admin-prefix-example/api/monthly-passes/accounts/d%2Fa", "GET"], ["/admin-prefix-example/api/monthly-passes/accounts/d%2Fa/issue", "POST"],
      ["/admin-prefix-example/api/monthly-passes/subscriptions/s%2Fa/stop", "POST"], ["/admin-prefix-example/api/monthly-passes/subscriptions/s%2Fa/renew", "POST"], ["/admin-prefix-example/api/monthly-passes/accounts/d%2Fa/wallet-fallback", "PUT"],
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ ...input(), enabled: 0, service_group_ids: [] });
    expect(JSON.parse(fetchMock.mock.calls[5][1].body)).toEqual({ plan_id: "p", operation_id: "issue-op" });
    expect(fetchMock.mock.calls[6][1].body).toBe("{}"); expect(JSON.parse(fetchMock.mock.calls[7][1].body)).toEqual({ operation_id: "renew-op" });
    expect(fetchMock.mock.calls[0][1].credentials).toBe("include");
  });
  it("uses the existing console bearer + session chain and same-origin credentials, not admin auth", async () => {
    setConsoleToken("device-token"); setConsoleSession("password-session");
    await consoleMonthlyPassApi.account(); await consoleMonthlyPassApi.walletFallback(true, true);
    expect(fetchMock.mock.calls[0][0]).toBe("/console/monthly-pass");
    expect(fetchMock.mock.calls[1][0]).toBe("/console/monthly-pass/wallet-fallback");
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.credentials).toBe("same-origin");
      expect(init.headers.Authorization).toBe("Bearer device-token");
      expect(init.headers["X-Console-Session"]).toBe("password-session");
    }
    expect(fetchMock.mock.calls[1][1].method).toBe("PUT");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ enabled: true });
  });
  it("preserves cookie-only console auth and rejects failed writes without success notifications", async () => {
    await consoleMonthlyPassApi.account();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[0][1].credentials).toBe("same-origin");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "save_failed", message: "保存未完成" }), { status: 500 }));
    await expect(consoleMonthlyPassApi.walletFallback(true, true)).rejects.toThrow("保存未完成");
    expect(notifications.success).not.toHaveBeenCalled();
  });
  it("sends confirmed admin fallback enabling and propagates admin mutation failure", async () => {
    await monthlyPassesApi.walletFallback("device-1", true, true);
    expect(fetchMock.mock.calls[0][0]).toBe("/admin-prefix-example/api/monthly-passes/accounts/device-1/wallet-fallback");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ enabled: true });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "monthly_pass_already_active" }), { status: 409 }));
    await expect(monthlyPassesApi.issue("device-1", "p1", "rejected-op")).rejects.toThrow("monthly_pass_already_active");
    expect(notifications.success).not.toHaveBeenCalled();
  });
  it("retains console unauthorized versus password-required behavior", async () => {
    const unauthorized = vi.fn(); setConsoleUnauthorizedHandler(unauthorized);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "password_required" }), { status: 401 }));
    await expect(consoleMonthlyPassApi.account()).rejects.toBeInstanceOf(ConsoleError);
    expect(unauthorized).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    await expect(consoleMonthlyPassApi.account()).rejects.toThrow("unauthorized");
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
});

describe("monthly-pass UI SSR (not browser interaction or E2E)", () => {
  it("shows negative remaining, reservations, limits, IDs, Beijing times and disabled-by-default fallback", () => {
    fixture.data.set("console:owner-a:monthly-pass", { item: account() });
    const { text } = render(ConsoleMonthlyPass, { scope: "owner-a" });
    for (const expected of ["文本月卡", "额度不足", "sub-1", "plan-1", "预占", "¥0.5", "¥-1.5", "已超额", "北京时间", "已关闭（默认）", "开启钱包兜底…", "30 天", "不自动付款", "不暗扣钱包", "不是滚动窗口", "不清空额度桶", "不会授予路由权限", "向量仍按原钱包计费"]) expect(text).toContain(expected);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifications.success).not.toHaveBeenCalled();
  });
  it("keys queries by scope and does not render another scope's cached account", () => {
    fixture.data.set("console:a:monthly-pass", { item: account() });
    expect(render(ConsoleMonthlyPass, { scope: "a" }).text).toContain("文本月卡");
    fixture.loading = true;
    const second = render(ConsoleMonthlyPass, { scope: "b" });
    expect(second.text).not.toContain("文本月卡"); expect(second.text).toContain("正在加载月卡");
    expect(fixture.keys).toEqual(["console:a:monthly-pass", "console:b:monthly-pass"]);
  });
  it("renders no-subscription, stopped and expired states and distinguishes empty group scope", () => {
    expect(render(MonthlyPassSummary, { account: account({ subscription: null }) }).text).toContain("未开通");
    expect(render(MonthlyPassSummary, { account: account({ subscription: subscription({ enabled: 0 }) }) }).text).toContain("已停用");
    expect(render(MonthlyPassSummary, { account: account({ subscription: subscription({ expires_at: 0, service_group_ids: [] }) }) }).text).toContain("可计费服务分组：无");
    expect(render(MonthlyPassSummary, { account: account({ subscription: subscription({ expires_at: 0 }) }) }).text).toContain("已过期");
  });
  it("displays load failures instead of saved-success claims and starts fallback enable as confirmation-only", () => {
    fixture.error = new Error("无法读取月卡");
    const { text } = render(ConsoleMonthlyPass, { scope: "broken" });
    expect(text).toContain("月卡加载失败：无法读取月卡"); expect(text).not.toContain("已更新");
    const wallet = render(MonthlyPassWalletControl, { enabled: false, onSave: vi.fn() });
    expect(wallet.text).toContain("默认关闭"); expect(wallet.text).toContain("开启钱包兜底…");
    expect(wallet.text).not.toContain("确认开启钱包兜底");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("renders admin CRUD form fields, disabled plans, retained missing groups and account list", () => {
    const plan = { ...input(), id: "p1", enabled: 0, service_group_ids: ["missing"] };
    const form = render(MonthlyPassPlanForm, { plan, groups: [{ id: "g1", name: "蓝组" }], onSaved: vi.fn() });
    for (const label of ["套餐名称", "每日限额（¥，与网关计费币种一致）", "每周限额（¥，与网关计费币种一致）", "5 小时限额（¥，与网关计费币种一致）", "总额限额（¥，与网关计费币种一致）", "保存完整套餐", "不提供删除", "已失效，保留原值", "此处不授予账户路由权限"]) expect(form.text).toContain(label);
    expect(form.html).toContain('value="文本月卡"');
    expect(form.html).toMatch(/type="checkbox" checked=""/);
    const list = render(AccountList, { accounts: [account()], devices: [{ id: "device-1", name: "研发账户" }], onSelect: vi.fn() });
    expect(list.text).toContain("研发账户"); expect(list.text).toContain("额度不足");
    fixture.data.set("admin:monthly-passes", { plans: [plan], accounts: [account()], devices: [{ id: "device-1", name: "研发账户" }], groups: [] });
    const admin = render(MonthlyPassesPage);
    expect(admin.text).toContain("月卡管理"); expect(admin.text).toContain("编辑 / 停用"); expect(admin.text).toContain("选择账户 / 设备");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
