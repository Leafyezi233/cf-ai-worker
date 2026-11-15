import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireWeb = createRequire(new URL("../package.json", import.meta.url));
const requireVite = createRequire(requireWeb.resolve("vite"));
const { buildSync } = requireVite("esbuild");
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
function load(relative) {
  const result = buildSync({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, write: false,
    platform: "node", format: "cjs", jsx: "automatic", packages: "external", logLevel: "silent" });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(requireWeb, module, module.exports);
  return module.exports;
}
const controls = load("../src/components/ProtocolConnectionsControls.tsx");
const { ProtocolCapabilityControls, serialize: serializeModel } = load("../src/pages/ModelsPage.tsx");
const { serialize: serializeProvider } = load("../src/pages/ProvidersPage.tsx");
const { setExplicitConnections, updateProtocolConnection, validateProviderProtocolConnections, providerConnectionState,
  connectionUrlPreview, updateModelProtocolValue, validateModelProtocolDeclarations, ProtocolConnectionsControls } = controls;
function findControl(tree, label) {
  if (!React.isValidElement(tree)) return undefined;
  if (tree.props["aria-label"] === label) return tree;
  for (const child of React.Children.toArray(tree.props.children)) {
    const match = findControl(child, label); if (match) return match;
  }
}
const providerProps = json => ({ configJson: json, providerType: "openai", endpoint: "https://gateway.example/prefix/v1", onChange() {}, onError(message) { throw new Error(message); } });
const provider = json => ({ id: "p", type: "openai", config_json: json });
const modelProps = json => ({ configJson: json, modelName: "fallback-model", provider: provider('{"protocol_connections":{"messages":{}}}'), onChange() {}, onError() { throw new Error("invalid JSON"); } });
const modelDraft = config_json => ({ provider_id: "p", model_name: "fallback-model", display_name: "", description: "", alias: "", fallback_model_id: "",
  input_price_per_m: "", output_price_per_m: "", cache_read_price_per_m: "", cache_write_price_per_m: "", billing_unit: "token", price_per_call: "",
  search_price_per_call: "", pricing_mode: "auto", cache_enabled: false, cache_ttl: "3600", model_public: false, enabled: true,
  capabilities: [], routing_strategy: "priority", weight: 10, system_prompt: "", system_prompt_mode: "prepend", max_tokens_limit: "", model_rewrite: "", supports_search_tool: false, config_json });

test("viewing and untouched saves never create protocol configuration", () => {
  for (const json of ["", "{}", '{ "custom": { "keep": true } }']) {
    let changes = 0;
    renderToStaticMarkup(React.createElement(ProtocolConnectionsControls, { ...providerProps(json), onChange() { changes++; } }));
    renderToStaticMarkup(React.createElement(ProtocolCapabilityControls, { ...modelProps(json), onChange() { changes++; } }));
    assert.equal(changes, 0);
    const saved = serializeProvider({ name: "test", type: "openai", endpoint: "", api_key: "", secret_name: "", enabled: true, config_json: json });
    assert.equal(saved.config_json, json.trim() || null);
    assert.equal(JSON.parse(serializeModel(modelDraft(json)).config_json || "{}").protocol_capabilities, undefined);
    assert.equal(JSON.parse(serializeModel(modelDraft(json)).config_json || "{}").protocol_models, undefined);
  }
});

