import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import * as cfAccess from "../src/utils/cfAccess";
import { INIT_STATEMENTS } from "../src/db/schema";
import { MONTHLY_PASS_TABLES } from "../src/db/monthly_pass_schema";
import { MONTHLY_PASS_OPERATIONS_SCHEMA } from "../src/db/monthly_pass_operations_schema";
import type { Env } from "../src/types";
import { buildSessionCookie, buildUserSessionCookie, hashToken, signSession, signUserSession } from "../src/utils/crypto";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { resetIpRateLimitMemory } from "../src/middleware/ipRateLimit";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, TOKEN, makeEnv, seedDevice, seedProvider } from "./helpers/realGatewayEnv";

const SECRET = "monthly-api-local-session-secret";
const OTHER_ID = "monthly-other-device";
const OTHER_TOKEN = "monthly-other-master-secret";
const SUB_TOKEN = "monthly-sub-token-secret";
const DAY = 24 * 60 * 60 * 1000;
const BASE = "/api/monthly-passes";
type PlanInput = {
  name: string; enabled: 0 | 1;
  limits: { daily_usd: number | null; weekly_usd: number | null; five_hour_usd: number | null; total_usd: number | null };
  service_group_ids: string[] | null;
};
type Plan = PlanInput & { id: string };
type Subscription = {
  id: string; device_id: string; plan_id: string; plan_name: string; enabled: number;
  starts_at: number; expires_at: number; limits: PlanInput["limits"]; service_group_ids: string[] | null;
  windows: Array<{ kind: string; limit_usd: number; used_usd: number; reserved_usd: number; remaining_usd: number; starts_at: number; ends_at: number }>;
};
type Account = { device_id: string; wallet_fallback: boolean; subscription: Subscription | null };
let d: RealD1;
let env: Env;
let adminCookie: string;
let ownerCookie: string;
let otherCookie: string;
let clock: ReturnType<typeof vi.spyOn>;
function input(patch: Partial<PlanInput> = {}): PlanInput {
  return { name: "Text monthly", enabled: 1, limits: { daily_usd: 2, weekly_usd: 10, five_hour_usd: 1, total_usd: 30 }, service_group_ids: null, ...patch };
}
function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return app.request("https://monthly.test" + path, {
    method, headers: { accept: "application/json", "content-type": "application/json", "cf-connecting-ip": "192.0.2.44", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}
function admin(path: string, method = "GET", body?: unknown) {
  return request(BASE + path, method, body, { cookie: adminCookie });
}
function consoleRequest(path = "", method = "GET", body?: unknown, token = TOKEN, cookie = ownerCookie) {
  return request("/console/monthly-pass" + path, method, body, { authorization: "Bearer " + token, cookie });
}
async function create(data = input()) {
  const response = await admin("/plans", "POST", data);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json() as { item: Plan }).item;
}
async function issue(planId: string, deviceId = DEVICE_ID) {
  const response = await admin("/accounts/" + deviceId + "/issue", "POST", { plan_id: planId, operation_id: crypto.randomUUID() });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json() as { item: Subscription }).item;
}
async function account(deviceId = DEVICE_ID) {
  const response = await admin("/accounts/" + deviceId);
  expect(response.status).toBe(200);
  return (await response.json() as { item: Account }).item;
}
function auditRows() {
  return d.rows<{ actor_type: string; ip: string; action: string; target_type: string; target_id: string; details_json: string }>("SELECT actor_type, ip, action, target_type, target_id, details_json FROM audit_logs WHERE action LIKE 'monthly_pass.%' ORDER BY id");
}
beforeEach(async () => {
  resetRateLimitMemory(); resetIpRateLimitMemory();
  clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 12, 12));
  d = createRealD1({ init: [...INIT_STATEMENTS, ...MONTHLY_PASS_TABLES.filter(sql => /^CREATE /i.test(sql)), ...MONTHLY_PASS_OPERATIONS_SCHEMA] });
  env = { ...makeEnv(d), SESSION_SECRET: SECRET, ADMIN_SECRET: "monthly-admin-secret" };
  await seedDevice(d, { balance_usd: 123, model_scope: "whitelist" });
  await seedDevice(d, { id: OTHER_ID, token_hash: await hashToken(OTHER_TOKEN), balance_usd: 456 });
  d.sql("UPDATE devices SET password_hash = 'not-a-secret-hash-fixture', password_updated_at = 1");
  d.sql("INSERT INTO device_sub_tokens (id, device_id, name, token_hash, enabled, created_at) VALUES ('monthly-sub', ?, 'Sub', ?, 1, 1)", DEVICE_ID, await hashToken(SUB_TOKEN));
  seedProvider(d, { api_key: "monthly-upstream-private-secret" });
  adminCookie = buildSessionCookie(await signSession(SECRET)).split(";")[0];
  ownerCookie = buildUserSessionCookie(await signUserSession(SECRET, DEVICE_ID, 1)).split(";")[0];
  otherCookie = buildUserSessionCookie(await signUserSession(SECRET, OTHER_ID, 1)).split(";")[0];
});
afterEach(() => { vi.restoreAllMocks(); d?.close(); });

