import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const requireWeb = createRequire(new URL("../package.json", import.meta.url));
const requireVite = createRequire(requireWeb.resolve("vite"));
const { buildSync, transformSync } = requireVite("esbuild");
const ts = requireWeb("typescript");
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
function load(relative) {
  const result = buildSync({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, write: false,
    platform: "node", format: "cjs", jsx: "automatic", packages: "external", logLevel: "silent" });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(requireWeb, module, module.exports);
  return module.exports;
}
const { ModelCatalogVisibility, ModelCatalogVisibilityBadge, readCatalogVisibility, setCatalogVisible } = load("../src/components/ModelCatalogVisibility.tsx");
const { serialize } = load("../src/pages/ModelsPage.tsx");
const modelType = load("../src/utils/modelType.ts");
function findElement(tree, predicate) {
  if (!React.isValidElement(tree)) return undefined;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props.children)) {
    const found = findElement(child, predicate); if (found) return found;
  }
}
const checkbox = tree => findElement(tree, element => element.props["aria-label"] === "在用户模型列表中显示");
const original = { custom: { keep: [1, "two", false] }, responses_mode: "native",
  protocol_models: { messages: "upstream-claude", responses: "upstream-response" },
  protocol_capabilities: { messages: true, loss_policy: "strict" },
  protocol_connections: { messages: { secret_name: "MESSAGES_KEY", enabled: true } } };
const modelDraft = config_json => ({ provider_id: "p", model_name: "raw-model", display_name: "Display", description: "", alias: "raw-alias", fallback_model_id: "",
  input_price_per_m: "1", output_price_per_m: "2", cache_read_price_per_m: "", cache_write_price_per_m: "", billing_unit: "token", price_per_call: "",
  search_price_per_call: "", pricing_mode: "priced", cache_enabled: false, cache_ttl: "3600", model_public: true, enabled: true,
  capabilities: [], routing_strategy: "priority", weight: 10, system_prompt: "", system_prompt_mode: "prepend", max_tokens_limit: "", model_rewrite: "", supports_search_tool: false, config_json });

function pageAst(name) {
  const source = readFileSync(new URL("../src/pages/" + name, import.meta.url), "utf8");
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function findNode(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, node => findNode(node, predicate));
}
function visibilityHandler(name, initial) {
  const ast = pageAst(name);
  const component = findNode(ast, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "ModelCatalogVisibility");
  assert.ok(component, name + " must integrate the control");
  const change = component.attributes.properties.find(node => node.name?.getText(ast) === "onChange");
  const callback = change.initializer.expression.getText(ast);
  let state = initial;
  const update = next => { assert.equal(typeof next, "function", "derive from latest state, not captured JSON"); state = next(state); };
  const expression = transformSync("(" + callback + ")", { loader: "tsx" }).code;
  const handler = new Function("setForm", "setDraft", "setCatalogVisible", "return " + expression)(update, update, setCatalogVisible);
  return { handler, state: () => state };
}

async function saveGroup(config_json) {
  const ast = pageAst("ModelGroupsPage.tsx");
  const submit = findNode(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === "onSaveGroup");
  const draft = { ...modelDraft(config_json), name: "raw-group", member_retries: "2", peak_pricing_enabled: false };
  let payload, error = "";
  const context = { draft, ...modelType, confirm: () => true, num: value => Number(value) || 0,
    setFormError: value => { error = value; }, setSaving() {}, editingId: "group-id",
    api: { async put(_url, value) { payload = value; } }, setFormOpen() {}, invalidateCache() {}, async refresh() {},
    toast: { success() {} }, ApiError: class extends Error {} };
  const body = "const { " + Object.keys(context).join(",") + " } = context; " + submit.getText(ast) + "; return onSaveGroup({preventDefault(){}});";
  const javascript = transformSync(body, { loader: "ts" }).code;
  await new Function("context", javascript)(context);
  return { payload, error };
}

test("absent defaults to visible; only boolean false hides", () => {
  for (const json of [undefined, null, "", "   ", "{}", '{"catalog_visible":true}', '{"catalog_visible":"false"}', '{"catalog_visible":0}', '{"catalog_visible":null}']) {
    assert.deepEqual(readCatalogVisibility(json), { visible: true, error: null });
  }
  assert.deepEqual(readCatalogVisibility('{"catalog_visible":false}'), { visible: false, error: null });
});

test("helper merges false and removes true/default without losing unrelated protocol JSON", () => {
  const hidden = setCatalogVisible(JSON.stringify(original), false);
  assert.deepEqual(JSON.parse(hidden), { ...original, catalog_visible: false });
  assert.deepEqual(JSON.parse(setCatalogVisible(hidden, true)), original);
  assert.equal(setCatalogVisible("", true), "");
  assert.equal(setCatalogVisible('{"catalog_visible":false}', true), "");
  assert.deepEqual(JSON.parse(setCatalogVisible("", false)), { catalog_visible: false });
  assert.deepEqual(JSON.parse(setCatalogVisible('{"__proto__":{"keep":true},"catalog_visible":false}', true)), JSON.parse('{"__proto__":{"keep":true}}'));
});

