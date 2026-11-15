import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { createServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import { modelGroupsApp } from "../src/admin/model-groups";
import { playgroundApp } from "../src/admin/playground";
import type { Env } from "../src/types";
import { CollectingExecutionContext, DEVICE_ID, TOKEN, createRealD1, makeEnv, makeKv, seedDevice, seedModel, seedProvider, seedGroup, seedGroupMembers, usageRows, ledgerRows, wallet, holdRows, type RealD1 } from "./helpers/realGatewayEnv";

let d1: RealD1, env: Env, kv: ReturnType<typeof makeKv>;
const publicModel = "public-multi";
const connections = {
  chat_completions: { base_url: "https://chat.example/prefix", path: "/chat", auth: "bearer" },
  responses: { base_url: "https://response.example/v1", secret_name: "RESPONSE_KEY" },
  messages: { base_url: "https://message.example/api/v1", path: "/custom/messages", auth: "x-api-key", secret_name: "MESSAGE_KEY", headers: { "anthropic-beta": "test-beta" } },
};
const models = { chat_completions: "private-chat", responses: "private-response", messages: "private-message" };
const nativeUsage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 400, cache_creation_input_tokens: 200 };
const signed = { type: "thinking", thinking: "native thought", signature: "opaque-signature-exact" };
const redacted = { type: "redacted_thinking", data: "opaque-redacted-exact" };
function providerConfig(value: unknown = connections) { d1.sql("UPDATE providers SET config_json = ? WHERE id = ?", JSON.stringify({ protocol_connections: value }), "prov_a"); }
function modelConfig(extra: Record<string, unknown> = {}) { d1.sql("UPDATE models SET config_json = ? WHERE id = ?", JSON.stringify({ protocol_models: models, ...extra }), "model_a"); }
function nativeObject() { return { id: "msg_local", type: "message", role: "assistant", model: models.messages, content: [signed, redacted, { type: "text", text: "hello" }, { type: "tool_use", id: "tool_local", name: "lookup", input: { model: "tool-data-not-identity" } }], stop_reason: "end_turn", usage: nativeUsage }; }
function json(obj: unknown) { return new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } }); }
function responseObject() { return { id: "resp_local", object: "response", status: "completed", model: models.responses, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }], usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 400 } } }; }
function chatObject() { return { id: "chat_local", object: "chat.completion", model: models.chat_completions, choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 400 } } }; }
function body(extra: Record<string, unknown> = {}) { return { model: publicModel, max_tokens: 2048, messages: [{ role: "user", content: "hello" }], ...extra }; }
type Call = { url: string; body: any; headers: Headers };
function upstream(factory: (call: Call, index: number) => Response = () => json(nativeObject())) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call = { url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) };
    calls.push(call); return factory(call, calls.length);
  });
  return calls;
}
async function request(path = "/messages", value: any = body(), affinity?: string) {
  const exec = new CollectingExecutionContext();
  const headers = new Headers({ "x-api-key": TOKEN, "content-type": "application/json", "anthropic-beta": "client-beta" });
  if (affinity) headers.set("x-cpg-affinity", affinity);
  const response = await gatewayApp.request("http://gw.test" + path, { method: "POST", headers, body: JSON.stringify(value) }, env, exec as never);
  const text = await response.text(); await Promise.all(exec.pending);
  return { response, text };
}
function billed(cost: number, count = 1) {
  expect(usageRows(d1)).toHaveLength(count); expect(ledgerRows(d1)).toHaveLength(count);
  expect(usageRows(d1).at(-1)?.cost_usd).toBeCloseTo(cost, 8);
  expect(wallet(d1)?.reserved_usd).toBe(0); expect(holdRows(d1)).toEqual([]);
}
beforeEach(async () => {
  resetRateLimitMemory(); clearMemoryCacheForTest(); d1 = createRealD1(); kv = makeKv(); env = makeEnv(d1, kv);
  env.SESSION_SECRET = "local-only-affinity-secret"; env.MESSAGE_KEY = "sk-local-messages"; env.RESPONSE_KEY = "sk-local-responses";
  await seedDevice(d1, { balance_usd: 100 }); seedProvider(d1, { type: "openai", api_key: "sk-local-shared" });
  seedModel(d1, { model_name: publicModel, cache_enabled: 1, cache_read_price_per_m: 1, cache_write_price_per_m: 4 });
  providerConfig(); modelConfig();
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });

