import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import {
  CollectingExecutionContext,
  createRealD1,
  makeEnv,
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
  clearMemoryCacheForTest();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PAD = "x".repeat(300 * 1024);

function chatAnswer() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "gw-primary",
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function anthropicAnswer() {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "gw-ant",
      content: [{ type: "text", text: "pong" }],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function recordUpstreamBodies(answer: () => Response) {
  const bodies: string[] = [];
  const urls: string[] = [];
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    urls.push(String(input));
    bodies.push(typeof init?.body === "string" ? init.body : String(init?.body ?? ""));
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { bodies, urls };
}

async function callRaw(env: Env, path: string, raw: string) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, path, raw, exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

function spacedChatBody(model: string) {
  return `{"model":"${model}", "messages":[{"role":"user", "content":"${PAD}"}], "max_tokens":8}`;
}

describe("raw-body reuse on the upstream send", () => {
  it("replays the client's exact bytes when the chain mutated nothing", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { model_name: "gw-primary" });
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const { bodies, urls } = recordUpstreamBodies(chatAnswer);

    const raw = spacedChatBody("gw-primary");
    const { res } = await callRaw(env, "/chat/completions", raw);

    expect(res.status).toBe(200);
    expect(urls).toEqual(["https://a.example/v1/chat/completions"]);
    expect(bodies[0]).toBe(raw);
    d1.close();
  });

  it("re-serialises when the caller dialled an alias (model stamp differs)", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { model_name: "gw-primary", alias: "gw-alias" });
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const { bodies } = recordUpstreamBodies(chatAnswer);

    const raw = spacedChatBody("gw-alias");
    const { res } = await callRaw(env, "/chat/completions", raw);

    expect(res.status).toBe(200);
    expect(bodies[0]).not.toBe(raw);
    expect(JSON.parse(bodies[0]).model).toBe("gw-primary");
    d1.close();
  });

  it("re-serialises when the row carries model_rewrite", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { model_name: "gw-primary", config_json: '{"model_rewrite":"upstream-name"}' });
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const { bodies } = recordUpstreamBodies(chatAnswer);

    const raw = spacedChatBody("gw-primary");
    const { res } = await callRaw(env, "/chat/completions", raw);

    expect(res.status).toBe(200);
    expect(bodies[0]).not.toBe(raw);
    expect(JSON.parse(bodies[0]).model).toBe("upstream-name");
    d1.close();
  });

  it("re-serialises an anthropic messages request that carries reasoning_effort", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_ant", name: "Anthropic A", type: "anthropic", endpoint: "https://ant.example/v1", api_key: "sk-ant" });
    seedModel(d1, { id: "model_ant", provider_id: "prov_ant", model_name: "gw-ant" });
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const { bodies, urls } = recordUpstreamBodies(anthropicAnswer);

    const raw = `{"model":"gw-ant", "max_tokens":4096, "messages":[{"role":"user", "content":"${PAD}"}], "reasoning_effort":"high"}`;
    const { res } = await callRaw(env, "/messages", raw);

    expect(res.status).toBe(200);
    expect(urls).toEqual(["https://ant.example/v1/messages"]);
    expect(bodies[0]).not.toBe(raw);
    const sent = JSON.parse(bodies[0]);
    expect(sent.thinking).toEqual({ type: "enabled", budget_tokens: expect.any(Number) });
    expect(sent.reasoning_effort).toBeUndefined();
    d1.close();
  });

  it("re-serialises when the billing row injects a system prompt", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { model_name: "gw-primary", config_json: '{"system_prompt":"You are helpful"}' });
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const { bodies } = recordUpstreamBodies(chatAnswer);

    const raw = spacedChatBody("gw-primary");
    const { res } = await callRaw(env, "/chat/completions", raw);

    expect(res.status).toBe(200);
    expect(bodies[0]).not.toBe(raw);
    expect(JSON.parse(bodies[0]).messages[0].role).toBe("system");
    d1.close();
  });

  it("always re-serialises on the responses path (translated to chat/completions)", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { model_name: "gw-primary" });
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const { bodies, urls } = recordUpstreamBodies(chatAnswer);

    const raw = `{"model":"gw-primary", "input":"${PAD}", "stream":false}`;
    const { res } = await callRaw(env, "/responses", raw);

    expect(res.status).toBe(200);
    expect(urls[0]).toContain("/chat/completions");
    expect(bodies[0]).not.toBe(raw);
    expect(Array.isArray(JSON.parse(bodies[0]).messages)).toBe(true);
    d1.close();
  });

  it("keeps the threshold: a small body is re-serialised even when nothing mutated it", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { model_name: "gw-primary" });
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const { bodies } = recordUpstreamBodies(chatAnswer);

    const raw = '{"model":"gw-primary", "messages":[{"role":"user", "content":"hi"}], "max_tokens":8}';
    const { res } = await callRaw(env, "/chat/completions", raw);

    expect(res.status).toBe(200);
    expect(bodies[0]).not.toBe(raw);
    expect(JSON.parse(bodies[0]).messages[0].content).toBe("hi");
    d1.close();
  });
});