describe("monthly API complete-app authorization", () => {
  it("protects every admin route with admin authentication, not a master token or owner session", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["/plans", "GET"], ["/plans", "POST", input()], ["/plans/missing", "PUT", input()],
      ["/accounts", "GET"], ["/accounts/" + DEVICE_ID, "GET"],
      ["/accounts/" + DEVICE_ID + "/issue", "POST", { plan_id: "missing", operation_id: crypto.randomUUID() }],
      ["/subscriptions/missing/stop", "POST", {}], ["/subscriptions/missing/renew", "POST", { operation_id: crypto.randomUUID() }],
      ["/accounts/" + DEVICE_ID + "/wallet-fallback", "PUT", { enabled: true }],
    ];
    for (const [path, method, body] of routes) {
      expect((await request(BASE + path, method, body)).status, path).toBe(401);
      expect((await request(BASE + path, method, body, { authorization: "Bearer " + TOKEN, cookie: ownerCookie })).status, path).toBe(401);
    }
    expect(auditRows()).toEqual([]);
  });
  it("requires master for reads, and master plus matching password session for fallback writes", async () => {
    for (const method of ["GET", "PUT"]) {
      const suffix = method === "GET" ? "" : "/wallet-fallback";
      const body = method === "GET" ? undefined : { enabled: true };
      expect((await request("/console/monthly-pass" + suffix, method, body)).status).toBe(401);
      expect((await consoleRequest(suffix, method, body, SUB_TOKEN)).status).toBe(403);
      expect((await request("/console/monthly-pass" + suffix, method, body, { cookie: adminCookie })).status).toBe(401);
    }
    expect((await consoleRequest("", "GET", undefined, TOKEN, "")).status).toBe(200);
    expect((await consoleRequest("/wallet-fallback", "PUT", { enabled: true }, TOKEN, "")).status).toBe(401);
    expect((await consoleRequest("/wallet-fallback", "PUT", { enabled: true }, TOKEN, otherCookie)).status).toBe(401);
    expect((await account()).wallet_fallback).toBe(false);
    expect(auditRows()).toEqual([]);
  });
});

