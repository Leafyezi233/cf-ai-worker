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

function chatBody(model = "gw-primary") {
  return JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 8 });
}

async function expectUnknownHoldRecovery(fixture: Awaited<ReturnType<typeof makeEnv>>, count: number) {
  const { env, wallet, holds, billing, usages, ledger } = fixture;
  expect(holds()).toHaveLength(count);
  expect(wallet().reserved_usd).toBeCloseTo(holds().reduce((sum, hold) => sum + hold.amount_usd, 0), 12);
  expect(wallet().reserved_usd).toBeGreaterThan(0);
  expect(usages()).toHaveLength(0);
  expect(ledger()).toHaveLength(0);
  expect(billing()).toHaveLength(count);
  for (const request of billing()) {
    expect(request.known_cost_usd).toBeNull();
    expect(request.settled_at).toBeNull();
  }
  const expiry = Math.max(...billing().map(request => request.lease_until));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Math.min(...billing().map(request => request.lease_until)) - 1);
  try {
    expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 0 });
    expect(holds()).toHaveLength(count);
    clock.mockReturnValue(expiry);
    expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: count });
    expect(holds()).toHaveLength(0);
    expect(wallet().reserved_usd).toBe(0);
    expect(wallet().balance_usd).toBe(1);
    expect(usages()).toHaveLength(0);
    expect(ledger()).toHaveLength(0);
    for (const request of billing()) {
      expect(request.billing_state).toBe("needs_reconciliation");
      expect(request.known_cost_usd).toBeNull();
      expect(request.settled_at).toBeNull();
      expect(request.hold_released_at).not.toBeNull();
    }
    expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 0 });
  } finally { clock.mockRestore(); }
}

describe("durable balance holds survive unknown transport outcomes until lease recovery", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    realFetch = globalThis.fetch;
    resetRateLimitMemory();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("settles a definite HTTP rejection at zero and releases its hold", async () => {
    const fixture = await makeEnv([modelRow()], 1);
    const { env } = fixture;
    globalThis.fetch = vi.fn(async () => new Response("upstream down", { status: 503 })) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    await Promise.all(exec.pending);

    expect(res.status).toBe(502);
    expect(fixture.holds()).toHaveLength(0);
    expect(fixture.wallet()).toEqual({ balance_usd: 1, reserved_usd: 0 });
    expect(fixture.usages()).toHaveLength(1);
    expect(fixture.usages()[0].status_code).toBe(502);
    expect(fixture.usages()[0].cost_usd).toBe(0);
    expect(fixture.billing()[0].known_cost_usd).toBe(0);
    expect(fixture.billing()[0].billing_state).toBe("settled");
    expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 0 });
  });

  it("recovers all retained holds across repeated unknown failures without billing them", async () => {
    const fixture = await makeEnv([modelRow()], 1);
    const { env } = fixture;
    globalThis.fetch = vi.fn(async () => { throw new Error("unknown transport acceptance"); }) as unknown as typeof globalThis.fetch;

    for (let i = 0; i < 5; i++) {
      const exec = new CollectingExecutionContext();
      const res = await postChat(env, chatBody(), exec);
      await Promise.all(exec.pending);
      expect(res.status).toBe(502);
    }
    await expectUnknownHoldRecovery(fixture, 5);
  });

  it("retains a thrown-fetch hold until lease recovery without fabricating zero usage", async () => {
    const fixture = await makeEnv([modelRow()], 1);
    const { env } = fixture;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    await Promise.all(exec.pending);

    expect(res.status).toBe(502);
    await expectUnknownHoldRecovery(fixture, 1);
  });


  it.each([1, 50])("owns a durable hold at dispatch with $%s balance, and settles exactly once", async (balance) => {
    const { env, wallet, holds, billing, usages, ledger, d1 } = await makeEnv([modelRow()], balance);
    globalThis.fetch = vi.fn(
      async () => {
        expect(holds()).toHaveLength(1);
        expect(wallet().reserved_usd).toBeGreaterThan(0);
        expect(billing()[0].billing_state).toBe("active");
        expect(d1.rows("SELECT * FROM billing_attempts")).toHaveLength(1);
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
    ) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    await Promise.all(exec.pending);

    expect(res.status).toBe(200);
    const w = wallet();
    expect(w.reserved_usd).toBe(0);
    expect(w.balance_usd).toBeCloseTo(balance - 0.018, 9);
    expect(holds()).toHaveLength(0);
    expect(usages()).toHaveLength(1);
    expect(ledger()).toHaveLength(1);
    expect(billing()[0].billing_state).toBe("settled");
    expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 0 });
    expect(ledger()).toHaveLength(1);
  });
});
