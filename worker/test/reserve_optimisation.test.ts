import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { STALE_RESERVE_CRON } from "../src/crons";
import { estimatePromptTokens, estimateRequestCostUsd, TRUSTED_BALANCE_MULTIPLIER } from "../src/gateway/proxy";
import { releaseStaleReserves } from "../src/db/repo";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import type { ModelWithProvider } from "../src/types";
import { gatewayApp } from "../src/gateway";
import {
  CollectingExecutionContext,
  TOKEN,
  chatBody,
  createRealD1,
  holdRows,
  makeEnv,
  makeKv,
  openAiAnswer,
  postJson,
  seedDevice,
  seedModel,
  seedProvider,
  wallet,
} from "./helpers/realGatewayEnv";


const baseRow = {
  id: "model_a",
  provider_id: "prov_a",
  provider_name: "Provider A",
  provider_type: "openai",
  model_name: "gw-primary",
  display_name: "gw-primary",
  alias: null,
  enabled: 1,
  config_json: null,
  input_price_per_m: 3,
  output_price_per_m: 15,
  cache_read_price_per_m: 0,
  cache_write_price_per_m: 0,
  cache_enabled: 0,
  cache_ttl: 3600,
  model_public: 1,
  peak_pricing_enabled: 0,
  pricing_mode: "priced",
  fallback_model_id: null,
} as unknown as ModelWithProvider;

describe("the cost estimate the hold is built on", () => {
  it("allows 2048 output tokens when the caller sets no limit", () => {
    const body = { model: "gw-primary", messages: [{ role: "user", content: "x" }] };
    const estimate = estimateRequestCostUsd(baseRow, body, 1, 4000);

    expect(estimate).toBeCloseTo((1000 * 3 + 2048 * 15) / 1_000_000, 12);
    expect(estimate).toBeLessThan((1000 * 3 + 4096 * 15) / 1_000_000);
  });

  it("still honours an explicit max_tokens above the default", () => {
    const body = { model: "gw-primary", messages: [], max_tokens: 8192 };
    const estimate = estimateRequestCostUsd(baseRow, body, 1, 400);
    expect(estimate).toBeCloseTo((100 * 3 + 8192 * 15) / 1_000_000, 12);
  });

  it("counts a prompt by its UTF-8 bytes when the caller has them", () => {
    const body = { model: "gw-primary", messages: [{ role: "user", content: "你好世界" }] };
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;

    expect(estimatePromptTokens(body, bytes)).toBe(Math.ceil(bytes / 4));
    expect(estimatePromptTokens(body)).toBeLessThan(estimatePromptTokens(body, bytes));
  });

  it("never under-holds a free or unpriced model", () => {
    const free = { ...baseRow, pricing_mode: "free" } as unknown as ModelWithProvider;
    expect(estimateRequestCostUsd(free, { messages: [] }, 1, 4000)).toBe(0);
  });
});

describe("the hold is built on the byte count the request really carries", () => {
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

  it("holds against UTF-8 bytes of a Chinese prompt, not its UTF-16 length", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { input_price_per_m: 1, output_price_per_m: 0 });
    await seedDevice(d1, { balance_usd: 0.001 });

    const body = { model: "gw-primary", messages: [{ role: "user", content: "你好世界".repeat(100) }] };
    const text = JSON.stringify(body);
    const bytes = new TextEncoder().encode(text).length;

    let heldUsd = -1;
    globalThis.fetch = vi.fn(async () => {
      const holds = holdRows(d1);
      heldUsd = holds.length ? Number(holds[0].amount_usd) : 0;
      return openAiAnswer({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    }) as unknown as typeof globalThis.fetch;

    const env = makeEnv(d1, makeKv());
    const exec = new CollectingExecutionContext();
    const res = await gatewayApp.request(
      "http://gw.test/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": String(bytes),
        },
        body: text,
      },
      env,
      exec as never
    );
    await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(200);
    expect(heldUsd).toBeCloseTo(Math.ceil(bytes / 4) / 1_000_000, 12);
    expect(heldUsd).toBeGreaterThan(Math.ceil(text.length / 4) / 1_000_000);
  });

  it("falls back to the text length when the client declares no length", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { input_price_per_m: 1, output_price_per_m: 0 });
    await seedDevice(d1, { balance_usd: 0.001 });

    const body = { model: "gw-primary", messages: [{ role: "user", content: "你好世界".repeat(100) }] };
    const text = JSON.stringify(body);

    let heldUsd = -1;
    globalThis.fetch = vi.fn(async () => {
      const holds = holdRows(d1);
      heldUsd = holds.length ? Number(holds[0].amount_usd) : 0;
      return openAiAnswer({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    }) as unknown as typeof globalThis.fetch;

    const env = makeEnv(d1, makeKv());
    const exec = new CollectingExecutionContext();
    const res = await postJson(env, "/chat/completions", text, exec);
    await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(200);
    expect(heldUsd).toBeCloseTo(Math.ceil(text.length / 4) / 1_000_000, 12);
  });
});

