import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_REQUEST_BODY_BYTES,
  UPSTREAM_FIRST_CHUNK_TIMEOUT_MS,
  UPSTREAM_STREAM_STALL_TIMEOUT_MS,
} from "../src/gateway/proxy";
import { CREDENTIAL_COOLDOWN_MS, isCoolingDown, resetCooldowns } from "../src/gateway/failover";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { gatewayApp } from "../src/gateway/index";
import { convertResponsesRequest } from "../src/gateway/responses_adapter";
import {
  CollectingExecutionContext,
  TOKEN,
  chatBody,
  createRealD1,
  makeEnv,
  openAiAnswer,
  postJson,
  seedDevice,
  seedModel,
  seedProvider,
  sseAnswer,
  usageRows,
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
  vi.useRealTimers();
});

async function call(env: Env, path: string, body: unknown) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, path, body, exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

function seedTwoProviders(d1: ReturnType<typeof createRealD1>) {
  seedProvider(d1, { id: "prov_a", name: "Provider A", endpoint: "https://a.example/v1", api_key: "sk-a" });
  seedProvider(d1, { id: "prov_b", name: "Provider B", endpoint: "https://b.example/v1", api_key: "sk-b" });
}

function fetchByHost(answer: Record<string, () => Response>) {
  const seen: string[] = [];
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = String(input);
    const host = url.includes("b.example") ? "b" : "a";
    seen.push(host);
    const make = answer[host];
    if (!make) return new Response("unexpected host " + host, { status: 500 });
    return make();
  }) as unknown as typeof globalThis.fetch;
  return seen;
}

describe("a failure that belongs to the provider is retried on the next one", () => {
  it("retries a rejected credential instead of telling the caller their key is wrong", async () => {
    const d1 = createRealD1();
    seedTwoProviders(d1);
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
    seedModel(d1, { id: "model_b", model_name: "gw-primary", provider_id: "prov_b" });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const seen = fetchByHost({
      a: () => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }),
      b: () => openAiAnswer(),
    });

    const { res, text } = await call(env, "/chat/completions", chatBody());

    expect(seen).toEqual(["a", "b"]);
    expect(res.status).toBe(200);
    expect(JSON.parse(text).choices).toHaveLength(1);
    expect(res.headers.get("x-gateway-attempts")).toBe("2");
    expect(text).not.toContain("invalid api key");
    d1.close();
  });

  it("benches the provider that rejected our credential", async () => {
    const d1 = createRealD1();
    seedTwoProviders(d1);
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
    seedModel(d1, { id: "model_b", model_name: "gw-primary", provider_id: "prov_b" });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    fetchByHost({
      a: () => new Response("forbidden", { status: 403 }),
      b: () => openAiAnswer(),
    });

    await call(env, "/chat/completions", chatBody());

    expect(isCoolingDown("prov_a")).toBe(true);
    expect(isCoolingDown("prov_b")).toBe(false);
    expect(isCoolingDown("prov_a", Date.now() + CREDENTIAL_COOLDOWN_MS)).toBe(false);
    d1.close();
  });

  it("retries a model the provider does not carry", async () => {
    const d1 = createRealD1();
    seedTwoProviders(d1);
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
    seedModel(d1, { id: "model_b", model_name: "gw-primary", provider_id: "prov_b" });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const seen = fetchByHost({
      a: () =>
        new Response(
          JSON.stringify({
            error: {
              message: "The model gw-primary does not exist or you do not have access to it",
              type: "invalid_request_error",
              code: "model_not_found",
            },
          }),
          { status: 404 }
        ),
      b: () => openAiAnswer(),
    });

    const { res } = await call(env, "/chat/completions", chatBody());

    expect(seen).toEqual(["a", "b"]);
    expect(res.status).toBe(200);
    d1.close();
  });

  it("retries a 404 that means the endpoint is gone", async () => {
    const d1 = createRealD1();
    seedTwoProviders(d1);
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
    seedModel(d1, { id: "model_b", model_name: "gw-primary", provider_id: "prov_b" });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const seen = fetchByHost({
      a: () => new Response("not found", { status: 404 }),
      b: () => openAiAnswer(),
    });

    const { res } = await call(env, "/chat/completions", chatBody());

    expect(seen).toEqual(["a", "b"]);
    expect(res.status).toBe(200);
    d1.close();
  });
});

describe("a failure that belongs to the request is handed back, not retried", () => {
  it("keeps a malformed request on the first provider and shows the caller why", async () => {
    const d1 = createRealD1();
    seedTwoProviders(d1);
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
    seedModel(d1, { id: "model_b", model_name: "gw-primary", provider_id: "prov_b" });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const seen = fetchByHost({
      a: () => new Response(JSON.stringify({ error: { message: "invalid value for temperature: must be at most 2" } }), { status: 400 }),
      b: () => openAiAnswer(),
    });

    const { res, text } = await call(env, "/chat/completions", chatBody());

    expect(seen).toEqual(["a"]);
    expect(res.status).toBe(400);
    expect(text).toContain("must be at most 2");
    d1.close();
  });

  it("never relays a rejected credential as the caller's problem", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", endpoint: "https://a.example/v1", api_key: "sk-a" });
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    fetchByHost({ a: () => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }) });

    const { res, text } = await call(env, "/chat/completions", chatBody());

    expect(res.status).toBe(502);
    expect(JSON.parse(text).error).toBe("upstream_service_unavailable");
    expect(text).not.toContain("invalid api key");
    expect(text).not.toContain("Provider A");
    d1.close();
  });

  it("returns the upstream answer when no other candidate exists", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", endpoint: "https://a.example/v1", api_key: "sk-a" });
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    fetchByHost({ a: () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 }) });

    const { res, text } = await call(env, "/chat/completions", chatBody());

    expect(res.status).toBe(400);
    expect(text).toContain("nope");
    d1.close();
  });

  it("does not add an attempts header to a request that never retried", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    fetchByHost({ a: () => openAiAnswer() });

    const { res } = await call(env, "/chat/completions", chatBody());

    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-attempts")).toBeNull();
    d1.close();
  });
});

describe("an oversized body is refused before it is read or billed", () => {
  it("answers 413 to a declared length over the limit without dialling upstream", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const seen = fetchByHost({ a: () => openAiAnswer() });

    const exec = new CollectingExecutionContext();
    const res = await gatewayApp.request(
      "http://gw.test/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + TOKEN,
          "Content-Type": "application/json",
          "Content-Length": String(MAX_REQUEST_BODY_BYTES + 1024),
        },
        body: JSON.stringify(chatBody()),
      },
      env,
      exec as never
    );

    expect(res.status).toBe(413);
    const payload: any = await res.json();
    expect(payload.error).toBe("request_too_large");
    expect(payload.limit_bytes).toBe(MAX_REQUEST_BODY_BYTES);
    expect(seen).toEqual([]);
    expect(usageRows(d1)).toHaveLength(0);
    d1.close();
  });

  it("answers 413 to a body that only turns out to be oversized once decoded", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const seen = fetchByHost({ a: () => openAiAnswer() });

    const exec = new CollectingExecutionContext();
    const res = await gatewayApp.request(
      "http://gw.test/chat/completions",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: "x".repeat(MAX_REQUEST_BODY_BYTES + 1),
      },
      env,
      exec as never
    );

    expect(res.status).toBe(413);
    const payload: any = await res.json();
    expect(payload.error).toBe("request_too_large");
    expect(seen).toEqual([]);
    expect(usageRows(d1)).toHaveLength(0);
    d1.close();
  });
});
