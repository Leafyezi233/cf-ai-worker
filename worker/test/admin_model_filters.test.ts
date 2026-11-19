import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const fixture = vi.hoisted(() => ({
  location: { pathname: "/admin/models", search: "", hash: "#table" },
  navigate: vi.fn(), post: vi.fn(), refresh: vi.fn(), models: [] as any[], groups: [] as any[],
  categories: { items: [{ id: "cat", name: "编程", enabled: 1, sort_order: 0 }], bindings: [{ model_name: "public", category_id: "cat" }] },
}));
vi.mock("../../web/src/api/client", () => ({ api: { post: fixture.post }, ApiError: class extends Error {} }));
vi.mock("../../web/src/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../../web/src/hooks/useQuery", () => ({
  useQuery: (key: string) => ({ data: key === "models-page-data" ? { items: fixture.models, providers: [{ id: "p", name: "Provider" }] } : key === "model-groups" ? fixture.groups : key === "admin-model-categories" ? fixture.categories : fixture.models, loading: false, error: null, refresh: fixture.refresh }),
  invalidateCache: vi.fn(),
}));
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
vi.doMock((requireWeb as any).resolve("react-router-dom"), () => ({ useLocation: () => fixture.location, useNavigate: () => fixture.navigate }));
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const hookPath = "../../web/src/hooks/useAdminFilters";
const { readAdminFilters, writeAdminFilters, useAdminFilters } = await import(hookPath);
const modelsPath = "../../web/src/pages/ModelsPage";
const groupsPath = "../../web/src/pages/ModelGroupsPage";
const toolbarPath = "../../web/src/components/AdminListToolbar";
const { default: ModelsPage } = await import(modelsPath);
const { default: ModelGroupsPage } = await import(groupsPath);
const { AdminListToolbar } = await import(toolbarPath);

