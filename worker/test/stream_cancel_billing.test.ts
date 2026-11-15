import { durableBillingFixture } from "./helpers/durableBillingFixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { recoverBillingRequests } from "../src/db/request_billing";
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

function sseWithoutUsage(chunks: number): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < chunks; i++) {
        controller.enqueue(
          enc.encode(
            `data: {"id":"c1","object":"chat.completion.chunk","model":"gw-primary","choices":[{"index":0,"delta":{"content":"abcdefghij"}}]}\n\n`
          )
        );
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function postStream(env: Env, exec: CollectingExecutionContext) {
  return gatewayApp.request(
    "http://gw.test/chat/completions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gw-primary",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
        stream: true,
      }),
    },
    env,
    exec as never
  );
}

describe("a cancelled stream is still billed", () => {
  let realFetch: typeof globalThis.fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    resetRateLimitMemory();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("charges for the partial answer when the caller hangs up", async () => {
    const { env, wallet, holds, usages, billing, ledger } = await makeEnv([modelRow()], 1);
    globalThis.fetch = vi.fn(async () => sseWithoutUsage(40)) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postStream(env, exec);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("client disconnected");
    await Promise.all(exec.pending);

    const w = wallet();
    expect(w.reserved_usd).toBe(0);
    expect(w.balance_usd).toBeLessThan(1);
    expect(holds().length).toBe(0);
    expect(res.status).toBe(200);
    expect(usages()).toHaveLength(1);
    expect(usages()[0].status_code).toBe(499);
    expect(usages()[0].cost_usd).toBeGreaterThan(0);
    expect(ledger()).toHaveLength(1);
    expect(billing()[0].outcome).toBe("cancelled");
  });

  it("does not bill a cancelled stream twice when both ends signal completion", async () => {
    const { env, wallet, usages } = await makeEnv([modelRow()], 1);
    globalThis.fetch = vi.fn(async () => sseWithoutUsage(10)) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postStream(env, exec);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("stop");
    await Promise.all(exec.pending);

    expect(usages().length).toBe(1);
    expect(wallet().reserved_usd).toBe(0);
  });

  it("never caches a truncated answer", async () => {
    const { env, wallet, usages, billing, holds } = await makeEnv([modelRow({ cache_enabled: 1, cache_ttl: 300 })], 1);
    const fetchSpy = vi.fn(async () => sseWithoutUsage(40));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const firstExec = new CollectingExecutionContext();
    const res = await postStream(env, firstExec);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("stop");
    await Promise.all(firstExec.pending);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const secondExec = new CollectingExecutionContext();
    const res2 = await postStream(env, secondExec);
    await res2.text();
    await Promise.all(secondExec.pending);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(res2.headers.get("x-cache")).toBeNull();
    expect(usages()).toHaveLength(1);
    expect(usages()[0].status_code).toBe(499);
    expect(billing()).toHaveLength(2);
    expect(billing().filter(request => request.known_cost_usd === null)).toHaveLength(1);
    expect(holds()).toHaveLength(1);
    expect(wallet().reserved_usd).toBeGreaterThan(0);
  });

  it("recovers unknown EOF without usage only after lease expiry, never as a fake zero invoice", async () => {
    const { env, wallet, usages, billing, holds, ledger } = await makeEnv([modelRow()], 1);
    globalThis.fetch = vi.fn(async () => sseWithoutUsage(10)) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postStream(env, exec);
    expect(res.status).toBe(200);
    await res.text();
    await Promise.all(exec.pending);

    expect(wallet().reserved_usd).toBeGreaterThan(0);
    expect(wallet().balance_usd).toBe(1);
    expect(holds()).toHaveLength(1);
    expect(usages()).toHaveLength(0);
    expect(ledger()).toHaveLength(0);
    expect(billing()).toHaveLength(1);
    expect(billing()[0].billing_state).toBe("needs_reconciliation");
    expect(billing()[0].known_cost_usd).toBeNull();
    const terminal = JSON.parse(billing()[0].terminal_snapshot_json);
    expect(terminal.usage).toBeNull();
    expect(terminal.cost_usd).toBeUndefined();

    const clock = vi.spyOn(Date, "now").mockReturnValue(billing()[0].lease_until - 1);
    try {
      expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 0 });
      expect(holds()).toHaveLength(1);
      clock.mockReturnValue(billing()[0].lease_until);
      expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 1 });
      expect(holds()).toHaveLength(0);
      expect(wallet().reserved_usd).toBe(0);
      expect(wallet().balance_usd).toBe(1);
      expect(billing()[0].billing_state).toBe("needs_reconciliation");
      expect(billing()[0].known_cost_usd).toBeNull();
      expect(billing()[0].settled_at).toBeNull();
      expect(usages()).toHaveLength(0);
      expect(ledger()).toHaveLength(0);
      expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 0 });
    } finally { clock.mockRestore(); }
  });
});
