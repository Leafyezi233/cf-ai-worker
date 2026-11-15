import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const fixture = vi.hoisted(() => ({ categories: { items: [], bindings: [] } as any, models: [] as any[], groups: [] as any[], error: null as Error | null, loading: false, post: vi.fn(), refresh: vi.fn(), invalidate: vi.fn() }));
vi.mock("../../web/src/api/client", () => ({ api: { post: fixture.post, get: vi.fn(), put: vi.fn(), del: vi.fn() }, ApiError: class extends Error {} }));
vi.mock("../../web/src/hooks/useQuery", () => ({
  useQuery: (key: string) => ({ data: key === "admin-model-categories" ? fixture.categories : key === "models-page-data" ? { items: fixture.models, providers: [] } : key === "model-groups" ? fixture.groups : [], loading: key === "admin-model-categories" && fixture.loading, error: key === "admin-model-categories" ? fixture.error : null, refresh: fixture.refresh }),
  invalidateCache: fixture.invalidate,
}));
vi.mock("../../web/src/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const componentPath = "../../web/src/components/ModelCategories.tsx";
const ui = await import(componentPath);
const modelsPath = "../../web/src/pages/ModelsPage.tsx";
const groupsPath = "../../web/src/pages/ModelGroupsPage.tsx";
const servicesPath = "../../web/src/pages/ServiceGroupsPage.tsx";
const { default: ModelsPage } = await import(modelsPath);
const { default: ModelGroupsPage } = await import(groupsPath);
const { default: ServiceGroupsPage } = await import(servicesPath);
const render = (component: unknown, props: unknown = {}) => renderToStaticMarkup(React.createElement(component, props));
const plain = (html: string) => html.replace(/<[^>]*>/g, "");
const state = (extra = {}) => ({ data: fixture.categories, loading: false, error: null, refresh: fixture.refresh, ...extra });
const category = (id: string, extra = {}) => ({ id, name: id === "a" ? "编程研发" : "旧分类", description: "自定义说明", color: "blue", enabled: 1, sort_order: 0, model_count: 2, ...extra });
const model = (id: string, extra = {}) => ({ id, model_name: id, provider_id: "p", provider_name: "Provider", config_json: "{}", enabled: true, ...extra });
function seededPage(component: () => unknown, seeds: Record<number, unknown>) {
  function Seeded() {
    let index = 0;
    const dispatcher = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current;
    const original = dispatcher.useState;
    dispatcher.useState = (initial: unknown) => { const i = index++; return original(Object.hasOwn(seeds, i) ? seeds[i] : initial); };
    try { return component(); } finally { dispatcher.useState = original; }
  }
  return render(Seeded);
}
beforeEach(() => {
  vi.clearAllMocks(); fixture.post.mockResolvedValue({}); fixture.refresh.mockResolvedValue(undefined);
  fixture.categories = { items: [category("a"), category("b", { enabled: 0, color: "red", sort_order: 3 })], bindings: [{ model_name: "public", category_id: "a" }, { model_name: "public", category_id: "b" }] };
  fixture.models = []; fixture.groups = []; fixture.error = null; fixture.loading = false;
  vi.stubGlobal("window", { location: { origin: "https://gateway.test" } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("admin category public-name contract", () => {
  it("uses alias then model name, never display name or member IDs", () => {
    expect(ui.categoryModelName({ alias: " public ", model_name: "upstream", display_name: "Pretty", id: "member-id" } as any)).toBe("public");
    expect(ui.categoryModelName({ alias: " ", model_name: " upstream " })).toBe("upstream");
    expect(ui.categoryIdsForModel(fixture.categories, "public")).toEqual(["a", "b"]);
    expect(ui.categoryIdsForModel(fixture.categories, "upstream")).toEqual([]);
  });
  it("intersects category filters, includes disabled bindings, and distinguishes unclassified", () => {
    expect(ui.matchesModelCategory(fixture.categories, "public", "b")).toBe(true);
    expect(ui.matchesModelCategory(fixture.categories, "public", "__uncategorized__")).toBe(false);
    expect(ui.matchesModelCategory(fixture.categories, "other", "__uncategorized__")).toBe(true);
    expect(ui.matchesModelCategory(fixture.categories, "other", "")).toBe(true);
    expect(ui.matchesModelCategory(fixture.categories, "other", "a")).toBe(false);
  });
  it.each(["add", "remove", "replace"] as const)("confirms %s and only writes deduplicated category associations", async operation => {
    const confirm = vi.fn((_message: string) => { expect(fixture.post).not.toHaveBeenCalled(); return true; });
    expect(await ui.applyModelCategoryBindings([" public ", "public", "second"], ["a", "b", "a"], operation, confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledOnce(); expect(confirm.mock.calls[0][0]).toContain("2 个公开调用名");
    expect(confirm.mock.calls[0][0]).toContain("全局共享");
    expect(fixture.post).toHaveBeenCalledOnce(); expect(fixture.post).toHaveBeenCalledWith("/api/model-categories/bindings", { model_names: ["public", "second"], category_ids: ["a", "b"], operation });
    expect(fixture.invalidate).toHaveBeenCalledWith("admin-model-categories");
  });
  it("cancelled confirmation performs no write or invalidation", async () => {
    expect(await ui.applyModelCategoryBindings(["public"], ["a"], "remove", () => false)).toBe(false);
    expect(fixture.post).not.toHaveBeenCalled(); expect(fixture.invalidate).not.toHaveBeenCalled();
  });
  it("allows explicit replace-empty but rejects empty targets or add/remove selections before confirmation", async () => {
    const confirm = vi.fn((_message: string) => true);
    await expect(ui.applyModelCategoryBindings([], ["a"], "add", confirm)).rejects.toThrow("公开调用名");
    for (const operation of ["add", "remove"] as const) await expect(ui.applyModelCategoryBindings(["public"], [], operation, confirm)).rejects.toThrow("至少一个分类");
    expect(confirm).not.toHaveBeenCalled(); expect(fixture.post).not.toHaveBeenCalled();
    expect(await ui.applyModelCategoryBindings(["public"], [], "replace", confirm)).toBe(true);
    expect(confirm.mock.calls[0][0]).toContain("清空全部关联");
    expect(fixture.post).toHaveBeenCalledWith("/api/model-categories/bindings", { model_names: ["public"], category_ids: [], operation: "replace" });
  });
  it("propagates mutation failures without invalidating successful data", async () => {
    fixture.post.mockRejectedValueOnce(new Error("save failed"));
    await expect(ui.applyModelCategoryBindings(["public"], ["a"], "add", () => true)).rejects.toThrow("save failed");
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });
});

describe("category components SSR (not browser interaction tests)", () => {
  it("renders all badges in sort order with descriptions/disabled state and unclassified fallback", () => {
    const html = render(ui.ModelCategoryBadges, { data: fixture.categories, modelName: "public" });
    expect(html).toContain('title="自定义说明"'); expect(plain(html)).toBe("编程研发旧分类（停用）");
    expect(plain(render(ui.ModelCategoryBadges, { data: fixture.categories, modelName: "other" }))).toBe("未分类");
  });
  it("renders loading/error filter states and a retry control", () => {
    expect(render(ui.ModelCategoryFilter, { state: state({ loading: true }), value: "", onChange: vi.fn() })).toContain('disabled=""');
    const html = render(ui.ModelCategoryFilter, { state: state({ error: new Error("load failed") }), value: "b", onChange: vi.fn() });
    expect(plain(html)).toContain("旧分类（停用）"); expect(plain(html)).toContain("load failed"); expect(plain(html)).toContain("重试分类");
  });
  it("renders a multi-select operation editor with global and destructive-clear warnings, never a form", () => {
    const html = render(ui.ModelCategoryBindingFields, { data: fixture.categories, names: ["public", "second"], ids: ["a"], operation: "replace", setIds: vi.fn(), setOperation: vi.fn() });
    for (const text of ["已选 2 个公开调用名", "添加分类（保留原有）", "移除所选分类", "替换全部分类", "清空关联", "全局共享", "不改变模型类型、能力、路由、授权或计费"]) expect(plain(html)).toContain(text);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2); expect(html.match(/checked=""/g)).toHaveLength(1); expect(html).not.toContain("<form");
  });
  it("shows definition fields, all six colors, global model counts and category-only deletion", () => {
    const text = plain(render(ui.ModelCategoryManager, { state: state() }));
    for (const field of ["名称", "简短说明", "顺序", "预设颜色", "启用分类", "关联模型数（全局公开名）", ...ui.CATEGORY_COLORS]) expect(text).toContain(field);
    expect(text).toContain(ui.CATEGORY_DELETE_HELP); expect(text).toContain("停用仅隐藏用户侧分类，不删除现有关联");
    const html = render(ui.ModelCategoryAssignment, { state: state(), modelNames: ["public"], disabled: true });
    expect(html).toContain('type="button"'); expect(html).toContain('disabled=""'); expect(html).not.toContain("<form");
  });
});

describe("admin page category integration SSR", () => {
  it("mounts the manager and uses the public alias, with the category filter intersecting the model list", () => {
    fixture.models = [model("raw-upstream", { alias: "public" }), model("uncategorized")];
    const html = render(ModelsPage);
    expect(plain(html)).toContain("模型分类管理"); expect(plain(html)).toContain("模型分类（公开名）");
    expect(html).toContain("编程研发");
    const filtered = seededPage(ModelsPage, { 26: "a" });
    expect(plain(filtered)).toContain("raw-upstream"); expect(plain(filtered)).not.toContain("uncategorized");
  });
  it("renders group-name badges, batch selection and category-filtered groups", () => {
    fixture.groups = [{ id: "g1", name: "public", members: [], billing_unit: "token", config_json: "{}", enabled: true }, { id: "g2", name: "unclassified-group", members: [], billing_unit: "token", config_json: "{}", enabled: true }];
    const html = seededPage(ModelGroupsPage, { 0: "a", 1: ["g1"] });
    expect(plain(html)).toContain("模型分类（公开名）"); expect(plain(html)).toContain("批量分类"); expect(html).toContain("编程研发"); expect(html).not.toContain("unclassified-group");
  });
  it("filters mapping display without changing the full save payload and disables draft-name assignments", () => {
    const saved = [{ id: "m1", model_key: "public", target_type: "group", target_id: "g1", member_ids_json: null, pricing_json: null }, { id: "m2", model_key: "hidden-key", target_type: "group", target_id: "g2", member_ids_json: null, pricing_json: null }];
    const mappings = saved.map(({ member_ids_json, pricing_json, ...m }) => ({ ...m, member_ids: null, pricing: null }));
    const html = seededPage(ServiceGroupsPage, { 0: "a", 2: [{ id: "s1", name: "Service", enabled: 1, multiplier: 1, models: saved }], 6: false, 8: "s1", 10: mappings });
    expect(html).toContain('value="public"'); expect(html).not.toContain('value="hidden-key"');
    expect(plain(html)).toContain("保存映射仍包含完整列表"); expect(plain(html)).toContain(ui.CATEGORY_RENAME_HELP);
    const source = readFileSync(new URL("../../web/src/pages/ServiceGroupsPage.tsx", import.meta.url), "utf8");
    expect(source).toContain('section === "models" ? { models: mappings.map');
    expect(source).toContain("saved.model_key === m.model_key && (!m.id || saved.id === m.id)");
    const justSaved = seededPage(ServiceGroupsPage, { 2: [{ id: "s1", name: "Service", models: saved }], 6: false, 8: "s1", 10: [{ ...mappings[0], id: undefined }] });
    expect(justSaved).toMatch(/aria-label="选择映射分类 public"(?! disabled)/);
    const renamed = seededPage(ServiceGroupsPage, { 2: [{ id: "s1", name: "Service", models: saved }], 6: false, 8: "s1", 10: [{ ...mappings[0], model_key: "unsaved-name" }] });
    expect(renamed).toContain('aria-label="选择映射分类 unsaved-name" disabled=""');
    expect(source).not.toContain("models: mappings.filter");
  });
});
