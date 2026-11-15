import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import {
  createMonthlyPlan, updateMonthlyPlan, listMonthlyPlans, issueMonthlyPass,
  stopMonthlyPass, renewMonthlyPass, getMonthlyPassAccount,
  listMonthlyPassAccounts, setMonthlyWalletFallback,
} from "../db/monthly_passes";
import { recordAuditLog } from "../db/repo";
import { extractClientIp, getVerifiedAdminPrincipal } from "../middleware/adminAuth";

export const monthlyPassesApp = new Hono<{ Bindings: Env }>();

monthlyPassesApp.onError((error, c) => {
  switch (error.message) {
    case "monthly_invalid_plan":
    case "monthly_invalid_operation":
    case "monthly_scope_not_found":
      return c.json({ error: error.message }, 400);
    case "monthly_account_not_found":
    case "monthly_plan_not_found":
      return c.json({ error: error.message }, 404);
    case "monthly_pass_already_active":
    case "monthly_operation_conflict":
    case "monthly_subscription_not_current":
      return c.json({ error: error.message }, 409);
    default: throw error;
  }
});

const Id = z.string().trim().min(1).max(200);
const Amount = z.number().finite().positive().max(1e9).nullable();
const PlanInput = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.union([z.literal(0), z.literal(1)]),
  limits: z.object({
    daily_usd: Amount, weekly_usd: Amount, five_hour_usd: Amount, total_usd: Amount,
  }).strict().refine(limits => Object.values(limits).some(value => value !== null), "At least one positive limit is required"),
  service_group_ids: z.array(Id).max(100).nullable(),
}).strict();
const OperationId = z.string().trim().min(1).max(200);
const Issue = z.object({ plan_id: Id, operation_id: OperationId }).strict();
const Renew = z.object({ operation_id: OperationId }).strict();
const Empty = z.object({}).strict();
const Fallback = z.object({ enabled: z.boolean() }).strict();

type MonthlyContext = Context<{ Bindings: Env }>;
function operationContext(c: MonthlyContext, operation_id: string) {
  const actor_scope = getVerifiedAdminPrincipal(c.req.raw);
  if (!actor_scope) throw new Error("Missing verified monthly administrator principal");
  return { operation_id, actor_scope, ip: extractClientIp(c, c.env) };
}
async function parseBody<T extends z.ZodTypeAny>(c: MonthlyContext, schema: T) {
  let value: unknown;
  try { value = await c.req.json(); }
  catch { return { error: "invalid_json" } as const; }
  const result = schema.safeParse(value);
  if (!result.success) return { error: "validation_error", message: result.error.issues[0]?.message } as const;
  return { data: result.data as z.infer<T> } as const;
}
async function audit(c: MonthlyContext, action: string, targetType: string, id: string, details: Record<string, unknown>) {
  await recordAuditLog(c.env, {
    actor_type: "admin", ip: extractClientIp(c, c.env), action: "monthly_pass." + action,
    target_type: targetType, target_id: id, summary: "Monthly pass " + action, details,
  });
}
monthlyPassesApp.get("/plans", async c => c.json({ items: await listMonthlyPlans(c.env) }));
monthlyPassesApp.post("/plans", async c => {
  const body = await parseBody(c, PlanInput);
  if ("error" in body) return c.json(body, 400);
  const item = await createMonthlyPlan(c.env, body.data);
  await audit(c, "plan.create", "monthly_plan", item.id, { plan_id: item.id, enabled: item.enabled, limits: item.limits, service_group_ids: item.service_group_ids });
  return c.json({ item }, 201);
});
monthlyPassesApp.put("/plans/:id", async c => {
  const id = Id.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "validation_error" }, 400);
  const body = await parseBody(c, PlanInput);
  if ("error" in body) return c.json(body, 400);
  const item = await updateMonthlyPlan(c.env, id.data, body.data);
  if (!item) return c.json({ error: "monthly_plan_not_found" }, 404);
  await audit(c, "plan.update", "monthly_plan", item.id, { plan_id: item.id, enabled: item.enabled, limits: item.limits, service_group_ids: item.service_group_ids });
  return c.json({ item });
});
monthlyPassesApp.get("/accounts", async c => c.json({ items: await listMonthlyPassAccounts(c.env) }));
monthlyPassesApp.get("/accounts/:deviceId", async c => {
  const id = Id.safeParse(c.req.param("deviceId"));
  if (!id.success) return c.json({ error: "validation_error" }, 400);
  return c.json({ item: await getMonthlyPassAccount(c.env, id.data) });
});
monthlyPassesApp.post("/accounts/:deviceId/issue", async c => {
  const id = Id.safeParse(c.req.param("deviceId"));
  if (!id.success) return c.json({ error: "validation_error" }, 400);
  const body = await parseBody(c, Issue);
  if ("error" in body) return c.json(body, 400);
  const item = await issueMonthlyPass(c.env, id.data, body.data.plan_id, await operationContext(c, body.data.operation_id));
  return c.json({ item }, 201);
});
monthlyPassesApp.post("/subscriptions/:id/stop", async c => {
  const id = Id.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "validation_error" }, 400);
  const body = await parseBody(c, Empty);
  if ("error" in body) return c.json(body, 400);
  const item = await stopMonthlyPass(c.env, id.data);
  if (!item) return c.json({ error: "monthly_subscription_not_found" }, 404);
  await audit(c, "stop", "monthly_subscription", item.id, { subscription_id: item.id, device_id: item.device_id, enabled: item.enabled });
  return c.json({ item });
});
monthlyPassesApp.post("/subscriptions/:id/renew", async c => {
  const id = Id.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "validation_error" }, 400);
  const body = await parseBody(c, Renew);
  if ("error" in body) return c.json(body, 400);
  const item = await renewMonthlyPass(c.env, id.data, await operationContext(c, body.data.operation_id));
  if (!item) return c.json({ error: "monthly_subscription_not_found" }, 404);
  return c.json({ item });
});
monthlyPassesApp.put("/accounts/:deviceId/wallet-fallback", async c => {
  const id = Id.safeParse(c.req.param("deviceId"));
  if (!id.success) return c.json({ error: "validation_error" }, 400);
  const body = await parseBody(c, Fallback);
  if ("error" in body) return c.json(body, 400);
  const item = await setMonthlyWalletFallback(c.env, id.data, body.data.enabled);
  await audit(c, "wallet_fallback.update", "device", id.data, { device_id: id.data, wallet_fallback: item.wallet_fallback });
  return c.json({ item });
});
