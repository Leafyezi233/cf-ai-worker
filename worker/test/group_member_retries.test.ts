import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import type { Env } from "../src/types";
import {
  CollectingExecutionContext,
  chatBody,
  createRealD1,
  makeEnv,
  openAiAnswer,
  postJson,
  seedDevice,
  seedGroup,
  seedGroupMembers,
  seedModel,
  seedProvider,
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

interface Call {
  url: string;
  status: number | "throw";
}

function recordCalls(script: (call: number, input: unknown) => Response | "throw") {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (input: any, _init: any) => {
    const url = String(input instanceof Request ? input.url : input);
    const outcome = script(calls.length + 1, input);
    calls.push({ url, status: outcome === "throw" ? "throw" : outcome.status });
    if (outcome === "throw") throw new Error("socket dead");
    return outcome;
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

function seedGroupOfTwo(d1: ReturnType<typeof createRealD1>, groupConfig: string | null) {
  seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
  seedProvider(d1, { id: "prov_b", name: "Provider B", type: "openai", endpoint: "https://b.example/v1", api_key: "sk-b" });
  seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
  seedModel(d1, { id: "model_b", model_name: "gw-backup", provider_id: "prov_b" });
  seedGroup(d1, { id: "grp_a", name: "gw-group", config_json: groupConfig });
  seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
}

async function callGroup(env: Env) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, "/chat/completions", chatBody("gw-group"), exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

describe("group member_retries", () => {
  it("re-dials the same member on a 503 before moving on", async () => {
    const d1 = createRealD1();
    seedGroupOfTwo(d1, JSON.stringify({ member_retries: 2 }));
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordCalls((n) => (n === 1 ? new Response("boom", { status: 503 }) : openAiAnswer()));

    const { res } = await callGroup(env);

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("a.example");
    expect(calls[1].url).toContain("a.example");
    expect(res.headers.get("x-gateway-attempts")).toBe("2");
    d1.close();
  });

  it("retries an explicit 429 rate-limit rejection", async () => {
    const d1 = createRealD1();
    seedGroupOfTwo(d1, JSON.stringify({ member_retries: 1 }));
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    let n = 0;
    const calls = recordCalls(() => (++n === 1 ? new Response("slow down", { status: 429 }) : openAiAnswer()));

    const { res } = await callGroup(env);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("a.example");
    d1.close();
  });

  it("does not replay an unknown-acceptance network error", async () => {
    const d1 = createRealD1();
    seedGroupOfTwo(d1, JSON.stringify({ member_retries: 1 }));
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordCalls((n) => (n === 1 ? "throw" : openAiAnswer()));

    const { res } = await callGroup(env);
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("a.example");
    expect(d1.rows("SELECT * FROM usage")).toHaveLength(0);
    d1.close();
  });

  it("moves to the next member when the retries run out", async () => {
    const d1 = createRealD1();
    seedGroupOfTwo(d1, JSON.stringify({ member_retries: 1 }));
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordCalls((n, input) =>
      String(input instanceof Request ? input.url : input).includes("a.example")
        ? new Response("boom", { status: 503 })
        : openAiAnswer()
    );

    const { res } = await callGroup(env);

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain("a.example");
    expect(calls[1].url).toContain("a.example");
    expect(calls[2].url).toContain("b.example");
    expect(res.headers.get("x-gateway-attempts")).toBe("3");
    d1.close();
  });

  it("keeps today's behaviour when member_retries is absent", async () => {
    const d1 = createRealD1();
    seedGroupOfTwo(d1, null);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordCalls((n) => (n === 1 ? new Response("boom", { status: 503 }) : openAiAnswer()));

    const { res } = await callGroup(env);

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("a.example");
    expect(calls[1].url).toContain("b.example");
    d1.close();
  });

  it("never re-dials a member that rejected the REQUEST (400)", async () => {
    const d1 = createRealD1();
    seedGroupOfTwo(d1, JSON.stringify({ member_retries: 2 }));
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordCalls(() =>
      new Response(JSON.stringify({ error: { message: "invalid value: temperature" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { res } = await callGroup(env);

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(1);
    d1.close();
  });

  it("never re-dials a member that rejected our credential (401) -- it moves on", async () => {
    const d1 = createRealD1();
    seedGroupOfTwo(d1, JSON.stringify({ member_retries: 2 }));
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordCalls((n) => (n === 1 ? new Response("bad key", { status: 401 }) : openAiAnswer()));

    const { res } = await callGroup(env);

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("a.example");
    expect(calls[1].url).toContain("b.example");
    d1.close();
  });

  it("clamps the setting: 99 means 3, a string means 0", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
    seedGroup(d1, { id: "grp_a", name: "gw-group", config_json: JSON.stringify({ member_retries: 99 }) });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordCalls(() => new Response("boom", { status: 503 }));

    const { res } = await callGroup(env);
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(4);
    d1.close();
  });

  it("ignores a non-numeric member_retries (behaves as 0)", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
    seedGroup(d1, { id: "grp_a", name: "gw-group", config_json: JSON.stringify({ member_retries: "2" }) });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordCalls(() => new Response("boom", { status: 503 }));

    const { res } = await callGroup(env);
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
    d1.close();
  });

  it("excludes per-call groups: a failed image-group member is never re-dialled", async () => {
    const d1 = createRealD1();
    seedGroupOfTwo(d1, JSON.stringify({ member_retries: 2 }));
    d1.sql("UPDATE model_groups SET billing_unit = 'call', price_per_call = 0.01 WHERE id = 'grp_a'");
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordCalls((n) => (n === 1 ? new Response("boom", { status: 503 }) : openAiAnswer()));

    const { res, text } = await callGroup(env);

    expect(res.status).toBe(400);
    expect(JSON.parse(text).error).toBe("per_call_text_only");
    expect(calls).toHaveLength(0);
    d1.close();
  });
});
