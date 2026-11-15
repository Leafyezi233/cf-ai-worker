import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateModelMetadata, inferContextWindow, resolveModelMetadata } from "../src/gateway/model_metadata";
import type { ModelMetadataInput } from "../src/gateway/model_metadata";
import { resolveGroupReasoningSupport, resolveReasoningSupport } from "../src/gateway/reasoning";
import { buildModelCatalog } from "../src/gateway/catalog";
import { gatewayApp } from "../src/gateway";
import { modelsApp } from "../src/admin/models";
import { serializeConsoleModel } from "../src/console/model_marketplace";
import { ensureSchema } from "../src/db/schema";
import { listGroupsForDevice, listModelProjectionsForDevice } from "../src/db/repo";
import type { DeviceRow, Env } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, TOKEN, makeEnv, seedDevice, seedDeviceModels, seedGroup, seedGroupMembers, seedModel, seedProvider } from "./helpers/realGatewayEnv";

const input = (config: Record<string, unknown> = {}, extra: Partial<ModelMetadataInput> = {}): ModelMetadataInput =>
  ({ model_name: "opaque-model", config_json: JSON.stringify(config), ...extra });
const limit = (context: number, output: number) => ({ context_window: context, max_output_tokens: output });
const fields = ["context_window", "max_context_window", "max_output_tokens", "context_window_source", "max_output_tokens_source", "supports_reasoning", "supported_reasoning_levels", "default_reasoning_level", "reasoning_source"];
function metadataOf(row: Record<string, unknown>) { return Object.fromEntries(fields.map(key => [key, row[key]])); }
function noSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const marker of ["provider_api_key", "provider_secret_name", "provider_endpoint", "provider_id", "member_ids_json", "config_json", "secret-marker"]) expect(text).not.toContain(marker);
}

