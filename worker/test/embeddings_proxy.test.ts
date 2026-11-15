import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { createServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import { readBoundedBody, compatibleEmbeddingSpace, embeddingPoolError, validateEmbeddingRequest } from "../src/gateway/embeddings";
import type { Env } from "../src/types";
import { CollectingExecutionContext, createRealD1, holdRows, ledgerRows, makeEnv, makeKv, postJson, seedDevice, seedGroup, seedGroupMembers, seedModel, seedProvider, usageRows, wallet, type RealD1 } from "./helpers/realGatewayEnv";
const MODEL = "public-vector", PRIVATE = "private-vector";
const profile = { compatibility_key: "space-v1", dimensions: 3 };
const config = (p?: unknown) => JSON.stringify({ model_type: "embedding", model_rewrite: PRIVATE, ...(p ? { embedding_profile: p } : {}) });
const prices = { input_price_per_m: 10, output_price_per_m: 0, cache_read_price_per_m: 0, cache_write_price_per_m: 0 };
let db: RealD1, env: Env;
function object(count = 1, embedding: number[] | string = [0.1, 0.2, 0.3]) {
  return { object: "list", model: PRIVATE, data: Array.from({ length: count }, (_, index) => ({ object: "embedding", index, embedding })), usage: { prompt_tokens: 1000, total_tokens: 1000 } };
}
function upstream(factory: () => Response = () => Response.json(object())) {
  const calls: { url: string; body: any }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return factory();
  });
  return calls;
}
async function request(body: unknown = { model: MODEL, input: "hello" }, path = "/embeddings") {
  const exec = new CollectingExecutionContext();
  const response = await postJson(env, path, body, exec);
  const text = await response.text();
  await Promise.all(exec.pending);
  return { response, text };
}
function cleanWallet(balance: number) {
  expect(wallet(db)?.balance_usd).toBeCloseTo(balance, 8);
  expect(wallet(db)?.reserved_usd).toBeCloseTo(0, 8);
  expect(holdRows(db)).toEqual([]);
}
beforeEach(async () => {
  resetRateLimitMemory(); clearMemoryCacheForTest(); db = createRealD1(); env = makeEnv(db);
  await seedDevice(db, { balance_usd: 0.02 }); seedProvider(db);
  seedModel(db, { model_name: MODEL, ...prices, config_json: config() });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); db.close(); });