describe("monthly plans strict input and envelopes", () => {
  it("creates, lists and replaces a plan and rejects partial updates", async () => {
    const plan = await create();
    expect(plan).toMatchObject(input()); expect(plan.id).toEqual(expect.any(String));
    expect(await (await admin("/plans")).json()).toEqual({ items: [plan] });
    const updated = input({ name: "Replacement", enabled: 0, limits: { daily_usd: null, weekly_usd: null, five_hour_usd: null, total_usd: 1e9 }, service_group_ids: [] });
    const response = await admin("/plans/" + plan.id, "PUT", updated);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ item: { id: plan.id, ...updated } });
    expect((await admin("/plans/" + plan.id, "PUT", { name: "Partial" })).status).toBe(400);
    expect((await admin("/plans/missing", "PUT", input())).status).toBe(404);
    expect(auditRows().map(row => row.action)).toEqual(["monthly_pass.plan.create", "monthly_pass.plan.update"]);
  });
  const invalid: Array<[string, unknown]> = [
    ["missing fields", {}], ["unknown field", { ...input(), secret: "do-not-store" }],
    ["empty name", input({ name: "" })], ["blank name", input({ name: "   " })], ["long name", input({ name: "x".repeat(101) })],
    ["boolean enabled", { ...input(), enabled: true }], ["other enabled", { ...input(), enabled: 2 }],
    ["all null limits", input({ limits: { daily_usd: null, weekly_usd: null, five_hour_usd: null, total_usd: null } })],
    ["extra limit", { ...input(), limits: { ...input().limits, secret: 1 } }],
    ["missing limit", { ...input(), limits: { total_usd: 1 } }],
    ["zero limit", input({ limits: { ...input().limits, daily_usd: 0 } })],
    ["negative limit", input({ limits: { ...input().limits, weekly_usd: -1 } })],
    ["over max", input({ limits: { ...input().limits, total_usd: 1e9 + 1 } })],
    ["string amount", { ...input(), limits: { ...input().limits, daily_usd: "1" } }],
    ["too many groups", input({ service_group_ids: Array.from({ length: 101 }, (_, i) => "g" + i) })],
    ["blank group id", input({ service_group_ids: [" "] })], ["nonstring group id", { ...input(), service_group_ids: [1] }],
  ];
  it.each(invalid)("rejects %s without audit or persisted plan", async (_label, value) => {
    const response = await admin("/plans", "POST", value);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: "validation_error" });
    expect(await (await admin("/plans")).json()).toEqual({ items: [] }); expect(auditRows()).toEqual([]);
  });
  it("accepts exactly one positive limit, one-character names, and the 100-character boundary", async () => {
    const limits = { daily_usd: null, weekly_usd: null, five_hour_usd: 0.01, total_usd: null };
    expect(await create(input({ name: "a", limits }))).toMatchObject({ name: "a", limits });
    expect(await create(input({ name: "b".repeat(100), limits }))).toMatchObject({ name: "b".repeat(100), limits });
  });
  it("accepts the maximum 100 existing scoped group IDs without granting account routes", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => "monthly-scope-" + i);
    for (const id of ids) d.sql("INSERT INTO service_groups(id,name,enabled,selectable,public_selectable,multiplier,revision) VALUES(?,?,1,1,0,1,1)", id, id);
    const plan = await create(input({ service_group_ids: ids }));
    expect(plan.service_group_ids).toEqual(ids);
    await issue(plan.id);
    expect(d.rows("SELECT * FROM device_service_groups")).toEqual([]);
  });
  it("rejects malformed JSON and non-finite JSON numbers before persistence", async () => {
    const malformed = await app.request("https://monthly.test" + BASE + "/plans", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: "{" }, env);
    expect(malformed.status).toBe(400); expect(await malformed.json()).toMatchObject({ error: "invalid_json" });
    const raw = JSON.stringify(input()).replace('"daily_usd":2', '"daily_usd":1e999');
    const infinite = await app.request("https://monthly.test" + BASE + "/plans", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: raw }, env);
    expect(infinite.status).toBe(400); expect(auditRows()).toEqual([]);
  });
});

