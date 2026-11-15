import { afterEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin";
import { claimVideoDiagnostics, captureVideoDiagnostic, getVideoDiagnostics, pruneVideoDiagnostics,
  VIDEO_DIAGNOSTIC_ARM_MS, VIDEO_DIAGNOSTIC_RETENTION_MS, type VideoDiagnosticEvent } from "../src/db/video_diagnostics";
import { createVideoTask, type VideoTask } from "../src/db/video_tasks";
import { buildSessionCookie, openSecret, signSession } from "../src/utils/crypto";
import { INIT_STATEMENTS } from "../src/db/schema";
import { createRealD1 } from "./helpers/realD1";
import { makeWalletFixture } from "./helpers/walletFixture";

const signedUrl = "https://cdn.example/video.mp4?signature=keep-full-signature&token=signed-token";
async function setup() {
  const f = await makeWalletFixture({ deviceIds: ["dev-1", "other"] });
  f.env.ENCRYPTION_KEY = "diagnostic-test-encryption";
  f.env.SESSION_SECRET = "diagnostic-test-session";
  const cookie = buildSessionCookie(await signSession(f.env.SESSION_SECRET, 0)).split(";")[0];
  const admin = (path: string, input?: unknown, authenticated = true) => adminApp.request("https://gateway.test/video-tasks" + path, {
    method: input === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(authenticated ? { cookie } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }, f.env);
  const arm = (device_id = "dev-1") => admin("/diagnostics/arm", { device_id });
  const disarm = () => admin("/diagnostics/disarm", { device_id: "dev-1" });
  return { ...f, admin, arm, disarm };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function create(f: Fixture, patch: Partial<VideoTask> = {}) {
  const id = crypto.randomUUID();
  const t: VideoTask = { id, device_id: "dev-1", sub_token_id: null, idempotency_key: id, request_hash: "hash",
    status: "submitting", upstream_task_id: null, route_json: "{}", price_usd: 0, pricing_snapshot_json: "{}",
    result_url: null, error_code: null, poll_after: null, poll_lease_until: null,
    created_at: Date.now(), updated_at: Date.now(), ...patch };
  expect(await createVideoTask(f.env, t)).toBe(true);
  return t;
}
function event(patch: Partial<VideoDiagnosticEvent> = {}): VideoDiagnosticEvent {
  return { slot: "create", http_status: 200, content_type: "application/json; charset=utf-8", body: JSON.stringify({ task_id: "up-123", status: "queued" }), truncated: false, ...patch };
}
async function claimed(f: Fixture) {
  expect((await f.arm()).status).toBe(200);
  const t = await create(f);
  expect(await claimVideoDiagnostics(f.env, t.id)).toBe(true);
  return t;
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("opt-in video diagnostic sampling on real SQLite", () => {
  it("requires parent admin auth for every diagnostic route and never accepts a device bearer as admin", async () => {
    const f = await setup();
    for (const [path, input] of [["/diagnostics/arm", { device_id: "dev-1" }], ["/diagnostics/disarm", { device_id: "dev-1" }], ["/missing/diagnostics", undefined], ["/missing/diagnostics/export", undefined]] as const) {
      expect((await f.admin(path, input, false)).status).toBe(401);
    }
    expect(f.d1.rows("SELECT * FROM video_diagnostic_arms")).toHaveLength(0);
    const r = await adminApp.request("https://gateway.test/video-tasks/diagnostics/arm", { method: "POST",
      headers: { authorization: "Bearer dev-1", "content-type": "application/json" }, body: JSON.stringify({ device_id: "dev-1" }) }, f.env);
    expect(r.status).toBe(401);
  });
  it("arms only explicit existing accounts, rejects options and requires an encryption key", async () => {
    const f = await setup();
    for (const input of [{}, [], { device_id: "" }, { device_id: "dev-1", raw: true }, { device_id: 1 }, { __proto__: null }])
      expect((await f.admin("/diagnostics/arm", input)).status).toBe(400);
    expect((await f.arm("missing")).status).toBe(404);
    for (const key of [undefined, "", "   "]) {
      f.env.ENCRYPTION_KEY = key;
      expect((await f.arm()).status).toBe(503);
    }
    expect(f.d1.rows("SELECT * FROM video_diagnostic_arms")).toHaveLength(0);
    expect(f.d1.rows("SELECT * FROM audit_logs")).toHaveLength(0);
  });
  it("claims exactly once when the same account/task races and refuses absent, old and other-account tasks", async () => {
    const f = await setup();
    const old = await create(f);
    expect(await claimVideoDiagnostics(f.env, old.id)).toBe(false);
    expect((await f.arm()).status).toBe(200);
    expect(await claimVideoDiagnostics(f.env, "missing")).toBe(false);
    expect(await claimVideoDiagnostics(f.env, old.id)).toBe(false);
    const other = await create(f, { device_id: "other" });
    expect(await claimVideoDiagnostics(f.env, other.id)).toBe(false);
    const t = await create(f);
    expect((await Promise.all(Array.from({ length: 8 }, () => claimVideoDiagnostics(f.env, t.id)))).filter(Boolean)).toHaveLength(1);
    expect(await claimVideoDiagnostics(f.env, t.id)).toBe(false);
    expect(f.d1.rows("SELECT * FROM video_diagnostic_grants")).toHaveLength(1);
    const next = await create(f); expect(await claimVideoDiagnostics(f.env, next.id)).toBe(false);
  });
  it("lets only one of competing same-account tasks consume an arm", async () => {
    const f = await setup(); await f.arm();
    const a = await create(f), b = await create(f);
    expect((await Promise.all([claimVideoDiagnostics(f.env, a.id), claimVideoDiagnostics(f.env, b.id)])).sort()).toEqual([false, true]);
  });
  it("refuses pending/terminal/unknown tasks and never consumes a missing-key arm", async () => {
    const f = await setup(); await f.arm(); const t = await create(f);
    f.env.ENCRYPTION_KEY = undefined; expect(await claimVideoDiagnostics(f.env, t.id)).toBe(false);
    f.env.ENCRYPTION_KEY = "restored-key";
    for (const status of ["pending", "failed", "succeeded", "submission_unknown"]) {
      f.d1.sql("UPDATE video_tasks SET status = ? WHERE id = ?", status, t.id);
      expect(await claimVideoDiagnostics(f.env, t.id)).toBe(false);
    }
    expect(f.d1.row("SELECT task_id FROM video_diagnostic_arms")).toEqual({ task_id: null });
  });
  it("rearming/disarming never revokes prior bound grants and old tasks cannot consume new arms", async () => {
    const f = await setup(); const a = await claimed(f);
    const firstArm = f.d1.row("SELECT arm_id FROM video_diagnostic_arms")!.arm_id;
    expect((await f.disarm()).status).toBe(200);
    await captureVideoDiagnostic(f.env, a.id, event());
    expect((await f.arm()).status).toBe(200);
    expect(f.d1.row("SELECT arm_id FROM video_diagnostic_arms")!.arm_id).not.toBe(firstArm);
    expect(await claimVideoDiagnostics(f.env, a.id)).toBe(false);
    const b = await create(f); expect(await claimVideoDiagnostics(f.env, b.id)).toBe(true);
    await captureVideoDiagnostic(f.env, a.id, event({ slot: "terminal" }));
    await captureVideoDiagnostic(f.env, b.id, event());
    expect((await getVideoDiagnostics(f.env, a.id)).samples).toHaveLength(2);
    expect((await getVideoDiagnostics(f.env, b.id)).samples).toHaveLength(1);
    await f.arm(); await f.disarm();
    expect(f.d1.rows("SELECT * FROM video_diagnostic_arms")).toHaveLength(0);
    expect(f.d1.rows("SELECT * FROM video_diagnostic_grants")).toHaveLength(2);
  });
  it("enforces 24h arm expiry without needing the retention job", async () => {
    const f = await setup(); vi.useFakeTimers(); const now = Date.now(); await f.arm();
    expect(f.d1.row("SELECT enabled_until FROM video_diagnostic_arms")!.enabled_until).toBe(now + VIDEO_DIAGNOSTIC_ARM_MS);
    vi.setSystemTime(now + VIDEO_DIAGNOSTIC_ARM_MS); const t = await create(f);
    expect(await claimVideoDiagnostics(f.env, t.id)).toBe(false);
  });
  it("captures first-wins four slots only and no samples for unclaimed tasks", async () => {
    const f = await setup(); const t = await claimed(f); const unclaimed = await create(f);
    await captureVideoDiagnostic(f.env, unclaimed.id, event());
    await Promise.all(Array.from({ length: 8 }, (_, i) => captureVideoDiagnostic(f.env, t.id, event({ body: JSON.stringify({ first: i }) }))));
    await captureVideoDiagnostic(f.env, t.id, event({ slot: "create", body: JSON.stringify({ overwrite: true }) }));
    for (const slot of ["processing", "terminal", "error"] as const) await captureVideoDiagnostic(f.env, t.id, event({ slot }));
    await captureVideoDiagnostic(f.env, t.id, event({ slot: "bogus" as VideoDiagnosticEvent["slot"] }));
    const data = await getVideoDiagnostics(f.env, t.id);
    expect(data.samples).toHaveLength(4); expect(data.samples.find(s => s.slot === "create")!.body).not.toHaveProperty("overwrite");
    expect((await getVideoDiagnostics(f.env, unclaimed.id)).samples).toHaveLength(0);
    expect(() => f.d1.sql("INSERT INTO video_diagnostics SELECT task_id, 'bogus', http_status, content_type, body_sealed, truncated, captured_at, expires_at FROM video_diagnostics LIMIT 1")).toThrow();
  });
  it("encrypts recursive redaction, preserves usage/task/status and full signed URLs only inside ciphertext", async () => {
    const f = await setup(); const t = await claimed(f);
    const secret = "upstream-secret-unprefixed";
    const body = JSON.parse('{"__proto__":{"api_key":"prototype-secret"},"constructor":{"prototype":{"credential":"prototype-secret"}}}');
    Object.assign(body, { id: "up-123", status: "running", usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      nested: [{ Authorization: "Bearer bearer-secret", "X-API-Key": "api-secret", cookies: "cookie-secret", refresh_token: "token-secret", credentials: { value: "credential-secret" }, prompt: "private-prompt", revised_prompt: "private-revised" }],
      result: { url: signedUrl }, error: { message: "failed with " + secret, context: "provider says " + secret }, misc: secret });
    await captureVideoDiagnostic(f.env, t.id, event({ body: JSON.stringify(body), error_code: secret }), [secret]);
    const row = f.d1.row<{ body_sealed: string }>("SELECT body_sealed FROM video_diagnostics")!;
    expect(row.body_sealed).toMatch(/^enc:v1:/); expect(row.body_sealed).not.toContain(signedUrl);
    const plain = (await openSecret(row.body_sealed, f.env.ENCRYPTION_KEY))!;
    const parsed = JSON.parse(plain);
    expect(parsed.body.result.url).toBe(signedUrl);
    for (const value of [secret, "prototype-secret", "bearer-secret", "api-secret", "cookie-secret", "token-secret", "credential-secret", "private-prompt", "private-revised"])
      expect(plain).not.toContain(value);
    expect(parsed.body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
    expect(parsed.body.id).toBe("up-123"); expect(parsed.body.status).toBe("running");
    expect(parsed.body.nested).toHaveLength(1);
    expect(Object.prototype).not.toHaveProperty("api_key");
    const data = await getVideoDiagnostics(f.env, t.id);
    expect(JSON.stringify(data)).not.toContain("signature="); expect(JSON.stringify(data)).not.toContain("signed-token");
    expect(data.samples[0].body).toMatchObject({ result: { url: "[REDACTED_URL]" }, usage: { total_tokens: 30 } });
    expect(data.samples[0].error_code).toBe("[REDACTED]");
  });
  it("redacts scalar error prose even when the upstream uses an ordinary error string", async () => {
    const f = await setup(); const t = await claimed(f);
    await captureVideoDiagnostic(f.env, t.id, event({ body: JSON.stringify({ status: "FAILED", error: "Rejected content: private prompt" }) }));
    const data = JSON.stringify(await getVideoDiagnostics(f.env, t.id));
    expect(data).not.toContain("Rejected content: private prompt");
    expect(data).toContain("[REDACTED]");
  });
  it("redacts non-JSON, malformed/truncated JSON, error prose and credentials even when secrets are omitted", async () => {
    const f = await setup(); const t = await claimed(f);
    await captureVideoDiagnostic(f.env, t.id, event({ body: 'Authorization: Basic dXNlcjpwYXNz cookie=very-private prompt=hidden', error_code: 'Bearer leaked-credential' }));
    await captureVideoDiagnostic(f.env, t.id, event({ slot: "error", body: '{"api_key":"unterminated-secret', truncated: true }));
    await captureVideoDiagnostic(f.env, t.id, event({ slot: "terminal", body: JSON.stringify({ message: "unrecognizable-secret", info: "Bearer obvious-secret", download: signedUrl }) }));
    const data = JSON.stringify(await getVideoDiagnostics(f.env, t.id));
    for (const value of ["dXNlcjpwYXNz", "very-private", "hidden", "leaked-credential", "unterminated-secret", "unrecognizable-secret", "obvious-secret", signedUrl]) expect(data).not.toContain(value);
  });
  it("bounds UTF-8 plaintext after redaction and handles multibyte expansion without leaking fragments", async () => {
    const f = await setup(); const t = await claimed(f);
    await captureVideoDiagnostic(f.env, t.id, event({ body: JSON.stringify({ long: "😀".repeat(17000) }) }));
    await captureVideoDiagnostic(f.env, t.id, event({ slot: "processing", body: JSON.stringify({ long: "x".repeat(20000) }) }), ["x"]);
    await captureVideoDiagnostic(f.env, t.id, event({ slot: "terminal", body: JSON.stringify({ long: "中".repeat(21000) }) }));
    for (const row of f.d1.rows<{ body_sealed: string }>("SELECT body_sealed FROM video_diagnostics")) {
      const plain = (await openSecret(row.body_sealed, f.env.ENCRYPTION_KEY))!;
      expect(new TextEncoder().encode(plain).byteLength).toBeLessThanOrEqual(65536);
      expect(() => JSON.parse(plain)).not.toThrow();
    }
    const data = await getVideoDiagnostics(f.env, t.id);
    expect(data.samples.filter(s => s.truncated)).toHaveLength(2);
    expect(data.samples.find(s => s.slot === "terminal")!.truncated).toBe(false);
  });
  it("uses fixed 7d expiry from consumption, not capture, and refuses expired reads/writes before pruning", async () => {
    const f = await setup(); vi.useFakeTimers(); const now = Date.now(); const t = await claimed(f);
    vi.setSystemTime(now + VIDEO_DIAGNOSTIC_RETENTION_MS - 1);
    await captureVideoDiagnostic(f.env, t.id, event());
    expect(f.d1.row("SELECT expires_at FROM video_diagnostics")!.expires_at).toBe(now + VIDEO_DIAGNOSTIC_RETENTION_MS);
    vi.setSystemTime(now + VIDEO_DIAGNOSTIC_RETENTION_MS);
    expect((await getVideoDiagnostics(f.env, t.id)).samples).toHaveLength(0);
    await captureVideoDiagnostic(f.env, t.id, event({ slot: "terminal" }));
    expect(f.d1.rows("SELECT * FROM video_diagnostics")).toHaveLength(1);
    await pruneVideoDiagnostics(f.env);
    expect(f.d1.rows("SELECT * FROM video_diagnostics")).toHaveLength(0);
    expect(f.d1.rows("SELECT * FROM video_diagnostic_grants")).toHaveLength(0);
    expect(f.d1.rows("SELECT * FROM video_diagnostic_arms")).toHaveLength(0);
    expect(f.d1.rows("SELECT * FROM audit_logs WHERE action = 'video_diagnostics.retention'")).toHaveLength(3);
  });
  it("bounds retention deletes to 100 per table, keeps live data, and has expiry/task lookup indexes", async () => {
    const f = await setup(); const t = await claimed(f); await captureVideoDiagnostic(f.env, t.id, event());
    for (let i = 0; i < 105; i++) {
      const id = "expired-" + i;
      f.d1.sql("INSERT INTO video_diagnostics VALUES (?, 'create', 200, 'application/json', 'enc:v1:expired', 0, 1, 2)", id);
      f.d1.sql("INSERT INTO video_diagnostic_grants VALUES (?, ?, 'dev-1', 1, 2)", id, id);
      f.d1.sql("INSERT INTO video_diagnostic_arms VALUES (?, ?, NULL, 1, 0, 2)", id, id);
    }
    await pruneVideoDiagnostics(f.env);
    for (const table of ["video_diagnostics", "video_diagnostic_grants", "video_diagnostic_arms"]) {
      expect(f.d1.rows("SELECT * FROM " + table)).toHaveLength(6);
      const column = table === "video_diagnostic_arms" ? "enabled_until" : "expires_at";
      expect(JSON.stringify(f.d1.rows("EXPLAIN QUERY PLAN SELECT rowid FROM " + table + " WHERE " + column + " <= ? ORDER BY " + column + " LIMIT 100", Date.now()))).toContain("INDEX");
    }
    expect((await getVideoDiagnostics(f.env, t.id)).samples).toHaveLength(1);
  });
  it("exports only redacted JSON attachment, audits arm/disarm/export, and denies missing tasks/raw variants", async () => {
    const f = await setup(); const t = await claimed(f);
    await captureVideoDiagnostic(f.env, t.id, event({ body: JSON.stringify({ url: signedUrl, token: "private-token", status: "done" }) }));
    const normal = await f.admin("/" + t.id + "/diagnostics");
    const exported = await f.admin("/" + t.id + "/diagnostics/export?raw=true");
    expect(normal.status).toBe(200); expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("application/json");
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    expect(exported.headers.get("cache-control")).toBe("no-store");
    expect(await exported.json()).toEqual(await normal.json());
    expect((await f.admin("/" + t.id + "/diagnostics/raw")).status).toBe(404);
    expect((await f.admin("/missing/diagnostics/export")).status).toBe(404);
    await f.disarm();
    const audit = f.d1.rows<{ action: string }>("SELECT * FROM audit_logs");
    expect(audit.map(r => r.action)).toEqual(["video_diagnostics.arm", "video_diagnostics.export", "video_diagnostics.disarm"]);
    for (const value of [signedUrl, "private-token", f.env.ENCRYPTION_KEY!, f.env.SESSION_SECRET!]) expect(JSON.stringify(audit)).not.toContain(value);
  });
  it("fails safe for missing/wrong key, ciphertext corruption and all sampling DB failures without logging", async () => {
    const f = await setup(); const t = await claimed(f); await captureVideoDiagnostic(f.env, t.id, event());
    f.env.ENCRYPTION_KEY = undefined;
    await expect(captureVideoDiagnostic(f.env, t.id, event({ slot: "terminal" }))).resolves.toBeUndefined();
    expect((await getVideoDiagnostics(f.env, t.id)).samples[0].body).toBe("[UNAVAILABLE]");
    f.env.ENCRYPTION_KEY = "wrong-key";
    expect((await getVideoDiagnostics(f.env, t.id)).samples[0].body).toBe("[UNAVAILABLE]");
    f.d1.sql("UPDATE video_diagnostics SET body_sealed = 'plaintext-secret'");
    expect(JSON.stringify(await getVideoDiagnostics(f.env, t.id))).not.toContain("plaintext-secret");
    const error = vi.spyOn(console, "error").mockImplementation(() => {}), log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(f.env.DB, "prepare").mockImplementation(() => { throw Error("DB failed with private-response-secret"); });
    await expect(captureVideoDiagnostic(f.env, t.id, event())).resolves.toBeUndefined();
    await expect(claimVideoDiagnostics(f.env, t.id)).resolves.toBe(false);
    await expect(pruneVideoDiagnostics(f.env)).resolves.toBeUndefined();
    expect(error).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  });
  it("rolls an arm binding back if grant persistence fails", async () => {
    const f = await setup(); await f.arm(); const t = await create(f);
    f.d1.sql("CREATE TRIGGER diagnostic_fail BEFORE INSERT ON video_diagnostic_grants BEGIN SELECT RAISE(ABORT, 'failure'); END");
    expect(await claimVideoDiagnostics(f.env, t.id)).toBe(false);
    expect(f.d1.row("SELECT task_id FROM video_diagnostic_arms")).toEqual({ task_id: null });
    expect(f.d1.rows("SELECT * FROM video_diagnostic_grants")).toHaveLength(0);
  });
  it("excludes pre-arm tasks even in the same millisecond and after expired grants are pruned", async () => {
    const f = await setup(); vi.useFakeTimers(); const now = Date.now(); const old = await create(f);
    await f.arm(); expect(await claimVideoDiagnostics(f.env, old.id)).toBe(false);
    const t = await create(f); expect(await claimVideoDiagnostics(f.env, t.id)).toBe(true);
    vi.setSystemTime(now + VIDEO_DIAGNOSTIC_RETENTION_MS); await pruneVideoDiagnostics(f.env); await f.arm();
    expect(await claimVideoDiagnostics(f.env, t.id)).toBe(false);
    const next = await create(f); expect(await claimVideoDiagnostics(f.env, next.id)).toBe(true);
  });
  it("refuses unavailable encryption and rechecks expiry after asynchronous encryption", async () => {
    const f = await setup(); const t = await claimed(f);
    const error = vi.spyOn(console, "error").mockImplementation(() => {}), log = vi.spyOn(console, "log").mockImplementation(() => {});
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "encrypt").mockRejectedValue(new Error("private-crypto-failure"));
    expect((await f.arm()).status).toBe(503);
    await expect(captureVideoDiagnostic(f.env, t.id, event())).resolves.toBeUndefined();
    expect(f.d1.rows("SELECT * FROM video_diagnostics")).toHaveLength(0);
    vi.useFakeTimers();
    const expiry = f.d1.row<{ expires_at: number }>("SELECT expires_at FROM video_diagnostic_grants")!.expires_at;
    vi.setSystemTime(expiry - 1);
    spy.mockImplementationOnce(async (...args) => { const ciphertext = await encrypt(...args); vi.setSystemTime(expiry); return ciphertext; });
    await expect(captureVideoDiagnostic(f.env, t.id, event())).resolves.toBeUndefined();
    expect(f.d1.rows("SELECT * FROM video_diagnostics")).toHaveLength(0);
    expect(error).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  });
  it("rolls arm/disarm back when their audit cannot persist and refuses unaudited export", async () => {
    const f = await setup(); const t = await create(f);
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.d1.sql("CREATE TRIGGER diagnostic_audit_fail BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    expect((await f.arm()).status).toBe(500);
    expect(f.d1.rows("SELECT * FROM video_diagnostic_arms")).toHaveLength(0);
    f.d1.sql("DROP TRIGGER diagnostic_audit_fail"); await f.arm();
    f.d1.sql("CREATE TRIGGER diagnostic_audit_fail BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    expect((await f.disarm()).status).toBe(500);
    expect(f.d1.rows("SELECT * FROM video_diagnostic_arms")).toHaveLength(1);
    const exported = await f.admin("/" + t.id + "/diagnostics/export");
    expect(exported.status).toBe(500); expect(exported.headers.get("content-disposition")).toBeNull();
    expect(await exported.text()).not.toContain("audit unavailable");
    expect(f.d1.rows("SELECT * FROM audit_logs")).toHaveLength(1);
  });
  it("adds only idempotent CREATE tables/indexes usable before old video ALTER migrations", () => {
    const statements = INIT_STATEMENTS.filter(sql => /(?:TABLE|INDEX) IF NOT EXISTS (?:idx_)?video_diagnostic/.test(sql));
    expect(statements.filter(sql => sql.startsWith("CREATE TABLE"))).toHaveLength(3);
    const d1 = createRealD1({ init: ["CREATE TABLE video_tasks (id TEXT PRIMARY KEY, legacy_value TEXT)", ...statements], alters: [] });
    try {
      d1.sql("INSERT INTO video_tasks VALUES ('keep', 'legacy')");
      for (const sql of statements) d1.sql(sql);
      expect(d1.row("SELECT * FROM video_tasks")).toEqual({ id: "keep", legacy_value: "legacy" });
    } finally { d1.close(); }
  });
});
