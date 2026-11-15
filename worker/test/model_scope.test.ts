import { durableBillingFixture } from "./helpers/durableBillingFixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import {
  filterCandidatesForDevice,
  getDeviceModelIds,
  isModelInScope,
  listModelsForDevice,
  replaceDeviceModels,
} from "../src/db/repo";
import type { DeviceRow, Env, ModelWithProvider } from "../src/types";

const TOKEN = "ccs_scope_token";

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
    model_public: 0,
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

function deviceRow(over: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: "d1",
    name: "Laptop",
    token_hash: "pending",
    enabled: 1,
    rate_limit_rpm: 0,
    cost_limit_monthly: null,
    last_used_at: null,
    created_at: 1,
    revoked_at: null,
    model_scope: "all",
    ...over,
  } as DeviceRow;
}

async function makeEnv(opts: { models?: ModelWithProvider[]; device?: DeviceRow | null; whitelisted?: string[] } = {}) {
  const fixture = await durableBillingFixture(opts.models ?? [], { token: TOKEN, device: opts.device === undefined ? deviceRow() : opts.device, whitelisted: opts.whitelisted });
  await (await import("../src/db/schema")).ensureSchema(fixture.env);
  fixture.queries.length = 0;
  return fixture;
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

function chatBody() {
  return JSON.stringify({ model: "gw-primary", messages: [{ role: "user", content: "hi" }], max_tokens: 8 });
}

async function postChat(env: Env) {
  return gatewayApp.request(
    "http://gw.test/chat/completions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: chatBody(),
    },
    env,
    new CollectingExecutionContext() as never
  );
}

function get(env: Env, path: string, token?: string) {
  return gatewayApp.request(
    `http://gw.test${path}`,
    token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    env,
    new CollectingExecutionContext() as never
  );
}

describe("isModelInScope", () => {
  it("lets every model through when the scope is all", () => {
    expect(isModelInScope("all", "model_a", new Set(), false)).toBe(true);
    expect(isModelInScope(undefined, "model_a", new Set(), false)).toBe(true);
  });

  it("narrows to the whitelist ids when the scope is list", () => {
    const allowed = new Set(["model_a"]);
    expect(isModelInScope("list", "model_a", allowed, false)).toBe(true);
    expect(isModelInScope("list", "model_b", allowed, false)).toBe(false);
  });

  it("keeps a published model reachable under all_and_list", () => {
    const allowed = new Set<string>();
    expect(isModelInScope("all_and_list", "model_a", allowed, true)).toBe(true);
    expect(isModelInScope("all_and_list", "model_a", allowed, false)).toBe(false);
  });
});

describe("replaceDeviceModels", () => {
  it("replaces the set wholesale and collapses duplicates", async () => {
    const { env, d1 } = await makeEnv({ models: [modelRow({ id: "model_a" }), modelRow({ id: "model_b" })], whitelisted: ["model_old"] });
    const stored = await replaceDeviceModels(env, "d1", ["model_a", "model_b", "model_a", "", "  "]);
    expect(stored).toEqual(["model_a", "model_b"]);
    expect(d1.rows("SELECT model_id FROM device_models WHERE device_id = ? ORDER BY model_id", "d1").map((x) => x.model_id)).toEqual(["model_a", "model_b"]);
  });

  it("stores an empty set when the admin clears the whitelist", async () => {
    const { env } = await makeEnv({ models: [], whitelisted: ["model_a"] });
    expect(await replaceDeviceModels(env, "d1", [])).toEqual([]);
  });
  it("reads ids back in sorted order", async () => {
    const { env } = await makeEnv({ models: [], whitelisted: ["model_z", "model_a"] });
    expect(await getDeviceModelIds(env, "d1")).toEqual(["model_a", "model_z"]);
  });
});