describe("monthly account lifecycle and audit", () => {
  it("starts with fallback off, issues thirty days without money or route grants, and renews/stops only entitlements", async () => {
    expect(await account()).toEqual({ device_id: DEVICE_ID, wallet_fallback: false, subscription: null });
    const deviceBefore = d.row("SELECT * FROM devices WHERE id=?", DEVICE_ID);
    const walletBefore = d.rows("SELECT * FROM device_wallets ORDER BY device_id");
    const plan = await create(); const sub = await issue(plan.id);
    expect(sub).toMatchObject({ device_id: DEVICE_ID, plan_id: plan.id, plan_name: plan.name, enabled: 1, limits: plan.limits, service_group_ids: null });
    expect(sub.expires_at - sub.starts_at).toBe(30 * DAY);
    expect(sub).not.toHaveProperty("windows");
    expect((await account()).subscription?.windows).toHaveLength(4);
    const renewed = await admin("/subscriptions/" + sub.id + "/renew", "POST", { operation_id: crypto.randomUUID() });
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toMatchObject({ item: { id: sub.id, starts_at: sub.starts_at, expires_at: sub.expires_at + 30 * DAY, limits: sub.limits } });
    expect((await admin("/subscriptions/" + sub.id + "/stop", "POST", {})).status).toBe(200);
    expect((await account()).subscription).toMatchObject({ id: sub.id, enabled: 0 });
    expect(d.row("SELECT * FROM devices WHERE id=?", DEVICE_ID)).toEqual(deviceBefore);
    expect(d.rows("SELECT * FROM device_wallets ORDER BY device_id")).toEqual(walletBefore);
    expect(d.rows("SELECT * FROM device_service_groups")).toEqual([]);
    expect(d.rows("SELECT * FROM device_models")).toEqual([]);
    expect(auditRows().map(row => row.action)).toEqual(["monthly_pass.plan.create", "monthly_pass.issue", "monthly_pass.renew", "monthly_pass.stop"]);
    for (const row of auditRows()) { expect(row.actor_type).toBe("admin"); expect(row.ip).toBe("192.0.2.44"); expect(row.target_id).toBeTruthy(); }
  });
  it("keeps existing snapshot and bucket usage on an in-period renewal, without granting scoped routes", async () => {
    d.sql("INSERT INTO service_groups(id,name,enabled,selectable,public_selectable,multiplier,revision) VALUES('monthly-private','Private',1,1,0,1,1)");
    const plan = await create(input({ service_group_ids: ["monthly-private"] }));
    const sub = await issue(plan.id);
    const windows = (await account()).subscription!.windows;
    for (const window of windows) d.sql("INSERT INTO monthly_pass_buckets(subscription_id,kind,starts_at,ends_at,limit_usd,used_usd,reserved_usd) VALUES(?,?,?,?,?,?,?)", sub.id, window.kind, window.starts_at, window.ends_at, window.limit_usd, 0.25, 0.1);
    expect((await admin("/plans/" + plan.id, "PUT", input({ name: "Future only", limits: { daily_usd: null, weekly_usd: null, five_hour_usd: null, total_usd: 999 } }))).status).toBe(200);
    expect((await admin("/subscriptions/" + sub.id + "/renew", "POST", { operation_id: crypto.randomUUID() })).status).toBe(200);
    const current = (await account()).subscription!;
    expect(current).toMatchObject({ id: sub.id, plan_name: plan.name, limits: plan.limits, service_group_ids: ["monthly-private"], expires_at: sub.expires_at + 30 * DAY });
    for (const window of current.windows) {
      expect(window.used_usd).toBe(0.25); expect(window.reserved_usd).toBe(0.1);
      expect(window.remaining_usd).toBeCloseTo(window.limit_usd - 0.35);
    }
    expect(d.rows("SELECT * FROM device_service_groups")).toEqual([]);
  });
  it("expired renewal creates a new subscription cycle identifier", async () => {
    const plan = await create(); const sub = await issue(plan.id);
    clock.mockReturnValue(sub.expires_at + 1);
    adminCookie = buildSessionCookie(await signSession(SECRET)).split(";")[0];
    const response = await admin("/subscriptions/" + sub.id + "/renew", "POST", { operation_id: crypto.randomUUID() });
    expect(response.status).toBe(200);
    const next = (await response.json() as { item: Subscription }).item;
    expect(next.id).not.toBe(sub.id); expect(next.expires_at - next.starts_at).toBe(30 * DAY);
    expect((await account()).subscription?.id).toBe(next.id);
  });
  it("validates issue, stop, renew, and fallback bodies strictly with no rejected-action audit", async () => {
    const plan = await create(); const sub = await issue(plan.id); const before = auditRows().length;
    for (const [path, method, body] of [
      ["/accounts/" + DEVICE_ID + "/issue", "POST", { plan_id: plan.id, device_id: OTHER_ID }],
      ["/accounts/" + DEVICE_ID + "/issue", "POST", {}],
      ["/subscriptions/" + sub.id + "/stop", "POST", { enabled: false }],
      ["/subscriptions/" + sub.id + "/renew", "POST", { days: 365 }],
      ["/accounts/" + DEVICE_ID + "/wallet-fallback", "PUT", { enabled: 1 }],
      ["/accounts/" + DEVICE_ID + "/wallet-fallback", "PUT", { enabled: true, device_id: OTHER_ID }],
    ] as Array<[string, string, unknown]>) expect((await admin(path, method, body)).status, path).toBe(400);
    expect(auditRows()).toHaveLength(before); expect((await account()).subscription?.enabled).toBe(1);
    expect((await admin("/subscriptions/missing/stop", "POST", {})).status).toBe(404);
    expect((await admin("/subscriptions/missing/renew", "POST", { operation_id: crypto.randomUUID() })).status).toBe(404);
  });
  it("lists account DTOs without account, wallet or upstream secrets", async () => {
    const plan = await create(); await issue(plan.id);
    const response = await admin("/accounts"); expect(response.status).toBe(200);
    const text = await response.text(); const body = JSON.parse(text) as { items: Account[] };
    expect(body.items).toHaveLength(1);
    expect(body.items.find(item => item.device_id === OTHER_ID)).toBeUndefined();  
    for (const forbidden of [TOKEN, OTHER_TOKEN, SUB_TOKEN, SECRET, "password_hash", "token_hash", "monthly-upstream-private-secret", "balance_usd"]) expect(text).not.toContain(forbidden);
  });
});