type Element = { type?: any; props?: Record<string, any> };
function nodes(value: any): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  return [value, ...nodes(value.props?.children)];
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") return text(value.props?.children);
  return value == null || typeof value === "boolean" ? "" : String(value);
}
function harness(component: () => any, selected: string[] = []) {
  const slots: any[] = []; let index = 0;
  const dispatcher = {
    useState(initial: any) {
      const i = index++;
      if (!(i in slots)) slots[i] = initial instanceof Set ? new Set(selected) : Array.isArray(initial) ? [...selected] : typeof initial === "function" ? initial() : initial;
      return [slots[i], (next: any) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }];
    },
    useRef(initial: any) { const i = index++; return slots[i] ||= { current: initial }; },
    useMemo(fn: () => any) { return fn(); }, useCallback(fn: any) { return fn; }, useEffect() {},
  };
  function render() {
    index = 0;
    const current = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
    const previous = current.current; current.current = dispatcher;
    try { return component(); } finally { current.current = previous; }
  }
  return { render };
}
const defaults = { q: "", enabled: "", sort: "" };
const model = (id: string, extra = {}) => ({ id, model_name: id, display_name: "", alias: "", enabled: 1, pricing_mode: "priced", provider_id: "p", config_json: "{}", billing_unit: "token", ...extra });
const group = (id: string, extra = {}) => ({ ...model(id), name: id, members: [], ...extra });
const rows = (tree: any) => nodes(tree).filter(n => n.type === "tbody").flatMap(n => nodes(n.props?.children).filter(row => row.type === "tr").map(row => row.props?.children));
beforeEach(() => {
  vi.clearAllMocks(); fixture.location = { pathname: "/admin/models", search: "", hash: "#table" };
  fixture.navigate.mockImplementation((next: any) => { fixture.location = next; }); fixture.refresh.mockResolvedValue(undefined);
  fixture.models = [model("zulu", { alias: "public", config_json: '{"capabilities":["code"]}' }), model("alpha", { enabled: 0, pricing_mode: "free", config_json: '{"model_type":"embedding"}' }), model("bravo", { billing_unit: "call", pricing_mode: null })];
  fixture.groups = [group("zulu"), group("alpha", { enabled: 0, pricing_mode: "free", config_json: '{"model_type":"embedding"}' }), group("public", { billing_unit: "call", pricing_mode: null })];
  vi.stubGlobal("window", { location: { origin: "https://gateway.test" } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("shared admin URL filter contract", () => {
  it("restores only declared list-prefixed conditions", () => {
    expect(readAdminFilters("?q=ignored&list_q=hello+world&list_enabled=0&token=secret&list_secret=hidden", defaults)).toEqual({ q: "hello world", enabled: "0", sort: "" });
  });
  it("writes/removes defaults and preserves unrelated parameters", () => {
    const updated = writeAdminFilters("?token=keep&tab=routes&list_q=old&list_other=keep", defaults, { q: "中文 + /", enabled: "1", sort: "" });
    expect(new URLSearchParams(updated).get("list_q")).toBe("中文 + /");
    const reset = new URLSearchParams(writeAdminFilters(updated, defaults, defaults));
    expect([...reset]).toEqual([["token", "keep"], ["tab", "routes"], ["list_other", "keep"]]);
  });
  it("replaces router URL, preserves hash, handles rapid changes, reset, and restored navigation", () => {
    fixture.location.search = "?tab=keep";
    const h = harness(() => useAdminFilters(defaults));
    let [, set, reset] = h.render(); set("q", "first"); set("enabled", "0");
    expect(fixture.navigate).toHaveBeenLastCalledWith({ pathname: "/admin/models", search: "?tab=keep&list_q=first&list_enabled=0", hash: "#table" }, { replace: true });
    expect(h.render()[0]).toEqual({ q: "first", enabled: "0", sort: "" });
    fixture.location = { ...fixture.location, search: "?tab=keep&list_q=back" };
    expect(h.render()[0].q).toBe("back");
    const calls = fixture.navigate.mock.calls.length; set("secret", "never"); expect(fixture.navigate).toHaveBeenCalledTimes(calls);
    [, , reset] = h.render(); reset(); expect(fixture.location.search).toBe("?tab=keep");
  });
});

describe("model and model-group list projections", () => {
  it("combines model keyword/provider/capability/category/status/pricing/type conditions", () => {
    fixture.location.search = "?list_q=+PUBLIC+&list_provider=p&list_capability=code&list_category=cat&list_enabled=1&list_pricing=priced&list_type=text";
    const tree = harness(ModelsPage).render();
    expect(rows(tree)).toHaveLength(1); expect(text(rows(tree))).toContain("zulu");
    const toolbar = nodes(tree).find(n => n.type === AdminListToolbar)!;
    expect(toolbar.props?.count).toBe(1); expect(toolbar.props?.total).toBe(3);
    fixture.location.search = "?list_type=video"; expect(rows(harness(ModelsPage).render())).toHaveLength(0);
  });
  it("supports disabled/free/embedding and fallback image/unset without mutating full models", () => {
    const before = JSON.stringify(fixture.models);
    fixture.location.search = "?list_enabled=0&list_pricing=free&list_type=embedding";
    expect(text(rows(harness(ModelsPage).render()))).toContain("alpha");
    fixture.location.search = "?list_pricing=unset&list_type=image";
    expect(text(rows(harness(ModelsPage).render()))).toContain("bravo");
    expect(JSON.stringify(fixture.models)).toBe(before);
  });
  it.each(["name", "name-desc"])("sorts both projections by %s without mutating source arrays", sort => {
    fixture.location.search = "?list_sort=" + sort;
    const modelsBefore = fixture.models.map(m => m.id), groupsBefore = fixture.groups.map(g => g.id);
    const modelRows = rows(harness(ModelsPage).render()); const groupRows = rows(harness(ModelGroupsPage).render());
    expect(text(modelRows[0])).toContain(sort === "name" ? "alpha" : "zulu");
    expect(text(groupRows[0])).toContain(sort === "name" ? "alpha" : "zulu");
    expect(fixture.models.map(m => m.id)).toEqual(modelsBefore); expect(fixture.groups.map(g => g.id)).toEqual(groupsBefore);
  });
  it("combines group display-name search and category with the new conditions", () => {
    fixture.groups[2].display_name = "Friendly";
    fixture.location.search = "?list_q=+FRIENDLY+&list_category=cat&list_type=image&list_pricing=unset&list_enabled=1";
    const tree = harness(ModelGroupsPage).render(); expect(rows(tree)).toHaveLength(1); expect(text(rows(tree))).toContain("public");
    expect(nodes(tree).find(n => n.type === AdminListToolbar)?.props?.count).toBe(1);
    fixture.location.search = "?list_q=no-match";
    expect(text(harness(ModelGroupsPage).render())).not.toContain("还没有分组");
  });
  it("disables hidden model batch actions, guards handlers, and clears hidden choices", async () => {
    fixture.location.search = "?list_q=zulu";
    const h = harness(ModelsPage, ["zulu", "alpha"]); let tree = h.render();
    expect(text(tree)).toContain("隐藏 1 项");
    const enable = nodes(tree).find(n => n.props?.onClick && text(n) === "启用")!;
    expect(enable.props?.disabled).toBe(true); await enable.props?.onClick(); expect(fixture.post).not.toHaveBeenCalled();
    nodes(tree).find(n => n.props?.onClick && text(n) === "清理隐藏选择")!.props!.onClick();
    tree = h.render(); expect(text(tree)).toContain("隐藏 0 项");
    expect(nodes(tree).find(n => n.props?.onClick && text(n) === "启用")?.props?.disabled).toBe(false);
  });
  it("disables hidden group category batches until hidden selections are cleared", () => {
    fixture.location.search = "?list_q=zulu";
    const h = harness(ModelGroupsPage, ["zulu", "alpha"]); let tree = h.render();
    const assignment = () => nodes(tree).find(n => n.props?.label === "批量分类")!;
    expect(assignment().props?.disabled).toBe(true);
    nodes(tree).find(n => n.props?.onClick && text(n) === "清理隐藏选择")!.props!.onClick(); tree = h.render();
    expect(assignment().props?.disabled).toBe(false); expect(text(tree)).toContain("隐藏 0 项");
  });
  it("renders shared keyword/status/sort/reset/count/error/refresh controls", () => {
    const html = renderToStaticMarkup(React.createElement(AdminListToolbar, { filters: defaults, onChange: vi.fn(), onReset: vi.fn(), total: 7, count: 2, loading: true, error: "failed", onRefresh: vi.fn() }));
    for (const label of ["关键词", "启用状态", "名称排序", "清空筛选", "显示 2 / 7 项", "刷新中", "failed"]) expect(html).toContain(label);
  });
});
