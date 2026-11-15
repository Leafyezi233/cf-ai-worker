import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { checkAndRecordRateLimit, resetRateLimitMemory } from "../src/gateway/ratelimit";
import {
  CollectingExecutionContext,
  chatBody,
  createRealD1,
  holdRows,
  makeEnv,
  makeKv,
  postJson,
  seedDevice,
  seedModel,
  seedProvider,
  wallet,
} from "./helpers/realGatewayEnv";


let realFetch: typeof globalThis.fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetRateLimitMemory();
  clearMemoryCacheForTest();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function seedFallbackPair(d1: ReturnType<typeof createRealD1>, rpm: number) {
  seedProvider(d1, { id: "prov_a" });
  seedProvider(d1, { id: "prov_z", name: "Provider Z", api_key: "sk-z", endpoint: "https://z.example/v1" });
  seedModel(d1, { id: "model_a", fallback_model_id: "model_z" });
  seedModel(d1, { id: "model_z", model_name: "owner-chosen-backup", provider_id: "prov_z" });
  d1.sql("INSERT OR REPLACE INTO device_models (device_id, model_id, rpm) VALUES (?, ?, ?)", "dev_1", "model_z", rpm);
}

describe("the fallback's own rate-limit path releases the hold", () => {
  it("returns 429 from the fallback block and gives the reservation back", async () => {
    const d1 = createRealD1();
    seedFallbackPair(d1, 1);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1, makeKv());

    expect(await checkAndRecordRateLimit(env, "dev_1::model::model_z", 1)).toBe(true);

    globalThis.fetch = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof globalThis.fetch;
    const exec = new CollectingExecutionContext();
    const res = await postJson(env, "/chat/completions", chatBody(), exec);
    const text = await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(429);
    expect(JSON.parse(text)).toMatchObject({ error: "rate_limit_exceeded", model: "owner-chosen-backup" });
    expect(wallet(d1)!.reserved_usd).toBe(0);
    expect(wallet(d1)!.balance_usd).toBe(1);
    expect(holdRows(d1)).toHaveLength(0);
  });

  it("still returns the 502 and releases the hold when the fallback is not rate-limited", async () => {
    const d1 = createRealD1();
    seedFallbackPair(d1, 10);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1, makeKv());

    globalThis.fetch = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof globalThis.fetch;
    const exec = new CollectingExecutionContext();
    const res = await postJson(env, "/chat/completions", chatBody(), exec);
    await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(502);
    expect(wallet(d1)!.reserved_usd).toBe(0);
    expect(wallet(d1)!.balance_usd).toBe(1);
    expect(holdRows(d1)).toHaveLength(0);
  });
});
