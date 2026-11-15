import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { parseModelTypeConfig, resolvedModelType, validateModelBilling, isEmbeddingModel, isTextModel, EMBEDDING_HELP } from "../../web/src/utils/modelType";
import { buildDshProfile } from "../../web/src/utils/modelConfigExport";

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const squarePath = "../../web/src/components/ConsoleModelsSquare.tsx";
const chatPath = "../../web/src/components/ConsoleChatCard.tsx";
const guidePath = "../../web/src/components/ConsoleGuide.tsx";
const modelsPath = "../../web/src/pages/ModelsPage.tsx";
const { ConsoleModelsSquare, ModelOfferCard, matchesFilter } = await import(squarePath);
const { ConsoleChatCard } = await import(chatPath);
const { ConsoleGuide } = await import(guidePath);
const { serialize } = await import(modelsPath);
const render = (component: unknown, props: unknown) => renderToStaticMarkup(createElement(component, props));
const plain = (html: string) => html.replace(/<[^>]*>/g, "");
const source = (path: string) => readFileSync(new URL("../../web/src/" + path, import.meta.url), "utf8");
function embedding(extra: Record<string, unknown> = {}) {
  return { id: "embedding", model_name: "vector-only", model_type: "embedding" as const, billing_unit: "token",
    chat_endpoint: "/v1/embeddings", service_group_id: "g", service_group_name: "向量组", is_current: true,
    pricing_mode: "priced", input_price_per_m: 0.25, output_price_per_m: 987,
    cache_read_price_per_m: 986, cache_write_price_per_m: 985, search_price_per_call: 984,
    supports_reasoning: false, ...extra };
}
const textModel = { id: "chat", model_name: "chat-only", model_type: "text", billing_unit: "token", chat_endpoint: "/v1/chat/completions", supports_reasoning: false };
function draft(extra: Record<string, unknown> = {}) {
  return { provider_id: "p", model_name: "vector-only", display_name: "", description: "", alias: "", fallback_model_id: "",
    input_price_per_m: "0.25", output_price_per_m: "987", cache_read_price_per_m: "986", cache_write_price_per_m: "985",
    billing_unit: "token", price_per_call: "983", search_price_per_call: "984", pricing_mode: "priced",
    cache_enabled: true, cache_ttl: "3600", model_public: true, enabled: true,
    capabilities: [], routing_strategy: "priority", weight: 10, system_prompt: "", system_prompt_mode: "prepend",
    max_tokens_limit: "", model_rewrite: "", supports_search_tool: false,
    config_json: JSON.stringify({ model_type: "embedding", embedding_profile: { compatibility_key: "space-v1", dimensions: 256 }, custom: { preserved: true } }),
    ...extra };
}

describe("embedding UI configuration and billing", () => {
  it("keeps legacy text/image fallback and recognizes embedding endpoint metadata", () => {
    expect(resolvedModelType(null, "token")).toBe("text");
    expect(resolvedModelType("{}", "call")).toBe("image");
    expect(resolvedModelType('{"model_type":"text"}', "call")).toBe("text");
    expect(resolvedModelType('{"model_type":"embedding"}', "token")).toBe("embedding");
    expect(isEmbeddingModel({ chat_endpoint: "/v1/embeddings" })).toBe(true);
    expect(isTextModel({ model_type: "embedding", billing_unit: "token" })).toBe(false);
    expect(() => validateModelBilling('{"model_type":"embedding"}', "call")).toThrow("仅支持按输入 Token");
    expect(() => validateModelBilling('{"model_type":"image"}', "token")).toThrow("仅支持按请求次数");
    expect(() => validateModelBilling('{"model_type":"text"}', "call")).not.toThrow();
  });
  it("rejects malformed advanced JSON and invalid profile rather than silently replacing it", () => {
    for (const invalid of ["{", "[]", "null", '{"model_type":"other"}', '{"embedding_profile":{}}', '{"embedding_profile":{"compatibility_key":" "}}']) {
      expect(() => parseModelTypeConfig(invalid)).toThrow();
      expect(() => serialize(draft({ config_json: invalid }))).toThrow();
    }
    for (const dimensions of [0, -1, 1.5, "256"]) {
      expect(() => parseModelTypeConfig(JSON.stringify({ embedding_profile: { compatibility_key: "space", dimensions } }))).toThrow("正整数");
    }
    expect(parseModelTypeConfig('{"embedding_profile":{"compatibility_key":"space"}}')).toHaveProperty("embedding_profile");
  });
  it("serializes input-only billing with cache disabled and preserves advanced profile/custom JSON", () => {
    const payload = serialize(draft());
    expect(payload).toMatchObject({ billing_unit: "token", input_price_per_m: 0.25, output_price_per_m: 0,
      cache_read_price_per_m: 0, cache_write_price_per_m: 0, price_per_call: 0, search_price_per_call: 0, cache_enabled: false });
    expect(JSON.parse(payload.config_json)).toMatchObject({ model_type: "embedding", embedding_profile: { compatibility_key: "space-v1", dimensions: 256 }, custom: { preserved: true } });
    expect(() => serialize(draft({ billing_unit: "call" }))).toThrow();
    expect(serialize(draft({ config_json: '{"model_type":"text"}' })).output_price_per_m).toBe(987);
  });
  it("retains both admin type selectors, validation, input-only save guards and cache guards (static)", () => {
    for (const page of ["pages/ModelsPage.tsx", "pages/ModelGroupsPage.tsx"]) {
      const code = source(page);
      expect(code).toContain('<option value="embedding">');
      expect(code).toContain("validateModelBilling(");
      expect(code).toContain("parseModelTypeConfig(");
      expect(code).toContain("output_price_per_m: embedding ? 0");
      expect(code).toContain("cache_enabled: !embedding &&");
      expect(code).toMatch(/<option value="call" disabled=.{0,100}"embedding"/);
      expect(code).toContain("EMBEDDING_HELP");
    }
    expect(EMBEDDING_HELP).toContain("单个固定上游");
    expect(EMBEDDING_HELP).toContain("跨 member / Auto");
    expect(EMBEDDING_HELP).toContain("embedding_profile");
    expect(source("pages/ModelsPage.tsx").includes("向量模型不支持响应缓存")).toBe(true);
    expect(source("pages/ModelsPage.tsx").includes("enabled && items.some")).toBe(true);
  });
});