describe("pure model metadata resolution", () => {
  it.each(["context_window", "max_context_window", "contextWindow", "max_input_tokens"])("accepts positive integer context key %s", key => {
    expect(resolveModelMetadata(input({ [key]: 32000 }))).toMatchObject({ context_window: 32000, max_context_window: 32000, context_window_source: "config", max_output_tokens: null, max_output_tokens_source: "unknown" });
  });
  it.each(["max_output_tokens", "maxTokens", "max_completion_tokens"])("accepts positive integer output key %s", key => {
    expect(resolveModelMetadata(input({ [key]: 4096 }))).toMatchObject({ max_output_tokens: 4096, max_output_tokens_source: "config" });
  });
  it.each([0, -1, 0.5, "8192", true, null, [], {}, Number.MAX_SAFE_INTEGER + 1])("does not promote invalid limits %j", value => {
    const resolved = resolveModelMetadata(input({ context_window: value, max_context_window: value, contextWindow: value, max_input_tokens: value, max_output_tokens: value, maxTokens: value, max_completion_tokens: value }));
    expect(resolved).toMatchObject({ context_window: 128000, context_window_source: "fallback", max_output_tokens: null, max_output_tokens_source: "unknown" });
  });
  it.each(["{broken", "null", "[]", "42", '"text"', '{"context_window":1e999,"max_output_tokens":1e999}'])("tolerates malformed/non-object config %s", config_json => {
    expect(resolveModelMetadata({ model_name: "gpt-4o", config_json })).toMatchObject({ context_window: inferContextWindow("gpt-4o"), context_window_source: "inferred", max_output_tokens: null });
  });
  it("uses the smallest valid spelling without mutating the input", () => {
    const row = input({ context_window: 64000, contextWindow: 32000, max_context_window: "1", max_output_tokens: 8192, maxTokens: 4096 });
    const before = JSON.stringify(row);
    expect(resolveModelMetadata(row)).toMatchObject({ context_window: 32000, max_output_tokens: 4096 });
    expect(JSON.stringify(row)).toBe(before);
  });
  it.each([input(), input({}, { model_name: "o3" }), input({}, { provider_type: "anthropic" }), input({ supports_reasoning: false }), input({ supported_reasoning_levels: ["low", "max"], default_reasoning_level: "max" }), input({ probe: { reasoning_supported: false } }, { model_name: "o3" }), input({ capabilities: ["reasoning"] }), input({ supports_reasoning: false }, { is_group: true }), input({}, { is_group: true })])("preserves existing reasoning rules %#", row => {
    const expected = row.is_group ? resolveGroupReasoningSupport(row.config_json) : resolveReasoningSupport(row);
    expect(resolveModelMetadata(row)).toMatchObject({ supports_reasoning: expected.supported, supported_reasoning_levels: expected.levels, default_reasoning_level: expected.default_level, reasoning_source: expected.source });
  });
  it("publishes only allowlisted metadata, even with hostile config", () => {
    const result = resolveModelMetadata(input({ ...limit(64000, 8192), provider_api_key: "secret-marker", member_ids_json: ["secret-marker"], model_metadata: { context_window: 999999 } }));
    expect(Object.keys(result).sort()).toEqual(fields.sort()); noSecrets(result);
  });
  it("aggregates all member minima and explicit group caps without changing its reasoning ladder", () => {
    const group = input({ ...limit(40000, 6000) }, { is_group: true });
    const result = aggregateModelMetadata(group, [input(limit(64000, 8000)), input(limit(48000, 7000))]);
    expect(result).toMatchObject({ context_window: 40000, max_output_tokens: 6000, context_window_source: "members", max_output_tokens_source: "members", supports_reasoning: true, default_reasoning_level: "medium" });
    expect(result.supported_reasoning_levels.map(level => level.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
  it("keeps unknown members untrusted and unknown output null even under explicit caps", () => {
    expect(aggregateModelMetadata(input(limit(64000, 8192), { is_group: true }), [input(limit(48000, 4096)), input()]))
      .toMatchObject({ context_window: 48000, context_window_source: "mixed", max_output_tokens: null, max_output_tokens_source: "mixed" });
    expect(aggregateModelMetadata(input(limit(64000, 8192), { is_group: true }), [])).toMatchObject({ context_window_source: "mixed", max_output_tokens: null, max_output_tokens_source: "unknown" });
  });
});

let d1: RealD1, env: Env;
function device() { return d1.row<DeviceRow>("SELECT * FROM devices WHERE id = ?", DEVICE_ID)!; }
function select(id: string | null) { d1.sql("UPDATE devices SET service_group_id = ? WHERE id = ?", id, DEVICE_ID); }
function service(id: string, target: string, members: string[] | null = null, multiplier = 1, kind = "group") {
  d1.sql("INSERT INTO service_groups(id,name,enabled,selectable,public_selectable,multiplier,revision) VALUES(?,?,1,1,1,?,1)", id, id, multiplier);
  d1.sql("INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id,member_ids_json) VALUES(?,?,'shared',?,?,?)", id + "-mapping", id, kind, target, members === null ? null : JSON.stringify(members));
}
async function get(path: string, auth = true) {
  const response = await gatewayApp.request("https://gw.test" + path, { headers: auth ? { authorization: "Bearer " + TOKEN } : {} }, env);
  return { status: response.status, body: await response.json() as any };
}
beforeEach(async () => {
  d1 = createRealD1(); env = makeEnv(d1); await seedDevice(d1); seedProvider(d1, { api_key: "secret-marker" });
  seedModel(d1, { id: "wide", model_name: "upstream-wide", alias: "wide-alias", config_json: JSON.stringify({ ...limit(96000, 12000), provider_api_key: "secret-marker", capabilities: ["tool_call", { api_key: "secret-marker" }] }) });
  seedModel(d1, { id: "small", model_name: "upstream-small", config_json: JSON.stringify(limit(32000, 4096)) });
  seedGroup(d1, { id: "pool", name: "pool", config_json: JSON.stringify(limit(64000, 8192)) });
  seedGroupMembers(d1, "pool", ["wide", "small"]);
  select("legacy"); await ensureSchema(env);
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });

describe("unified discovery metadata", () => {
  it("retains actual per-call billing and protocol on legacy console and catalog projections", async () => {
    seedModel(d1, { id: "images", model_name: "images", billing_unit: "call", price_per_call: 2, search_price_per_call: 0.1, config_json: JSON.stringify(limit(64000, 8000)) });
    const row = (await listModelProjectionsForDevice(env, device())).find(item => item.id === "images")!;
    expect(serializeConsoleModel(row, new Map(), Date.now(), 0)).toMatchObject({ billing_unit: "call", price_per_call: 2, search_price_per_call: 0.1, chat_endpoint: "/v1/images/generations" });
    expect(buildModelCatalog([row]).models[0]).toMatchObject({ billing_unit: "call", chat_endpoint: "/v1/images/generations" });
  });
  it("keeps list/single/alias/catalog/console values identical and admin catalog exports max_output_tokens", async () => {
    const rows = await listModelProjectionsForDevice(env, device());
    const list = await get("/models"); expect(list.status).toBe(200);
    const catalog = (await get("/model-catalog.json")).body.models;
    for (const row of rows) {
      const expected = resolveModelMetadata(row);
      for (const name of [row.model_name, row.alias].filter((name): name is string => Boolean(name))) {
        const listed = list.body.data.find((item: any) => item.id === name);
        const single = await get("/models/" + name); expect(single.status).toBe(200);
        expect(metadataOf(listed)).toEqual(expected); expect(metadataOf(single.body)).toEqual(expected);
        expect(listed.contextWindow).toBe(expected.context_window); expect(listed.maxTokens).toBe(expected.max_output_tokens);
        noSecrets(single.body); noSecrets(listed);
      }
      expect(metadataOf(catalog.find((item: any) => item.slug === (row.alias || row.model_name)))).toEqual(expected);
      expect(metadataOf(serializeConsoleModel(row, new Map(), Date.now(), 0))).toEqual(expected);
    }
    const response = await modelsApp.request("https://gw.test/catalog", {}, env);
    expect(response.status).toBe(200); const exported = await response.json() as any;
    expect(exported.models.find((item: any) => item.slug === "pool")).toMatchObject({ context_window: 32000, max_output_tokens: 4096 });
    noSecrets(exported); noSecrets(catalog);
  });
  it("uses selected service members rather than all group defaults", async () => {
    service("fixed", "pool", ["wide"]); select("fixed");
    const listed = (await get("/models")).body.data;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "shared", context_window: 64000, max_output_tokens: 8192 });
    expect((await get("/models/shared")).body).toMatchObject({ context_window: 64000, max_output_tokens: 8192, owned_by: "system" });
    expect((await get("/models/pool")).status).toBe(404);
    noSecrets(listed);
  });
  it("aggregates all reachable Auto candidates, not merely the cheapest offer", async () => {
    service("cheap-wide", "wide", null, 0.1, "model"); service("costly-small", "small", null, 10, "model"); select("auto");
    const listed = (await get("/models")).body.data.find((item: any) => item.id === "shared");
    expect(listed).toMatchObject({ context_window: 32000, max_output_tokens: 4096, input_price_per_m: 0.30000000000000004 });
    expect(metadataOf((await get("/models/shared")).body)).toEqual(metadataOf(listed));
    const catalog = (await get("/model-catalog.json")).body.models.find((item: any) => item.slug === "shared");
    expect(metadataOf(catalog)).toEqual(metadataOf(listed)); noSecrets(catalog);
    d1.sql("UPDATE models SET config_json = '{}' WHERE id = 'small'");
    expect((await get("/models/shared")).body).toMatchObject({ max_output_tokens: null, maxTokens: null, context_window_source: "mixed" });
  });
  it("does not let config forge inferred provenance or bypass null output in catalogs", async () => {
    const row = (await listModelProjectionsForDevice(env, device())).find(row => row.id === "wide")!;
    row.config_json = JSON.stringify({ context_window: -1, max_output_tokens: "8192", context_window_source: "config", max_output_tokens_source: "config", supports_reasoning: false, provider_api_key: "secret-marker" });
    const catalog = buildModelCatalog([row]).models[0];
    expect(catalog).toMatchObject({ context_window: 128000, context_window_source: "fallback", max_output_tokens: null, max_output_tokens_source: "unknown", supports_reasoning: false }); noSecrets(catalog);
  });
  it("retains anonymous/private and scoped single lookup gates", async () => {
    d1.sql("UPDATE models SET model_public = 0 WHERE id = 'wide'");
    expect((await get("/models/wide-alias", false)).status).toBe(404);
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID); seedDeviceModels(d1, ["small"]);
    expect((await get("/models/wide-alias")).status).toBe(404);
    expect((await get("/models")).body.data.map((row: any) => row.id)).toEqual(["upstream-small"]);
  });
  it("batch-loads all group metadata with a constant number of queries", async () => {
    const prepare = vi.spyOn(env.DB, "prepare"); await listGroupsForDevice(env, device()); const first = prepare.mock.calls.length;
    for (let i = 0; i < 30; i++) { seedGroup(d1, { id: "pool-" + i, name: "pool-" + i }); seedGroupMembers(d1, "pool-" + i, ["wide", "small"]); }
    prepare.mockClear(); const rows = await listGroupsForDevice(env, device());
    expect(rows).toHaveLength(31); expect(prepare.mock.calls.length).toBe(first);
    expect(rows.every(row => resolveModelMetadata(row).max_output_tokens === 4096)).toBe(true);
  });
});