describe("listModelsForDevice", () => {
  const PUBLIC = modelRow({ id: "pub", model_name: "shared", alias: "shared-alias", model_public: 1 });
  const PRIVATE_A = modelRow({ id: "priv_a", model_name: "secret-a" });
  const PRIVATE_B = modelRow({ id: "priv_b", model_name: "secret-b" });

  it("shows only published models to an anonymous caller", async () => {
    const { env } = await makeEnv({ models: [PUBLIC, PRIVATE_A, PRIVATE_B], device: null });
    const ids = (await listModelsForDevice(env, null)).map((m) => m.id);
    expect(ids).toEqual(["pub"]);
  });

  it("shows everything to a device scoped to all", async () => {
    const { env } = await makeEnv({ models: [PUBLIC, PRIVATE_A, PRIVATE_B] });
    const ids = (await listModelsForDevice(env, deviceRow())).map((m) => m.id);
    expect(ids).toEqual(["pub", "priv_a", "priv_b"]);
  });

  it("shows only whitelisted ids under list scope", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env, queries } = await makeEnv({ models: [PUBLIC, PRIVATE_A, PRIVATE_B], device: scoped, whitelisted: ["priv_b"] });
    expect((await listModelsForDevice(env, scoped)).map((m) => m.id)).toEqual(["priv_b"]);
    expect(queries.some((q) => q.includes("device_models"))).toBe(true);
  });

  it("keeps published models reachable under all_and_list", async () => {
    const scoped = deviceRow({ model_scope: "all_and_list" });
    const { env } = await makeEnv({ models: [PUBLIC, PRIVATE_A], device: scoped, whitelisted: ["priv_a"] });
    const ids = (await listModelsForDevice(env, scoped)).map((m) => m.id);
    expect(ids.sort()).toEqual(["priv_a", "pub"]);
  });

  it("shows nothing when a list-scoped device has an empty whitelist", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env } = await makeEnv({ models: [PUBLIC, PRIVATE_A], device: scoped, whitelisted: [] });
    expect(await listModelsForDevice(env, scoped)).toEqual([]);
  });

  it("does not query device_models at all under all scope", async () => {
    const { env, queries } = await makeEnv({ models: [PUBLIC, PRIVATE_A] });
    await listModelsForDevice(env, deviceRow());
    expect(queries.some((q) => q.includes("device_models"))).toBe(false);
  });
});

