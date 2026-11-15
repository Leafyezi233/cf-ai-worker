import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { gatewayApp } from "../src/gateway/index";
import {
  CollectingExecutionContext,
  chatBody,
  createRealD1,
  makeEnv,
  makeKv,
  openAiAnswer,
  postJson,
  seedDevice,
  seedDeviceGroups,
  seedDeviceModels,
  seedGroup,
  seedGroupMembers,
  seedModel,
  seedProvider,
  usageAttribution,
  usageRows,
  wallet,
} from "./helpers/realGatewayEnv";
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

function recordUpstreams(answer: () => Response) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: any) => {
    calls.push(String(input));
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

function failThenSucceed(failures: number) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: any) => {
    calls.push(String(input));
    if (calls.length <= failures) return new Response("upstream down", { status: 503 });
    return openAiAnswer();
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

async function callGroup(env: Env, body: unknown = chatBody("gw-group")) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, "/chat/completions", body, exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text, exec };
}

function seedTwoMembers(d1: ReturnType<typeof createRealD1>) {
  seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
  seedProvider(d1, { id: "prov_b", name: "Provider B", type: "openai", endpoint: "https://b.example/v1", api_key: "sk-b" });
  seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
  seedModel(d1, { id: "model_b", model_name: "gw-backup", provider_id: "prov_b" });
}

