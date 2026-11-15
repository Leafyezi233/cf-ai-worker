import { afterEach, describe, expect, it } from "vitest";
import { createConfigSnapshot, restoreConfigSnapshot } from "../src/db/repo";
import { ensureSchema } from "../src/db/schema";
import {
  restoreServiceGroupsSnapshot, snapshotServiceGroups, validateServiceGroupsSnapshot,
  type ServiceGroupsSnapshot,
} from "../src/db/service_group_snapshot";
import type { Env } from "../src/types";
import { createRealD1 } from "./helpers/realD1";

const prices = {
  input_price_per_m: 1, output_price_per_m: 2, cache_read_price_per_m: 0,
  cache_write_price_per_m: 0, price_per_call: 0, search_price_per_call: 0,
};
function fixture(): ServiceGroupsSnapshot {
  return {
    model_groups: [{ id: "g1", name: "pool", display_name: null, description: null,
      enabled: 1, model_public: 1, pricing_mode: "priced", ...prices, cache_enabled: 0,
      cache_ttl: 60, peak_pricing_enabled: 1, config_json: null, created_at: 1, updated_at: 2,
      billing_unit: "token" }],
    model_group_members: [{ group_id: "g1", model_id: "m1", position: 0, enabled: 1 },
      { group_id: "g1", model_id: "m2", position: 1, enabled: 0 }],
    model_price_windows: ["m1", "g1"].map((model_id, i) => ({ id: "w" + i, model_id,
      day_type: "weekday", start_minute: 60, end_minute: 120, multiplier: 2,
      enabled: 1, created_at: 1, updated_at: 2 })),
    device_model_groups: [{ device_id: "d1", group_id: "g1", rpm: 25 }],
    service_groups: [{ id: "s1", name: "standard", description: null, public_selectable: 1,
      selectable: 1, enabled: 1, multiplier: 1.5, revision: 3 }],
    service_group_models: [
      { id: "map1", service_group_id: "s1", model_key: "direct", target_type: "model",
        target_id: "m1", pricing_json: JSON.stringify(prices), member_ids_json: null },
      { id: "map2", service_group_id: "s1", model_key: "pool", target_type: "group",
        target_id: "g1", pricing_json: null, member_ids_json: JSON.stringify(["m1", "m2"]) },
    ],
    device_service_groups: [{ device_id: "d1", service_group_id: "s1" }],
    device_service_group_selections: [{ id: "d1", default_service_group_id: "s1", service_group_id: "s1" }],
    sub_token_service_group_selections: [{ id: "sub1", device_id: "d1", service_group_id: "s1" }],
  };
}

const databases: ReturnType<typeof createRealD1>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function setup() {
  const db = createRealD1();
  databases.push(db);
  const batches: string[][] = [];
  db.DB.batch = async (statements: Array<{ sql: string; all: () => Promise<unknown>; run: () => Promise<unknown> }>) => {
    batches.push(statements.map((s) => s.sql));
    db.sql("BEGIN");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await (/^\s*(SELECT|PRAGMA)\b/i.test(statement.sql) ? statement.all() : statement.run()));
      }
      db.sql("COMMIT");
      return results;
    } catch (error) {
      db.sql("ROLLBACK");
      throw error;
    }
  };
  const env = { DB: db.DB, ENCRYPTION_KEY: "snapshot-test-encryption-key" } as unknown as Env;
  await ensureSchema(env);
  db.sql("INSERT INTO providers (id, name, type) VALUES ('p1', 'provider', 'openai')");
  for (const id of ["m1", "m2"]) db.sql("INSERT INTO models (id, provider_id, model_name) VALUES (?, 'p1', ?)", id, id);
  for (const id of ["d1", "d2"]) db.sql("INSERT INTO devices (id, name, token_hash, password_hash, enabled, revoked_at) VALUES (?, ?, ?, ?, 0, 123)", id, id, "token-secret-" + id, "password-secret-" + id);
  db.sql("INSERT INTO device_sub_tokens (id, device_id, name, token_hash, created_at, enabled, revoked_at) VALUES ('sub1', 'd1', 'sub', 'sub-secret', 1, 0, 456)");
  db.sql("INSERT INTO device_wallets (device_id, balance_usd, reserved_usd, updated_at) VALUES ('d1', 99, 3, 1)");
  batches.length = 0;
  return { db, env, batches };
}
function saveSnapshot(db: ReturnType<typeof createRealD1>, payload: unknown) {
  db.sql("INSERT INTO config_snapshots (id, name, snapshot_json, created_at) VALUES ('saved', 'saved', ?, 1)", JSON.stringify(payload));
}

