import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { createServiceGroup, setDeviceServiceGroups, updateServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import type { Env } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { CollectingExecutionContext, DEVICE_ID, chatBody, makeEnv, makeKv, openAiAnswer, postJson,
  seedDevice, seedGroup, seedGroupMembers, seedModel, seedProvider, wallet, openAiStreamFrames, sseAnswer } from "./helpers/realGatewayEnv";

let d1: RealD1;
let env: Env;
let kv: ReturnType<typeof makeKv>;
beforeEach(async () => {
  resetRateLimitMemory();
  clearMemoryCacheForTest();
  d1 = createRealD1();
  d1.DB.batch = async (statements: Array<{ sql: string; all: () => Promise<unknown>; run: () => Promise<unknown> }>) => {
    const results = [];
    for (const statement of statements) results.push(await (/^\s*SELECT/i.test(statement.sql) ? statement.all() : statement.run()));
    return results;
  };
  kv = makeKv();
  env = makeEnv(d1, kv);
  await seedDevice(d1, { balance_usd: 100 });
  seedProvider(d1, { id: "public-provider", endpoint: "https://public.example/v1" });
  seedProvider(d1, { id: "internal-provider", endpoint: "https://internal.example/v1" });
  seedProvider(d1, { id: "backup-provider", endpoint: "https://backup.example/v1" });
  seedModel(d1, { id: "public", provider_id: "public-provider", model_name: "public-model", input_price_per_m: 10, output_price_per_m: 20, cache_enabled: 1, fallback_model_id: "escape" });
  seedModel(d1, { id: "internal", provider_id: "internal-provider", model_name: "private-fast", model_public: 0,
    input_price_per_m: 700, output_price_per_m: 900, cache_enabled: 1, fallback_model_id: "escape" });
  seedModel(d1, { id: "backup", provider_id: "backup-provider", model_name: "private-backup", model_public: 0,
    input_price_per_m: 800, output_price_per_m: 1000, fallback_model_id: "escape" });
  seedModel(d1, { id: "escape", provider_id: "public-provider", model_name: "escape-model" });
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });

async function select(members = ["internal"], targetType: "model" | "group" = "model", targetId = "public", publicSelectable = 1) {
  const group = await createServiceGroup(env, { name: "selected-service", multiplier: 2, public_selectable: publicSelectable });
  await upsertServiceGroupModel(env, group.id, { model_key: "public-model", target_type: targetType, target_id: targetId,
    member_ids_json: JSON.stringify(members) });
  if (!publicSelectable) await setDeviceServiceGroups(env, DEVICE_ID, [group.id]);
  d1.sql("UPDATE devices SET service_group_id = ? WHERE id = ?", group.id, DEVICE_ID);
  return { ...group, revision: group.revision + 1 };
}
function upstream(answer: (call: number) => Response | Promise<Response> = () => openAiAnswer()) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return answer(calls.length);
  });
  return calls;
}
async function request(path = "/chat/completions", body: unknown = chatBody("public-model")) {
  const exec = new CollectingExecutionContext();
  const response = await postJson(env, path, body, exec);
  const text = await response.text();
  await Promise.all(exec.pending);
  return { response, text };
}
interface Usage {
  model: string; provider_id: string; cost_usd: number; cache_hit: number; status_code: number;
  service_group_id: string | null; service_group_revision: number | null; pricing_snapshot_json: string | null;
}
function usages() { return d1.rows<Usage>("SELECT * FROM usage ORDER BY id"); }
function checkBill(group: { id: string; revision: number }, cost: number, provider = "internal-provider") {
  expect(usages()).toHaveLength(1);
  const row = usages()[0];
  expect(row).toMatchObject({ model: "public-model", provider_id: provider, cache_hit: 0,
    service_group_id: group.id, service_group_revision: group.revision });
  expect(row.cost_usd).toBeCloseTo(cost, 6);
  expect(row.pricing_snapshot_json).not.toBeNull();
  const snapshot = JSON.parse(row.pricing_snapshot_json!);
  expect(snapshot.billing.model_name).toBe("public-model");
  expect(row.pricing_snapshot_json).not.toMatch(/api_key|secret|config_json|sk-a/);
  expect(wallet(d1)?.balance_usd).toBeCloseTo(100 - cost, 6);
  expect(wallet(d1)?.reserved_usd).toBe(0);
  return snapshot;
}

