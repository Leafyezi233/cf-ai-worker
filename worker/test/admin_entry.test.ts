import { describe, it, expect, vi } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";
import { initializedSchemaDouble } from "./helpers/initializedSchemaDouble";
import { signSession } from "../src/utils/crypto";
import { createRealD1 } from "./helpers/realD1";

const host = "https://gateway.example.com";
function fixture() {
  const queries: string[] = [];
  const files: string[] = [];
  const db = { prepare: (sql: string) => {
    queries.push(sql);
    const statement = { bind: (..._args: unknown[]) => statement, run: async () => ({}), all: async () => ({ results: [] }), first: async () => null };
    return statement;
  } };
  const env = { ADMIN_SECRET: "test-secret", DB: initializedSchemaDouble(db as any), ASSETS: { fetch: vi.fn(async (req: Request) => {
    const path = new URL(req.url).pathname;
    files.push(path);
    if (path.endsWith("manifest.json")) return Response.json({ "admin.html": { isEntry: true, file: "assets/login.js", css: ["assets/login.css"] } });
    if (path === "/__admin/admin.html") return new Response('<script src="./assets/login.js"></script>', { headers: { "Content-Type": "text/html" } });
    if (path.startsWith("/__admin/assets/")) return new Response("export {};", { headers: { "Content-Type": "application/javascript" } });
    return new Response("PUBLIC", { headers: { "Content-Type": "text/html" } });
  }) } } as unknown as Env;
  return { env, queries, files };
}

