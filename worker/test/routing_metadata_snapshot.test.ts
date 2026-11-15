import { afterEach, describe, expect, it } from "vitest";
import {
  ensureModelCategoriesSchema, exportModelCategories, restoreModelCategoriesStatements,
  type ModelCategoriesBackup,
} from "../src/db/model_categories";
import { createConfigSnapshot, restoreConfigSnapshot } from "../src/db/repo";
import { ensureSchema } from "../src/db/schema";
import {
  restoreServiceGroupsSnapshot, snapshotServiceGroups, validateServiceGroupsSnapshot,
  type ServiceGroupsSnapshot,
} from "../src/db/service_group_snapshot";
import { resolveTokenRoutingPolicy } from "../src/db/token_policies";
import type { DeviceRow, Env, TokenRoutingPolicy } from "../src/types";
import { createRealD1 } from "./helpers/realD1";

const databases: ReturnType<typeof createRealD1>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const prices = {
  input_price_per_m: 1, output_price_per_m: 2, cache_read_price_per_m: 0,
  cache_write_price_per_m: 0, price_per_call: 0, search_price_per_call: 0,
};
function policy(): TokenRoutingPolicy {
  return {
    mode: "multi", group_ids: ["s2", "s1"], selection: "input_price", failure_fallback: true,
    model_scope: ["model:m1", "model:m2", "group:g1", "public:identity-direct"],
    model_overrides: { "model:m1": "s1", "model:m2": "s2", "group:g1": "s2", "public:identity-direct": "s1" },
  };
}
function fixture(): ServiceGroupsSnapshot {
  return {
    model_groups: [{ id: "g1", name: "pool", display_name: null, description: null,
      enabled: 1, model_public: 1, pricing_mode: "priced", ...prices, cache_enabled: 0,
      cache_ttl: 60, peak_pricing_enabled: 0, config_json: null, created_at: 1, updated_at: 2,
      billing_unit: "token" }],
    model_group_members: [{ group_id: "g1", model_id: "m1", position: 0, enabled: 1 },
      { group_id: "g1", model_id: "m2", position: 1, enabled: 1 }],
    model_price_windows: [],
    device_model_groups: [{ device_id: "d1", group_id: "g1", rpm: 20 }],
    service_groups: ["s1", "s2"].map((id) => ({ id, name: id, description: null,
      public_selectable: 1, selectable: 1, enabled: 1, multiplier: 1, revision: 3 })),
    service_group_models: [
      { id: "map1", service_group_id: "s1", model_key: "direct", target_type: "model",
        target_id: "m1", pricing_json: JSON.stringify(prices), member_ids_json: null },
      { id: "map2", service_group_id: "s2", model_key: "pool", target_type: "group",
        target_id: "g1", pricing_json: null, member_ids_json: JSON.stringify(["m1", "m2"]) },
    ],
    device_service_groups: [{ device_id: "d1", service_group_id: "s1" }, { device_id: "d1", service_group_id: "s2" }],
    device_service_group_selections: [{ id: "d1", default_service_group_id: "s1", service_group_id: "s2" }],
    sub_token_service_group_selections: [{ id: "sub1", device_id: "d1", service_group_id: "s1" }],
    routing_metadata: {
      identities: [{ id: "identity-direct", name: "direct", enabled: 1 },
        { id: "identity-pool", name: "pool", enabled: 0 },
        { id: "identity-retired", name: "retired", enabled: 0 }],
      aliases: [{ service_group_id: "s1", name: "old-direct", mapping_id: "map1", enabled: 1 },
        { service_group_id: "s1", name: "retired-name", mapping_id: "deleted-mapping", enabled: 0 },
        { service_group_id: "s2", name: "old-pool", mapping_id: "map2", enabled: 1 }],
      policies: [
        { device_id: "d1", token_id: "account", policy_json: JSON.stringify(policy()), revision: 7, updated_at: 1 },
        { device_id: "d1", token_id: "master", policy_json: null, revision: 4, updated_at: 2 },
        { device_id: "d1", token_id: "sub1", policy_json: JSON.stringify(policy()), revision: 11, updated_at: 3 },
      ],
    },
  };
}
function categories(name = "direct"): ModelCategoriesBackup {
  return {
    model_categories: [{ id: "category-code", name: "Code", description: "snapshot metadata", sort_order: 2, color: "green", enabled: 1 },
      { id: "category-off", name: "Hidden", description: "disabled", sort_order: 3, color: "slate", enabled: 0 }],
    model_category_bindings: [{ model_name: name, category_id: "category-code" },
      { model_name: "pool", category_id: "category-off" }],
  };
}
async function setup() {
  const db = createRealD1();
  databases.push(db);
  const env = { DB: db.DB, ENCRYPTION_KEY: "routing-snapshot-test-key" } as unknown as Env;
  await ensureSchema(env);
  await ensureModelCategoriesSchema(env);
  db.sql("INSERT INTO providers (id,name,type) VALUES ('p1','provider','openai')");
  for (const id of ["m1", "m2"]) db.sql("INSERT INTO models (id,provider_id,model_name) VALUES (?,'p1',?)", id, id);
  for (const id of ["d1", "d2"]) db.sql("INSERT INTO devices (id,name,token_hash,password_hash,enabled,revoked_at) VALUES (?,?,?,?,0,123)", id, id, "secret-" + id, "password-" + id);
  db.sql("INSERT INTO device_sub_tokens (id,device_id,name,token_hash,created_at,enabled,revoked_at) VALUES ('sub1','d1','sub','secret-sub',1,0,456)");
  return { db, env };
}
function saveSnapshot(db: ReturnType<typeof createRealD1>, payload: unknown) {
  db.sql("INSERT INTO config_snapshots(id,name,snapshot_json,created_at) VALUES ('saved','saved',?,1)", JSON.stringify(payload));
}
function groupRefs(db: ReturnType<typeof createRealD1>) {
  return db.rows("SELECT device_id,token_id,service_group_id,position FROM token_routing_policy_groups ORDER BY device_id,token_id,position");
}
function expectedRefs(tokenIds = ["account", "sub1"]) {
  return tokenIds.flatMap(token_id => ["s2", "s1"].map((service_group_id, position) => ({ device_id: "d1", token_id, service_group_id, position })));
}

