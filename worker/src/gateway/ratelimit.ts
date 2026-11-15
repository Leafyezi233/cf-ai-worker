import type { Env } from "../types";
import { BoundedWindow } from "../utils/boundedWindow";

const memoryWindows = new BoundedWindow();

export async function checkAndRecordRateLimit(
  env: Env,
  deviceId: string,
  rpm: number
): Promise<boolean> {
  if (!rpm || rpm <= 0) return true;

  const now = Date.now();


  const memKey = "ratelimit:mem:" + deviceId;
  if (!memoryWindows.hit(memKey,rpm,now)) return false;

  if (env.RATE_LIMITER) {
    try {
      const { checkViaDurableObject } = await import("./rate-limiter-do");
      const allowed = await checkViaDurableObject(env, deviceId, rpm);
      if (!allowed) {
        memoryWindows.undo(memKey,now);
      }
      return allowed;
    } catch (err: any) {
      console.warn(
        "[ratelimit] Durable Object check failed, falling back to the per-isolate window:",
        err?.message || err
      );
    }
  }

  if (env.CACHE_KV) {
    const minuteWindow = Math.floor(now / 60000);
    const kvKey = "ratelimit:kv:" + deviceId + ":" + minuteWindow;
    try {
      const currentVal = await env.CACHE_KV.get(kvKey);
      const count = currentVal ? parseInt(currentVal, 10) : 0;
      if (count >= rpm) {
        return false;
      }
      await env.CACHE_KV.put(kvKey, String(count + 1), { expirationTtl: 70 });
    } catch (err: any) {
      console.warn("[ratelimit] KV counter failed, falling back to the per-isolate window:", err?.message || err);
    }
  }

  return true;
}

export function resetRateLimitMemory(): void {
  memoryWindows.clear();

}