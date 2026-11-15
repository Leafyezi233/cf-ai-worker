import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { MAX_REQUEST_BODY_BYTES } from "../src/gateway/proxy";
import {
  CollectingExecutionContext,
  createRealD1,
  makeEnv,
  postJson,
  seedDevice,
  seedModel,
  seedProvider,
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

function chatAnswer() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-img1",
      object: "chat.completion",
      model: "upstream-image-model",
      choices: [{ index: 0, message: { role: "assistant", content: "here is your picture" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function recordUpstreams(answer: () => Response) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: any) => {
    calls.push(String(input));
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

function seedPerCallModel(d1: ReturnType<typeof createRealD1>, over: Record<string, unknown> = {}) {
  seedProvider(d1, { id: "prov_img", name: "Image Provider", type: "openai", endpoint: "https://img.example/v1", api_key: "sk-img" });
  seedModel(d1, {
    id: "model_img",
    provider_id: "prov_img",
    model_name: "gw-image",
    input_price_per_m: 0,
    output_price_per_m: 0,
    billing_unit: "call",
    price_per_call: 0.5,
    ...over,
  });
}

const IMAGE_PART = { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } };

async function callChat(env: Env, body: unknown) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, "/chat/completions", body, exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

function usageRows(d1: ReturnType<typeof createRealD1>) {
  return d1.rows<{ model: string; cost_usd: number; input_tokens: number; output_tokens: number }>(
    "SELECT model, cost_usd, input_tokens, output_tokens FROM usage ORDER BY id ASC"
  );
}

describe("a per-call model on the chat path", () => {
  it("answers a chat request that carries an image, billed once at price_per_call", async () => {
    const d1 = createRealD1();
    seedPerCallModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(chatAnswer);

    const { res, text } = await callChat(env, {
      model: "gw-image",
      messages: [{ role: "user", content: [{ type: "text", text: "make it blue" }, IMAGE_PART] }],
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(text).model).toBe("gw-image");
    expect(calls).toEqual(["https://img.example/v1/chat/completions"]);

    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_usd).toBeCloseTo(0.5, 10);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(9.5, 10);
    d1.close();
  });

  it("refuses a text-only chat with per_call_text_only", async () => {
    const d1 = createRealD1();
    seedPerCallModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(chatAnswer);

    const { res, text } = await callChat(env, {
      model: "gw-image",
      messages: [{ role: "user", content: "plain text" }],
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(text) as any;
    expect(body.error).toBe("per_call_text_only");
    expect(calls).toEqual([]);
    expect(usageRows(d1)).toHaveLength(0);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(10, 10);
    d1.close();
  });

  it("refuses a string-content message too (no parts, no picture)", async () => {
    const d1 = createRealD1();
    seedPerCallModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    recordUpstreams(chatAnswer);

    const { res, text } = await callChat(env, {
      model: "gw-image",
      messages: [
        { role: "user", content: [{ type: "text", text: "no image here" }] },
      ],
    });

    expect(res.status).toBe(400);
    expect((JSON.parse(text) as any).error).toBe("per_call_text_only");
    d1.close();
  });

  it("does not ride the failover chain: a failed per-call attempt ends the request", async () => {
    const d1 = createRealD1();
    seedPerCallModel(d1);
    seedProvider(d1, { id: "prov_b", name: "Provider B", type: "openai", endpoint: "https://b.example/v1", api_key: "sk-b" });
    seedModel(d1, {
      id: "model_img_b",
      provider_id: "prov_b",
      model_name: "gw-image",
      input_price_per_m: 0,
      output_price_per_m: 0,
      billing_unit: "call",
      price_per_call: 0.4,
    });
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => new Response("upstream boom", { status: 503 }));

    const { res } = await callChat(env, {
      model: "gw-image",
      messages: [{ role: "user", content: [{ type: "text", text: "redo" }, IMAGE_PART] }],
    });

    expect(res.status).toBe(502);
    expect(calls).toEqual(["https://img.example/v1/chat/completions"]);
    expect(usageRows(d1)).toHaveLength(0);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(10, 10);
    d1.close();
  });

  it("leaves a token-billed model with an image alone", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_txt", name: "Text Provider", type: "openai", endpoint: "https://txt.example/v1", api_key: "sk-txt" });
    seedModel(d1, { id: "model_txt", provider_id: "prov_txt", model_name: "gw-vision", input_price_per_m: 3, output_price_per_m: 15 });
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    recordUpstreams(chatAnswer);

    const { res } = await callChat(env, {
      model: "gw-vision",
      messages: [{ role: "user", content: [{ type: "text", text: "describe" }, IMAGE_PART] }],
    });

    expect(res.status).toBe(200);
    d1.close();
  });

  it("keeps the request body ceiling at 10 MB even with reference images", async () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(10 * 1024 * 1024);

    const d1 = createRealD1();
    seedPerCallModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    recordUpstreams(chatAnswer);

    const bigB64 = "A".repeat(9 * 1024 * 1024);
    const { res } = await callChat(env, {
      model: "gw-image",
      messages: [{ role: "user", content: [{ type: "text", text: "redo" }, { type: "image_url", image_url: { url: "data:image/png;base64," + bigB64 } }] }],
    });
    expect(res.status).toBe(200);
    d1.close();
  });

  it("still refuses a body past 10 MB with 413", async () => {
    const d1 = createRealD1();
    seedPerCallModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    recordUpstreams(chatAnswer);

    const bigB64 = "A".repeat(11 * 1024 * 1024);
    const { res, text } = await callChat(env, {
      model: "gw-image",
      messages: [{ role: "user", content: [{ type: "text", text: "redo" }, { type: "image_url", image_url: { url: "data:image/png;base64," + bigB64 } }] }],
    });
    expect(res.status).toBe(413);
    expect((JSON.parse(text) as any).error).toBe("request_too_large");
    d1.close();
  });
});