describe("management entry isolation", () => {
  it("round-trips login, protected API, authenticated logout and revocation on real SQLite", async () => {
    const db = createRealD1();
    try {
      const env = { ADMIN_SECRET: "test-secret", DB: initializedSchemaDouble(db.DB) } as Env;
      const call = (path: string, method = "GET", cookie = "", body?: unknown) => app.fetch(new Request(host + "/admin-prefix-example/api" + path, {
        method, headers: { "X-Admin-Request": "1", Origin: host, Cookie: cookie, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
      }), env);
      const login = await call("/auth/login", "POST", "", { password: "test-secret" });
      expect(login.status).toBe(200);
      const setCookie = login.headers.get("set-cookie")!;
      expect(setCookie).toContain("__Host-session="); expect(setCookie).toContain("Path=/"); expect(setCookie).toContain("HttpOnly; Secure; SameSite=Lax");
      const cookie = setCookie.split(";")[0];
      expect((await call("/auth/me", "GET", cookie)).status).toBe(200);
      expect((await call("/models", "GET", cookie)).status).toBe(200);
      const logout = await call("/auth/logout", "POST", cookie);
      expect(logout.status).toBe(200); expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
      expect((await call("/auth/me", "GET", cookie)).status).toBe(401);
      const login2 = await call("/auth/login", "POST", "", { password: "test-secret" });
      expect(login2.status).toBe(200);
      const cookie2 = login2.headers.get("set-cookie")!.split(";")[0];
      db.sql("CREATE TRIGGER fail_epoch_write BEFORE INSERT ON settings WHEN NEW.key='session_epoch' BEGIN SELECT RAISE(ABORT, 'epoch write unavailable'); END");
      const failed = await call("/auth/logout", "POST", cookie2);
      expect(failed.status).toBe(500); expect(await failed.json()).not.toMatchObject({ ok: true });
      const original = env.DB.prepare.bind(env.DB);
      env.DB = { ...env.DB, prepare: (sql: string) => {
        const statement = original(sql);
        if (!sql.includes("SELECT value_json FROM settings")) return statement;
        return { ...statement, bind: (...args: unknown[]) => {
          if (args[0] === "session_epoch") throw new Error("epoch read unavailable");
          return statement.bind(...args);
        } };
      } } as D1Database;
      expect((await call("/auth/me", "GET", cookie2)).status).toBe(500);
    } finally { db.close(); }
  });
  for (const path of ["/login", "/dashboard", "/settings/", "/api/auth/login", "/api/settings", "/__admin/admin.html", "/%5f%5fadmin/assets/login.js", "/wrong-prefix-example/login"]) {
    for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) it(method + " old/private/incorrect " + path + " is 404 without I/O", async () => {
      const { env, queries, files } = fixture();
      const res = await app.fetch(new Request(host + path, { method, headers: { Accept: "text/html" } }), env);
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(queries).toEqual([]); expect(files).toEqual([]);
    });
  }
  it("serves only the isolated management HTML and rewrites its asset URLs", async () => {
    const { env, queries, files } = fixture();
    const res = await app.fetch(new Request(host + "/admin-prefix-example/dashboard", { headers: { Accept: "text/html" } }), env);
    expect(res.status).toBe(200); expect(await res.text()).toContain('/admin-prefix-example/assets/login.js');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(files).toEqual(["/__admin/admin.html"]); expect(queries).toEqual([]);
  });
  it("allows login shell assets without loading D1", async () => {
    const { env, queries } = fixture();
    const res = await app.fetch(new Request(host + "/admin-prefix-example/assets/login.js"), env);
    expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("no-store"); expect(queries).toEqual([]);
  });
  it("requires admin authentication for lazy management modules", async () => {
    const { env, files } = fixture();
    const res = await app.fetch(new Request(host + "/admin-prefix-example/assets/ModelsPage.js"), env);
    expect(res.status).toBe(401); expect(files).not.toContain("/__admin/assets/ModelsPage.js");
  });
  for (const path of ["/admin-prefix-example/assets/file.js.map", "/admin-prefix-example/.vite/manifest.json", "/admin-prefix-example//login", "/admin-prefix-example/api%2Fsettings"]) it("rejects noncanonical or metadata path " + path, async () => {
    const { env, queries } = fixture();
    expect((await app.fetch(new Request(host + path), env)).status).toBe(404); expect(queries).toEqual([]);
  });
  it("handles management health as JSON even for browser Accept", async () => {
    const { env, files } = fixture();
    const res = await app.fetch(new Request(host + "/admin-prefix-example/api/health", { headers: { Accept: "text/html" } }), env);
    expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ ok: true }); expect(files).toEqual([]);
  });
  it("rejects a cross-origin admin read without database work", async () => {
    const { env, queries } = fixture();
    const res = await app.fetch(new Request(host + "/admin-prefix-example/api/settings", { headers: { Origin: "https://evil.example" } }), env);
    expect(res.status).toBe(403); expect(queries).toEqual([]);
  });
  for (const headers of ([{}, { Origin: "https://evil.example", "X-Admin-Request": "1" }, { "Sec-Fetch-Site": "cross-site", "X-Admin-Request": "1" }] as Record<string, string>[])) it("blocks unsafe management requests before D1", async () => {
    const { env, queries } = fixture();
    const res = await app.fetch(new Request(host + "/admin-prefix-example/api/auth/logout", { method: "POST", headers }), env);
    expect(res.status).toBe(403); expect(queries).toEqual([]);
  });
  it("anonymous logout cannot revoke admin sessions", async () => {
    const { env, queries } = fixture();
    const res = await app.fetch(new Request(host + "/admin-prefix-example/api/auth/logout", { method: "POST", headers: { "X-Admin-Request": "1" } }), env);
    expect(res.status).toBe(401); expect(queries.some(q => /INSERT|UPDATE/i.test(q))).toBe(false);
  });
  it("valid admin cookie still authenticates at the new entry", async () => {
    const { env } = fixture();
    const cookie = "__Host-session=" + await signSession(env.ADMIN_SECRET!);
    const res = await app.fetch(new Request(host + "/admin-prefix-example/api/auth/me", { headers: { Cookie: cookie } }), env);
    expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ authenticated: true });
  });
  for (const path of ["/dashboard/billing/subscription", "/dashboard/billing/usage"]) it("preserves public balance alias " + path, async () => {
    const { env, files } = fixture();
    const res = await app.fetch(new Request(host + path), env);
    expect(res.status).toBe(401); expect(await res.json()).toMatchObject({ error: { code: "invalid_request_error" } }); expect(files).toEqual([]);
  });
  it("changing the prefix does not retain an alias", async () => {
    const { env } = fixture(); env.ADMIN_PATH_PREFIX = "private987";
    expect((await app.fetch(new Request(host + "/private987/login"), env)).status).toBe(200);
    expect((await app.fetch(new Request(host + "/admin-prefix-example/login", { headers: { Accept: "text/html" } }), env)).status).toBe(404);
  });
});