describe("embedding console SSR (no browser interactions or upstream requests)", () => {
  it("separates vector filter from conversation/reasoning/call filters including legacy endpoint", () => {
    for (const offer of [embedding(), embedding({ model_type: undefined }), embedding({ supports_reasoning: true })]) {
      expect(matchesFilter(offer, "embedding")).toBe(true);
      for (const filter of ["chat", "reasoning", "image", "call"]) expect(matchesFilter(offer, filter)).toBe(false);
    }
    expect(matchesFilter(textModel, "chat")).toBe(true);
  });
  it("shows vector input minimum/endpoint without an output minimum or output charge", () => {
    const html = render(ConsoleModelsSquare, { models: { items: [embedding()] }, loading: false, error: null });
    const text = plain(html);
    expect(text).toContain("向量");
    expect(text).toContain("embeddings");
    expect(text).toContain("输入最低¥0.25/M token");
    expect(text).not.toContain("输出最低¥");
    expect(text).not.toContain("¥987");
  });
  it("shows input-only quote, supported request fields and no cache/output/search charges", () => {
    const text = plain(render(ModelOfferCard, { m: embedding() }));
    expect(text).toContain("输入¥0.25");
    expect(text).toContain("/v1/embeddings");
    for (const field of ["string | string[]", "float / base64", "dimensions", "user"]) expect(text).toContain(field);
    for (const charge of ["输出¥", "缓存读取", "缓存写入", "联网搜索", "¥987", "¥986", "¥985", "¥984"]) expect(text).not.toContain(charge);
    expect(text).toContain("不收输出费用");
    expect(plain(render(ModelOfferCard, { m: embedding({ pricing_mode: "free" }) }))).toContain("输入¥0");
    expect(plain(render(ModelOfferCard, { m: embedding({ pricing_mode: "unset" }) }))).not.toContain("¥");
  });
  it("never puts embedding models into the ChatCard picker", () => {
    const html = render(ConsoleChatCard, { models: { items: [embedding(), textModel, { ...textModel, id: "call", model_name: "per-call-text", billing_unit: "call" }] } });
    expect(html).toContain('value="chat-only"');
    expect(html).not.toContain("vector-only");
    expect(html).not.toContain("per-call-text");
  });
  it("selects separate real chat/vector models for guide examples and documents first-version limits", () => {
    const text = plain(render(ConsoleGuide, { models: { items: [embedding(), textModel] } }));
    expect(text).toContain("/v1/embeddings");
    expect(text).toContain("vector-only");
    expect(text).toContain("chat-only");
    for (const field of ["encoding_format", "base64", "dimensions", "user", "不支持 token ID 数组", "不收输出费用", "向量维数和兼容性"]) expect(text).toContain(field);
    for (const internal of ["embedding_profile", "跨 member", "单个固定上游"]) expect(text).not.toContain(internal);
    const snippets = render(ConsoleGuide, { models: { items: [embedding(), textModel] } }).split("<pre").slice(1).map((code: string) => code.split("</pre>")[0]);
    expect(snippets.find((code: string) => code.includes("/v1/chat/completions"))).not.toContain("vector-only");
    expect(snippets.find((code: string) => code.includes("/v1/embeddings"))).toContain("vector-only");
  });
  it("does not export embeddings as OpenAI chat client profiles", () => {
    const result = buildDshProfile([embedding()], "https://example.invalid/v1");
    expect(result.skipped).toContainEqual({ id: "vector-only", reason: "向量模型不属于 OpenAI 文本 profile" });
  });
});
