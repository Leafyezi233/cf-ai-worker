import { describe, expect, it } from "vitest";
import { adminApp } from "../src/admin";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { seedDevice, seedGroup, seedGroupMembers, seedModel, seedProvider } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";


const SECRET = "session-signing-secret";

function makeEnv(d1: RealD1): Env {
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

function seedModels(d1: RealD1) {
  seedProvider(d1);
  seedModel(d1, { id: "model_a", model_name: "gw-primary" });
  seedModel(d1, { id: "model_b", model_name: "gw-backup" });
}

function modelGrants(d1: RealD1, deviceId: string) {
  return d1
    .rows<{ model_id: string }>("SELECT model_id FROM device_models WHERE device_id = ? ORDER BY model_id", deviceId)
    .map((r) => r.model_id);
}

function deviceRow(d1: RealD1, id: string) {
  return d1.row<{ model_scope: string; rate_limit_rpm: number; cost_limit_monthly: number }>(
    "SELECT model_scope, rate_limit_rpm, cost_limit_monthly FROM devices WHERE id = ?",
    id
  )!;
}

async function makeTemplate(env: Env, body: Record<string, unknown>): Promise<string> {
  const res = await admin(env, "/device-templates", { method: "POST", body });
  const json = (await res.json()) as { item: { id: string } };
  return json.item.id;
}

function applyPath(templateId: string, suffix: string): string {
  return "/device-templates/" + templateId + suffix;
}

describe("creating a template", () => {
  it("stores the scope and the model grants, and lists them back", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);

    const res = await admin(env, "/device-templates", {
      method: "POST",
      body: { name: "只读用户", model_scope: "list", model_ids: ["model_a", "model_b"], model_rpms: { model_b: 20 } },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { models: Array<{ model_id: string; rpm: number }> } };
    expect(body.item.models.map((m) => m.model_id).sort()).toEqual(["model_a", "model_b"]);
    expect(body.item.models.find((m) => m.model_id === "model_b")!.rpm).toBe(20);

    const list = await admin(env, "/device-templates");
    const listed = (await list.json()) as { items: Array<{ models: unknown[] }> };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].models).toHaveLength(2);
    d1.close();
  });

  it("rejects a duplicate name instead of creating a second template with it", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);

    await makeTemplate(env, { name: "dup", model_scope: "all" });
    const res = await admin(env, "/device-templates", { method: "POST", body: { name: "dup", model_scope: "all" } });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("name_taken");
    expect(d1.rows("SELECT id FROM device_templates")).toHaveLength(1);
    d1.close();
  });

  it("refuses a scoped template with nothing granted", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);

    const res = await admin(env, "/device-templates", { method: "POST", body: { name: "empty", model_scope: "list" } });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("empty_whitelist");
    d1.close();
  });

  it("refuses model ids that do not exist", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);

    const res = await admin(env, "/device-templates", {
      method: "POST",
      body: { name: "ghost", model_scope: "list", model_ids: ["model_a", "model_missing"] },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; model_ids: string[] };
    expect(body.error).toBe("unknown_model_ids");
    expect(body.model_ids).toEqual(["model_missing"]);
    d1.close();
  });

  it("accepts an all-scope template with no grants at all", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);

    const res = await admin(env, "/device-templates", { method: "POST", body: { name: "全开", model_scope: "all" } });

    expect(res.status).toBe(201);
    d1.close();
  });
});

