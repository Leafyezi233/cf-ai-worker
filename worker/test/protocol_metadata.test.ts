import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { aggregateProtocolMetadata, resolveProtocolMetadata } from "../src/gateway/protocol_metadata";
import type { ProtocolMetadataInput } from "../src/gateway/protocol_metadata";
import { readProtocolCapabilities } from "../src/gateway/protocol_capabilities";
import { buildModelCatalog } from "../src/gateway/catalog";
import { gatewayApp } from "../src/gateway";
import { serializeConsoleModel } from "../src/console/model_marketplace";
import { listGroupsForDevice, listModelProjectionsForDevice } from "../src/db/repo";
import { ensureSchema } from "../src/db/schema";
import type { DeviceRow, Env } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, TOKEN, makeEnv, seedDevice, seedGroup, seedGroupMembers, seedModel, seedProvider } from "./helpers/realGatewayEnv";

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const squarePath = "../../web/src/components/ConsoleModelsSquare.tsx";
const { ModelOfferCard } = await import(squarePath);

const chat = "/v1/chat/completions", responses = "/v1/responses";
const input = (protocols?: Record<string, unknown>, extra: Partial<ProtocolMetadataInput> = {}): ProtocolMetadataInput => ({
  provider_type: "openai", billing_unit: "token", config_json: JSON.stringify(protocols ? { protocol_capabilities: protocols } : {}), ...extra,
});
const chatOnly = () => input({ chat_completions: true, responses: false, responses_route: "chat", loss_policy: "safe" });
const responsesOnly = () => input({ chat_completions: false, responses: true, chat_route: "responses", loss_policy: "safe" });
function noSecrets(value: unknown) {
  const json = JSON.stringify(value);
  for (const marker of ["provider_id", "provider_endpoint", "provider_api_key", "provider_secret_name", "config_json", "member_ids_json", "secret-marker", "https://a.example"]) expect(json).not.toContain(marker);
}

describe("per-offer protocol discovery UI", () => {
  it("shows callable interfaces without backend member counts or topology", () => {
    const protocol_capabilities = aggregateProtocolMetadata([chatOnly(), responsesOnly()]);
    const html = renderToStaticMarkup(createElement(ModelOfferCard, { m: {
      id: "offer", model_name: "shared", service_group_id: "offer-group", service_group_name: "public-offer",
      pricing_mode: "free", billing_unit: "token", chat_endpoint: chat, supports_reasoning: false,
      input_price_per_m: 0, output_price_per_m: 0, protocol_capabilities,
    } }));
    const text = html.replace(/<[^>]*>/g, "");
    expect(text).toContain(chat); expect(text).toContain(responses);
    for (const hidden of ["路由成员", "成员路径", "原生 1", "转换 1", "不支持 0", "执行至", "Chat 路由", "Responses 路由", "转换损失策略"]) expect(text).not.toContain(hidden);
    expect(text).toContain("支持的请求接口"); noSecrets(html);
  });
  it("hides raw offer upstream and conversion settings while retaining callable interfaces", () => {
    const html = renderToStaticMarkup(createElement(ModelOfferCard, { m: {
      id: "offer", model_name: "shared", service_group_id: null, service_group_name: "public-offer",
      pricing_mode: "free", chat_endpoint: chat, supports_reasoning: false,
      protocol_capabilities: readProtocolCapabilities(responsesOnly()),
    } }));
    const text = html.replace(/<[^>]*>/g, "");
    expect(text).toContain(chat); expect(text).toContain(responses);
    for (const hidden of ["→", "（转换）", "（原生）", "上游原生接口", "Chat 路由", "Responses 路由"]) expect(text).not.toContain(hidden);
    noSecrets(html);
  });
});