describe("service group snapshot pure validation", () => {
  it("accepts the reserved auto selection without requiring a real group", () => {
    const payload = fixture();
    payload.device_service_group_selections[0].default_service_group_id = "auto";
    payload.device_service_group_selections[0].service_group_id = "auto";
    payload.sub_token_service_group_selections[0].service_group_id = "auto";
    expect(validateServiceGroupsSnapshot(payload)).toEqual(payload);
  });
  it("accepts complete data without mutating the caller", () => {
    const payload = fixture();
    const before = JSON.stringify(payload);
    expect(validateServiceGroupsSnapshot(payload)).toEqual(payload);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it.each([
    ["unknown credential fields", (p: ServiceGroupsSnapshot) => Object.assign(p.device_service_group_selections[0], { token_hash: "secret" })],
    ["negative prices", (p: ServiceGroupsSnapshot) => { p.model_groups[0].input_price_per_m = -1; }],
    ["non-finite multipliers", (p: ServiceGroupsSnapshot) => { p.service_groups[0].multiplier = Infinity; }],
    ["invalid flags", (p: ServiceGroupsSnapshot) => { p.service_groups[0].enabled = 2 as 1; }],
    ["fractional positions", (p: ServiceGroupsSnapshot) => { p.model_group_members[0].position = 0.5; }],
    ["invalid window bounds", (p: ServiceGroupsSnapshot) => { p.model_price_windows[0].end_minute = 1441; }],
    ["duplicate group IDs", (p: ServiceGroupsSnapshot) => { p.model_groups.push({ ...p.model_groups[0], name: "other" }); }],
    ["duplicate memberships", (p: ServiceGroupsSnapshot) => { p.model_group_members.push({ ...p.model_group_members[0] }); }],
    ["duplicate mapping keys", (p: ServiceGroupsSnapshot) => { p.service_group_models.push({ ...p.service_group_models[0], id: "other" }); }],
    ["missing group references", (p: ServiceGroupsSnapshot) => { p.model_group_members[0].group_id = "missing"; }],
    ["missing mapping service", (p: ServiceGroupsSnapshot) => { p.service_group_models[0].service_group_id = "missing"; }],
    ["missing mapping target group", (p: ServiceGroupsSnapshot) => { p.service_group_models[1].target_id = "missing"; }],
    ["missing default selection", (p: ServiceGroupsSnapshot) => { p.device_service_group_selections[0].default_service_group_id = "missing"; }],
    ["missing sub-token selection", (p: ServiceGroupsSnapshot) => { p.sub_token_service_group_selections[0].service_group_id = "missing"; }],
    ["malformed pricing JSON", (p: ServiceGroupsSnapshot) => { p.service_group_models[0].pricing_json = "{"; }],
    ["extra pricing JSON keys", (p: ServiceGroupsSnapshot) => { p.service_group_models[0].pricing_json = JSON.stringify({ ...prices, secret: "x" }); }],
    ["duplicate selected members", (p: ServiceGroupsSnapshot) => { p.service_group_models[1].member_ids_json = '["m1","m1"]'; }],
    ["empty selected members", (p: ServiceGroupsSnapshot) => { p.service_group_models[1].member_ids_json = "[]"; }],
  ])("rejects %s", (_label, change) => {
    const payload = fixture();
    change(payload);
    expect(() => validateServiceGroupsSnapshot(payload)).toThrow();
  });
});

describe("service group snapshot SQLite integration", () => {
  it("selects only allowlisted credential columns in one read batch and exports no account secrets", async () => {
    const { db, env, batches } = await setup();
    await restoreServiceGroupsSnapshot(env, fixture());
    batches.length = 0;
    const payload = await snapshotServiceGroups(env);
    const expected = fixture();
    expected.device_service_group_selections.push({ id: "d2", default_service_group_id: null, service_group_id: null });
    expected.routing_metadata = {
      identities: [{ id: expect.stringMatching(/^public_/), name: "direct", enabled: 1 }, { id: expect.stringMatching(/^public_/), name: "pool", enabled: 1 }],
      aliases: [], policies: [],
    };
    expect(payload).toEqual(expected);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(12);
    expect(batches[0].filter((sql) => /FROM (devices|device_sub_tokens) /.test(sql))).toEqual([
      "SELECT id, default_service_group_id, service_group_id FROM devices ORDER BY id",
      "SELECT id, device_id, service_group_id FROM device_sub_tokens ORDER BY id",
    ]);
    const json = JSON.stringify(payload);
    for (const secret of ["token_hash", "password_hash", "token-secret", "password-secret", "sub-secret", "balance_usd", "revoked_at"]) expect(json).not.toContain(secret);
    expect(db.row("SELECT balance_usd FROM device_wallets WHERE device_id = 'd1'")).toEqual({ balance_usd: 99 });
  });

  it.each(["auto", "legacy"])("round-trips explicit %s selections without changing wallet state", async (selection) => {
    const { db, env } = await setup();
    const payload = fixture();
    payload.device_service_group_selections[0].default_service_group_id = selection;
    payload.device_service_group_selections[0].service_group_id = selection;
    payload.sub_token_service_group_selections[0].service_group_id = selection;
    const wallet = db.row("SELECT * FROM device_wallets WHERE device_id = 'd1'");
    await restoreServiceGroupsSnapshot(env, payload);
    const saved = await snapshotServiceGroups(env);
    expect(saved.device_service_group_selections.find((row) => row.id === "d1")).toEqual(payload.device_service_group_selections[0]);
    expect(saved.sub_token_service_group_selections).toEqual(payload.sub_token_service_group_selections);
    expect(db.row("SELECT * FROM device_wallets WHERE device_id = 'd1'")).toEqual(wallet);
  });

  it("remaps model IDs everywhere but preserves group IDs and selected member order", async () => {
    const { db, env, batches } = await setup();
    db.sql("UPDATE models SET id = 'new1' WHERE id = 'm1'");
    db.sql("UPDATE models SET id = 'new2' WHERE id = 'm2'");
    const payload = fixture();
    await restoreServiceGroupsSnapshot(env, payload, new Map([["m1", "new1"], ["m2", "new2"], ["g1", "not-a-group"]]));
    expect(db.rows("SELECT group_id, model_id, enabled FROM model_group_members ORDER BY position")).toEqual([
      { group_id: "g1", model_id: "new1", enabled: 1 }, { group_id: "g1", model_id: "new2", enabled: 0 },
    ]);
    expect(db.rows("SELECT model_id FROM price_windows ORDER BY id")).toEqual([{ model_id: "new1" }, { model_id: "g1" }]);
    expect(db.rows("SELECT target_id, member_ids_json FROM service_group_models ORDER BY id")).toEqual([
      { target_id: "new1", member_ids_json: null }, { target_id: "g1", member_ids_json: '["new1","new2"]' },
    ]);
    expect(payload).toEqual(fixture());
    const writes = batches.filter((batch) => batch.some((sql) => /^UPDATE devices SET default_service_group_id = NULL/.test(sql)));
    expect(writes).toHaveLength(1);
    expect(writes[0].filter((sql) => sql.startsWith("DELETE FROM"))).toHaveLength(7);
    expect(writes[0].some((sql) => sql.startsWith("INSERT INTO service_group_models"))).toBe(true);
  });

  it("restores selections only for existing credentials with matching owners, without restoring accounts", async () => {
    const { db, env } = await setup();
    const accounts = db.rows("SELECT * FROM devices ORDER BY id");
    const sub = db.row("SELECT * FROM device_sub_tokens WHERE id = 'sub1'");
    const wallet = db.row("SELECT * FROM device_wallets WHERE device_id = 'd1'");
    const payload = fixture();
    payload.device_service_group_selections.push({ id: "deleted", default_service_group_id: "s1", service_group_id: "s1" });
    payload.device_service_groups.push({ device_id: "deleted", service_group_id: "s1" });
    payload.device_model_groups.push({ device_id: "deleted", group_id: "g1", rpm: 1 });
    payload.sub_token_service_group_selections.push({ id: "deleted", device_id: "d1", service_group_id: "s1" });
    await restoreServiceGroupsSnapshot(env, payload);
    expect(db.rows("SELECT * FROM devices ORDER BY id")).toEqual(accounts.map((a) => a.id === "d1" ? { ...a, default_service_group_id: "s1", service_group_id: "s1" } : a));
    expect(db.row("SELECT * FROM device_sub_tokens WHERE id = 'sub1'")).toEqual({ ...sub, service_group_id: "s1" });
    expect(db.row("SELECT * FROM device_wallets WHERE device_id = 'd1'")).toEqual(wallet);
    expect(db.rows("SELECT device_id FROM device_service_groups")).toEqual([{ device_id: "d1" }]);
    expect(db.rows("SELECT device_id FROM device_model_groups")).toEqual([{ device_id: "d1" }]);
    db.sql("UPDATE device_sub_tokens SET device_id = 'd2' WHERE id = 'sub1'");
    await restoreServiceGroupsSnapshot(env, payload);
    expect(db.row("SELECT device_id, token_hash, enabled, revoked_at, service_group_id FROM device_sub_tokens WHERE id = 'sub1'")).toEqual({
      device_id: "d2", token_hash: "sub-secret", enabled: 0, revoked_at: 456, service_group_id: null,
    });
    expect(db.rows("SELECT id FROM devices ORDER BY id")).toEqual([{ id: "d1" }, { id: "d2" }]);
  });

  it("rejects missing model references and remap collisions before destructive writes", async () => {
    const { db, env, batches } = await setup();
    await restoreServiceGroupsSnapshot(env, fixture());
    const before = await snapshotServiceGroups(env);
    batches.length = 0;
    const payload = fixture();
    payload.model_group_members[0].model_id = "missing";
    await expect(restoreServiceGroupsSnapshot(env, payload)).rejects.toThrow("Missing member model reference: missing");
    const collision = fixture();
    collision.service_group_models[1].member_ids_json = null;
    await expect(restoreServiceGroupsSnapshot(env, collision, new Map([["m2", "m1"]]))).rejects.toThrow("Duplicate model group members");
    await expect(restoreServiceGroupsSnapshot(env, fixture(), new Map([["m2", "m1"]]))).rejects.toThrow("Invalid JSON value");
    expect(batches.every((batch) => batch.every((sql) => sql.startsWith("SELECT")))).toBe(true);
    expect(await snapshotServiceGroups(env)).toEqual(before);
    expect(db.row("SELECT service_group_id FROM devices WHERE id = 'd1'")).toEqual({ service_group_id: "s1" });
  });

  it("rolls back the complete replacement when an insert in the write batch fails", async () => {
    const { db, env } = await setup();
    await restoreServiceGroupsSnapshot(env, fixture());
    const before = await snapshotServiceGroups(env);
    db.sql("CREATE TRIGGER reject_snapshot_mapping BEFORE INSERT ON service_group_models BEGIN SELECT RAISE(ABORT, 'injected snapshot insert failure'); END");
    const payload = fixture();
    payload.service_groups[0].name = "changed";
    await expect(restoreServiceGroupsSnapshot(env, payload)).rejects.toThrow("injected snapshot insert failure");
    expect(await snapshotServiceGroups(env)).toEqual(before);
  });

  it("embeds the extension and restores references to newly created model IDs through repo integration", async () => {
    const { db, env } = await setup();
    await restoreServiceGroupsSnapshot(env, fixture());
    const saved = await createConfigSnapshot(env, "integrated");
    expect(JSON.parse(saved.snapshot_json).service_groups_snapshot).toEqual(await snapshotServiceGroups(env));
    db.sql("DELETE FROM models");
    db.sql("DELETE FROM providers");
    const result = await restoreConfigSnapshot(env, saved.id);
    expect(result.success, result.message).toBe(true);
    const models = db.rows<{ id: string; model_name: string; provider_id: string }>("SELECT id, model_name, provider_id FROM models");
    expect(models).toHaveLength(2);
    const restored = new Map(models.map((m) => [m.model_name, m.id]));
    expect(restored.get("m1")).not.toBe("m1");
    expect(db.row("SELECT model_id FROM model_group_members WHERE position = 0")).toEqual({ model_id: restored.get("m1") });
    expect(db.row("SELECT target_id FROM service_group_models WHERE id = 'map1'")).toEqual({ target_id: restored.get("m1") });
    expect(JSON.parse(db.row<{ member_ids_json: string }>("SELECT member_ids_json FROM service_group_models WHERE id = 'map2'")!.member_ids_json)).toEqual([restored.get("m1"), restored.get("m2")]);
    expect(db.row("SELECT id FROM providers")!.id).toBe(models[0].provider_id);
    expect(db.row("SELECT service_group_id FROM device_sub_tokens WHERE id = 'sub1'")).toEqual({ service_group_id: "s1" });
  });

  it("preflights malformed extensions before provider updates or automatic backup", async () => {
    const { db, env } = await setup();
    const extension = fixture();
    extension.service_group_models[0].target_type = "invalid" as "model";
    saveSnapshot(db, { providers: [{ id: "p1", name: "must-not-change" }], service_groups_snapshot: extension });
    const result = await restoreConfigSnapshot(env, "saved");
    expect(result.success).toBe(false);
    expect(result.message).toContain("target_type");
    expect(db.row("SELECT name FROM providers WHERE id = 'p1'")).toEqual({ name: "provider" });
    expect(db.row("SELECT COUNT(*) AS count FROM config_snapshots")).toEqual({ count: 1 });
  });

  it("restores legacy snapshots without clearing existing group configuration or credential selections", async () => {
    const { db, env } = await setup();
    await restoreServiceGroupsSnapshot(env, fixture());
    const before = await snapshotServiceGroups(env);
    saveSnapshot(db, { providers: [], models: [], settings: { budget_config: { enabled: true } } });
    const result = await restoreConfigSnapshot(env, "saved");
    expect(result.success, result.message).toBe(true);
    expect(await snapshotServiceGroups(env)).toEqual(before);
    expect(db.row("SELECT COUNT(*) AS count FROM config_snapshots")).toEqual({ count: 2 });
    expect(db.row<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'budget_config'")!.value_json).toContain('"enabled":true');
  });
});
