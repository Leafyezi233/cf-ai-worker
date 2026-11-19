import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const squarePath = "../../web/src/components/ConsoleModelsSquare.tsx";
const categoryPath = "../../web/src/components/ConsoleModelCategories.tsx";
const { ConsoleModelsSquare, matchesCategorySquareFilters, matchesFilter } = await import(squarePath);
const { ModelCategoryBadges, ModelCategoryFilter, publicModelCategories, matchesModelCategory } = await import(categoryPath);
const category = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: "分类-" + id, description: "用途-" + id, sort_order: 0, color: "blue", ...extra });
function offer(name: string, group: string, extra: Record<string, unknown> = {}) {
  return { id: name + "-" + group, model_name: name, service_group_id: group, service_group_name: group,
    is_current: false, model_type: "text", pricing_mode: "priced", billing_unit: "token", chat_endpoint: "/v1/chat/completions",
    input_price_per_m: 5, output_price_per_m: 9, supports_reasoning: false, ...extra };
}
function markup(component: unknown, props: Record<string, unknown>) { return renderToStaticMarkup(createElement(component, props)); }
function text(html: string) { return html.replace(/<[^>]*>/g, ""); }
const defaults = { q: "", filter: "all", capability: "all", billing: "all" };

describe("console model categories (rendered React SSR and filter logic, not browser E2E)", () => {
  it("counts public names once across same-name group quotes and retains independent minima", () => {
    const items = [offer("shared", "cheap-input", { input_price_per_m: 1, categories: [category("code")] }),
      offer("shared", "cheap-output", { output_price_per_m: 2, categories: [category("code")] }), offer("plain", "solo")];
    const html = markup(ConsoleModelsSquare, { models: { items }, loading: false, error: null });
    const rendered = text(html);
    expect(html.match(/role="button"/g)).toHaveLength(2);
    expect(rendered).toContain("全部分类 (2)");
    expect(rendered).toContain("分类-code (1)");
    expect(rendered).toContain("未分类 (1)");
    expect(rendered).toContain("显示 2 / 2 个模型 · 3 个分组报价");
    expect(rendered).toContain("输入最低¥1/M tokencheap-input");
    expect(rendered).toContain("输出最低¥2/M tokencheap-output");
    expect(rendered).toContain("2 个授权组报价");
  });
  it("deduplicates sorted enabled labels, limits cards to two plus N and displays all in details", () => {
    const offers = [{ categories: [category("third", { sort_order: 3 }), category("first", { sort_order: 1 }), category("hidden", { enabled: 0 })] },
      { categories: [category("second", { sort_order: 2 }), category("first", { sort_order: 1 })] }];
    expect(publicModelCategories(offers).map((c: { id: string }) => c.id)).toEqual(["first", "second", "third"]);
    const card = markup(ModelCategoryBadges, { offers });
    expect(card).toContain("分类-first"); expect(card).toContain("分类-second"); expect(card).toContain(">+1<");
    expect(card).not.toContain(">分类-third<");
    const details = markup(ModelCategoryBadges, { offers, all: true });
    expect(details).toContain(">分类-third<"); expect(details).not.toContain(">+1<");
    expect(details).not.toContain("分类-hidden");
    expect(text(markup(ModelCategoryBadges, { offers: [{}], all: true }))).toBe("未分类");
  });
  it("intersects search, type, capability and billing before category counts without dropping any quote", () => {
    const shared = { model_name: "shared", offers: [offer("shared", "token", { supports_reasoning: true, categories: [category("code")] }),
      offer("shared", "call", { billing_unit: "call", price_per_call: 0.2, categories: [category("code")] })] };
    const image = { model_name: "image", offers: [offer("image", "g", { model_type: "image", billing_unit: "call", categories: [category("art")] })] };
    const candidates = [shared, image].filter(g => matchesCategorySquareFilters(g, { ...defaults, filter: "chat", capability: "reasoning", billing: "token" }));
    expect(candidates).toEqual([shared]);
    const html = text(markup(ModelCategoryFilter, { groups: candidates, selected: "code", onChange: () => {} }));
    expect(html).toContain("分类-code (1)"); expect(html).not.toContain("分类-art");
    expect(candidates.filter(g => matchesModelCategory(g.offers, "code"))[0].offers).toHaveLength(2);
    expect(matchesCategorySquareFilters(shared, { ...defaults, capability: "reasoning", billing: "call" })).toBe(false);
    expect(matchesCategorySquareFilters(shared, { ...defaults, q: "用途-code" })).toBe(true);
    expect(matchesCategorySquareFilters(shared, { ...defaults, q: "分类-code" })).toBe(true);
    expect(matchesCategorySquareFilters(shared, { ...defaults, q: "absent" })).toBe(false);
  });
  it("never infers real type or capabilities from category names", () => {
    const embedding = offer("emb", "g", { model_type: "embedding", chat_endpoint: "/v1/embeddings", supports_reasoning: true,
      categories: [category("fake", { name: "对话 推理 视觉 工具" })] });
    expect(matchesFilter(embedding, "embedding")).toBe(true);
    expect(matchesFilter(embedding, "chat")).toBe(false);
    const group = { model_name: "emb", offers: [embedding] };
    expect(matchesCategorySquareFilters(group, { ...defaults, capability: "reasoning" })).toBe(false);
    expect(matchesCategorySquareFilters(group, { ...defaults, capability: "vision" })).toBe(false);
    const vision = { ...group, offers: [{ ...embedding, model_type: "text", input_modalities: ["image"] }] };
    expect(matchesCategorySquareFilters(vision, { ...defaults, capability: "vision" })).toBe(true);
  });
  it("treats disabled-only and legacy models as uncategorized and has horizontal single-selection controls", () => {
    const groups = [{ offers: [{ categories: [category("disabled", { enabled: 0 })] }] }, { offers: [{}] }, { offers: [{ categories: [category("enabled")] }] }];
    expect(matchesModelCategory(groups[0].offers, "__uncategorized")).toBe(true);
    expect(matchesModelCategory(groups[1].offers, "__uncategorized")).toBe(true);
    expect(matchesModelCategory(groups[2].offers, "__uncategorized")).toBe(false);
    const html = markup(ModelCategoryFilter, { groups, selected: "enabled", onChange: () => {} });
    expect(html).toContain("overflow-x-auto"); expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(text(html)).toContain("未分类 (2)"); expect(html).not.toContain("分类-disabled");
    const selected: string[] = [];
    const element = ModelCategoryFilter({ groups, selected: "enabled", onChange: (id: string) => selected.push(id) });
    element.props.children[0].props.onClick();
    element.props.children[1][0].props.onClick();
    element.props.children[2].props.onClick();
    expect(selected).toEqual(["", "enabled", "__uncategorized"]);
  });
  it("shows primary type and category above collapsed advanced conditions and preserves no-authorized empty state", () => {
    const html = markup(ConsoleModelsSquare, { models: { items: [offer("one", "g")] }, loading: false, error: null });
    expect(html.indexOf('aria-label="模型类型"')).toBeLessThan(html.indexOf('aria-label="分类筛选"'));
    expect(html.indexOf('aria-label="分类筛选"')).toBeLessThan(html.indexOf("更多能力与计费条件"));
    expect(html).not.toMatch(/<details[^>]*\sopen(?:[\s=>])/);
    expect(text(markup(ConsoleModelsSquare, { models: { items: [] }, loading: false, error: null }))).toContain("当前没有授权模型");
    expect(text(markup(ConsoleModelsSquare, { models: null, loading: true, error: null }))).toContain("正在加载模型");
    expect(text(markup(ConsoleModelsSquare, { models: null, loading: false, error: new Error("directory failed") }))).toContain("directory failed");
  });
  it("escapes category text and omits categories not present in authorized offers", () => {
    const offers = [{ categories: [category("unsafe", { name: "<script>bad</script>", description: '"<img src=x>' })] }];
    const html = markup(ModelCategoryBadges, { offers, all: true });
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    const filters = markup(ModelCategoryFilter, { groups: [{ offers }], selected: "", onChange: () => {} });
    expect(filters).not.toContain("secret-admin-category");
  });
});