describe("applying a template", () => {
  it("replaces the device whitelist and its scope by default", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    await seedDevice(d1, { id: "dev_1", model_scope: "all" });
    d1.sql("INSERT INTO device_models (device_id, model_id, rpm) VALUES ('dev_1', 'model_b', 0)");

    const templateId = await makeTemplate(env, { name: "只用 A", model_scope: "list", model_ids: ["model_a"] });
    const res = await admin(env, applyPath(templateId, "/apply"), { method: "POST", body: { device_ids: ["dev_1"] } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: number; mode: string };
    expect(body.applied).toBe(1);
    expect(body.mode).toBe("replace");
    expect(modelGrants(d1, "dev_1")).toEqual(["model_a"]);
    expect(deviceRow(d1, "dev_1").model_scope).toBe("list");
    d1.close();
  });

  it("leaves rate_limit_rpm and cost_limit_monthly exactly as they were", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    await seedDevice(d1, { id: "dev_1" });
    d1.sql("UPDATE devices SET rate_limit_rpm = 60, cost_limit_monthly = 5 WHERE id = 'dev_1'");

    const templateId = await makeTemplate(env, { name: "模板", model_scope: "list", model_ids: ["model_a"] });
    await admin(env, applyPath(templateId, "/apply"), { method: "POST", body: { device_ids: ["dev_1"] } });

    const after = deviceRow(d1, "dev_1");
    expect(after.rate_limit_rpm).toBe(60);
    expect(after.cost_limit_monthly).toBe(5);
    d1.close();
  });

  it("flips an all-scope device to list even in merge mode", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    await seedDevice(d1, { id: "dev_1", model_scope: "all" });

    const templateId = await makeTemplate(env, { name: "受限", model_scope: "list", model_ids: ["model_a"] });
    await admin(env, applyPath(templateId, "/apply"), { method: "POST", body: { device_ids: ["dev_1"], mode: "merge" } });

    expect(deviceRow(d1, "dev_1").model_scope).toBe("list");
    expect(modelGrants(d1, "dev_1")).toEqual(["model_a"]);
    d1.close();
  });

  it("never widens a restricted device with a permissive template in merge mode", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    await seedDevice(d1, { id: "dev_1", model_scope: "list" });

    const templateId = await makeTemplate(env, { name: "全开", model_scope: "all" });
    await admin(env, applyPath(templateId, "/apply"), { method: "POST", body: { device_ids: ["dev_1"], mode: "merge" } });

    expect(deviceRow(d1, "dev_1").model_scope).toBe("list");
    d1.close();
  });

  it("adds to the existing whitelist in merge mode without dropping what was there", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    await seedDevice(d1, { id: "dev_1", model_scope: "list" });
    d1.sql("INSERT INTO device_models (device_id, model_id, rpm) VALUES ('dev_1', 'model_b', 0)");

    const templateId = await makeTemplate(env, { name: "加 A", model_scope: "list", model_ids: ["model_a"] });
    await admin(env, applyPath(templateId, "/apply"), { method: "POST", body: { device_ids: ["dev_1"], mode: "merge" } });

    expect(modelGrants(d1, "dev_1")).toEqual(["model_a", "model_b"]);
    d1.close();
  });

  it("applies to every live device when the target is all", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    await seedDevice(d1, { id: "dev_1" });
    await seedDevice(d1, { id: "dev_2", token_hash: "hash-of-a-second-token" });

    const templateId = await makeTemplate(env, { name: "批量", model_scope: "list", model_ids: ["model_a"] });
    const res = await admin(env, applyPath(templateId, "/apply"), { method: "POST", body: { device_ids: "all" } });

    expect(((await res.json()) as { applied: number }).applied).toBe(2);
    expect(modelGrants(d1, "dev_1")).toEqual(["model_a"]);
    expect(modelGrants(d1, "dev_2")).toEqual(["model_a"]);
    d1.close();
  });

  it("refuses unknown and revoked device ids by name", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    await seedDevice(d1, { id: "dev_1" });
    d1.sql("UPDATE devices SET revoked_at = 123 WHERE id = 'dev_1'");

    const templateId = await makeTemplate(env, { name: "t", model_scope: "all" });
    const unknown = await admin(env, applyPath(templateId, "/apply"), { method: "POST", body: { device_ids: ["dev_missing"] } });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe("unknown_device_ids");

    const revoked = await admin(env, applyPath(templateId, "/apply"), { method: "POST", body: { device_ids: ["dev_1"] } });
    expect(revoked.status).toBe(400);
    expect(((await revoked.json()) as { error: string }).error).toBe("device_revoked");
    d1.close();
  });

  it("previews the resulting scope without touching anything", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    await seedDevice(d1, { id: "dev_1", model_scope: "all" });

    const templateId = await makeTemplate(env, { name: "受限", model_scope: "list", model_ids: ["model_a"] });
    const res = await admin(env, applyPath(templateId, "/preview"), {
      method: "POST",
      body: { device_ids: ["dev_1"], mode: "merge" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      item: { scope_change_count: number; items: Array<{ from_scope: string; to_scope: string }> };
    };
    expect(body.item.scope_change_count).toBe(1);
    expect(body.item.items[0]).toMatchObject({ from_scope: "all", to_scope: "list" });
    expect(deviceRow(d1, "dev_1").model_scope).toBe("all");
    expect(modelGrants(d1, "dev_1")).toEqual([]);
    d1.close();
  });

  it("grants a group as well as a model, keeping the group rpm", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1, { id: "dev_1" });

    const templateId = await makeTemplate(env, {
      name: "带组",
      model_scope: "list",
      group_ids: ["grp_a"],
      group_rpms: { grp_a: 15 },
    });
    await admin(env, applyPath(templateId, "/apply"), { method: "POST", body: { device_ids: ["dev_1"] } });

    const rows = d1.rows<{ group_id: string; rpm: number }>(
      "SELECT group_id, rpm FROM device_model_groups WHERE device_id = 'dev_1'"
    );
    expect(rows).toEqual([{ group_id: "grp_a", rpm: 15 }]);
    d1.close();
  });
});