describe("every dispatched text request receives durable admission", () => {
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

  it("durably admits a hold even when the balance dwarfs the estimate", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1);
    await seedDevice(d1, { balance_usd: 100 });

    let holdsDuringRequest = -1;
    globalThis.fetch = vi.fn(async () => {
      const holds = holdRows(d1);
      holdsDuringRequest = holds.length;
      expect(holds[0].amount_usd).toBeGreaterThan(0);
      expect(d1.row("SELECT request_id, billing_state FROM billing_requests")).toMatchObject({
        request_id: holds[0].request_id, billing_state: "active",
      });
      return openAiAnswer({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    }) as unknown as typeof globalThis.fetch;

    const env = makeEnv(d1, makeKv());
    const exec = new CollectingExecutionContext();
    const res = await postJson(env, "/chat/completions", chatBody(), exec);
    await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(200);
    expect(holdsDuringRequest).toBe(1);
    expect(holdRows(d1)).toHaveLength(0);
    expect(wallet(d1)!.balance_usd).toBeLessThan(100);
  });

  it("takes a hold when the balance is only a few times the estimate", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1);
    await seedDevice(d1, { balance_usd: 0.001 });

    let holdsDuringRequest = -1;
    globalThis.fetch = vi.fn(async () => {
      const holds = holdRows(d1);
      holdsDuringRequest = holds.length;
      expect(holds[0].amount_usd).toBeGreaterThan(0);
      expect(d1.row("SELECT request_id, billing_state FROM billing_requests")).toMatchObject({
        request_id: holds[0].request_id, billing_state: "active",
      });
      return openAiAnswer({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    }) as unknown as typeof globalThis.fetch;

    const env = makeEnv(d1, makeKv());
    const exec = new CollectingExecutionContext();
    const res = await postJson(env, "/chat/completions", chatBody(), exec);
    await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(200);
    expect(holdsDuringRequest).toBe(1);
    expect(holdRows(d1)).toHaveLength(0);
  });

  it("still rejects a wallet below the estimate with 429 before dispatch", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { input_price_per_m: 100000, output_price_per_m: 100000 });
    await seedDevice(d1, { balance_usd: 0.02 });

    const fetchSpy = vi.fn(async () => openAiAnswer());
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const env = makeEnv(d1, makeKv());
    const exec = new CollectingExecutionContext();
    const res = await postJson(env, "/chat/completions", chatBody(), exec);
    const payload = JSON.parse(await res.text());
    await Promise.all(exec.pending);

    expect(res.status).toBe(429);
    expect(payload.error).toBe("insufficient_balance");
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(TRUSTED_BALANCE_MULTIPLIER).toBe(15);
  });
});

describe("the stale-hold sweep records the request it gave up on", () => {
  it("writes an aborted usage row before handing the money back", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1, { balance_usd: 1 });
    d1.sql(
      "INSERT INTO reserve_holds (request_id, device_id, amount_usd, created_at) VALUES (?, ?, ?, ?)",
      "req-aborted",
      "dev_1",
      0.25,
      Date.now() - 90 * 60 * 1000
    );
    d1.sql("UPDATE device_wallets SET reserved_usd = reserved_usd + ? WHERE device_id = ?", 0.25, "dev_1");

    const env = makeEnv(d1, makeKv());
    expect(await releaseStaleReserves(env)).toBe(1);

    expect(holdRows(d1)).toHaveLength(0);
    expect(wallet(d1)!.reserved_usd).toBe(0);
    expect(wallet(d1)!.balance_usd).toBe(1);

    const usage = d1.rows<{ model: string | null; status_code: number; cost_usd: number; request_id: string }>(
      "SELECT model, status_code, cost_usd, request_id FROM usage"
    );
    expect(usage).toHaveLength(1);
    expect(usage[0].status_code).toBe(0);
    expect(usage[0].cost_usd).toBe(0);
    expect(usage[0].model).toBeNull();
    expect(usage[0].request_id).toBe("req-aborted");
  });

  it("does not add a second row for a request that already has one", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1, { balance_usd: 1 });
    d1.sql(
      "INSERT INTO usage (device_id, provider_id, provider_name, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit, cache_read_tokens, cache_write_tokens, pricing_missing, price_multiplier, price_window_id, status_code, latency_ms, request_id, created_at) " +
        "VALUES (?, ?, ?, ?, 10, 5, 15, 0.1, 0, 0, 0, 0, 1, NULL, 200, 5, ?, ?)",
      "dev_1",
      "prov_a",
      "Provider A",
      "gw-primary",
      "req-settled",
      Date.now()
    );
    d1.sql(
      "INSERT INTO reserve_holds (request_id, device_id, amount_usd, created_at) VALUES (?, ?, ?, ?)",
      "req-settled",
      "dev_1",
      0.25,
      Date.now() - 90 * 60 * 1000
    );

    const env = makeEnv(d1, makeKv());
    expect(await releaseStaleReserves(env)).toBe(1);

    const rows = d1.rows<{ status_code: number }>("SELECT status_code FROM usage");
    expect(rows).toHaveLength(1);
    expect(rows[0].status_code).toBe(200);
  });
});

