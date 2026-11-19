import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { buildDshProfile, buildPiModelsConfig, type ModelConfigMetadata } from "../../web/src/utils/modelConfigExport";

const BASE = "https://gateway.test/v1";
function metadata(extra: Record<string, unknown> = {}): ModelConfigMetadata {
  return { slug: "public", display_name: "Public Model", context_window: 128000, max_output_tokens: 8192,
    context_window_source: "config", max_output_tokens_source: "config", supports_reasoning: true,
    supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort, description: effort })),
    input_modalities: ["text", "image"], ...extra };
}
function models(items: ModelConfigMetadata[]) { return buildDshProfile(items, BASE).config.providers["cpg-gateway"]?.models ?? []; }

describe("DSH profile contract and public capability projection", () => {
  it("emits the DSH 0.2.0-rc.2 contract, not Pi fields or provider internals", () => {
    const result = buildDshProfile([metadata({ id: "internal-id", provider_url: "https://secret-provider.test", api_key: "secret-key",
      prices: { input: 19 }, config_json: '{"reasoning":"secret-wire"}', system_prompt: "secret-prompt", default_reasoning_level: "high" })], BASE);
    expect(result.config).toEqual({ providers: { "cpg-gateway": {
      displayName: "CPG Gateway", api: "openai-completions", baseURL: BASE, apiKeyEnv: "CPG_API_KEY",
      models: [{ id: "public", name: "Public Model", contextWindow: 128000, maxTokens: 8192, input: ["text", "image"],
        reasoningEfforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } }],
    } } });
    expect(result.warnings).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(JSON.stringify(result.config)).not.toMatch(/internal-id|secret|prices|config_json|system_prompt|baseUrl|apiKey"|"reasoning"|default_reasoning/);
  });
  it("only includes declared common abstract levels, without off/null or forced mapping", () => {
    expect(models([metadata({ supported_reasoning_levels: [{ effort: "off" }, { effort: "medium" }, { effort: "budget-2000" }] })])[0].reasoningEfforts).toEqual({ medium: "medium" });
    expect(models([metadata({ supports_reasoning: false })])[0].reasoningEfforts).toBe(false);
    expect(models([metadata({ supported_reasoning_levels: [{ effort: "off" }, { effort: "unknown" }] })])[0].reasoningEfforts).toBe(false);
    expect(models([metadata({ supported_reasoning_levels: [] })])[0].reasoningEfforts).toBe(false);
  });
  it.each([null, undefined, 0, -1, 1.2, NaN, Infinity, "8192", Number.MAX_SAFE_INTEGER + 1])("skips unknown or illegal output limit %s rather than fabricating one", (max_output_tokens) => {
    const result = buildDshProfile([metadata({ max_output_tokens })], BASE);
    expect(result.config).toEqual({ providers: {} });
    expect(result.skipped[0]).toMatchObject({ id: "public", reason: expect.stringContaining("max_output_tokens") });
    expect(result.warnings.join(" ")).toContain("请先配置真实");
  });
  it.each([0, -1, 1.5, NaN, "128000", undefined])("requires positive integer context %s", (context_window) => {
    expect(buildDshProfile([metadata({ context_window })], BASE).config).toEqual({ providers: {} });
  });
  it("rejects output greater than context and accepts equality", () => {
    expect(models([metadata({ context_window: 4096 })])).toEqual([]);
    expect(models([metadata({ context_window: 8192 })])[0].maxTokens).toBe(8192);
  });
  it("exports inferred/fallback context with prominent unverified warnings", () => {
    for (const context_window_source of ["inferred", "fallback", "group_min:inferred", "model_name", "mixed", undefined]) {
      const result = buildDshProfile([metadata({ context_window_source })], BASE);
      expect(result.config.providers["cpg-gateway"].models).toHaveLength(1);
      expect(result.warnings.join(" ")).toContain("不是真实已验证");
    }
  });
  it("deduplicates public ids with min budgets and modality/reasoning intersection", () => {
    const first = metadata({ context_window: 100000, max_output_tokens: 9000 });
    const second = metadata({ context_window: 64000, max_output_tokens: 4000, input_modalities: ["text"], supported_reasoning_levels: [{ effort: "high" }] });
    expect(models([first, second])).toEqual([{ id: "public", name: "Public Model", contextWindow: 64000, maxTokens: 4000, input: ["text"], reasoningEfforts: { high: "high" } }]);
    expect(models([first, metadata({ supports_reasoning: false })])[0].reasoningEfforts).toBe(false);
    expect(models([first, metadata({ supported_reasoning_levels: [{ effort: "off" }] })])[0].reasoningEfforts).toBe(false);
  });
  it("does not hide an incomplete or incompatible duplicate route in either order", () => {
    for (const bad of [metadata({ max_output_tokens: null }), metadata({ chat_endpoint: "/v1/messages" }), metadata({ billing_unit: "call" })]) {
      expect(models([metadata(), bad])).toEqual([]);
      expect(models([bad, metadata()])).toEqual([]);
    }
  });
  it("uses alias/model_name for console items and never falls back to database ids", () => {
    expect(models([metadata({ slug: undefined, alias: "client-alias", model_name: "model", id: "db-1" })])[0].id).toBe("client-alias");
    expect(models([metadata({ slug: undefined, model_name: "group-auto", is_group: true })])[0].id).toBe("group-auto");
    expect(models([metadata({ slug: undefined, id: "db-1" })])).toEqual([]);
  });
  it("skips Anthropic, image/per-call and non-text models with reasons", () => {
    const result = buildDshProfile([metadata({ slug: "messages", chat_endpoint: "/v1/messages" }), metadata({ slug: "images", billing_unit: "call" }), metadata({ slug: "audio", input_modalities: ["audio"] })], BASE);
    expect(result.config.providers).toEqual({});
    expect(result.skipped.map((item) => item.id)).toEqual(["messages", "images", "audio"]);
    expect(result.skipped.every((item) => item.reason.length > 0)).toBe(true);
  });
  it("does not infer vision or reasoning from familiar names or config_json", () => {
    const result = models([metadata({ slug: "gemini-vision-thinking", supports_reasoning: undefined, supported_reasoning_levels: undefined, input_modalities: undefined, config_json: '{"supports_reasoning":true}' })]);
    expect(result[0].input).toEqual(["text"]);
    expect(result[0].reasoningEfforts).toBe(false);
  });
  it("keeps ordinary Pi contract with complete maxTokens and reasoning boolean", () => {
    const config = buildPiModelsConfig([metadata()], BASE).config;
    expect(config.providers["personal-ai-gateway"]).toEqual({ name: "Personal AI Gateway", baseUrl: BASE, api: "openai-completions", apiKey: "YOUR_DEVICE_TOKEN", discoverModels: true,
      models: [{ id: "public", name: "Public Model", contextWindow: 128000, maxTokens: 8192, input: ["text", "image"], reasoning: true }] });
    expect(buildPiModelsConfig([metadata({ max_output_tokens: null })], BASE).config.providers).toEqual({});
    expect(JSON.stringify(config)).not.toMatch(/reasoningEfforts|baseURL|apiKeyEnv|default_reasoning/);
  });
});

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
vi.doMock((requireWeb as any).resolve("react-router-dom"), () => ({
  useLocation: () => ({ pathname: "/admin/models", search: "", hash: "" }),
  useNavigate: () => vi.fn(),
}));
const { readFileSync } = requireWeb("node:fs");
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const componentPath = "../../web/src/components/ConsoleGuide.tsx";
const { ConsoleDshExport } = await import(componentPath);
function renderGuide(items: unknown[] | null, open = true) {
  function SeededGuide() {
    const dispatcher = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current;
    const original = dispatcher.useState;
    dispatcher.useState = () => original(open);
    try { return ConsoleDshExport({ models: items === null ? null : { items } }); } finally { dispatcher.useState = original; }
  }
  return renderToStaticMarkup(React.createElement(SeededGuide));
}
function decode(text: string) { return text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&"); }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("console DSH profile (SSR, not browser E2E)", () => {
  it("does not serialize profiles while closed", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    renderGuide([metadata()], false);
    expect(stringify).not.toHaveBeenCalled();
  });
  it("exports only supplied authorized items, reports skips and documents discovery limitations", () => {
    const html = decode(renderGuide([metadata({ slug: undefined, model_name: "authorized-group", id: "internal-db-id" }), metadata({ slug: undefined, model_name: "anthropic-only", chat_endpoint: "/v1/messages" })]));
    expect(html).toContain('"id": "authorized-group"');
    expect(html).not.toContain("internal-db-id");
    expect(html).toContain("已跳过 anthropic-only");
    expect(html).toContain("contextWindow/maxTokens");
    expect(html).toContain("不读取 reasoning/input");
    expect(html).toContain("llm-pi-ai");
    expect(html).toContain("不是普通 Pi models.json");
    expect(html).toContain("不会设置默认推理等级");
  });
  it("reports missing list instead of exporting marketplace offers", () => {
    expect(renderGuide(null)).toContain("模型列表加载失败");
    const page = readFileSync(new URL("../../web/src/pages/ConsolePage.tsx", import.meta.url), "utf8");
    expect(page).toContain("<ConsoleGuide models={modelsQuery.data}");
    expect(page).toContain('fetcher("/console/models")');
    expect(page).not.toContain("<ConsoleGuide models={marketplaceQuery.data}");
  });
});
const adminFixture = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("../../web/src/hooks/useQuery", () => ({
  useQuery: () => ({ data: { items: adminFixture.items, providers: [] }, loading: false, error: null, refresh: vi.fn() }),
  invalidateCache: vi.fn(),
}));
vi.mock("../../web/src/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
const adminPath = "../../web/src/pages/ModelsPage.tsx";
const { default: ModelsPage } = await import(adminPath);
function renderAdmin(format: string, catalog: string | { models: ModelConfigMetadata[] }, open = true) {
  vi.stubGlobal("window", { location: { origin: "https://gateway.test" } });
  let index = 0;
  function SeededAdmin() {
    const dispatcher = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current;
    const original = dispatcher.useState;
    dispatcher.useState = (initial: unknown) => {
      const current = index++;
      return original(current === 8 ? open : current === 9 ? format : current === 20 ? catalog : initial);
    };
    try { return ModelsPage(); } finally { dispatcher.useState = original; }
  }
  return renderToStaticMarkup(React.createElement(SeededAdmin));
}
function adminPreview(html: string) { return decode(html.match(/<pre[^>]*>(.*?)<[/]pre>/s)?.[1] ?? ""); }
describe("admin authoritative capability export (SSR, not browser E2E)", () => {
  it.each(["dsh", "pi", "catalog"])("does not serialize an already-loaded %s export while closed", (format) => {
    const stringify = vi.spyOn(JSON, "stringify");
    renderAdmin(format, { models: [metadata()] }, false);
    expect(stringify).not.toHaveBeenCalled();
  });
  it("lazily serializes the actual server object when catalog is selected", () => {
    const html = renderAdmin("catalog", { models: [metadata({ slug: "server-only" })] });
    expect(JSON.parse(adminPreview(html)).models[0].slug).toBe("server-only");
  });
  it.each(["dsh", "pi"])("uses server group metadata only for %s, not raw config or local inference", (format) => {
    adminFixture.items = [{ id: "internal", model_name: "local-vision-thinking", enabled: true,
      provider_id: "private-provider", config_json: '{"context_window":999999,"max_output_tokens":12345,"api_key":"local-secret"}' }];
    const catalog = JSON.stringify({ models: [metadata({ slug: "server-group", is_group: true, context_window: 64000, max_output_tokens: 4000 })] });
    const stringify = vi.spyOn(JSON, "stringify");
    const text = adminPreview(renderAdmin(format, catalog));
    expect(stringify).toHaveBeenCalledTimes(1);
    expect(text).toContain('"id": "server-group"');
    expect(text).toContain('"maxTokens": 4000');
    expect(text).not.toMatch(/local-vision|999999|12345|local-secret|private-provider/);
    expect(text).toContain(format === "dsh" ? '"reasoningEfforts"' : '"reasoning": true');
  });
  it.each(["dsh", "pi", "catalog"])("does not generate %s without authoritative catalog", (format) => {
    const html = renderAdmin(format, "");
    expect(adminPreview(html)).toBe("");
    expect(html).toContain("服务端权威目录尚未加载");
    expect(html).not.toContain("复制内容");
  });
  it("reports incomplete metadata with empty providers instead of default maxTokens", () => {
    const html = renderAdmin("dsh", JSON.stringify({ models: [metadata({ max_output_tokens: null })] }));
    expect(JSON.parse(adminPreview(html))).toEqual({ providers: {} });
    expect(html).toContain("已跳过 public");
    expect(html).toContain("请先配置真实");
  });
});
