import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { identityRedactionTransform, redactUpstreamIdentity } from "../src/gateway/caller_identity";
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

function rejectingUpstream(
  message = 'provider "Provider A" model "vendor/a-real" does not support reasoning effort "xhigh"',
  status = 400
) {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recordUpstreams(answer: () => Response) {
  const bodies: any[] = [];
  globalThis.fetch = vi.fn(async (_input: any, init: any) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return bodies;
}

async function call(env: Env, path: string, body: unknown) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, path, body, exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

describe("redactUpstreamIdentity replaces identity by value", () => {
  const terms = { providerName: "magpie-anthropic", providerId: "prov_4b57a2fa", upstreamModel: "ohmyg/glm-5.3-flash", publicModel: "gw-primary" };

  it("replaces the provider name and the upstream model id, keeping the rest of the sentence", () => {
    const input = 'provider "magpie-anthropic" model "ohmyg/glm-5.3-flash" does not support reasoning effort "xhigh"';
    const out = redactUpstreamIdentity(input, terms);
    expect(out).not.toContain("magpie-anthropic");
    expect(out).not.toContain("ohmyg/glm-5.3-flash");
    expect(out).toContain("upstream");
    expect(out).toContain("gw-primary");
    expect(out).toContain("does not support reasoning effort");
    expect(out).toContain('"xhigh"');
  });

  it("replaces the provider row id as well", () => {
    const out = redactUpstreamIdentity("provider prov_4b57a2fa rejected the request", terms);
    expect(out).not.toContain("prov_4b57a2fa");
    expect(out).toContain("upstream");
  });

  it("keeps a needle that is only part of a longer word, so a short provider name cannot shred the body", () => {
    const out = redactUpstreamIdentity("example: amp rejected the model", {
      providerName: "amp",
      publicModel: "gw-primary",
    });
    expect(out).toBe("example: upstream rejected the model");
  });

  it("matches case-insensitively, the way a provider echoes its own name back", () => {
    const out = redactUpstreamIdentity("PROVIDER A said no", { providerName: "Provider A", publicModel: "gw" });
    expect(out.toLowerCase()).not.toContain("provider a");
  });

  it("treats regex metacharacters in an id literally", () => {
    const out = redactUpstreamIdentity('model "a.b*c" unknown', { upstreamModel: "a.b*c", publicModel: "gw" });
    expect(out).toBe('model "gw" unknown');
  });

  it("does nothing when the id it would hide is the id the caller already sees", () => {
    const text = 'model "gw-primary" rejected';
    expect(redactUpstreamIdentity(text, { upstreamModel: "gw-primary", publicModel: "gw-primary" })).toBe(text);
  });

  it("ignores a needle too short to be an identity", () => {
    expect(redactUpstreamIdentity("a b c", { providerName: "a", publicModel: "gw" })).toBe("a b c");
  });

  it("does not let a dollar sign in the replacement be read as a pattern reference", () => {
    const out = redactUpstreamIdentity('model "vendor/real"', { upstreamModel: "vendor/real", publicModel: "$&-x" });
    expect(out).toBe('model "$&-x"');
  });
});

describe("identityRedactionTransform", () => {
  async function streamThrough(terms: Parameters<typeof redactUpstreamIdentity>[1], chunks: string[]) {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return await new Response(body.pipeThrough(identityRedactionTransform(terms))).text();
  }

  it("redacts a name split across two chunks", async () => {
    const terms = { providerName: "Provider A", upstreamModel: "vendor/a-real", publicModel: "gw-primary" };
    const out = await streamThrough(terms, ['provider "Provi', 'der A" model "vendor/a-', 'real" rejected']);
    expect(out).not.toContain("Provider A");
    expect(out).not.toContain("vendor/a-real");
    expect(out).toContain("gw-primary");
    expect(out).toContain("rejected");
  });

  it("redacts a name at the very start of the stream, where there is no left context yet", async () => {
    const terms = { providerName: "Provider A", publicModel: "gw-primary" };
    const out = await streamThrough(terms, ['Provider A', ' rejected']);
    expect(out).toBe("upstream rejected");
  });

  it("redacts a name fed one character per chunk", async () => {
    const terms = { providerName: "Provider A", upstreamModel: "vendor/a-real", publicModel: "gw-primary" };
    const chunks = 'provider "Provider A" model "vendor/a-real" rejected'.split("");
    const out = await streamThrough(terms, chunks);
    expect(out).toBe('provider "upstream" model "gw-primary" rejected');
  });

  it("redacts every occurrence, including one that straddles the boundary and one that does not", async () => {
    const terms = { providerName: "Provider A", publicModel: "gw-primary" };
    const out = await streamThrough(terms, ["Provider A said no; then Prov", "ider A said no again"]);
    expect(out).toBe("upstream said no; then upstream said no again");
  });

  it("does not split a needle that starts right at the emit cut", async () => {
    const terms = { upstreamModel: "vendor/a-real", publicModel: "gw-primary" };
    const text = "z".repeat(40) + 'provider "vendor/a-real" rejected';
    const out = await streamThrough(terms, text.match(/[\s\S]{1,3}/g) || []);
    expect(out).toBe("z".repeat(40) + 'provider "gw-primary" rejected');
  });

  it("keeps one character of left context so a name glued to a word is not redacted", async () => {
    const terms = { providerName: "amp", publicModel: "gw-primary" };
    const out = await streamThrough(terms, ["xam", "p tail"]);
    expect(out).toBe("xamp tail");
  });

  it("keeps multibyte text intact when a chunk ends inside a character", async () => {
    const terms = { providerName: "Provider A", publicModel: "gw-primary" };
    const encoder = new TextEncoder();
    const bytes = encoder.encode("上游 Provider A 拒绝了请求");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1, 12));
        controller.enqueue(bytes.slice(12));
        controller.close();
      },
    });
    const out = await new Response(body.pipeThrough(identityRedactionTransform(terms))).text();
    expect(out).toBe("上游 upstream 拒绝了请求");
  });

  it("passes a body it cannot recognise through unchanged", async () => {
    const out = await streamThrough({ providerName: "Provider A", publicModel: "gw-primary" }, ["upstream down", "stream"]);
    expect(out).toBe("upstream downstream");
  });
});