describe("routing metadata snapshot real SQLite roundtrip", () => {
  it("roundtrips stable identities, enabled/disabled aliases, nullable policies and ordered relational group references", async () => {
    const { db, env } = await setup();
    const input = fixture();
    const original = JSON.stringify(input);
    await restoreServiceGroupsSnapshot(env, input);
    const first = await snapshotServiceGroups(env);
    expect(first.routing_metadata!.identities).toEqual(input.routing_metadata!.identities);
    expect(first.routing_metadata!.aliases).toEqual(input.routing_metadata!.aliases);
    expect(first.routing_metadata!.policies).toHaveLength(3);
    for (const row of first.routing_metadata!.policies) {
      const saved = input.routing_metadata!.policies.find(p => p.token_id === row.token_id)!;
      expect(row).toMatchObject({ device_id: saved.device_id, token_id: saved.token_id, revision: saved.revision + 1 });
      expect(row.policy_json === null ? null : JSON.parse(row.policy_json)).toEqual(saved.policy_json === null ? null : JSON.parse(saved.policy_json));
      expect(row.updated_at).toBeGreaterThan(saved.updated_at);
    }
    expect(groupRefs(db)).toEqual(expectedRefs());
    db.sql("INSERT INTO public_model_identities(id,name,enabled) VALUES ('extra','unrelated',1)");
    db.sql("INSERT INTO service_model_aliases VALUES ('s1','extra-alias','map1',1)");
    db.sql("INSERT INTO token_routing_policies VALUES ('d2','account',NULL,90,1)");
    db.sql("INSERT INTO token_routing_policy_groups VALUES ('d2','account','s1',0)");
    await restoreServiceGroupsSnapshot(env, first);
    const second = await snapshotServiceGroups(env);
    expect(second.routing_metadata!.identities).toEqual(first.routing_metadata!.identities);
    expect(second.routing_metadata!.aliases).toEqual(first.routing_metadata!.aliases);
    expect(second.routing_metadata!.policies.map(({ revision, updated_at, ...rest }) => rest))
      .toEqual(first.routing_metadata!.policies.map(({ revision, updated_at, ...rest }) => rest));
    expect(second.routing_metadata!.policies.map(p => p.revision)).toEqual(first.routing_metadata!.policies.map(p => p.revision + 1));
    expect(groupRefs(db)).toEqual(expectedRefs());
    expect(JSON.stringify(input)).toBe(original);
    expect(JSON.stringify(second)).not.toContain("secret-");
    expect(JSON.stringify(second)).not.toContain("password-");
  });

  it("repo export/restore remaps model scopes and override keys without changing public/group identities or category names", async () => {
    const { db, env } = await setup();
    await restoreServiceGroupsSnapshot(env, fixture());
    await env.DB.batch(restoreModelCategoriesStatements(env, categories()));
    const saved = await createConfigSnapshot(env, "routing metadata");
    const exported = JSON.parse(saved.snapshot_json);
    expect(exported.service_groups_snapshot).toEqual(await snapshotServiceGroups(env));
    expect({ model_categories: exported.model_categories, model_category_bindings: exported.model_category_bindings }).toEqual(categories());
    db.sql("DELETE FROM models");
    db.sql("DELETE FROM providers");
    const result = await restoreConfigSnapshot(env, saved.id);
    expect(result.success, result.message).toBe(true);
    const remapped = new Map(db.rows<{ id: string; model_name: string }>("SELECT id,model_name FROM models").map(m => [m.model_name, m.id]));
    expect(remapped.size).toBe(2);
    expect(remapped.get("m1")).not.toBe("m1");
    expect(remapped.get("m2")).not.toBe("m2");
    const expectedPolicy = {
      ...policy(), model_scope: ["model:" + remapped.get("m1"), "model:" + remapped.get("m2"), "group:g1", "public:identity-direct"],
      model_overrides: { ["model:" + remapped.get("m1")]: "s1", ["model:" + remapped.get("m2")]: "s2", "group:g1": "s2", "public:identity-direct": "s1" },
    };
    const restored = await snapshotServiceGroups(env);
    for (const row of restored.routing_metadata!.policies) {
      expect(row.policy_json === null ? null : JSON.parse(row.policy_json)).toEqual(row.token_id === "master" ? null : expectedPolicy);
    }
    expect(restored.routing_metadata!.identities).toEqual(fixture().routing_metadata!.identities);
    expect(restored.routing_metadata!.aliases).toEqual(fixture().routing_metadata!.aliases);
    expect(restored.service_group_models[0].target_id).toBe(remapped.get("m1"));
    expect(restored.service_group_models[1].target_id).toBe("g1");
    expect(JSON.parse(restored.service_group_models[1].member_ids_json!)).toEqual([remapped.get("m1"), remapped.get("m2")]);
    expect(restored.model_group_members.map(m => m.model_id)).toEqual([remapped.get("m1"), remapped.get("m2")]);
    expect(groupRefs(db)).toEqual(expectedRefs());
    expect(await exportModelCategories(env)).toEqual(categories());
  });

  it("skips absent owners, missing sub-tokens and owner-mismatched sub-tokens without reviving accounts or credentials", async () => {
    const { db, env } = await setup();
    const input = fixture();
    input.routing_metadata!.policies.push(
      { ...input.routing_metadata!.policies[0], device_id: "missing-owner" },
      { ...input.routing_metadata!.policies[1], device_id: "missing-owner" },
      { ...input.routing_metadata!.policies[2], token_id: "missing-sub" },
      { ...input.routing_metadata!.policies[2], device_id: "d2" },
    );
    db.sql("UPDATE device_sub_tokens SET device_id='d2' WHERE id='sub1'");
    const accounts = db.rows("SELECT * FROM devices ORDER BY id");
    const sub = db.row("SELECT * FROM device_sub_tokens WHERE id='sub1'");
    await restoreServiceGroupsSnapshot(env, input);
    expect(db.rows("SELECT device_id,token_id FROM token_routing_policies ORDER BY device_id,token_id")).toEqual([
      { device_id: "d1", token_id: "account" }, { device_id: "d1", token_id: "master" }, { device_id: "d2", token_id: "sub1" },
    ]);
    expect(groupRefs(db)).toEqual([
      ...expectedRefs(["account"]),
      ...["s2", "s1"].map((service_group_id, position) => ({ device_id: "d2", token_id: "sub1", service_group_id, position })),
    ]);
    expect(db.row("SELECT * FROM device_sub_tokens WHERE id='sub1'")).toEqual(sub);
    expect(db.rows("SELECT * FROM devices ORDER BY id")).toEqual(accounts.map(row => row.id === "d1"
      ? { ...row, default_service_group_id: "s1", service_group_id: "s2" } : row));
  });

  it("invalidates effective account/master/sub-token policy versions on restoring a freshly captured snapshot", async () => {
    const { db, env } = await setup();
    await restoreServiceGroupsSnapshot(env, fixture());
    const device = db.row<DeviceRow>("SELECT * FROM devices WHERE id='d1'")!;
    const tokens = ["account", "master", "sub1"];
    const before = await Promise.all(tokens.map(token => resolveTokenRoutingPolicy(env, device, token)));
    const saved = await snapshotServiceGroups(env);
    await restoreServiceGroupsSnapshot(env, saved);
    const after = await Promise.all(tokens.map(token => resolveTokenRoutingPolicy(env, device, token)));
    for (let i = 0; i < tokens.length; i++) {
      expect(after[i].version).not.toBe(before[i].version);
      expect(after[i].policy).toEqual(before[i].policy);
    }
  });

  it("advances beyond newer live revisions while restoring an older policy body", async () => {
    const { db, env } = await setup();
    const historical = fixture();
    await restoreServiceGroupsSnapshot(env, historical);
    db.sql("UPDATE token_routing_policies SET revision=100,policy_json=NULL");
    const device = db.row<DeviceRow>("SELECT * FROM devices WHERE id='d1'")!;
    const before = await resolveTokenRoutingPolicy(env, device, "sub1");
    await restoreServiceGroupsSnapshot(env, historical);
    const after = await resolveTokenRoutingPolicy(env, device, "sub1");
    expect(after.version).not.toBe(before.version);
    expect(after.policy).toEqual(policy());
    expect(db.rows("SELECT revision FROM token_routing_policies ORDER BY token_id")).toEqual([
      { revision: 101 }, { revision: 101 }, { revision: 101 },
    ]);
    expect(groupRefs(db)).toEqual(expectedRefs());
  });

  it("preserves empty deny-all scope separately from unrestricted null scope and inherited null policy", async () => {
    const { db, env } = await setup();
    const input = fixture();
    input.routing_metadata!.policies[0].policy_json = JSON.stringify({ ...policy(), model_scope: [] });
    input.routing_metadata!.policies[2].policy_json = JSON.stringify({ ...policy(), model_scope: null });
    await restoreServiceGroupsSnapshot(env, input);
    const device = db.row<DeviceRow>("SELECT * FROM devices WHERE id='d1'")!;
    const master = await resolveTokenRoutingPolicy(env, device, "master");
    const sub = await resolveTokenRoutingPolicy(env, device, "sub1");
    expect(master.policy.model_scope).toEqual([]);
    expect(master.scope_layers).toEqual([[]]);
    expect(sub.policy.model_scope).toBeNull();
    expect(sub.scope_layers).toEqual([]);
    const saved = await snapshotServiceGroups(env);
    await restoreServiceGroupsSnapshot(env, saved);
    const restored = await snapshotServiceGroups(env);
    expect(restored.routing_metadata!.policies.map(p => p.policy_json)).toEqual(saved.routing_metadata!.policies.map(p => p.policy_json));
  });

  it("invalidates effective versions when the same historical snapshot is restored repeatedly", async () => {
    const { db, env } = await setup();
    const historical = fixture();
    await restoreServiceGroupsSnapshot(env, historical);
    const device = db.row<DeviceRow>("SELECT * FROM devices WHERE id='d1'")!;
    const before = await resolveTokenRoutingPolicy(env, device, "sub1");
    await restoreServiceGroupsSnapshot(env, historical);
    const after = await resolveTokenRoutingPolicy(env, device, "sub1");
    expect(after.version).not.toBe(before.version);
  });
});

