import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin";
import { consoleApp } from "../src/console";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import {
  TOKEN,
  makeEnv,
  seedDevice,
  seedGroup,
  seedGroupMembers,
  seedModel,
  seedProvider,
} from "./helpers/realGatewayEnv";
import { gatewayApp } from "../src/gateway/index";
import type { Env } from "../src/types";


const SECRET = "session-signing-secret";

function makeEnvWithSecrets(d1: RealD1): Env {
  return {
    DB: d1.DB,
    ASSETS: { fetch: async () => new Response("assets") } as any,
    ADMIN_SECRET: "admin-password",
    SESSION_SECRET: SECRET,
    ENCRYPTION_KEY: "encryption-key",
  } as unknown as Env;
}

async function admin(env: Env, path: string, init: { method?: string; body?: unknown } = {}) {
  const token = await signSession(SECRET, 0);
  return adminApp.fetch(
    new Request("http://localhost" + path, {
      method: init.method ?? "GET",
      headers: {
        cookie: buildSessionCookie(token).split(";")[0],
        "cf-connecting-ip": "203.0.113.9",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
    env
  );
}

function seedTwoProvidersAndModels(d1: RealD1) {
  seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai" });
  seedProvider(d1, { id: "prov_b", name: "Provider B", type: "openai" });
  seedProvider(d1, { id: "prov_c", name: "Provider C", type: "anthropic", endpoint: "https://c.example/v1" });
  seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
  seedModel(d1, { id: "model_b", model_name: "gw-backup", provider_id: "prov_b" });
  seedModel(d1, { id: "model_c", model_name: "gw-claude", provider_id: "prov_c" });
}

describe("creating a group refuses to collide with a model name", () => {
  it("rejects a name that a model already owns", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/model-groups", { method: "POST", body: { name: "gw-primary" } });

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("name_conflicts_with_model");
    expect(d1.rows("SELECT id FROM model_groups")).toHaveLength(0);
    d1.close();
  });

  it("rejects a name that resolves through a model ALIAS, since callers use both in one field", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    d1.sql("UPDATE models SET alias = 'gw-official' WHERE id = 'model_a'");
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/model-groups", { method: "POST", body: { name: "gw-official" } });

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("name_conflicts_with_model");
    d1.close();
  });

  it("rejects a second group with the same name", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/model-groups", { method: "POST", body: { name: "gw-group" } });

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("name_conflicts_with_group");
    d1.close();
  });

  it("refuses to rename a MODEL onto a group name, in the other direction", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/models/model_a", { method: "PUT", body: { model_name: "gw-group" } });

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("name_conflicts_with_group");
    const stored = d1.row<{ model_name: string }>("SELECT model_name FROM models WHERE id = 'model_a'")!;
    expect(stored.model_name).toBe("gw-primary");
    d1.close();
  });
});

describe("members are an ordered set that must speak one protocol", () => {
  it("stores an ordered member list and returns it in order", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/model-groups/grp_a/members", {
      method: "PUT",
      body: { members: [{ model_id: "model_b" }, { model_id: "model_a" }] },
    });

    expect(res.status).toBe(200);
    const items = ((await res.json()) as any).items;
    expect(items.map((m: any) => m.model_id)).toEqual(["model_b", "model_a"]);
    expect(items.map((m: any) => m.position)).toEqual([0, 1]);
    d1.close();
  });

  it("refuses an empty member list", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/model-groups/grp_a/members", { method: "PUT", body: { members: [] } });

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("empty_members");
    d1.close();
  });

  it("refuses unknown member ids", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/model-groups/grp_a/members", {
      method: "PUT",
      body: { members: [{ model_id: "model_a" }, { model_id: "nope" }] },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("unknown_model_ids");
    expect(body.model_ids).toEqual(["nope"]);
    d1.close();
  });

  it("accepts mixed supplier labels because protocol compatibility is planned per request", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/model-groups/grp_a/members", {
      method: "PUT",
      body: { members: [{ model_id: "model_a" }, { model_id: "model_c" }] },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items.map((row: any) => row.model_id)).toEqual(["model_a", "model_c"]);
    expect(d1.rows("SELECT * FROM model_group_members WHERE group_id = 'grp_a'")).toHaveLength(2);
    d1.close();
  });

  it("accepts a group priced BELOW what its members cost", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    const env = makeEnvWithSecrets(d1);
    const created = await admin(env, "/model-groups", {
      method: "POST",
      body: { name: "gw-cheap", pricing_mode: "priced", input_price_per_m: 1, output_price_per_m: 1 },
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as any).item.id;

    const res = await admin(env, `/model-groups/${id}/members`, {
      method: "PUT",
      body: { members: [{ model_id: "model_a" }, { model_id: "model_b" }] },
    });

    expect(res.status).toBe(200);
    d1.close();
  });
});