describe("monthly operation API contract", () => {
  it("requires nonempty bounded operation keys and rejects arbitrary client actor scope", async () => {
    const plan = await create(); const sub = await issue(plan.id); const before = auditRows().length;
    for (const key of [undefined, null, "", "   ", 7, "x".repeat(201)]) {
      expect((await admin("/accounts/" + OTHER_ID + "/issue", "POST", { plan_id: plan.id, operation_id: key })).status).toBe(400);
      expect((await admin("/subscriptions/" + sub.id + "/renew", "POST", { operation_id: key })).status).toBe(400);
    }
    for (const body of [{ operation_id: "key", actor_scope: "attacker" }, { operation_id: "key", device_id: OTHER_ID }])
      expect((await admin("/subscriptions/" + sub.id + "/renew", "POST", body)).status).toBe(400);
    expect(auditRows()).toHaveLength(before);
    const response = await admin("/subscriptions/" + sub.id + "/renew", "POST", { operation_id: "x".repeat(200) });
    expect(response.status).toBe(200);
  });
  it("replays issue201 and renew200 with byte-identical public envelopes and exactly one audit each", async () => {
    const plan = await create(); const key = crypto.randomUUID();
    const first = await admin("/accounts/" + DEVICE_ID + "/issue", "POST", { plan_id: plan.id, operation_id: key });
    const issueText = await first.text(); expect(first.status).toBe(201); const sub = JSON.parse(issueText).item as Subscription;
    const renewKey = crypto.randomUUID();
    const renewal = await admin("/subscriptions/" + sub.id + "/renew", "POST", { operation_id: renewKey });
    const renewText = await renewal.text(); expect(renewal.status).toBe(200);
    await admin("/subscriptions/" + sub.id + "/stop", "POST", {});
    await issue(plan.id);
    const replayIssue = await admin("/accounts/" + DEVICE_ID + "/issue", "POST", { plan_id: plan.id, operation_id: " " + key + " " });
    const replayRenew = await admin("/subscriptions/" + sub.id + "/renew", "POST", { operation_id: renewKey });
    expect(replayIssue.status).toBe(201); expect(await replayIssue.text()).toBe(issueText);
    expect(replayRenew.status).toBe(200); expect(await replayRenew.text()).toBe(renewText);
    expect(auditRows().filter(r=>r.action==="monthly_pass.issue")).toHaveLength(2);
    expect(auditRows().filter(r=>r.action==="monthly_pass.renew")).toHaveLength(1);
    const evidence = d.row<{actor_scope:string}>("SELECT actor_scope FROM monthly_pass_operations WHERE operation_id=?", key);
    expect(evidence).toEqual({ actor_scope: "admin:session" });
  });
  it("returns409 for key reuse on another account, action, or plan, regardless of spoofed identity headers", async () => {
    const plan = await create(); const otherPlan = await create(input({ name: "Other" })); const key = crypto.randomUUID();
    const first = await admin("/accounts/" + DEVICE_ID + "/issue", "POST", { plan_id: plan.id, operation_id: key });
    const sub = (await first.json() as {item:Subscription}).item; const before = auditRows().length;
    const conflicts = [
      ["/accounts/" + OTHER_ID + "/issue", { plan_id: plan.id, operation_id: key }],
      ["/accounts/" + DEVICE_ID + "/issue", { plan_id: otherPlan.id, operation_id: key }],
      ["/subscriptions/" + sub.id + "/renew", { operation_id: key }],
    ] as const;
    for (const [path,body] of conflicts) {
      const response = await request(BASE + path, "POST", body, { cookie: adminCookie, "cf-access-authenticated-user-email": "arbitrary@example.test", "x-operation-scope": "arbitrary" });
      expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "monthly_operation_conflict" });
    }
    expect(auditRows()).toHaveLength(before);
  });
  it("binds global operation IDs to the single middleware-verified Access principal", async () => {
    const plan=await create();env.CF_ACCESS_ALLOWED_EMAILS="a@example.test,b@example.test";
    const verifier=vi.spyOn(cfAccess,"verifyCfAccessJwt").mockImplementation(async token=>token==="verified-a"?{email:"A@EXAMPLE.TEST"}:token==="verified-b"?{email:"b@example.test"}:null);
    const access=(deviceId:string,token:string,key="same-principal-key")=>request(BASE+"/accounts/"+deviceId+"/issue","POST",{plan_id:plan.id,operation_id:key},{"cf-access-jwt-assertion":token,"cf-access-authenticated-user-email":"untrusted@example.test"});
    expect((await access(DEVICE_ID,"verified-a")).status).toBe(201);expect(verifier).toHaveBeenCalledTimes(1);
    expect((await access(OTHER_ID,"verified-b")).status).toBe(409);
    expect((await access(OTHER_ID,"verified-b","separate-key")).status).toBe(201);
    expect(d.rows("SELECT actor_scope FROM monthly_pass_operations WHERE operation_id='same-principal-key'")).toEqual([{actor_scope:"admin:access:a@example.test"}]);
    const refused=await access(OTHER_ID,"verified-a");expect(refused.status).toBe(409);expect(await refused.json()).toEqual({error:"monthly_operation_conflict"});
    expect(auditRows().filter(r=>r.action==="monthly_pass.issue")).toHaveLength(2);
  });
  it("affected-row-zero renewal returns409 with no success audit", async () => {
    const plan = await create(); const sub = await issue(plan.id); const before = auditRows().length;
    d.sql("CREATE TRIGGER ignore_api_renew BEFORE UPDATE OF expires_at ON monthly_pass_subscriptions BEGIN SELECT RAISE(IGNORE); END");
    const response = await admin("/subscriptions/" + sub.id + "/renew", "POST", { operation_id: crypto.randomUUID() });
    expect(response.status).toBe(409);expect(await response.json()).toEqual({ error: "monthly_subscription_not_current" });expect(auditRows()).toHaveLength(before);
  });
  it("audit storage failure is an opaque500 and rolls back claim and entitlement instead of reporting success", async () => {
    const plan = await create(); const before = auditRows().length; const key = crypto.randomUUID();
    d.sql("CREATE TRIGGER fail_api_audit BEFORE INSERT ON audit_logs WHEN NEW.action='monthly_pass.issue' BEGIN SELECT RAISE(ABORT,'monthly_private_audit_failure'); END");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await admin("/accounts/" + DEVICE_ID + "/issue", "POST", { plan_id: plan.id, operation_id: key });
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "internal_server_error" });
    expect(d.row("SELECT * FROM monthly_pass_operations WHERE operation_id=?", key)).toBeNull();
    expect((await account()).subscription).toBeNull(); expect(auditRows()).toHaveLength(before);
  });
});

