import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";

describe("retired personal page routes", () => {
  const assetFetch = vi.fn(() => new Response("Unexpected SPA", { headers: { "Content-Type": "text/html" } }));
  const prepare = vi.fn(() => { throw new Error("Retired routes must not access D1"); });
  const env = { ASSETS: { fetch: assetFetch }, DB: { prepare } } as unknown as Env;
  it.each(["/me", "/me/", "/me/index.html"])("GET/HEAD %s temporarily redirect without consulting assets or D1", async path => {
    for (const method of ["GET", "HEAD"]) for (const accept of ["text/html", "application/json"]) {
      assetFetch.mockClear(); prepare.mockClear();
      const res = await app.fetch(new Request("https://gw.test" + path + "?next=https://evil.invalid&token=discard-me", { method, headers: { accept, authorization: "Bearer unused" } }), env);
      expect(res.status).toBe(302); expect(res.headers.get("Location")).toBe("/console");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(assetFetch).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    }
  });
  it.each(["/me/avatar.webp", "/me/unknown.html", "/me/nested/image.png"])("%s returns actual 404, never SPA HTML", async path => {
    for (const method of ["GET", "HEAD", "POST"]) {
      assetFetch.mockClear(); prepare.mockClear();
      const res = await app.fetch(new Request("https://gw.test" + path, { method, headers: { accept: "text/html" } }), env);
      expect(res.status).toBe(404); expect(res.headers.has("Location")).toBe(false);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      expect(assetFetch).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    }
  });
  it.each(["/me", "/me/", "/me/index.html"])("POST %s does not redirect or serve old content", async path => {
    const res = await app.fetch(new Request("https://gw.test" + path, { method: "POST" }), env);
    expect(res.status).toBe(404); expect(res.headers.has("Location")).toBe(false);
  });
  it.each(["GET", "HEAD"])("%s browser root redirects to console without forwarding queries", async method => {
    const res = await app.fetch(new Request("https://gw.test/?token=discard-me", { method, headers: { accept: "text/html" } }), env);
    expect(res.status).toBe(302); expect(res.headers.get("Location")).toBe("/console");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
