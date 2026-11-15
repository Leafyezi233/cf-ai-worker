import { afterEach, describe, expect, it, vi } from "vitest";
import { modelsApp } from "../src/admin/models";
import { modelGroupsApp } from "../src/admin/model-groups";
import type { Env } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedGroup, seedGroupMembers, seedModel, seedProvider } from "./helpers/realGatewayEnv";

const databases: RealD1[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
});
function fixture() {
  const db = createRealD1(); databases.push(db);
  seedProvider(db);
  seedProvider(db, { id: "anthropic", type: "anthropic" });
  seedProvider(db, { id: "gemini", type: "gemini" });
  return { db, env: makeEnv(db) };
}
const config = (profile?: unknown) => JSON.stringify({ model_type: "embedding", ...(profile ? { embedding_profile: profile } : {}) });
const profile = { compatibility_key: "space-v1", dimensions: 3 };
const inputOnly = {
  output_price_per_m: 0, cache_read_price_per_m: 0, cache_write_price_per_m: 0,
  price_per_call: 0, search_price_per_call: 0,
};
const invalidFields: [string, Record<string, unknown>][] = [
  ["call billing", { billing_unit: "call" }],
  ["output price", { output_price_per_m: 0.1 }],
  ["cache read price", { cache_read_price_per_m: 0.1 }],
  ["cache write price", { cache_write_price_per_m: 0.1 }],
  ["call price", { price_per_call: 0.1 }],
  ["search price", { search_price_per_call: 0.1 }],
  ["response cache", { cache_enabled: true }],
];
function write(app: typeof modelsApp, env: Env, path: string, body: unknown, method = "PUT") {
  return app.request("http://admin.test" + path, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }, env);
}
function seedEmbeddings(db: RealD1, groupConfig = config(profile)) {
  seedGroup(db, { id: "grp", name: "embedding-pool", ...inputOnly, config_json: groupConfig });
  seedModel(db, { id: "e1", model_name: "e1", ...inputOnly, config_json: config(profile) });
  seedModel(db, { id: "e2", model_name: "e2", ...inputOnly, config_json: config(profile) });
}
function replace(env: Env, members: string[]) {
  return write(modelGroupsApp, env, "/grp/members", { members: members.map(model_id => ({ model_id })) });
}

