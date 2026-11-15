import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import {
  CollectingExecutionContext,
  createRealD1,
  makeEnv,
  makeKv,
  openAiAnswer,
  openAiStreamFrames,
  seedDevice,
  seedModel,
  seedProvider,
  sseAnswer,
  usageRows,
  wallet,
} from "./helpers/realGatewayEnv";
import { gatewayApp } from "../src/gateway/index";
import { TOKEN } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";


let realFetch: typeof globalThis.fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetRateLimitMemory();
  clearMemoryCacheForTest();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function responsesBody(extra: Record<string, unknown> = {}) {
  return {
    model: "gw-primary",
    instructions: "be brief",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    max_output_tokens: 8,
    ...extra,
  };
}

async function callResponses(env: Env, body: unknown) {
  const exec = new CollectingExecutionContext();
  const res = await gatewayApp.request(
    "http://gw.test/responses",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
    exec as never
  );
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

async function seed(cacheEnabled: number, balanceUsd = 1) {
  const d1 = createRealD1();
  seedProvider(d1);
  seedModel(d1, { cache_enabled: cacheEnabled });
  await seedDevice(d1, { balance_usd: balanceUsd });
  const kv = makeKv();
  return { d1, kv, env: makeEnv(d1, kv) };
}

describe("the responses adapter caches and bills its answers", () => {
  it("caches a non-streamed responses answer with its first-time price", async () => {
    const { d1, kv, env } = await seed(1);
    globalThis.fetch = vi.fn(async () => openAiAnswer()) as unknown as typeof globalThis.fetch;

    const first = await callResponses(env, responsesBody());
    expect(first.res.status).toBe(200);
    expect(kv.writes).toHaveLength(1);
    expect(kv.writes[0].key.startsWith("aigw:cache:v3:responses:")).toBe(true);

    const payload = JSON.parse(kv.writes[0].value);
    expect(payload.billing).toMatchObject({ cost_usd: 0.018, pricing_mode: "priced" });

    globalThis.fetch = vi.fn(async () => {
      throw new Error("a cache hit must not reach the upstream");
    }) as unknown as typeof globalThis.fetch;

    const second = await callResponses(env, responsesBody());
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get("X-Cache")).toBe("HIT");
    expect(wallet(d1)!.balance_usd).toBeCloseTo(0.964, 10);
    const rows = usageRows(d1);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ cache_hit: 1 });
    expect(rows[1].cost_usd).toBeCloseTo(rows[0].cost_usd, 10);
  });

  it("caches a streamed responses answer with its first-time price", async () => {
    const { d1, kv, env } = await seed(1);
    globalThis.fetch = vi.fn(async () => sseAnswer(openAiStreamFrames())) as unknown as typeof globalThis.fetch;

    const first = await callResponses(env, responsesBody({ stream: true }));
    expect(first.res.status).toBe(200);
    expect(kv.writes).toHaveLength(1);
    expect(kv.writes[0].key.startsWith("aigw:cache:v3:responses:")).toBe(true);
    expect(JSON.parse(kv.writes[0].value).billing.cost_usd).toBeGreaterThan(0);

    globalThis.fetch = vi.fn(async () => {
      throw new Error("a cache hit must not reach the upstream");
    }) as unknown as typeof globalThis.fetch;

    const second = await callResponses(env, responsesBody({ stream: true }));
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get("X-Cache")).toBe("HIT");
    expect(wallet(d1)!.balance_usd).toBeLessThan(1);
    expect(usageRows(d1)).toHaveLength(2);
  });

  it("leaves the cache alone when the model has caching switched off", async () => {
    const { kv, env } = await seed(0);
    globalThis.fetch = vi.fn(async () => openAiAnswer()) as unknown as typeof globalThis.fetch;

    const { res } = await callResponses(env, responsesBody());
    expect(res.status).toBe(200);
    expect(kv.writes).toHaveLength(0);
  });
});