test("explicit opt-in is an authoritative allowlist and removable without losing unrelated JSON", () => {
  const legacy = '{"custom":{"keep":true},"responses_mode":"native"}';
  let json = setExplicitConnections(legacy, true);
  assert.deepEqual(JSON.parse(json).protocol_connections, {});
  for (const key of ["chat_completions", "responses", "messages"]) assert.equal(providerConnectionState(json, key), "disabled");
  json = updateProtocolConnection(json, "messages", "enabled", true);
  assert.equal(providerConnectionState(json, "messages"), "enabled");
  assert.equal(providerConnectionState(json, "responses"), "disabled");
  json = updateProtocolConnection(json, "messages", "base_url", "https://anthropic.example/api/v1");
  json = updateProtocolConnection(json, "messages", "anthropic-beta", "test-beta");
  json = updateProtocolConnection(json, "messages", "secret_name", "MESSAGES_API_KEY");
  json = updateProtocolConnection(json, "messages", "enabled", false);
  assert.equal(providerConnectionState(json, "messages"), "disabled");
  assert.equal(JSON.parse(json).protocol_connections.messages.secret_name, "MESSAGES_API_KEY");
  validateProviderProtocolConnections(json);
  assert.deepEqual(JSON.parse(setExplicitConnections(json, false)), JSON.parse(legacy));
  assert.equal(providerConnectionState('{"protocol_connections":{"messages":{}}}', "messages"), "enabled");
});

test("connection controls edit only the selected fields and expose safe defaults", () => {
  let changed;
  const tree = ProtocolConnectionsControls({ ...providerProps('{"custom":7}'), onChange(value) { changed = value; } });
  findControl(tree, "启用显式协议连接").props.onChange({ target: { checked: true } });
  let enabled = ProtocolConnectionsControls({ ...providerProps(changed), onChange(value) { changed = value; } });
  findControl(enabled, "启用 Messages").props.onChange({ target: { checked: true } });
  enabled = ProtocolConnectionsControls({ ...providerProps(changed), onChange(value) { changed = value; } });
  findControl(enabled, "Messages Secret 环境变量名").props.onChange({ target: { value: "CUSTOM_SECRET" } });
  assert.deepEqual(JSON.parse(changed), { custom: 7, protocol_connections: { messages: { enabled: true, secret_name: "CUSTOM_SECRET" } } });
  const html = renderToStaticMarkup(React.createElement(ProtocolConnectionsControls, providerProps(changed)));
  assert.match(html, /x-api-key/); assert.match(html, /2023-06-01/);
  assert.match(html, /anthropic-beta/); assert.match(html, /anthropic-version/);
  assert.ok(html.includes("https://gateway.example/prefix/v1/messages"));
});

