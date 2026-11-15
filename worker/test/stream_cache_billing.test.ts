import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import {
  CollectingExecutionContext,
  chatBody,
  createRealD1,
  makeEnv,
  makeKv,
  openAiStreamFrames,
  postJson,
  seedDevice,
  seedModel,
  seedProvider,
  sseAnswer,
  usageRows,
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

async function streamOnce(
  env: Parameters<typeof postJson>[0],
  headers: Record<string, string> = {}
) {
  const { gatewayApp } = await import("../src/gateway/index");
  const { TOKEN } = await import("./helpers/realGatewayEnv");
  const exec = new CollectingExecutionContext();
  const res = await gatewayApp.request(
    "http://gw.test/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(chatBody("gw-primary", { stream: true })),
    },
    env,
    exec as never
  );
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text, exec };
}

describe("a streamed answer is cached and billed like any other", () => {
  it("writes the stream into the cache so the next identical request is a hit", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { cache_enabled: 1 });
    await seedDevice(d1, { balance_usd: 1 });
    const kv = makeKv();
    const env = makeEnv(d1, kv);
    globalThis.fetch = vi.fn(async () => sseAnswer(openAiStreamFrames())) as unknown as typeof globalThis.fetch;

    const first = await streamOnce(env);
    expect(first.res.status).toBe(200);
    expect(kv.writes).toHaveLength(1);
    expect(kv.writes[0].key.startsWith("aigw:cache:v3:")).toBe(true);

    const payload = JSON.parse(kv.writes[0].value);
    expect(payload.billing).toMatchObject({ cost_usd: 0.018, pricing_mode: "priced" });
    expect(payload.usage).toMatchObject({ input_tokens: 1000, output_tokens: 1000 });

    globalThis.fetch = vi.fn(async () => {
      throw new Error("a cache hit must not reach the upstream");
    }) as unknown as typeof globalThis.fetch;

    const second = await streamOnce(env);
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get("X-Cache")).toBe("HIT");
    expect(second.text).toContain("pong");
  });

  it("bills the replay at the first-time price even after the list price changes", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { cache_enabled: 1 });
    await seedDevice(d1, { balance_usd: 1 });
    const kv = makeKv();
    const env = makeEnv(d1, kv);
    globalThis.fetch = vi.fn(async () => sseAnswer(openAiStreamFrames())) as unknown as typeof globalThis.fetch;

    await streamOnce(env);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(0.982, 10);

    d1.sql("UPDATE models SET input_price_per_m = 6, output_price_per_m = 30 WHERE model_name = 'gw-primary'");

    const second = await streamOnce(env);
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get("X-Cache")).toBe("HIT");

    expect(wallet(d1)!.balance_usd).toBeCloseTo(0.964, 10);
    const rows = usageRows(d1);
    expect(rows).toHaveLength(2);
    expect(rows[1].cache_hit).toBe(1);
    expect(rows[1].cost_usd).toBeCloseTo(rows[0].cost_usd, 10);
  });

  it("does not cache a stream when the model has caching switched off", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { cache_enabled: 0 });
    await seedDevice(d1, { balance_usd: 1 });
    const kv = makeKv();
    const env = makeEnv(d1, kv);
    globalThis.fetch = vi.fn(async () => sseAnswer(openAiStreamFrames())) as unknown as typeof globalThis.fetch;

    const { res } = await streamOnce(env);
    expect(res.status).toBe(200);
    expect(kv.writes).toHaveLength(0);
  });

  it("answers a bypass request from upstream even when the entry already exists", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { cache_enabled: 1 });
    await seedDevice(d1, { balance_usd: 1 });
    const kv = makeKv();
    const env = makeEnv(d1, kv);
    const upstream = vi.fn(async () => sseAnswer(openAiStreamFrames()));
    globalThis.fetch = upstream as unknown as typeof globalThis.fetch;

    await streamOnce(env);
    expect(kv.writes).toHaveLength(1);

    const { res } = await streamOnce(env, { "x-cache-bypass": "true" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