describe("monthly domain refusals versus storage failures", () => {
  it("returns exact known business errors without success audits", async () => {
    const plan = await create(); const sub = await issue(plan.id); const before = auditRows().length;
    const duplicate = await admin("/accounts/" + DEVICE_ID + "/issue", "POST", { plan_id: plan.id, operation_id: crypto.randomUUID() });
    expect(duplicate.status).toBe(409); expect(await duplicate.json()).toEqual({ error: "monthly_pass_already_active" });
    const missingPlan = await admin("/accounts/" + OTHER_ID + "/issue", "POST", { plan_id: "missing", operation_id: crypto.randomUUID() });
    expect(missingPlan.status).toBe(404); expect(await missingPlan.json()).toEqual({ error: "monthly_plan_not_found" });
    const missingAccount = await admin("/accounts/missing/issue", "POST", { plan_id: plan.id, operation_id: crypto.randomUUID() });
    expect(missingAccount.status).toBe(404); expect(await missingAccount.json()).toEqual({ error: "monthly_account_not_found" });
    const badScope = await admin("/plans", "POST", input({ service_group_ids: ["missing"] }));
    expect(badScope.status).toBe(400); expect(await badScope.json()).toEqual({ error: "monthly_scope_not_found" });
    expect((await account()).subscription?.id).toBe(sub.id); expect(auditRows()).toHaveLength(before);
  });
  it("never swallows real database exceptions or unrecognized monthly-prefixed messages as business refusals", async () => {
    await create();  
    const before = auditRows().length;
    const original = d.DB.prepare.bind(d.DB);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const message of ["SQLITE_IOERR private-storage-detail", "monthly_unrecognized_storage_failure"]) {
      d.DB.prepare = (sql: string) => {
        if (/monthly_pass_plans/.test(sql)) throw new Error(message);
        return original(sql);
      };
      const response = await admin("/plans", "POST", input());
      expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "internal_server_error" });
    }
    d.DB.prepare = original;
    expect(auditRows()).toHaveLength(before);
    d.DB.prepare = (sql: string) => {
      if (/monthly_pass_accounts/.test(sql)) throw new Error("SQLITE_IOERR console-private-storage-detail");
      return original(sql);
    };
    const response = await consoleRequest();
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "internal_server_error" });
    d.DB.prepare = original;
    expect(auditRows()).toHaveLength(before);
  });
});

