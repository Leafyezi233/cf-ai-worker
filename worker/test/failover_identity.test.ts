import { durableBillingFixture } from "./helpers/durableBillingFixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import { sha256Hex } from "../src/utils/crypto";
import type { DeviceRow, Env, ModelWithProvider } from "../src/types";

const TOKEN = "ccs_test_token";

function modelRow(over: Partial<ModelWithProvider> = {}): ModelWithProvider {
  return {
    id: "model_a",
    model_name: "gw-primary",
    display_name: "gw-primary",
    alias: null,
    provider_id: "prov_a",
    input_price_per_m: 3,
    output_price_per_m: 15,
    cache_enabled: 0,
    cache_ttl: 0,
    fallback_model_id: null,
    enabled: 1,
    model_public: 1,
    pricing_mode: "priced",
    peak_pricing_enabled: 0,
    config_json: null,
    created_at: 1,
    updated_at: 1,
    provider_name: "Provider A",
    provider_type: "openai",
    provider_api_key: "sk-a",
    provider_secret_name: null,
    provider_endpoint: "https://a.example/v1",
    ...over,
  } as ModelWithProvider;
}

const DEVICE: DeviceRow = {
  id: "dev_1",
  name: "Laptop",
  token_hash: "pending",
  enabled: 1,
  rate_limit_rpm: 0,
  cost_limit_monthly: null,
  last_used_at: null,
  created_at: 1,
  revoked_at: null,
  model_scope: "all",
};

interface UsageInsert {
  model: unknown;
  provider_name: unknown;
  provider_id: unknown;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  price_multiplier: number;
}

function makeEnv(models: ModelWithProvider[], options: { hash?: string; cache?: boolean } = {}) {
  return durableBillingFixture(models, { token: TOKEN, ...options });
}

class CollectingExecutionContext {
  readonly pending: Promise<unknown>[] = [];
  waitUntil(p: Promise<unknown>) {
    this.pending.push(p.catch(() => undefined));
  }
  passThroughOnException() {}
  readonly props: unknown = undefined;
  readonly tracing: unknown = undefined;
  readonly access: unknown = undefined;
}

function chatBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ model: "gw-primary", messages: [{ role: "user", content: "hi" }], max_tokens: 8, ...extra });
}

async function postChat(env: Env, body: string, exec: CollectingExecutionContext) {
  return gatewayApp.request(
    "http://gw.test/chat/completions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body,
    },
    env,
    exec as never
  );
}

function openAiBody(model: string, idSuffix = "1") {
  return JSON.stringify({
    id: `chatcmpl-${idSuffix}`,
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
  });
}

function anthropicBody(model: string) {
  return JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "pong" }],
    usage: { input_tokens: 1000, output_tokens: 1000 },
  });
}