describe("routing metadata snapshot validation", () => {
  const invalid: [string, (p: ServiceGroupsSnapshot) => void, string][] = [
    ["duplicate identity IDs", p => { p.routing_metadata!.identities[1].id = "identity-direct"; }, "Duplicate public identity IDs"],
    ["duplicate identity names", p => { p.routing_metadata!.identities[1].name = "direct"; }, "Duplicate public identity names"],
    ["duplicate aliases", p => { p.routing_metadata!.aliases.push({ ...p.routing_metadata!.aliases[0] }); }, "Duplicate aliases"],
    ["duplicate policies", p => { p.routing_metadata!.policies.push({ ...p.routing_metadata!.policies[0] }); }, "Duplicate token policies"],
    ["missing alias group", p => { p.routing_metadata!.aliases[0].service_group_id = "missing"; }, "Missing alias service group reference"],
    ["dangling enabled alias", p => { p.routing_metadata!.aliases[0].mapping_id = "missing"; }, "Missing alias mapping reference"],
    ["cross-group alias mapping", p => { p.routing_metadata!.aliases[0].mapping_id = "map2"; }, "Missing alias mapping reference"],
    ["alias canonical-name collision", p => { p.routing_metadata!.aliases[0].name = "direct"; p.routing_metadata!.aliases[0].mapping_id = "deleted"; p.routing_metadata!.aliases[0].enabled = 0; }, "Alias conflicts with canonical name"],
    ["missing policy group", p => { const value = policy(); value.group_ids = ["missing", "s1"]; value.model_overrides = {}; p.routing_metadata!.policies[0].policy_json = JSON.stringify(value); }, "Missing token policy group reference"],
    ["malformed policy JSON", p => { p.routing_metadata!.policies[0].policy_json = "{"; }, "Invalid routing policy"],
    ["override outside selected groups", p => { const value = policy(); value.model_overrides["model:m1"] = "missing"; p.routing_metadata!.policies[0].policy_json = JSON.stringify(value); }, "Invalid routing policy"],
    ["invalid policy revision", p => { p.routing_metadata!.policies[0].revision = 0; }, "greater than or equal to 1"],
    ["credential injection", p => { Object.assign(p.routing_metadata!.policies[0], { token_hash: "secret" }); }, "Unrecognized key"],
  ];
  it.each(invalid)("rejects %s before provider mutation or automatic backup", async (_label, mutate, message) => {
    const { db, env } = await setup();
    const input = fixture();
    mutate(input);
    expect(() => validateServiceGroupsSnapshot(input)).toThrow(message);
    const before = await snapshotServiceGroups(env);
    saveSnapshot(db, { providers: [{ id: "p1", name: "must-not-change" }], service_groups_snapshot: input });
    const result = await restoreConfigSnapshot(env, "saved");
    expect(result.success).toBe(false);
    expect(result.message).toContain(message);
    expect(db.row("SELECT name FROM providers WHERE id='p1'")).toEqual({ name: "provider" });
    expect(db.row("SELECT COUNT(*) AS count FROM config_snapshots")).toEqual({ count: 1 });
    expect(await snapshotServiceGroups(env)).toEqual(before);
  });
});