describe("embeddings real SQLite routing and accounting", () => {
  it("rewrites only the upstream model, preserves embedding fields, and bills input once", async () => {
    const calls = upstream();
    const { response, text } = await request({ model: MODEL, input: "hello", dimensions: 3, user: "caller", stream: false });
    expect(response.status, text).toBe(200);
    expect(calls).toEqual([{ url: "https://a.example/v1/embeddings", body: { model: PRIVATE, input: "hello", dimensions: 3, user: "caller" } }]);
    expect(JSON.parse(text)).toMatchObject({ object: "list", model: MODEL, usage: { prompt_tokens: 1000, total_tokens: 1000 } });
    expect(text).not.toContain(PRIVATE);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(usageRows(db)).toMatchObject([{ model: MODEL, cost_usd: 0.01, input_tokens: 1000, output_tokens: 0, cache_hit: 0, status_code: 200 }]);
    expect(ledgerRows(db).filter(r => r.reason === "usage")).toHaveLength(1); cleanWallet(0.01);
  });
  it("supports batched float and base64 answers without output/cache/search fees", async () => {
    const calls = upstream(() => Response.json(object(2, "zczMPc3MTD6amZk+")));
    const { response, text } = await request({ model: MODEL, input: ["one", "two"], encoding_format: "base64", dimensions: 3 });
    expect(response.status, text).toBe(200); expect(calls).toHaveLength(1);
    expect(JSON.parse(text).data).toHaveLength(2); cleanWallet(0.01);
  });
  it("never reads or writes the response cache even when stale stored config enables it", async () => {
    const kv = makeKv(); env = makeEnv(db, kv); db.sql("UPDATE models SET cache_enabled = 1");
    const calls = upstream();
    expect((await request()).response.status).toBe(200); expect((await request()).response.status).toBe(200);
    expect(calls).toHaveLength(2); expect(kv.writes).toEqual([]); expect(usageRows(db).every(r => r.cache_hit === 0)).toBe(true); cleanWallet(0);
  });
  it.each([{ input: "" }, { input: [] }, { input: [1, 2] }, { input: ["a", " "] }, { input: Array(65).fill("a") }, { stream: true }, { dimensions: 4097 }, { dimensions: 1.5 }, { encoding_format: "hex" }, { user: "x".repeat(257) }, { messages: [] }])("rejects invalid fields before upstream, reserve or usage: %j", async invalid => {
    const calls = upstream(); const { response } = await request({ model: MODEL, input: "hello", ...invalid });
    expect(response.status).toBe(400); expect(calls).toEqual([]); expect(usageRows(db)).toEqual([]); cleanWallet(0.02);
  });
  it("bounds actual request bytes even without Content-Length", async () => {
    const calls = upstream(); const { response } = await request({ model: MODEL, input: "中".repeat(90000) });
    expect(response.status).toBe(413); expect(calls).toEqual([]); cleanWallet(0.02);
  });
  it("does not route text models through embeddings or embedding models through chat", async () => {
    const calls = upstream(); seedModel(db, { id: "text", model_name: "text" });
    expect((await request({ model: "text", input: "hi" })).response.status).toBe(400);
    expect((await request({ model: MODEL, messages: [] }, "/chat/completions")).response.status).toBe(400);
    expect(calls).toEqual([]); cleanWallet(0.02);
  });
  it.each(["gemini", "anthropic"])("rejects unsupported %s provider without fetch", async type => {
    db.sql("UPDATE providers SET type = ?", type); const calls = upstream();
    expect((await request()).response.status).toBe(400); expect(calls).toEqual([]); cleanWallet(0.02);
  });
  it.each(["json", "count", "index", "dimensions", "usage", "stream", "oversize", "truncated", "http"])("does not charge or leak identity after %s upstream failure", async mode => {
    const calls = upstream(() => {
      if (mode === "json") return new Response("not-json-private-vector");
      if (mode === "stream") return new Response("data: secret", { headers: { "content-type": "text/event-stream" } });
      if (mode === "oversize") return new Response("secret", { headers: { "content-length": "8388609" } });
      if (mode === "truncated") return new Response(new ReadableStream({ start(c) { c.error(Error("private-vector")); } }));
      if (mode === "http") return Response.json({ error: PRIVATE }, { status: 400 });
      const answer = object(mode === "count" ? 2 : 1);
      if (mode === "index") answer.data[0].index = 7;
      if (mode === "dimensions") answer.data[0].embedding = [];
      if (mode === "usage") answer.usage.total_tokens = 10;
      return Response.json(answer);
    });
    const { response, text } = await request();
    expect(response.status).toBe(mode === "http" ? 400 : 502); expect(text).not.toContain(PRIVATE); expect(calls).toHaveLength(1);
    expect(usageRows(db)).toHaveLength(1); expect(usageRows(db)[0].cost_usd).toBe(0); cleanWallet(0.02);
  });
  it("rejects a mixed or unprofiled multi-member vector pool before fetching", async () => {
    const calls = upstream(); seedGroup(db, { name: "pool", ...prices, config_json: config() });
    seedModel(db, { id: "second", model_name: "second", ...prices, config_json: config() }); seedGroupMembers(db, "grp_a", ["model_a", "second"]);
    const result = await request({ model: "pool", input: "hi" }); expect(result.response.status).toBe(400); expect(calls).toEqual([]);
    db.sql("UPDATE models SET config_json = NULL WHERE id = 'second'");
    expect((await request({ model: "pool", input: "hi" })).response.status).toBe(400); expect(calls).toEqual([]); cleanWallet(0.02);
  });
  it("fails over only within an explicitly compatible vector pool", async () => {
    db.sql("UPDATE models SET config_json = ?", config(profile));
    seedGroup(db, { name: "pool", ...prices, config_json: config(profile) });
    seedModel(db, { id: "second", model_name: "second", ...prices, config_json: config(profile) }); seedGroupMembers(db, "grp_a", ["model_a", "second"]);
    let attempt = 0; const calls = upstream(() => ++attempt === 1 ? new Response(null, { status: 401 }) : Response.json(object()));
    const { response, text } = await request({ model: "pool", input: "hi", dimensions: 3 });
    expect(response.status, text).toBe(200); expect(calls).toHaveLength(2); expect(usageRows(db)).toHaveLength(1); cleanWallet(0.01);
  });
  it("uses the fixed service input price and never escapes to another group", async () => {
    const service = await createServiceGroup(env, { name: "vector-service", multiplier: 5, public_selectable: 1 });
    await upsertServiceGroupModel(env, service.id, { model_key: MODEL, target_type: "model", target_id: "model_a", pricing_json: JSON.stringify({ input_price_per_m: 5 }) });
    db.sql("UPDATE devices SET service_group_id = ?", service.id);
    const calls = upstream(); const { response, text } = await request();
    expect(response.status, text).toBe(200); expect(calls).toHaveLength(1); cleanWallet(0.015);
    expect(db.row("SELECT service_group_id FROM usage")?.service_group_id).toBe(service.id);
  });
  it.each(["missing", "different", "dimensions"])("refuses Auto vector spaces with %s profile declaration before fetching", async mode => {
    db.sql("UPDATE models SET config_json = ?", config(mode === "missing" ? undefined : profile));
    seedModel(db, { id: "second", model_name: "second", ...prices, config_json: config(mode === "missing" ? undefined : { compatibility_key: mode === "different" ? "another-space" : "space-v1", dimensions: mode === "dimensions" ? 2 : 3 }) });
    for (const [id, target] of [["one", "model_a"], ["two", "second"]]) {
      const group = await createServiceGroup(env, { name: id, multiplier: 1, public_selectable: 1 });
      await upsertServiceGroupModel(env, group.id, { model_key: MODEL, target_type: "model", target_id: target });
    }
    db.sql("UPDATE devices SET service_group_id = 'auto'"); const calls = upstream();
    const { response, text } = await request(); expect(response.status, text).toBe(400); expect(calls).toEqual([]); cleanWallet(0.02);
  });
  it("Auto fails over only within a declared space and uses the successful service input price", async () => {
    db.sql("UPDATE models SET config_json = ?", config(profile));
    seedProvider(db, { id: "provider-second", endpoint: "https://second.example/v1" });
    seedModel(db, { id: "second", provider_id: "provider-second", model_name: "second", ...prices, config_json: config(profile) });
    for (const [name, target, price] of [["one", "model_a", 5], ["two", "second", 8]] as const) {
      const group = await createServiceGroup(env, { name, multiplier: 1, public_selectable: 1 });
      await upsertServiceGroupModel(env, group.id, { model_key: MODEL, target_type: "model", target_id: target, pricing_json: JSON.stringify({ input_price_per_m: price }) });
    }
    db.sql("UPDATE devices SET service_group_id = 'auto'"); let count = 0;
    const calls = upstream(() => ++count === 1 ? new Response(null, { status: 500 }) : Response.json(object()));
    const { response, text } = await request(); expect(response.status, text).toBe(200); expect(calls).toHaveLength(2);
    expect(usageRows(db)).toHaveLength(1); expect(usageRows(db)[0].cost_usd).toBeCloseTo(0.008); cleanWallet(0.012);
  });
  it("rejects a profile/request dimension mismatch without upstream", async () => {
    db.sql("UPDATE models SET config_json = ?", config(profile)); const calls = upstream();
    expect((await request({ model: MODEL, input: "hi", dimensions: 2 })).response.status).toBe(400); expect(calls).toEqual([]); cleanWallet(0.02);
  });
});