describe("caller-facing identity across failover", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("reports the primary model and bills the primary price even when a failover answered", async () => {
    const primary = modelRow({ id: "model_a", model_name: "gw-primary", provider_id: "prov_a", provider_name: "Provider A", input_price_per_m: 3, output_price_per_m: 15 });
    const backup = modelRow({ id: "model_b", model_name: "gw-primary", provider_id: "prov_b", provider_name: "Provider B", input_price_per_m: 0.1, output_price_per_m: 0.2, provider_api_key: "sk-b", provider_endpoint: "https://b.example/v1" });
    const { env, usages } = await makeEnv([primary, backup], { hash: await sha256Hex(TOKEN) });

    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.startsWith("https://a.example")) return new Response("upstream down", { status: 503 });
      return new Response(openAiBody("upstream-internal-x"), {
        status: 200,
        headers: { "Content-Type": "application/json", server: "cloudflare", "x-request-id": "req_secret" },
      });
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    expect(res.status).toBe(200);
    await Promise.all(exec.pending);

    const text = await res.text();
    expect(text).not.toContain("upstream-internal-x");
    const json = JSON.parse(text);
    expect(json.model).toBe("gw-primary");
    expect(json.choices[0].message.content).toBe("pong");

    expect(res.headers.get("server")).toBeNull();
    expect(res.headers.get("x-request-id")).toBeNull();

    expect(seenUrls.some((u) => u.startsWith("https://b.example"))).toBe(true);

    expect(usages()).toHaveLength(1);
    expect(usages()[0].model).toBe("gw-primary");
    expect(usages()[0].provider_name).toBe("Provider B");
    expect(usages()[0].cost_usd).toBeCloseTo(0.018, 9);
  });

  it("keeps the primary identity when the explicit fallback_model_id answered", async () => {
    const primary = modelRow({ id: "model_a", model_name: "gw-primary", fallback_model_id: "model_z" });
    const fallback = modelRow({
      id: "model_z",
      model_name: "owner-chosen-backup",
      provider_id: "prov_z",
      provider_name: "Provider Z",
      input_price_per_m: 0.1,
      output_price_per_m: 0.2,
      provider_api_key: "sk-z",
      provider_endpoint: "https://z.example/v1",
    });
    const { env, usages } = await makeEnv([primary, fallback], { hash: await sha256Hex(TOKEN) });

    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.startsWith("https://a.example")) return new Response("down", { status: 503 });
      return new Response(openAiBody("owner-chosen-backup"), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    expect(res.status).toBe(200);
    const text = await res.text();
    await Promise.all(exec.pending);

    expect(seenUrls.some((u) => u.startsWith("https://z.example"))).toBe(true);
    expect(text).not.toContain("owner-chosen-backup");
    expect(JSON.parse(text).model).toBe("gw-primary");

    expect(usages()).toHaveLength(1);
    expect(usages()[0].model).toBe("gw-primary");
    expect(usages()[0].cost_usd).toBeCloseTo(0.018, 9);
  });

  it("masks the model on a streaming failover too", async () => {
    const primary = modelRow({ id: "model_a", model_name: "gw-primary" });
    const backup = modelRow({ id: "model_b", model_name: "gw-primary", provider_id: "prov_b", provider_name: "Provider B", provider_api_key: "sk-b", provider_endpoint: "https://b.example/v1" });
    const { env } = await makeEnv([primary, backup], { hash: await sha256Hex(TOKEN) });

    globalThis.fetch = vi.fn(async (input: any) => {
      if (String(input).startsWith("https://a.example")) return new Response("down", { status: 503 });
      const sse = [
        `data: ${JSON.stringify({ id: "c1", model: "upstream-internal-x", choices: [{ delta: { content: "po" } }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", model: "upstream-internal-x", choices: [{ delta: { content: "ng" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody({ stream: true }), exec);
    expect(res.status).toBe(200);
    const sse = await res.text();
    await Promise.all(exec.pending);

    expect(sse).not.toContain("upstream-internal-x");
    expect(JSON.parse(sse.split("\n")[0].slice(6)).model).toBe("gw-primary");
  });

  it("masks the model in an Anthropic messages failover", async () => {
    const primary = modelRow({ id: "model_a", model_name: "gw-primary", provider_type: "anthropic", provider_endpoint: "https://a.example/v1", provider_api_key: "sk-anthropic" });
    const backup = modelRow({ id: "model_b", model_name: "gw-primary", provider_id: "prov_b", provider_name: "Provider B", provider_type: "anthropic", provider_api_key: "sk-b2", provider_endpoint: "https://b.example/v1" });
    const { env, usages } = await makeEnv([primary, backup], { hash: await sha256Hex(TOKEN) });

    globalThis.fetch = vi.fn(async (input: any) => {
      if (String(input).startsWith("https://a.example")) return new Response("down", { status: 503 });
      return new Response(anthropicBody("upstream-internal-x"), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await gatewayApp.request(
      "http://gw.test/messages",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gw-primary", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
      },
      env,
      exec as never
    );
    expect(res.status).toBe(200);
    await Promise.all(exec.pending);
    const json = JSON.parse(await res.text());
    expect(json.model).toBe("gw-primary");
    expect(json.content[0].text).toBe("pong");

    expect(usages()).toHaveLength(1);
    expect(usages()[0].model).toBe("gw-primary");
  });

  it("still charges the primary price when the failover body reports a different model", async () => {
    const primary = modelRow({ id: "model_a", model_name: "gw-primary" });
    const backup = modelRow({ id: "model_b", model_name: "gw-primary", provider_id: "prov_b", provider_name: "Provider B", provider_api_key: "sk-b", provider_endpoint: "https://b.example/v1" });
    const { env, usages } = await makeEnv([primary, backup], { hash: await sha256Hex(TOKEN) });

    globalThis.fetch = vi.fn(async (input: any) => {
      if (String(input).startsWith("https://a.example")) return new Response("down", { status: 503 });
      return new Response(openAiBody("upstream-internal-x"), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    await res.text();
    await Promise.all(exec.pending);

    expect(usages()[0].cost_usd).toBeCloseTo(0.018, 9);
    expect(usages()[0].provider_name).toBe("Provider B");
  });

  it("caches the masked body, so a later caller never receives the fallback name", async () => {
    const primary = modelRow({ id: "model_a", model_name: "gw-primary", cache_enabled: 1, cache_ttl: 300 });
    const backup = modelRow({ id: "model_b", model_name: "gw-primary", provider_id: "prov_b", provider_name: "Provider B", provider_api_key: "sk-b", provider_endpoint: "https://b.example/v1", cache_enabled: 1, cache_ttl: 300 });
    const { env, kvWrites } = await makeEnv([primary, backup], { hash: await sha256Hex(TOKEN), cache: true });

    globalThis.fetch = vi.fn(async (input: any) => {
      if (String(input).startsWith("https://a.example")) return new Response("down", { status: 503 });
      return new Response(openAiBody("upstream-internal-x"), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    await res.text();
    await Promise.all(exec.pending);

    expect(kvWrites).toHaveLength(1);
    expect(kvWrites[0].value).not.toContain("upstream-internal-x");
    const entry = JSON.parse(kvWrites[0].value) as any;
    expect(entry.model).toBe("gw-primary");
    expect(entry.jsonBody.model).toBe("gw-primary");
    expect(entry.jsonBody.choices[0].message.content).toBe("pong");
  });

  it("writes nothing to the cache when the model has caching disabled", async () => {
    const primary = modelRow({ id: "model_a", model_name: "gw-primary", cache_enabled: 0 });
    const backup = modelRow({ id: "model_b", model_name: "gw-primary", provider_id: "prov_b", provider_name: "Provider B", provider_api_key: "sk-b", provider_endpoint: "https://b.example/v1" });
    const { env, kvWrites } = await makeEnv([primary, backup], { hash: await sha256Hex(TOKEN), cache: true });

    globalThis.fetch = vi.fn(async (input: any) => {
      if (String(input).startsWith("https://a.example")) return new Response("down", { status: 503 });
      return new Response(openAiBody("upstream-internal-x"), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    await res.text();
    await Promise.all(exec.pending);

    expect(kvWrites).toHaveLength(0);
  });

  it("reports the primary name even when the primary answers (no failover)", async () => {
    const primary = modelRow({ id: "model_a", model_name: "gw-primary" });
    const backup = modelRow({ id: "model_b", model_name: "gw-primary", provider_id: "prov_b", provider_name: "Provider B", provider_api_key: "sk-b", provider_endpoint: "https://b.example/v1" });
    const { env, usages } = await makeEnv([primary, backup], { hash: await sha256Hex(TOKEN) });

    globalThis.fetch = vi.fn(async (input: any) => {
      return new Response(openAiBody("gw-primary"), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    expect(res.status).toBe(200);
    const json = JSON.parse(await res.text());
    await Promise.all(exec.pending);

    expect(json.model).toBe("gw-primary");
    expect(usages()).toHaveLength(1);
    expect(usages()[0].model).toBe("gw-primary");
    expect(usages()[0].cost_usd).toBeCloseTo(0.018, 9);
  });

  it("drops the caller effort on a failover target that cannot reason, and keeps it on the primary", async () => {
    const primary = modelRow({
      id: "model_a",
      model_name: "gw-primary",
      config_json: JSON.stringify({ capabilities: ["reasoning"] }),
    });
    const backup = modelRow({
      id: "model_b",
      model_name: "gw-primary",
      provider_id: "prov_b",
      provider_name: "Provider B",
      provider_api_key: "sk-b",
      provider_endpoint: "https://b.example/v1",
    });
    const { env } = await makeEnv([primary, backup], { hash: await sha256Hex(TOKEN) });

    const sent: { url: string; body: any }[] = [];
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      sent.push({ url, body: JSON.parse(String(init.body)) });
      if (url.startsWith("https://a.example")) return new Response("down", { status: 503 });
      return new Response(openAiBody("gw-primary"), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody({ reasoning_effort: "high" }), exec);
    expect(res.status).toBe(200);
    await res.text();
    await Promise.all(exec.pending);

    const primaryCall = sent.find((s) => s.url.startsWith("https://a.example"));
    const backupCall = sent.find((s) => s.url.startsWith("https://b.example"));
    expect(primaryCall?.body.reasoning_effort).toBe("high");
    expect(backupCall).toBeDefined();
    expect("reasoning_effort" in (backupCall as any).body).toBe(false);
    expect("thinking" in (backupCall as any).body).toBe(false);
  });

  it("never caches an answer that was produced without the effort the key describes", async () => {
    const primary = modelRow({
      id: "model_a",
      model_name: "gw-primary",
      cache_enabled: 1,
      cache_ttl: 300,
      config_json: JSON.stringify({ capabilities: ["reasoning"] }),
    });
    const backup = modelRow({
      id: "model_b",
      model_name: "gw-primary",
      provider_id: "prov_b",
      provider_name: "Provider B",
      provider_api_key: "sk-b",
      provider_endpoint: "https://b.example/v1",
      cache_enabled: 1,
      cache_ttl: 300,
      config_json: JSON.stringify({ supports_reasoning: false }),
    });
    const { env, kvWrites } = await makeEnv([primary, backup], { hash: await sha256Hex(TOKEN), cache: true });

    globalThis.fetch = vi.fn(async (input: any) => {
      if (String(input).startsWith("https://a.example")) return new Response("down", { status: 503 });
      return new Response(openAiBody("gw-primary"), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody({ reasoning_effort: "high" }), exec);
    expect(res.status).toBe(200);
    await res.text();
    await Promise.all(exec.pending);

    expect(kvWrites).toHaveLength(0);
  });

  it("does not let a dropped effort leak into the shared body of a later candidate", async () => {
    const primary = modelRow({ id: "model_a", model_name: "gw-primary" });
    const backup1 = modelRow({ id: "model_b", model_name: "gw-primary", provider_id: "prov_b", provider_name: "Provider B", provider_api_key: "sk-b", provider_endpoint: "https://b.example/v1" });
    const backup2 = modelRow({ id: "model_c", model_name: "gw-primary", provider_id: "prov_c", provider_name: "Provider C", provider_api_key: "sk-c", provider_endpoint: "https://c.example/v1" });
    const { env } = await makeEnv([primary, backup1, backup2], { hash: await sha256Hex(TOKEN) });

    const sent: { url: string; body: any }[] = [];
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      sent.push({ url, body: JSON.parse(String(init.body)) });
      if (url.startsWith("https://c.example")) return new Response(openAiBody("gw-primary"), { status: 200 });
      return new Response("down", { status: 503 });
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody({ reasoning: { effort: "high" } }), exec);
    expect(res.status).toBe(200);
    await res.text();
    await Promise.all(exec.pending);

    expect(sent).toHaveLength(3);
    expect(sent[0].body.reasoning).toEqual({ effort: "high" });
    for (const attempt of sent.slice(1)) {
      expect("reasoning" in attempt.body).toBe(false);
    }
  });

  it("hands the caller a generic 502 that never names the failed provider", async () => {
    const primary = modelRow({ id: "model_a", model_name: "gw-primary", provider_name: "Provider A" });
    const { env } = await makeEnv([primary], { hash: await sha256Hex(TOKEN) });

    globalThis.fetch = vi.fn(async () => {
      throw new Error("upstream down");
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, chatBody(), exec);
    const body = await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(502);
    expect(JSON.parse(body).error).toBe("upstream_service_unavailable");
    expect(body).not.toContain("Provider A");
  });
});