describe("templates follow their grants when the target is deleted", () => {
  it("drops a model grant when the model is deleted", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);

    await makeTemplate(env, { name: "t", model_scope: "list", model_ids: ["model_a", "model_b"] });
    const res = await admin(env, "/models/model_a", { method: "DELETE" });

    expect(res.status).toBe(409);
    const left = d1.rows<{ model_id: string }>("SELECT model_id FROM device_template_models");
    expect(left.map((r) => r.model_id)).toEqual(["model_a", "model_b"]);
    d1.close();
  });

  it("drops a group grant when the group is deleted", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a"]);

    await makeTemplate(env, { name: "t", model_scope: "list", group_ids: ["grp_a"] });
    const res = await admin(env, "/model-groups/grp_a", { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(d1.rows("SELECT group_id FROM device_template_groups")).toEqual([{ group_id: "grp_a" }]);
    d1.close();
  });

  it("keeps the devices it stamped when the template itself is deleted", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    await seedDevice(d1, { id: "dev_1" });

    const templateId = await makeTemplate(env, { name: "t", model_scope: "list", model_ids: ["model_a"] });
    await admin(env, applyPath(templateId, "/apply"), { method: "POST", body: { device_ids: ["dev_1"] } });
    await admin(env, applyPath(templateId, ""), { method: "DELETE" });

    expect(modelGrants(d1, "dev_1")).toEqual(["model_a"]);
    expect(d1.rows("SELECT device_id FROM device_template_bindings")).toEqual([]);
    d1.close();
  });
});

describe("saving a device whitelist as a template", () => {
  it("copies the device scope, models and groups", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1, { id: "dev_1", model_scope: "list" });
    d1.sql("INSERT INTO device_models (device_id, model_id, rpm) VALUES ('dev_1', 'model_a', 30)");
    d1.sql("INSERT INTO device_model_groups (device_id, group_id, rpm) VALUES ('dev_1', 'grp_a', 0)");

    const res = await admin(env, "/device-templates/from-device/dev_1?name=快照", { method: "POST" });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      item: { name: string; model_scope: string; models: Array<{ model_id: string; rpm: number }>; groups: unknown[] };
    };
    expect(body.item.name).toBe("快照");
    expect(body.item.model_scope).toBe("list");
    expect(body.item.models).toEqual([expect.objectContaining({ model_id: "model_a", rpm: 30 })]);
    expect(body.item.groups).toHaveLength(1);
    d1.close();
  });

  it("404s for a device that does not exist", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const res = await admin(env, "/device-templates/from-device/dev_missing", { method: "POST" });
    expect(res.status).toBe(404);
    d1.close();
  });
});

describe("editing a template", () => {
  it("renames without having to resend the grants", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);

    const templateId = await makeTemplate(env, { name: "旧名", model_scope: "list", model_ids: ["model_a"] });
    const res = await admin(env, applyPath(templateId, ""), { method: "PUT", body: { name: "新名" } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { name: string; models: Array<{ model_id: string }> } };
    expect(body.item.name).toBe("新名");
    expect(body.item.models.map((m) => m.model_id)).toEqual(["model_a"]);
    d1.close();
  });

  it("replaces the grants when they are sent", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);

    const templateId = await makeTemplate(env, { name: "t", model_scope: "list", model_ids: ["model_a"] });
    await admin(env, applyPath(templateId, ""), { method: "PUT", body: { model_ids: ["model_b"] } });

    const left = d1.rows<{ model_id: string }>("SELECT model_id FROM device_template_models ORDER BY model_id");
    expect(left.map((r) => r.model_id)).toEqual(["model_b"]);
    d1.close();
  });

  it("clears the grants when the scope becomes all", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);

    const templateId = await makeTemplate(env, { name: "t", model_scope: "list", model_ids: ["model_a"] });
    await admin(env, applyPath(templateId, ""), { method: "PUT", body: { model_scope: "all" } });

    expect(d1.rows("SELECT model_id FROM device_template_models")).toEqual([]);
    d1.close();
  });
});