test("URL previews append rather than replace the base prefix and respect legacy defaults", () => {
  assert.equal(connectionUrlPreview("openai", "https://upstream.example/api/v1///", "chat_completions", {}), "https://upstream.example/api/v1/chat/completions");
  assert.equal(connectionUrlPreview("anthropic", "", "messages", {}), "https://api.anthropic.com/v1/messages");
  assert.equal(connectionUrlPreview("gemini", "", "chat_completions", {}), "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(connectionUrlPreview("openai", "https://ignored.example", "responses", { base_url: "http://localhost:9999/proxy", path: "/custom/responses" }), "http://localhost:9999/proxy/custom/responses");
});

test("connection validation rejects unsafe paths, raw keys, arbitrary headers, malformed types and secret values", () => {
  const invalid = [null, [], { enabled: "true" }, { base_url: "/relative" }, { base_url: "ftp://example.test" },
    ...["relative", "//other.example", "/../messages", "/./messages", "/%2e%2e/messages", "/x/%2e%2e/messages", "/messages?key=secret", "/messages#hash", "/x\\..\\messages"].map(path => ({ path })),
    { auth: "basic" }, { auth: ["bearer"] }, { secret_name: "ADMIN_SECRET" }, { secret_name: "cf_access_client_secret" }, { secret_name: "A".repeat(101) }, { secret_name: "sk-secret-value" },
    { base_url: "https://user:pass@example.test/v1" }, { base_url: "https://example.test/v1?key=secret" }, { base_url: "https://example.test/v1#hash" }, { path: "/messages%00" }, { secret_name: "NAME,OTHER" }, { secret_name: "7NAME" },
    { api_key: "raw-secret" }, { headers: { Authorization: "Bearer raw-secret" } }, { headers: { "x-api-key": "raw-secret" } },
    { headers: { "anthropic-beta": "beta\r\nunsafe" } }, { headers: null }, { version: 123 }];
  for (const connection of invalid) assert.throws(() => validateProviderProtocolConnections(JSON.stringify({ protocol_connections: { messages: connection } })), JSON.stringify(connection));
  for (const json of ["[]", "null", "{", '{"protocol_connections":null}', '{"protocol_connections":{"unknown":{}}}']) assert.throws(() => validateProviderProtocolConnections(json));
  validateProviderProtocolConnections('{"custom":true,"protocol_connections":{"messages":{"base_url":"https://example.test/v1","path":"/messages","auth":"x-api-key","secret_name":"_VALID_2","version":"2023-06-01","headers":{"anthropic-beta":"beta","anthropic-version":"2023-06-01"}}}}');
});

test("invalid JSON is never silently discarded by an editor action", () => {
  for (const json of ["{", "null", "[]", '{"protocol_connections":false}']) {
    assert.throws(() => updateProtocolConnection(json, "messages", "enabled", true));
  }
  assert.throws(() => updateModelProtocolValue('{"protocol_models":null}', "protocol_models", "messages", "claude"));
  assert.throws(() => updateModelProtocolValue('{"protocol_capabilities":[]}', "protocol_capabilities", "messages", "true"));
});

test("per-protocol model IDs and Messages capabilities round-trip with existing routes/loss/unrelated config", () => {
  const original = { custom: { keep: true }, responses_mode: "native", protocol_capabilities: { responses: true, chat_route: "responses", responses_route: "native", loss_policy: "strict" } };
  let json = JSON.stringify(original);
  json = updateModelProtocolValue(json, "protocol_capabilities", "messages", "true");
  for (const [key, id] of [["chat_completions", "chat-model"], ["responses", "response-model"], ["messages", "message-model"]]) json = updateModelProtocolValue(json, "protocol_models", key, id);
  validateModelProtocolDeclarations(json);
  assert.deepEqual(JSON.parse(serializeModel(modelDraft(json)).config_json), { ...original, protocol_capabilities: { ...original.protocol_capabilities, messages: true }, protocol_models: { chat_completions: "chat-model", responses: "response-model", messages: "message-model" } });
  json = updateModelProtocolValue(json, "protocol_capabilities", "messages", "");
  assert.deepEqual(JSON.parse(json).protocol_capabilities, original.protocol_capabilities);
  for (const key of ["chat_completions", "responses", "messages"]) json = updateModelProtocolValue(json, "protocol_models", key, "");
  assert.deepEqual(JSON.parse(json), original);
  for (const bad of [{ protocol_models: [] }, { protocol_models: { messages: true } }, { protocol_models: { other: "model" } }, { protocol_capabilities: { messages: "true" } }]) assert.throws(() => validateModelProtocolDeclarations(JSON.stringify(bad)));
});

test("model controls block native selection for missing or disabled provider connections, preserve old declarations", () => {
  for (const connections of [{}, { messages: { enabled: false } }]) {
    const json = JSON.stringify({ custom: true, protocol_capabilities: { messages: true } });
    let changes = 0;
    const props = { ...modelProps(json), provider: provider(JSON.stringify({ protocol_connections: connections })), onChange() { changes++; } };
    const tree = ProtocolCapabilityControls(props);
    const selector = findControl(tree, "上游 Messages");
    const native = React.Children.toArray(selector.props.children).find(child => child.props.value === "true");
    assert.equal(native.props.disabled, true); assert.equal(selector.props.value, "true"); assert.equal(changes, 0);
    const html = renderToStaticMarkup(React.createElement(ProtocolCapabilityControls, props));
    assert.match(html, /即使已有模型声明 true 也不会生效/); assert.ok(html.includes("无 Chat / Responses 桥接"));
  }
  const tree = ProtocolCapabilityControls(modelProps("{}"));
  const selector = findControl(tree, "上游 Messages");
  assert.equal(React.Children.toArray(selector.props.children).find(child => child.props.value === "true").props.disabled, false);
  for (const label of ["Chat 入站路由", "Responses 入站路由", "转换损失策略"]) assert.ok(findControl(tree, label));
});
