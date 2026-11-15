import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { ensureSchema } from "../db/schema";
import { backfillUsageRollups, verifyUsageRollups, previewUsageCleanup, cleanupUsageDetails } from "../db/usage_rollups";
import { recordAuditLog } from "../db/repo";
import { extractClientIp } from "../middleware/adminAuth";

export const usageRetentionApp = new Hono<{ Bindings: Env }>();
usageRetentionApp.use("*", async (c, next) => {
  if (c.req.method !== "GET") {
    if (c.req.header("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return c.json({ error: "json_required" }, 415);
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "origin_rejected" }, 403);
  }
  await ensureSchema(c.env);
  await next();
});
usageRetentionApp.onError((error, c) => {
  if (["usage_invalid_timestamp", "usage_invalid_limit", "usage_invalid_cursor", "usage_cleanup_hour_alignment_required", "usage_cleanup_cutoff_required", "usage_invalid_operation_id"].includes(error.message)) return c.json({ error: error.message }, 400);
  if (error.message === "usage_cleanup_operation_conflict") return c.json({ error: error.message }, 409);
  if (["usage_rollup_verification_required:history_missing", "usage_rollup_verification_required:backfill_required", "usage_rollup_verification_required:mismatch"].includes(error.message)) return c.json({ error: error.message }, 409);
  throw error;
});
const Integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Page = z.object({ before: Integer.positive().refine(v => v % 3600000 === 0), limit: Integer.min(1).max(1000), after: z.object({ createdAt: Integer, id: Integer }).strict().optional() }).strict();
const Cleanup = Page.extend({ enabled: z.literal(true), confirm: z.literal("DELETE_USAGE_DETAILS"), operation_id: z.string().min(1).max(200) }).strict();
async function parsed(c: any, schema: z.ZodTypeAny) {
  let value: unknown;
  try { value = await c.req.json(); } catch { return null; }
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}
usageRetentionApp.get("/status", async c => c.json({ item: { ...(await verifyUsageRollups(c.env)), automatic_cleanup: false, detail_granularity_after_cleanup: "hour" } }));
usageRetentionApp.post("/backfill", async c => {
  const body = await parsed(c, z.object({ limit: Integer.min(1).max(500) }).strict());
  if (!body) return c.json({ error: "validation_error" }, 400);
  return c.json({ item: await backfillUsageRollups(c.env, body) });
});
usageRetentionApp.post("/verify", async c => {
  if (!await parsed(c, z.object({}).strict())) return c.json({ error: "validation_error" }, 400);
  return c.json({ item: await verifyUsageRollups(c.env) });
});
usageRetentionApp.post("/preview", async c => {
  const body = await parsed(c, Page);
  if (!body) return c.json({ error: "validation_error" }, 400);
  return c.json({ item: await previewUsageCleanup(c.env, body) });
});
usageRetentionApp.post("/cleanup", async c => {
  const body = await parsed(c, Cleanup);
  if (!body) return c.json({ error: "validation_error" }, 400);
  const item = await cleanupUsageDetails(c.env, body);
  await recordAuditLog(c.env, { actor_type: "admin", ip: extractClientIp(c, c.env), action: "usage_retention.cleanup", target_type: "usage", summary: "Manual bounded verified usage detail cleanup", details: { ...body, confirm: undefined, result: item } });
  return c.json({ item });
});