describe("embedding helpers are bounded and do not infer vector compatibility", () => {
  it("requires both matching explicit key and dimensions", () => {
    expect(compatibleEmbeddingSpace({ config_json: config(profile) }, { config_json: config(profile) })).toBe(true);
    expect(compatibleEmbeddingSpace({ config_json: config({ compatibility_key: "space-v1" }) }, { config_json: config({ compatibility_key: "space-v1" }) })).toBe(false);
    expect(validateEmbeddingRequest({ input: [123] })).toBe("invalid_embedding_input");
  });
  it("allows key-only profiles only for a fixed single upstream", () => {
    const row = { config_json: config({ compatibility_key: "space-v1" }), provider_type: "openai", billing_unit: "token" };
    expect(embeddingPoolError(row, [row])).toBeNull();
    expect(embeddingPoolError(row, [row], true)).toBe("embedding_compatibility_required");
    expect(embeddingPoolError(row, [row, row])).toBe("embedding_compatibility_required");
    expect(embeddingPoolError(row, [{ ...row, config_json: config({ compatibility_key: "other" }) }])).toBe("embedding_compatibility_required");
    expect(embeddingPoolError({ ...row, config_json: config(profile) }, [row])).toBe("embedding_compatibility_required");
  });
  it("cancels on size, abort, or stalled-body deadline", async () => {
    const encoder = new TextEncoder();
    await expect(readBoundedBody(new ReadableStream({ start(c) { c.enqueue(encoder.encode("12345")); c.close(); } }), 4)).rejects.toThrow("body_too_large");
    const controller = new AbortController(); controller.abort();
    await expect(readBoundedBody(new ReadableStream(), 4, controller.signal)).rejects.toThrow("aborted");
    vi.useFakeTimers(); let cancelled = false;
    const promise = readBoundedBody(new ReadableStream({ cancel() { cancelled = true; } }), 4);
    const assertion = expect(promise).rejects.toThrow("aborted"); await vi.advanceTimersByTimeAsync(30001); await assertion; expect(cancelled).toBe(true);
  });
});
