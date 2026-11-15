import { afterEach, describe, expect, it, vi } from "vitest";
import { modelGroupMergeApp } from "../src/admin/model-group-merge";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedProvider, seedModel, seedGroup, seedGroupMembers, seedDevice } from "./helpers/realGatewayEnv";
import { DEFAULT_ROUTING_POLICY } from "../src/db/token_policies";
import { resolveServiceRoute } from "../src/gateway/service_groups";
import { getDeviceById } from "../src/db/repo";
import type { Env } from "../src/types";

const opened: RealD1[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); vi.restoreAllMocks(); });
const selection = { source_id: "source", target_id: "target", legacy_action: "disable" };
const priceKeys = ["input_price_per_m", "output_price_per_m", "cache_read_price_per_m", "cache_write_price_per_m", "price_per_call", "search_price_per_call"];
function fixture() {
  const db = createRealD1(); opened.push(db);
  seedProvider(db);
  seedModel(db, { id: "member_s", model_name: "upstream-s" });
  seedModel(db, { id: "member_t", model_name: "upstream-t" });
  seedGroup(db, { id: "source", name: "source-legacy", input_price_per_m: 9, output_price_per_m: 45, cache_read_price_per_m: 2, cache_write_price_per_m: 3, search_price_per_call: 0.3 });
  seedGroup(db, { id: "target", name: "target-legacy", input_price_per_m: 1, output_price_per_m: 5, cache_read_price_per_m: 0.2, cache_write_price_per_m: 0.4, search_price_per_call: 0.1 });
  seedGroupMembers(db, "source", ["member_s"]); seedGroupMembers(db, "target", ["member_t"]);
  db.sql("INSERT INTO service_groups(id,name,multiplier,revision) VALUES('svc_s','source service',2,1),('svc_t','target service',3,1)");
  db.sql("INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id) VALUES('map_s','svc_s','public-model','group','source'),('map_t','svc_t','public-model','group','target')");
  db.sql("INSERT INTO public_model_identities(id,name,enabled) VALUES('identity','public-model',1)");
  db.sql("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES('svc_s','old-public','map_s',1),('svc_t','old-public','map_t',0)");
  return { db, env: makeEnv(db) };
}
async function post(env: Env, path: string, body: unknown) {
  return modelGroupMergeApp.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
}
async function preview(env: Env, input = selection) {
  const res = await post(env, "/preview", input);
  expect(res.status).toBe(200);
  return res.json() as Promise<any>;
}
async function commit(env: Env, fingerprint: string, input = selection, extra = {}) {
  return post(env, "/commit", { ...input, fingerprint, confirm_prices: true, confirm_permissions: true, ...extra });
}
function durable(db: RealD1) {
  return {
    groups: db.rows("SELECT * FROM model_groups ORDER BY id"),
    members: db.rows("SELECT * FROM model_group_members ORDER BY group_id,position,model_id"),
    mappings: db.rows("SELECT * FROM service_group_models ORDER BY id"),
    services: db.rows("SELECT * FROM service_groups ORDER BY id"),
    aliases: db.rows("SELECT * FROM service_model_aliases ORDER BY name,service_group_id"),
    identities: db.rows("SELECT * FROM public_model_identities ORDER BY id"),
    guards: db.rows("SELECT * FROM public_model_write_guards"),
  };
}