describe("multiple native connections through actual gateway", () => {
  it("refuses legacy admin Playground for explicit connections instead of dialing an undeclared route", async () => {
    const calls = upstream();
    const response = await playgroundApp.request("http://gw.test/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) }, env);
    expect(response.status).toBe(409); expect((await response.json() as any).error).toBe("multi_protocol_test_requires_gateway");
    expect(calls).toEqual([]); expect(usageRows(d1)).toEqual([]);
  });
  it.each(["openai", "anthropic", "gemini"])("uses all three wire protocols independently of supplier %s", async type => {
    d1.sql("UPDATE providers SET type = ?", type);
    const calls = upstream(call => call.url.includes("chat.example") ? json(chatObject()) : call.url.includes("response.example") ? json(responseObject()) : json(nativeObject()));
    for (const [path, value] of [["/chat/completions", body()], ["/responses", { model: publicModel, input: "hello" }], ["/messages", body()]] as const) {
      const result = await request(path, value); expect(result.response.status, result.text).toBe(200);
      expect(JSON.parse(result.text).model).toBe(publicModel);
      expect(result.response.headers.get("x-cpg-protocol-route")).toBe(path.slice(1) + "->" + path.slice(1));
    }
    expect(calls.map(c => c.url)).toEqual(["https://chat.example/prefix/chat", "https://response.example/v1/responses", "https://message.example/api/v1/custom/messages"]);
    expect(calls.map(c => c.body.model)).toEqual(Object.values(models));
    expect(calls[0].headers.get("authorization")).toBe("Bearer sk-local-shared");
    expect(calls[1].headers.get("authorization")).toBe("Bearer sk-local-responses");
    expect(calls[2].headers.get("x-api-key")).toBe("sk-local-messages"); expect(calls[2].headers.get("authorization")).toBeNull();
    expect(calls[2].headers.get("anthropic-version")).toBe("2023-06-01"); expect(calls[2].headers.get("anthropic-beta")).toBe("test-beta");
    expect(calls[0].headers.get("anthropic-beta")).toBeNull();
    expect(usageRows(d1).map(r => r.cost_usd)).toEqual([0.0037, 0.0037, 0.0057]);
    expect(ledgerRows(d1)).toHaveLength(3); expect(kv.writes).toHaveLength(1); expect(kv.writes[0].key).toContain("chat/completions");
  });
  it("preserves Messages fields and native signed/redacted blocks without normalizing or caching", async () => {
    const calls = upstream();
    const system = [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }];
    const value = body({ system, thinking: { type: "adaptive" }, output_config: { effort: "high" }, tools: [{ name: "lookup", input_schema: { type: "object" } }], metadata: { user_id: "local" } });
    for (let i = 0; i < 2; i++) {
      const result = await request("/messages", value); expect(result.response.status, result.text).toBe(200);
      expect(JSON.parse(result.text).content).toEqual(nativeObject().content);
    }
    expect(calls).toHaveLength(2); expect(calls[0].body).toEqual({ ...value, model: models.messages });
    expect(kv.writes).toEqual([]); billed(0.0057, 2);
  });
  it("relays Messages SSE signature/tool/ping events unchanged and settles cumulative usage once", async () => {
    const frame = (type: string, extra: object) => "event: " + type + "\ndata: " + JSON.stringify({ type, ...extra }) + "\n\n";
    const wire = frame("message_start", { message: { ...nativeObject(), content: [], usage: { ...nativeUsage, output_tokens: 0 } } }) + frame("content_block_start", { index: 0, content_block: signed }) + frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "signature-suffix" } }) + frame("ping", {}) + frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: nativeUsage }) + frame("message_stop", {});
    const calls = upstream(() => new Response(wire, { headers: { "content-type": "text/event-stream" } }));
    const result = await request("/messages", body({ stream: true })); expect(result.response.status, result.text).toBe(200);
    expect(result.text).toContain("signature-suffix"); expect(result.text).toContain("event: ping"); expect(result.text).toContain(signed.signature);
    expect(result.response.headers.get("x-cpg-affinity")).toBeTruthy(); expect(calls).toHaveLength(1); billed(0.0057); expect(kv.writes).toEqual([]);
  });
  it.each([{}, { messages: { enabled: false } }, { chat_completions: {} }])("model declarations cannot create a missing/disabled provider connection %j", async config => {
    providerConfig(config); modelConfig({ protocol_capabilities: { messages: true } }); const calls = upstream();
    expect((await request()).response.status).toBe(400); expect(calls).toEqual([]); expect(ledgerRows(d1)).toEqual([]);
  });
  it("never falls back to shared key when an explicit connection secret is missing", async () => {
    delete env.MESSAGE_KEY; const calls = upstream(); expect((await request()).response.status).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]); expect(ledgerRows(d1)).toEqual([]); expect(wallet(d1)?.reserved_usd).toBe(0);
  });
  it.each(["legacy-group", "fixed-service", "auto-service", "same-name"].flatMap(selection => [true, false].map(working => [selection, working] as const)))("handles missing connection secrets in %s with working successor=%s", async (selection, working) => {
    delete env.MESSAGE_KEY;
    if (working) env.WORKING_MESSAGE_KEY = "sk-working-member";
    seedProvider(d1, { id: "working-provider", type: "openai", api_key: "sk-must-not-use-shared" });
    d1.sql("UPDATE providers SET config_json = ? WHERE id = ?", JSON.stringify({ protocol_connections: {
      messages: { ...connections.messages, base_url: "https://working.example/v1", secret_name: "WORKING_MESSAGE_KEY" },
    } }), "working-provider");
    seedModel(d1, { id: "working-model", provider_id: "working-provider", model_name: selection === "same-name" ? publicModel : "working-private", config_json: JSON.stringify({ protocol_models: models }) });
    seedGroup(d1, { name: "credential-pool", config_json: JSON.stringify({ member_retries: 2 }) });
    seedGroupMembers(d1, "grp_a", ["model_a", "working-model"]);
    let model = selection === "same-name" ? publicModel : "credential-pool";
    if (selection === "fixed-service" || selection === "auto-service") {
      const group = await createServiceGroup(env, { name: "credential-offer", public_selectable: 1, multiplier: 1 });
      await upsertServiceGroupModel(env, group.id, { model_key: publicModel, target_type: "group", target_id: "grp_a" });
      d1.sql("UPDATE devices SET service_group_id = ? WHERE id = ?", selection === "auto-service" ? "auto" : group.id, DEVICE_ID);
      model = publicModel;
    }
    const calls = upstream();
    const result = await request("/messages", body({ model }));
    if (!working) {
      expect(result.response.status).toBe(502); expect(calls).toEqual([]);
      expect(usageRows(d1)).toEqual([]); expect(ledgerRows(d1)).toEqual([]);
      expect(wallet(d1)?.balance_usd).toBe(100); expect(wallet(d1)?.reserved_usd).toBe(0);
      expect(holdRows(d1)).toEqual([]); return;
    }
    expect(result.response.status, result.text).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://working.example/v1/custom/messages");
    expect(calls[0].headers.get("x-api-key")).toBe("sk-working-member");
    expect(calls[0].body.model).toBe(selection === "fixed-service" || selection === "auto-service" ? "working-private" : models.messages);
    expect(JSON.parse(result.text).model).toBe(model);
    expect(usageRows(d1)).toHaveLength(1); expect(ledgerRows(d1)).toHaveLength(1);
    expect(wallet(d1)?.balance_usd).toBeCloseTo(100 - Number(usageRows(d1)[0].cost_usd), 8);
    expect(wallet(d1)?.reserved_usd).toBe(0); expect(holdRows(d1)).toEqual([]);
  });
  it("resets missing Messages receipts but preserves valid native opaque history", async () => {
    const calls = upstream(); const replay = body({ messages: [{ role: "assistant", content: [signed, redacted] }, { role: "user", content: "continue" }] });
    const reset = await request("/messages", replay); expect(reset.response.status, reset.text).toBe(200);
    expect(reset.response.headers.get("x-cpg-state-reset")).toBe("opaque-state-dropped");
    expect(calls[0].body.messages).toEqual([{ role: "user", content: "continue" }]);
    const initial = await request(); const token = initial.response.headers.get("x-cpg-affinity")!; expect(token).toBeTruthy();
    const accepted = await request("/messages", replay, token); expect(accepted.response.status, accepted.text).toBe(200);
    expect(calls[2].body.messages).toEqual(replay.messages); expect(calls[2].headers.get("x-cpg-affinity")).toBeNull(); billed(0.0057, 3);
  });
  it.each(["endpoint", "auth", "secret", "model"])("resets opaque replay after selected connection %s changes", async field => {
    const calls = upstream(); const token = (await request()).response.headers.get("x-cpg-affinity")!;
    if (field === "model") modelConfig({ protocol_models: { ...models, messages: "other-message-id" } });
    else { const changed = { ...connections, messages: { ...connections.messages } }; if (field === "endpoint") changed.messages.base_url = "https://other.example/v1"; if (field === "auth") changed.messages.auth = "bearer"; if (field === "secret") env.MESSAGE_KEY = "sk-rotated-local"; providerConfig(changed); }
    const result = await request("/messages", body({ messages: [{ role: "assistant", content: [signed, { type: "text", text: "answer" }] }, { role: "user", content: "continue" }] }), token);
    expect(result.response.status, result.text).toBe(200); expect(calls).toHaveLength(2); billed(0.0057, 2);
    expect(result.response.headers.get("x-cpg-state-reset")).toBe("opaque-state-dropped");
    expect(calls[1].body.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "answer" }] }, { role: "user", content: "continue" }]);
  });
  it("filters a heterogeneous pool per inbound protocol and preserves Messages thinking", async () => {
    seedProvider(d1, { id: "legacy", type: "openai" }); seedModel(d1, { id: "legacy-model", provider_id: "legacy", model_name: "legacy-only" });
    seedGroup(d1, { name: "mixed-pool", config_json: JSON.stringify({ supports_reasoning: false }) }); seedGroupMembers(d1, "grp_a", ["legacy-model", "model_a"]);
    const calls = upstream(); const result = await request("/messages", body({ model: "mixed-pool", thinking: { type: "adaptive" } }));
    expect(result.response.status, result.text).toBe(200); expect(calls).toHaveLength(1); expect(calls[0].body.thinking).toEqual({ type: "adaptive" }); expect(calls[0].url).toContain("message.example");
  });
  it("allows saving mixed supplier labels but retains model-type checks", async () => {
    seedProvider(d1, { id: "legacy", type: "anthropic" }); seedModel(d1, { id: "legacy-model", provider_id: "legacy" }); seedGroup(d1);
    const saved = await modelGroupsApp.request("http://admin/grp_a/members", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ members: [{ model_id: "model_a" }, { model_id: "legacy-model" }] }) }, env);
    expect(saved.status, await saved.text()).toBe(200);
  });
  it("does not turn missing local credentials into a compatibility Auto price upgrade", async () => {
    delete env.MESSAGE_KEY;
    seedProvider(d1, { id: "expensive-provider", type: "anthropic", endpoint: "https://expensive.example/v1" });
    seedModel(d1, { id: "expensive-model", provider_id: "expensive-provider", model_name: publicModel });
    d1.sql("UPDATE devices SET service_group_id = ? WHERE id = ?", "auto", DEVICE_ID);
    for (const [name, id, multiplier] of [["cheap-missing", "model_a", 1], ["expensive-working", "expensive-model", 3]] as const) {
      const group = await createServiceGroup(env, { name, public_selectable: 1, multiplier });
      await upsertServiceGroupModel(env, group.id, { model_key: publicModel, target_type: "model", target_id: id });
    }
    const calls = upstream(); const result = await request();
    expect(result.response.status).toBe(502); expect(calls).toEqual([]);
    expect(usageRows(d1)).toEqual([]); expect(ledgerRows(d1)).toEqual([]);
    expect(wallet(d1)?.balance_usd).toBe(100); expect(wallet(d1)?.reserved_usd).toBe(0); expect(holdRows(d1)).toEqual([]);
  });
  it("preserves Auto price order rather than prioritizing another supplier label", async () => {
    seedProvider(d1, { id: "other", type: "anthropic", endpoint: "https://expensive.example/v1" }); seedModel(d1, { id: "other-model", provider_id: "other", model_name: publicModel });
    d1.sql("UPDATE devices SET service_group_id = ? WHERE id = ?", "auto", DEVICE_ID);
    for (const [name, id, multiplier] of [["cheap", "model_a", 1], ["expensive", "other-model", 3]] as const) {
      const group = await createServiceGroup(env, { name, public_selectable: 1, multiplier });
      await upsertServiceGroupModel(env, group.id, { model_key: publicModel, target_type: "model", target_id: id });
    }
    const calls = upstream(); const result = await request(); expect(result.response.status, result.text).toBe(200);
    expect(calls).toHaveLength(1); expect(calls[0].url).toContain("message.example"); billed(0.0057);
  });
});