describe("a device's grant on a group lives beside its model whitelist", () => {
  it("reads and writes group_ids and group_rpms next to model_ids", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", enabled: 1 });
    await seedDevice(d1, { model_scope: "list" });
    const env = makeEnvWithSecrets(d1);

    const put = await admin(env, "/devices/dev_1/model-scope", {
      method: "PUT",
      body: {
        model_scope: "list",
        model_ids: ["model_a"],
        group_ids: ["grp_a"],
        group_rpms: { grp_a: 30 },
      },
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).item).toMatchObject({ group_ids: ["grp_a"], group_rpms: { grp_a: 30 } });

    const read = await admin(env, "/devices/dev_1/model-scope");
    const body = (await read.json()) as any;
    expect(body.item.group_ids).toEqual(["grp_a"]);
    expect(body.item.group_rpms).toEqual({ grp_a: 30 });
    expect(body.groups).toEqual([{ id: "grp_a", name: "gw-group", display_name: "gw-group", enabled: 1 }]);
    d1.close();
  });

  it("accepts a scope that grants only a group, with no models at all", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    await seedDevice(d1, { model_scope: "list" });
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/devices/dev_1/model-scope", {
      method: "PUT",
      body: { model_scope: "list", model_ids: [], group_ids: ["grp_a"] },
    });

    expect(res.status).toBe(200);
    d1.close();
  });

  it("still refuses a scope that grants nothing at all", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    await seedDevice(d1, { model_scope: "list" });
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/devices/dev_1/model-scope", {
      method: "PUT",
      body: { model_scope: "list", model_ids: [], group_ids: [] },
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("empty_whitelist");
    d1.close();
  });

  it("refuses an unknown group id rather than storing a dangling grant", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    await seedDevice(d1, { model_scope: "list" });
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/devices/dev_1/model-scope", {
      method: "PUT",
      body: { model_scope: "list", model_ids: [], group_ids: ["grp_missing"] },
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("unknown_group_ids");
    d1.close();
  });
});

describe("the list reports whether a group can reason", () => {
  it("defaults to yes with the five-level ladder when config_json says nothing", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/model-groups");
    const listed = ((await res.json()) as any).items.find((g: any) => g.id === "grp_a");
    expect(listed.reasoning.supported).toBe(true);
    expect(listed.reasoning.levels.map((l: any) => l.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(listed.reasoning.default_level).toBe("medium");
    expect(listed.reasoning.source).toBe("group_default");

    const one = ((await (await admin(env, "/model-groups/grp_a")).json()) as any).item;
    expect(one.reasoning).toMatchObject({ supported: true, default_level: "medium" });
    d1.close();
  });

  it("honours an explicit ladder and an explicit off", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, {
      id: "grp_a",
      name: "gw-group",
      config_json: JSON.stringify({ supported_reasoning_levels: ["low", "high"], default_reasoning_level: "high" }),
    });
    seedGroup(d1, { id: "grp_b", name: "gw-off", config_json: JSON.stringify({ supports_reasoning: false }) });
    const env = makeEnvWithSecrets(d1);

    const items = ((await (await admin(env, "/model-groups")).json()) as any).items;
    const ladder = items.find((g: any) => g.id === "grp_a");
    expect(ladder.reasoning).toMatchObject({ supported: true, source: "group_levels", default_level: "high" });
    expect(ladder.reasoning.levels.map((l: any) => l.effort)).toEqual(["low", "high"]);

    const vetoed = items.find((g: any) => g.id === "grp_b");
    expect(vetoed.reasoning).toMatchObject({ supported: false, levels: [], source: "config_off" });
    d1.close();
  });
});

