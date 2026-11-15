import { durableBillingFixture } from "./helpers/durableBillingFixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import type { DeviceRow, Env, ModelWithProvider } from "../src/types";


const TOKEN = "ccs_test_token";

function modelRow(over: Partial<ModelWithProvider> = {}): ModelWithProvider {
  return {
    id: "model_a",
    model_name: "gw-primary",
    display_name: "gw-primary",
    alias: null,
    provider_id: "prov_a",
    provider_name: "Provider A",
    provider_api_key: "sk-a",
    provider_endpoint: "https://a.example/v1",
    input_price_per_m: 3,
    output_price_per_m: 15,
    cache_enabled: 1,
    cache_ttl: 300,
    fallback_model_id: null,
    enabled: 1,
    model_public: 1,
    pricing_mode: "priced",
    peak_pricing_enabled: 0,
    config_json: null,
    created_at: 1,
    updated_at: 1,
    provider_type: "openai",
    provider_secret_name: null,
    ...over,
  } as ModelWithProvider;
}

const DEVICE: DeviceRow = {
  id: "dev_1",
  name: "Laptop",
  token_hash: "pending",
  enabled: 1,
  rate_limit_rpm: 0,
  cost_limit_monthly: null,
  last_used_at: null,
  created_at: 1,
  revoked_at: null,
  model_scope: "all",
};

interface UsageRow {
  cost_usd: number;
  cache_hit: number;
  price_multiplier: number;
  price_window_id: unknown;
  model: unknown;
}

function makeEnv(models: ModelWithProvider[], balanceUsd = 1) {
  return durableBillingFixture(models, { token: TOKEN, balanceUsd });
}

class CollectingExecutionContext {
  readonly pending: Promise<unknown>[] = [];
  waitUntil(p: Promise<unknown>) {
    this.pending.push(p.catch(() => undefined));
  }
  passThroughOnException() {}
  readonly props: unknown = undefined;
  readonly tracing: unknown = undefined;
  readonly access: unknown = undefined;
}

function chatBody() {
  return JSON.stringify({ model: "gw-primary", messages: [{ role: "user", content: "hi" }], max_tokens: 8 });
}

async function postChat(env: Env, body: string, exec: CollectingExecutionContext) {
  return gatewayApp.request(
    "http://gw.test/chat/completions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body,
    },
    env,
    exec as never
  );
}

function upstreamAnswer() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "gw-primary",
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function primeCache(env: Env) {
  const exec = new CollectingExecutionContext();
  const res = await postChat(env, chatBody(), exec);
  await Promise.all(exec.pending);
  expect(res.status).toBe(200);
  await res.text();
}

describe("a cache hit is gated on the wallet and charged to it", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    resetRateLimitMemory();
    clearMemoryCacheForTest();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("refuses a hit the wallet cannot afford, and answers nothing", async () => {
    const { env, wallet, usages, d1 } = await makeEnv([modelRow()], 1);
    globalThis.fetch = vi.fn(async () => upstreamAnswer()) as unknown as typeof globalThis.fetch;
    await primeCache(env);

    d1.sql("UPDATE device_wallets SET balance_usd = ? WHERE device_id = ?", 0.01, DEVICE.id);

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    await Promise.all(exec.pending);

    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.error).toBe("insufficient_balance");
    expect(body.available_usd).toBeCloseTo(0.01, 6);
    expect(body.estimated_cost_usd).toBeCloseTo(0.018, 9);
    expect(res.headers.get("x-cache")).toBeNull();
    expect(wallet().balance_usd).toBeCloseTo(0.01, 9);
    expect(usages()).toHaveLength(1);
  });

  it("serves the hit and takes the money out of the wallet", async () => {
    const { env, wallet, usages, d1 } = await makeEnv([modelRow()], 1);
    globalThis.fetch = vi.fn(async () => upstreamAnswer()) as unknown as typeof globalThis.fetch;
    await primeCache(env);

    expect(wallet().balance_usd).toBeCloseTo(1 - 0.018, 9);

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    await Promise.all(exec.pending);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-cache")).toBe("HIT");
    const json = (await res.json()) as any;
    expect(json.choices[0].message.content).toBe("pong");

    expect(wallet().balance_usd).toBeCloseTo(1 - 0.036, 9);
    expect(usages()).toHaveLength(2);
    expect(usages()[1].cache_hit).toBe(1);
    expect(usages()[1].cost_usd).toBeCloseTo(0.018, 9);
  });

  it("counts other in-flight holds when deciding whether a hit is affordable", async () => {
    const { env, wallet, d1 } = await makeEnv([modelRow()], 1);
    globalThis.fetch = vi.fn(async () => upstreamAnswer()) as unknown as typeof globalThis.fetch;
    await primeCache(env);

    d1.sql("UPDATE device_wallets SET balance_usd = 1, reserved_usd = 0.99 WHERE device_id = ?", DEVICE.id);

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    await Promise.all(exec.pending);

    expect(res.status).toBe(429);
    expect(((await res.json()) as any).available_usd).toBeCloseTo(0.01, 6);
    expect(wallet().reserved_usd).toBeCloseTo(0.99, 9);
    expect(wallet().balance_usd).toBeCloseTo(1, 9);
  });

  it("serves a free model's hit to a device with no money at all", async () => {
    const { env, wallet, usages, d1 } = await makeEnv([modelRow({ pricing_mode: "free" })], 0);
    globalThis.fetch = vi.fn(async () => upstreamAnswer()) as unknown as typeof globalThis.fetch;
    await primeCache(env);

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    await Promise.all(exec.pending);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-cache")).toBe("HIT");
    expect(wallet().balance_usd).toBe(0);
    expect(usages()).toHaveLength(2);
    expect(usages()[1].cost_usd).toBe(0);
    expect(usages()[1].cache_hit).toBe(1);
  });
});
