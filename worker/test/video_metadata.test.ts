import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway";
import { protocolProbesApp } from "../src/admin/protocol-probes";
import { modelsApp } from "../src/admin/models";
import { modelGroupsApp } from "../src/admin/model-groups";
import { serviceGroupsApp } from "../src/admin/service-groups";
import { resolveModelType } from "../src/gateway/model_type";
import { readProtocolCapabilities, planProtocolRoute } from "../src/gateway/protocol_capabilities";
import { aggregateProtocolMetadata } from "../src/gateway/protocol_metadata";
import { CreateModelSchema, UpdateModelSchema, CreateModelGroupSchema } from "../src/admin/schemas";
import { buildModelCatalog } from "../src/gateway/catalog";
import { serializeConsoleModel } from "../src/console/model_marketplace";
import { generateOpenApiSpec } from "../src/gateway/openapi";
import { readVideoConfig } from "../src/gateway/video_config";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedGroup, seedGroupMembers, seedModel, seedProvider } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";

const video = { adapter: "moyuu", task_id_path: "data.private_task", sizes: ["1280x720"], seconds_min: 4, seconds_max: 10 };
const config = (over: Record<string, unknown> = {}) => JSON.stringify({ model_type: "video", video: { ...video, ...over } });
const callOnly = { input_price_per_m: 0, output_price_per_m: 0, cache_read_price_per_m: 0, cache_write_price_per_m: 0, search_price_per_call: 0, price_per_call: 0.25, billing_unit: "call" };
const row = (provider_type = "openai") => ({ id: "v", provider_id: "p", provider_type, provider_name: "PRIVATE-UPSTREAM", model_name: "video-public", display_name: "Video", alias: "video-alias", enabled: 1, model_public: 1, config_json: config(), ...callOnly });
const databases: RealD1[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  const db = createRealD1(); databases.push(db); seedProvider(db, { name: "PRIVATE-UPSTREAM", endpoint: "https://private-upstream.example/v1" });
  seedProvider(db, { id: "anthropic", type: "anthropic" }); seedProvider(db, { id: "gemini", type: "gemini" });
  return { db, env: makeEnv(db) };
}
function write(app: typeof modelsApp, env: Env, path: string, body: unknown, method = "PUT") {
  return app.request("http://admin.test" + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
}
function seedVideo(db: RealD1, id = "v", overrides: Record<string, unknown> = {}) { seedModel(db, { id, model_name: id, ...callOnly, config_json: config(), ...overrides }); }
function seedVideoGroup(db: RealD1) { seedGroup(db, { id: "vg", name: "video-pool", ...callOnly, config_json: config() }); seedVideo(db, "v1"); seedVideo(db, "v2", { config_json: config({ task_id_path: "result.other", failed_statuses: ["STOPPED"], sizes: ["1280x720", "1920x1080"], seconds_min: 3, seconds_max: 15 }) }); }
const invalidPricing: [string, Record<string, unknown>][] = [
  ["token billing", { billing_unit: "token" }], ["input", { input_price_per_m: 1 }], ["output", { output_price_per_m: 1 }],
  ["cache read", { cache_read_price_per_m: 1 }], ["cache write", { cache_write_price_per_m: 1 }],
  ["search", { search_price_per_call: 1 }], ["cache enabled", { cache_enabled: true }],
];

describe("video metadata isolation", () => {
  it("resolves explicit video without changing legacy call or Embedding models", () => {
    expect(resolveModelType(row())).toBe("video"); expect(resolveModelType({ billing_unit: "call" })).toBe("image");
    expect(resolveModelType({ config_json: '{"model_type":"embedding"}' })).toBe("embedding");
    expect(resolveModelType({ config_json: "broken", billing_unit: "token" })).toBe("text");
  });
  it("advertises video only and cannot plan Chat or Responses even with explicit chat flags", () => {
    const v = { ...row(), config_json: JSON.stringify({ model_type: "video", video, protocol_capabilities: { chat_completions: true, responses: true } }) };
    expect(readProtocolCapabilities(v)).toMatchObject({ chat_completions: false, responses: false, supported_endpoints: ["/v1/video/generations"] });
    expect(planProtocolRoute(v, "chat/completions")).toBeNull(); expect(planProtocolRoute(v, "responses")).toBeNull();
    for (const type of ["anthropic", "gemini"]) expect(readProtocolCapabilities(row(type)).supported_endpoints).toEqual([]);
    expect(aggregateProtocolMetadata([row(), row()])).toMatchObject({ supported_endpoints: ["/v1/video/generations"], chat_completions: false, responses: false, member_count: 2 });
    expect(buildModelCatalog([row() as any]).models).toEqual([]);
    expect(serializeConsoleModel(row() as any, new Map(), Date.now(), 0)).toMatchObject({ model_type: "video", chat_endpoint: "/v1/video/generations", billing_unit: "call", price_per_call: 0.25 });
  });
  it("publishes no private config, credentials or upstream ownership in discovery", async () => {
    const { db, env } = fixture();
    seedVideo(db, "v", { alias: "video-alias", fallback_model_id: "PRIVATE-FALLBACK", config_json: JSON.stringify({ model_type: "video", video, api_key: "PRIVATE-KEY", upstream_model: "PRIVATE-MODEL" }) });
    const listing = await gatewayApp.request("http://local/models", {}, env); expect(listing.status).toBe(200);
    const data = await listing.json() as any; expect(data.data).toHaveLength(2);
    const payloads: unknown[] = [data, serializeConsoleModel(row() as any, new Map(), Date.now(), 0)];
    for (const model of data.data) {
      expect(model.video).toEqual({sizes:["1280x720"],seconds_min:4,seconds_max:10});
      expect(model).toMatchObject({ model_type: "video", chat_endpoint: "/v1/video/generations", owned_by: "system", fallback_model_id: null });
      const single = await gatewayApp.request("http://local/models/" + model.id, {}, env); expect(single.status).toBe(200); payloads.push(await single.json());
    }
    const tags = await gatewayApp.request("http://local/tags", {}, env); expect(tags.status).toBe(200); payloads.push(await tags.json());
    for (const payload of payloads) for (const secret of ["private_task", "moyuu", "PRIVATE-UPSTREAM", "PRIVATE-FALLBACK", "PRIVATE-KEY", "PRIVATE-MODEL", "private-upstream.example"]) expect(JSON.stringify(payload)).not.toContain(secret);
  });
  it("skips all paid protocol and reasoning probes for stored and unsaved video", async () => {
    const { db, env } = fixture(); seedVideo(db); seedModel(db, { id: "text", model_name: "text" });
    const fetch = vi.fn(() => { throw Error("No network allowed"); }); vi.stubGlobal("fetch", fetch);
    const preview = await write(protocolProbesApp, env, "/preview", { model_ids: ["v"] }, "POST");
    expect(await preview.json()).toMatchObject({ items: [], request_count: 0, skipped: 1 });
    for (const operation of ["run", "apply"]) expect((await write(protocolProbesApp, env, "/" + operation, { model_id: "v", fingerprint: "stale", confirm_cost: true }, "POST")).status).toBe(409);
    for (const [id, body] of [["v", {}], ["v", { config_json: '{"model_type":"text"}' }], ["text", { config_json: config() }]] as const) {
      const response = await write(modelsApp, env, "/" + id + "/probe-reasoning", body, "POST"); expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: "video_reasoning_probe_not_supported" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("documents required idempotency, text-only submits, device lists and queries without chat enum pollution", async () => {
    const { db, env } = fixture(); seedVideo(db); seedModel(db, { id: "text", model_name: "chat-public" });
    seedModel(db, { id: "embed", model_name: "embedding-public", config_json: '{"model_type":"embedding"}' });
    const spec = await generateOpenApiSpec(env); const schemas = (spec.components as any).schemas; const paths = spec.paths as any;
    expect(schemas.VideoGenerationRequest.required).toEqual(["model", "prompt", "size", "seconds"]); expect(schemas.VideoGenerationRequest.additionalProperties).toBe(false);
    expect(schemas.VideoGenerationRequest.properties.model.enum).toEqual(["v"]);
    expect(schemas.ChatCompletionRequest.properties.model.enum).toEqual(["chat-public"]); expect(schemas.EmbeddingRequest.properties.model.enum).toEqual(["embedding-public"]);
    expect(paths["/v1/video/generations"].post.parameters).toContainEqual(expect.objectContaining({ name: "Idempotency-Key", in: "header", required: true }));
    expect(paths["/v1/video/generations"].get.operationId).toBe("listVideoGenerations"); expect(paths["/v1/video/generations/{task_id}"].get.operationId).toBe("retrieveVideoGeneration");
    expect(paths["/v1/video/generations"].post.responses["200"]).toBeDefined(); expect(paths["/v1/video/generations"].post.responses["202"]).toBeDefined();
    expect(paths["/v1/video/generations"].get.responses["200"].content["application/json"].schema.properties).not.toHaveProperty("object");
    expect(schemas.VideoTask.properties.status.enum).toEqual(["submitting", "submission_unknown", "pending", "succeeded", "failed"]);
    expect(schemas.VideoTask.additionalProperties).toBe(false); expect(schemas.VideoTask.required).toContain("cost_usd");
    expect(paths["/v1/video/generations"].post.description).toContain("price_per_call"); expect(JSON.stringify(spec)).not.toContain("private_task");
  });
});

describe("strict explicit video configuration", () => {
  const create = { provider_id: "prov_a", model_name: "v", ...callOnly, config_json: config() };
  it("requires explicit video config and call billing, without inventing task IDs or failure statuses", () => {
    expect(CreateModelSchema.safeParse(create).success).toBe(true); expect(CreateModelGroupSchema.safeParse({ name: "vg", ...callOnly, config_json: config() }).success).toBe(true);
    expect(readVideoConfig({ config_json: config({ seconds_min: undefined, seconds_max: undefined }) })).toMatchObject({ failed_statuses: [], seconds_min: 3, seconds_max: 15, task_id_path: "data.private_task" });
    for (const cfg of ['{"model_type":"video"}', '{"model_type":"video","video":null}', JSON.stringify({ model_type: "video", video: { adapter: "moyuu", sizes: ["1280x720"] } })]) expect(CreateModelSchema.safeParse({ ...create, config_json: cfg }).success).toBe(false);
    expect(CreateModelSchema.safeParse({ ...create, billing_unit: "token" }).success).toBe(false);
    expect(UpdateModelSchema.safeParse({ config_json: config() }).success).toBe(true);
  });
  it.each([
    ["adapter", "other"], ["task_id_path", ""], ["task_id_path", "a..b"], ["task_id_path", "a.__proto__.id"], ["task_id_path", "constructor.id"], ["task_id_path", "a.prototype.id"], ["task_id_path", "a[0].id"], ["task_id_path", "x".repeat(129)],
    ["sizes", []], ["sizes", ["4097x720"]], ["sizes", ["0x720"]], ["sizes", ["1280X720"]], ["sizes", ["1280x720", "1280x720"]], ["sizes", Array.from({ length: 21 }, (_, n) => (n + 100) + "x720")],
    ["seconds_min", null], ["seconds_max", null], ["failed_statuses", null], ["seconds_min", 2], ["seconds_min", 3.5], ["seconds_min", 11], ["seconds_max", 16], ["seconds_max", 3], ["seconds_max", "10"], ["failed_statuses", "FAILED"], ["failed_statuses", [1]], ["unexpected", true],
  ])("rejects invalid %s=%j in both create and update without rewriting JSON", (key, value) => {
    const cfg = config({ [key as string]: value }); expect(CreateModelSchema.safeParse({ ...create, config_json: cfg }).success).toBe(false); expect(UpdateModelSchema.safeParse({ config_json: cfg }).success).toBe(false);
    expect(readVideoConfig({ config_json: cfg })).toBeNull();
  });
  it("validates explicit video slots, rejects malformed JSON and preserves valid unrelated configs", () => {
    expect(UpdateModelSchema.safeParse({ config_json: "legacy malformed json" }).success).toBe(false);
    expect(UpdateModelSchema.safeParse({ config_json: JSON.stringify({ model_type: "text", video: {} }) }).success).toBe(false);
    for (const config_json of [ '{"model_type":"text"}', '{"model_type":"image"}', '{"model_type":"embedding"}']) expect(UpdateModelSchema.safeParse({ config_json }).success).toBe(true);
  });
});

describe("video admin writes use merged state", () => {
  it("creates valid openai call-only models and preserves supplied private config verbatim", async () => {
    const { env } = fixture(); const cfg = config({ failed_statuses: ["STOPPED"] });
    const response = await write(modelsApp, env, "/", { provider_id: "prov_a", model_name: "v", ...callOnly, config_json: cfg }, "POST"); expect(response.status).toBe(201); expect((await response.json() as any).item).toMatchObject({ ...callOnly, cache_enabled: 0, config_json: cfg });
  });
  it.each(invalidPricing)("rejects %s on model/group creates and merged updates without writes", async (_label, invalid) => {
    const { db, env } = fixture();
    expect((await write(modelsApp, env, "/", { provider_id: "prov_a", model_name: "v", ...callOnly, config_json: config(), ...invalid }, "POST")).status).toBe(400);
    expect((await write(modelGroupsApp, env, "/", { name: "vg", ...callOnly, config_json: config(), ...invalid }, "POST")).status).toBe(400);
    expect(db.rows("SELECT id FROM models")).toHaveLength(0); expect(db.rows("SELECT id FROM model_groups")).toHaveLength(0);
    seedVideoGroup(db); expect((await write(modelsApp, env, "/v1", invalid)).status).toBe(400); expect((await write(modelGroupsApp, env, "/vg", invalid)).status).toBe(400);
    expect(db.row("SELECT * FROM models WHERE id = 'v1'")).toMatchObject({ ...callOnly, cache_enabled: 0 }); expect(db.row("SELECT * FROM model_groups WHERE id = 'vg'")).toMatchObject({ ...callOnly, cache_enabled: 0 });
  });
  it.each(["anthropic", "gemini"])("rejects %s provider creates, reassignment and retagging", async provider_id => {
    const { db, env } = fixture(); expect((await write(modelsApp, env, "/", { provider_id, model_name: "v", ...callOnly, config_json: config() }, "POST")).status).toBe(400);
    seedVideo(db); expect((await write(modelsApp, env, "/v", { provider_id })).status).toBe(400);
    seedModel(db, { id: "other", model_name: "other", provider_id, ...callOnly }); expect((await write(modelsApp, env, "/other", { config_json: config() })).status).toBe(400);
  });
  it("checks inherited prices/cache on retagging and batch updates atomically", async () => {
    const { db, env } = fixture(); seedModel(db, { id: "old", model_name: "old", cache_enabled: 1 });
    expect((await write(modelsApp, env, "/old", { config_json: config() })).status).toBe(400);
    expect((await write(modelsApp, env, "/old", { ...callOnly, config_json: config(), cache_enabled: false })).status).toBe(200);
    seedModel(db, { id: "text", model_name: "text" });
    expect((await write(modelsApp, env, "/batch-update", { ids: ["text", "old"], cache_enabled: true }, "POST")).status).toBe(400);
    expect(db.rows("SELECT cache_enabled FROM models").every(r => r.cache_enabled === 0)).toBe(true);
    expect((await write(modelsApp, env, "/batch-update", { ids: ["old"], enabled: false }, "POST")).status).toBe(200);
  });
});

describe("video group and service mapping compatibility", () => {
  it("accepts compatible actual capabilities with different task ID paths/statuses and rejects narrowing", async () => {
    const { db, env } = fixture(); seedVideoGroup(db);
    const replace = (ids: string[]) => write(modelGroupsApp, env, "/vg/members", { members: ids.map(model_id => ({ model_id })) });
    expect((await replace(["v1", "v2"])).status).toBe(200);
    for (const bad of [{ sizes: ["1920x1080"] }, { seconds_min: 5 }, { seconds_max: 9 }]) {
      db.sql("UPDATE models SET config_json = ? WHERE id = 'v2'", config(bad)); expect((await replace(["v1", "v2"])).status).toBe(400);
      expect((await write(modelGroupsApp, env, "/vg", { display_name: "changed" })).status).toBe(400);
    }
    expect(db.rows("SELECT model_id FROM model_group_members WHERE group_id = 'vg'")).toHaveLength(2);
  });
  it("refuses mixed types including disabled members and non-openai/video invalid member rows", async () => {
    const { db, env } = fixture(); seedVideoGroup(db); seedModel(db, { id: "image", model_name: "image", ...callOnly });
    expect((await write(modelGroupsApp, env, "/vg/members", { members: [{ model_id: "image" }] })).status).toBe(400);
    seedGroupMembers(db, "vg", ["image"], 0); expect((await write(modelGroupsApp, env, "/vg", { display_name: "changed" })).status).toBe(400);
    seedGroupMembers(db, "vg", ["v1"]);
    for (const change of ["provider_id = 'gemini'", "billing_unit = 'token'", "input_price_per_m = 1", "cache_enabled = 1"]) {
      db.sql("UPDATE models SET provider_id = 'prov_a', billing_unit = 'call', input_price_per_m = 0, cache_enabled = 0 WHERE id = 'v1'"); db.sql("UPDATE models SET " + change + " WHERE id = 'v1'");
      expect((await write(modelGroupsApp, env, "/vg/members", { members: [{ model_id: "v1" }] })).status).toBe(400);
    }
  });
  it("preflights service mappings, selected member capabilities and call-only overrides without destroying valid mappings", async () => {
    const { db, env } = fixture(); seedVideoGroup(db); seedGroupMembers(db, "vg", ["v1", "v2"]);
    const created = await write(serviceGroupsApp, env, "/", { name: "service" }, "POST"); expect(created.status).toBe(201); const id = (await created.json() as any).item.id;
    const base = { model_key: "video-pool", target_type: "group", target_id: "vg", member_ids_json: ["v2"] };
    const replace = (mapping: unknown) => write(serviceGroupsApp, env, "/" + id + "/models", { models: [mapping] });
    expect((await replace(base)).status).toBe(200); const old = db.rows("SELECT * FROM service_group_models WHERE service_group_id = ?", id);
    for (const field of ["input_price_per_m", "output_price_per_m", "cache_read_price_per_m", "cache_write_price_per_m", "search_price_per_call"]) {
      const { billing_unit: _unit, ...pricing } = callOnly; expect((await replace({ ...base, pricing_json: { ...pricing, [field]: 1 } })).status).toBe(400); expect(db.rows("SELECT * FROM service_group_models WHERE service_group_id = ?", id)).toEqual(old);
    }
    db.sql("UPDATE models SET config_json = ? WHERE id = 'v2'", config({ seconds_min: 5 })); expect((await replace(base)).status).toBe(400); expect(db.rows("SELECT * FROM service_group_models WHERE service_group_id = ?", id)).toEqual(old);
    seedModel(db, { id: "image", model_name: "image", ...callOnly }); expect((await replace({ ...base, member_ids_json: ["image"] })).status).toBe(400);
  });
});
