import { afterEach, describe, expect, it } from "vitest";
import { modelsApp } from "../src/admin/models";
import { modelGroupsApp } from "../src/admin/model-groups";
import { deleteUnreferencedTargets } from "../src/db/model_references";
import { ensureSchema } from "../src/db/schema";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedGroup, seedGroupMembers, seedModel, seedProvider } from "./helpers/realGatewayEnv";

const databases: RealD1[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = createRealD1(); databases.push(db);
  seedProvider(db); seedModel(db); seedGroup(db);
  db.sql("INSERT INTO service_groups (id, name, enabled) VALUES ('sg', 'Public service', 0)");
  return { db, env: makeEnv(db) };
}
function mapping(db: RealD1, type = "model", target = "model_a", key = "gw-primary", members: string | null = null) {
  db.sql("INSERT INTO service_group_models (id, service_group_id, model_key, target_type, target_id, member_ids_json) VALUES ('map', 'sg', ?, ?, ?, ?)", key, type, target, members);
}
function json(method: string, body: unknown) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
function priceWindow(db: RealD1, id: string) {
  db.sql("INSERT INTO price_windows (id, model_id, day_type, start_minute, end_minute) VALUES (?, ?, 'workday', 0, 60)", "price-" + id, id);
}

describe("reference-aware model lifecycle through real SQLite D1", () => {
  it.each(["model", "group"] as const)("keeps each native D1 compound query within five branches for %s", async type => {
    const { db, env } = fixture();
    await ensureSchema(env);
    const prepare = env.DB.prepare.bind(env.DB);
    const batch = env.DB.batch.bind(env.DB);
    let calls = 0;
    env.DB.prepare = (sql: string) => {
      for (const query of sql.split("NOT EXISTS (")) {
        expect((query.match(/ UNION ALL /g) || []).length).toBeLessThanOrEqual(4);
      }
      return prepare(sql);
    };
    env.DB.batch = ((statements: Parameters<typeof batch>[0]) => { calls++; return batch(statements); }) as typeof env.DB.batch;
    const result = await deleteUnreferencedTargets(env, type, [type === "model" ? "model_a" : "grp_a"]);
    expect(result).toEqual({ references: [], deleted: 1 });
    expect(calls).toBe(1);
  });
  const modelRefs: [string, (db: RealD1) => void][] = [
    ["service_mapping", db => mapping(db)],
    ["service_member", db => mapping(db, "group", "grp_a", "public-group", '["model_a"]')],
    ["group_member", db => seedGroupMembers(db, "grp_a", ["model_a"], 0)],
    ["fallback", db => seedModel(db, { id: "fallback-owner", model_name: "other", fallback_model_id: "model_a", enabled: 0 })],
    ["device_model", db => db.sql("INSERT INTO device_models (device_id, model_id) VALUES ('device', 'model_a')")],
    ["template_model", db => db.sql("INSERT INTO device_template_models (template_id, model_id) VALUES ('template', 'model_a')")],
    ["invalid_service_members", db => mapping(db, "group", "grp_a", "broken", '[bad')],
  ];
  it.each(modelRefs)("blocks model deletion on %s without cascading anything", async (kind, seed) => {
    const { db, env } = fixture(); seed(db); priceWindow(db, "model_a");
    const before = db.rows("SELECT * FROM model_group_members");
    const response = await modelsApp.request("http://admin.test/model_a", { method: "DELETE" }, env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "model_in_use", references: expect.arrayContaining([expect.objectContaining({ target_id: "model_a", kind })]) });
    expect(db.row("SELECT id FROM models WHERE id = 'model_a'")).not.toBeNull();
    expect(db.row("SELECT id FROM price_windows WHERE model_id = 'model_a'")).not.toBeNull();
    expect(db.rows("SELECT * FROM model_group_members")).toEqual(before);
  });
  it.each([
    ["service_mapping", (db: RealD1) => mapping(db, "group", "grp_a", "public-group")],
    ["device_group", (db: RealD1) => db.sql("INSERT INTO device_model_groups (device_id, group_id) VALUES ('device', 'grp_a')")],
    ["template_group", (db: RealD1) => db.sql("INSERT INTO device_template_groups (template_id, group_id) VALUES ('template', 'grp_a')")],
  ] as const)("blocks group deletion on %s, retaining owned members", async (kind, seed) => {
    const { db, env } = fixture(); seed(db); seedGroupMembers(db, "grp_a", ["model_a"]); priceWindow(db, "grp_a");
    const response = await modelGroupsApp.request("http://admin.test/grp_a", { method: "DELETE" }, env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "model_group_in_use", references: expect.arrayContaining([expect.objectContaining({ kind })]) });
    expect(db.row("SELECT id FROM model_groups WHERE id = 'grp_a'")).not.toBeNull();
    expect(db.rows("SELECT * FROM model_group_members")).toHaveLength(1);
    expect(db.rows("SELECT * FROM price_windows")).toHaveLength(1);
  });
  it.each(["model", "group"] as const)("blocks %s deletion referenced only by a token scope or override", async type => {
    for (const field of ["model_scope", "model_overrides"]) {
      const { db, env } = fixture();
      const id = type === "model" ? "model_a" : "grp_a";
      const key = type + ":" + id;
      const policy = field === "model_scope" ? { model_scope: [key] } : { model_overrides: { [key]: "sg" } };
      db.sql("INSERT INTO token_routing_policies(device_id,token_id,policy_json,updated_at) VALUES ('orphan','revoked',?,1)", JSON.stringify(policy));
      const app = type === "model" ? modelsApp : modelGroupsApp;
      const response = await app.request("http://admin.test/" + id, { method: "DELETE" }, env);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ references: expect.arrayContaining([expect.objectContaining({ kind: field === "model_scope" ? "token_model_scope" : "token_model_override", source_id: "orphan/revoked" })]) });
      expect(db.rows("SELECT id FROM " + (type === "model" ? "models" : "model_groups"))).toHaveLength(1);
    }
  });
  it("compares exact policy identity keys and permits null inherited policies", async () => {
    const { db, env } = fixture();
    db.sql("INSERT INTO token_routing_policies(device_id,token_id,policy_json,updated_at) VALUES ('x','scope',?,1)", JSON.stringify({ model_scope: ["model:model_a-longer", "public:model_a"], model_overrides: { "group:model_a": "sg" } }));
    db.sql("INSERT INTO token_routing_policies(device_id,token_id,policy_json,updated_at) VALUES ('x','inherit',NULL,1)");
    expect((await modelsApp.request("http://admin.test/model_a", { method: "DELETE" }, env)).status).toBe(200);
  });
  it("fails closed on corrupt token policy JSON instead of deleting potential references", async () => {
    const { db, env } = fixture();
    db.sql("INSERT INTO token_routing_policies(device_id,token_id,policy_json,updated_at) VALUES ('x','broken','[bad',1)");
    const result = await deleteUnreferencedTargets(env, "model", ["model_a"]);
    expect(result.references).toEqual([expect.objectContaining({ kind: "invalid_token_policy" })]);
    expect(result.deleted).toBe(0);
  });
  it("refuses the whole batch if even one target is referenced", async () => {
    const { db, env } = fixture(); mapping(db); seedModel(db, { id: "free", model_name: "free" });
    priceWindow(db, "free");
    const response = await modelsApp.request("http://admin.test/batch-delete", json("POST", { ids: ["free", "model_a", "free"] }), env);
    expect(response.status).toBe(409);
    expect(db.rows("SELECT id FROM models")).toHaveLength(2);
    expect(db.rows("SELECT id FROM price_windows")).toHaveLength(1);
  });
  it("treats JSON member IDs exactly, not as substring/name references", async () => {
    const { db, env } = fixture(); mapping(db, "group", "grp_a", "public-group", '["model_a-longer"]');
    const response = await modelsApp.request("http://admin.test/model_a", { method: "DELETE" }, env);
    expect(response.status).toBe(200);
    expect(db.row("SELECT id FROM models WHERE id = 'model_a'")).toBeNull();
    expect(db.rows("SELECT id FROM service_group_models")).toHaveLength(1);
  });
  it("cleans owned group configuration only after unreferenced group deletion", async () => {
    const { db, env } = fixture(); seedGroupMembers(db, "grp_a", ["model_a"]); priceWindow(db, "grp_a");
    const response = await modelGroupsApp.request("http://admin.test/grp_a", { method: "DELETE" }, env);
    expect(response.status).toBe(200);
    expect(db.rows("SELECT * FROM model_group_members")).toEqual([]);
    expect(db.rows("SELECT * FROM price_windows")).toEqual([]);
    expect(db.rows("SELECT * FROM models")).toHaveLength(1);
  });
  it("deletes an unreferenced batch atomically, deduplicates IDs and cleans prices", async () => {
    const { db, env } = fixture(); seedModel(db, { id: "free", model_name: "free" }); priceWindow(db, "model_a");
    const response = await modelsApp.request("http://admin.test/batch-delete", json("POST", { ids: ["free", "model_a", "free", "missing"] }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 2 });
    expect(db.rows("SELECT * FROM models")).toEqual([]);
    expect(db.rows("SELECT * FROM price_windows")).toEqual([]);
  });
  it("returns 404 when an unreferenced target does not exist", async () => {
    const { env } = fixture();
    expect((await modelsApp.request("http://admin.test/missing", { method: "DELETE" }, env)).status).toBe(404);
    expect((await modelGroupsApp.request("http://admin.test/missing", { method: "DELETE" }, env)).status).toBe(404);
  });
  it("rolls target deletion back if owned configuration cleanup fails", async () => {
    const { db, env } = fixture(); priceWindow(db, "model_a");
    db.sql("CREATE TRIGGER fail_price_cleanup BEFORE DELETE ON price_windows BEGIN SELECT RAISE(ABORT, 'injected_cleanup_failure'); END");
    await expect(deleteUnreferencedTargets(env, "model", ["model_a"])).rejects.toThrow("injected_cleanup_failure");
    expect(db.row("SELECT id FROM models WHERE id = 'model_a'")).not.toBeNull();
    expect(db.rows("SELECT * FROM price_windows")).toHaveLength(1);
  });

  it.each([{ model_name: "renamed" }, { alias: "new-alias" }, { alias: null }])("blocks rename/alias removal breaking an existing mapping: %j", async patch => {
    const { db, env } = fixture(); db.sql("UPDATE models SET alias = 'old-alias' WHERE id = 'model_a'");
    mapping(db, "model", "model_a", "alias" in patch ? "old-alias" : "gw-primary");
    const response = await modelsApp.request("http://admin.test/model_a", json("PUT", patch), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "model_rename_breaks_service_mapping", actions: expect.arrayContaining(["migrate_to_group_target"]), references: [expect.objectContaining({ source_id: "map", source_name: "Public service" })] });
    expect(db.row("SELECT model_name, alias FROM models WHERE id = 'model_a'")).toEqual({ model_name: "gw-primary", alias: "old-alias" });
  });
  it("checks every public mapping, not only the first one", async () => {
    const { db, env } = fixture(); mapping(db);
    db.sql("UPDATE models SET alias = 'second-key' WHERE id = 'model_a'");
    db.sql("INSERT INTO service_group_models (id, service_group_id, model_key, target_type, target_id) VALUES ('map2', 'sg', 'second-key', 'model', 'model_a')");
    const response = await modelsApp.request("http://admin.test/model_a", json("PUT", { model_name: "renamed", alias: "gw-primary" }), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ references: [expect.objectContaining({ source_id: "map2", model_key: "second-key" })] });
    expect(db.row("SELECT model_name, alias FROM models WHERE id = 'model_a'")).toEqual({ model_name: "gw-primary", alias: "second-key" });
  });
  it("allows non-name edits even when an old mapping is already inconsistent", async () => {
    const { db, env } = fixture(); mapping(db, "model", "model_a", "old-inconsistent-key");
    const response = await modelsApp.request("http://admin.test/model_a", json("PUT", { enabled: false }), env);
    expect(response.status).toBe(200);
    expect(db.row("SELECT model_name, enabled FROM models WHERE id = 'model_a'")).toEqual({ model_name: "gw-primary", enabled: 0 });
    expect(db.rows("SELECT * FROM service_group_models")).toHaveLength(1);
  });
  it("permits direct rename retaining the public key as alias and subsequent original save", async () => {
    const { db, env } = fixture(); mapping(db);
    const response = await modelsApp.request("http://admin.test/model_a", json("PUT", { model_name: "renamed", alias: "gw-primary" }), env);
    expect(response.status).toBe(200);
    expect(db.row("SELECT model_name, alias FROM models WHERE id = 'model_a'")).toEqual({ model_name: "renamed", alias: "gw-primary" });
    const saved = await modelsApp.request("http://admin.test/model_a", json("PUT", { model_name: "renamed", alias: "gw-primary" }), env);
    expect(saved.status).toBe(200);
  });
  it("allows disabling a referenced direct model without changing or deleting its mapping", async () => {
    const { db, env } = fixture(); mapping(db);
    expect((await modelsApp.request("http://admin.test/model_a", json("PUT", { enabled: false }), env)).status).toBe(200);
    expect(db.row("SELECT enabled FROM models WHERE id = 'model_a'")).toEqual({ enabled: 0 });
    expect(db.rows("SELECT * FROM service_group_models")).toHaveLength(1);
  });
  it("leaves group ID-bound public names, prices and members untouched on internal rename", async () => {
    const { db, env } = fixture(); mapping(db, "group", "grp_a", "client-name", '["model_a"]'); seedGroupMembers(db, "grp_a", ["model_a"]);
    const before = db.rows("SELECT * FROM service_group_models");
    const response = await modelGroupsApp.request("http://admin.test/grp_a", json("PUT", { name: "internal-renamed" }), env);
    expect(response.status).toBe(200);
    expect(db.row("SELECT id, name FROM model_groups WHERE id = 'grp_a'")).toEqual({ id: "grp_a", name: "internal-renamed" });
    expect(db.rows("SELECT * FROM service_group_models")).toEqual(before);
    expect(db.rows("SELECT * FROM model_group_members")).toHaveLength(1);
  });

  it.each(["model", "group"] as const)("sees a late %s reference inserted immediately before the deletion transaction", async type => {
    const { db, env } = fixture(); const batch = db.DB.batch.bind(db.DB); let injected = false;
    db.DB.batch = (statements: { sql: string }[]) => {
      if (!injected && statements.some(s => /WITH targets/.test(s.sql))) {
        injected = true; mapping(db, type, type === "model" ? "model_a" : "grp_a", type === "model" ? "gw-primary" : "public-group");
      }
      return batch(statements);
    };
    const app = type === "model" ? modelsApp : modelGroupsApp;
    const response = await app.request("http://admin.test/" + (type === "model" ? "model_a" : "grp_a"), { method: "DELETE" }, env);
    expect(injected).toBe(true); expect(response.status).toBe(409);
    expect(db.rows("SELECT * FROM " + (type === "model" ? "models" : "model_groups"))).toHaveLength(1);
    expect(db.rows("SELECT * FROM service_group_models")).toHaveLength(1);
  });
  it("does not report a synthetic updated model when it was concurrently deleted", async () => {
    const { db, env } = fixture(); const prepare = db.DB.prepare.bind(db.DB); let injected = false;
    db.DB.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (!/^UPDATE models SET /.test(sql)) return statement;
      const bind = statement.bind;
      statement.bind = (...values: unknown[]) => {
        bind(...values); const run = statement.run;
        statement.run = async () => { if (!injected) { injected = true; db.sql("DELETE FROM models WHERE id = 'model_a'"); } return run(); };
        return statement;
      };
      return statement;
    };
    const response = await modelsApp.request("http://admin.test/model_a", json("PUT", { model_name: "renamed" }), env);
    expect(injected).toBe(true); expect(response.status).toBe(404);
    expect(db.rows("SELECT * FROM models")).toEqual([]);
  });
  it("rejects a mapping inserted after rename prechecks but before the actual UPDATE", async () => {
    const { db, env } = fixture(); const prepare = db.DB.prepare.bind(db.DB); let injected = false;
    db.DB.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (!/^UPDATE models SET /.test(sql)) return statement;
      const bind = statement.bind;
      statement.bind = (...values: unknown[]) => {
        bind(...values); const run = statement.run;
        statement.run = async () => { if (!injected) { injected = true; mapping(db); } return run(); };
        return statement;
      };
      return statement;
    };
    const response = await modelsApp.request("http://admin.test/model_a", json("PUT", { model_name: "renamed" }), env);
    expect(injected).toBe(true); expect(response.status).toBe(409);
    expect(db.row("SELECT model_name FROM models WHERE id = 'model_a'")).toEqual({ model_name: "gw-primary" });
    expect(db.rows("SELECT * FROM service_group_models")).toHaveLength(1);
  });
});
