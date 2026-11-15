import { durableBillingFixture } from "./helpers/durableBillingFixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { sha256Hex } from "../src/utils/crypto";
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
    cache_enabled: 0,
    cache_ttl: 0,
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

function makeEnv(models: ModelWithProvider[], options: { hash?: string; rpmByModel?: Record<string, number> } = {}) {
  return durableBillingFixture(models, { token: TOKEN, ...options });
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

function chatBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ model: "gw-primary", messages: [{ role: "user", content: "hi" }], max_tokens: 8, ...extra });
}

function openAiBody(model: string) {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
}

async function postChat(env: Env, body = chatBody(), exec = new CollectingExecutionContext()) {
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

describe("per-model rate limits", () => {
  let realFetch: typeof globalThis.fetch;
  let hash: string;

  beforeEach(async () => {
    realFetch = globalThis.fetch;
    resetRateLimitMemory();
    hash = await sha256Hex(TOKEN);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetRateLimitMemory();
    vi.restoreAllMocks();
  });

  function primaryUp() {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      urls.push(String(input));
      return new Response(openAiBody("upstream-internal-x"), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return urls;
  }

  function primaryDown() {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://a.example")) return new Response("down", { status: 503 });
      return new Response(openAiBody("upstream-internal-x"), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return urls;
  }

  it("serves every request when the device has no per-model override", async () => {
    const urls = primaryUp();  });

  it("answers 429 once the primary model spends its own budget", async () => {
    const urls = primaryUp();  });

  it("spends the BACKUP model budget on a failover, not the primary one", async () => {
    const primary = modelRow({ id: "model_a" });
    const backup = modelRow({ id: "model_b", provider_id: "prov_b", provider_name: "Provider B", provider_api_key: "sk-b", provider_endpoint: "https://b.example/v1" });
    const urls = primaryDown();
    const { env } = await makeEnv([primary, backup], { hash, rpmByModel: { model_b: 1 } });

    const first = await postChat(env);
    expect(first.status).toBe(200);
    expect(JSON.parse(await first.text()).model).toBe("gw-primary");

    const second = await postChat(env);
    expect(second.status).toBe(502);
    expect(((await second.json()) as { error: string }).error).toBe("upstream_service_unavailable");
    expect(urls.map((u) => (u.includes("b.example") ? "b" : "a"))).toEqual(["a", "b", "a"]);
  });

  it("keeps one bucket per model instead of a shared device counter", async () => {
    const primary = modelRow({ id: "model_a" });
    const backup = modelRow({ id: "model_b", provider_id: "prov_b", provider_name: "Provider B", provider_api_key: "sk-b", provider_endpoint: "https://b.example/v1" });
    const urls = primaryDown();
    const { env } = await makeEnv([primary, backup], { hash, rpmByModel: { model_a: 1, model_b: 1 } });

    expect((await postChat(env)).status).toBe(200);
    expect((await postChat(env)).status).toBe(429);
    expect(((await (await postChat(env)).json()) as { error: string }).error).toBe("rate_limit_exceeded");
    expect(urls).toHaveLength(2);
  });

  it("does not let a rate-limited model be served from cache", async () => {
    const cached = modelRow({ id: "model_a", cache_enabled: 1 });
    globalThis.fetch = vi.fn(async () => new Response(openAiBody("gw-primary"), { status: 200 })) as unknown as typeof globalThis.fetch;
    const { env } = await makeEnv([cached], { hash, rpmByModel: { model_a: 1 } });

    expect((await postChat(env)).status).toBe(200);
    expect((await postChat(env)).status).toBe(429);
  });
});

