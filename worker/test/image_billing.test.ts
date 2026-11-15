import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { MAX_IMAGES_PER_REQUEST } from "../src/gateway/proxy";
import {
  CollectingExecutionContext,
  createRealD1,
  makeEnv,
  makeKv,
  postJson,
  seedDevice,
  seedGroup,
  seedGroupMembers,
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

function imageAnswer(pictures: number, key: "url" | "b64_json" = "url") {
  const data = Array.from({ length: pictures }, (_, i) =>
    key === "url" ? { url: `https://cdn.example/${i}.png` } : { b64_json: "iVBORw0KGgo=" }
  );
  return new Response(
    JSON.stringify({ created: 1, data, model: "upstream-image-model" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function chunkedAnswer(body: string, chunks = 4) {
  const bytes = new TextEncoder().encode(body);
  const size = Math.max(1, Math.ceil(bytes.length / chunks));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
}

function recordUpstreams(answer: () => Response) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: any) => {
    calls.push(String(input));
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

function seedImageModel(d1: ReturnType<typeof createRealD1>, over: Record<string, unknown> = {}) {
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

async function callImages(env: Env, body: unknown) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, "/images/generations", body, exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text, exec };
}

function usageRows(d1: ReturnType<typeof createRealD1>) {
  return d1.rows<{ model: string; cost_usd: number; image_count: number; input_tokens: number; output_tokens: number }>(
    "SELECT model, cost_usd, image_count, input_tokens, output_tokens FROM usage ORDER BY id ASC"
  );
}

describe("a per-call model is billed once for the request", () => {
  it("charges price_per_call once no matter how many pictures came back", async () => {
    const d1 = createRealD1();
    seedImageModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => imageAnswer(3));

    const { res, text } = await callImages(env, { model: "gw-image", prompt: "a cat", n: 3 });

    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://img.example/v1/images/generations"]);
    expect(JSON.parse(text).model).toBe("gw-image");

    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("gw-image");
    expect(rows[0].cost_usd).toBeCloseTo(0.5, 10);
    expect(rows[0].image_count).toBe(0);
    expect(rows[0].input_tokens).toBe(0);
    expect(rows[0].output_tokens).toBe(0);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(9.5, 10);
    d1.close();
  });

  it("charges nothing when the upstream answered with an error", async () => {
    const d1 = createRealD1();
    seedImageModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    recordUpstreams(() => new Response(JSON.stringify({ error: { message: "bad prompt" } }), { status: 400 }));

    const { res } = await callImages(env, { model: "gw-image", prompt: "a cat", n: 2 });

    expect(res.status).toBe(400);
    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_usd).toBe(0);
    expect(rows[0].image_count).toBe(0);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(10, 10);
    d1.close();
  });

  it("holds exactly one price, so n cannot make an affordable request unaffordable", async () => {
    const d1 = createRealD1();
    seedImageModel(d1, { price_per_call: 2 });
    await seedDevice(d1, { balance_usd: 5 });
    const env = makeEnv(d1);
    recordUpstreams(() => imageAnswer(3));

    const { res } = await callImages(env, { model: "gw-image", prompt: "a cat", n: 3 });

    expect(res.status).toBe(200);
    expect(usageRows(d1)[0].cost_usd).toBeCloseTo(2, 10);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(3, 10);
    d1.close();
  });

  it("still refuses a request the balance cannot cover", async () => {
    const d1 = createRealD1();
    seedImageModel(d1, { price_per_call: 2 });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => imageAnswer(1));

    const { res, text } = await callImages(env, { model: "gw-image", prompt: "a cat", n: 1 });

    expect(res.status).toBe(429);
    expect(JSON.parse(text).error).toBe("insufficient_balance");
    expect(calls).toEqual([]);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(1, 10);
    d1.close();
  });
});

describe("what the image path refuses before spending anything", () => {
  it("refuses stream: true", async () => {
    const d1 = createRealD1();
    seedImageModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => imageAnswer(1));

    const { res, text } = await callImages(env, { model: "gw-image", prompt: "a cat", stream: true });

    expect(res.status).toBe(400);
    expect(JSON.parse(text).error).toBe("images_do_not_stream");
    expect(calls).toEqual([]);
    d1.close();
  });

  it("refuses an n above the cap", async () => {
    const d1 = createRealD1();
    seedImageModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => imageAnswer(1));

    const { res, text } = await callImages(env, { model: "gw-image", prompt: "a cat", n: MAX_IMAGES_PER_REQUEST + 1 });

    expect(res.status).toBe(400);
    const body = JSON.parse(text);
    expect(body.error).toBe("too_many_images");
    expect(body.max_images).toBe(MAX_IMAGES_PER_REQUEST);
    expect(calls).toEqual([]);
    d1.close();
  });

  it("refuses a per-call model on the token path, where its zero token prices would mean free", async () => {
    const d1 = createRealD1();
    seedImageModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => new Response("{}", { status: 200 }));

    const exec = new CollectingExecutionContext();
    const res = await postJson(env, "/chat/completions", { model: "gw-image", messages: [{ role: "user", content: "hi" }] }, exec);
    const text = await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(400);
    expect(JSON.parse(text).error).toBe("per_call_text_only");
    expect(calls).toEqual([]);
    d1.close();
  });

  it("refuses a per-call model whose price is still zero", async () => {
    const d1 = createRealD1();
    seedImageModel(d1, { price_per_call: 0, pricing_mode: "priced" });
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => imageAnswer(1));

    const { res, text } = await callImages(env, { model: "gw-image", prompt: "a cat", n: 1 });

    expect(res.status).toBe(400);
    expect(JSON.parse(text).error).toBe("model_pricing_missing");
    expect(calls).toEqual([]);
    d1.close();
  });

  it("refuses a token-billed model on the image path instead of billing it as free", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
    seedModel(d1, { id: "model_a", provider_id: "prov_a", model_name: "gw-text", input_price_per_m: 3, output_price_per_m: 15 });
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => imageAnswer(1));

    const { res, text } = await callImages(env, { model: "gw-text", prompt: "a cat", n: 1 });

    expect(res.status).toBe(400);
    expect(JSON.parse(text).error).toBe("model_not_billed_per_call");
    expect(calls).toEqual([]);
    d1.close();
  });
});