describe("model-group internal-pool merge (real SQLite)", () => {
  it("preview is strictly read-only, lists quotes/aliases/policies, never returns credentials", async () => {
    const { db, env } = fixture();
    const before = durable(db);
    const batch = vi.spyOn(env.DB, "batch"), prepare = vi.spyOn(env.DB, "prepare");
    const p = await preview(env);
    expect(p.can_commit).toBe(true);
    expect(p.references.mappings).toHaveLength(2); expect(p.references.aliases).toHaveLength(2);
    expect(p.references.identities).toEqual([{ id: "identity", name: "public-model", enabled: 1 }]);
    expect(p.comparison.source.prices.input_price_per_m).toBe(9); expect(p.comparison.target.prices.input_price_per_m).toBe(1);
    expect(p.comparison.merged_members.map((row: any) => row.model_id)).toEqual(["member_t", "member_s"]);
    expect(JSON.stringify(p)).not.toContain("sk-a"); expect(JSON.stringify(p)).not.toContain("provider_api_key");
    expect(batch).not.toHaveBeenCalled();
    expect(prepare.mock.calls.every(([sql]) => /^PRAGMA|^WITH/.test(String(sql)))).toBe(true);
    expect(durable(db)).toEqual(before);
  });

  it.each([false, true])("preserves independent full quotes with same prices=%s; no cheapest-price collapse", async same => {
    const { db, env } = fixture();
    if (same) db.sql("UPDATE model_groups SET input_price_per_m=9,output_price_per_m=45,cache_read_price_per_m=2,cache_write_price_per_m=3,search_price_per_call=0.3 WHERE id='target'");
    const before = durable(db), p = await preview(env);
    expect(p.can_commit).toBe(true);
    const batch = vi.spyOn(env.DB, "batch");
    expect((await commit(env, p.fingerprint)).status).toBe(200);
    expect(batch).toHaveBeenCalledTimes(1);
    const s = db.row<any>("SELECT * FROM service_group_models WHERE id='map_s'")!;
    expect(s).toMatchObject({ id: "map_s", target_id: "target", model_key: "public-model", service_group_id: "svc_s" });
    expect(JSON.parse(s.pricing_json)).toEqual({ input_price_per_m: 18, output_price_per_m: 90, cache_read_price_per_m: 4, cache_write_price_per_m: 6, price_per_call: 0, search_price_per_call: 0.3 });
    const t = db.row<any>("SELECT * FROM service_group_models WHERE id='map_t'")!;
    expect(t).toEqual(before.mappings.find(row => row.id === "map_t"));
    expect(durable(db).aliases).toEqual(before.aliases); expect(durable(db).identities).toEqual(before.identities);
    expect(db.row("SELECT enabled FROM model_groups WHERE id='source'")).toEqual({ enabled: 0 });
    expect(db.rows("SELECT model_id FROM model_group_members WHERE group_id='source'")).toEqual([{ model_id: "member_s" }]);
    expect(db.rows("SELECT model_id FROM model_group_members WHERE group_id='target' ORDER BY position")).toEqual([{ model_id: "member_t" }, { model_id: "member_s" }]);
    expect(db.rows("SELECT * FROM public_model_write_guards")).toEqual([]);
    db.sql("UPDATE model_groups SET input_price_per_m=0.001 WHERE id='target'");
    expect(JSON.parse(db.row<any>("SELECT pricing_json FROM service_group_models WHERE id='map_s'")!.pricing_json).input_price_per_m).toBe(18);
  });

  it("freezes partial source overrides completely, preserving unknown price metadata and explicit member selection", async () => {
    const { db, env } = fixture();
    const explicit = JSON.stringify({ input_price_per_m: 7, custom_note: "separate quote" });
    db.sql(`UPDATE service_group_models SET pricing_json=?,member_ids_json='["member_s"]' WHERE id='map_s'`, explicit);
    db.sql(`UPDATE service_group_models SET pricing_json='{"input_price_per_m":100}' WHERE id='map_t'`);
    const p = await preview(env);
    expect((await commit(env, p.fingerprint)).status).toBe(200);
    const s = db.row<any>("SELECT * FROM service_group_models WHERE id='map_s'")!;
    expect(JSON.parse(s.pricing_json)).toEqual({ input_price_per_m: 7, output_price_per_m: 45, cache_read_price_per_m: 2, cache_write_price_per_m: 3, price_per_call: 0, search_price_per_call: 0.3, custom_note: "separate quote" });
    expect(s.member_ids_json).toBe('["member_s"]');
    expect(db.row<any>("SELECT pricing_json FROM service_group_models WHERE id='map_t'")!.pricing_json).toBe('{"input_price_per_m":100}');
  });

  it.each(["null", "[]", "false", '"not-an-object"'])("refuses invalid explicit pricing JSON %s rather than silently enabling its mapping", async price => {
    const { db, env } = fixture();
    db.sql("UPDATE service_group_models SET pricing_json=? WHERE id='map_s'", price);
    const before = durable(db), p = await preview(env);
    expect(p.can_commit).toBe(false);
    expect(p.blockers).toContainEqual(expect.objectContaining({ code: "invalid_mapping" }));
    expect((await commit(env, p.fingerprint)).status).toBe(409);
    expect(durable(db)).toEqual(before);
  });

  it("preserves actual service-route prices, stable public scope and account grants without paid dispatch", async () => {
    const { db, env } = fixture();
    await seedDevice(db);
    db.sql("UPDATE devices SET default_service_group_id='svc_s' WHERE id='dev_1'");
    db.sql("INSERT INTO device_service_groups(device_id,service_group_id) VALUES('dev_1','svc_s')");
    const device = (await getDeviceById(env, "dev_1"))!;
    const beforeRoute = (await resolveServiceRoute(env, device, "public-model"))!;
    const permissions = db.rows("SELECT * FROM device_service_groups");
    const p = await preview(env);
    expect(p.can_commit).toBe(true);
    expect((await commit(env, p.fingerprint)).status).toBe(200);
    const afterRoute = (await resolveServiceRoute(env, device, "public-model"))!;
    for (const key of priceKeys) expect((afterRoute.billingRow as any)[key]).toBe((beforeRoute.billingRow as any)[key]);
    expect(afterRoute.mapping.id).toBe(beforeRoute.mapping.id); expect(afterRoute.members.map(row => row.id)).toEqual(["member_t", "member_s"]);
    expect(db.rows("SELECT * FROM device_service_groups")).toEqual(permissions);
  });

  it("explicit retain preserves source shell prices while visibly changing its member pool", async () => {
    const { db, env } = fixture();
    const input = { ...selection, legacy_action: "retain" }, before = db.row<any>("SELECT * FROM model_groups WHERE id='source'")!;
    const p = await preview(env, input);
    expect(p.legacy).toMatchObject({ pool_changes: true, source_remains: true }); expect(p.legacy.description).toContain("合并后");
    expect((await commit(env, p.fingerprint, input)).status).toBe(200);
    const after = db.row<any>("SELECT * FROM model_groups WHERE id='source'")!;
    expect(after.enabled).toBe(1); for (const key of priceKeys) expect(after[key]).toBe(before[key]);
    expect(db.rows("SELECT model_id FROM model_group_members WHERE group_id='source' ORDER BY position")).toEqual([{ model_id: "member_t" }, { model_id: "member_s" }]);
  });

  it("requires explicit old-name choice and separate price/permission confirmation; fingerprint binds choice", async () => {
    const { db, env } = fixture();
    expect((await post(env, "/preview", { source_id: "source", target_id: "target" })).status).toBe(400);
    const before = durable(db), p = await preview(env);
    expect((await commit(env, p.fingerprint, selection, { confirm_prices: false })).status).toBe(400);
    expect((await commit(env, p.fingerprint, selection, { confirm_permissions: false })).status).toBe(400);
    expect((await commit(env, p.fingerprint, { ...selection, legacy_action: "retain" })).status).toBe(409);
    expect(durable(db)).toEqual(before);
  });

  it.each(["source", "target"])("blocks %s device-only permissions instead of widening access", async group => {
    const { db, env } = fixture();
    db.sql("INSERT INTO device_model_groups(device_id,group_id,rpm) VALUES('disabled-or-orphan-account',?,8)", group);
    const before = durable(db), p = await preview(env);
    expect(p.can_commit).toBe(false); expect(p.blockers).toContainEqual(expect.objectContaining({ code: "device_group_reference" }));
    expect((await commit(env, p.fingerprint)).status).toBe(409); expect(durable(db)).toEqual(before);
    expect(db.rows("SELECT group_id FROM device_model_groups")).toEqual([{ group_id: group }]);
  });

  it("blocks template references, including orphan templates", async () => {
    const { db, env } = fixture();
    db.sql("INSERT INTO device_template_groups(template_id,group_id,rpm) VALUES('orphan-template','source',0)");
    const p = await preview(env); expect(p.can_commit).toBe(false);
    expect(p.blockers).toContainEqual(expect.objectContaining({ code: "template_group_reference" }));
    expect((await commit(env, p.fingerprint)).status).toBe(409);
  });

  it.each(["group:source", "group:target"])("blocks direct token model-scope %s without rewriting or granting", async key => {
    const { db, env } = fixture();
    const policy = JSON.stringify({ ...DEFAULT_ROUTING_POLICY, model_scope: [key] });
    db.sql("INSERT INTO token_routing_policies(device_id,token_id,policy_json,updated_at) VALUES('account','subtoken',?,1)", policy);
    const p = await preview(env); expect(p.can_commit).toBe(false);
    expect(p.blockers).toContainEqual(expect.objectContaining({ code: "policy_group_reference" }));
    expect((await commit(env, p.fingerprint)).status).toBe(409);
    expect(db.row<any>("SELECT policy_json FROM token_routing_policies")!.policy_json).toBe(policy);
  });

  it("keeps public stable-ID policies and null inherited policies exactly unchanged", async () => {
    const { db, env } = fixture();
    const policy = JSON.stringify({ ...DEFAULT_ROUTING_POLICY, mode: "multi", group_ids: ["svc_s", "svc_t"], model_scope: ["public:identity"], model_overrides: { "public:identity": "svc_s" } });
    db.sql("INSERT INTO token_routing_policies(device_id,token_id,policy_json,updated_at) VALUES('account','subtoken',?,1),('account','master',NULL,1)", policy);
    const before = db.rows("SELECT * FROM token_routing_policies ORDER BY token_id");
    const p = await preview(env); expect(p.can_commit).toBe(true); expect(p.references.policies).toHaveLength(2);
    expect((await commit(env, p.fingerprint)).status).toBe(200);
    expect(db.rows("SELECT * FROM token_routing_policies ORDER BY token_id")).toEqual(before);
  });

  it.each([
    ["mixed billing unit", `UPDATE model_groups SET billing_unit='call' WHERE id='source'`, "unit_mismatch"],
    ["rewrite", `UPDATE model_groups SET config_json='{"model_rewrite":"other-model"}' WHERE id='source'`, "configuration_mismatch"],
    ["pricing mode", `UPDATE model_groups SET pricing_mode='free' WHERE id='source'`, "mode_mismatch"],
    ["public access", `UPDATE model_groups SET model_public=0 WHERE id='source'`, "configuration_mismatch"],
    ["context capability", `UPDATE models SET config_json='{"context_window":8192}' WHERE id='member_s'`, "capability_mismatch"],
    ["disabled member unit", `UPDATE models SET billing_unit='call',enabled=0 WHERE id='member_s'`, "unit_mismatch"],
    ["malformed member config", "UPDATE models SET config_json='{' WHERE id='member_s'", "invalid_member"],
  ])("refuses incompatible %s", async (_name, sql, code) => {
    const { db, env } = fixture(); db.sql(sql);
    const before = durable(db), p = await preview(env);
    expect(p.can_commit).toBe(false); expect(p.blockers).toContainEqual(expect.objectContaining({ code }));
    expect((await commit(env, p.fingerprint)).status).toBe(409); expect(durable(db)).toEqual(before);
  });

  it("refuses same-dimension embeddings with different vector spaces", async () => {
    const { db, env } = fixture();
    const cfg = (space: string) => JSON.stringify({ model_type: "embedding", embedding_profile: { compatibility_key: space, dimensions: 1024 } });
    db.sql("UPDATE model_groups SET config_json=?", cfg("space-a"));
    db.sql("UPDATE models SET config_json=? WHERE id='member_s'", cfg("space-a"));
    db.sql("UPDATE models SET config_json=? WHERE id='member_t'", cfg("space-b"));
    const p = await preview(env); expect(p.can_commit).toBe(false);
    expect(p.blockers).toContainEqual(expect.objectContaining({ code: "incompatible_pool", message: "embedding_compatibility_required" }));
    expect((await commit(env, p.fingerprint)).status).toBe(409);
  });

  it("refuses incompatible video generation sizes rather than silently reducing capabilities", async () => {
    const { db, env } = fixture();
    const cfg = (sizes: string[]) => JSON.stringify({ model_type: "video", video: { adapter: "moyuu", task_id_path: "id", sizes, seconds_min: 3, seconds_max: 10 } });
    db.sql("UPDATE model_groups SET billing_unit='call',input_price_per_m=0,output_price_per_m=0,cache_read_price_per_m=0,cache_write_price_per_m=0,search_price_per_call=0,price_per_call=2,config_json=?", cfg(["1280x720"]));
    db.sql("UPDATE models SET billing_unit='call',input_price_per_m=0,output_price_per_m=0,config_json=?", cfg(["1280x720"]));
    db.sql("UPDATE models SET config_json=? WHERE id='member_t'", cfg(["720x1280"]));
    const p = await preview(env); expect(p.can_commit).toBe(false);
    expect(p.blockers).toContainEqual(expect.objectContaining({ code: "incompatible_pool", message: "incompatible_video_member" }));
    expect((await commit(env, p.fingerprint)).status).toBe(409);
  });

  it.each([
    ["repricing", `UPDATE model_groups SET output_price_per_m=100 WHERE id='source'`],
    ["revocation", "DELETE FROM device_service_groups WHERE service_group_id='svc_s'"],
    ["new reference", `INSERT INTO device_model_groups(device_id,group_id,rpm) VALUES('new-account','target',0)`],
    ["new alias", `INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES('svc_s','late-alias','map_s',1)`],
    ["new orphan alias reservation", `INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES('svc_s','reserved-name','missing-mapping',0)`],
    ["provider rewrite configuration", `UPDATE providers SET endpoint='https://changed.invalid'`],
    ["new scope", `INSERT INTO token_routing_policies(device_id,token_id,policy_json,updated_at) VALUES('new-account','master','{"mode":"auto","group_ids":[],"model_scope":["group:source"]}',1)`],
  ])("batch-time %s race fails CHECK and leaves all merge writes rolled back", async (_name, mutation) => {
    const { db, env } = fixture();
    db.sql("INSERT INTO device_service_groups(device_id,service_group_id) VALUES('account','svc_s')");
    const p = await preview(env); expect(p.can_commit).toBe(true);
    const originalBatch = env.DB.batch.bind(env.DB);
    const before = durable(db);
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements: D1PreparedStatement[]) => { db.sql(mutation); return originalBatch(statements); });
    const res = await commit(env, p.fingerprint);
    expect(res.status).toBe(409);
    const after = durable(db);
    expect(after.members).toEqual(before.members); expect(after.mappings).toEqual(before.mappings); expect(after.services).toEqual(before.services);
    expect(after.guards).toEqual([]); expect(db.row<any>("SELECT enabled FROM model_groups WHERE id='source'")!.enabled).toBe(1);
    if (_name !== "repricing") expect(after.groups).toEqual(before.groups);
  });

  it("a late write error after member/mapping changes rolls the entire real SQLite batch back", async () => {
    const { db, env } = fixture();
    const p = await preview(env), before = durable(db);
    db.sql("CREATE TRIGGER reject_merge_revision BEFORE UPDATE OF revision ON service_groups BEGIN SELECT RAISE(ABORT,'injected-late-write-failure'); END");
    const res = await commit(env, p.fingerprint); expect(res.status).toBe(409); expect(durable(db)).toEqual(before);
  });

  it("pre-commit stale snapshots reject without any write batch and cannot be replayed", async () => {
    const { db, env } = fixture();
    const p = await preview(env);
    db.sql("UPDATE service_groups SET multiplier=9 WHERE id='svc_s'");
    const batch = vi.spyOn(env.DB, "batch");
    expect((await commit(env, p.fingerprint)).status).toBe(409); expect(batch).not.toHaveBeenCalled();
    const fresh = await preview(env); expect((await commit(env, fresh.fingerprint)).status).toBe(200);
    expect((await commit(env, fresh.fingerprint)).status).toBe(409); expect(db.rows("SELECT * FROM public_model_write_guards")).toEqual([]);
  });
});
