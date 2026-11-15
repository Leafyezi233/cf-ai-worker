import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateProviderSchema, UpdateProviderSchema, CcSwitchImportItemSchema, CreateModelSchema, UpdateModelSchema, CreateModelGroupSchema, UpdateModelGroupSchema } from "../src/admin/schemas";
import { serviceGroupsApp } from "../src/admin/service-groups";
import { gatewayApp } from "../src/gateway";
import { readProtocolCapabilities, planProtocolRoute } from "../src/gateway/protocol_capabilities";
import { protocolModelName, protocolTargetUrl, readConnectionSet } from "../src/gateway/protocol_connections";
import { aggregateProtocolMetadata } from "../src/gateway/protocol_metadata";
import { preferredModelEndpoint } from "../src/gateway/catalog";
import { serializeConsoleModel } from "../src/console/model_marketplace";
import { listModelProjectionsForDevice } from "../src/db/repo";
import { ensureSchema } from "../src/db/schema";
import type { DeviceRow, Env } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, TOKEN, makeEnv, seedDevice, seedProvider, seedModel, seedGroup, seedGroupMembers } from "./helpers/realGatewayEnv";

const chat = "/v1/chat/completions", responses = "/v1/responses", messages = "/v1/messages";
const providerCases = [
  { name: "create", schema: CreateProviderSchema, required: { name: "supplier", type: "openai" } },
  { name: "update", schema: UpdateProviderSchema, required: {} },
  { name: "import", schema: CcSwitchImportItemSchema, required: { name: "supplier", type: "openai" } },
];
const modelCases = [
  { name: "create model", schema: CreateModelSchema, required: { provider_id: "supplier", model_name: "public" } },
  { name: "update model", schema: UpdateModelSchema, required: {} },
  { name: "create group", schema: CreateModelGroupSchema, required: { name: "public" } },
  { name: "update group", schema: UpdateModelGroupSchema, required: {} },
];
afterEach(() => vi.restoreAllMocks());

describe.each(providerCases)("provider protocol config $name", ({ schema, required }) => {
  it("accepts multiple native connections and preserves unrelated config verbatim", () => {
    const config_json = JSON.stringify({ custom: { legacy: true }, protocol_connections: {
      chat_completions: {}, responses: { base_url: "https://responses.example/v1", path: "/responses", auth: "bearer" },
      messages: { base_url: "https://messages.example/v1", auth: "x-api-key", secret_name: "MESSAGES_KEY", version: "2023-06-01", headers: { "anthropic-beta": "feature-1" } },
    } });
    expect(schema.parse({ ...required, config_json }).config_json).toBe(config_json);
  });
  it.each([undefined, null, "", "{}", '{"legacy":true}'])("preserves legacy/empty config %j", config_json => {
    expect(schema.parse({ ...required, config_json }).config_json).toBe(config_json);
  });
  it.each([
    null, [], { completions: {} }, { messages: null }, { responses: { enabled: "yes" } },
    { messages: { api_key: "raw-secret" } }, { messages: { secret_name: "DB" } },
    { messages: { secret_name: "SESSION_SECRET" } }, { messages: { auth: "cookie" } },
    { responses: { base_url: "https://user:pass@example.test/v1" } },
    { responses: { base_url: "https://example.test/v1?api_key=raw" } },
    { responses: { path: "/%2e%2e/secret" } }, { responses: { path: "//evil.test" } },
    { responses: { path: "/messages%00" } }, { responses: { path: "/messages%7f" } },
    { messages: { headers: { authorization: "raw-secret" } } }, { messages: { version: "bad\r\nheader" } },
  ])("rejects invalid connection allowlist %j", protocol_connections => {
    expect(schema.safeParse({ ...required, config_json: JSON.stringify({ protocol_connections }) }).success).toBe(false);
  });
  it("rejects malformed JSON", () => {
    const result = schema.safeParse({ ...required, config_json: "{truncated" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].path).toEqual(["config_json"]);
  });
});

