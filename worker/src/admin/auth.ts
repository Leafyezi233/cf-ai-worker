import { Hono } from "hono";
import type { Env } from "../types";
import { buildSessionCookie, clearSessionCookies, safeEqual, signSession } from "../utils/crypto";
import { adminAuth, extractClientIp } from "../middleware/adminAuth";
import {
  bumpSessionEpoch,
  clearLoginAttempt,
  getLoginAttempt,
  getSessionEpoch,
  recordLoginFailure,
} from "../db/repo";
import { LoginSchema, zValidator } from "./schemas";

export const authApp = new Hono<{ Bindings: Env }>();

async function checkLoginLock(env: Env, ip: string): Promise<{ locked: boolean; remainingSec: number }> {
  let record;
  try {
    record = await getLoginAttempt(env, ip);
  } catch {
    return { locked: false, remainingSec: 0 };
  }
  if (!record) return { locked: false, remainingSec: 0 };
  const now = Date.now();
  if (record.locked_until > now) {
    return { locked: true, remainingSec: Math.ceil((record.locked_until - now) / 1000) };
  }
  return { locked: false, remainingSec: 0 };
}

authApp.post("/login", zValidator("json", LoginSchema), async (c) => {
  const clientIp = extractClientIp(c, c.env);
  const lock = await checkLoginLock(c.env, clientIp);
  if (lock.locked) {
    return c.json(
      {
        error: "too_many_attempts",
        message: `密码错误次数过多，已被临时锁定，请在 ${lock.remainingSec} 秒后再试`,
      },
      429
    );
  }

  const { password } = c.req.valid("json");
  const expected = c.env.ADMIN_SECRET;
  if (!expected) {
    return c.json({ error: "ADMIN_SECRET_NOT_CONFIGURED: 请在 Cloudflare 环境变量中配置 ADMIN_SECRET" }, 500);
  }
  if (!safeEqual(password, expected)) {
    try {
      await recordLoginFailure(c.env, clientIp);
    } catch {
    }
    return c.json({ error: "invalid_credentials" }, 401);
  }

  try {
    await clearLoginAttempt(c.env, clientIp);
  } catch {
  }
  const sessionSecret = c.env.SESSION_SECRET || c.env.ADMIN_SECRET || "";
  const epoch = await getSessionEpoch(c.env);
  const session = await signSession(sessionSecret, epoch);
  c.header("Set-Cookie", buildSessionCookie(session));
  return c.json({ ok: true });
});

authApp.post("/logout", adminAuth, async (c) => {
  await bumpSessionEpoch(c.env);
  const cookies = clearSessionCookies();
  c.header("Set-Cookie", cookies[0]);
  for (const cookie of cookies.slice(1)) c.header("Set-Cookie", cookie, { append: true });
  return c.json({ ok: true });
});

authApp.get("/me", adminAuth, async (c) => {
  return c.json({ ok: true, authenticated: true });
});
