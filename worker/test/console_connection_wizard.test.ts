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
    expect(html.indexOf("1 · 选择客户端与协议")).toBeLessThan(html.indexOf("2 · 选择兼容模型"));
    expect(html.indexOf("2 · 选择兼容模型")).toBeLessThan(html.indexOf("3 · 复制占位密钥配置"));
    for (const label of ["接入客户端", "接入协议", "兼容模型"]) expect(html).toContain('aria-label="' + label + '"');
    expect(html).toContain("$CPG_API_KEY"); expect(html).toContain("不会传给第三方配置服务");
    expect(html).toContain("不会自动展开占位符"); expect(html).toContain("Token 管理创建子 Token");
    expect(html).toContain("生成 DSH 配置 JSON"); expect(html).toContain("/v1/embeddings"); expect(html).toContain("/v1/videos");
    expect(fetcher).not.toHaveBeenCalled(); expect(readToken).not.toHaveBeenCalled();
  });
  it.each([null, undefined])("blocks configuration when the authorized snapshot is missing (%s)", (value) => {
    const html = render(value);
    expect(html).toContain("暂不生成配置"); expect(html).not.toContain("客户端字段清单 · 占位密钥");
  });
  it("distinguishes an empty compatible set from unloaded data and never offers fake wizard models", () => {
    const html = render(snapshot([model({ model_type: "embedding", chat_endpoint: "/v1/embeddings" })]));
    expect(html).toContain("当前权限下没有兼容此客户端 / 协议的文本模型");
    expect(html).not.toContain("客户端字段清单 · 占位密钥");
  });
  it("offers an optional local key-management callback without invoking it during SSR", () => {
    const onOpenKeys = vi.fn(), onOpenModels = vi.fn();
    const html = render(snapshot([model()]), { onOpenKeys, onOpenModels });
    expect(html).toContain("创建子 Token →"); expect(onOpenKeys).not.toHaveBeenCalled(); expect(onOpenModels).not.toHaveBeenCalled();
  });
  it("renders Responses, Messages and DSH selected states with protocol-specific guidance", () => {
    expect(wizard([model({ protocol_capabilities: { supported_endpoints: [responses] } })], "openai", responses)).toContain('value="/v1/responses" selected=""');
    const anthropic = wizard([model({ chat_endpoint: messages })], "anthropic");
    expect(anthropic).toContain('value="/v1/messages" selected=""'); expect(anthropic).toContain("max_tokens");
    const dsh = wizard([model()], "dsh");
    expect(dsh).toContain("字段清单不能代替 DSH profile"); expect(dsh).toContain("真实上下文与输出上限");
    expect(wizard([model({ max_output_tokens: undefined })], "dsh")).not.toContain("客户端字段清单 · 占位密钥");
  });
});