describe("a rejected chat request", () => {
  function seed(d1: ReturnType<typeof createRealD1>) {
    seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a", config_json: JSON.stringify({ model_rewrite: "vendor/a-real" }) });
  }

  it("forwards the reason but not the provider or the upstream model id", async () => {
    const d1 = createRealD1();
    seed(d1);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies = recordUpstreams(() => rejectingUpstream());

    const { res, text } = await call(env, "/chat/completions", chatBody());

    expect(bodies[0].model).toBe("vendor/a-real");
    expect(res.status).toBe(400);
    expect(text).not.toContain("Provider A");
    expect(text).not.toContain("vendor/a-real");
    expect(text).not.toContain("prov_a");
    expect(text).toContain('provider \\"upstream\\"');
    expect(text).toContain("gw-primary");
    expect(text).toContain("does not support reasoning effort");
    d1.close();
  });

  it("bills nothing for the rejection", async () => {
    const d1 = createRealD1();
    seed(d1);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    recordUpstreams(() => rejectingUpstream());

    const { res } = await call(env, "/chat/completions", chatBody());

    expect(res.status).toBe(400);
    expect(usageRows(d1)).toHaveLength(1);
    expect(usageRows(d1)[0].cost_usd).toBe(0);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(1, 10);
    d1.close();
  });

  it("redacts a rejected streaming request too", async () => {
    const d1 = createRealD1();
    seed(d1);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    recordUpstreams(() => rejectingUpstream());

    const { res, text } = await call(env, "/chat/completions", chatBody("gw-primary", { stream: true }));

    expect(res.status).toBe(400);
    expect(text).not.toContain("Provider A");
    expect(text).not.toContain("vendor/a-real");
    expect(text).toContain("gw-primary");
    d1.close();
  });

  it("leaves a successful body alone, including prose that mentions the provider", async () => {
    const d1 = createRealD1();
    seed(d1);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    recordUpstreams(
      () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            model: "vendor/a-real",
            choices: [{ index: 0, message: { role: "assistant", content: "Provider A is a fine name." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );

    const { res, text } = await call(env, "/chat/completions", chatBody());

    expect(res.status).toBe(200);
    expect(JSON.parse(text).model).toBe("gw-primary");
    expect(text).not.toContain("vendor/a-real");
    expect(JSON.parse(text).choices[0].message.content).toBe("Provider A is a fine name.");
    d1.close();
  });
});

describe("a rejected Responses request", () => {
  it("is redacted on the same terms", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a", config_json: JSON.stringify({ model_rewrite: "vendor/a-real" }) });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    recordUpstreams(() => rejectingUpstream());

    const { res, text } = await call(env, "/responses", { model: "gw-primary", input: "hi" });

    expect(res.status).toBe(400);
    expect(text).not.toContain("Provider A");
    expect(text).not.toContain("vendor/a-real");
    expect(text).toContain("gw-primary");
    d1.close();
  });

  it("still answers a successful Responses request", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
    seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    recordUpstreams(() => openAiAnswer());

    const { res, text } = await call(env, "/responses", { model: "gw-primary", input: "hi" });

    expect(res.status).toBe(200);
    expect(JSON.parse(text).model).toBe("gw-primary");
    d1.close();
  });
});

describe("a rejected image request", () => {
  function seedImage(d1: ReturnType<typeof createRealD1>) {
    seedProvider(d1, { id: "prov_img", name: "Image Provider", type: "openai", endpoint: "https://img.example/v1", api_key: "sk-img" });
    seedModel(d1, {
      id: "model_img",
      provider_id: "prov_img",
      model_name: "gw-image",
      input_price_per_m: 0,
      output_price_per_m: 0,
      billing_unit: "call",
      price_per_call: 0.5,
      config_json: JSON.stringify({ model_rewrite: "vendor/img-real" }),
    });
  }

  it("redacts an error body that names the provider and the upstream model", async () => {
    const d1 = createRealD1();
    seedImage(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    recordUpstreams(() => rejectingUpstream('provider "Image Provider" model "vendor/img-real" refused the prompt'));

    const { res, text } = await call(env, "/images/generations", { model: "gw-image", prompt: "a cat", n: 2 });

    expect(res.status).toBe(400);
    expect(text).not.toContain("Image Provider");
    expect(text).not.toContain("vendor/img-real");
    expect(text).toContain("gw-image");
    expect(usageRows(d1)[0].cost_usd).toBe(0);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(10, 10);
    d1.close();
  });

  it("redacts an error body that also carries a model field", async () => {
    const d1 = createRealD1();
    seedImage(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    recordUpstreams(
      () =>
        new Response(JSON.stringify({ error: { message: "provider Image Provider refused" }, model: "vendor/img-real" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
    );

    const { res, text } = await call(env, "/images/generations", { model: "gw-image", prompt: "a cat", n: 2 });

    expect(res.status).toBe(400);
    expect(text).not.toContain("Image Provider");
    expect(text).not.toContain("vendor/img-real");
    d1.close();
  });

  it("leaves a successful picture answer byte-identical", async () => {
    const d1 = createRealD1();
    seedImage(d1);
    await seedDevice(d1, { balance_usd: 10 });
    const env = makeEnv(d1);
    const answer = JSON.stringify({ created: 1, data: [{ url: "https://cdn.example/0.png" }], model: "vendor/img-real" });
    recordUpstreams(() => new Response(answer, { status: 200, headers: { "Content-Type": "application/json" } }));

    const { res, text } = await call(env, "/images/generations", { model: "gw-image", prompt: "a cat", n: 1 });

    expect(res.status).toBe(200);
    expect(text).toContain('"data"');
    expect(text).not.toContain("vendor/img-real");
    d1.close();
  });
});
