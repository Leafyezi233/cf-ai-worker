import { Hono } from "hono";
import currentWorker from "./index";
import type { Env } from "./types";
import { ensureSchema } from "./db/schema";
import { adminAuth } from "./middleware/adminAuth";
import { ipRateLimit } from "./middleware/ipRateLimit";
import { applySecurityHeaders } from "./utils/security-headers";
import { adminPrefix } from "./utils/admin-path";

export { RateLimiterDO } from "./index";

const monthlyWriteBlock = new Hono<{ Bindings: Env }>();
monthlyWriteBlock.use("*", applySecurityHeaders);
monthlyWriteBlock.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  const origin = c.req.header("origin");
  if ((origin && origin !== new URL(c.req.url).origin) || c.req.header("sec-fetch-site") === "cross-site") return c.json({ error: "origin_rejected" }, 403);
  if (c.req.header("x-admin-request") !== "1") return c.json({ error: "csrf_rejected" }, 403);
  return next();
});
monthlyWriteBlock.use("*", ipRateLimit);
monthlyWriteBlock.use("*", async (c, next) => { await ensureSchema(c.env); return next(); });
monthlyWriteBlock.use("*", adminAuth);
monthlyWriteBlock.all("*", c => c.json({ error: "monthly_admin_read_only" }, 503));
monthlyWriteBlock.onError((error, c) => {
  console.error("Compatibility worker unhandled error:", error);
  return c.json({ error: "internal_server_error" }, 500);
});

export const app = new Hono<{ Bindings: Env }>();
app.all("*", c => {
  let ctx: Parameters<typeof currentWorker.fetch>[2];
  try { ctx = c.executionCtx; } catch {   }
  const path = c.req.path;
  const prefix = adminPrefix(c.env);
  const base = prefix ? prefix + "/api/monthly-passes" : null;
  const monthlyAdmin = base !== null && (path === base || path.startsWith(base + "/"));
  if (monthlyAdmin && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    return monthlyWriteBlock.fetch(c.req.raw, c.env, ctx);
  }
  return currentWorker.fetch(c.req.raw, c.env, ctx);
});

export default { ...currentWorker, fetch: app.fetch };
