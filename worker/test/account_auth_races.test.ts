import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consoleApp } from "../src/console";
import { resetDevicePassword, setDevicePassword } from "../src/db/repo";
import { buildUserSessionCookie, hashToken, signSession, signUserSession, verifyPassword } from "../src/utils/crypto";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { createRealD1, makeEnv, seedDevice, DEVICE_ID, TOKEN } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";

type Db = ReturnType<typeof createRealD1>;
const SECRET = "local-auth-races-secret";
const PASSWORD = "first-password";
const databases: Db[] = [];
beforeEach(() => resetRateLimitMemory());
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

async function fixture() {
  const db = createRealD1(); databases.push(db);
  await seedDevice(db);
  const env: Env = { ...makeEnv(db), SESSION_SECRET: SECRET };
  return { db, env };
}
function request(env: Env, path: string, body?: unknown, extra: Record<string, string> = {}, token = TOKEN) {
  return consoleApp.request("http://gw.test" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json", ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}
async function setup(env: Env, password = PASSWORD) {
  const response = await request(env, "/auth/setup", { password });
  expect(response.status).toBe(200);
  return { response, body: await response.clone().json() as { session: string; password_updated_at: number }, cookie: response.headers.get("set-cookie")!.split(";")[0] };
}
async function assertAccess(env: Env, extra: Record<string, string>, allowed: boolean, token = TOKEN) {
  const session = await request(env, "/auth/session", undefined, extra, token);
  expect(session.status).toBe(200);
  expect((await session.json() as { authenticated: boolean }).authenticated).toBe(allowed);
  const operation = await request(env, "/tokens", undefined, extra, token);
  expect(operation.status).toBe(allowed ? 200 : 401);
  expect(operation.headers.get("set-cookie")).toBeNull();
  if (!allowed) expect((await operation.json() as { error: string }).error).toBe("password_required");
}

function holdPasswordWrites(db: Db, count: number) {
  let arrived = 0;
  let reached!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prepare = db.DB.prepare.bind(db.DB);
  db.DB.prepare = (sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith("UPDATE devices SET password_hash = ?")) {
      const first = statement.first.bind(statement);
      const run = statement.run.bind(statement);
      const wait = async () => { if (++arrived === count) reached(); await gate; };
      statement.first = async () => { await wait(); return first(); };
      statement.run = async () => { await wait(); return run(); };
    }
    return statement;
  };
  return { ready, release };
}

describe("atomic first-time password setup", () => {
  it("allows exactly one concurrent winner, returns no credential to losers and audits once", async () => {
    const { db, env } = await fixture();
    const barrier = holdPasswordWrites(db, 4);
    const passwords = ["password-one", "password-two", "password-three", "password-four"];
    const pending = passwords.map(password => request(env, "/auth/setup", { password }));
    await barrier.ready;
    barrier.release();
    const responses = await Promise.all(pending);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409, 409, 409]);
    const winner = responses.findIndex(r => r.status === 200);
    const stored = db.row<{ password_hash: string }>("SELECT password_hash FROM devices WHERE id = ?", DEVICE_ID)!;
    expect(await Promise.all(passwords.map(password => verifyPassword(password, stored.password_hash))))
      .toEqual(passwords.map((_, index) => index === winner));
    for (const response of responses.filter(r => r.status !== 200)) {
      expect(response.headers.get("set-cookie")).toBeNull();
      const body = await response.json() as { error: string; session?: string };
      expect(body.error).toBe("password_setup_conflict");
      expect(body.session).toBeUndefined();
    }
    expect(db.rows("SELECT id FROM audit_logs WHERE action = 'console.password_setup'")).toHaveLength(1);
    await assertAccess(env, { cookie: responses[winner].headers.get("set-cookie")!.split(";")[0] }, true);
  });

  it("rejects a reset that changes the observed empty-password version while hashing", async () => {
    const { db, env } = await fixture();
    const barrier = holdPasswordWrites(db, 1);
    const pending = request(env, "/auth/setup", { password: PASSWORD });
    await barrier.ready;
    const resetVersion = await resetDevicePassword(env, DEVICE_ID);
    barrier.release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(db.row("SELECT password_hash, password_updated_at FROM devices WHERE id = ?", DEVICE_ID))
      .toMatchObject({ password_hash: null, password_updated_at: resetVersion });
    expect(db.rows("SELECT id FROM audit_logs WHERE action = 'console.password_setup'")).toHaveLength(0);
    const retry = await setup(env);
    expect(retry.body.password_updated_at).toBeGreaterThan(resetVersion!);
  });

  it("returns 404 if the account is removed before the conditional write", async () => {
    const { db, env } = await fixture();
    const barrier = holdPasswordWrites(db, 1);
    const pending = request(env, "/auth/setup", { password: PASSWORD });
    await barrier.ready;
    db.sql("DELETE FROM device_wallets WHERE device_id = ?", DEVICE_ID);
    db.sql("DELETE FROM devices WHERE id = ?", DEVICE_ID);
    barrier.release();
    const response = await pending;
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await response.json() as { session?: string }).session).toBeUndefined();
  });

  it("does not overwrite a populated password even when its version matches", async () => {
    const { db, env } = await fixture();
    const original = await setup(env);
    const stored = db.row("SELECT password_hash FROM devices WHERE id = ?", DEVICE_ID);
    expect(await setDevicePassword(env, DEVICE_ID, "must-not-be-written", original.body.password_updated_at))
      .toEqual({ status: "conflict" });
    expect(db.row("SELECT password_hash FROM devices WHERE id = ?", DEVICE_ID)).toEqual(stored);
  });

  it("requires a null-safe matching version and supports legacy empty-string hashes", async () => {
    const { db, env } = await fixture();
    expect(await setDevicePassword(env, DEVICE_ID, "not-written", 0)).toEqual({ status: "conflict" });
    db.sql("UPDATE devices SET password_hash = '' WHERE id = ?", DEVICE_ID);
    const created = await setup(env);
    expect(await verifyPassword(PASSWORD, db.row<{ password_hash: string }>("SELECT password_hash FROM devices WHERE id = ?", DEVICE_ID)!.password_hash)).toBe(true);
    expect(created.body.password_updated_at).toBeGreaterThan(0);
  });

  it("rejects sessions while cleared and advances setup version even in the same millisecond", async () => {
    const { env } = await fixture();
    vi.spyOn(Date, "now").mockReturnValue(1800000000000);
    const old = await setup(env);
    await resetDevicePassword(env, DEVICE_ID);
    await assertAccess(env, { cookie: old.cookie, "x-console-session": old.body.session }, false);
    const fresh = await setup(env, "next-password");
    expect(fresh.body.password_updated_at).toBe(old.body.password_updated_at + 1);
    await assertAccess(env, { cookie: old.cookie }, false);
    await assertAccess(env, { cookie: old.cookie, "x-console-session": fresh.body.session }, true);
  });

  it("advances from a future version instead of reusing an older wall clock", async () => {
    const { db, env } = await fixture();
    const future = Date.now() + 60000;
    db.sql("UPDATE devices SET password_updated_at = ? WHERE id = ?", future, DEVICE_ID);
    const fresh = await setup(env);
    expect(fresh.body.password_updated_at).toBe(future + 1);
  });
});

