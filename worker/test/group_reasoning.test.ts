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

function recordBodies(answer: (call: number) => Response) {
  const bodies: Array<Record<string, any>> = [];
  globalThis.fetch = vi.fn(async (_input: any, init: any) => {
    bodies.push(JSON.parse(String(init.body)));
    return answer(bodies.length);
  }) as unknown as typeof globalThis.fetch;
  return bodies;
}

function seedGroupOfTwo(d1: ReturnType<typeof createRealD1>, firstConfig: string | null, secondConfig: string | null) {
  seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
  seedProvider(d1, { id: "prov_b", name: "Provider B", type: "openai", endpoint: "https://b.example/v1", api_key: "sk-b" });
  seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a", config_json: firstConfig });
  seedModel(d1, { id: "model_b", model_name: "gw-backup", provider_id: "prov_b", config_json: secondConfig });
  seedGroup(d1, { id: "grp_a", name: "gw-group" });
  seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
}

async function callGroup(env: Env, extra: Record<string, unknown>) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, "/chat/completions", chatBody("gw-group", extra), exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

const shortLadder = JSON.stringify({ supported_reasoning_levels: ["low", "medium", "high"] });

describe("a group degrades an effort its member cannot honour", () => {
  it("keeps the caller's level when the first member carries it", async () => {
    const d1 = createRealD1();
    seedGroupOfTwo(d1, JSON.stringify({ capabilities: ["reasoning"] }), null);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordBodies(() => openAiAnswer());

    const { res } = await callGroup(env, { reasoning_effort: "high" });

    expect(res.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].reasoning_effort).toBe("high");
    d1.close();
  });

  it("rewrites the level to the member's second-highest rung instead of failing", async () => {
    const d1 = createRealD1();
    seedGroupOfTwo(d1, shortLadder, null);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordBodies(() => openAiAnswer());

    const { res, text } = await callGroup(env, { reasoning_effort: "xhigh" });

    expect(res.status).toBe(200);
    expect(bodies[0].reasoning_effort).toBe("medium");
    expect(JSON.parse(text).model).toBe("gw-group");
    d1.close();
  });

  it("rewrites every spelling of the level on a /v1/responses-style body", async () => {
    const d1 = createRealD1();
    seedGroupOfTwo(d1, shortLadder, null);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordBodies(() => openAiAnswer());

    await callGroup(env, { reasoning_effort: "xhigh", output_config: { effort: "xhigh" } });

    expect(bodies[0].reasoning_effort).toBe("medium");
    expect(bodies[0].output_config.effort).toBe("medium");
    d1.close();
  });

  it("removes the effort for a member that cannot reason at all, and still answers", async () => {
    const d1 = createRealD1();
    seedGroupOfTwo(d1, null, null);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordBodies(() => openAiAnswer());

    const { res, text } = await callGroup(env, { reasoning_effort: "high" });

    expect(res.status).toBe(200);
    expect("reasoning_effort" in bodies[0]).toBe(false);
    expect(JSON.parse(text).model).toBe("gw-group");
    d1.close();
  });

  it("degrades per member on failover rather than reusing the first member's level", async () => {
    const d1 = createRealD1();
    seedGroupOfTwo(d1, shortLadder, null);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordBodies((call) =>
      call === 1 ? new Response("upstream down", { status: 503 }) : openAiAnswer()
    );

    const { res } = await callGroup(env, { reasoning_effort: "xhigh" });

    expect(res.status).toBe(200);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].reasoning_effort).toBe("medium");
    expect("reasoning_effort" in bodies[1]).toBe(false);
    d1.close();
  });

  it("honours a group that vetoes reasoning by removing the effort before any member sees it", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a", config_json: JSON.stringify({ capabilities: ["reasoning"] }) });
    seedGroup(d1, { id: "grp_a", name: "gw-group", config_json: JSON.stringify({ supports_reasoning: false }) });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordBodies(() => openAiAnswer());

    const { res } = await callGroup(env, { reasoning_effort: "high" });

    expect(res.status).toBe(200);
    expect("reasoning_effort" in bodies[0]).toBe(false);
    d1.close();
  });

  it("leaves a plain model's own ladder in charge, unchanged", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a", config_json: shortLadder });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordBodies(() => openAiAnswer());

    const exec = new CollectingExecutionContext();
    const res = await postJson(env, "/chat/completions", chatBody("gw-primary", { reasoning_effort: "xhigh" }), exec);
    await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(200);
    expect(bodies[0].reasoning_effort).toBe("xhigh");
    d1.close();
  });
});
