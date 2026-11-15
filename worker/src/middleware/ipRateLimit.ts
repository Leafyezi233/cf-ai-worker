
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { extractClientIp, UNKNOWN_CLIENT_IP } from "./adminAuth";

import { BoundedWindow } from "../utils/boundedWindow";

export const DEFAULT_IP_RATE_LIMIT_RPM = 600;

const windows = new BoundedWindow();

export function ipRateLimitRpm(env: Env): number {
  const raw = (env as unknown as Record<string, unknown> | undefined)?.IP_RATE_LIMIT_RPM;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_IP_RATE_LIMIT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IP_RATE_LIMIT_RPM;
  return Math.floor(n);
}

export function recordIpHit(ip: string, rpm: number, now = Date.now()): boolean {
  if (!rpm || rpm <= 0) return true;
  if (!ip || ip === UNKNOWN_CLIENT_IP) return true;
  return windows.hit("ip:" + ip,rpm,now);
}

export function resetIpRateLimitMemory(): void {
  windows.clear();

}

export const ipRateLimit: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const rpm = ipRateLimitRpm(c.env);
  if (rpm > 0) {
    const ip = extractClientIp(c, c.env);
    if (!recordIpHit(ip, rpm)) {
      c.header("Retry-After", "60");
      return c.json(
        {
          error: "ip_rate_limited",
          message: `Too many requests from this address (limit ${rpm} per minute).`,
        },
        429
      );
    }
  }
  return next();
};