describe("account-bound cookie/header session selection", () => {
  it("accepts valid cookie-only, header-only and both paths", async () => {
    const { env } = await fixture(); const current = await setup(env);
    await assertAccess(env, { cookie: current.cookie }, true);
    await assertAccess(env, { "x-console-session": current.body.session }, true);
    await assertAccess(env, { cookie: current.cookie, "x-console-session": current.body.session }, true);
  });

  it("falls back from a signed stale-version cookie to a freshly issued login header", async () => {
    const { db, env } = await fixture();
    const old = await setup(env);
    db.sql("UPDATE devices SET password_updated_at = ? WHERE id = ?", old.body.password_updated_at + 1, DEVICE_ID);
    const login = await request(env, "/auth/login", { password: PASSWORD });
    expect(login.status).toBe(200);
    const body = await login.json() as { session: string };
    await assertAccess(env, { cookie: old.cookie }, false);
    await assertAccess(env, { cookie: old.cookie, "x-console-session": body.session }, true);
  });

  it("keeps two accounts usable with their own per-tab headers despite the shared cookie", async () => {
    const { db, env } = await fixture(); const a = await setup(env);
    const tokenB = "ccs_second_local_account";
    await seedDevice(db, { id: "dev-b", token_hash: await hashToken(tokenB) });
    const response = await request(env, "/auth/setup", { password: PASSWORD }, {}, tokenB);
    expect(response.status).toBe(200);
    const b = await response.json() as { session: string };
    const cookieB = response.headers.get("set-cookie")!.split(";")[0];
    await assertAccess(env, { cookie: a.cookie, "x-console-session": b.session }, true, tokenB);
    await assertAccess(env, { cookie: cookieB, "x-console-session": a.body.session }, true);
    await assertAccess(env, { cookie: a.cookie }, false, tokenB);
    await assertAccess(env, { "x-console-session": a.body.session }, false, tokenB);
  });

  it.each(["expired", "tampered", "admin"])("ignores a %s cookie when the header is valid", async kind => {
    const { env } = await fixture(); const current = await setup(env);
    let invalid: string;
    if (kind === "expired") {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 8 * 86400000);
      invalid = await signUserSession(SECRET, DEVICE_ID, current.body.password_updated_at);
      clock.mockRestore();
    } else if (kind === "admin") invalid = await signSession(SECRET);
    else invalid = current.body.session + "x";
    await assertAccess(env, { cookie: buildUserSessionCookie(invalid), "x-console-session": current.body.session }, true);
    await assertAccess(env, { cookie: buildUserSessionCookie(invalid), "x-console-session": invalid }, false);
  });

  it("does not let an invalid header suppress a fully matching cookie", async () => {
    const { env } = await fixture(); const current = await setup(env);
    await assertAccess(env, { cookie: current.cookie, "x-console-session": "invalid" }, true);
  });

  it("rejects empty credentials, wrong-version headers and valid sessions for a passwordless account", async () => {
    const { env } = await fixture();
    const passwordless = await signUserSession(SECRET, DEVICE_ID, null);
    await assertAccess(env, { "x-console-session": passwordless }, false);
    const current = await setup(env);
    const stale = await signUserSession(SECRET, DEVICE_ID, current.body.password_updated_at - 1);
    await assertAccess(env, {}, false);
    await assertAccess(env, { "x-console-session": stale }, false);
  });

  it.each(["disabled", "revoked", "sub"])("does not relax the %s token restriction", async kind => {
    const { db, env } = await fixture(); const current = await setup(env);
    const headers = { "x-console-session": current.body.session };
    let token = TOKEN;
    if (kind === "disabled") db.sql("UPDATE devices SET enabled = 0 WHERE id = ?", DEVICE_ID);
    else if (kind === "revoked") db.sql("UPDATE devices SET revoked_at = 1 WHERE id = ?", DEVICE_ID);
    else {
      token = "ccs_sub_local_review";
      db.sql("INSERT INTO device_sub_tokens (id, device_id, name, token_hash, enabled, created_at) VALUES (?, ?, ?, ?, 1, 1)", "sub-review", DEVICE_ID, "review", await hashToken(token));
    }
    for (const path of ["/auth/session", "/tokens"]) expect((await request(env, path, undefined, headers, token)).status).toBe(kind === "sub" ? 403 : 401);
  });
});