describe("a group appears wherever a model appears", () => {
  it("shows up on the device console, on /v1/models and in the OpenAPI enum", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", input_price_per_m: 9, output_price_per_m: 45, model_public: 1 });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1);
    const env = makeEnv(d1);

    const consoleRes = await consoleApp.fetch(
      new Request("https://gw.test/models", { headers: { authorization: "Bearer " + TOKEN } }),
      env
    );
    expect(consoleRes.status).toBe(200);
    const consoleBody = (await consoleRes.json()) as any;
    const group = consoleBody.items.find((m: any) => m.model_name === "gw-group");
    expect(group).toBeTruthy();
    expect(group).toMatchObject({
      input_price_per_m: 9,
      output_price_per_m: 45,
      chat_endpoint: "/v1/chat/completions",
    });
    expect(consoleBody.model_count).toBe(consoleBody.items.length);

    const listRes = await gatewayApp.request(
      "http://gw.test/models",
      { headers: { Authorization: "Bearer " + TOKEN } },
      env
    );
    const listBody = (await listRes.json()) as any;
    expect(listBody.data.map((m: any) => m.id)).toContain("gw-group");

    const specRes = await gatewayApp.request(
      "http://gw.test/openapi.json",
      { headers: { Authorization: "Bearer " + TOKEN } },
      env
    );
    const spec = (await specRes.json()) as any;
    const enumValues = spec.components.schemas.ChatCompletionRequest.properties.model.enum;
    expect(enumValues).toContain("gw-group");
    d1.close();
  });

  it("hides a group whose members can all no longer serve", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", model_public: 1 });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1);
    d1.sql("UPDATE models SET enabled = 0 WHERE id = 'model_a'");
    const env = makeEnv(d1);

    const listRes = await gatewayApp.request(
      "http://gw.test/models",
      { headers: { Authorization: "Bearer " + TOKEN } },
      env
    );
    const listBody = (await listRes.json()) as any;
    expect(listBody.data.map((m: any) => m.id)).not.toContain("gw-group");
    d1.close();
  });

  it("shows up on the Codex catalogue, in the Ollama tag list and in a single-model lookup", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", display_name: "Gw Group", input_price_per_m: 9, output_price_per_m: 45, model_public: 1 });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1);
    const env = makeEnv(d1);
    const headers = { Authorization: "Bearer " + TOKEN };

    const catalogRes = await gatewayApp.request("http://gw.test/model-catalog.json", { headers }, env);
    expect(catalogRes.status).toBe(200);
    const catalog = (await catalogRes.json()) as any;
    const entry = (Array.isArray(catalog) ? catalog : catalog.models || catalog.items || []).find(
      (m: any) => m.slug === "gw-group" || m.model === "gw-group" || m.id === "gw-group"
    );
    expect(entry).toBeTruthy();

    const tagsRes = await gatewayApp.request("http://gw.test/tags", { headers }, env);
    expect(tagsRes.status).toBe(200);
    const tags = (await tagsRes.json()) as any;
    expect(JSON.stringify(tags)).toContain("gw-group");

    const oneRes = await gatewayApp.request("http://gw.test/models/gw-group", { headers }, env);
    expect(oneRes.status).toBe(200);
    const one = (await oneRes.json()) as any;
    expect(one.id).toBe("gw-group");
    expect(one.input_price_per_m).toBe(9);
    expect(one.output_price_per_m).toBe(45);
    expect(one.alias).toBeNull();
    expect(one.fallback_model_id).toBeNull();
    d1.close();
  });

  it("gates a single group lookup by the group grant, not by the members", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", model_public: 0 });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1, { model_scope: "list" });
    const env = makeEnv(d1);
    const headers = { Authorization: "Bearer " + TOKEN };

    d1.sql("INSERT INTO device_models (device_id, model_id, rpm) VALUES ('dev_1', 'model_a', 0)");
    const refused = await gatewayApp.request("http://gw.test/models/gw-group", { headers }, env);
    expect(refused.status).toBe(404);

    d1.sql("INSERT INTO device_model_groups (device_id, group_id, rpm) VALUES ('dev_1', 'grp_a', 0)");
    const allowed = await gatewayApp.request("http://gw.test/models/gw-group", { headers }, env);
    expect(allowed.status).toBe(200);
    d1.close();
  });

  it("removes a deleted group's members and grants with it", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1);
    d1.sql("INSERT INTO device_model_groups (device_id, group_id, rpm) VALUES ('dev_1', 'grp_a', 0)");
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/model-groups/grp_a", { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(d1.rows("SELECT * FROM model_group_members WHERE group_id = 'grp_a'")).toHaveLength(1);
    expect(d1.rows("SELECT * FROM device_model_groups WHERE group_id = 'grp_a'")).toHaveLength(1);
    d1.close();
  });
});