describe("routing metadata and model categories snapshot compatibility/atomicity", () => {
  it("keeps identities, aliases, policies, group references and categories when an older extension omits routing metadata and categories", async () => {
    const { db, env } = await setup();
    await restoreServiceGroupsSnapshot(env, fixture());
    await env.DB.batch(restoreModelCategoriesStatements(env, categories()));
    const before = await snapshotServiceGroups(env);
    const refs = groupRefs(db);
    const legacy = fixture();
    delete legacy.routing_metadata;
    saveSnapshot(db, { providers: [], models: [], service_groups_snapshot: legacy });
    const result = await restoreConfigSnapshot(env, "saved");
    expect(result.success, result.message).toBe(true);
    expect((await snapshotServiceGroups(env)).routing_metadata).toEqual(before.routing_metadata);
    expect(groupRefs(db)).toEqual(refs);
    expect(await exportModelCategories(env)).toEqual(categories());
  });

  it("keeps all routing configuration and categories when a legacy config snapshot has neither extension", async () => {
    const { db, env } = await setup();
    await restoreServiceGroupsSnapshot(env, fixture());
    await env.DB.batch(restoreModelCategoriesStatements(env, categories()));
    const before = await snapshotServiceGroups(env);
    const refs = groupRefs(db);
    saveSnapshot(db, { providers: [], models: [] });
    const result = await restoreConfigSnapshot(env, "saved");
    expect(result.success, result.message).toBe(true);
    expect(await snapshotServiceGroups(env)).toEqual(before);
    expect(groupRefs(db)).toEqual(refs);
    expect(await exportModelCategories(env)).toEqual(categories());
  });

  it.each(["model_categories", "model_category_bindings"])("rejects incomplete category metadata (%s only) before writes", async field => {
    const { db, env } = await setup();
    await restoreServiceGroupsSnapshot(env, fixture());
    await env.DB.batch(restoreModelCategoriesStatements(env, categories()));
    const before = await snapshotServiceGroups(env);
    const data = categories();
    saveSnapshot(db, { providers: [{ id: "p1", name: "must-not-change" }], service_groups_snapshot: fixture(), [field]: data[field as keyof ModelCategoriesBackup] });
    const result = await restoreConfigSnapshot(env, "saved");
    expect(result.success).toBe(false);
    expect(result.message).toContain("incomplete_model_categories_backup");
    expect(db.row("SELECT name FROM providers WHERE id='p1'")).toEqual({ name: "provider" });
    expect(db.row("SELECT COUNT(*) AS count FROM config_snapshots")).toEqual({ count: 1 });
    expect(await snapshotServiceGroups(env)).toEqual(before);
    expect(await exportModelCategories(env)).toEqual(data);
  });

  it("treats explicitly empty metadata/categories as replacement, unlike missing legacy fields", async () => {
    const { db, env } = await setup();
    await restoreServiceGroupsSnapshot(env, fixture());
    await env.DB.batch(restoreModelCategoriesStatements(env, categories()));
    const input = fixture();
    input.routing_metadata = { identities: [], aliases: [], policies: [] };
    saveSnapshot(db, { providers: [], models: [], service_groups_snapshot: input, model_categories: [], model_category_bindings: [] });
    const result = await restoreConfigSnapshot(env, "saved");
    expect(result.success, result.message).toBe(true);
    const restored = await snapshotServiceGroups(env);
    expect(restored.routing_metadata!.aliases).toEqual([]);
    expect(restored.routing_metadata!.policies).toEqual([]);
    expect(groupRefs(db)).toEqual([]);
    expect(restored.routing_metadata!.identities).toEqual([
      { id: expect.stringMatching(/^public_/), name: "direct", enabled: 1 },
      { id: expect.stringMatching(/^public_/), name: "pool", enabled: 1 },
    ]);
    expect(await exportModelCategories(env)).toEqual({ model_categories: [], model_category_bindings: [] });
  });

  it.each(["category", "category-binding", "mapping", "policy-group"])("rolls back service config, metadata, policy refs and categories on injected %s failure", async failure => {
    const { db, env } = await setup();
    await restoreServiceGroupsSnapshot(env, fixture());
    await env.DB.batch(restoreModelCategoriesStatements(env, categories()));
    const before = await snapshotServiceGroups(env);
    const refs = groupRefs(db);
    const credentials = db.rows("SELECT * FROM devices ORDER BY id");
    const sub = db.rows("SELECT * FROM device_sub_tokens ORDER BY id");
    const triggers = {
      category: "CREATE TRIGGER reject_category BEFORE INSERT ON model_categories BEGIN SELECT RAISE(ABORT,'injected category failure'); END",
      "category-binding": "CREATE TRIGGER reject_category_binding BEFORE INSERT ON model_category_bindings BEGIN SELECT RAISE(ABORT,'injected category-binding failure'); END",
      mapping: "CREATE TRIGGER reject_mapping BEFORE INSERT ON service_group_models BEGIN SELECT RAISE(ABORT,'injected mapping failure'); END",
      "policy-group": "CREATE TRIGGER reject_policy_group BEFORE INSERT ON token_routing_policy_groups BEGIN SELECT RAISE(ABORT,'injected policy-group failure'); END",
    };
    db.sql(triggers[failure as keyof typeof triggers]);
    const changed = fixture();
    changed.service_groups[0].name = "changed";
    changed.routing_metadata!.identities[0].enabled = 0;
    changed.routing_metadata!.aliases[0].enabled = 0;
    changed.device_service_group_selections[0].service_group_id = "s1";
    changed.sub_token_service_group_selections[0].service_group_id = "s2";
    saveSnapshot(db, { providers: [], models: [], service_groups_snapshot: changed, ...categories("new-name") });
    const result = await restoreConfigSnapshot(env, "saved");
    expect(result.success).toBe(false);
    expect(result.message).toContain("injected " + failure + " failure");
    expect(await snapshotServiceGroups(env)).toEqual(before);
    expect(groupRefs(db)).toEqual(refs);
    expect(await exportModelCategories(env)).toEqual(categories());
    expect(db.rows("SELECT * FROM devices ORDER BY id")).toEqual(credentials);
    expect(db.rows("SELECT * FROM device_sub_tokens ORDER BY id")).toEqual(sub);
  });
});