describe("the answer is relayed, not decoded", () => {
  it("relays a body whose head names no model byte for byte", async () => {
    const d1 = createRealD1();
    seedImageModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const payload = "A".repeat(1024 * 1024);
    const body = `{"created":1,"data":[{"b64_json":"${payload}"}]}`;
    const calls = recordUpstreams(() => chunkedAnswer(body, 8));

    const { res, text } = await callImages(env, { model: "gw-image", prompt: "a cat", n: 1 });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(text.length).toBe(body.length);
    expect(text).toBe(body);
    expect(usageRows(d1)[0].cost_usd).toBeCloseTo(0.5, 10);
    d1.close();
  });

  it("relays an answer that arrives as one huge chunk without decoding it", async () => {
    const d1 = createRealD1();
    seedImageModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const payload = "A".repeat(1024 * 1024);
    const body = `{"created":1,"data":[{"b64_json":"${payload}"}]}`;
    const bytes = new TextEncoder().encode(body);
    recordUpstreams(
      () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }))
    );

    const { res, text } = await callImages(env, { model: "gw-image", prompt: "a cat", n: 1 });

    expect(res.status).toBe(200);
    expect(text.length).toBe(body.length);
    expect(text).toBe(body);
    d1.close();
  });

  it("masks a model name that sits near the end of the probe window", async () => {
    const d1 = createRealD1();
    seedImageModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const padding = "A".repeat(7000);
    const body = `{"created":1,"data":[{"b64_json":"${padding}"}],"model":"upstream-image-model"}`;
    recordUpstreams(() => chunkedAnswer(body, 16));

    const { res, text } = await callImages(env, { model: "gw-image", prompt: "a cat", n: 1 });

    expect(res.status).toBe(200);
    expect(JSON.parse(text).model).toBe("gw-image");
    expect(text).not.toContain("upstream-image-model");
    d1.close();
  });

  it("masks the upstream's model when the head names one", async () => {
    const d1 = createRealD1();
    seedImageModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    recordUpstreams(() => chunkedAnswer(JSON.stringify({ created: 1, data: [{ url: "https://cdn.example/0.png" }], model: "upstream-image-model" })));

    const { res, text } = await callImages(env, { model: "gw-image", prompt: "a cat", n: 1 });

    expect(res.status).toBe(200);
    expect(JSON.parse(text).model).toBe("gw-image");
    expect(text).not.toContain("upstream-image-model");
    d1.close();
  });

  it("relays a model name that sits past the probe head, which is the price of not decoding", async () => {
    const d1 = createRealD1();
    seedImageModel(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const payload = "A".repeat(64 * 1024);
    const body = `{"created":1,"data":[{"b64_json":"${payload}"}],"model":"upstream-image-model"}`;
    recordUpstreams(() => chunkedAnswer(body, 4));

    const { res, text } = await callImages(env, { model: "gw-image", prompt: "a cat", n: 1 });

    expect(res.status).toBe(200);
    expect(text).toBe(body);
    d1.close();
  });
});

