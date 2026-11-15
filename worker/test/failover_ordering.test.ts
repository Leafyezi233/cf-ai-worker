import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberCooldown, resetCooldowns } from "../src/gateway/failover";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import {
  CollectingExecutionContext,
  chatBody,
  createRealD1,
  makeEnv,
  openAiAnswer,
  postJson,
  seedDevice,
  seedModel,
  seedProvider,
} from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";


let realFetch: typeof globalThis.fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetRateLimitMemory();
  resetCooldowns();
  clearMemoryCacheForTest();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

type D1 = ReturnType<typeof createRealD1>;

function seedTrio(d1: D1) {
  seedProvider(d1, { id: "prov_a", name: "Provider A", endpoint: "https://a.example/v1", api_key: "sk-a" });
  seedProvider(d1, { id: "prov_b", name: "Provider B", endpoint: "https://b.example/v1", api_key: "sk-b" });
  seedProvider(d1, { id: "prov_c", name: "Provider C", endpoint: "https://c.example/v1", api_key: "sk-c" });
  seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
  seedModel(d1, { id: "model_b", model_name: "gw-primary", provider_id: "prov_b" });
  seedModel(d1, { id: "model_c", model_name: "gw-primary", provider_id: "prov_c" });
}

function dialsWithSickPrimary(healthy: string[]) {
  const seen: string[] = [];
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = String(input);
    const host = ["a", "b", "c"].find((name) => url.includes(name + ".example")) ?? "?";
    seen.push(host);
    if (host === "a") return new Response("down", { status: 503 });
    if (healthy.includes(host)) return openAiAnswer();
    return new Response("down", { status: 503 });
  }) as unknown as typeof globalThis.fetch;
  return seen;
}

function priorUsage(d1: D1, providerId: string, statusCode: number, ageMs = 1_000) {
  d1.sql(
    "INSERT INTO usage (device_id, provider_id, provider_name, model, cost_usd, latency_ms, status_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "dev_1",
    providerId,
    providerId,
    "gw-primary",
    0,
    statusCode >= 400 ? 0 : 100,
    statusCode,
    Date.now() - ageMs
  );
}

async function call(env: Env) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, "/chat/completions", chatBody(), exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

describe("the failover pool is ordered by what the usage table remembers", () => {
  it("tries the healthy sibling before a provider that has been failing", async () => {
    const d1 = createRealD1();
    seedTrio(d1);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    priorUsage(d1, "prov_b", 500, 1_000);
    priorUsage(d1, "prov_b", 500, 2_000);
    priorUsage(d1, "prov_b", 500, 3_000);
    const seen = dialsWithSickPrimary(["b", "c"]);

    const { res, text } = await call(env);

    expect(res.status).toBe(200);
    expect(JSON.parse(text).choices).toHaveLength(1);
    expect(seen).toEqual(["a", "c"]);
    expect(res.headers.get("x-gateway-attempts")).toBe("2");
    d1.close();
  });

  it("ignores a failure rate that rests on too few attempts", async () => {
    const d1 = createRealD1();
    seedTrio(d1);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    priorUsage(d1, "prov_b", 500, 1_000);
    const seen = dialsWithSickPrimary(["b", "c"]);

    await call(env);

    expect(seen).toEqual(["a", "b"]);
    d1.close();
  });

  it("passes over a provider that just refused our credential", async () => {
    const d1 = createRealD1();
    seedTrio(d1);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    rememberCooldown("prov_b", 60_000);
    const seen = dialsWithSickPrimary(["b", "c"]);

    await call(env);

    expect(seen).toEqual(["a", "c"]);
    d1.close();
  });

  it("still fails over when the health read itself breaks", async () => {
    const d1 = createRealD1();
    seedTrio(d1);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const realPrepare = env.DB.prepare.bind(env.DB);
    let failedHealthReads = 0;
    env.DB.prepare = ((sql: string) => {
      if (/COUNT\(\*\)\s+as attempts/i.test(sql) && /as failures\s+FROM usage/i.test(sql) && /GROUP BY provider_id/i.test(sql)) {
        failedHealthReads++;
        throw new Error("D1 is having a day");
      }
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const seen = dialsWithSickPrimary(["b", "c"]);

    const { res } = await call(env);

    expect(failedHealthReads).toBe(1);
    expect(res.status).toBe(200);
    expect(seen).toEqual(["a", "b"]);
    d1.close();
  });
});