describe.each(modelCases)("model protocol config $name", ({ schema, required }) => {
  it("accepts all three per-protocol IDs and messages capability", () => {
    const config_json = JSON.stringify({ custom: "keep", protocol_models: { chat_completions: "chat-id", responses: "responses-id", messages: "messages-id" }, protocol_capabilities: { chat_completions: true, responses: true, messages: true, loss_policy: "safe" } });
    expect(schema.parse({ ...required, config_json }).config_json).toBe(config_json);
  });
  it.each([null, [], { "chat/completions": "id" }, { unknown: "id" }, { messages: "" }, { messages: "   " }, { responses: 7 }, { chat_completions: "x".repeat(151) }])("rejects malformed protocol_models %j", protocol_models => {
    expect(schema.safeParse({ ...required, config_json: JSON.stringify({ protocol_models }) }).success).toBe(false);
  });
  it.each([null, [], { messages: "yes" }, { messages_route: "native" }, { chat_route: "messages" }, { loss_policy: "unknown" }])("rejects malformed protocol_capabilities %j", protocol_capabilities => {
    expect(schema.safeParse({ ...required, config_json: JSON.stringify({ protocol_capabilities }) }).success).toBe(false);
  });
  it.each([undefined, null, "", "{}", '{"capabilities":"legacy","custom":true}'])("preserves legacy/empty config %j", config_json => {
    expect(schema.parse({ ...required, config_json }).config_json).toBe(config_json);
  });
  it("rejects malformed JSON", () => {
    expect(schema.safeParse({ ...required, config_json: "{truncated" }).success).toBe(false);
  });
});

describe("local multi-native defaults and allowlists", () => {
  const multi = (protocol_connections: unknown, config: object = {}, provider_type = "openai") => ({
    provider_type, billing_unit: "token", model_name: "legacy-model", config_json: JSON.stringify(config),
    provider_endpoint: "https://supplier.example/v1", provider_config_json: JSON.stringify({ protocol_connections }),
  });
  it.each(["openai", "anthropic", "gemini"])("defaults every declared native transport independently of %s supplier identity", provider_type => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline test"));
    const row = multi({ chat_completions: {}, responses: {}, messages: {} }, {}, provider_type);
    expect(readProtocolCapabilities(row)).toMatchObject({ chat_completions: true, responses: true, messages: true, source: "configured", loss_policy: "safe", supported_endpoints: [chat, responses, messages] });
    for (const kind of ["chat/completions", "responses", "messages"] as const) expect(planProtocolRoute(row, kind, true)).toBe(kind);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps explicit allowlists authoritative even over positive model declarations", () => {
    const row = multi({ messages: {} }, { protocol_capabilities: { chat_completions: true, responses: true, messages: true } });
    expect(readProtocolCapabilities(row).supported_endpoints).toEqual([messages]);
    expect(preferredModelEndpoint(row)).toBe(messages);
    expect(planProtocolRoute(row, "responses")).toBeNull();
    expect(readProtocolCapabilities(multi({})).supported_endpoints).toEqual([]);
    expect(preferredModelEndpoint(multi({}))).toBeNull();
    expect(readProtocolCapabilities(multi({ messages: { enabled: false } })).supported_endpoints).toEqual([]);
  });
  it("fails closed for malformed explicit provider declarations", () => {
    for (const provider_config_json of ["{bad", '{"protocol_connections":null}', '{"protocol_connections":{"unknown":{}}}']) {
      const row = { ...multi({}), provider_config_json };
      expect(readConnectionSet(row)).toMatchObject({ explicit: true, valid: false });
      expect(readProtocolCapabilities(row).supported_endpoints).toEqual([]);
    }
  });
  it("uses per-protocol upstream model IDs and safe per-connection URLs", () => {
    const row = multi({ responses: { base_url: "https://native.example/root/", path: "/answer" }, messages: {} }, { protocol_models: { responses: "responses-id", messages: "messages-id" } });
    expect(protocolModelName(row, "responses")).toBe("responses-id");
    expect(protocolModelName(row, "messages")).toBe("messages-id");
    expect(protocolModelName(row, "chat/completions")).toBe("legacy-model");
    expect(protocolTargetUrl(row, "responses")).toBe("https://native.example/root/answer");
    expect(protocolTargetUrl(row, "chat/completions")).toBeNull();
  });
  it("prefers a native callable interface over a bridged one and honors strict mode", () => {
    const row = multi({ responses: {} });
    expect(readProtocolCapabilities(row).supported_endpoints).toEqual([chat, responses]);
    expect(preferredModelEndpoint(row)).toBe(responses);
    expect(readProtocolCapabilities(multi({ responses: {} }, { protocol_capabilities: { loss_policy: "strict" } })).supported_endpoints).toEqual([responses]);
  });
  it("preserves legacy behavior without explicit connections and legacy Responses overrides", () => {
    const legacy = { provider_type: "openai", config_json: "{}" };
    expect(readProtocolCapabilities(legacy)).toMatchObject({ source: "legacy", supported_endpoints: [chat, responses], upstream_endpoints: [chat] });
    expect(readProtocolCapabilities({ ...legacy, provider_type: "anthropic" }).supported_endpoints).toEqual([messages]);
    expect(readProtocolCapabilities(multi({ chat_completions: {}, responses: {} }, { responses_mode: "disabled" })).supported_endpoints).toEqual([chat]);
    expect(planProtocolRoute(multi({ chat_completions: {}, responses: {} }, { responses_mode: "chat_adapter" }), "responses")).toBe("chat/completions");
  });
  it.each(["disabled", "chat_adapter", "native"])("preserves explicit Responses policy %s when adding unrelated Messages capability", responses_mode => {
    const row = multi({ chat_completions: {}, responses: {}, messages: {} }, { responses_mode, protocol_capabilities: { messages: false } });
    expect(planProtocolRoute(row, "responses")).toBe(responses_mode === "disabled" ? null : responses_mode === "chat_adapter" ? "chat/completions" : "responses");
    expect(readProtocolCapabilities(row).supported_endpoints.includes(responses)).toBe(responses_mode !== "disabled");
  });
  it("allows an explicit new Responses route to override the inherited legacy policy", () => {
    const row = multi({ chat_completions: {}, responses: {} }, { responses_mode: "chat_adapter", protocol_capabilities: { responses_route: "native" } });
    expect(planProtocolRoute(row, "responses")).toBe("responses");
  });
  it("aggregates heterogeneous suppliers using actual effective member protocols", () => {
    const result = aggregateProtocolMetadata([multi({ responses: {} }), multi({ messages: {} }, {}, "gemini")]);
    expect(result.supported_endpoints).toEqual([chat, responses, messages]);
    expect(result.member_support[messages]).toMatchObject({ native: 1, bridge: 0, unsupported: 1 });
    expect(preferredModelEndpoint({ protocol_metadata: result })).toBe(responses);
  });
});