describe("an upstream that breaks off mid-answer", () => {
  it("returns a 502, charges nothing and gives the hold back", async () => {
    const d1 = createRealD1();
    seedImageModel(d1, { price_per_call: 2 });
    await seedDevice(d1, { balance_usd: 5 });
    const env = makeEnv(d1);
    globalThis.fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("socket hang up"));
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;

    const { res, text } = await callImages(env, { model: "gw-image", prompt: "a cat", n: 1 });

    expect(res.status).toBe(502);
    expect(JSON.parse(text).error).toBe("upstream_read_failed");
    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_usd).toBe(0);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(5, 10);
    expect(wallet(d1)!.reserved_usd).toBeCloseTo(0, 10);
    d1.close();
  });
});

describe("pictures never enter the response cache", () => {
  it("dials the upstream twice even when the row has caching switched on", async () => {
    const d1 = createRealD1();
    seedImageModel(d1, { cache_enabled: 1 });
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1, makeKv());
    const calls = recordUpstreams(() => imageAnswer(1));

    const first = await callImages(env, { model: "gw-image", prompt: "a cat", n: 1 });
    const second = await callImages(env, { model: "gw-image", prompt: "a cat", n: 1 });

    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(calls).toHaveLength(2);
    const rows = usageRows(d1);
    expect(rows.map((r) => r.cost_usd)).toEqual([0.5, 0.5]);
    d1.close();
  });
});

describe("a per-call group bills at the group's price", () => {
  it("charges the group's price_per_call, not the member's", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
    seedModel(d1, {
      id: "model_a",
      provider_id: "prov_a",
      model_name: "gw-img-member",
      input_price_per_m: 0,
      output_price_per_m: 0,
      billing_unit: "call",
      price_per_call: 0.1,
    });
    seedGroup(d1, {
      id: "grp_img",
      name: "gw-img-group",
      input_price_per_m: 0,
      output_price_per_m: 0,
      billing_unit: "call",
      price_per_call: 1.5,
    });
    seedGroupMembers(d1, "grp_img", ["model_a"]);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    recordUpstreams(() => imageAnswer(1));

    const { res, text } = await callImages(env, { model: "gw-img-group", prompt: "a cat", n: 1 });

    expect(res.status).toBe(200);
    expect(JSON.parse(text).model).toBe("gw-img-group");
    const rows = usageRows(d1);
    expect(rows[0].model).toBe("gw-img-group");
    expect(rows[0].cost_usd).toBeCloseTo(1.5, 10);
    d1.close();
  });
});