describe("monthly console owner isolation", () => {
  it("derives both reads and writes exclusively from authenticated owner and audits console separately", async () => {
    const plan = await create(); await issue(plan.id);
    const read = await consoleRequest("?device_id=" + OTHER_ID, "GET", undefined, TOKEN, "");
    expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ item: { device_id: DEVICE_ID, wallet_fallback: false, subscription: { plan_id: plan.id } } });
    const otherRead = await consoleRequest("", "GET", undefined, OTHER_TOKEN, "");
    expect(await otherRead.json()).toEqual({ item: { device_id: OTHER_ID, wallet_fallback: false, subscription: null } });
    const rejected = await consoleRequest("/wallet-fallback", "PUT", { enabled: true, device_id: OTHER_ID });
    expect(rejected.status).toBe(400);
    expect((await consoleRequest("/wallet-fallback", "PUT", { enabled: "true" })).status).toBe(400);
    const enabled = await consoleRequest("/wallet-fallback?device_id=" + OTHER_ID, "PUT", { enabled: true });
    expect(enabled.status).toBe(200); expect(await enabled.json()).toMatchObject({ item: { device_id: DEVICE_ID, wallet_fallback: true } });
    expect((await account(OTHER_ID)).wallet_fallback).toBe(false);
    expect((await consoleRequest("/wallet-fallback", "PUT", { enabled: false }, OTHER_TOKEN, otherCookie)).status).toBe(404);
    const consoleAudits = auditRows().filter(row => row.actor_type === "console");
    expect(consoleAudits).toHaveLength(1);
    expect(consoleAudits[0]).toMatchObject({ action: "monthly_pass.wallet_fallback.update", target_id: DEVICE_ID, ip: "192.0.2.44" });
    expect(JSON.parse(consoleAudits[0].details_json)).toEqual({ device_id: DEVICE_ID, wallet_fallback: true });
    const auditText = JSON.stringify(auditRows());
    for (const secret of [TOKEN, OTHER_TOKEN, SUB_TOKEN, SECRET, "monthly-upstream-private-secret", "password_hash", "token_hash"]) expect(auditText).not.toContain(secret);
  });
  it("supports administrator explicit fallback updates only after issuance with admin actor", async () => {
    expect((await admin("/accounts/" + DEVICE_ID + "/wallet-fallback", "PUT", { enabled: true })).status).toBe(404);
    const plan=await create(); await issue(plan.id);
    const response = await admin("/accounts/" + DEVICE_ID + "/wallet-fallback", "PUT", { enabled: true });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ item: { device_id: DEVICE_ID, wallet_fallback: true, subscription: {plan_id:plan.id} } });
    expect(auditRows().filter(r=>r.action==="monthly_pass.wallet_fallback.update")).toMatchObject([{ actor_type: "admin", action: "monthly_pass.wallet_fallback.update", target_id: DEVICE_ID }]);
  });
});
