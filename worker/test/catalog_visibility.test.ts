import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { CreateModelSchema, UpdateModelSchema, CreateModelGroupSchema, UpdateModelGroupSchema } from "../src/admin/schemas";
import { consoleApp } from "../src/console";
import { listModelProjectionsForDevice } from "../src/db/repo";
import { createServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import { DEFAULT_ROUTING_POLICY, putTokenRoutingPolicy } from "../src/db/token_policies";
import { resolveDevice } from "../src/gateway/auth";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { isRawCatalogVisible } from "../src/gateway/catalog_visibility";
import { gatewayApp } from "../src/gateway/index";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import type { AuthedDevice, Env, TokenRoutingPolicy } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { CollectingExecutionContext, DEVICE_ID, TOKEN, chatBody, holdRows, ledgerRows, makeEnv,
  openAiAnswer, seedDevice, seedDeviceGroups, seedDeviceModels, seedGroup, seedGroupMembers,
  seedModel, seedProvider, usageRows, wallet } from "./helpers/realGatewayEnv";

const app = new Hono<{ Bindings: Env }>().route("/v1", gatewayApp);
const authApp = new Hono<{ Bindings: Env }>();
authApp.get("/", async c => c.json(await resolveDevice(c)));
const hidden = JSON.stringify({ catalog_visible: false });
const nativeNames = ["visible-native", "visible-alias", "private-visible", "visible-group", "private-group"];
let d1: RealD1;
let env: Env;
const mockUpstream = () => vi.spyOn(globalThis, "fetch");
let upstream: ReturnType<typeof mockUpstream>;

beforeEach(async () => {
  resetRateLimitMemory();
  clearMemoryCacheForTest();
  d1 = createRealD1();
  env = makeEnv(d1);
  await seedDevice(d1, { balance_usd: 100 });
  seedProvider(d1);
  seedModel(d1, { id: "visible", model_name: "visible-native", alias: "visible-alias" });
  seedModel(d1, { id: "private", model_name: "private-visible", model_public: 0 });
  seedModel(d1, { id: "hidden", model_name: "raw-hidden", alias: "raw-hidden-alias",
    input_price_per_m: 10, output_price_per_m: 20, config_json: hidden });
  seedModel(d1, { id: "member", model_name: "hidden-member", model_public: 0,
    input_price_per_m: 100, output_price_per_m: 200, config_json: hidden });
  seedGroup(d1, { id: "hidden-group", name: "raw-hidden-group",
    input_price_per_m: 7, output_price_per_m: 13, config_json: hidden });
  seedGroup(d1, { id: "visible-group", name: "visible-group" });
  seedGroup(d1, { id: "private-group", name: "private-group", model_public: 0 });
  for (const id of ["hidden-group", "visible-group", "private-group"]) seedGroupMembers(d1, id, ["member"]);
  upstream = mockUpstream().mockRejectedValue(new Error("Unexpected external fetch in catalog visibility test"));
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });

function get(path: string, token: string | null = TOKEN) {
  return app.request("https://gw.test/v1" + path,
    { headers: token === null ? {} : { authorization: "Bearer " + token } }, env);
}
async function json<T>(response: Response | Promise<Response>): Promise<T> {
  const res = await response;
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as T;
}
interface Entry { id: string; input_price_per_m: number; output_price_per_m: number; }
const sorted = (values: string[]) => [...values].sort();
async function models(token: string | null = TOKEN) {
  return (await json<{ data: Entry[] }>(get("/models", token))).data;
}
async function device() {
  return json<AuthedDevice>(authApp.request("https://gw.test/", { headers: { authorization: "Bearer " + TOKEN } }, env));
}
async function policy(mode: TokenRoutingPolicy["mode"], groups: string[] = [], model_scope: string[] | null = null) {
  await putTokenRoutingPolicy(env, DEVICE_ID, "master", { ...structuredClone(DEFAULT_ROUTING_POLICY), mode, group_ids: groups, model_scope });
}
async function services(sameName = false) {
  const keys = sameName ? ["raw-hidden", "raw-hidden-group"] : ["canonical-model", "canonical-group"];
  const first = await createServiceGroup(env, { name: "visibility-first", public_selectable: 1, multiplier: 2 });
  const second = await createServiceGroup(env, { name: "visibility-second", public_selectable: 1, multiplier: 3 });
  for (const group of [first, second]) {
    await upsertServiceGroupModel(env, group.id, { model_key: keys[0], target_type: "model", target_id: "hidden" });
    await upsertServiceGroupModel(env, group.id, { model_key: keys[1], target_type: "group", target_id: "hidden-group" });
  }
  return { keys, ids: [first.id, second.id] };
}
async function select(mode: "legacy" | "auto" | "fixed" | "multi", ids: string[]) {
  await policy(mode, mode === "fixed" ? ids.slice(0, 1) : mode === "multi" ? ids : []);
}
async function marketplace() {
  return json<{ model_count: number; items: Array<{ model_name: string; service_group_id: string | null;
    input_price_per_m: number; output_price_per_m: number; pricing_mode: string }> }>(
    consoleApp.request("https://gw.test/model-marketplace", { headers: { authorization: "Bearer " + TOKEN } }, env));
}
function state() {
  return ["devices", "device_models", "device_model_groups", "device_service_groups", "token_routing_policies",
    "token_routing_policy_groups", "models", "model_groups"].map(table => d1.rows("SELECT * FROM " + table));
}
async function call(name: string) {
  const exec = new CollectingExecutionContext();
  const res = await app.request("https://gw.test/v1/chat/completions", { method: "POST",
    headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(chatBody(name)) }, env, exec as never);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}
function expectOneBill(cost: number) {
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(usageRows(d1)).toHaveLength(1);
  expect(usageRows(d1)[0]).toMatchObject({ status_code: 200, input_tokens: 1000, output_tokens: 1000, cache_hit: 0 });
  expect(usageRows(d1)[0].cost_usd).toBeCloseTo(cost, 8);
  const charges = ledgerRows(d1).filter(row => row.delta_usd < 0);
  expect(charges).toHaveLength(1);
  expect(charges[0].delta_usd).toBeCloseTo(-cost, 8);
  expect(wallet(d1)?.balance_usd).toBeCloseTo(100 - cost, 8);
  expect(wallet(d1)?.reserved_usd).toBe(0);
  expect(holdRows(d1)).toEqual([]);
}

describe("raw catalog visibility defaults and admin validation", () => {
  it("hides only an explicit boolean false; missing, malformed and historical nonboolean flags default visible", () => {
    expect(isRawCatalogVisible({ config_json: hidden })).toBe(false);
    for (const config_json of [undefined, null, "", "{}", '{"catalog_visible":true}', '{broken', "null", "[]", "false",
      '{"catalog_visible":"false"}', '{"catalog_visible":0}', '{"catalog_visible":null}']) {
      expect(isRawCatalogVisible({ config_json }), String(config_json)).toBe(true);
    }
  });

  const schemas = [
    { name: "create model", schema: CreateModelSchema, base: { provider_id: "prov_a", model_name: "new-model" } },
    { name: "update model", schema: UpdateModelSchema, base: {} },
    { name: "create group", schema: CreateModelGroupSchema, base: { name: "new-group" } },
    { name: "update group", schema: UpdateModelGroupSchema, base: {} },
  ];
  it.each(schemas)("$name accepts absent/true/false without changing unrelated configuration", ({ schema, base }) => {
    for (const config_json of [undefined, null, "{}", JSON.stringify({ catalog_visible: true, custom: { keep: 1 } }),
      JSON.stringify({ catalog_visible: false, custom: { keep: 1 } })]) {
      const result = schema.safeParse({ ...base, config_json });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.config_json).toBe(config_json);
    }
  });
  it.each(schemas)("$name rejects explicit nonboolean catalog_visible", ({ schema, base }) => {
    for (const flag of ["false", "true", 0, 1, null, [], {}]) {
      const result = schema.safeParse({ ...base, config_json: JSON.stringify({ catalog_visible: flag }) });
      expect(result.success, JSON.stringify(flag)).toBe(false);
      if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["config_json"], message: "catalog_visible must be a boolean" }),
      ]));
    }
  });
});