describe("the cron trigger that runs the sweep", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function runScheduled(env: ReturnType<typeof makeEnv>, event: { cron?: string }) {
    const exec = new CollectingExecutionContext();
    await (worker as any).scheduled(event as any, env, exec as any);
    await Promise.all(exec.pending);
    return exec;
  }

  function seedStaleHold(d1: ReturnType<typeof createRealD1>) {
    d1.sql(
      "INSERT INTO reserve_holds (request_id, device_id, amount_usd, created_at) VALUES (?, ?, ?, ?)",
      "req-stale",
      "dev_1",
      0.25,
      Date.now() - 90 * 60 * 1000
    );
    d1.sql("UPDATE device_wallets SET reserved_usd = reserved_usd + ? WHERE device_id = ?", 0.25, "dev_1");
  }

  it("the two-hourly trigger only sweeps, and does not run the daily pass", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1, { balance_usd: 1 });
    seedStaleHold(d1);
    d1.sql(
      "INSERT INTO usage (device_id, provider_id, provider_name, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit, cache_read_tokens, cache_write_tokens, pricing_missing, price_multiplier, price_window_id, status_code, latency_ms, request_id, created_at) " +
        "VALUES (?, ?, ?, ?, 10, 5, 15, 0.1, 0, 0, 0, 0, 1, NULL, 200, 5, NULL, ?)",
      "dev_1",
      "prov_a",
      "Provider A",
      "gw-primary",
      Date.now()
    );

    const env = makeEnv(d1, makeKv());
    await runScheduled(env, { cron: STALE_RESERVE_CRON });

    expect(holdRows(d1)).toHaveLength(0);
    expect(wallet(d1)!.reserved_usd).toBe(0);
    expect(wallet(d1)!.balance_usd).toBe(1);
    expect(d1.rows("SELECT date FROM daily_stats WHERE model = ?", "gw-primary")).toHaveLength(0);
    const swept = d1.rows<{ request_count: number; error_count: number }>(
      "SELECT request_count, error_count FROM daily_stats WHERE model = ''"
    );
    expect(swept).toEqual([{ request_count: 1, error_count: 0 }]);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("the daily trigger still runs the whole pass", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1, { balance_usd: 1 });
    seedStaleHold(d1);
    d1.sql(
      "INSERT INTO usage (device_id, provider_id, provider_name, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit, cache_read_tokens, cache_write_tokens, pricing_missing, price_multiplier, price_window_id, status_code, latency_ms, request_id, created_at) " +
        "VALUES (?, ?, ?, ?, 10, 5, 15, 0.1, 0, 0, 0, 0, 1, NULL, 200, 5, NULL, ?)",
      "dev_1",
      "prov_a",
      "Provider A",
      "gw-primary",
      Date.now()
    );

    const env = makeEnv(d1, makeKv());
    await runScheduled(env, { cron: "0 1 * * *" });

    expect(holdRows(d1)).toHaveLength(0);
    expect(d1.rows("SELECT date FROM daily_stats")).not.toHaveLength(0);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0);
  });

  it("an event without a cron expression (a manual run) does the full pass", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1, { balance_usd: 1 });
    d1.sql(
      "INSERT INTO usage (device_id, provider_id, provider_name, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit, cache_read_tokens, cache_write_tokens, pricing_missing, price_multiplier, price_window_id, status_code, latency_ms, request_id, created_at) " +
        "VALUES (?, ?, ?, ?, 10, 5, 15, 0.1, 0, 0, 0, 0, 1, NULL, 200, 5, NULL, ?)",
      "dev_1",
      "prov_a",
      "Provider A",
      "gw-primary",
      Date.now()
    );

    const env = makeEnv(d1, makeKv());
    await runScheduled(env, {});

    expect(d1.rows("SELECT date FROM daily_stats")).not.toHaveLength(0);
  });
});