describe("embedding model admin writes", () => {
  it("accepts OpenAI input-only token embeddings, without requiring a fixed model profile", async () => {
    const { env } = fixture();
    const response = await write(modelsApp, env, "/", {
      provider_id: "prov_a", model_name: "embed", config_json: config(), input_price_per_m: 1,
    }, "POST");
    expect(response.status).toBe(201);
    expect((await response.json() as any).item).toMatchObject({ ...inputOnly, billing_unit: "token", cache_enabled: 0 });
  });

  it.each(invalidFields)("rejects %s on create and merged update", async (_label, invalid) => {
    const { db, env } = fixture();
    const created = await write(modelsApp, env, "/", {
      provider_id: "prov_a", model_name: "embed", config_json: config(), ...invalid,
    }, "POST");
    expect(created.status).toBe(400);
    expect(db.rows("SELECT id FROM models")).toHaveLength(0);
    seedModel(db, { id: "e", model_name: "e", ...inputOnly, config_json: config() });
    expect((await write(modelsApp, env, "/e", invalid)).status).toBe(400);
    expect(db.row("SELECT * FROM models WHERE id = 'e'")).toMatchObject({ ...inputOnly, billing_unit: "token", cache_enabled: 0 });
  });

  it.each(["anthropic", "gemini"])("rejects %s providers on create, reassignment, and retagging", async provider_id => {
    const { db, env } = fixture();
    expect((await write(modelsApp, env, "/", { provider_id, model_name: "embed", config_json: config() }, "POST")).status).toBe(400);
    seedModel(db, { id: "e", model_name: "e", ...inputOnly, config_json: config() });
    expect((await write(modelsApp, env, "/e", { provider_id })).status).toBe(400);
    seedModel(db, { id: "other", model_name: "other", provider_id, ...inputOnly });
    expect((await write(modelsApp, env, "/other", { config_json: config() })).status).toBe(400);
  });

  it("checks inherited fields when changing type and permits a complete valid conversion", async () => {
    const { db, env } = fixture();
    seedModel(db, { id: "target", model_name: "target", output_price_per_m: 2, billing_unit: "call", cache_enabled: 1 });
    expect((await write(modelsApp, env, "/target", { config_json: config() })).status).toBe(400);
    expect((await write(modelsApp, env, "/target", { config_json: config(), billing_unit: "token", ...inputOnly, cache_enabled: false })).status).toBe(200);
    expect((await write(modelsApp, env, "/target", { input_price_per_m: 4 })).status).toBe(200);
  });

  it("preflights batch cache changes before writing any row and leaves non-embeddings unchanged", async () => {
    const { db, env } = fixture();
    seedModel(db, { id: "text", model_name: "text" });
    seedModel(db, { id: "e", model_name: "e", ...inputOnly, config_json: config() });
    expect((await write(modelsApp, env, "/batch-update", { ids: ["text", "e"], cache_enabled: true }, "POST")).status).toBe(400);
    expect(db.rows("SELECT cache_enabled FROM models").every(row => row.cache_enabled === 0)).toBe(true);
    expect((await write(modelsApp, env, "/batch-update", { ids: ["text"], cache_enabled: true }, "POST")).status).toBe(200);
    expect((await write(modelsApp, env, "/batch-update", { ids: ["e"], enabled: false }, "POST")).status).toBe(200);
  });

  it("blocks reasoning probes for stored and unsaved embedding configs without upstream fetch", async () => {
    const { db, env } = fixture();
    const fetch = vi.fn(() => { throw Error("No network allowed"); });
    vi.stubGlobal("fetch", fetch);
    seedModel(db, { id: "e", ...inputOnly, config_json: config() });
    seedModel(db, { id: "text", model_name: "text" });
    for (const [id, body] of [["e", {}], ["e", { config_json: JSON.stringify({ model_type: "text" }) }], ["text", { config_json: config() }]] as const) {
      const response = await write(modelsApp, env, "/" + id + "/probe-reasoning", body, "POST");
      expect(response.status).toBe(400);
      expect((await response.json() as any).error).toBe("embedding_reasoning_probe_not_supported");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("embedding group admin writes", () => {
  it.each(invalidFields)("rejects %s on group create and effective update", async (_label, invalid) => {
    const { db, env } = fixture();
    expect((await write(modelGroupsApp, env, "/", { name: "embed", config_json: config(), ...invalid }, "POST")).status).toBe(400);
    expect(db.rows("SELECT id FROM model_groups")).toHaveLength(0);
    seedEmbeddings(db);
    expect((await write(modelGroupsApp, env, "/grp", invalid)).status).toBe(400);
  });

  it("allows a single fixed unprofiled upstream but refuses more than one", async () => {
    const { db, env } = fixture();
    seedEmbeddings(db, config());
    db.sql("UPDATE models SET config_json = ?", config());
    expect((await replace(env, ["e1"])).status).toBe(200);
    expect((await replace(env, ["e1", "e2"])).status).toBe(400);
    expect(db.rows("SELECT model_id FROM model_group_members WHERE group_id = 'grp'")).toEqual([{ model_id: "e1" }]);
  });

  it("requires matching group and every member compatibility_key AND dimensions", async () => {
    const { db, env } = fixture();
    seedEmbeddings(db);
    expect((await replace(env, ["e1", "e2"])).status).toBe(200);
    for (const badProfile of [undefined, { compatibility_key: "other", dimensions: 3 }, { compatibility_key: "space-v1", dimensions: 4 }, { compatibility_key: "space-v1" }]) {
      db.sql("UPDATE models SET config_json = ? WHERE id = 'e2'", config(badProfile));
      const response = await replace(env, ["e1", "e2"]);
      expect(response.status).toBe(400);
      expect((await response.json() as any).error).toBe("embedding_compatibility_required");
    }
    db.sql("UPDATE models SET config_json = ?", config({ compatibility_key: "space-v1" }));
    db.sql("UPDATE model_groups SET config_json = ?", config({ compatibility_key: "space-v1" }));
    expect((await replace(env, ["e1", "e2"])).status).toBe(400);
  });

  it("rejects mixed types in either direction, including disabled configured members", async () => {
    const { db, env } = fixture();
    seedEmbeddings(db);
    seedModel(db, { id: "text", model_name: "text" });
    seedModel(db, { id: "image", model_name: "image", billing_unit: "call" });
    for (const id of ["text", "image"]) {
      const response = await replace(env, ["e1", id]);
      expect(response.status).toBe(400);
      expect((await response.json() as any).error).toBe("mixed_model_types");
    }
    db.sql("UPDATE model_groups SET config_json = NULL WHERE id = 'grp'");
    expect((await replace(env, ["e1"])).status).toBe(400);
    seedGroupMembers(db, "grp", ["text"]);
    db.sql("UPDATE model_group_members SET enabled = 0");
    const response = await write(modelGroupsApp, env, "/grp", { config_json: config() });
    expect(response.status).toBe(400);
    expect((await response.json() as any).error).toBe("mixed_model_types");
  });

  it("rejects provider/billing incompatibility and rechecks existing members on group edits", async () => {
    const { db, env } = fixture();
    seedEmbeddings(db);
    expect((await replace(env, ["e1", "e2"])).status).toBe(200);
    expect((await write(modelGroupsApp, env, "/grp", { config_json: config({ compatibility_key: "other", dimensions: 3 }) })).status).toBe(400);
    expect((await write(modelGroupsApp, env, "/grp", { config_json: null })).status).toBe(400);
    for (const change of ["provider_id = 'anthropic'", "provider_id = 'gemini'", "billing_unit = 'call'"]) {
      db.sql("UPDATE models SET provider_id = 'prov_a', billing_unit = 'token'");
      db.sql("UPDATE models SET " + change + " WHERE id = 'e2'");
      const response = await replace(env, ["e1", "e2"]);
      expect(response.status).toBe(400);
      expect((await response.json() as any).error).toBe("embedding_model_required");
      expect((await write(modelGroupsApp, env, "/grp", { display_name: "renamed" })).status).toBe(400);
    }
  });

  it("merges group type conversion with stored pricing and preserves ordinary text groups", async () => {
    const { db, env } = fixture();
    seedGroup(db, { id: "grp", name: "plain", billing_unit: "call", cache_enabled: 1 });
    expect((await write(modelGroupsApp, env, "/grp", { config_json: config() })).status).toBe(400);
    expect((await write(modelGroupsApp, env, "/grp", { config_json: config(), ...inputOnly, billing_unit: "token", cache_enabled: false })).status).toBe(200);
    expect((await write(modelGroupsApp, env, "/", { name: "text-group", output_price_per_m: 2, cache_enabled: true }, "POST")).status).toBe(201);
  });
});