describe("filterCandidatesForDevice", () => {
  it("passes every candidate through under all scope", async () => {
    const { env } = await makeEnv();
    const cands = [modelRow({ id: "a" }), modelRow({ id: "b" })];
    expect(await filterCandidatesForDevice(env, deviceRow(), cands)).toHaveLength(2);
  });

  it("keeps only the whitelisted copy when one name is registered twice", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env } = await makeEnv({ device: scoped, whitelisted: ["model_b"] });
    const cands = [modelRow({ id: "model_a", provider_id: "prov_a" }), modelRow({ id: "model_b", provider_id: "prov_b" })];
    const kept = await filterCandidatesForDevice(env, scoped, cands);
    expect(kept.map((c) => c.id)).toEqual(["model_b"]);
  });

  it("drops every candidate for an empty whitelist", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env } = await makeEnv({ device: scoped, whitelisted: [] });
    expect(await filterCandidatesForDevice(env, scoped, [modelRow()])).toEqual([]);
  });
});
describe("the gateway applies the whitelist to real requests", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const okBody = JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "gw-primary",
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
  });

  it("answers 403 when the model exists but is not whitelisted", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env, usages } = await makeEnv({ models: [modelRow({ id: "model_a" })], device: scoped, whitelisted: [] });
    globalThis.fetch = vi.fn(async () => new Response(okBody, { status: 200 })) as unknown as typeof globalThis.fetch;

    const res = await postChat(env);
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe("model_not_in_scope");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(usages()).toHaveLength(0);
  });

  it("serves the model once its id is whitelisted", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env, usages } = await makeEnv({ models: [modelRow({ id: "model_a" })], device: scoped, whitelisted: ["model_a"] });
    globalThis.fetch = vi.fn(async () => new Response(okBody, { status: 200 })) as unknown as typeof globalThis.fetch;

    const res = await postChat(env);
    expect(res.status).toBe(200);
    expect(usages()).toHaveLength(1);
  });

  it("prefers the whitelisted copy when one is in scope", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env } = await makeEnv({
      models: [modelRow({ id: "model_a", provider_id: "prov_a" }), modelRow({ id: "model_b", provider_id: "prov_b" })],
      device: scoped,
      whitelisted: ["model_a"],
    });
    globalThis.fetch = vi.fn(async () => new Response(okBody, { status: 200 })) as unknown as typeof globalThis.fetch;

    const res = await postChat(env);
    expect(res.status).toBe(200);
    expect(String((globalThis.fetch as any).mock.calls[0][0])).toContain("a.example");
  });

  it("fails over to a non-whitelisted copy of the same model, invisibly", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env } = await makeEnv({
      models: [modelRow({ id: "model_a", provider_id: "prov_a", provider_endpoint: "https://a.example/v1" }),
               modelRow({ id: "model_b", provider_id: "prov_b", provider_endpoint: "https://b.example/v1" })],
      device: scoped,
      whitelisted: ["model_a"],
    });
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response("upstream down", { status: 503 });
      return new Response(okBody, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const res = await postChat(env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.model).toBe("gw-primary");
    expect(String((globalThis.fetch as any).mock.calls[1][0])).toContain("b.example");
  });

  it("tries a non-whitelisted copy exactly once, then answers 502", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env, usages } = await makeEnv({
      models: [modelRow({ id: "model_a", provider_id: "prov_a", provider_endpoint: "https://a.example/v1" }),
               modelRow({ id: "model_b", provider_id: "prov_b", provider_endpoint: "https://b.example/v1" })],
      device: scoped,
      whitelisted: ["model_a"],
    });
    globalThis.fetch = vi.fn(async () => {
      return new Response("every upstream down", { status: 503 });
    }) as unknown as typeof globalThis.fetch;

    const res = await postChat(env);
    expect(res.status).toBe(502);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(String((globalThis.fetch as any).mock.calls[1][0])).toContain("b.example");
    expect(usages()).toHaveLength(1);
    expect(usages()[0].status_code).toBe(502);
    expect(usages()[0].cost_usd).toBe(0);
  });

  it("does not retry an unknown network failure", async () => {
    const { env, usages } = await makeEnv({
      models: [modelRow({ id: "model_a", provider_id: "prov_a", provider_endpoint: "https://a.example/v1" }),
               modelRow({ id: "model_b", provider_id: "prov_b", provider_endpoint: "https://b.example/v1" })],
      device: deviceRow({ model_scope: "all" }),
    });
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network unavailable");
    }) as unknown as typeof globalThis.fetch;

    const res = await postChat(env);
    expect(res.status).toBe(502);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(usages()).toHaveLength(0);
  });

  it("keeps the failover order unchanged when every candidate is in scope", async () => {
    const { env, usages } = await makeEnv({
      models: [modelRow({ id: "model_a", provider_id: "prov_a", provider_endpoint: "https://a.example/v1" }),
               modelRow({ id: "model_b", provider_id: "prov_b", provider_endpoint: "https://b.example/v1" })],
      device: deviceRow({ model_scope: "all" }),
    });
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response("upstream down", { status: 503 });
      return new Response(okBody, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const res = await postChat(env);
    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(String((globalThis.fetch as any).mock.calls[1][0])).toContain("b.example");
    expect(usages()).toHaveLength(1);
  });

  it("keeps an anonymous caller on the published set", async () => {
    const { env } = await makeEnv({ models: [modelRow({ id: "pub", model_public: 1 })], device: null });
    const res = await get(env, "/models");
    const json = (await res.json()) as any;
    expect(json.data.map((x: any) => x.id)).toEqual(["gw-primary"]);
  });

  it("lists only whitelisted models on GET /v1/models", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env } = await makeEnv({
      models: [modelRow({ id: "model_a", model_name: "alpha" }), modelRow({ id: "model_b", model_name: "beta" })],
      device: scoped,
      whitelisted: ["model_b"],
    });
    const res = await get(env, "/models", TOKEN);
    const json = (await res.json()) as any;
    expect(json.data.map((x: any) => x.id)).toEqual(["beta"]);
  });

  it("404s a real-but-out-of-scope model instead of admitting it exists", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env } = await makeEnv({ models: [modelRow({ id: "model_a", model_name: "alpha" })], device: scoped, whitelisted: [] });
    const res = await get(env, "/models/alpha", TOKEN);
    expect(res.status).toBe(404);
  });

  it("hides the out-of-scope model from the catalog", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env } = await makeEnv({
      models: [modelRow({ id: "model_a", model_name: "alpha" }), modelRow({ id: "model_b", model_name: "beta" })],
      device: scoped,
      whitelisted: ["model_b"],
    });
    const res = await get(env, "/model-catalog.json", TOKEN);
    const json = (await res.json()) as any;
    const names = JSON.stringify(json);
    expect(names).toContain("beta");
    expect(names).not.toContain("alpha");
  });

  it("hides the out-of-scope model from the openapi schema", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env } = await makeEnv({
      models: [modelRow({ id: "model_a", model_name: "alpha" }), modelRow({ id: "model_b", model_name: "beta" })],
      device: scoped,
      whitelisted: ["model_b"],
    });
    const res = await get(env, "/openapi.json", TOKEN);
    const json = (await res.json()) as any;
    const names = JSON.stringify(json);
    expect(names).toContain("beta");
    expect(names).not.toContain("alpha");
  });

  it("hides the out-of-scope model from the ollama tags endpoint", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env } = await makeEnv({
      models: [modelRow({ id: "model_a", model_name: "alpha" }), modelRow({ id: "model_b", model_name: "beta" })],
      device: scoped,
      whitelisted: ["model_b"],
    });
    const res = await get(env, "/tags", TOKEN);
    const json = (await res.json()) as any;
    expect(json.models.map((x: any) => x.name)).toEqual(["beta"]);
  });
  it("never routes a scoped request to the copy the routing order prefers", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env } = await makeEnv({
      models: [
        modelRow({ id: "model_a", model_name: "gw-primary", provider_id: "prov_a", provider_endpoint: "https://a.example/v1" }),
        modelRow({
          id: "model_b",
          model_name: "gw-secondary",
          alias: "gw-primary",
          provider_id: "prov_b",
          provider_endpoint: "https://b.example/v1",
        }),
      ],
      device: scoped,
      whitelisted: ["model_a"],
    });
    globalThis.fetch = vi.fn(async () => new Response(okBody, { status: 200 })) as unknown as typeof globalThis.fetch;

    const res = await postChat(env);
    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(String((globalThis.fetch as any).mock.calls[0][0])).toContain("a.example");
  });

  it("uses an out-of-scope explicit fallback_model_id when the primary dies", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env, usages } = await makeEnv({
      models: [
        modelRow({ id: "model_a", model_name: "gw-primary", fallback_model_id: "model_fb", provider_endpoint: "https://a.example/v1" }),
        modelRow({ id: "model_fb", model_name: "gw-fallback", provider_endpoint: "https://fb.example/v1" }),
      ],
      device: scoped,
      whitelisted: ["model_a"],
    });
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response("upstream down", { status: 503 });
      return new Response(okBody, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const res = await postChat(env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.model).toBe("gw-primary");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(String((globalThis.fetch as any).mock.calls[1][0])).toContain("fb.example");
    expect(usages()).toHaveLength(1);
    expect(usages()[0].model).toBe("gw-primary");
  });

  it("still honours an explicit fallback that IS whitelisted", async () => {
    const scoped = deviceRow({ model_scope: "list" });
    const { env } = await makeEnv({
      models: [
        modelRow({ id: "model_a", model_name: "gw-primary", fallback_model_id: "model_fb", provider_endpoint: "https://a.example/v1" }),
        modelRow({ id: "model_fb", model_name: "gw-fallback", provider_endpoint: "https://fb.example/v1" }),
      ],
      device: scoped,
      whitelisted: ["model_a", "model_fb"],
    });
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response("upstream down", { status: 503 });
      return new Response(okBody, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const res = await postChat(env);
    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(String((globalThis.fetch as any).mock.calls[1][0])).toContain("fb.example");
  });
});