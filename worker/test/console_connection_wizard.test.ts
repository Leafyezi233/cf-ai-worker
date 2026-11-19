import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
type ConsoleProtocolCapabilities = { supported_endpoints: string[] };
type ConsoleModels = { items: Metadata[]; model_scope: string; model_count: number };
import type { ModelConfigMetadata } from "../../web/src/utils/modelConfigExport";

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const guidePath = "../../web/src/components/ConsoleGuide.tsx";
const { ConsoleGuide, ConsoleConnectionWizard, connectionProtocol, connectionModels, connectionConfig } = await import(guidePath);
type Metadata = ModelConfigMetadata & { protocol_capabilities?: ConsoleProtocolCapabilities };
const chat = "/v1/chat/completions", responses = "/v1/responses", messages = "/v1/messages";
function model(extra: Partial<Metadata> = {}): Metadata {
  return { model_name: "allowed", alias: null, display_name: "授权模型", model_type: "text", billing_unit: "token",
    chat_endpoint: chat, context_window: 64000, max_output_tokens: 4096,
    context_window_source: "config", max_output_tokens_source: "config", input_modalities: ["text"], ...extra };
}
function snapshot(items: Metadata[]): ConsoleModels {
  return { items, model_scope: "list", model_count: items.length } as ConsoleModels;
}
function render(models: ConsoleModels | null | undefined, props = {}) {
  return renderToStaticMarkup(React.createElement(ConsoleGuide, { models, ...props }));
}
function wizard(items: Metadata[], client: string, protocol = chat, selected = "") {
  function SeededWizard() {
    const dispatcher = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current;
    const original = dispatcher.useState;
    const values = [client, protocol, selected];
    let index = 0;
    dispatcher.useState = () => original(values[index++]);
    try { return ConsoleConnectionWizard({ models: snapshot(items) }); } finally { dispatcher.useState = original; }
  }
  return renderToStaticMarkup(React.createElement(SeededWizard));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("connection wizard pure helpers", () => {
  it("normalizes client protocols without carrying an incompatible previous choice", () => {
    expect(connectionProtocol("anthropic", responses)).toBe(messages);
    expect(connectionProtocol("dsh", responses)).toBe(chat);
    expect(connectionProtocol("openai", messages)).toBe(chat);
    expect(connectionProtocol("openai", responses)).toBe(responses);
  });
  it("uses declared public endpoint capabilities, with only legacy endpoint fallback", () => {
    const items = [model(), model({ model_name: "multi", protocol_capabilities: { supported_endpoints: [chat, responses] } }),
      model({ model_name: "anthropic", chat_endpoint: messages }), model({ model_name: "disabled", protocol_capabilities: { supported_endpoints: [] } })];
    expect(connectionModels(items, "openai", responses).map((m: { id: string }) => m.id)).toEqual(["multi"]);
    expect(connectionModels(items, "anthropic", chat).map((m: { id: string }) => m.id)).toEqual(["anthropic"]);
    expect(connectionModels(items, "openai", chat).map((m: { id: string }) => m.id)).toEqual(["allowed", "multi"]);
    expect(connectionModels([model({ chat_endpoint: undefined })], "openai", chat)).toHaveLength(1);
  });
  it("excludes media, missing text input and incompatible duplicate routes in either order", () => {
    const items = [model({ model_name: "image", model_type: "image" }), model({ model_name: "vector", model_type: "embedding" }),
      model({ model_name: "video", model_type: "video", chat_endpoint: "/v1/videos" }),
      model({ model_name: "call", model_type: undefined, billing_unit: "call" }), model({ model_name: "audio", input_modalities: ["audio"] })];
    expect(connectionModels(items, "openai", chat)).toEqual([]);
    const bad = model({ chat_endpoint: messages });
    for (const duplicates of [[model(), bad], [bad, model()]]) expect(connectionModels(duplicates, "openai", chat)).toEqual([]);
  });
  it("retains DSH strict capability requirements and does not fabricate output budgets", () => {
    const items = [model(), model({ model_name: "unknown-output", max_output_tokens: undefined }), model({ model_name: "messages", chat_endpoint: messages })];
    expect(connectionModels(items, "dsh", chat)).toEqual([{ id: "allowed", label: "授权模型" }]);
    expect(connectionConfig([items[1]], "dsh", chat, "unknown-output")).toBeNull();
  });
  it("projects only public call IDs and fixed official URLs, never internals or stale selections", () => {
    const item = { ...model({ alias: "public-alias" }), id: "private-db", provider_api_key: "secret-marker", provider_url: "https://private.invalid" };
    const config = connectionConfig([item], "openai", chat, "revoked-selection");
    expect(config).toEqual({ baseURL: "http://127.0.0.1:8787/v1", endpoint: "http://127.0.0.1:8787/v1/chat/completions", apiKey: "$CPG_API_KEY", model: "public-alias" });
    expect(JSON.stringify(config)).not.toMatch(/secret-marker|private-db|private.invalid|revoked-selection/);
    expect(connectionConfig([], "openai", chat, "old")).toBeNull();
    expect(connectionConfig([model({ model_name: "", alias: null })], "openai", chat, "old")).toBeNull();
    expect(connectionConfig([model({ chat_endpoint: messages })], "anthropic", chat, "allowed")?.baseURL).toBe("http://127.0.0.1:8787");
  });
  it("does not alter supplied metadata or infer compatibility from a familiar name", () => {
    const items = [model({ model_name: "claude-thinking-responses", chat_endpoint: chat })];
    const before = JSON.stringify(items);
    expect(connectionModels(items, "anthropic", messages)).toEqual([]);
    expect(connectionModels(items, "openai", responses)).toEqual([]);
    expect(JSON.stringify(items)).toBe(before);
  });
});

describe("connection wizard SSR (not browser E2E)", () => {
  it("renders ordered accessible steps and supports old props without network or token reads", () => {
    const fetcher = vi.fn(() => { throw Error("unexpected network"); });
    const readToken = vi.fn(() => { throw Error("unexpected credential read"); });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("sessionStorage", { getItem: readToken });
    vi.stubGlobal("localStorage", { getItem: readToken });
    const html = render(snapshot([model()]));
    const steps = ["准备 API 密钥", "选择你的客户端", "选择模型", "填入配置并运行"].map(label => html.indexOf(label));
    expect(steps.every(index => index >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(html.indexOf("准备 API 密钥")).toBeLessThan(html.indexOf("更多接口与参考"));
    for (const label of ["接入客户端", "接入协议", "兼容模型"]) expect(html).toContain('aria-label="' + label + '"');
    expect(html).toContain("$CPG_API_KEY");
    expect(html).toContain("Token 管理创建子 Token");
    expect(html).toContain("DeepSeek Harness"); expect(html).not.toContain("DSH profile JSON"); expect(html).toContain("/v1/embeddings"); expect(html).toContain("/v1/videos");
    expect(fetcher).not.toHaveBeenCalled(); expect(readToken).not.toHaveBeenCalled();
  });
  it.each([null, undefined])("blocks configuration when the authorized snapshot is missing (%s)", (value) => {
    const html = render(value);
    expect(html).toContain("模型列表加载失败"); expect(html).not.toContain('aria-label="示例代码"');
  });
  it("distinguishes an empty compatible set from unloaded data and never offers fake wizard models", () => {
    const html = render(snapshot([model({ model_type: "embedding", chat_endpoint: "/v1/embeddings" })]));
    expect(html).toContain("没有支持此客户端 / 协议的文本模型");
    expect(html).not.toContain('aria-label="示例代码"');
  });
  it("offers an optional local key-management callback without invoking it during SSR", () => {
    const onOpenKeys = vi.fn(), onOpenModels = vi.fn();
    const html = render(snapshot([model()]), { onOpenKeys, onOpenModels });
    expect(html).toContain("创建子 Token →"); expect(onOpenKeys).not.toHaveBeenCalled(); expect(onOpenModels).not.toHaveBeenCalled();
  });
  it("renders Responses, Messages and DSH selected states with protocol-specific guidance", () => {
    expect(wizard([model({ protocol_capabilities: { supported_endpoints: [responses] } })], "openai", responses)).toMatch(/role="radio" aria-checked="true"[^>]*><span[^>]*>Responses</);
    const anthropic = wizard([model({ chat_endpoint: messages })], "anthropic");
    expect(anthropic).toMatch(/role="radio" aria-checked="true"[^>]*><span[^>]*>Anthropic</); expect(anthropic).not.toContain('aria-label="接入协议"'); expect(anthropic).toContain("max_tokens");
    const dsh = wizard([model()], "dsh");
    expect(dsh).toContain("真实上下文与输出上限");
    expect(wizard([model({ max_output_tokens: undefined })], "dsh")).not.toContain('aria-label="示例代码"');
  });
});

describe("connection wizard runnable snippets", () => {
  it("generates protocol-specific examples for the selected model that read the key from the environment", async () => {
    const { connectionSnippets } = await import(guidePath);
    const chatConfig = connectionConfig([model({ alias: "public-alias" })], "openai", chat, "");
    const chatSnippets = connectionSnippets(chatConfig, chat);
    expect(chatSnippets.curl).toContain("http://127.0.0.1:8787/v1/chat/completions");
    expect(chatSnippets.curl).toContain('"model": "public-alias"');
    expect(chatSnippets.python).toContain("chat.completions.create");
    expect(chatSnippets.env).toContain("OPENAI_BASE_URL");
    const responsesConfig = connectionConfig([model({ protocol_capabilities: { supported_endpoints: [responses] } })], "openai", responses, "");
    expect(connectionSnippets(responsesConfig, responses).node).toContain("responses.create");
    const messagesConfig = connectionConfig([model({ chat_endpoint: messages })], "anthropic", messages, "");
    const messagesSnippets = connectionSnippets(messagesConfig, messages);
    expect(messagesSnippets.curl).toContain('"max_tokens": 1024');
    expect(messagesSnippets.python).toContain('base_url="http://127.0.0.1:8787"');
    expect(messagesSnippets.env).toContain("ANTHROPIC_BASE_URL");
    for (const snippets of [chatSnippets, messagesSnippets]) for (const code of Object.values(snippets)) {
      expect(code).not.toMatch(/ccs_[A-Za-z0-9]/);
      expect(code).toMatch(/CPG_API_KEY/);
    }
  });
  it("uses the page origin as gateway base in a browser and the local default elsewhere", async () => {
    const { gatewayBase } = await import(guidePath);
    expect(gatewayBase()).toBe("http://127.0.0.1:8787");
    vi.stubGlobal("window", { location: { origin: "https://gw.example.test" } });
    expect(gatewayBase()).toBe("https://gw.example.test");
    expect(connectionConfig([model()], "openai", chat, "")?.baseURL).toBe("https://gw.example.test/v1");
    vi.stubGlobal("window", { location: { origin: "null" } });
    expect(gatewayBase()).toBe("http://127.0.0.1:8787");
  });
});