describe("a group answers and bills as one model", () => {
  it("names and bills the group, not the member that answered", async () => {
    const d1 = createRealD1();
    seedTwoMembers(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", input_price_per_m: 9, output_price_per_m: 45 });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => openAiAnswer());

    const { res, text } = await callGroup(env);

    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://a.example/v1/chat/completions"]);
    expect(JSON.parse(text).model).toBe("gw-group");

    const rows = usageAttribution(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("gw-group");
    expect(rows[0].provider_id).toBe("prov_a");
    expect(rows[0].provider_name).toBe("Provider A");
    expect(rows[0].cost_usd).toBeCloseTo(0.054, 10);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(0.946, 10);
    d1.close();
  });

  it("tries members in the order the administrator authored, not by created_at", async () => {
    const d1 = createRealD1();
    seedTwoMembers(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_b", "model_a"]);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => openAiAnswer());

    const { res } = await callGroup(env);

    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://b.example/v1/chat/completions"]);
    d1.close();
  });

  it("fails over to the next member while still answering as the group at the group's price", async () => {
    const d1 = createRealD1();
    seedTwoMembers(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", input_price_per_m: 9, output_price_per_m: 45 });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = failThenSucceed(1);

    const { res, text } = await callGroup(env);

    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://a.example/v1/chat/completions", "https://b.example/v1/chat/completions"]);
    expect(JSON.parse(text).model).toBe("gw-group");

    const rows = usageAttribution(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("gw-group");
    expect(rows[0].provider_id).toBe("prov_b");
    expect(rows[0].cost_usd).toBeCloseTo(0.054, 10);
    d1.close();
  });

  it("does not inherit a member's fallback model", async () => {
    const d1 = createRealD1();
    seedTwoMembers(d1);
    seedModel(d1, { id: "model_fb", model_name: "gw-fallback", provider_id: "prov_b" });
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a", fallback_model_id: "model_fb" });
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      calls.push(String(input));
      return new Response("upstream down", { status: 503 });
    }) as unknown as typeof globalThis.fetch;

    const { res } = await callGroup(env);

    expect(res.status).toBe(502);
    expect(calls).toEqual(["https://a.example/v1/chat/completions"]);
    d1.close();
  });
});

describe("a group is gated exactly like a model", () => {
  it("refuses a group whose own price was never configured, even when its members are priced", async () => {
    const d1 = createRealD1();
    seedTwoMembers(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", pricing_mode: "unset", input_price_per_m: 0, output_price_per_m: 0 });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => openAiAnswer());

    const { res, text } = await callGroup(env);

    expect(res.status).toBe(400);
    expect(JSON.parse(text).error).toBe("model_pricing_missing");
    expect(calls).toEqual([]);
    d1.close();
  });

  it("refuses a group no member can currently serve", async () => {
    const d1 = createRealD1();
    seedTwoMembers(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    d1.sql("UPDATE models SET enabled = 0");
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => openAiAnswer());

    const { res, text } = await callGroup(env);

    expect(res.status).toBe(503);
    expect(JSON.parse(text).error).toBe("model_unavailable");
    expect(calls).toEqual([]);
    d1.close();
  });

  it("answers 404 for a disabled group", async () => {
    const d1 = createRealD1();
    seedTwoMembers(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", enabled: 0 });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);

    const { res, text } = await callGroup(env);

    expect(res.status).toBe(404);
    expect(JSON.parse(text).error).toBe("model_not_found");
    d1.close();
  });

  it("lets a list-scoped device call a granted group, and refuses an ungranted one", async () => {
    const d1 = createRealD1();
    seedTwoMembers(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1, { balance_usd: 1, model_scope: "list" });
    const env = makeEnv(d1);
    recordUpstreams(() => openAiAnswer());

    seedDeviceModels(d1, ["model_a"]);
    const refused = await callGroup(env);
    expect(refused.res.status).toBe(403);
    expect(JSON.parse(refused.text).error).toBe("model_not_in_scope");

    seedDeviceGroups(d1, ["grp_a"]);
    const allowed = await callGroup(env);
    expect(allowed.res.status).toBe(200);
    expect(JSON.parse(allowed.text).model).toBe("gw-group");
    d1.close();
  });

  it("spends one RPM budget for the whole group, not one per member", async () => {
    const d1 = createRealD1();
    seedTwoMembers(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1, { balance_usd: 1 });
    seedDeviceGroups(d1, ["grp_a"], { grp_a: 1 });
    const env = makeEnv(d1);
    recordUpstreams(() => openAiAnswer());

    const first = await callGroup(env);
    expect(first.res.status).toBe(200);

    const second = await callGroup(env);
    expect(second.res.status).toBe(429);
    expect(JSON.parse(second.text).error).toBe("rate_limit_exceeded");
    expect(JSON.parse(second.text).model).toBe("gw-group");
    d1.close();
  });
});

describe("a group prices itself", () => {
  it("bills at its OWN peak band, not at its first member's", async () => {
    const d1 = createRealD1();
    seedTwoMembers(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", input_price_per_m: 9, output_price_per_m: 45, peak_pricing_enabled: 1 });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1, { balance_usd: 1 });
    d1.sql("UPDATE models SET peak_pricing_enabled = 1 WHERE id = 'model_a'");
    const { PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES, peakPricingDayKey } = await import("../src/db/repo");
    const today = peakPricingDayKey(PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES, Date.now()).day;
    for (const [id, modelId, mult] of [["pw_member", "model_a", 5], ["pw_group", "grp_a", 2]] as const) {
      d1.sql(
        "INSERT INTO price_windows (id, model_id, day_type, start_minute, end_minute, multiplier, enabled, created_at, updated_at) VALUES (?, ?, ?, 0, 1440, ?, 1, 1, 1)",
        id,
        modelId,
        today,
        mult
      );
    }
    const env = makeEnv(d1);
    recordUpstreams(() => openAiAnswer());

    const { res } = await callGroup(env);

    expect(res.status).toBe(200);
    const rows = d1.rows<{ cost_usd: number; price_multiplier: number; price_window_id: string }>(
      "SELECT cost_usd, price_multiplier, price_window_id FROM usage"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].price_multiplier).toBe(2);
    expect(rows[0].price_window_id).toBe("pw_group");
    expect(rows[0].cost_usd).toBeCloseTo(0.108, 10);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(0.892, 10);
    d1.close();
  });

  it("reserves against the group's price, so a member's cheap list price cannot under-hold the wallet", async () => {
    const d1 = createRealD1();
    seedTwoMembers(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", input_price_per_m: 100000, output_price_per_m: 100000 });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1, { balance_usd: 0.02 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => openAiAnswer());

    const { res, text } = await callGroup(env);

    expect(res.status).toBe(429);
    expect(JSON.parse(text).error).toBe("insufficient_balance");
    expect(calls).toEqual([]);
    d1.close();
  });
});

describe("a group owns its cache namespace", () => {
  it("caches under the group's name and serves the next call from it", async () => {
    const d1 = createRealD1();
    seedTwoMembers(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", cache_enabled: 1 });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1, { balance_usd: 1 });
    const kv = makeKv();
    const env = makeEnv(d1, kv);
    recordUpstreams(() => openAiAnswer());

    const first = await callGroup(env);
    expect(first.res.status).toBe(200);
    expect(kv.writes).toHaveLength(1);
    expect(kv.writes[0].key).toContain(":gw-group:");
    expect(kv.writes[0].key.startsWith("aigw:cache:v3:chat/completions:")).toBe(true);

    globalThis.fetch = vi.fn(async () => {
      throw new Error("a cache hit must not reach the upstream");
    }) as unknown as typeof globalThis.fetch;

    const second = await callGroup(env);
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get("X-Cache")).toBe("HIT");
    expect(second.res.headers.get("X-Cache-Key")).toBe("gw-group");

    const rows = usageRows(d1);
    expect(rows).toHaveLength(2);
    expect(rows[1].cache_hit).toBe(1);
    expect(rows[1].cost_usd).toBeCloseTo(rows[0].cost_usd, 10);
    d1.close();
  });

  it("writes nothing when the group has caching off, even if every member has it on", async () => {
    const d1 = createRealD1();
    seedTwoMembers(d1);
    d1.sql("UPDATE models SET cache_enabled = 1");
    seedGroup(d1, { id: "grp_a", name: "gw-group", cache_enabled: 0 });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1, { balance_usd: 1 });
    const kv = makeKv();
    const env = makeEnv(d1, kv);
    recordUpstreams(() => openAiAnswer());

    const { res } = await callGroup(env);

    expect(res.status).toBe(200);
    expect(kv.writes).toHaveLength(0);
    d1.close();
  });
});
