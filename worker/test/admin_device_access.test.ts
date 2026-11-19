import { afterEach, describe, expect, it } from "vitest";
import { devicesApp } from "../src/admin/devices";
import { attentionApp } from "../src/admin/attention";
import { ensureSchema } from "../src/db/schema";
import { makeEnv, seedDevice, seedModel, seedProvider } from "./helpers/realGatewayEnv";
import { createRealD1, type RealD1 } from "./helpers/realD1";

const databases: RealD1[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

async function setup() {
  const db = createRealD1(); databases.push(db);
  const env = makeEnv(db); await ensureSchema(env);
  seedProvider(db);
  seedModel(db, { id: "m_cheap", model_name: "cheap-chat", input_price_per_m: 1, output_price_per_m: 2 });
  seedModel(db, { id: "m_free", model_name: "free-chat", pricing_mode: "free", input_price_per_m: 0, output_price_per_m: 0 });
  seedModel(db, { id: "m_unpriced", model_name: "draft-chat", pricing_mode: "unset", input_price_per_m: 0, output_price_per_m: 0 });
  seedModel(db, { id: "m_off", model_name: "retired-chat", enabled: 0 });
  return { db, env };
}

async function access(env: ReturnType<typeof makeEnv>, id: string) {
  const res = await devicesApp.request("http://local/" + id + "/access", {}, env);
  return { status: res.status, body: await res.json() as any };
}

describe("admin account access report", () => {
  it("lists every enabled model with availability, plain reasons and effective prices", async () => {
    const { db, env } = await setup();
    await seedDevice(db, { id: "acct", token_hash: "h1", balance_usd: 5 });
    const { status, body } = await access(env, "acct");
    expect(status).toBe(200);
    expect(body.issues).toEqual([]);
    const byName = Object.fromEntries(body.models.map((m: any) => [m.name, m]));
    expect(Object.keys(byName).sort()).toEqual(["cheap-chat", "draft-chat", "free-chat"]);
    expect(byName["cheap-chat"]).toMatchObject({ available: true, reason: null, service_group: null, price: { pricing_mode: "priced", input_price_per_m: 1, output_price_per_m: 2 } });
    expect(byName["free-chat"]).toMatchObject({ available: true, price: { pricing_mode: "free" } });
    expect(byName["draft-chat"]).toMatchObject({ available: false, price: null });
    expect(byName["draft-chat"].reason).toContain("未定价");
    expect(body.models[body.models.length - 1].name).toBe("draft-chat");
    expect(JSON.stringify(body)).not.toMatch(/token_hash|password_hash|sk-a/);
  });

  it("explains whitelist denials and account-wide blockers", async () => {
    const { db, env } = await setup();
    await seedDevice(db, { id: "acct", token_hash: "h2", model_scope: "list", balance_usd: 0 });
    db.sql("INSERT INTO device_models (device_id, model_id, rpm) VALUES ('acct', 'm_cheap', 0)");
    db.sql("UPDATE devices SET calls_enabled = 0 WHERE id = 'acct'");
    const { body } = await access(env, "acct");
    const byName = Object.fromEntries(body.models.map((m: any) => [m.name, m]));
    expect(byName["cheap-chat"].available).toBe(true);
    expect(byName["free-chat"]).toMatchObject({ available: false });
    expect(byName["free-chat"].reason).toContain("没有权限");
    expect(body.issues.map((i: any) => [i.key, i.level])).toEqual([["calls_disabled", "block"], ["no_balance", "block"]]);
  });

  it("returns 404 for unknown accounts", async () => {
    const { env } = await setup();
    expect((await access(env, "missing")).status).toBe(404);
  });
});

describe("admin attention items", () => {
  it("is empty for a healthy setup", async () => {
    const { db, env } = await setup();
    db.sql("UPDATE models SET enabled = 0 WHERE id = 'm_unpriced'");
    await seedDevice(db, { id: "acct", token_hash: "h3", balance_usd: 5 });
    const res = await attentionApp.request("http://local/", {}, env);
    expect(res.status).toBe(200);
    expect((await res.json() as any).items).toEqual([]);
  });

  it("flags unpriced models, empty wallets, blocked calls and expiring passes with fix links", async () => {
    const { db, env } = await setup();
    await seedDevice(db, { id: "a1", token_hash: "h4", balance_usd: 0 });
    await seedDevice(db, { id: "a2", token_hash: "h5", balance_usd: 3 });
    db.sql("UPDATE devices SET calls_enabled = 0 WHERE id = 'a2'");
    const now = Date.now();
    db.sql("INSERT INTO monthly_pass_subscriptions (id, device_id, plan_id, plan_name, enabled, limits_json, groups_json, starts_at, expires_at, five_hour_start, created_at, updated_at) VALUES ('s1','a2','p1','标准',1,?,NULL,?,?,NULL,?,?)",
      JSON.stringify({ daily_usd: 1, weekly_usd: null, five_hour_usd: null, total_usd: null }), now - 1000, now + 2 * 86_400_000, now, now);
    db.sql("INSERT INTO monthly_pass_accounts (device_id, subscription_id, wallet_fallback) VALUES ('a2','s1',0)");
    const res = await attentionApp.request("http://local/", {}, env);
    const items = (await res.json() as any).items as any[];
    const byKey = Object.fromEntries(items.map(i => [i.key, i]));
    expect(Object.keys(byKey).sort()).toEqual(["accounts_calls_off", "accounts_no_balance", "models_unpriced", "passes_expiring"]);
    expect(byKey.models_unpriced).toMatchObject({ level: "block", count: 1, link: "/models?list_enabled=1&list_pricing=unset" });
    expect(byKey.accounts_no_balance).toMatchObject({ count: 1, link: "/devices?list_state=nobalance" });
    expect(byKey.passes_expiring.text).toBe("1 张月卡 7 天内到期");
  });
});