describe("the failure modes the review found", () => {
  function transactional(d1: RealD1): RealD1 {
    return {
      ...d1,
      DB: {
        prepare: d1.DB.prepare,
        batch: async (statements: { run: () => Promise<unknown> }[]) => {
          d1.sql("BEGIN");
          try {
            const out: unknown[] = [];
            for (const statement of statements) out.push(await statement.run());
            d1.sql("COMMIT");
            return out;
          } catch (err) {
            d1.sql("ROLLBACK");
            throw err;
          }
        },
      },
    };
  }

  function boomOnModel(d1: RealD1, modelId: string) {
    d1.sql(
      `CREATE TRIGGER boom_grant BEFORE INSERT ON device_template_models WHEN NEW.model_id = '${modelId}' ` +
        "BEGIN SELECT RAISE(ABORT, 'boom'); END"
    );
  }

  it("leaves no template behind when a grant insert fails while creating", async () => {
    const d1 = createRealD1();
    seedModels(d1);
    seedModel(d1, { id: "model_boom", model_name: "gw-boom" });
    boomOnModel(d1, "model_boom");
    const env = makeEnv(transactional(d1));

    const res = await admin(env, "/device-templates", {
      method: "POST",
      body: { name: "半成品", model_scope: "list", model_ids: ["model_a", "model_boom"] },
    });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(d1.rows("SELECT id FROM device_templates")).toEqual([]);
    expect(d1.rows("SELECT model_id FROM device_template_models")).toEqual([]);
    d1.close();
  });

  it("writes the row and its grants in one batch", async () => {
    const d1 = createRealD1();
    seedModels(d1);
    const seen: string[][] = [];
    const counting = {
      ...d1,
      DB: {
        prepare: d1.DB.prepare,
        batch: async (statements: { sql?: string; run: () => Promise<unknown> }[]) => {
          seen.push(statements.map((s) => s.sql ?? ""));
          return d1.DB.batch(statements);
        },
      },
    } as RealD1;
    const env = makeEnv(counting);

    const res = await admin(env, "/device-templates", {
      method: "POST",
      body: { name: "一次写完", model_scope: "list", model_ids: ["model_a"] },
    });

    expect(res.status).toBe(201);
    const carriesRow = seen.filter((batch) => batch.some((s) => s.startsWith("INSERT INTO device_templates")));
    const carriesGrants = seen.filter((batch) => batch.some((s) => s.includes("INTO device_template_models")));
    expect(carriesRow).toHaveLength(1);
    expect(carriesGrants).toHaveLength(1);
    expect(carriesRow[0]).toBe(carriesGrants[0]);
    d1.close();
  });

  it("does not let a failed edit rename a template or rewrite its grants", async () => {
    const d1 = createRealD1();
    seedModels(d1);
    const env = makeEnv(d1);
    const templateId = await makeTemplate(env, { name: "旧名", model_scope: "list", model_ids: ["model_a"] });

    seedModel(d1, { id: "model_boom", model_name: "gw-boom" });
    boomOnModel(d1, "model_boom");
    const brokenEnv = makeEnv(transactional(d1));
    const res = await admin(brokenEnv, applyPath(templateId, ""), {
      method: "PUT",
      body: { name: "新名", model_ids: ["model_boom"] },
    });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(d1.rows<{ name: string }>("SELECT name FROM device_templates")).toEqual([{ name: "旧名" }]);
    expect(d1.rows<{ model_id: string }>("SELECT model_id FROM device_template_models")).toEqual([
      { model_id: "model_a" },
    ]);
    d1.close();
  });

  it("refuses a stamp that would build more statements than the cap", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    await seedDevice(d1, { id: "dev_1" });

    const templateId = await makeTemplate(env, { name: "t", model_scope: "list", model_ids: ["model_a"] });
    const preview = await admin(env, applyPath(templateId, "/preview"), {
      method: "POST",
      body: { device_ids: ["dev_1"], mode: "replace" },
    });
    const body = (await preview.json()) as { item: { statements: number; statement_limit: number } };
    expect(body.item.statements).toBe(5);
    expect(body.item.statement_limit).toBe(20000);

    const applied = await admin(env, applyPath(templateId, "/apply"), {
      method: "POST",
      body: { device_ids: ["dev_1"], mode: "replace" },
    });
    expect(applied.status).toBe(200);
    d1.close();
  });

  it("bounds the rpm maps by entry count, not only by key length", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);

    const rpms: Record<string, number> = {};
    for (let i = 0; i < 501; i++) rpms["model_" + i] = 7;
    const res = await admin(env, "/device-templates", {
      method: "POST",
      body: { name: "太多", model_scope: "list", model_ids: ["model_a"], model_rpms: rpms },
    });

    expect(res.status).toBe(400);
    d1.close();
  });

  it("drops grants whose model no longer exists when saving from a device", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedModels(d1);
    await seedDevice(d1, { id: "dev_1", model_scope: "list" });
    d1.sql("INSERT INTO device_models (device_id, model_id, rpm) VALUES ('dev_1', 'model_a', 0)");
    d1.sql("INSERT INTO device_models (device_id, model_id, rpm) VALUES ('dev_1', 'model_gone', 0)");

    const res = await admin(env, "/device-templates/from-device/dev_1", { method: "POST" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { models: Array<{ model_id: string }> } };
    expect(body.item.models.map((m) => m.model_id)).toEqual(["model_a"]);
    d1.close();
  });
});

