import { durableBillingFixture } from "./helpers/durableBillingFixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import { app } from "../src/index";
import { sha256Hex } from "../src/utils/crypto";
import { CSP, withSecurityHeaders } from "../src/utils/security-headers";
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

function makeEnv(models: ModelWithProvider[], hash: string) {
  return durableBillingFixture(models, { token: TOKEN, hash });
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

function okUpstream(model: string) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function postChat(env: Env, exec: CollectingExecutionContext) {
  return gatewayApp.request(
    "http://gw.test/chat/completions",
    {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gw-primary", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
    },
    env,
    exec as never,
  );
}

describe("model_rewrite reaches the upstream provider", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("sends the configured model_rewrite name upstream while still answering as gw-primary", async () => {
    const row = modelRow({ config_json: JSON.stringify({ model_rewrite: "vendor/real-model-v2" }) });
    const { env, usages } = await makeEnv([row], await sha256Hex(TOKEN));

    const sent: Record<string, any>[] = [];
    globalThis.fetch = vi.fn(async (_input: any, init: any) => {
      sent.push(JSON.parse(String(init.body)));
      return okUpstream("vendor/real-model-v2");
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, exec);
    expect(res.status).toBe(200);
    await Promise.all(exec.pending);

    expect(sent).toHaveLength(1);
    expect(sent[0].model).toBe("vendor/real-model-v2");
    expect(sent[0].model).not.toBe("gw-primary");

    expect(JSON.parse(await res.text()).model).toBe("gw-primary");
    expect(usages()).toHaveLength(1);
    expect(usages()[0].model).toBe("gw-primary");
  });

  it("keeps sending row.model_name when no rewrite is configured", async () => {
    const row = modelRow();
    const { env } = await makeEnv([row], await sha256Hex(TOKEN));

    const sent: Record<string, any>[] = [];
    globalThis.fetch = vi.fn(async (_input: any, init: any) => {
      sent.push(JSON.parse(String(init.body)));
      return okUpstream("gw-primary");
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postChat(env, exec);
    expect(res.status).toBe(200);
    await Promise.all(exec.pending);

    expect(sent).toHaveLength(1);
    expect(sent[0].model).toBe("gw-primary");
  });
});

describe("security headers", () => {
  it("sets the hardening headers on a JSON response", () => {
    const res = withSecurityHeaders(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("adds CSP on an HTML response and names no external origin", () => {
    const res = withSecurityHeaders(new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toBe(CSP);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp.includes("http://")).toBe(false);
    expect(csp.includes("https://")).toBe(false);
  });

  it("does not allow inline scripts", () => {
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toContain("script-src 'self' 'unsafe-inline'");
    const scriptDirective = CSP.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"))!;
    expect(scriptDirective).not.toContain("unsafe-inline");
    expect(scriptDirective).not.toContain("unsafe-eval");
  });

  it("preserves status and existing headers when it rebuilds", async () => {
    const original = new Response("payload", { status: 201, statusText: "Created", headers: { "Content-Type": "application/json", "X-Custom": "keep" } });
    const res = withSecurityHeaders(original);
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Custom")).toBe("keep");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await res.text()).toBe("payload");
  });

  it("does not throw on a response whose headers cannot be mutated", () => {
    const immutable = new Response("x", { status: 200, headers: { "Content-Type": "text/html" } });
    Object.freeze(immutable.headers);
    const res = withSecurityHeaders(immutable);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe(CSP);
  });

  it("wraps the SPA HTML the app serves to a browser", async () => {
    const { env } = await durableBillingFixture([], { token: TOKEN });
    const mockEnv = {
      ...env,
      ASSETS: {
        fetch: async () =>
          new Response("<!DOCTYPE html><html><body>React App</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      },
    } as unknown as Env;

    const res = await app.fetch(
      new Request("https://gateway.example.com/models", { method: "GET", headers: { Accept: "text/html" } }),
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("React App");
    expect(res.headers.get("Content-Security-Policy")).toBe(CSP);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});