describe("a group carries its own price bands", () => {
  it("stores and returns the group's bands under the group id", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", peak_pricing_enabled: 1 });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    const env = makeEnvWithSecrets(d1);

    const putRes = await admin(env, "/model-groups/grp_a/price-windows", {
      method: "PUT",
      body: { windows: [{ day_type: "weekday", start: "09:00", end: "18:00", multiplier: 2, enabled: true }] },
    });
    expect(putRes.status).toBe(200);

    const stored = d1.rows("SELECT model_id, multiplier FROM price_windows");
    expect(stored).toHaveLength(1)
    expect(stored[0].model_id).toBe("grp_a");

    const getRes = await admin(env, "/model-groups/grp_a/price-windows");
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as any;
    expect(body.peak_pricing_enabled).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].multiplier).toBe(2);
    d1.close();
  });

  it("keeps a model's own bands apart from a group's", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group", peak_pricing_enabled: 1 });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    const env = makeEnvWithSecrets(d1);

    await admin(env, "/model-groups/grp_a/price-windows", {
      method: "PUT",
      body: { windows: [{ day_type: "weekday", start: "09:00", end: "18:00", multiplier: 2, enabled: true }] },
    });
    await admin(env, "/models/model_a/price-windows", {
      method: "PUT",
      body: { windows: [{ day_type: "weekday", start: "09:00", end: "18:00", multiplier: 5, enabled: true }] },
    });

    const groupBands = (await (await admin(env, "/model-groups/grp_a/price-windows")).json()) as any;
    const modelBands = (await (await admin(env, "/models/model_a/price-windows")).json()) as any;
    expect(groupBands.items.map((w: any) => w.multiplier)).toEqual([2]);
    expect(modelBands.items.map((w: any) => w.multiplier)).toEqual([5]);
    d1.close();
  });
});

