import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { getMonthlyPassAccount, setMonthlyWalletFallback } from "../db/monthly_passes";
import { recordAuditLog } from "../db/repo";
import { extractClientIp } from "../middleware/adminAuth";
import { requireMaster, requireAccount } from "./account";

export const monthlyConsoleApp = new Hono<{ Bindings: Env }>();
const Fallback = z.object({ enabled: z.boolean() }).strict();
monthlyConsoleApp.onError((error, c) => {
  if (error.message === "monthly_account_not_found") return c.json({ error: error.message }, 404);
  throw error;
});

monthlyConsoleApp.get("/", async c => {
  const auth = await requireMaster(c);
  if ("response" in auth) return auth.response;
  return c.json({ item: await getMonthlyPassAccount(c.env, auth.device.id) });
});
monthlyConsoleApp.put("/wallet-fallback", async c => {
  const auth = await requireAccount(c);
  if ("response" in auth) return auth.response;
  let value: unknown;
  try { value = await c.req.json(); }
  catch { return c.json({ error: "invalid_json" }, 400); }
  const body = Fallback.safeParse(value);
  if (!body.success) return c.json({ error: "validation_error", message: body.error.issues[0]?.message }, 400);
  const item = await setMonthlyWalletFallback(c.env, auth.device.id, body.data.enabled);
  await recordAuditLog(c.env, {
    actor_type: "console", ip: extractClientIp(c, c.env), action: "monthly_pass.wallet_fallback.update",
    target_type: "device", target_id: auth.device.id, summary: "Monthly pass wallet fallback updated",
    details: { device_id: auth.device.id, wallet_fallback: item.wallet_fallback },
  });
  return c.json({ item });
});