describe("offline metadata and service-group integration", () => {
  let d1: RealD1, env: Env;
  beforeEach(async () => {
    d1 = createRealD1(); env = makeEnv(d1); await seedDevice(d1);
    seedProvider(d1, { api_key: "credential-marker" });
    seedProvider(d1, { id: "anthropic", type: "anthropic" });
    seedModel(d1, { id: "public", model_name: "public-model" });
    seedModel(d1, { id: "other", provider_id: "anthropic", model_name: "other-model" });
    d1.sql("UPDATE devices SET service_group_id = 'legacy' WHERE id = ?", DEVICE_ID);
    await ensureSchema(env);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("metadata must remain offline"));
  });
  afterEach(() => d1.close());
  async function get(path: string) {
    const response = await gatewayApp.request("https://gw.test" + path, { headers: { authorization: "Bearer " + TOKEN } }, env);
    expect(response.status).toBe(200); return await response.json() as any;
  }
  async function replace(members: string[], extra: Record<string, unknown> = {}) {
    return serviceGroupsApp.request("https://admin.test/service/models", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: [{ id: "mapping", model_key: "public-model", target_type: "model", target_id: "public", member_ids_json: members, ...extra }] }),
    }, env);
  }
  function seedService() {
    d1.sql("INSERT INTO service_groups(id,name,enabled,selectable,public_selectable,multiplier,revision) VALUES('service','service',1,1,1,1,1)");
  }
  function assertPrivate(value: unknown) {
    const json = JSON.stringify(value);
    for (const secret of ["credential-marker", "private-native.example", "PRIVATE_NATIVE_KEY", "provider_config_json", "protocol_connections", "protocol_models", "responses-upstream-id"]) expect(json).not.toContain(secret);
  }
  it.each(["responses", "messages"])("propagates actual %s-only transport to list/detail/catalog/console without leaking config", async kind => {
    const endpoint = kind === "responses" ? responses : messages;
    d1.sql("UPDATE providers SET config_json = ? WHERE id = 'prov_a'", JSON.stringify({ protocol_connections: { [kind]: { base_url: "https://private-native.example/v1", secret_name: "PRIVATE_NATIVE_KEY" } } }));
    d1.sql("UPDATE models SET config_json = ? WHERE id = 'public'", JSON.stringify({ protocol_models: { [kind]: "responses-upstream-id" }, chat_endpoint: "forged" }));
    const list = await get("/models"), detail = await get("/models/public-model"), catalog = await get("/model-catalog.json");
    const listed = list.data.find((row: any) => row.id === "public-model");
    const entry = catalog.models.find((row: any) => row.slug === "public-model");
    for (const row of [listed, detail, entry]) { expect(row.chat_endpoint).toBe(endpoint); expect(row.protocol_capabilities.supported_endpoints).toContain(endpoint); assertPrivate(row); }
    const device = d1.row<DeviceRow>("SELECT * FROM devices WHERE id = ?", DEVICE_ID)!;
    const projected = (await listModelProjectionsForDevice(env, device)).find(row => row.id === "public")!;
    const consoleRow = serializeConsoleModel(projected, new Map(), Date.now(), 0);
    expect(consoleRow.chat_endpoint).toBe(endpoint);
    expect(consoleRow.protocol_capabilities).toEqual({ supported_endpoints: listed.protocol_capabilities.supported_endpoints });
    assertPrivate(consoleRow); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("publishes no invented endpoint for an explicitly empty allowlist", async () => {
    d1.sql("UPDATE providers SET config_json = ? WHERE id = 'prov_a'", '{"protocol_connections":{}}');
    expect((await get("/models/public-model"))).toMatchObject({ chat_endpoint: null, protocol_capabilities: { supported_endpoints: [] } });
  });
  it("accepts mixed supplier-family overrides and publishes their protocol union", async () => {
    seedService();
    const saved = await replace(["public", "other"]);
    expect(saved.status).toBe(200);
    d1.sql("UPDATE devices SET service_group_id = 'service' WHERE id = ?", DEVICE_ID);
    const row = (await get("/models")).data.find((item: any) => item.id === "public-model");
    expect(row.protocol_capabilities).toMatchObject({ member_count: 2, supported_endpoints: [chat, responses, messages] });
    expect(row.chat_endpoint).toBe(chat); assertPrivate(row);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each(["unit", "type"])("still rejects mixed %s overrides atomically", async mismatch => {
    seedService();
    if (mismatch === "unit") d1.sql("UPDATE models SET billing_unit = 'call' WHERE id = 'other'");
    else d1.sql("UPDATE models SET config_json = ? WHERE id = 'other'", '{"model_type":"embedding"}');
    const saved = await replace(["public", "other"]);
    expect(saved.status).toBe(400);
    expect(await saved.json()).toMatchObject({ error: mismatch === "unit" ? "incompatible_billing_unit" : "incompatible_model_type" });
    expect(d1.rows("SELECT * FROM service_group_models")).toEqual([]);
  });
  it("uses effective group members rather than supplier-derived defaults for service metadata", async () => {
    seedService(); seedGroup(d1, { id: "pool", name: "public-model" }); seedGroupMembers(d1, "pool", ["public", "other"]);
    d1.sql("UPDATE providers SET config_json = ? WHERE id = 'anthropic'", '{"protocol_connections":{"responses":{}}}');
    const saved = await replace(["other"], { target_type: "group", target_id: "pool" });
    expect(saved.status).toBe(200);
    d1.sql("UPDATE devices SET service_group_id = 'service' WHERE id = ?", DEVICE_ID);
    const row = await get("/models/public-model");
    expect(row).toMatchObject({ chat_endpoint: responses, protocol_capabilities: { member_count: 1, messages: false, responses: true } });
    assertPrivate(row); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