test("malformed/nonobject JSON reports visible error and helper refuses to clobber it", () => {
  for (const json of ["{", "null", "[]", "false", '"text"', "7"]) {
    assert.equal(readCatalogVisibility(json).visible, true);
    assert.match(readCatalogVisibility(json).error, /JSON 对象/);
    for (const visible of [false, true]) assert.throws(() => setCatalogVisible(json, visible), /JSON 对象/);
    let changes = 0;
    const tree = ModelCatalogVisibility({ configJson: json, onChange() { changes++; } });
    assert.equal(checkbox(tree).props.disabled, true);
    const html = renderToStaticMarkup(tree);
    assert.match(html, /role="alert"/);
    assert.match(html, /不会覆盖无效内容/);
    assert.equal(changes, 0);
  }
});

test("control derives each render from JSON and describes display-only canonical-mapping limits", () => {
  let selected;
  const props = { configJson: "", onChange(value) { selected = value; } };
  const tree = ModelCatalogVisibility(props);
  assert.equal(checkbox(tree).props.checked, true);
  assert.equal(selected, undefined, "viewing must not mutate the draft");
  checkbox(tree).props.onChange({ target: { checked: false } });
  assert.equal(selected, false);
  const hidden = ModelCatalogVisibility({ ...props, configJson: '{"catalog_visible":false}' });
  assert.equal(checkbox(hidden).props.checked, false);
  const shownAgain = ModelCatalogVisibility({ ...props, configJson: '{"catalog_visible":true}' });
  assert.equal(checkbox(shownAgain).props.checked, true);
  const html = renderToStaticMarkup(tree);
  for (const text of ["在用户模型列表中显示", "原始模型名", "原始别名", "原始模型组名", "不会禁用", "公开权限", "调用权限", "服务分组", "显式映射", "规范名", "默认显示"]) assert.ok(html.includes(text), text);
});

test("admin badge distinguishes hidden rows without hiding them", () => {
  const render = configJson => renderToStaticMarkup(React.createElement(ModelCatalogVisibilityBadge, { configJson }));
  assert.match(render('{"catalog_visible":false}'), /列表隐藏/);
  for (const json of [null, "", "{}", "{", '{"catalog_visible":true}']) assert.equal(render(json), "");
  assert.ok(pageAst("ModelsPage.tsx").text.includes("<ModelCatalogVisibilityBadge visible={customObj?.catalog_visible !== false} />"));
  assert.ok(pageAst("ModelGroupsPage.tsx").text.includes("<ModelCatalogVisibilityBadge configJson={g.config_json} />"));
  const precomputed = visible => renderToStaticMarkup(React.createElement(ModelCatalogVisibilityBadge, { configJson: "{", visible }));
  assert.match(precomputed(false), /列表隐藏/);
  assert.equal(precomputed(true), "");
});

test("both page callbacks merge into latest JSON and preserve enabled/public state", () => {
  for (const name of ["ModelsPage.tsx", "ModelGroupsPage.tsx"]) {
    const initial = { config_json: JSON.stringify({ ...original, latest_raw_edit: 42 }), enabled: true, model_public: true, unrelated_draft: "keep" };
    const editor = visibilityHandler(name, initial);
    editor.handler(false);
    assert.deepEqual(editor.state(), { ...initial, config_json: setCatalogVisible(initial.config_json, false) });
    editor.handler(true);
    assert.deepEqual(JSON.parse(editor.state().config_json), { ...original, latest_raw_edit: 42 });
    const malformed = { ...initial, config_json: "{" };
    const raced = visibilityHandler(name, malformed);
    raced.handler(false);
    assert.equal(raced.state(), malformed, "a queued invalid draft must survive an old checkbox event");
  }
});

test("model save honors current raw JSON, not an earlier checkbox value", () => {
  let draft = modelDraft(setCatalogVisible(JSON.stringify(original), false));
  let saved = serialize(draft);
  assert.deepEqual(JSON.parse(saved.config_json), { ...original, catalog_visible: false });
  assert.equal(saved.enabled, true); assert.equal(saved.model_public, true); assert.equal(saved.alias, "raw-alias");
  draft = { ...draft, config_json: JSON.stringify({ ...original, catalog_visible: true }) };
  saved = serialize(draft);
  assert.deepEqual(JSON.parse(saved.config_json), { ...original, catalog_visible: true });
  draft = { ...draft, config_json: JSON.stringify(original) };
  assert.deepEqual(JSON.parse(serialize(draft).config_json), original);
  assert.throws(() => serialize({ ...draft, config_json: "{" }));
});

test("group save preserves current catalog JSON and protocol fields while merging retries", async () => {
  for (const extra of [{ catalog_visible: false }, { catalog_visible: true }, {}]) {
    const config = { ...original, ...extra };
    const { payload, error } = await saveGroup(JSON.stringify(config));
    assert.equal(error, "");
    assert.deepEqual(JSON.parse(payload.config_json), { ...config, member_retries: 2 });
    assert.equal(payload.enabled, true); assert.equal(payload.model_public, true);
  }
  const invalid = await saveGroup("{");
  assert.equal(invalid.payload, undefined);
  assert.ok(invalid.error);
});