describe("catalog discovery is display-only", () => {
  it.each([null, "invalid-token"])("anonymous/invalid token %s lists only public visible names, not hidden aliases or private rows", async token => {
    expect(sorted((await models(token)).map(row => row.id))).toEqual(sorted(["visible-native", "visible-alias", "visible-group"]));
    expect((await get("/models/private-visible", token)).status).toBe(404);
    expect((await get("/models/private-group", token)).status).toBe(404);
    const tags = await json<{ models: Array<{ name: string }> }>(get("/tags", token));
    expect(sorted(tags.models.map(row => row.name))).toEqual(sorted(["visible-native", "visible-alias", "visible-group"]));
    const spec = await json<{ components: { schemas: { ChatCompletionRequest: { properties: { model: { enum: string[] } } } } } }>(get("/openapi.json", token));
    expect(sorted(spec.components.schemas.ChatCompletionRequest.properties.model.enum)).toEqual(sorted(["visible-native", "visible-alias", "visible-group"]));
    expect(upstream).not.toHaveBeenCalled();
  });

  it("native authorized listing preserves default-visible model/group prices and does not mutate scopes or billing", async () => {
    const before = state();
    const rows = await models();
    expect(sorted(rows.map(row => row.id))).toEqual(sorted(nativeNames));
    expect(rows.find(row => row.id === "visible-native")).toMatchObject({ input_price_per_m: 3, output_price_per_m: 15 });
    expect(rows.find(row => row.id === "visible-group")).toMatchObject({ input_price_per_m: 9, output_price_per_m: 45 });
    expect(state()).toEqual(before);
    expect(usageRows(d1)).toEqual([]); expect(ledgerRows(d1)).toEqual([]);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("explicit true keeps raw models and groups visible", async () => {
    d1.sql("UPDATE models SET config_json = ? WHERE id = 'hidden'", '{"catalog_visible":true}');
    d1.sql("UPDATE model_groups SET config_json = ? WHERE id = 'hidden-group'", '{"catalog_visible":true}');
    expect(sorted((await models()).map(row => row.id))).toEqual(sorted([...nativeNames, "raw-hidden", "raw-hidden-alias", "raw-hidden-group"]));
  });

  it.each(["auto", "fixed", "multi"] as const)("%s keeps differently named canonical services visible over hidden model/group targets", async mode => {
    const { keys, ids } = await services(); await select(mode, ids);
    const before = state();
    const rows = await models();
    expect(sorted(rows.map(row => row.id))).toEqual(sorted([...keys, ...(mode === "auto" ? nativeNames : [])]));
    expect(rows.find(row => row.id === keys[0])).toMatchObject({ input_price_per_m: 20, output_price_per_m: 40 });
    expect(rows.find(row => row.id === keys[1])).toMatchObject({ input_price_per_m: 14, output_price_per_m: 26 });
    expect(state()).toEqual(before); expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["auto", "fixed", "multi"] as const)("%s retains explicit same-name mappings, but never revives the hidden raw alias", async mode => {
    const { keys, ids } = await services(true); await select(mode, ids);
    const rows = await models();
    expect(sorted(rows.map(row => row.id))).toEqual(sorted([...keys, ...(mode === "auto" ? nativeNames : [])]));
    expect(rows.filter(row => row.id === "raw-hidden")).toHaveLength(1);
    expect(rows.find(row => row.id === "raw-hidden")).toMatchObject({ input_price_per_m: 20, output_price_per_m: 40 });
    expect(rows.some(row => row.id === "raw-hidden-alias")).toBe(false);
  });

  it.each(["legacy", "auto", "fixed", "multi"] as const)("%s tags, Codex catalog and OpenAPI match visible discovery names", async mode => {
    const { keys, ids } = await services(); await select(mode, ids);
    const expected = [...(mode === "legacy" || mode === "auto" ? nativeNames : []), ...(mode === "legacy" ? [] : keys)];
    const tags = await json<{ models: Array<{ name: string }> }>(get("/tags"));
    expect(sorted(tags.models.map(row => row.name))).toEqual(sorted(expected));
    const codex = await json<{ models: Array<{ slug: string }> }>(get("/model-catalog.json"));
    expect(codex.models.some(row => ["raw-hidden", "raw-hidden-alias", "raw-hidden-group", "hidden-member"].includes(row.slug))).toBe(false);
    const codexExpected = expected.filter(name => name !== "visible-native");
    expect(sorted(codex.models.map(row => row.slug))).toEqual(sorted(codexExpected));
    const spec = await json<{ components: { schemas: { ChatCompletionRequest: { properties: { model: { enum: string[] } } } } } }>(get("/openapi.json"));
    expect(sorted(spec.components.schemas.ChatCompletionRequest.properties.model.enum)).toEqual(sorted(expected));
    expect(upstream).not.toHaveBeenCalled();
  });

  it("includeHidden uses a separate anonymous cache entry and never grants private rows", async () => {
    const listed = await listModelProjectionsForDevice(env, null);
    const all = await listModelProjectionsForDevice(env, null, { includeHidden: true });
    expect(sorted(listed.map(row => row.model_name))).toEqual(["visible-group", "visible-native"]);
    expect(sorted(all.map(row => row.model_name))).toEqual(sorted(["visible-native", "visible-group", "raw-hidden", "raw-hidden-group"]));
    expect(await listModelProjectionsForDevice(env, null)).toEqual(listed);
    expect(await listModelProjectionsForDevice(env, null, { includeHidden: true })).toEqual(all);
    expect((await listModelProjectionsForDevice(env, null, { includePrivate: true, includeHidden: true })).map(row => row.model_name)).toContain("private-group");
    expect(await listModelProjectionsForDevice(env, null)).toEqual(listed);
  });

  it.each(["legacy", "auto", "fixed", "multi"] as const)("%s marketplace filters raw legacy only, preserving mapped quotes and prices", async mode => {
    const { keys, ids } = await services(); await select(mode, ids);
    const before = state();
    const body = await marketplace();
    expect(body.model_count).toBe(body.items.length);
    const raw = body.items.filter(row => row.service_group_id === null);
    expect(sorted(raw.map(row => row.model_name))).toEqual(sorted(nativeNames.filter(name => name !== "visible-alias")));
    const mapped = body.items.filter(row => row.service_group_id !== null);
    expect(mapped).toHaveLength(4);
    expect(mapped).toEqual(expect.arrayContaining([
      expect.objectContaining({ model_name: keys[0], service_group_id: ids[0], input_price_per_m: 20, output_price_per_m: 40, pricing_mode: "priced" }),
      expect.objectContaining({ model_name: keys[1], service_group_id: ids[1], input_price_per_m: 21, output_price_per_m: 39, pricing_mode: "priced" }),
    ]));
    expect(state()).toEqual(before); expect(usageRows(d1)).toEqual([]); expect(upstream).not.toHaveBeenCalled();
  });

  it("marketplace preserves same-name service offers even when the original raw card is hidden", async () => {
    const { keys, ids } = await services(true);
    const { items } = await marketplace();
    expect(items.filter(row => keys.includes(row.model_name))).toHaveLength(4);
    expect(items.filter(row => keys.includes(row.model_name)).every(row => ids.includes(row.service_group_id!))).toBe(true);
  });
});

describe("hidden names keep authorization, metadata and request billing", () => {
  it.each(["legacy", "auto"] as const)("%s authorized by-name model, alias and group detail remain available despite absent list entries", async mode => {
    await policy(mode);
    expect((await models()).some(row => row.id.startsWith("raw-hidden"))).toBe(false);
    for (const name of ["raw-hidden", "raw-hidden-alias", "raw-hidden-group"]) {
      const detail = await json<Entry>(get("/models/" + name));
      expect(detail.id).toBe(name);
      expect(detail.input_price_per_m).toBe(name === "raw-hidden-group" ? 7 : 10);
    }
    const all = await listModelProjectionsForDevice(env, await device(), { includeHidden: true });
    expect(all.map(row => row.model_name)).toContain("raw-hidden-group");
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["legacy", "auto", "fixed", "multi"] as const)("%s preserves list scope: hidden granted targets stay callable, ungranted visible targets stay denied", async mode => {
    const { keys, ids } = await services();
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID);
    seedDeviceModels(d1, ["hidden"]); seedDeviceGroups(d1, ["hidden-group"]);
    await select(mode, ids);
    expect(sorted((await models()).map(row => row.id))).toEqual(mode === "legacy" ? [] : sorted(keys));
    expect((await get("/models/visible-native")).status).toBe(404);
    expect((await get("/models/visible-group")).status).toBe(404);
    const all = await listModelProjectionsForDevice(env, await device(), { includeHidden: true });
    expect(all.some(row => row.id === "visible" || row.id === "visible-group")).toBe(false);
    const requested = mode === "legacy" ? "raw-hidden-alias" : keys[0];
    expect((await get("/models/" + requested)).status).toBe(200);
    upstream.mockImplementation(async () => openAiAnswer());
    const { res, text } = await call(requested);
    expect(res.status, text).toBe(200);
    expectOneBill(mode === "legacy" ? 0.03 : 0.06);
  });

  it("all_and_list still includes public and explicitly granted private names, independently of the hide flag", async () => {
    d1.sql("UPDATE devices SET model_scope = 'all_and_list' WHERE id = ?", DEVICE_ID);
    seedDeviceModels(d1, ["private", "hidden"]); seedDeviceGroups(d1, ["private-group", "hidden-group"]);
    await policy("legacy");
    expect(sorted((await models()).map(row => row.id))).toEqual(sorted(nativeNames));
    expect((await get("/models/raw-hidden")).status).toBe(200);
    expect((await get("/models/raw-hidden-group")).status).toBe(200);
    const all = await listModelProjectionsForDevice(env, await device(), { includeHidden: true });
    expect(sorted(all.map(row => row.model_name))).toEqual(sorted([
      "visible-native", "private-visible", "visible-group", "private-group", "raw-hidden", "raw-hidden-group",
    ]));
    expect(all.some(row => row.model_name === "hidden-member")).toBe(false);
  });

  it("marketplace keeps account grants authoritative even for explicit mappings over hidden targets", async () => {
    const { keys } = await services();
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID);
    seedDeviceModels(d1, ["visible"]); seedDeviceGroups(d1, []);
    expect((await marketplace()).items.map(row => row.model_name)).toEqual(["visible-native"]);
    seedDeviceModels(d1, ["visible", "hidden"]); seedDeviceGroups(d1, ["hidden-group"]);
    const items = (await marketplace()).items;
    expect(items.filter(row => row.service_group_id === null).map(row => row.model_name)).toEqual(["visible-native"]);
    expect(sorted([...new Set(items.filter(row => row.service_group_id !== null).map(row => row.model_name))])).toEqual(sorted(keys));
  });

  it("includeHidden cannot bypass token model_scope or account model/group grants", async () => {
    await policy("auto", [], ["model:hidden"]);
    const rows = await listModelProjectionsForDevice(env, await device(), { includeHidden: true });
    expect(rows.map(row => row.model_name)).toEqual(["raw-hidden"]);
    expect((await get("/models/raw-hidden-alias")).status).toBe(200);
    expect((await get("/models/raw-hidden-group")).status).toBe(404);
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID);
    seedDeviceModels(d1, []); seedDeviceGroups(d1, []);
    expect(await listModelProjectionsForDevice(env, await device(), { includeHidden: true })).toEqual([]);
    expect((await get("/models/raw-hidden-alias")).status).toBe(404);
  });

  it.each((["legacy", "auto"] as const).flatMap(mode =>
    ["raw-hidden", "raw-hidden-alias", "raw-hidden-group"].map(name => ({ mode, name }))))(
    "$mode manual hidden $name requests still route and bill once at the original raw price", async ({ mode, name }) => {
    await policy(mode);
    const before = state();
    expect((await models()).some(row => row.id === name)).toBe(false);
    upstream.mockImplementation(async () => openAiAnswer());
    const { res, text } = await call(name);
    expect(res.status, text).toBe(200);
    expectOneBill(name === "raw-hidden-group" ? 0.02 : 0.03);
    const sent = JSON.parse(String(upstream.mock.calls[0][1]?.body));
    expect(sent.model).toBe(name === "raw-hidden-group" ? "hidden-member" : "raw-hidden");
    expect(usageRows(d1)[0].model).toBe(name === "raw-hidden-group" ? name : "raw-hidden");
    const after = state();
    expect(after.slice(1)).toEqual(before.slice(1));
  });

  it.each(["auto", "fixed", "multi"] as const)("%s service request over a hidden target uses its frozen service price and bills once", async mode => {
    const { keys, ids } = await services(); await select(mode, ids);
    upstream.mockImplementation(async () => openAiAnswer());
    const { res, text } = await call(keys[1]);
    expect(res.status, text).toBe(200);
    expectOneBill(0.04);
    const row = d1.row<{ service_group_id: string; pricing_snapshot_json: string }>("SELECT service_group_id, pricing_snapshot_json FROM usage")!;
    expect(row.service_group_id).toBe(ids[0]);
    expect(JSON.parse(row.pricing_snapshot_json).billing).toMatchObject({ model_name: keys[1], input_price_per_m: 14, output_price_per_m: 26 });
    expect(JSON.parse(String(upstream.mock.calls[0][1]?.body)).model).toBe("hidden-member");
  });

  it("hiding does not authorize a raw/manual request outside account grants", async () => {
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID);
    seedDeviceModels(d1, ["visible"]);
    await policy("legacy");
    for (const name of ["raw-hidden", "raw-hidden-alias", "raw-hidden-group"]) {
      expect((await get("/models/" + name)).status).toBe(404);
      const { res } = await call(name);
      expect(res.status).toBe(403);
    }
    expect(upstream).not.toHaveBeenCalled(); expect(usageRows(d1)).toEqual([]);
    expect(ledgerRows(d1)).toEqual([]); expect(wallet(d1)?.balance_usd).toBe(100);
  });
});
