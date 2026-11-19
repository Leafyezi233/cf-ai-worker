import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const f = vi.hoisted(() => ({
  location: { pathname: "/admin/devices", search: "", hash: "#keep" },
  navigate: vi.fn(), get: vi.fn(), put: vi.fn(), post: vi.fn(), refresh: vi.fn(), refreshWindows: vi.fn(), toast: vi.fn(),
  devices: [] as any[], templates: [] as any[], pricing: [] as any[], windows: null as any,
  error: null as Error | null, refreshing: false,
}));
vi.mock("../../web/src/api/client", () => ({ api: { get: f.get, put: f.put, post: f.post }, ApiError: class extends Error {}, fmtTime: () => "time" }));
vi.mock("../../web/src/components/Toast", () => ({ useToast: () => ({ success: f.toast, error: f.toast }) }));
vi.mock("../../web/src/hooks/useQuery", () => ({
  useQuery: (key: string, _fetch: unknown, options?: any) => ({
    data: options?.enabled === false ? undefined : key.startsWith("devices-list") || key === "device-templates-devices" ? f.devices : key === "device-templates" ? f.templates : key === "peak-pricing-models" ? f.pricing : key.startsWith("peak-pricing:") ? f.windows : [],
    loading: false, isRefreshing: f.refreshing, error: f.error,
    refresh: key.startsWith("peak-pricing:") ? f.refreshWindows : f.refresh,
  }),
  invalidateCache: vi.fn(),
}));
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
vi.doMock((requireWeb as any).resolve("react-router-dom"), () => ({ useLocation: () => f.location, useNavigate: () => f.navigate }));
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const devicesPath = "../../web/src/pages/DevicesPage";
const templatesPath = "../../web/src/pages/DeviceTemplatesPage";
const peakPath = "../../web/src/pages/PeakPricingPage";
const toolbarPath = "../../web/src/components/AdminListToolbar";
const { default: DevicesPage } = await import(devicesPath);
const { default: DeviceTemplatesPage } = await import(templatesPath);
const { default: PeakPricingPage } = await import(peakPath);
const { AdminListToolbar } = await import(toolbarPath);
function nodes(v: any): any[] {
  if (Array.isArray(v)) return v.flatMap(nodes);
  return v && typeof v === "object" ? [v, ...nodes(v.props?.children), ...nodes(v.props?.action)] : [];
}
function text(v: any): string {
  if (Array.isArray(v)) return v.map(text).join("");
  return v && typeof v === "object" ? text(v.props?.children) : v == null || typeof v === "boolean" ? "" : String(v);
}
const rows = (tree: any) => nodes(tree).filter(n => n.type === "tbody").flatMap(n => nodes(n.props.children).filter(n => n.type === "tr"));
const toolbar = (tree: any) => nodes(tree).find(n => n.type === AdminListToolbar).props;
const button = (tree: any, label: string) => nodes(tree).find(n => n.props?.onClick && text(n) === label).props;
const field = (tree: any, label: string) => nodes(tree).find(n => n.props?.["aria-label"] === label).props;
function harness(component: () => any) {
  const slots: any[] = []; let index = 0; let effects: (() => void)[] = [];
  const dispatcher = {
    useState(initial: any) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (next: any) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useRef(initial: any) { const i = index++; return slots[i] ||= { current: initial }; },
    useMemo(fn: any) { return fn(); }, useCallback(fn: any) { return fn; },
    useEffect(fn: any, deps: any[]) { const i = index++; if (!slots[i] || deps.some((v, j) => v !== slots[i][j])) { slots[i] = deps; effects.push(fn); } },
  };
  return { render() {
    index = 0; effects = [];
    const current = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
    const previous = current.current; current.current = dispatcher;
    try { const tree = component(); effects.forEach(fn => fn()); return tree; } finally { current.current = previous; }
  } };
}
const device = (id: string, extra = {}) => ({ id, name: id, enabled: 1, rate_limit_rpm: 0, created_at: 1, last_used_at: null, revoked_at: null, ...extra });
const template = (id: string, extra = {}) => ({ id, name: id, description: "", model_scope: "list", models: [], groups: [], ...extra });
const pricing = (id: string, extra = {}) => ({ id, model_name: id, enabled: 1, pricing_mode: "priced", peak_pricing_enabled: 1, scope: "model", ...extra });
beforeEach(() => {
  vi.clearAllMocks(); f.location = { pathname: "/admin/devices", search: "", hash: "#keep" }; f.error = null; f.refreshing = false;
  f.navigate.mockImplementation(next => { f.location = next; }); f.refresh.mockResolvedValue(undefined); f.refreshWindows.mockResolvedValue(undefined); f.put.mockResolvedValue({});
  f.devices = [device("zulu"), device("alpha", { enabled: 0, calls_enabled: 0, model_scope: "list" }), device("revoked", { revoked_at: 1 }), device("blocked", { cost_limit_monthly: 3, current_month_cost: 3 })];
  f.templates = [template("zulu", { models: [{ model_id: "m", model_name: "Public Model", rpm: 2 }], groups: [{ group_id: "g", name: "Grant Group", rpm: 4 }] }), template("alpha", { model_scope: "all" })];
  f.pricing = [pricing("zulu"), pricing("alpha", { scope: "group", enabled: 0, peak_pricing_enabled: 0 })];
  f.windows = { tz_offset_minutes: 480, items: [{ day_type: "weekday", start_minute: 1200, end_minute: 1440, multiplier: 2, enabled: 1 }, { day_type: "weekend", start_minute: 600, end_minute: 720, multiplier: 1, enabled: 0 }] };
  vi.stubGlobal("confirm", vi.fn(() => false));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function selectPeak(h: ReturnType<typeof harness>, id = "zulu") {
  let tree = h.render(); nodes(tree).find(n => n.props?.value === "" && n.props?.className === "w-56").props.onChange({ target: { value: id } });
  h.render(); return h.render();
}
describe("peak pricing refresh failure", () => {
  it("catches model refresh rejection instead of leaking an unhandled promise", async () => {
    f.refresh.mockRejectedValue(new Error("refresh_offline"));
    const h = harness(PeakPricingPage);
    toolbar(h.render()).onRefresh();
    await Promise.resolve(); await Promise.resolve();
    expect(f.toast).toHaveBeenCalledWith(expect.stringContaining("refresh_offline"));
  });
});
describe("phase2 device list filters", () => {
  it("filters master-token service selection and routing mode without extra requests", () => {
    f.devices = [device("one", { routing_policy_mode: "multi", routing_group_ids: ["cheap", "extra"] }), device("two", { routing_policy_mode: "fixed", selected_service_group_name: "低价池", selected_service_group_id: "cheap" })];
    f.location.search = "?list_routing=multi&list_service=cheap"; expect(text(rows(harness(DevicesPage).render()))).toContain("one"); expect(rows(harness(DevicesPage).render())).toHaveLength(1);
    f.location.search = "?list_service=" + encodeURIComponent("低价池"); expect(text(rows(harness(DevicesPage).render()))).toContain("two"); expect(f.get).not.toHaveBeenCalled();
  });
  it("combines URL keyword, enabled, call policy and scope using legacy defaults", () => {
    f.location.search = "?list_q=+ZULU+&list_enabled=1&list_calls=1&list_scope=all";
    const tree = harness(DevicesPage).render(); expect(rows(tree)).toHaveLength(1); expect(text(rows(tree))).toContain("zulu");
    expect(toolbar(tree).count).toBe(1); expect(toolbar(tree).total).toBe(4);
    f.location.search = "?list_calls=0&list_scope=list&list_enabled=0"; expect(text(rows(harness(DevicesPage).render()))).toContain("alpha");
  });
  it("requires explicit revoked inclusion and identifies monthly blocked devices", () => {
    f.location.search = "?list_state=revoked"; expect(rows(harness(DevicesPage).render())).toHaveLength(0);
    f.location.search = "?list_state=revoked&list_revoked=1"; expect(text(rows(harness(DevicesPage).render()))).toContain("revoked");
    f.location.search = "?list_state=blocked"; expect(text(rows(harness(DevicesPage).render()))).toContain("blocked");
  });
  it.each([DevicesPage, DeviceTemplatesPage, PeakPricingPage])("sorts projections without modifying originals", Page => {
    const before = JSON.stringify([f.devices, f.templates, f.pricing]); f.location.search = "?list_sort=name";
    expect(text(rows(harness(Page).render())[0])).toContain("alpha"); expect(JSON.stringify([f.devices, f.templates, f.pricing])).toBe(before);
  });
  it("distinguishes errors, zero records and no matches, retaining stale data during refresh", () => {
    f.location.search = "?list_q=no-match"; let tree = harness(DevicesPage).render(); expect(nodes(tree).some(n => n.props?.text === "没有符合筛选条件的设备")).toBe(true);
    f.location.search = ""; f.error = new Error("offline"); f.refreshing = true; tree = harness(DevicesPage).render(); expect(rows(tree)).toHaveLength(3); expect(toolbar(tree).error).toBe("offline"); expect(toolbar(tree).loading).toBe(true);
    f.devices = []; tree = harness(DevicesPage).render(); expect(nodes(tree).some(n => n.props?.text === "设备列表加载失败，请重试")).toBe(true);
    f.error = null; tree = harness(DevicesPage).render(); expect(nodes(tree).some(n => n.props?.text === "尚未签发任何设备 Token")).toBe(true);
  });
  it("filter changes/reset only navigate; manual refresh is explicit", () => {
    const h = harness(DevicesPage); let tree = h.render(); toolbar(tree).onChange("q", "zulu"); tree = h.render(); toolbar(tree).onReset();
    expect(f.location.search).toBe(""); expect(f.get).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled(); toolbar(tree).onRefresh(); expect(f.refresh).toHaveBeenCalledOnce();
  });
});
describe("template list and complete draft saves", () => {
  it("combines case-insensitive grant search, range and model-group filters", () => {
    f.location.search = "?list_q=PUBLIC&list_scope=list&list_group=g"; const tree = harness(DeviceTemplatesPage).render(); expect(rows(tree)).toHaveLength(1); expect(text(rows(tree))).toContain("zulu"); expect(toolbar(tree).total).toBe(2);
    toolbar(tree).onChange("service_group", "invented"); expect(f.navigate).not.toHaveBeenCalled();
  });
  it("preserves hidden model/group grants and form drafts across list refresh/filtering", async () => {
    const h = harness(DeviceTemplatesPage); let tree = h.render(); nodes(tree).find(n => n.props?.title === "编辑").props.onClick(); tree = h.render();
    nodes(tree).find(n => n.props?.placeholder === "例如：实习生只读").props.onChange({ target: { value: "edited" } });
    toolbar(tree).onChange("q", "not-visible"); tree = h.render(); await toolbar(tree).onRefresh(); tree = h.render();
    await nodes(tree).find(n => n.type === "form").props.onSubmit({ preventDefault() {} });
    expect(f.put).toHaveBeenCalledWith("/api/device-templates/zulu", expect.objectContaining({ name: "edited", model_ids: ["m"], group_ids: ["g"], model_rpms: { m: 2 }, group_rpms: { g: 4 } }));
  });
  it("keeps explicit template apply targets independent of hidden list rows", async () => {
    const h = harness(DeviceTemplatesPage); let tree = h.render(); button(tree, "套用").onClick(); tree = h.render();
    toolbar(tree).onChange("q", "nothing"); tree = h.render(); await button(tree, "确认套用").onClick(); expect(f.post).not.toHaveBeenCalled();
    expect(text(h.render())).toContain("先选择要套用的设备");
  });
});
describe("peak pricing filters and draft protection", () => {
  it("combines pricing object conditions without per-keystroke reads", () => {
    f.location.search = "?list_q=ALPHA&list_scope=group&list_enabled=0&list_peak=0";
    const tree = harness(PeakPricingPage).render(); expect(rows(tree)).toHaveLength(1); expect(text(rows(tree))).toContain("alpha"); expect(f.get).not.toHaveBeenCalled();
  });
  it("filters rules by state, timezone and search while saving every hidden rule", async () => {
    const h = harness(PeakPricingPage); selectPeak(h); f.location.search = "?list_rule_enabled=1&list_timezone=480&list_rule_q=20:00";
    let tree = h.render(); expect(text(tree)).toContain("显示 1 / 2 时段"); await button(tree, "保存").onClick();
    expect(f.put).toHaveBeenCalledWith("/api/models/zulu/price-windows", { windows: [expect.objectContaining({ start: "20:00", enabled: true }), expect.objectContaining({ start: "10:00", enabled: false })] });
    f.location.search = "?list_timezone=0"; tree = h.render(); expect(text(tree)).toContain("显示 0 / 2 时段");
  });
  it("edits/deletes a filtered rule by its original index", async () => {
    const h = harness(PeakPricingPage); selectPeak(h); f.location.search = "?list_rule_enabled=0"; let tree = h.render();
    nodes(tree).find(n => n.props?.placeholder === "20:00").props.onChange({ target: { value: "11:00" } }); tree = h.render(); await button(tree, "保存").onClick();
    expect(f.put.mock.calls[0][1].windows.map((w: any) => w.start)).toEqual(["20:00", "11:00"]);
    button(tree, "删除").onClick(); tree = h.render(); await button(tree, "保存").onClick(); expect(f.put.mock.calls[1][1].windows).toHaveLength(1);
  });
  it("manual refresh skips dirty rules, preserves late responses and confirms switching", async () => {
    const h = harness(PeakPricingPage); let tree = selectPeak(h);
    nodes(tree).find(n => n.props?.placeholder === "20:00").props.onChange({ target: { value: "21:00" } }); tree = h.render(); await toolbar(tree).onRefresh();
    expect(f.refresh).toHaveBeenCalled(); expect(f.refreshWindows).not.toHaveBeenCalled();
    f.windows = { ...f.windows, items: [] }; h.render(); tree = h.render(); expect(nodes(tree).find(n => n.props?.placeholder === "20:00").props.value).toBe("21:00");
    nodes(tree).find(n => n.props?.className === "w-56").props.onChange({ target: { value: "alpha" } }); expect((globalThis as any).confirm).toHaveBeenCalled(); tree = h.render(); expect(nodes(tree).find(n => n.props?.className === "w-56").props.value).toBe("zulu");
  });
  it("saves cached group rows through group endpoints even before a list fetch", async () => {
    f.pricing[1].pricing_mode = "priced";
    const h = harness(PeakPricingPage); const tree = selectPeak(h, "alpha"); await button(tree, "保存").onClick();
    expect(f.put).toHaveBeenCalledWith("/api/model-groups/alpha/price-windows", expect.any(Object));
  });
  it("guards manual refresh while a complete draft save is in flight", async () => {
    let resolve!: () => void; f.put.mockImplementationOnce(() => new Promise<void>(r => { resolve = r; }));
    const h = harness(PeakPricingPage); let tree = selectPeak(h); const saving = button(tree, "保存").onClick();
    tree = h.render(); expect(toolbar(tree).loading).toBe(true); await toolbar(tree).onRefresh(); expect(f.refresh).not.toHaveBeenCalled();
    resolve(); await saving;
  });
  it("list toggle does not refresh or overwrite open rules", async () => {
    const h = harness(PeakPricingPage); const tree = selectPeak(h); await button(tree, "关闭").onClick(); expect(f.refresh).toHaveBeenCalled(); expect(f.refreshWindows).not.toHaveBeenCalled();
  });
  it("SSR renders shared controls and explicit unsupported metadata caveats", () => {
    for (const Page of [DevicesPage, DeviceTemplatesPage, PeakPricingPage]) {
      const html = renderToStaticMarkup(React.createElement(Page)); expect(html).toContain("列表筛选"); expect(html).toContain("清空筛选"); expect(html).toContain("刷新");
    }
  });
});