describe("selected service group gateway pipeline", () => {
  it("routes an explicit internal member using its actual model name, not the public name or alias", async () => {
    const group = await select();
    d1.sql("UPDATE models SET alias = 'do-not-send-alias' WHERE id = 'internal'");
    const calls = upstream();
    const { response, text } = await request();
    expect(response.status, text).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://internal.example/v1/chat/completions", body: { model: "private-fast" } });
    expect(JSON.parse(text).model).toBe("public-model");
    const snapshot = checkBill(group, 0.06);
    expect(snapshot.billing).toMatchObject({ input_price_per_m: 20, output_price_per_m: 40 });
  });

  it("fails over only in explicit member order and keeps the original public invoice", async () => {
    const group = await select(["internal", "backup"]);
    const calls = upstream((call) => call === 1 ? new Response("busy", { status: 503 }) : openAiAnswer());
    const { response, text } = await request();
    expect(response.status, text).toBe(200);
    expect(calls.map((call) => call.body.model)).toEqual(["private-fast", "private-backup"]);
    expect(calls.map((call) => call.url)).toEqual(["https://internal.example/v1/chat/completions", "https://backup.example/v1/chat/completions"]);
    checkBill(group, 0.06, "backup-provider");
  });

  it("does not escape exhausted members through same-name candidates or fallback_model_id", async () => {
    await select(["internal", "backup"]);
    seedModel(d1, { id: "same-name-outsider", provider_id: "public-provider", model_name: "public-model" });
    const calls = upstream(() => new Response("busy", { status: 503 }));
    const { response } = await request();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(calls.map((call) => call.body.model)).toEqual(["private-fast", "private-backup"]);
    expect(calls.every((call) => !call.url.includes("public.example"))).toBe(true);
  });

  it("freezes group price and revision before upstream, even if pricing changes in flight", async () => {
    const group = await select();
    upstream(async () => {
      await updateServiceGroup(env, group.id, { multiplier: 9 });
      d1.sql("UPDATE models SET input_price_per_m = 900, output_price_per_m = 900 WHERE id = 'public'");
      return openAiAnswer();
    });
    const { response, text } = await request();
    expect(response.status, text).toBe(200);
    expect(checkBill(group, 0.06).billing).toMatchObject({ input_price_per_m: 20, output_price_per_m: 40 });
    expect(d1.row<{ revision: number }>("SELECT revision FROM service_groups WHERE id = ?", group.id)?.revision).toBeGreaterThan(group.revision);
  });

  it("uses the model-group target price, not internal member prices", async () => {
    seedGroup(d1, { id: "target-group", name: "catalog-group", input_price_per_m: 7, output_price_per_m: 13 });
    seedGroupMembers(d1, "target-group", ["internal", "backup"]);
    const group = await select(["internal"], "group", "target-group");
    upstream();
    const { response, text } = await request();
    expect(response.status, text).toBe(200);
    expect(checkBill(group, 0.04).billing).toMatchObject({ input_price_per_m: 14, output_price_per_m: 26 });
  });

  it("never reads or writes response cache despite enabled target/member caches", async () => {
    await select();
    const get = vi.spyOn(kv.KV, "get");
    const put = vi.spyOn(kv.KV, "put");
    const calls = upstream();
    for (let i = 0; i < 2; i++) {
      const { response, text } = await request();
      expect(response.status, text).toBe(200);
    }
    expect(calls).toHaveLength(2);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(usages().map((row) => row.cache_hit)).toEqual([0, 0]);
    expect(wallet(d1)?.balance_usd).toBeCloseTo(99.88, 6);
  });

  it.each(["disabled", "withdrawn"])("blocks a %s assigned service before any upstream or charge", async (state) => {
    const group = await select(["internal"], "model", "public", 0);
    if (state === "disabled") await updateServiceGroup(env, group.id, { enabled: 0 });
    else await setDeviceServiceGroups(env, DEVICE_ID, []);
    const calls = upstream();
    const { response } = await request();
    expect(response.status).toBe(state === "disabled" ? 503 : 403);
    expect(calls).toEqual([]);
    expect(usages()).toEqual([]);
    expect(wallet(d1)?.balance_usd).toBe(100);
  });

  it("does not fall back to the legacy catalog for an unmapped public model", async () => {
    await select();
    const calls = upstream();
    const { response } = await request("/chat/completions", chatBody("escape-model"));
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
    expect(usages()).toEqual([]);
  });

  it("settles streaming chat with service identity, revision and frozen prices", async () => {
    const group = await select();
    const calls = upstream(() => sseAnswer(openAiStreamFrames()));
    const { response, text } = await request("/chat/completions", chatBody("public-model", { stream: true }));
    expect(response.status, text).toBe(200);
    expect(text).toContain('"model":"public-model"');
    expect(calls[0].body.model).toBe("private-fast");
    checkBill(group, 0.06);
  });

  it("charges an explicit partial price override without also applying the multiplier", async () => {
    const group = await select();
    await upsertServiceGroupModel(env, group.id, { model_key: "public-model", target_type: "model", target_id: "public",
      member_ids_json: JSON.stringify(["internal"]), pricing_json: JSON.stringify({ input_price_per_m: 5 }) });
    upstream();
    const { response, text } = await request();
    expect(response.status, text).toBe(200);
    expect(checkBill({ ...group, revision: group.revision + 1 }, 0.025).billing).toMatchObject({ input_price_per_m: 5, output_price_per_m: 20 });
  });

  it("routes native Responses to the explicit member and records service billing", async () => {
    const group = await select();
    d1.sql("UPDATE models SET config_json = ? WHERE id = 'internal'", JSON.stringify({ responses_mode: "native" }));
    const calls = upstream(() => new Response(JSON.stringify({ id: "resp_1", object: "response", status: "completed", model: "private-fast",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
      usage: { input_tokens: 1000, output_tokens: 1000, total_tokens: 2000 } }), { headers: { "content-type": "application/json" } }));
    const { response, text } = await request("/responses", { model: "public-model", input: "hi", max_output_tokens: 8 });
    expect(response.status, text).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://internal.example/v1/responses", body: { model: "private-fast", store: false } });
    expect(JSON.parse(text).model).toBe("public-model");
    checkBill(group, 0.06);
  });

  it("bills image generation once at the frozen service per-call price, independent of n", async () => {
    d1.sql("UPDATE models SET billing_unit = 'call', price_per_call = 0.25 WHERE id = 'public'");
    d1.sql("UPDATE models SET billing_unit = 'call', price_per_call = 9 WHERE id = 'internal'");
    const group = await select();
    const calls = upstream(() => new Response(JSON.stringify({ created: 1, data: [{ url: "https://images.example/1.png" }, { url: "https://images.example/2.png" }] }),
      { headers: { "content-type": "application/json" } }));
    const { response, text } = await request("/images/generations", { model: "public-model", prompt: "a tree", n: 2 });
    expect(response.status, text).toBe(200);
    expect(calls[0]).toMatchObject({ url: "https://internal.example/v1/images/generations", body: { model: "private-fast", n: 2 } });
    expect(checkBill(group, 0.5).billing).toMatchObject({ billing_unit: "call", price_per_call: 0.5 });
  });
});
