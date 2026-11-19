import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const fixture = vi.hoisted(() => ({ location: { pathname: "/admin/monthly-passes", search: "", hash: "#accounts" }, navigate: vi.fn(), get: vi.fn() }));
vi.mock("../../web/src/api/client", () => ({ api: { get: fixture.get }, ApiError: class extends Error {} }));
vi.mock("../../web/src/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
vi.doMock((requireWeb as any).resolve("react-router-dom"), () => ({ useLocation: () => fixture.location, useNavigate: () => fixture.navigate }));
const React = requireWeb("react");
const pagePath = "../../web/src/pages/MonthlyPassesPage";
const queryPath = "../../web/src/hooks/useQuery";
const { default: Page, filterMonthlyPlans, filterMonthlyAccounts, monthlyFilterDefaults, MonthlyPassPlanForm, AccountEditor, AccountList } = await import(pagePath);
const { invalidateCache, setCacheData, getCacheData } = await import(queryPath);
const toolbarPath = "../../web/src/components/AdminListToolbar";
const { AdminListToolbar } = await import(toolbarPath);
const now = 2_000_000_000_000, day = 86_400_000;
const limits = { daily_usd: 10, weekly_usd: null, five_hour_usd: null, total_usd: null };
const plans = [{ id: "p-z", name: "Zulu", enabled: 1, limits, service_group_ids: null }, { id: "p-a", name: "Alpha", enabled: 0, limits, service_group_ids: [] }];
function account(id: string, extra: any = {}) { return { device_id: id, wallet_fallback: false, subscription: { id: "s-" + id, device_id: id, plan_id: "p-z", plan_name: "Zulu snapshot", enabled: 1, starts_at: now - day, expires_at: now + day, windows: [], limits, service_group_ids: null, ...extra } }; }
const devices = [{ id: "z", name: "研发账户" }, { id: "a", name: "Alpha account" }];
const data = () => ({ plans, accounts: [account("z"), account("a", { enabled: 0, expires_at: now + 30 * day }), { device_id: "none", wallet_fallback: false, subscription: null }], devices, groups: [] });
const filters = (extra = {}) => ({ ...monthlyFilterDefaults, ...extra });
const nodes = (x: any): any[] => Array.isArray(x) ? x.flatMap(nodes) : x && typeof x === "object" ? [x, ...nodes(x.props?.children)] : [];
function harness(component: () => any, effectsEnabled = false) {
  const slots: any[] = []; let cursor = 0; let effects: Function[] = [];
  const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const dispatcher = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (v: any) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn: Function, deps: any[]) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useCallback(fn: Function, deps: any[]) { return this.useMemo(() => fn, deps); },
    useEffect(fn: Function, deps: any[]) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { const prev = slots[i]; slots[i] = { deps, cleanup: prev?.cleanup }; if (effectsEnabled) effects.push(() => { prev?.cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  return { render() { cursor = 0; effects = []; const d = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher; const prev = d.current; d.current = dispatcher; let result; try { result = component(); } finally { d.current = prev; } effects.forEach(fn => fn()); return result; }, unmount() { slots.forEach(s => s?.cleanup?.()); } };
}
function deferred() { let resolve!: (v: any) => void; let reject!: (e: Error) => void; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const find = (tree: any, type: any) => nodes(tree).filter(n => n.type === type);
beforeEach(() => { vi.clearAllMocks(); invalidateCache(); vi.spyOn(Date, "now").mockReturnValue(now); fixture.location = { pathname: "/admin/monthly-passes", search: "?tab=keep", hash: "#accounts" }; fixture.navigate.mockImplementation((next: any) => { fixture.location = next; }); setCacheData("admin:monthly-passes", data()); fixture.get.mockImplementation(async (path: string) => ({ items: path.endsWith("/plans") ? plans : path.endsWith("/accounts") ? data().accounts : path.endsWith("/devices") ? devices : [] })); });
afterEach(() => { invalidateCache(); vi.restoreAllMocks(); });

describe("monthly full-list projections", () => {
  it("combines plan name/ID and enabled filters, sorts copies, and preserves original order", () => {
    expect(filterMonthlyPlans(plans, filters({ q: " P-Z ", enabled: "1" })).map((x: any) => x.id)).toEqual(["p-z"]);
    expect(filterMonthlyPlans(plans, filters({ sort: "name" })).map((x: any) => x.id)).toEqual(["p-a", "p-z"]);
    expect(filterMonthlyPlans(plans, filters({ sort: "name-desc" })).map((x: any) => x.id)).toEqual(["p-z", "p-a"]);
    expect(plans.map(x => x.id)).toEqual(["p-z", "p-a"]);
  });
  it("combines account name/ID/snapshot plan, status, plan and expiry filters", () => {
    const list = data().accounts;
    expect(filterMonthlyAccounts(list, devices, filters({ account_q: "研发", plan: "p-z", status: "有效", account_enabled: "1", expiry: "7d" }), now).map((x: any) => x.device_id)).toEqual(["z"]);
    expect(filterMonthlyAccounts(list, devices, filters({ account_q: "SNAPSHOT", status: "已停用", expiry: "30d" }), now).map((x: any) => x.device_id)).toEqual(["a"]);
    expect(filterMonthlyAccounts(list, devices, filters({ status: "未开通", expiry: "none" }), now).map((x: any) => x.device_id)).toEqual(["none"]);
    expect(filterMonthlyAccounts(list, devices, filters({ account_q: "none" }), now)).toHaveLength(1);
  });
  it("uses inclusive expiry boundaries and distinguishes expired/future/exhausted/disabled", () => {
    const list = [account("expired", { expires_at: now }), account("7", { expires_at: now + 7 * day }), account("late", { expires_at: now + 7 * day + 1 }), account("future", { starts_at: now + 1 }), account("empty", { windows: [{ remaining_usd: 0 }] })];
    expect(filterMonthlyAccounts(list, [], filters({ expiry: "expired" }), now).map((x: any) => x.device_id)).toEqual(["expired"]);
    expect(filterMonthlyAccounts(list, [], filters({ expiry: "7d" }), now).map((x: any) => x.device_id)).toEqual(["7", "future", "empty"]);
    for (const [status, id] of [["未生效", "future"], ["额度不足", "empty"]]) expect(filterMonthlyAccounts(list, [], filters({ status }), now).map((x: any) => x.device_id)).toEqual([id]);
  });
  it("sorts names and expiry with missing subscriptions last and stable ID ties", () => {
    expect(filterMonthlyAccounts(data().accounts, [{ id: "z", name: "Zulu account" }, devices[1]], filters({ account_sort: "name" }), now).map((x: any) => x.device_id)).toEqual(["a", "none", "z"]);
    expect(filterMonthlyAccounts(data().accounts, devices, filters({ expiry_sort: "desc" }), now).map((x: any) => x.device_id)).toEqual(["a", "z", "none"]);
    expect(filterMonthlyAccounts(data().accounts, devices, filters({ expiry_sort: "asc" }), now).map((x: any) => x.device_id)).toEqual(["z", "a", "none"]);
  });
});

describe("monthly page real hooks and event handlers (no browser E2E claims)", () => {
  it("restores URL state, shows truthful counts and no-match, and resets both lists preserving unrelated URL", () => {
    fixture.location.search = "?tab=keep&list_q=absent&list_account_q=研发&list_plan=p-z&list_status=有效&list_expiry=7d";
    const h = harness(Page); let tree = h.render(); let bars = find(tree, AdminListToolbar);
    expect(bars.map(n => [n.props.count, n.props.total])).toEqual([[0, 2], [1, 3]]);
    expect(find(tree, AccountList)[0].props.accounts.map((x: any) => x.device_id)).toEqual(["z"]);
    bars[1].props.onChange("sort", "name-desc"); tree = h.render(); bars = find(tree, AdminListToolbar);
    expect(new URLSearchParams(fixture.location.search).get("list_account_sort")).toBe("name-desc");
    bars[0].props.onReset(); expect(fixture.location.search).toBe("?tab=keep"); expect(fixture.location.hash).toBe("#accounts");
    expect(find(h.render(), AdminListToolbar).map(n => n.props.count)).toEqual([2, 3]); expect(fixture.get).not.toHaveBeenCalled();
  });
  it("keeps selected plan editor and account management independent from filtered lists", () => {
    const h = harness(Page); let tree = h.render();
    nodes(tree).find(n => n.props?.children === "编辑 / 停用").props.onClick();
    const planForm = find(h.render(), MonthlyPassPlanForm)[0]; expect(planForm.props.plan.id).toBe("p-z");
    find(h.render(), AccountList)[0].props.onSelect("z");
    find(h.render(), AdminListToolbar)[0].props.onChange("q", "absent");
    find(h.render(), AdminListToolbar)[1].props.onChange("q", "none");
    tree = h.render(); expect(find(tree, MonthlyPassPlanForm)[0].key).toBe(planForm.key); expect(find(tree, MonthlyPassPlanForm)[0].props.plan.id).toBe("p-z");
    expect(find(tree, AccountEditor)[0].props.deviceId).toBe("z"); expect(find(tree, AccountEditor)[0].props.plans).toBe(plans);
    find(tree, AdminListToolbar)[0].props.onReset(); expect(find(h.render(), MonthlyPassPlanForm)[0].key).toBe(planForm.key);
  });
  it("performs exactly four overview reads, no filter requests, and retains data on refresh failure", async () => {
    const h = harness(Page, true); h.render(); await tick(); expect(fixture.get).toHaveBeenCalledTimes(4);
    find(h.render(), AdminListToolbar)[1].props.onChange("q", "研发"); h.render(); await tick(); expect(fixture.get).toHaveBeenCalledTimes(4);
    fixture.get.mockRejectedValue(new Error("offline")); nodes(h.render()).find(n => n.props?.children === "刷新").props.onClick(); await tick();
    expect(find(h.render(), AdminListToolbar).map(n => n.props.total)).toEqual([2, 3]);
    expect(getCacheData("admin:monthly-passes").accounts).toHaveLength(3); expect(JSON.stringify(h.render())).toContain("offline"); h.unmount();
  });
  it("latest overview wins over an older response and stale failure", async () => {
    const h = harness(Page, true); h.render(); await tick();
    const a = deferred(), b = deferred();
    fixture.get.mockImplementation((path: string) => path.endsWith("/plans") ? a.promise : Promise.resolve({ items: [] }));
    const first = find(h.render(), MonthlyPassPlanForm)[0].props.onSaved().catch(() => {});
    fixture.get.mockImplementation((path: string) => path.endsWith("/plans") ? b.promise : Promise.resolve({ items: [] }));
    const second = find(h.render(), MonthlyPassPlanForm)[0].props.onSaved(); b.resolve({ items: [plans[1]] }); await second;
    a.resolve({ items: [plans[0]] }); await first; expect(getCacheData("admin:monthly-passes").plans).toEqual([plans[1]]);
    expect(find(h.render(), AdminListToolbar)[0].props.total).toBe(1);
    const stale = deferred(); fixture.get.mockImplementation((path: string) => path.endsWith("/plans") ? stale.promise : Promise.resolve({ items: [] }));
    const oldFailure = find(h.render(), MonthlyPassPlanForm)[0].props.onSaved().catch(() => {});
    fixture.get.mockResolvedValue({ items: [] }); await find(h.render(), MonthlyPassPlanForm)[0].props.onSaved();
    stale.reject(Error("stale failure")); await oldFailure;
    expect(find(h.render(), AdminListToolbar)[0].props.total).toBe(0); expect(JSON.stringify(h.render())).not.toContain("stale failure"); h.unmount();
  });
});
