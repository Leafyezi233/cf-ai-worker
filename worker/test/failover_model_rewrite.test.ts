import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  seedGroup,
  seedGroupMembers,
  seedModel,
  seedProvider,
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

function recordUpstreamBodies(failures: number) {
  const bodies: any[] = [];
  globalThis.fetch = vi.fn(async (_input: any, init: any) => {
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length <= failures) return new Response("upstream down", { status: 503 });
    return openAiAnswer();
  }) as unknown as typeof globalThis.fetch;
  return bodies;
}

function sentModels(bodies: any[]) {
  return bodies.map((b) => b.model);
}

async function call(env: Env, model: string) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, "/chat/completions", chatBody(model), exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

function seedTwoProviders(d1: ReturnType<typeof createRealD1>) {
  seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
  seedProvider(d1, { id: "prov_b", name: "Provider B", type: "openai", endpoint: "https://b.example/v1", api_key: "sk-b" });
}

describe("a failover keeps the rename of the row that answers", () => {
  it("sends the backup row's own model_rewrite when the primary failed", async () => {
    const d1 = createRealD1();
    seedTwoProviders(d1);
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a", config_json: JSON.stringify({ model_rewrite: "vendor/a-real" }) });
    seedModel(d1, { id: "model_b", model_name: "gw-primary", provider_id: "prov_b", config_json: JSON.stringify({ model_rewrite: "vendor/b-real" }) });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordUpstreamBodies(1);

    const { res, text } = await call(env, "gw-primary");

    expect(res.status).toBe(200);
    expect(sentModels(bodies)).toEqual(["vendor/a-real", "vendor/b-real"]);
    expect(JSON.parse(text).model).toBe("gw-primary");
    d1.close();
  });

  it("does not hand the primary's rewrite to a backup row that declares none", async () => {
    const d1 = createRealD1();
    seedTwoProviders(d1);
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a", config_json: JSON.stringify({ model_rewrite: "vendor/a-real" }) });
    seedModel(d1, { id: "model_b", model_name: "gw-primary", provider_id: "prov_b" });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordUpstreamBodies(1);

    const { res } = await call(env, "gw-primary");

    expect(res.status).toBe(200);
    expect(sentModels(bodies)).toEqual(["vendor/a-real", "gw-primary"]);
    d1.close();
  });

  it("sends the fallback row's own model_rewrite when the explicit fallback answered", async () => {
    const d1 = createRealD1();
    seedTwoProviders(d1);
    seedModel(d1, { id: "model_fb", model_name: "gw-fallback", provider_id: "prov_b", config_json: JSON.stringify({ model_rewrite: "vendor/fallback-real" }) });
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a", fallback_model_id: "model_fb" });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordUpstreamBodies(1);

    const { res, text } = await call(env, "gw-primary");

    expect(res.status).toBe(200);
    expect(sentModels(bodies)).toEqual(["gw-primary", "vendor/fallback-real"]);
    expect(JSON.parse(text).model).toBe("gw-primary");
    d1.close();
  });
});

describe("a group member keeps its own rename", () => {
  it("honours the member's model_rewrite on the first attempt", async () => {
    const d1 = createRealD1();
    seedTwoProviders(d1);
    seedModel(d1, { id: "model_a", model_name: "local-handle-a", provider_id: "prov_a", config_json: JSON.stringify({ model_rewrite: "vendor/real-a" }) });
    seedModel(d1, { id: "model_b", model_name: "local-handle-b", provider_id: "prov_b", config_json: JSON.stringify({ model_rewrite: "vendor/real-b" }) });
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordUpstreamBodies(0);

    const { res, text } = await call(env, "gw-group");

    expect(res.status).toBe(200);
    expect(sentModels(bodies)).toEqual(["vendor/real-a"]);
    expect(JSON.parse(text).model).toBe("gw-group");
    d1.close();
  });

  it("honours each member's own rename across a failover", async () => {
    const d1 = createRealD1();
    seedTwoProviders(d1);
    seedModel(d1, { id: "model_a", model_name: "local-handle-a", provider_id: "prov_a", config_json: JSON.stringify({ model_rewrite: "vendor/real-a" }) });
    seedModel(d1, { id: "model_b", model_name: "local-handle-b", provider_id: "prov_b", config_json: JSON.stringify({ model_rewrite: "vendor/real-b" }) });
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordUpstreamBodies(1);

    const { res } = await call(env, "gw-group");

    expect(res.status).toBe(200);
    expect(sentModels(bodies)).toEqual(["vendor/real-a", "vendor/real-b"]);
    d1.close();
  });

  it("lets a group-level rewrite cover a member that declares none", async () => {
    const d1 = createRealD1();
    seedTwoProviders(d1);
    seedModel(d1, { id: "model_a", model_name: "local-handle-a", provider_id: "prov_a" });
    seedModel(d1, { id: "model_b", model_name: "local-handle-b", provider_id: "prov_b" });
    seedGroup(d1, { id: "grp_a", name: "gw-group", config_json: JSON.stringify({ model_rewrite: "vendor/group-target" }) });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordUpstreamBodies(1);

    const { res } = await call(env, "gw-group");

    expect(res.status).toBe(200);
    expect(sentModels(bodies)).toEqual(["vendor/group-target", "vendor/group-target"]);
    d1.close();
  });
});
