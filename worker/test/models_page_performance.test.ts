import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
vi.doMock((requireWeb as any).resolve("react-router-dom"), () => ({
  useLocation: () => ({ pathname: "/admin/models", search: "", hash: "" }),
  useNavigate: () => vi.fn(),
}));
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const fixture = vi.hoisted(() => ({ items: [] as any[] }));
vi.mock("../../web/src/hooks/useQuery", () => ({
  useQuery: () => ({ data: { items: fixture.items, providers: [] }, loading: false, error: null, refresh: vi.fn() }),
  invalidateCache: vi.fn(),
}));
vi.mock("../../web/src/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
const componentPath = "../../web/src/pages/ModelsPage.tsx";
const { default: ModelsPage } = await import(componentPath);

function model(id: string, extra: Record<string, unknown> = {}) {
  return { id, model_name: id, enabled: true, provider_id: "p", provider_name: "Provider", config_json: "{}", ...extra };
}
function render(format?: string, serverCatalog = "") {
  vi.stubGlobal("window", { location: { origin: "https://gateway.test" } });
  let stateIndex = 0;
  function SeededPage() {
    const dispatcher = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current;
    const original = dispatcher.useState;
    dispatcher.useState = (initial: unknown) => {
      const index = stateIndex++;
      return original(index === 8 ? Boolean(format) : index === 9 ? (format || "catalog") : index === 20 ? serverCatalog : initial);
    };
    try { return ModelsPage(); } finally { dispatcher.useState = original; }
  }
  return renderToStaticMarkup(React.createElement(SeededPage));
}
function preview(html: string) {
  return (html.match(new RegExp("<pre[^>]*>(.*?)</pre>", "s"))?.[1] || "")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("models page export work (SSR, not browser profiling)", () => {
  it("does not serialize exports while closed and parses each config once", () => {
    fixture.items = [model("first", { fallback_model_id: "target", config_json: '{"description":"first"}' }), model("target", { alias: "fallback-alias", config_json: '{"description":"target"}' })];
    const parse = vi.spyOn(JSON, "parse");
    const stringify = vi.spyOn(JSON, "stringify");
    const html = render();
    for (const item of fixture.items) {
      expect(parse.mock.calls.filter(([value]) => value === item.config_json)).toHaveLength(1);
    }
    expect(stringify).not.toHaveBeenCalled();
    expect(html).toContain("fallback-alias");
    expect(html).not.toContain("<pre");
  });
  it("renders a hidden-name badge from the same parsed config without extra parse or export work", () => {
    fixture.items = [model("hidden", { config_json: '{"catalog_visible":false,"description":"hidden"}' })];
    const parse = vi.spyOn(JSON, "parse");
    const stringify = vi.spyOn(JSON, "stringify");
    const html = render();
    expect(html).toContain("列表隐藏");
    expect(parse.mock.calls.filter(([value]) => value === fixture.items[0].config_json)).toHaveLength(1);
    expect(stringify).not.toHaveBeenCalled();
  });
  it.each(["catalog", "pi", "continue", "toml", "list"])("preserves %s output and derives only that format", (format) => {
    fixture.items = [model("gemini-2.5", { alias: "client", display_name: "Display", config_json: '{"context_window":42,"description":"custom","supports_parallel_tool_calls":true}' }), model("disabled", { enabled: false })];
    const stringify = vi.spyOn(JSON, "stringify");
    const text = preview(render(format));
    expect(stringify).toHaveBeenCalledTimes(format === "continue" ? 1 : 0);
    expect(text).not.toContain("disabled");
    if (format === "catalog" || format === "pi") expect(text).toBe("");
    if (format === "continue") expect(JSON.parse(text)).toEqual({ models: [{ title: "Display", provider: "openai", model: "client", apiBase: "https://gateway.test/v1", apiKey: "YOUR_DEVICE_TOKEN" }] });
    if (format === "list") expect(text).toBe("client");
    if (format === "toml") expect(text).toBe('# ~/.codex/config.toml\nmodel = "client"\nmodel_provider = "personal-ai-gateway"\nmodel_catalog_json = "~/.codex/model-catalog.json"\n\n[model_providers.personal-ai-gateway]\nname = "Personal AI Gateway"\nbase_url = "https://gateway.test/v1"\napi_key = "YOUR_DEVICE_TOKEN"\nwire_specification = "openai"\n');
  });
  it("uses the server catalog without deriving a local catalog", () => {
    fixture.items = [model("bad-config", { config_json: "{" })];
    const stringify = vi.spyOn(JSON, "stringify");
    expect(preview(render("catalog", '{"models":[{"slug":"server"}]}'))).toBe('{"models":[{"slug":"server"}]}');
    expect(stringify).not.toHaveBeenCalled();
  });
});
