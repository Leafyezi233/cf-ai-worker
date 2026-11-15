import { afterEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { resolveReasoningSupport } from "../src/gateway/reasoning";
import { createRealD1 } from "./helpers/realD1";
import type { Env } from "../src/types";


const SECRET = "session-signing-secret";
const realFetch = globalThis.fetch;

function makeEnv(d1: ReturnType<typeof createRealD1>): Env {
  return {
    DB: d1.DB,
    ASSETS: { fetch: async () => new Response("assets") } as any,
    ADMIN_SECRET: "admin-password",
    SESSION_SECRET: SECRET,
  } as unknown as Env;
}

function seedModel(
  d1: ReturnType<typeof createRealD1>,
  opts: { id?: string; providerType?: string; configJson?: string | null; enabled?: number } = {}
) {
  const id = opts.id || "model_1";
  d1.sql(
    "INSERT INTO providers (id, name, type, endpoint, api_key, secret_name, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    "prov_1",
    "Relay",
    opts.providerType || "openai",
    "https://relay.example.com/v1",
    "sk-relay-secret",
    null,
    1,
    null,
    Date.now(),
    Date.now()
  );
  d1.sql(
    "INSERT INTO models (id, provider_id, model_name, display_name, alias, fallback_model_id, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, cache_enabled, cache_ttl, enabled, model_public, pricing_mode, peak_pricing_enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    "prov_1",
    "codebuddy_gpt-5",
    "Relay GPT-5",
    null,
    null,
    1,
    2,
    0,
    0,
    0,
    3600,
    opts.enabled === undefined ? 1 : opts.enabled,
    0,
    "priced",
    0,
    opts.configJson === undefined ? null : opts.configJson,
    Date.now(),
    Date.now()
  );
  return id;
}

async function probe(env: Env, id: string, body: Record<string, unknown> = {}) {
  const token = await signSession(SECRET, 0);
  const res = await adminApp.fetch(
    new Request(`http://localhost/models/${id}/probe-reasoning`, {
      method: "POST",
      headers: {
        cookie: buildSessionCookie(token).split(";")[0],
        "cf-connecting-ip": "203.0.113.9",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env
  );
  return { status: res.status, body: (await res.json()) as any };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("POST /models/:id/probe-reasoning", () => {
  it("refuses explicit multi-wire config before spending a legacy label-based reasoning probe", async () => {
    const d1 = createRealD1(); const env = makeEnv(d1); const id = seedModel(d1);
    d1.sql("UPDATE providers SET config_json=?", JSON.stringify({ protocol_connections: { messages: {} } }));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not call upstream"));
    const result = await probe(env, id);
    expect(result.status).toBe(409); expect(result.body.error).toBe("multi_protocol_test_requires_gateway");
    expect(fetch).not.toHaveBeenCalled(); d1.close();
  });
  it("persists a positive verdict that outranks the name heuristic", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const id = seedModel(d1);

    const calls: Array<{ url: string; init: any }> = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const { status, body } = await probe(env, id);
    expect(status).toBe(200);
    expect(body.reasoning_supported).toBe(true);
    expect(body.config_json).toContain("\"probe\"");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://relay.example.com/v1/chat/completions");
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.reasoning_effort).toBe("low");
    expect(sent.thinking).toBeUndefined();

    const stored = d1.row<{ config_json: string }>("SELECT config_json FROM models WHERE id = ?", id)!;
    const parsed = JSON.parse(stored.config_json);
    expect(parsed.probe.reasoning_supported).toBe(true);
    expect(parsed.probe.provider_type).toBe("openai");
    expect(resolveReasoningSupport({ model_name: "codebuddy_gpt-5", config_json: stored.config_json }).source).toBe(
      "probe"
    );
    d1.close();
  });

  it("records a refusal as known-unsupported instead of throwing the measurement away", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const id = seedModel(d1);

    globalThis.fetch = vi.fn(
      async () => new Response("upstream says no such parameter", { status: 400 })
    ) as unknown as typeof globalThis.fetch;

    const { status, body } = await probe(env, id);
    expect(status).toBe(200);
    expect(body.reasoning_supported).toBe(false);
    expect(body.error).toContain("no such parameter");

    const stored = d1.row<{ config_json: string }>("SELECT config_json FROM models WHERE id = ?", id)!;
    const parsed = JSON.parse(stored.config_json);
    expect(parsed.probe.reasoning_supported).toBe(false);
    const resolved = resolveReasoningSupport({
      model_name: "codebuddy_gpt-5",
      config_json: JSON.stringify({ ...parsed, capabilities: ["reasoning"] }),
    });
    expect(resolved.supported).toBe(false);
    d1.close();
  });

  it("stores nothing when the probe cannot conclude, so a 429 cannot fake a refusal", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const id = seedModel(d1);

    globalThis.fetch = vi.fn(async () => new Response("slow down", { status: 429 })) as unknown as typeof globalThis.fetch;

    const { status, body } = await probe(env, id);
    expect(status).toBe(200);
    expect(body.reasoning_supported).toBeNull();
    expect(body.conclusive).toBe(false);
    expect(body.persisted).toBe(false);

    const stored = d1.row<{ config_json: string | null }>("SELECT config_json FROM models WHERE id = ?", id)!;
    expect(stored.config_json).toBeNull();
    expect(resolveReasoningSupport({ model_name: "codebuddy_gpt-5", config_json: stored.config_json }).supported).toBe(false);
    d1.close();
  });

  it("keeps an earlier good verdict when a later probe cannot conclude", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const id = seedModel(d1);

    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;
    await probe(env, id);
    const afterOk = d1.row<{ config_json: string }>("SELECT config_json FROM models WHERE id = ?", id)!.config_json;
    expect(JSON.parse(afterOk).probe.reasoning_supported).toBe(true);

    globalThis.fetch = vi.fn(async () => new Response("upstream exploded", { status: 500 })) as unknown as typeof globalThis.fetch;
    const { body } = await probe(env, id);
    expect(body.reasoning_supported).toBeNull();
    const afterFail = d1.row<{ config_json: string }>("SELECT config_json FROM models WHERE id = ?", id)!.config_json;
    expect(afterFail).toBe(afterOk);
    d1.close();
  });

  it("speaks Anthropic's native shape on an Anthropic provider", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const id = seedModel(d1, { providerType: "anthropic" });

    let sent: any = null;
    let sentHeaders: any = null;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      sent = JSON.parse(init.body);
      sentHeaders = init.headers;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const { body } = await probe(env, id, { effort: "medium", max_tokens: 4096 });
    expect(body.reasoning_supported).toBe(true);
    expect(sent.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(sent.reasoning_effort).toBeUndefined();
    expect(sent.max_tokens).toBe(4096);
    expect(sentHeaders.get("anthropic-version")).toBe("2023-06-01");
    d1.close();
  });

  it("keeps the admin's own config keys when it merges the probe block", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const id = seedModel(d1, {
      configJson: JSON.stringify({ capabilities: ["tool_call"], system_prompt: "you are a relay" }),
    });

    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;

    const { body } = await probe(env, id);
    const returned = JSON.parse(body.config_json);
    expect(returned.capabilities).toEqual(["tool_call"]);
    expect(returned.system_prompt).toBe("you are a relay");
    expect(returned.probe.reasoning_supported).toBe(true);
    d1.close();
  });

  it("merges into the form's unsaved config without committing it to the row", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const id = seedModel(d1, { configJson: JSON.stringify({ capabilities: ["tool_call"] }) });

    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;

    const formConfig = JSON.stringify({ capabilities: ["tool_call"], system_prompt: "draft, not saved yet" });
    const { body } = await probe(env, id, { config_json: formConfig });

    const returned = JSON.parse(body.config_json);
    expect(returned.system_prompt).toBe("draft, not saved yet");
    expect(returned.probe.reasoning_supported).toBe(true);

    const stored = JSON.parse(d1.row<{ config_json: string }>("SELECT config_json FROM models WHERE id = ?", id)!.config_json);
    expect(stored.system_prompt).toBeUndefined();
    expect(stored.capabilities).toEqual(["tool_call"]);
    expect(stored.probe.reasoning_supported).toBe(true);
    d1.close();
  });

  it("refuses without spending a call when there is no key or the config is broken", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const id = seedModel(d1, { configJson: "{half typed" });

    let called = false;
    globalThis.fetch = vi.fn(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const broken = await probe(env, id);
    expect(broken.status).toBe(400);
    expect(broken.body.error).toBe("invalid_config_json");
    expect(called).toBe(false);

    d1.sql("UPDATE providers SET api_key = '' WHERE id = ?", "prov_1");
    d1.sql("UPDATE models SET config_json = NULL WHERE id = ?", id);
    const keyless = await probe(env, id);
    expect(keyless.status).toBe(400);
    expect(keyless.body.error).toBe("no_api_key");
    expect(called).toBe(false);
    d1.close();
  });

  it("probes under the rewritten upstream name, not the local alias", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const id = seedModel(d1, {
      configJson: JSON.stringify({ model_rewrite: "gpt-5-2025-08-07" }),
    });

    let sent: any = null;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      sent = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await probe(env, id);
    expect(sent.model).toBe("gpt-5-2025-08-07");
    d1.close();
  });

  it("still probes a model the admin has not switched on yet", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const id = seedModel(d1, { enabled: 0 });

    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;

    const { status, body } = await probe(env, id);
    expect(status).toBe(200);
    expect(body.reasoning_supported).toBe(true);
    d1.close();
  });
});
