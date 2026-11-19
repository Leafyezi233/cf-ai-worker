import { afterEach, describe, expect, it } from "vitest";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedDevice, seedModel, seedProvider, seedGroup, seedGroupMembers } from "./helpers/realGatewayEnv";
import { ensureSchema, resetSchemaCache } from "../src/db/schema";
import { deviceAccessReport } from "../src/admin/device_access";
import { accessBudgetEnv, AccessBudgetExceeded } from "../src/admin/access_budget";
import { devicesApp } from "../src/admin/devices";
import { previewTokenRouting } from "../src/console/routing_preview";
import { createServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import type { Env } from "../src/types";
import { app } from "../src/index";
import { signSession, buildSessionCookie } from "../src/utils/crypto";
const databases: RealD1[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
async function setup() {
  const db = createRealD1(); databases.push(db);
  const env = makeEnv(db); await ensureSchema(env);
  seedProvider(db); await seedDevice(db, { id: "acct", balance_usd: 5 });
  return { db, env };
}
function counted(env: Env, fail?: (sql: string) => boolean) {
  let calls = 0;
  const sqls: string[] = [], originals = new WeakMap<object, D1PreparedStatement>();
  const tick = (sql: string) => { calls++; sqls.push(sql); if (calls > 50) throw Error("D1 50 limit"); if (fail?.(sql)) throw Error("injected database outage"); };
  const wrap = (sql: string, stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, { get(target, prop) {
      if (prop === "bind") return (...args: unknown[]) => wrap(sql, target.bind(...args));
      if (["first", "all", "run", "raw"].includes(String(prop))) return (...args: unknown[]) => { tick(sql); return Reflect.apply(Reflect.get(target, prop), target, args); };
      const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
    } }); originals.set(proxy, stmt); return proxy;
  };
  const DB = new Proxy(env.DB, { get(target, prop) {
    if (prop === "prepare") return (sql: string) => wrap(sql, target.prepare(sql));
    if (prop === "batch") return (stmts: D1PreparedStatement[]) => { tick("BATCH"); return target.batch(stmts.map(s => originals.get(s) ?? s)); };
    const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { env: { ...env, DB }, calls: () => calls, sqls };
}
describe("PR1 bounded account diagnostics (real SQLite)", () => {
  it("measures first manifest creation separately from cold-ready and warm readiness", async () => {
    const db = createRealD1(); databases.push(db); const measured = counted(makeEnv(db));
    await ensureSchema(measured.env); const bootstrap = measured.calls();
    await ensureSchema(measured.env); expect(measured.calls()).toBe(bootstrap);
    console.log("first manifest/bootstrap ensureSchema executions", bootstrap, "warm", 0);
  });
  it("defaults to summary without querying model catalog or previews; cold/warm schema stay bounded", async () => {
    const { db, env } = await setup(); seedModel(db);
    const measured = counted(env);
    await ensureSchema(measured.env); const cold = measured.calls();
    await ensureSchema(measured.env); expect(measured.calls()).toBe(cold);
    const report = await deviceAccessReport(measured.env, "acct");
    expect(report).toMatchObject({ models: [], models_loaded: false, partial: false });
    expect(report!.d1_calls).toBeLessThanOrEqual(30);
    expect(measured.calls()).toBeLessThanOrEqual(35);
    expect(measured.sqls.some(sql => sql.includes("MAX(display_name)") || sql.includes("FROM token_routing_policies"))).toBe(false);
    console.log("schema manifest cold/warm", cold, 0, "summary internal", report!.d1_calls);
    resetSchemaCache(measured.env.DB); const before = measured.calls(); await ensureSchema(measured.env);
    console.log("schema reset audit", measured.calls() - before);
  });
  it("does not offer a no-progress continuation after injected budget exhaustion on the first preview", async () => {
    const { db, env } = await setup();
    for (let i = 0; i < 6; i++) seedModel(db, { id: "member-" + i, model_name: "model-" + i });
    for (const cursor of ["", "model-"]) {
      const measured = counted(env, sql => {
        if (sql.includes("FROM token_routing_policies")) throw new AccessBudgetExceeded();
        return false;
      });
      const report = await deviceAccessReport(measured.env, "acct", { models: true, cursor });
      expect(report!.partial).toBe(true);
      expect(report!.models[0]).toMatchObject({ name: "model-0", status: "unchecked", available: null });
      expect(report!.models).toHaveLength(5);
      expect(report!.next_cursor).toBeNull();
      expect(measured.calls()).toBeLessThanOrEqual(18);
    }
  });

  it("pages 300 fixed-group models and aliases with no skipped names under a 50 execution ceiling", async () => {
    const { db, env } = await setup();
    const group = await createServiceGroup(env, { name: "Fixed", multiplier: 2, public_selectable: 1 });
    db.sql("UPDATE devices SET service_group_id=? WHERE id='acct'", group.id);
    for (let i = 0; i < 300; i++) {
      const name = "model-" + String(i).padStart(3, "0");
      seedModel(db, { id: name, model_name: name, alias: i === 0 ? "alias-model" : null });
      seedGroup(db, { id: "g-" + name, name, peak_pricing_enabled: 1 }); seedGroupMembers(db, "g-" + name, [name]);
      const mapping = await upsertServiceGroupModel(env, group.id, { model_key: name, target_type: "group", target_id: "g-" + name });
      if (i === 0) db.sql("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES(?,?,?,1)", group.id, "public-alias", mapping.id);
    }
    env.SESSION_SECRET = "local-pr1-fixed-fixture";
    const cookie = buildSessionCookie(await signSession(env.SESSION_SECRET));
    const checked = new Set<string>(); let cursor = "", max = 0, partials = 0;
    for (let page = 0; page < 400; page++) {
      const measured = counted(env);
      const response = await app.request("https://local/admin-prefix-example/api/devices/acct/access?models=1&limit=999&cursor=" + encodeURIComponent(cursor), { headers: { cookie } }, measured.env);
      expect(response.status).toBe(200);
      const report = await response.json() as NonNullable<Awaited<ReturnType<typeof deviceAccessReport>>>;
      expect(measured.calls()).toBeLessThanOrEqual(50); expect(report.d1_calls).toBeLessThanOrEqual(35); expect(report.models.length).toBeLessThanOrEqual(5);
      expect(measured.sqls.filter(sql => sql.includes("FROM token_routing_policies")).length).toBeLessThanOrEqual(1);
      max = Math.max(max, measured.calls());
      for (const model of report.models) {
        if (model.status === "unchecked") { expect(model.available).toBeNull(); continue; }
        if (model.name.startsWith("model-") || model.name === "public-alias") expect(model.available).toBe(true);
        expect(checked.has(model.name)).toBe(false); checked.add(model.name);
      }
      if (report.partial) { partials++; expect(report.models.some(m => m.status === "unchecked")).toBe(true); }
      if (report.next_cursor === null) break;
      expect(report.next_cursor > cursor).toBe(true); cursor = report.next_cursor;
    }
    expect(partials).toBeGreaterThan(0);
    expect(checked.size).toBe(302); expect(checked.has("alias-model")).toBe(true); expect(checked.has("public-alias")).toBe(true);
    console.log("fixed300 + aliases max D1 calls", max, "partial pages", partials);
    db.sql("DROP TABLE cpg_schema_versions");
    const bootstrap = counted(env);
    const firstResponse = await app.request("https://local/admin-prefix-example/api/devices/acct/access?models=1&cursor=model-", { headers: { cookie } }, bootstrap.env);
    expect(firstResponse.status).toBe(200); expect(bootstrap.calls()).toBeLessThanOrEqual(50);
    const firstBody = await firstResponse.json() as any;
    expect(firstBody.models.some((m: any) => m.available === true)).toBe(true);
    console.log("first-manifest authenticated fixed-group page total", bootstrap.calls(), "internal", firstBody.d1_calls);
  });
  it("keeps the complete authenticated HTTP request below 50 including cold schema readiness", async () => {
    const { db, env } = await setup(); seedModel(db, { model_name: "a" });
    env.SESSION_SECRET = "pr1-local-test-session-only";
    const cookie = buildSessionCookie(await signSession(env.SESSION_SECRET));
    const measured = counted(env);
    const response = await app.request("https://local/admin-prefix-example/api/devices/acct/access?models=1", { headers: { cookie } }, measured.env);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.models[0].available).toBe(true); expect(measured.calls()).toBeLessThanOrEqual(50);
    console.log("complete HTTP cold schema + auth + diagnostic", measured.calls(), "internal", body.d1_calls);
  });
  it("does not reuse balance or authorization across requests", async () => {
    const { db, env } = await setup(); seedModel(db, { model_name: "a" });
    expect((await deviceAccessReport(env, "acct", { models: true }))!.models[0].available).toBe(true);
    db.sql("UPDATE devices SET model_scope='list' WHERE id='acct'"); db.sql("UPDATE device_wallets SET balance_usd=0 WHERE device_id='acct'");
    const report = (await deviceAccessReport(env, "acct", { models: true }))!;
    expect(report.models[0].available).toBe(false); expect(report.wallet.available_usd).toBe(0);
  });
  it("aborts on unknown DB failure and preserves ordinary preview behavior", async () => {
    const { db, env } = await setup(); seedModel(db, { model_name: "a" });
    const failed = counted(env, sql => sql.includes("FROM token_routing_policies"));
    const response = await devicesApp.request("http://local/acct/access?models=1", {}, failed.env);
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: "access_diagnostic_failed" });
    const device = db.row<any>("SELECT * FROM devices WHERE id='acct'")!;
    const normal = await previewTokenRouting(counted(env, sql => sql.includes("FROM token_routing_policies")).env, device, "master", "a");
    expect(normal.error).toBe("routing_unavailable");
    await expect(previewTokenRouting(counted(env, sql => sql.includes("FROM token_routing_policies")).env, device, "master", "a", { strict: true })).rejects.toThrow("injected database outage");
  });
  it("prioritizes an in-flight DB exception over simultaneous budget exhaustion", async () => {
    const { env } = await setup(); let reject!: (error: Error) => void;
    const deferred = new Promise<never>((_resolve, fail) => { reject = fail; });
    const DB = new Proxy(env.DB, { get(target, prop) { if (prop === "prepare") return () => ({ first: () => deferred }); return Reflect.get(target, prop); } });
    const budget = accessBudgetEnv({ ...env, DB }, 1);
    const inflight = budget.env.DB.prepare("SELECT 1").first();
    const rejected = expect(inflight).rejects.toThrow("database failure wins");
    await expect(budget.env.DB.prepare("SELECT 2").first()).rejects.toBeInstanceOf(AccessBudgetExceeded);
    reject(Error("database failure wins")); await rejected;
    await expect(budget.settle()).rejects.toThrow("database failure wins");
  });
  it("never memoizes mutations and reuses identical SELECT-only batches", async () => {
    const { env } = await setup(); const measured = counted(env), budget = accessBudgetEnv(measured.env, 5);
    await budget.env.DB.prepare("UPDATE devices SET enabled=enabled").run();
    await budget.env.DB.prepare("UPDATE devices SET enabled=enabled").run();
    await budget.env.DB.batch([budget.env.DB.prepare("SELECT 7")]);
    await budget.env.DB.batch([budget.env.DB.prepare("SELECT 7")]);
    expect(measured.calls()).toBe(3);
  });
  it("limits first/all/run/batch, memoizes only SELECT and never retries after exhaustion", async () => {
    const { env } = await setup(); const measured = counted(env), budget = accessBudgetEnv(measured.env, 4);
    const db = budget.env.DB;
    await db.prepare("SELECT 1 AS x").first(); await db.prepare("SELECT 1 AS x").first();
    await db.prepare("SELECT 2 AS x").all();
    await db.prepare("UPDATE devices SET enabled=enabled").run();
    await db.batch([db.prepare("SELECT 3 AS x")]);
    await expect(db.prepare("SELECT 4 AS x").first()).rejects.toBeInstanceOf(AccessBudgetExceeded);
    await expect(db.prepare("SELECT 5 AS x").all()).rejects.toBeInstanceOf(AccessBudgetExceeded);
    expect(measured.calls()).toBe(4);
  });
});
