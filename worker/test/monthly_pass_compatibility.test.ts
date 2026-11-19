import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import currentWorker, { app as currentApp, RateLimiterDO as CurrentRateLimiterDO } from "../src/index";
import compatibilityWorker, { app as compatibilityApp, RateLimiterDO as CompatibilityRateLimiterDO } from "../src/compatibility";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { CollectingExecutionContext, DEVICE_ID, TOKEN, makeEnv, seedDevice, seedModel, seedProvider, chatBody, openAiAnswer, wallet } from "./helpers/realGatewayEnv";
import { buildSessionCookie, buildUserSessionCookie, signSession, signUserSession } from "../src/utils/crypto";
import { admitBillingRequest, beginBillingAttempt, persistBillingTerminal, settleBillingRequest } from "../src/db/request_billing";
import { createMonthlyPlan, issueMonthlyPass } from "../src/db/monthly_passes";
import { migrateVersionedSchema, resetSchemaCache, type SchemaDefinition } from "../src/db/schema_versions";
import { resetIpRateLimitMemory } from "../src/middleware/ipRateLimit";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import type { Env } from "../src/types";

const SECRET = "local-compatibility-session-secret";
const T = Date.UTC(2026, 10, 12, 12);
const open: RealD1[] = [];
let d: RealD1, env: Env, cookie: string;
const input = { name: "compatibility card", enabled: 1 as const, limits: { daily_usd: 10, weekly_usd: 20, five_hour_usd: 5, total_usd: 30 }, service_group_ids: null };
const adm = (request_id: string) => ({ request_id, device_id: DEVICE_ID, model: "gw-primary", pricing_snapshot_json: "{}", reserved_usd: .1, monthly_service_group_ids: [null] });
const term = (request_id: string) => ({ request_id, device_id: DEVICE_ID, provider_id: "prov_a", provider_name: "Provider A", model: "gw-primary", cost_usd: .25, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, status_code: 200, latency_ms: 1, created_at: Date.now() });
function database(options?: Parameters<typeof createRealD1>[0]) { const db = createRealD1(options); open.push(db); return db; }
function call(app = compatibilityApp, path = "/health", method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return app.request("https://compat.local" + path, { method, headers: { accept: "application/json", "content-type": "application/json", "cf-connecting-ip": "192.0.2.60", ...(path.startsWith("/admin-prefix-example/api/") && !["GET", "HEAD", "OPTIONS"].includes(method) ? { "X-Admin-Request": "1" } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
}
const admin = (path: string, method = "GET", body?: unknown) => call(compatibilityApp, path, method, body, { cookie });
async function card() { const plan = await createMonthlyPlan(env, input); return issueMonthlyPass(env, DEVICE_ID, plan.id); }
const manifest = (db = d) => db.rows<{ id: string; checksum: string; completed: number }>("SELECT id,checksum,completed FROM cpg_schema_versions ORDER BY id");

beforeEach(async () => {
  resetIpRateLimitMemory(); resetRateLimitMemory(); resetSchemaCache();
  vi.spyOn(Date, "now").mockReturnValue(T);
  d = database(); env = { ...makeEnv(d), SESSION_SECRET: SECRET, ADMIN_SECRET: "compat-admin" };
  await seedDevice(d, { balance_usd: 0 }); seedProvider(d); seedModel(d);
  cookie = buildSessionCookie(await signSession(SECRET)).split(";")[0];
});
afterEach(() => { vi.restoreAllMocks(); resetSchemaCache(); for (const db of open.splice(0)) db.close(); });

describe("current full-worker compatibility entry", () => {
  it("retains runtime exports and the EXACT current scheduled/recovery handler", () => {
    expect(compatibilityWorker.scheduled).toBe(currentWorker.scheduled);
    expect(CompatibilityRateLimiterDO).toBe(CurrentRateLimiterDO);
  });

  it("blocks only monthly admin unsafe methods AFTER existing auth, with zero changes", async () => {
    const sub = await card();
    const before = ["monthly_pass_plans", "monthly_pass_subscriptions", "monthly_pass_accounts", "audit_logs"].map(t => d.rows("SELECT * FROM " + t + " ORDER BY rowid"));
    const routes: Array<[string, string, unknown]> = [
      ["/admin-prefix-example/api/monthly-passes/plans", "POST", input], ["/admin-prefix-example/api/monthly-passes/plans/" + sub.plan_id, "PUT", input],
      ["/admin-prefix-example/api/monthly-passes/accounts/" + DEVICE_ID + "/issue", "POST", { plan_id: sub.plan_id }],
      ["/admin-prefix-example/api/monthly-passes/subscriptions/" + sub.id + "/stop", "POST", {}],
      ["/admin-prefix-example/api/monthly-passes/subscriptions/" + sub.id + "/renew", "POST", {}],
      ["/admin-prefix-example/api/monthly-passes/accounts/" + DEVICE_ID + "/wallet-fallback", "PUT", { enabled: true }],
      ["/admin-prefix-example/api/monthly-passes/plans/new", "PATCH", {}], ["/admin-prefix-example/api/monthly-passes/plans/new", "DELETE", {}],
      ["/admin-prefix-example/api/monthly-passes/", "POST", {}],
    ];
    for (const [path, method, body] of routes) {
      expect((await call(compatibilityApp, path, method, body)).status).toBe(401);
      expect((await call(compatibilityApp, path, method, body, { authorization: "Bearer " + TOKEN })).status).toBe(401);
      const response = await admin(path, method, body);
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "monthly_admin_read_only" });
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(["monthly_pass_plans", "monthly_pass_subscriptions", "monthly_pass_accounts", "audit_logs"].map(t => d.rows("SELECT * FROM " + t + " ORDER BY rowid"))).toEqual(before);
  });

  it("retains whitelist and cookie revocation checks; forged Access email cannot bypass", async () => {
    await card();
    env.CF_ACCESS_ALLOWED_EMAILS = "allowed@example.test";
    expect((await call(compatibilityApp, "/admin-prefix-example/api/monthly-passes/plans", "POST", input, { "cf-access-authenticated-user-email": "allowed@example.test" })).status).toBe(401);
    d.sql("INSERT INTO settings(key,value_json,updated_at) VALUES('ip_whitelist_config',?,?)", JSON.stringify({ enabled: true, allowed_ips: ["203.0.113.42"] }), T);
    expect((await admin("/admin-prefix-example/api/monthly-passes/plans", "POST", input)).status).toBe(403);
    d.sql("DELETE FROM settings WHERE key='ip_whitelist_config'");
    d.sql("INSERT INTO settings(key,value_json,updated_at) VALUES('session_epoch','1',?)", T);
    expect((await admin("/admin-prefix-example/api/monthly-passes/plans", "POST", input)).status).toBe(401);
  });

  it("keeps all existing authorized reads/models and nonmonthly writes, without a new read privilege", async () => {
    await card();
    for (const path of ["/admin-prefix-example/api/monthly-passes/plans", "/admin-prefix-example/api/monthly-passes/accounts", "/admin-prefix-example/api/monthly-passes/accounts/" + DEVICE_ID, "/admin-prefix-example/api/devices", "/admin-prefix-example/api/providers"]) {
      expect((await call(compatibilityApp, path)).status).toBe(401);
      const normal = await call(currentApp, path, "GET", undefined, { cookie });
      const compatibility = await admin(path);
      expect(compatibility.status).toBe(normal.status); expect(await compatibility.json()).toEqual(await normal.json());
    }
    const models = await call(compatibilityApp, "/v1/models", "GET", undefined, { authorization: "Bearer " + TOKEN });
    expect(models.status).toBe(200); expect(await models.json()).toMatchObject({ data: [{ id: "gw-primary" }] });
    expect((await call(compatibilityApp, "/console/monthly-pass", "GET", undefined, { authorization: "Bearer " + TOKEN })).status).toBe(200);
    expect((await call(compatibilityApp, "/admin-prefix-example/api/providers", "POST", { name: "new provider", type: "openai", endpoint: "https://not-contacted.invalid/v1" }, { cookie, "X-Admin-Request": "1" })).status).toBe(201);
    expect((await call(compatibilityApp, "/health")).status).toBe(200);
  });

  it("preserves console fallback authorization and writes, rather than overblocking monthly funding", async () => {
    await card(); d.sql("UPDATE devices SET password_hash='fixture',password_updated_at=1 WHERE id=?", DEVICE_ID);
    const path = "/console/monthly-pass/wallet-fallback", authorization = "Bearer " + TOKEN;
    expect((await call(compatibilityApp, path, "PUT", { enabled: true }, { authorization })).status).toBe(401);
    const owner = buildUserSessionCookie(await signUserSession(SECRET, DEVICE_ID, 1)).split(";")[0];
    const response = await call(compatibilityApp, path, "PUT", { enabled: true }, { authorization, cookie: owner });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ item: { wallet_fallback: true } });
  });

  it("switches current to compatibility on SAME DB with active monthly settlement, expired unknown recovery and new proxy billing", async () => {
    const created = await call(currentApp, "/admin-prefix-example/api/monthly-passes/plans", "POST", input, { cookie, "X-Admin-Request": "1" }); expect(created.status).toBe(201);
    const plan = (await created.json() as { item: { id: string } }).item;
    expect((await call(currentApp, "/admin-prefix-example/api/monthly-passes/accounts/" + DEVICE_ID + "/issue", "POST", { plan_id: plan.id, operation_id: "compat-switch-issue" }, { cookie, "X-Admin-Request": "1" })).status).toBe(201);
    for (const id of ["active-on-switch", "pending-on-switch", "unknown-on-switch"]) expect(await admitBillingRequest(env, adm(id))).toBe(true);
    await persistBillingTerminal(env, term("pending-on-switch"));
    await beginBillingAttempt(env, { request_id: "unknown-on-switch", provider_id: "prov_a", model: "gw-primary", protocol: "chat" });
    const beforeManifest = manifest();
    expect((await admin("/admin-prefix-example/api/monthly-passes/plans")).status).toBe(200);  
    await persistBillingTerminal(env, term("active-on-switch")); await settleBillingRequest(env, "active-on-switch");
    vi.mocked(Date.now).mockReturnValue(T + 6 * 60000);
    const tasks: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    await compatibilityWorker.scheduled({ cron: "* * * * *" } as ScheduledEvent, env, ctx); await Promise.all(tasks);
    await compatibilityWorker.scheduled({ cron: "* * * * *" } as ScheduledEvent, env, ctx); await Promise.all(tasks);
    expect(d.rows("SELECT request_id,billing_state,known_cost_usd FROM billing_requests ORDER BY request_id")).toEqual([
      { request_id: "active-on-switch", billing_state: "settled", known_cost_usd: .25 },
      { request_id: "pending-on-switch", billing_state: "settled", known_cost_usd: .25 },
      { request_id: "unknown-on-switch", billing_state: "needs_reconciliation", known_cost_usd: null },
    ]);
    expect(d.rows<{ used_usd: number; reserved_usd: number }>("SELECT used_usd,reserved_usd FROM monthly_pass_buckets").every(b => Math.abs(b.used_usd - .5) < 1e-9 && Math.abs(b.reserved_usd) < 1e-9)).toBe(true);
    expect(d.rows("SELECT delta_usd FROM wallet_ledger")).toEqual([{ delta_usd: 0 }, { delta_usd: 0 }]);
    expect(d.rows("SELECT * FROM reserve_holds")).toEqual([]); expect(wallet(d)).toEqual({ balance_usd: 0, reserved_usd: 0 });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => openAiAnswer());
    const exec = new CollectingExecutionContext();
    const response = await compatibilityWorker.fetch(new Request("https://compat.local/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(chatBody()) }), env, exec as unknown as ExecutionContext);
    expect(response.status, await response.clone().text()).toBe(200); await response.text(); await Promise.all(exec.pending);
    expect(fetch).toHaveBeenCalledTimes(1); expect(wallet(d)).toEqual({ balance_usd: 0, reserved_usd: 0 });
    expect(d.rows("SELECT delta_usd FROM wallet_ledger")).toEqual([{ delta_usd: 0 }, { delta_usd: 0 }, { delta_usd: 0 }]);
    expect(d.rows<{ used_usd: number; reserved_usd: number }>("SELECT used_usd,reserved_usd FROM monthly_pass_buckets").every(b => Math.abs(b.used_usd - .518) < 1e-9 && Math.abs(b.reserved_usd) < 1e-9)).toBe(true);
    expect(manifest()).toEqual(beforeManifest);
  });
});

describe("local migration and current-manifest compatibility (no downgrade)", () => {
  async function currentDefinition(): Promise<SchemaDefinition> {
    const schema = await import("../src/db/schema");
    const definition = (schema as unknown as { SCHEMA_DEFINITION: SchemaDefinition }).SCHEMA_DEFINITION;
    expect(definition, "parent must export live SCHEMA_DEFINITION").toBeDefined();
    expect(definition.extensions?.map(e => e.id)).toContain("monthly/0003-operations");
    return definition;
  }

  it("upgrades original three migration files to current+operations stages with historical rows unchanged", async () => {
    const init = ["0001_init.sql", "0002_phase2.sql", "0003_phase3.sql"].flatMap(name => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8").split(";").map(sql => sql.trim()).filter(Boolean));
    const legacy = database({ init, alters: [] });
    legacy.sql("INSERT INTO devices(id,name,token_hash,enabled,created_at) VALUES('legacy','Old device','legacy-token',1,7)");
    legacy.sql("INSERT INTO providers(id,name,type,endpoint) VALUES('old-p','Old provider','openai','https://not-contacted.invalid/v1')");
    legacy.sql("INSERT INTO models(id,provider_id,model_name,input_price_per_m,output_price_per_m) VALUES('old-m','old-p','old',3,15)");
    legacy.sql("INSERT INTO usage(request_id,device_id,provider_id,model,created_at,cost_usd) VALUES('old-r','legacy','old-p','old',9,.125)");
    const before = Object.fromEntries(["devices", "providers", "models", "usage"].map(t => [t, legacy.rows<Record<string, unknown>>("SELECT * FROM " + t)]));
    const definition = await currentDefinition();
    await migrateVersionedSchema(legacy.DB, definition);
    for (const [table, rows] of Object.entries(before)) expect(legacy.rows("SELECT * FROM " + table)).toMatchObject(rows);
    const stages = manifest(legacy);
    expect(stages).toHaveLength(3 + definition.extensions!.length); expect(stages.every(s => s.completed === 1)).toBe(true);
    const localEnv = { ...env, DB: legacy.DB };
    const beforeCold = manifest(legacy); resetSchemaCache(legacy.DB);
    const response = await compatibilityApp.request("https://compat.local/admin-prefix-example/api/monthly-passes/plans", { headers: { cookie } }, localEnv);
    expect(response.status, await response.clone().text()).toBe(200); expect(manifest(legacy)).toEqual(beforeCold);
  });

  it("extends a completed three-stage manifest without changing core receipts; refuses unknown manifests in BOTH entries", async () => {
    const definition = await currentDefinition(); const core = database({ init: [], alters: [] });
    await migrateVersionedSchema(core.DB, { init: definition.init, migrations: definition.migrations });
    const oldManifest = manifest(core); expect(oldManifest).toHaveLength(3);
    await migrateVersionedSchema(core.DB, definition);
    expect(manifest(core).filter(s => s.id.startsWith("core/"))).toEqual(oldManifest);
    core.sql("INSERT INTO cpg_schema_versions(id,checksum,completed,applied_at) VALUES('zz/unknown',?,1,1)", "0".repeat(64));
    const unknownManifest = manifest(core), localEnv = { ...env, DB: core.DB };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const worker of [currentWorker, compatibilityWorker]) {
      resetSchemaCache(core.DB);
      const response = await worker.fetch(new Request("https://compat.local/admin-prefix-example/api/monthly-passes/plans", { headers: { cookie } }), localEnv);
      expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "internal_server_error" });
      expect(manifest(core)).toEqual(unknownManifest);
    }
    resetSchemaCache(core.DB);
    const blocked = await compatibilityWorker.fetch(new Request("https://compat.local/admin-prefix-example/api/monthly-passes/plans", { method: "POST", headers: { cookie, "content-type": "application/json", "X-Admin-Request": "1" }, body: JSON.stringify(input) }), localEnv);
    expect(blocked.status).toBe(500); expect(await blocked.json()).toEqual({ error: "internal_server_error" });
    expect(manifest(core)).toEqual(unknownManifest);
  });
});
