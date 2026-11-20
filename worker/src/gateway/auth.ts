import type { Context } from "hono";
import type { AuthedDevice, Env } from "../types";
import { getDeviceById, getDeviceByHash, getSubTokenByHash } from "../db/repo";
import { sha256Hex } from "../utils/crypto";
import { withTokenRoutingPolicy } from "../db/token_policies";

export async function authenticateGateway(c: Context<{ Bindings: Env }>) {
  return resolveDevice(c);
}

export async function optionalDeviceAuth(c: Context<{ Bindings: Env }>) {
  return resolveDevice(c);
}

export async function resolveDevice(c: Context<{ Bindings: Env }>): Promise<AuthedDevice | null> {
  const auth = c.req.header("authorization") || "";
  let token = "";
  if (auth.startsWith("Bearer ")) {
    token = auth.slice(7).trim();
  } else {
    token = c.req.header("x-api-key")?.trim() || "";
  }
  return resolveToken(c.env, token);
}

/** Resolves a raw master or sub token the same way a gateway request would. */
export async function resolveToken(env: Env, token: string): Promise<AuthedDevice | null> {
  if (!token) return null;
  const hash = await sha256Hex(token);
  const device = await getDeviceByHash(env, hash);
  if (device) {
    if (!device.enabled || device.revoked_at) return null;
    return withTokenRoutingPolicy(env, { ...device, auth_via: "master", sub_token_id: null });
  }
  const sub = await getSubTokenByHash(env, hash);
  if (!sub) return null;
  const owner = await getDeviceById(env, sub.device_id);
  if (!owner || !owner.enabled || owner.revoked_at) return null;
  return withTokenRoutingPolicy(env, {
    ...owner,
    service_group_id: sub.service_group_id ?? null,
    auth_via: "sub",
    sub_token_id: sub.id,
  });
}