describe("pure protocol discovery metadata", () => {
  it("uses exactly the core reader for raw models and preserves legacy modes", () => {
    for (const row of [input(), chatOnly(), responsesOnly(), input(undefined, { config_json: '{"responses_mode":"native"}' }), input(undefined, { config_json: '{"responses_mode":"disabled"}' }), input(undefined, { provider_type: "anthropic" }), input(undefined, { billing_unit: "call" }), input(undefined, { config_json: "{bad" })]) {
      expect(resolveProtocolMetadata(row)).toBe(readProtocolCapabilities(row)); noSecrets(resolveProtocolMetadata(row));
    }
  });
  it("unions incoming support while counting native and bridged members separately", () => {
    const result = aggregateProtocolMetadata([chatOnly(), responsesOnly()]);
    expect(result.supported_endpoints).toEqual([chat, responses]);
    expect(result).toMatchObject({ source: "members", member_count: 2, chat_completions: true, responses: true });
    expect(result.member_support[chat]).toEqual({ native: 1, bridge: 1, unsupported: 0, upstream_endpoints: { [chat]: 1, [responses]: 1 } });
    expect(result.member_support[responses]).toEqual({ native: 1, bridge: 1, unsupported: 0, upstream_endpoints: { [chat]: 1, [responses]: 1 } });
    noSecrets(result);
  });
  it("counts unsupported members under strict/native-only settings and preserves empty pools", () => {
    const result = aggregateProtocolMetadata([input({ chat_completions: true, responses: false, loss_policy: "strict" }), responsesOnly()]);
    expect(result.member_support[responses]).toMatchObject({ native: 1, bridge: 0, unsupported: 1 });
    expect(result.loss_policy).toBe("mixed");
    expect(aggregateProtocolMetadata([])).toMatchObject({ member_count: 0, supported_endpoints: [], upstream_endpoints: [] });
  });
  it("retains leaf counts across nested Auto offers rather than treating each offer as one member", () => {
    const pool = aggregateProtocolMetadata([chatOnly(), responsesOnly()]);
    const result = aggregateProtocolMetadata([{ protocol_metadata: pool }, chatOnly()]);
    expect(result).toMatchObject({ member_count: 3 });
    expect(result.member_support[responses]).toMatchObject({ native: 1, bridge: 2, unsupported: 0 });
  });
  it("reports non-OpenAI incoming protocols without pretending they bridge Chat/Responses", () => {
    const result = aggregateProtocolMetadata([input(undefined, { provider_type: "anthropic" }), input(undefined, { billing_unit: "call" })]);
    expect(result.supported_endpoints).toEqual(["/v1/messages", "/v1/images/generations"]);
    expect(result.member_support[chat]).toMatchObject({ native: 0, bridge: 0, unsupported: 2 });
    expect(result.member_support["/v1/messages"]).toMatchObject({ native: 1, bridge: 0, unsupported: 1 });
  });
});

let d1: RealD1, env: Env;
function device() { return d1.row<DeviceRow>("SELECT * FROM devices WHERE id = ?", DEVICE_ID)!; }
function select(id: string) { d1.sql("UPDATE devices SET service_group_id = ? WHERE id = ?", id, DEVICE_ID); }
function service(id: string, target: string, members: string[] | null, kind = "group", multiplier = 1) {
  d1.sql("INSERT INTO service_groups(id,name,enabled,selectable,public_selectable,multiplier,revision) VALUES(?,?,1,1,1,?,1)", id, id, multiplier);
  d1.sql("INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id,member_ids_json) VALUES(?,?,'shared',?,?,?)", id + "-mapping", id, kind, target, members === null ? null : JSON.stringify(members));
}
async function get(path: string) {
  const res = await gatewayApp.request("https://gw.test" + path, { headers: { authorization: "Bearer " + TOKEN } }, env);
  expect(res.status).toBe(200); return await res.json() as any;
}
beforeEach(async () => {
  d1 = createRealD1(); env = makeEnv(d1); await seedDevice(d1); seedProvider(d1, { api_key: "secret-marker" });
  seedModel(d1, { id: "chat", model_name: "upstream-chat", alias: "chat-alias", config_json: chatOnly().config_json });
  seedModel(d1, { id: "responses", model_name: "upstream-responses", config_json: responsesOnly().config_json });
  seedGroup(d1, { id: "pool", name: "pool", config_json: JSON.stringify({ protocol_capabilities: { chat_completions: false, responses: false, loss_policy: "strict" }, provider_api_key: "secret-marker" }) });
  seedGroupMembers(d1, "pool", ["chat", "responses"]); select("legacy"); await ensureSchema(env);
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });

describe("shared safe protocol discovery projections", () => {
  it("keeps gateway metadata intact but projects only callable interfaces to console without upstream calls", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected upstream probe"));
    const list = await get("/models"), catalog = await get("/model-catalog.json");
    for (const row of await listModelProjectionsForDevice(env, device())) {
      const expected = resolveProtocolMetadata(row);
      for (const name of [row.model_name, row.alias].filter((v): v is string => !!v)) {
        expect(list.data.find((item: any) => item.id === name).protocol_capabilities).toEqual(expected);
        expect((await get("/models/" + name)).protocol_capabilities).toEqual(expected);
      }
      expect(catalog.models.find((item: any) => item.slug === (row.alias || row.model_name)).protocol_capabilities).toEqual(expected);
      const consoleCapabilities = serializeConsoleModel(row, new Map(), Date.now(), 0).protocol_capabilities;
      expect(consoleCapabilities).toEqual({ supported_endpoints: expected.supported_endpoints });
      for (const hidden of ["member_count", "member_support", "upstream_endpoints", "chat_route", "responses_route", "source", "loss_policy"]) expect(consoleCapabilities).not.toHaveProperty(hidden);
    }
    expect(fetch).not.toHaveBeenCalled(); noSecrets(list); noSecrets(catalog);
  });
  it("ignores fake group config and uses only enabled effective member support", async () => {
    let pool = (await listGroupsForDevice(env, device())).find(row => row.id === "pool")!;
    expect(resolveProtocolMetadata(pool)).toMatchObject({ member_count: 2, supported_endpoints: [chat, responses] });
    d1.sql("UPDATE models SET enabled = 0 WHERE id = 'responses'");
    pool = (await listGroupsForDevice(env, device())).find(row => row.id === "pool")!;
    expect(resolveProtocolMetadata(pool)).toMatchObject({ member_count: 1, responses: false });
  });
  it("aggregates selected service members rather than target defaults or group config", async () => {
    service("fixed", "pool", ["responses"]); select("fixed");
    const listed = (await get("/models")).data[0].protocol_capabilities;
    expect(listed).toMatchObject({ source: "members", member_count: 1, chat_completions: false, responses: true });
    expect(listed.member_support[chat]).toMatchObject({ native: 0, bridge: 1, unsupported: 0 });
    expect((await get("/models/shared")).protocol_capabilities).toEqual(listed);
  });
  it("aggregates all reachable Auto offers, not just the cheapest selected price row", async () => {
    service("cheap", "chat", null, "model", 0.1); service("expensive", "responses", null, "model", 10); select("auto");
    const listed = (await get("/models")).data.find((row: any) => row.id === "shared").protocol_capabilities;
    expect(listed).toMatchObject({ member_count: 2, chat_completions: true, responses: true });
    expect(listed.member_support[responses]).toMatchObject({ native: 1, bridge: 1 });
    expect((await get("/models/shared")).protocol_capabilities).toEqual(listed);
    expect((await get("/model-catalog.json")).models.find((row: any) => row.slug === "shared").protocol_capabilities).toEqual(listed);
    noSecrets(listed);
  });
  it("does not allow config/template spreading to forge public protocol metadata", async () => {
    const row = (await listModelProjectionsForDevice(env, device())).find(row => row.id === "chat")!;
    row.config_json = JSON.stringify({ ...JSON.parse(chatOnly().config_json!), supported_endpoints: ["secret-marker"], protocol_metadata: { supported_endpoints: ["secret-marker"] }, provider_id: "secret-marker", chat_endpoint: "secret-marker" });
    const entry = buildModelCatalog([row]).models[0];
    expect(entry.protocol_capabilities).toEqual(readProtocolCapabilities(row));
    expect(entry.chat_endpoint).toBe(chat); noSecrets(entry);
  });
  it("extends existing batched SELECTs without extra queries per model/group", async () => {
    const prepare = vi.spyOn(env.DB, "prepare"); await listGroupsForDevice(env, device()); const count = prepare.mock.calls.length;
    for (let i = 0; i < 30; i++) { seedGroup(d1, { id: "pool-" + i, name: "pool-" + i }); seedGroupMembers(d1, "pool-" + i, ["chat", "responses"]); }
    prepare.mockClear(); const rows = await listGroupsForDevice(env, device());
    expect(rows).toHaveLength(31); expect(prepare.mock.calls.length).toBe(count);
    expect(rows.every(row => resolveProtocolMetadata(row).supported_endpoints.includes(responses))).toBe(true);
  });
});
