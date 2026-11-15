import { durableBillingFixture } from "./helpers/durableBillingFixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES, peakPricingDayKey } from "../src/db/repo";
import type { DeviceRow, Env, ModelWithProvider, PriceWindowRow } from "../src/types";


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
    peak_pricing_enabled: 1,
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
}

function allDayBand(multiplier: number): PriceWindowRow {
  const { day } = peakPricingDayKey(PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES, Date.now());
  return {
    id: "pw_peak",
    model_id: "model_a",
    day_type: day,
    start_minute: 0,
    end_minute: 1440,
    multiplier,
    enabled: 1,
    created_at: 0,
    updated_at: 0,
  };
}

function makeEnv(models: ModelWithProvider[], balanceUsd = 1, windows: PriceWindowRow[] = []) {
  return durableBillingFixture(models, { token: TOKEN, balanceUsd, windows, cache: true });
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

function chatBody(content = "hi") {
  return JSON.stringify({ model: "gw-primary", messages: [{ role: "user", content }], max_tokens: 8 });
}

async function postChat(env: Env, body: string) {
  const exec = new CollectingExecutionContext();
  const res = await gatewayApp.request(
    "http://gw.test/chat/completions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body,
    },
    env,
    exec as never
  );
  await Promise.all(exec.pending);
  return res;
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

describe("a cache hit is billed at the first call's price", () => {
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

  it("keeps the first-time amount when the peak band changes under the entry", async () => {
    const band = allDayBand(2);
    const { env, wallet, usages, d1 } = await makeEnv([modelRow()], 1, [band]);
    globalThis.fetch = vi.fn(async () => upstreamAnswer()) as unknown as typeof globalThis.fetch;

    const first = await postChat(env, chatBody());
    expect(first.status).toBe(200);
    expect(usages()[0].cost_usd).toBeCloseTo(0.036, 9);
    expect(usages()[0].price_multiplier).toBe(2);
    expect(usages()[0].price_window_id).toBe("pw_peak");
    expect(wallet().balance_usd).toBeCloseTo(1 - 0.036, 9);

    d1.sql("UPDATE price_windows SET multiplier = ? WHERE id = ?", 0.5, band.id);

    const hit = await postChat(env, chatBody());
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-cache")).toBe("HIT");

    expect(usages()[1].cache_hit).toBe(1);
    expect(usages()[1].cost_usd).toBeCloseTo(0.036, 9);
    expect(usages()[1].price_multiplier).toBe(2);
    expect(usages()[1].price_window_id).toBe("pw_peak");
    expect(wallet().balance_usd).toBeCloseTo(1 - 0.072, 9);
  });

  it("keeps the first-time amount when an admin edits the price list", async () => {
    const models = [modelRow({ peak_pricing_enabled: 0 })];
    const { env, wallet, usages, d1 } = await makeEnv(models, 20);
    globalThis.fetch = vi.fn(async () => upstreamAnswer()) as unknown as typeof globalThis.fetch;

    const first = await postChat(env, chatBody());
    expect(first.status).toBe(200);
    expect(usages()[0].cost_usd).toBeCloseTo(0.018, 9);

    d1.sql("UPDATE models SET input_price_per_m = 300, output_price_per_m = 1500 WHERE id = ?", models[0].id);

    const hit = await postChat(env, chatBody());
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(usages()[1].cache_hit).toBe(1);
    expect(usages()[1].cost_usd).toBeCloseTo(0.018, 9);
    expect(wallet().balance_usd).toBeCloseTo(20 - 0.036, 9);
  });

  it("bills a fresh answer at the new price, so the snapshot freezes one entry and not the model", async () => {
    const models = [modelRow({ peak_pricing_enabled: 0 })];
    const { env, usages, d1 } = await makeEnv(models, 20);
    globalThis.fetch = vi.fn(async () => upstreamAnswer()) as unknown as typeof globalThis.fetch;

    await postChat(env, chatBody("first question"));
    expect(usages()[0].cost_usd).toBeCloseTo(0.018, 9);

    d1.sql("UPDATE models SET input_price_per_m = 300, output_price_per_m = 1500 WHERE id = ?", models[0].id);

    const fresh = await postChat(env, chatBody("a different question"));
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("x-cache")).toBeNull();
    expect(usages()[1].cache_hit).toBe(0);
    expect(usages()[1].cost_usd).toBeCloseTo(1.8, 9);
  });

  it("writes the settled amount into the entry, so the price travels with the answer", async () => {
    const { env, kvWrites } = await makeEnv([modelRow({ peak_pricing_enabled: 0 })], 1);
    globalThis.fetch = vi.fn(async () => upstreamAnswer()) as unknown as typeof globalThis.fetch;

    await postChat(env, chatBody());
    expect(kvWrites).toHaveLength(1);

    const entry = JSON.parse(kvWrites[0].value) as any;
    expect(entry.billing).toBeDefined();
    expect(entry.billing.cost_usd).toBeCloseTo(0.018, 9);
    expect(entry.billing.price_multiplier).toBe(1);
    expect(entry.billing.price_window_id).toBeNull();
    expect(entry.billing.input_price_per_m).toBe(3);
    expect(entry.billing.output_price_per_m).toBe(15);
    expect(entry.billing.pricing_mode).toBe("priced");
  });

  it("stamps the entry with the primary's price even when a backup answered", async () => {
    const primary = modelRow({ id: "model_a", model_name: "gw-primary", alias: "gw-primary" });
    const backup = modelRow({
      id: "model_b",
      model_name: "gw-backup",
      alias: "gw-primary",
      provider_endpoint: "https://b.example/v1",
      input_price_per_m: 100,
      output_price_per_m: 500,
    });
    const { env, usages, kvWrites } = await makeEnv([primary, backup], 20);
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url).includes("a.example")) return new Response("upstream down", { status: 503 });
      return upstreamAnswer();
    }) as unknown as typeof globalThis.fetch;

    const res = await postChat(env, chatBody());
    expect(res.status).toBe(200);

    expect(usages()[0].cost_usd).toBeCloseTo(0.018, 9);
    expect(kvWrites).toHaveLength(1);
    const entry = JSON.parse(kvWrites[0].value) as any;
    expect(entry.billing.cost_usd).toBeCloseTo(0.018, 9);
    expect(entry.billing.input_price_per_m).toBe(3);
    expect(entry.billing.output_price_per_m).toBe(15);
  });
});
