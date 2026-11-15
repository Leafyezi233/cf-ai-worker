import { afterEach, describe, expect, it } from "vitest";
import {
  applyDeviceTemplate, createDeviceTemplate, createModel, createModelGroup,
  getDeviceTemplate, replaceDeviceModelGroups, replaceDeviceModels,
  replaceDeviceTemplateGroups, replaceDeviceTemplateModels, replaceModelGroupMembers,
  updateDeviceTemplate, updateModel, updateModelGroup,
} from "../src/db/repo";
import type { Env, DeviceRow } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedDevice, seedGroup, seedGroupMembers, seedModel, seedProvider } from "./helpers/realGatewayEnv";

const databases: RealD1[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function fixture() {
  const db = createRealD1(); databases.push(db);
  seedProvider(db);
  seedModel(db);
  seedModel(db, { id: "model_b", model_name: "second", enabled: 0 });
  seedGroup(db);
  seedGroup(db, { id: "grp_b", name: "second-group", enabled: 0 });
  await seedDevice(db, { model_scope: "all" });
  await seedDevice(db, { id: "dev_2", token_hash: "other-device", model_scope: "all" });
  db.sql("INSERT INTO device_templates (id, name, model_scope, created_at, updated_at) VALUES ('tpl', 'original', 'list', 1, 1)");
  db.sql("INSERT INTO device_template_models (template_id, model_id, rpm) VALUES ('tpl', 'model_a', 3)");
  db.sql("INSERT INTO device_template_groups (template_id, group_id, rpm) VALUES ('tpl', 'grp_a', 4)");
  db.sql("INSERT INTO device_models (device_id, model_id, rpm) VALUES ('dev_1', 'model_a', 5)");
  db.sql("INSERT INTO device_model_groups (device_id, group_id, rpm) VALUES ('dev_1', 'grp_a', 6)");
  seedGroupMembers(db, "grp_a", ["model_a"]);
  return { db, env: makeEnv(db) };
}

function beforeReferenceBatch(db: RealD1, change: () => void) {
  const batch = db.DB.batch.bind(db.DB);
  let applied = false;
  db.DB.batch = (statements: { sql: string }[]) => {
    if (!applied && statements.some(s => s.sql.includes("INSERT INTO public_model_write_guards"))) {
      applied = true;
      change();
    }
    return batch(statements);
  };
  return () => expect(applied).toBe(true);
}

function grants(db: RealD1) {
  return {
    members: db.rows("SELECT * FROM model_group_members ORDER BY group_id, model_id"),
    models: db.rows("SELECT * FROM device_models ORDER BY device_id, model_id"),
    groups: db.rows("SELECT * FROM device_model_groups ORDER BY device_id, group_id"),
    templateModels: db.rows("SELECT * FROM device_template_models ORDER BY template_id, model_id"),
    templateGroups: db.rows("SELECT * FROM device_template_groups ORDER BY template_id, group_id"),
    templates: db.rows("SELECT * FROM device_templates ORDER BY id"),
    scopes: db.rows("SELECT id, model_scope FROM devices ORDER BY id"),
    bindings: db.rows("SELECT * FROM device_template_bindings ORDER BY device_id"),
  };
}
function noGuards(db: RealD1) {
  expect(db.rows("SELECT * FROM public_model_write_guards")).toEqual([]);
}

const grantWriters: [string, string, string, (env: Env) => Promise<unknown>][] = [
  ["group members", "models", "model_b", env => replaceModelGroupMembers(env, "grp_a", [{ model_id: "model_a" }, { model_id: "model_b" }])],
  ["device models", "models", "model_b", env => replaceDeviceModels(env, "dev_1", ["model_a", "model_b"])],
  ["device groups", "model_groups", "grp_b", env => replaceDeviceModelGroups(env, "dev_1", ["grp_a", "grp_b"])],
  ["template models", "models", "model_b", env => replaceDeviceTemplateModels(env, "tpl", ["model_a", "model_b"])],
  ["template groups", "model_groups", "grp_b", env => replaceDeviceTemplateGroups(env, "tpl", ["grp_a", "grp_b"])],
];

describe("ID reference writers through real SQLite D1 transactions", () => {
  it.each(grantWriters)("rejects a deletion committed before %s without losing old configuration", async (_label, table, target, write) => {
    const { db, env } = await fixture();
    const before = grants(db);
    expect(db.row("SELECT id FROM " + table + " WHERE id = ?", target)).not.toBeNull();  
    const checked = beforeReferenceBatch(db, () => db.sql("DELETE FROM " + table + " WHERE id = ?", target));
    await expect(write(env)).rejects.toThrow(/CHECK constraint failed/);
    checked();
    expect(db.row("SELECT id FROM " + table + " WHERE id = ?", target)).toBeNull();
    expect(grants(db)).toEqual(before);
    noGuards(db);
  });

  it.each(grantWriters)("keeps %s attached to its disabled target ID when a rename commits first", async (label, table, target, write) => {
    const { db, env } = await fixture();
    const column = table === "models" ? "model_name" : "name";
    const checked = beforeReferenceBatch(db, () => db.sql("UPDATE " + table + " SET " + column + " = 'renamed-target' WHERE id = ?", target));
    await write(env);
    checked();
    const destination = {
      "group members": ["model_group_members", "model_id"],
      "device models": ["device_models", "model_id"],
      "device groups": ["device_model_groups", "group_id"],
      "template models": ["device_template_models", "model_id"],
      "template groups": ["device_template_groups", "group_id"],
    }[label]!;
    expect(db.rows("SELECT * FROM " + destination[0] + " WHERE " + destination[1] + " = ?", target)).toHaveLength(1);
    expect(db.row("SELECT " + column + " AS name, enabled FROM " + table + " WHERE id = ?", target)).toEqual({ name: "renamed-target", enabled: 0 });
    noGuards(db);
  });

  it("checks the member owner group, not just its model IDs", async () => {
    const { db, env } = await fixture();
    const group = await createModelGroup(env, { name: "temporary" });
    const checked = beforeReferenceBatch(db, () => db.sql("DELETE FROM model_groups WHERE id = ?", group.id));
    await expect(replaceModelGroupMembers(env, group.id, [{ model_id: "model_b" }])).rejects.toThrow(/CHECK constraint failed/);
    checked();
    expect(db.rows("SELECT * FROM model_group_members WHERE group_id = ?", group.id)).toEqual([]);
    noGuards(db);
  });

  it.each(["models", "model_groups"] as const)("rolls back template CREATE metadata and both grant sets after late %s deletion", async table => {
    const { db, env } = await fixture();
    const before = grants(db);
    const checked = beforeReferenceBatch(db, () => db.sql("DELETE FROM " + table + " WHERE id = ?", table === "models" ? "model_b" : "grp_b"));
    await expect(createDeviceTemplate(env, { name: "new", model_scope: "list", models: ["model_b"], groups: ["grp_b"] })).rejects.toThrow(/CHECK constraint failed/);
    checked();
    expect(grants(db)).toEqual(before);
    noGuards(db);
  });

  it.each(["models", "model_groups"] as const)("rolls back template UPDATE name/scope and both grant sets after late %s deletion", async table => {
    const { db, env } = await fixture();
    const before = grants(db);
    const checked = beforeReferenceBatch(db, () => db.sql("DELETE FROM " + table + " WHERE id = ?", table === "models" ? "model_b" : "grp_b"));
    await expect(updateDeviceTemplate(env, "tpl", { name: "changed", model_scope: "all_and_list", models: ["model_b"], groups: ["grp_b"] })).rejects.toThrow(/CHECK constraint failed/);
    checked();
    expect(grants(db)).toEqual(before);
    noGuards(db);
  });

  it.each(["replace", "merge"] as const)("rolls back the complete multi-device %s stamp, including scope/bindings, after a target deletion", async mode => {
    for (const table of ["models", "model_groups"]) {
      const { db, env } = await fixture();
      await updateDeviceTemplate(env, "tpl", { models: [{ model_id: "model_b", rpm: 11 }], groups: [{ group_id: "grp_b", rpm: 12 }] });
      const template = (await getDeviceTemplate(env, "tpl"))!;
      const devices = db.rows<DeviceRow>("SELECT * FROM devices ORDER BY id");
      const before = grants(db);
      const checked = beforeReferenceBatch(db, () => db.sql("DELETE FROM " + table + " WHERE id = ?", table === "models" ? "model_b" : "grp_b"));
      await expect(applyDeviceTemplate(env, template, devices, mode)).rejects.toThrow(/CHECK constraint failed/);
      checked();
      expect(grants(db)).toEqual(before);  
      noGuards(db);
    }
  });

  it("rejects fallback CREATE after deletion without leaving the source model", async () => {
    const { db, env } = await fixture();
    const checked = beforeReferenceBatch(db, () => db.sql("DELETE FROM models WHERE id = 'model_b'"));
    await expect(createModel(env, { provider_id: "prov_a", model_name: "new-source", fallback_model_id: "model_b" })).rejects.toThrow(/CHECK constraint failed/);
    checked();
    expect(db.rows("SELECT id FROM models")).toEqual([{ id: "model_a" }]);
    noGuards(db);
  });

  it("rejects fallback UPDATE after deletion without changing the source metadata", async () => {
    const { db, env } = await fixture();
    const before = db.row("SELECT * FROM models WHERE id = 'model_a'");
    const checked = beforeReferenceBatch(db, () => db.sql("DELETE FROM models WHERE id = 'model_b'"));
    await expect(updateModel(env, "model_a", { model_name: "changed", fallback_model_id: "model_b" })).rejects.toThrow(/CHECK constraint failed/);
    checked();
    expect(db.row("SELECT * FROM models WHERE id = 'model_a'")).toEqual(before);
    noGuards(db);
  });

  it.each(["create", "update"] as const)("keeps fallback %s bound to a disabled target ID across a late rename", async mode => {
    const { db, env } = await fixture();
    const checked = beforeReferenceBatch(db, () => db.sql("UPDATE models SET model_name = 'renamed-target' WHERE id = 'model_b'"));
    const row = mode === "create"
      ? await createModel(env, { provider_id: "prov_a", model_name: "source", fallback_model_id: "model_b" })
      : await updateModel(env, "model_a", { fallback_model_id: "model_b" });
    checked();
    expect(db.row("SELECT fallback_model_id FROM models WHERE id = ?", row!.id)).toEqual({ fallback_model_id: "model_b" });
    expect(db.row("SELECT model_name, enabled FROM models WHERE id = 'model_b'")).toEqual({ model_name: "renamed-target", enabled: 0 });
    noGuards(db);
  });

  it("saves complete disabled-target membership, grants and templates without renaming IDs or clearing old dirty rows", async () => {
    const { db, env } = await fixture();
    db.sql("INSERT INTO device_models (device_id, model_id, rpm) VALUES ('unrelated-dirty', 'missing', 9)");
    const group = await createModelGroup(env, { name: "normal-group", enabled: false });
    await replaceModelGroupMembers(env, group.id, [{ model_id: "model_b", position: 7, enabled: false }, { model_id: "model_a", position: 2 }]);
    await updateModelGroup(env, group.id, { name: "renamed-internal" });
    await replaceModelGroupMembers(env, group.id, [{ model_id: "model_b", position: 7, enabled: false }, { model_id: "model_a", position: 2 }]);
    expect(db.rows("SELECT model_id, position, enabled FROM model_group_members WHERE group_id = ? ORDER BY position", group.id)).toEqual([
      { model_id: "model_a", position: 2, enabled: 1 }, { model_id: "model_b", position: 7, enabled: 0 },
    ]);
    expect(await replaceDeviceModels(env, "dev_1", [{ model_id: "model_b", rpm: 12 }, { model_id: "model_b", rpm: 9 }, "model_a"])).toEqual(["model_a", "model_b"]);
    expect(await replaceDeviceModelGroups(env, "dev_1", ["grp_a", { group_id: "grp_b", rpm: 13 }])).toEqual(["grp_a", "grp_b"]);
    expect(db.row("SELECT rpm FROM device_models WHERE device_id = 'dev_1' AND model_id = 'model_b'")).toEqual({ rpm: 12 });
    await replaceDeviceTemplateModels(env, "tpl", [{ model_id: "model_b", rpm: 8 }]);
    await replaceDeviceTemplateGroups(env, "tpl", [{ group_id: "grp_b", rpm: 9 }]);
    const template = await createDeviceTemplate(env, { name: "full", model_scope: "list", models: [{ model_id: "model_b", rpm: 15 }], groups: [{ group_id: "grp_b", rpm: 16 }] });
    expect(template.models.map(m => [m.model_id, m.rpm])).toEqual([["model_b", 15]]);
    expect(template.groups.map(g => [g.group_id, g.rpm])).toEqual([["grp_b", 16]]);
    const updated = (await updateDeviceTemplate(env, template.id, { name: "full-updated", models: [{ model_id: "model_a", rpm: 17 }, { model_id: "model_b", rpm: 18 }], groups: [{ group_id: "grp_a", rpm: 19 }, { group_id: "grp_b", rpm: 20 }] }))!;
    expect(updated.name).toBe("full-updated");
    expect(updated.models).toHaveLength(2);
    expect(updated.groups).toHaveLength(2);
    await applyDeviceTemplate(env, updated, db.rows<DeviceRow>("SELECT * FROM devices ORDER BY id"), "replace");
    expect(db.rows("SELECT device_id, model_id, rpm FROM device_models WHERE device_id != 'unrelated-dirty' ORDER BY device_id, model_id")).toEqual([
      { device_id: "dev_1", model_id: "model_a", rpm: 17 }, { device_id: "dev_1", model_id: "model_b", rpm: 18 },
      { device_id: "dev_2", model_id: "model_a", rpm: 17 }, { device_id: "dev_2", model_id: "model_b", rpm: 18 },
    ]);
    expect(db.rows("SELECT id, model_scope FROM devices ORDER BY id")).toEqual([{ id: "dev_1", model_scope: "list" }, { id: "dev_2", model_scope: "list" }]);
    expect(db.rows("SELECT device_id, template_id FROM device_template_bindings ORDER BY device_id")).toEqual([{ device_id: "dev_1", template_id: updated.id }, { device_id: "dev_2", template_id: updated.id }]);
    expect(db.row("SELECT model_id, rpm FROM device_models WHERE device_id = 'unrelated-dirty'")).toEqual({ model_id: "missing", rpm: 9 });
    noGuards(db);
  });

  it("merges a complete normal stamp retaining larger existing RPMs", async () => {
    const { db, env } = await fixture();
    const template = await createDeviceTemplate(env, { name: "merge", model_scope: "list", models: [{ model_id: "model_a", rpm: 2 }, { model_id: "model_b", rpm: 8 }], groups: [{ group_id: "grp_a", rpm: 3 }, { group_id: "grp_b", rpm: 9 }] });
    await applyDeviceTemplate(env, template, db.rows<DeviceRow>("SELECT * FROM devices ORDER BY id"), "merge");
    expect(db.rows("SELECT model_id, rpm FROM device_models WHERE device_id = 'dev_1' ORDER BY model_id")).toEqual([{ model_id: "model_a", rpm: 5 }, { model_id: "model_b", rpm: 8 }]);
    expect(db.rows("SELECT group_id, rpm FROM device_model_groups WHERE device_id = 'dev_1' ORDER BY group_id")).toEqual([{ group_id: "grp_a", rpm: 6 }, { group_id: "grp_b", rpm: 9 }]);
    expect(db.rows("SELECT * FROM device_template_bindings")).toHaveLength(2);
    noGuards(db);
  });
});