describe("the playground can exercise a group", () => {
  let realFetch: typeof globalThis.fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubUpstream() {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          model: "gw-primary",
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof globalThis.fetch;
    return calls;
  }

  it("resolves a group to its first member and reports the name that was billed", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedProvider(d1, { id: "prov_b", name: "Provider B", type: "openai", endpoint: "https://b.example/v1" });
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_b", "model_a"]);
    const env = makeEnvWithSecrets(d1);
    const calls = stubUpstream();

    const res = await admin(env, "/playground/chat", {
      method: "POST",
      body: { model: "gw-group", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(calls[0]).toContain("b.example");
    expect(body.billing_model).toBe("gw-group");
    expect(body.is_group).toBe(true);
    expect(body.provider_name).toBe("Provider B");
    d1.close();
  });

  it("still resolves a plain model and marks it as not a group", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedProvider(d1, { id: "prov_b", name: "Provider B", type: "openai", endpoint: "https://b.example/v1" });
    const env = makeEnvWithSecrets(d1);
    const calls = stubUpstream();

    const res = await admin(env, "/playground/chat", {
      method: "POST",
      body: { model: "gw-primary", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(calls[0]).toContain("a.example");
    expect(body.billing_model).toBe("gw-primary");
    expect(body.is_group).toBe(false);
    d1.close();
  });

  it("answers 503 for a group with no servable member instead of a misleading 404", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    d1.sql("UPDATE models SET enabled = 0 WHERE id = 'model_a'");
    const env = makeEnvWithSecrets(d1);
    stubUpstream();

    const res = await admin(env, "/playground/chat", {
      method: "POST",
      body: { model: "gw-group", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toBe("model_unavailable");
    d1.close();
  });
});

describe("deleting a member leaves no dangling edge", () => {
  it("removes the model's group memberships and device grants with the row", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1);
    d1.sql("INSERT INTO device_models (device_id, model_id, rpm) VALUES ('dev_1', 'model_a', 0)");
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/models/model_a", { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(d1.rows("SELECT model_id FROM model_group_members WHERE group_id = 'grp_a'").map((r: any) => r.model_id)).toEqual([
      "model_a",
      "model_b",
    ]);
    expect(d1.rows("SELECT model_id FROM device_models WHERE model_id = 'model_a'")).toHaveLength(1);
    d1.close();
  });

  it("still answers 404 for a model that never existed", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/models/model_missing", { method: "DELETE" });

    expect(res.status).toBe(404);
    d1.close();
  });

  it("prunes the same edges from a batch delete", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/models/batch-delete", { method: "POST", body: { ids: ["model_a", "model_b"] } });

    expect(res.status).toBe(409);
    expect(d1.rows("SELECT * FROM model_group_members WHERE group_id = 'grp_a'")).toHaveLength(2);
    d1.close();
  });
});

describe("a member edge carries the provider it points at", () => {
  it("names each member's provider on the list and on the single-group read", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    const env = makeEnvWithSecrets(d1);

    const listRes = await admin(env, "/model-groups");
    expect(listRes.status).toBe(200);
    const listed = ((await listRes.json()) as any).items.find((g: any) => g.id === "grp_a");
    expect(listed.members.map((m: any) => [m.model_id, m.provider_name])).toEqual([
      ["model_a", "Provider A"],
      ["model_b", "Provider B"],
    ]);

    const oneRes = await admin(env, "/model-groups/grp_a");
    expect(oneRes.status).toBe(200);
    const one = ((await oneRes.json()) as any).item;
    expect(one.members.map((m: any) => [m.model_id, m.provider_name])).toEqual([
      ["model_a", "Provider A"],
      ["model_b", "Provider B"],
    ]);
    d1.close();
  });

  it("still names the provider of a member whose model was disabled", async () => {
    const d1 = createRealD1();
    seedTwoProvidersAndModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    d1.sql("UPDATE models SET enabled = 0 WHERE id = 'model_b'");
    const env = makeEnvWithSecrets(d1);

    const res = await admin(env, "/model-groups");
    const listed = ((await res.json()) as any).items.find((g: any) => g.id === "grp_a");
    const member = listed.members.find((m: any) => m.model_id === "model_b");
    expect(member.model_name).toBe("gw-backup");
    expect(member.provider_name).toBe("Provider B");
    d1.close();
  });
});
