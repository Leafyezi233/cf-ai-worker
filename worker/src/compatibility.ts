import { Hono } from "hono";
import currentWorker from "./index";
import type { Env } from "./types";
import { ensureSchema } from "./db/schema";
import { adminAuth } from "./middleware/adminAuth";
import { ipRateLimit } from "./middleware/ipRateLimit";
import { applySecurityHeaders } from "./utils/security-headers";

export { RateLimiterDO } from "./index";

const monthlyWriteBlock = new Hono<{ Bindings: Env }>();
monthlyWriteBlock.use("*", applySecurityHeaders);
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
  const monthlyAdmin = path === "/api/monthly-passes" || path.startsWith("/api/monthly-passes/");
  if (monthlyAdmin && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    return monthlyWriteBlock.fetch(c.req.raw, c.env, ctx);
  }
  return currentWorker.fetch(c.req.raw, c.env, ctx);
});

export default { ...currentWorker, fetch: app.fetch };
