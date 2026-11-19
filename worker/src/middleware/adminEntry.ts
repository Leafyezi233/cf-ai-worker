import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { adminApp } from "../admin";
import { adminAuth } from "./adminAuth";
import { ipRateLimit } from "./ipRateLimit";
import { ensureSchema } from "../db/schema";

import { adminPrefix } from "../utils/admin-path";
const PAGES = new Set(["", "login", "dashboard", "providers", "models", "model-groups", "service-groups", "peak-pricing", "playground", "devices", "device-templates", "monthly-passes", "usage", "settings"]);
const LEGACY = new Set([...PAGES].filter(Boolean));

type Chunk = { file: string; imports?: string[]; css?: string[]; assets?: string[]; isEntry?: boolean };
const loginAssetCache = new WeakMap<object, Promise<Set<string>>>();
async function loginAssets(assets: Fetcher, origin: string): Promise<Set<string>> {
  let cached = loginAssetCache.get(assets);
  if (!cached) {
    cached = (async () => {
      const response = await assets.fetch(new Request(origin + "/__admin/.vite/manifest.json"));
      if (!response.ok) throw new Error("Management manifest unavailable");
      const manifest = await response.json() as Record<string, Chunk>;
      const allowed = new Set<string>();
      const visited = new Set<string>();
      const visit = (key: string) => {
        if (visited.has(key)) return;
        visited.add(key);
        const chunk = manifest[key];
        if (!chunk) throw new Error("Invalid management manifest");
        if (!chunk.file.endsWith(".html")) allowed.add(chunk.file);
        for (const name of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) allowed.add(name);
        for (const key of chunk.imports ?? []) visit(key);
      };
      for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
      return allowed;
    })();
    loginAssetCache.set(assets, cached);
    cached.catch(() => loginAssetCache.delete(assets));
  }
  return cached;
}

const handleAdminEntry: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const path = c.req.path;
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return c.json({ error: "not_found" }, 404); }
  const notFound = () => c.json({ error: "not_found" }, 404);
  if (decoded.split("/").includes("__admin")) return notFound();
  const prefix = adminPrefix(c.env);
  if (prefix && (path === prefix || path.startsWith(prefix + "/"))) {
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    if (decoded !== path || path.includes("//") || path.includes("\\")) return notFound();
    const suffix = path.slice(prefix.length).replace(/^\//, "");
    const origin = new URL(c.req.url).origin;
    if (suffix === "api" || suffix.startsWith("api/")) {
      return ipRateLimit(c, async () => {
        const requestOrigin = c.req.header("origin");
        if ((requestOrigin && requestOrigin !== origin) || c.req.header("sec-fetch-site") === "cross-site") {
          c.res = c.json({ error: "origin_rejected" }, 403); return;
        }
        if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("x-admin-request") !== "1") {
          c.res = c.json({ error: "csrf_rejected" }, 403); return;
        }
        if (c.req.method === "OPTIONS") { c.res = new Response(null, { status: 204 }); return; }
        await ensureSchema(c.env);
        const url = new URL(c.req.url);
        url.pathname = suffix.slice(3) || "/";
        let executionCtx: Parameters<typeof adminApp.fetch>[2];
        try { executionCtx = c.executionCtx; } catch {   }
        c.res = await adminApp.fetch(new Request(url, c.req.raw), c.env, executionCtx);
      });
    }
    if (!["GET", "HEAD"].includes(c.req.method) || !c.env.ASSETS) return notFound();
    if (suffix.startsWith("assets/")) {
      if (!/^assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|png|svg|webp)$/.test(suffix) || suffix.endsWith(".map")) return notFound();
      const allowed = await loginAssets(c.env.ASSETS, origin);
      const serve = async () => {
        c.res = await c.env.ASSETS.fetch(new Request(origin + "/__admin/" + suffix, { method: c.req.method }));
        if ((c.res.headers.get("content-type") ?? "").includes("text/html")) c.res = notFound();
      };
      if (allowed.has(suffix)) { await serve(); return c.res; }
      return ipRateLimit(c, async () => {
        await ensureSchema(c.env);
        const response = await adminAuth(c, serve);
        if (response instanceof Response) c.res = response;
      });
    }
    if (!PAGES.has(suffix.replace(/\/$/, ""))) return notFound();
    const response = await c.env.ASSETS.fetch(new Request(origin + "/__admin/admin.html"));
    if (!response.ok) return notFound();
    const html = (await response.text()).replaceAll("./assets/", prefix + "/assets/");
    return new Response(c.req.method === "HEAD" ? null : html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
  }
  if (/^\/dashboard\/billing\/(?:subscription|usage)\/?$/.test(path) &&
      (!c.req.header("accept")?.includes("text/html") || c.req.header("authorization") || c.req.header("x-api-key"))) return next();
  const first = decoded.split("/").filter(Boolean)[0] ?? "";
  if ((first === "api" && decoded !== "/api/tags") ||
      (LEGACY.has(first) && !(first === "models" && !c.req.header("accept")?.includes("text/html")))) return notFound();
  if (path === "/api/tags") return next();
  if (c.req.header("accept")?.includes("text/html") &&
      !["", "console", "me", "index.html", "favicon.svg", "theme-boot.js", "assets", "v1"].includes(first)) return notFound();
  return next();
};

export const adminEntry: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const response = await handleAdminEntry(c, next);
  if (response instanceof Response) c.res = response;
  const prefix = adminPrefix(c.env);
  if (prefix && (c.req.path === prefix || c.req.path.startsWith(prefix + "/"))) {
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
  }
};
