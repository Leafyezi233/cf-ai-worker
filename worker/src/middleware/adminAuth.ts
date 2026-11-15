import { MiddlewareHandler } from "hono";
import type { Env, IpWhitelistConfig } from "../types";
import { verifySession } from "../utils/crypto";
import { getSessionEpoch, getSetting } from "../db/repo";
import { verifyCfAccessJwt } from "../utils/cfAccess";

export const UNKNOWN_CLIENT_IP = "unknown";
const verifiedAdminPrincipals = new WeakMap<Request, string>();
export const getVerifiedAdminPrincipal = (request: Request): string | null => verifiedAdminPrincipals.get(request) ?? null;

export function extractClientIp(
  c: { req: { header: (k: string) => string | undefined } },
  env?: { TRUST_FORWARD_HEADERS?: string }
): string {
  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  const trustForward = String(env?.TRUST_FORWARD_HEADERS || "").trim().toLowerCase();
  if (trustForward === "true" || trustForward === "1") {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
    const xReal = c.req.header("x-real-ip");
    if (xReal) return xReal.trim();
  }
  return UNKNOWN_CLIENT_IP;
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  if (ip === cidr) return true;
  if (!cidr.includes("/")) return ip === cidr;
  const [range, bitsStr] = cidr.split("/");
  const prefixBits = parseInt(bitsStr, 10);
  if (isNaN(prefixBits)) return false;

  const ipToLong = (v: string) => {
    return v.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
  };

  try {
    const ipLong = ipToLong(ip);
    const rangeLong = ipToLong(range);
    const mask = prefixBits === 0 ? 0 : (~0 << (32 - prefixBits)) >>> 0;
    return (ipLong & mask) === (rangeLong & mask);
  } catch {
    return false;
  }
}

export function isIpAllowed(clientIp: string, allowedIps: string[]): boolean {
  if (!allowedIps || allowedIps.length === 0) return true;
  for (const pattern of allowedIps) {
    const p = pattern.trim();
    if (!p) continue;
    if (p === "*" || p === clientIp) return true;
    if (clientIp === "127.0.0.1" && (p === "localhost" || p === "::1")) return true;
    if (clientIp === "::1" && (p === "localhost" || p === "127.0.0.1")) return true;
    if (p.includes("/") && isIpInCidr(clientIp, p)) return true;
  }
  return false;
}

export const adminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  verifiedAdminPrincipals.delete(c.req.raw);
  const clientIp = extractClientIp(c, c.env);
  const ipConfig = await getSetting<IpWhitelistConfig>(c.env, "ip_whitelist_config");
  if (ipConfig?.enabled && Array.isArray(ipConfig.allowed_ips) && ipConfig.allowed_ips.length > 0) {
    if (!isIpAllowed(clientIp, ipConfig.allowed_ips)) {
      return c.json(
        {
          error: "ip_not_allowed",
          message: `Client IP ${clientIp} is not in the allowed admin IP whitelist`,
          client_ip: clientIp,
        },
        403
      );
    }
  }

  const allowedEmailsStr = c.env.CF_ACCESS_ALLOWED_EMAILS;
  if (allowedEmailsStr) {
    const allowed = allowedEmailsStr.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (allowed.length > 0) {
      const jwt = c.req.header("cf-access-jwt-assertion");
      if (jwt) {
        const identity = await verifyCfAccessJwt(jwt, c.env);
        if (identity && allowed.includes(identity.email.trim().toLowerCase())) {
          verifiedAdminPrincipals.set(c.req.raw, "admin:access:" + identity.email.trim().toLowerCase());
          return next();
        }
      }
    }
  }

  const secret = c.env.SESSION_SECRET || c.env.ADMIN_SECRET;
  if (!secret) {
    return c.json({ error: "ADMIN_SECRET not configured" }, 500);
  }
  const payload = await verifySession(secret, c.req.header("cookie"));
  if (!payload) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const currentEpoch = await getSessionEpoch(c.env).catch(() => 0);
  const sessionEpoch = Number.isFinite(payload.epoch) ? Number(payload.epoch) : 0;
  if (sessionEpoch !== currentEpoch) {
    return c.json({ error: "unauthorized" }, 401);
  }
  verifiedAdminPrincipals.set(c.req.raw, "admin:session");
  await next();
};


