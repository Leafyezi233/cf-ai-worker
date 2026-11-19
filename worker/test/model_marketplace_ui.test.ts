import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const componentPath = "../../web/src/components/ConsoleModelsSquare.tsx";
const { ConsoleModelsSquare } = await import(componentPath);

function offer(group: string, input: number, output: number, extra: Record<string, unknown> = {}) {
  return { id: "same-target", model_name: "shared-demo", service_group_id: group, service_group_name: group,
    is_current: false, pricing_mode: "priced", input_price_per_m: input, output_price_per_m: output,
    billing_unit: "token", chat_endpoint: "/v1/chat/completions", supports_reasoning: false, ...extra };
}
function render(items: unknown[], routing?: { mode: "auto" | "legacy" | "fixed" | "multi"; selection: "ordered" | "input_price" | null; failure_fallback: boolean; fixed_group_id: string | null; fixed_group_name: string | null }) {
  return renderToStaticMarkup(createElement(ConsoleModelsSquare, { models: { items, routing }, loading: false, error: null }));
}
function plain(html: string) { return html.replace(/<[^>]*>/g, ""); }

describe("model marketplace cards (server rendering, not browser E2E)", () => {
  it("aggregates same names once and labels independent input/output minimum sources", () => {
    const html = render([offer("input-cheap", 1, 9), offer("output-cheap", 7, 2)]);
    expect(html.match(/role="button"/g)).toHaveLength(1);
    const text = plain(html);
    expect(text).toContain("输入最低¥1/M tokeninput-cheap");
    expect(text).toContain("输出最低¥2/M tokenoutput-cheap");
    expect(text).toContain("可能来自不同分组");
  });
  it("keeps all tied group sources and current labels", () => {
    const text = plain(render([offer("alpha", 2, 4, { is_current: true }), offer("beta", 2, 4)], { mode: "fixed", selection: null, failure_fallback: false, fixed_group_id: "alpha", fixed_group_name: "alpha" }));
    expect(text).toContain("输入最低¥2/M token令牌固定选择：alpha、beta");
  });
  it("explains automatic routing order without claiming the lowest quote is selected", () => {
    const text = plain(render([offer("alpha", 1, 2)], { mode: "auto", selection: "input_price", failure_fallback: true, fixed_group_id: null, fixed_group_name: null }));
    expect(text).toContain("按输入价优先排序（按次模型按次价比较）");
    expect(text).toContain("此 Token 使用自动路由");
    expect(text).not.toContain("此 Token 固定选择");
  });
  it("states that multi-group routing has no unique current group", () => {
    const text = plain(render([offer("alpha", 1, 2)], { mode: "multi", selection: "ordered", failure_fallback: false, fixed_group_id: null, fixed_group_name: null }));
    expect(text).toContain("实际分组由路由策略决定");
    expect(text).not.toContain("此 Token 固定选择");
  });
  it("excludes unset zero but includes explicitly free offers", () => {
    const unset = offer("unset-group", 0, 0, { pricing_mode: "unset" });
    expect(plain(render([unset, offer("paid", 3, 4)]))).toContain("输入最低¥3/M tokenpaid");
    expect(plain(render([unset, offer("free-group", 90, 80, { pricing_mode: "free" })]))).toContain("输入最低¥0/M tokenfree-group");
  });
  it("does not compare per-call zero token prices against token offers", () => {
    const text = plain(render([offer("tokens", 3, 5), offer("images", 0, 0, { billing_unit: "call", price_per_call: 0.1 })]));
    expect(text).toContain("输入最低¥3/M tokentokens");
    expect(text).toContain("按次最低¥0.1/次images");
  });
  it("uses current peak-adjusted prices including a zero multiplier", () => {
    expect(plain(render([offer("peak", 2, 3, { peak_pricing_enabled: true, current_price_multiplier: 3 }), offer("normal", 4, 8)]))).toContain("输入最低¥4/M tokennormal");
    expect(plain(render([offer("zero-band", 2, 3, { peak_pricing_enabled: true, current_price_multiplier: 0 })]))).toContain("输入最低¥0/M tokenzero-band");
  });
});

const { ModelOfferCard } = await import(componentPath);
function renderOffer(extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(ModelOfferCard, { m: offer("claude默认", 0.85, 4.8, {
    model_name: "claude-opus-5-5", display_name: "claude-opus-5-5", is_current: true,
    supports_reasoning: true, default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "Balances speed and reasoning" }],
    cache_read_price_per_m: 0.65, cache_write_price_per_m: 3.5, search_price_per_call: 0.0012,
    ...extra,
  }) }));
}

describe("group quote readability (SSR, not browser layout)", () => {
  it("puts primary prices before technical details, without repeating the model name", () => {
    const html = renderOffer();
    expect(html.indexOf("输入")).toBeLessThan(html.indexOf("<details"));
    expect(html.indexOf("¥0.85")).toBeLessThan(html.indexOf("<details"));
    expect(html).toContain("grid-cols-2");
    expect(plain(html)).toContain("此 Token 固定选择");
    expect(html).not.toContain("claude-opus-5-5");
    expect(html).not.toContain("已定价");
  });
  it("collapses endpoint, reasoning descriptions and base prices by default", () => {
    const html = renderOffer();
    expect(html).toContain("<details class=");
    expect(html).not.toMatch(/<details[^>]*\sopen(?:[\s=>])/);
    const folded = html.slice(html.indexOf("<details"));
    expect(folded).toContain("/v1/chat/completions");
    expect(folded).toContain("Balances speed and reasoning");
    expect(folded).toContain("基础标价");
    expect(plain(html.slice(0, html.indexOf("<details")))).toContain("默认 medium");
  });
  it("preserves peak-adjusted token and cache prices but does not multiply search", () => {
    const text = plain(renderOffer({ input_price_per_m: 2, output_price_per_m: 4,
      cache_read_price_per_m: 0, cache_write_price_per_m: 1,
      peak_pricing_enabled: true, current_price_multiplier: 3 }));
    expect(text).toContain("输入¥6");
    expect(text).toContain("输出¥12");
    expect(text).toContain("缓存读取¥6");
    expect(text).toContain("缓存写入¥3");
    expect(text).toContain("联网搜索¥0.0012");
    expect(text).toContain("按输入价计费");
  });
  it("keeps per-call quotes separate from token and cache prices", () => {
    const text = plain(renderOffer({ billing_unit: "call", price_per_call: 0.2 }));
    expect(text).toContain("单次调用¥0.2元 / 次");
    expect(text).not.toContain("缓存读取");
    expect(text).not.toContain("输入¥");
  });
  it("does not display unset values as free, and explicitly free quotes stay zero", () => {
    const unset = plain(renderOffer({ pricing_mode: "unset" }));
    expect(unset).toContain("尚未定价，不参与最低价比较");
    expect(unset).not.toContain("¥");
    const free = plain(renderOffer({ pricing_mode: "free" }));
    expect(free).toContain("免费");
    expect(free).toContain("输入¥0");
    expect(free).toContain("联网搜索¥0");
  });
  it("preserves and escapes descriptions, different display names and aliases", () => {
    const html = renderOffer({ description: "<script>alert(1)</script>", display_name: "friendly-name", alias: "short-name" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("friendly-name");
    expect(html).toContain("short-name");
  });
});
