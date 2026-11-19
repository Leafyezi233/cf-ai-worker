import { Hono } from "hono";
import { handleHttpError } from "./utils/http-errors";
import type { Env } from "./types";
import { adminEntry } from "./middleware/adminEntry";
import { gatewayApp } from "./gateway";
import {
  listProviders,
  aggregateDailyStats,
  getSetting,
  releaseStaleReserves,
  pruneLoginAttempts,
} from "./db/repo";
import { ensureSchema } from "./db/schema";
import { recoverBillingRequests } from "./db/request_billing";
import { pingSingleProvider } from "./admin/providers";
import { listOllamaTagsHandler } from "./gateway/models_endpoints";
import { RateLimiterDO } from "./gateway/rate-limiter-do";
import { STALE_RESERVE_CRON } from "./crons";
import { pollVideoTasks } from "./gateway/video";
import { pruneVideoDiagnostics } from "./db/video_diagnostics";
import { pruneVideoReferenceAssets } from "./db/video_reference_assets";
import { consoleApp } from "./console";
import { applySecurityHeaders } from "./utils/security-headers";
import { ipRateLimit } from "./middleware/ipRateLimit";

export const app = new Hono<{ Bindings: Env }>();

app.use("*", applySecurityHeaders);
app.use("*", adminEntry);

app.use("*", async (c, next) => {
  const hasAuth = !!(c.req.header("authorization") || c.req.header("x-api-key"));
  const isHtml = c.req.header("accept")?.includes("text/html");

  const personalPage = ["/me", "/me/", "/me/index.html"].includes(c.req.path);
  if (personalPage && ["GET", "HEAD"].includes(c.req.method)) {
    c.header("Cache-Control", "no-store");
    return c.redirect("/console", 302);
  }
  if (c.req.path === "/me" || c.req.path.startsWith("/me/")) {
    return c.json({ error: "not_found" }, 404);
  }

  if ((!isHtml || hasAuth) && c.req.path.length > 1 && c.req.path.endsWith("/")) {
    const target = new URL(c.req.raw.url);
    target.pathname = c.req.path.replace(/\/+$/, "");
    return c.redirect(target.toString(), 308);
  }

  if (["GET", "HEAD"].includes(c.req.method) && c.req.path === "/" && isHtml && !hasAuth) {
    c.header("Cache-Control", "no-store");
    return c.redirect("/console", 302);
  }

  if (
    c.req.method === "GET" &&
    !c.req.path.startsWith("/api/") &&
    !c.req.path.startsWith("/v1/") &&
    isHtml &&
    !hasAuth &&
    c.env.ASSETS
  ) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return next();
});

app.use("/api/*", ipRateLimit);

app.use("/api/*", async (c, next) => {
  await ensureSchema(c.env);
  return next();
});

app.use("/v1/*", ipRateLimit);

app.use("/v1/*", async (c, next) => {
  await ensureSchema(c.env);
  return next();
});

app.use("/console/*", ipRateLimit);

app.use("/console/*", async (c, next) => {
  await ensureSchema(c.env);
  return next();
});

app.get("/health", (c) => c.json({ ok: true, service: "personal-ai-gateway" }));
app.get("/api/tags", (c) => listOllamaTagsHandler(c));

app.route("/v1", gatewayApp);
app.route("/console", consoleApp);
app.route("/", gatewayApp);

app.all("*", async (c) => {
  const path = c.req.path;
  const publicAsset = ["/", "/index.html", "/console", "/favicon.svg", "/theme-boot.js"].includes(path) || /^\/assets\/[A-Za-z0-9_.-]+$/.test(path);
  if (publicAsset && ["GET", "HEAD"].includes(c.req.method) && c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ error: "not_found" }, 404);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError(handleHttpError);

export { RateLimiterDO };


export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      (async () => {
        if (event?.cron === "* * * * *") {
          const jobs = await Promise.allSettled([recoverBillingRequests(env), pollVideoTasks(env), pruneVideoReferenceAssets(env)]);
          if (jobs[0].status === "rejected") console.error("[cron] billing recovery failed:", jobs[0].reason);
          try { await pruneVideoDiagnostics(env); } catch {   }
          return;
        }
        if (event?.cron === STALE_RESERVE_CRON) {
          try {
            await recoverBillingRequests(env);
            const reaped = await releaseStaleReserves(env);
            if (reaped > 0) console.log(`[cron] released ${reaped} stale balance reservation(s)`);
          } catch (err: any) {
            console.error("[cron] stale reserve sweep failed:", err?.message || err);
          }
          return;
        }

        await recoverBillingRequests(env);
        await aggregateDailyStats(env);

        try {
          const reaped = await releaseStaleReserves(env);
          if (reaped > 0) console.log(`[cron] released ${reaped} stale balance reservation(s)`);
        } catch (err: any) {
          console.error("[cron] stale reserve sweep failed:", err?.message || err);
        }

        try {
          const pruned = await pruneLoginAttempts(env);
          if (pruned > 0) console.log(`[cron] pruned ${pruned} stale login-attempt row(s)`);
        } catch (err: any) {
          console.error("[cron] login-attempt prune failed:", err?.message || err);
        }

        const providers = await listProviders(env);
        const enabled = providers.filter((p) => p.enabled);
        await Promise.allSettled(enabled.map((p) => pingSingleProvider(env, p)));


      })()
    );
  },
};

