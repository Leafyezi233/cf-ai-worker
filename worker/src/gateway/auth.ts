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
  if (!token) return null;
  const hash = await sha256Hex(token);
  const device = await getDeviceByHash(c.env, hash);
  if (device) {
    if (!device.enabled || device.revoked_at) return null;
    return withTokenRoutingPolicy(c.env, { ...device, auth_via: "master", sub_token_id: null });
  }
  const sub = await getSubTokenByHash(c.env, hash);
  if (!sub) return null;
  const owner = await getDeviceById(c.env, sub.device_id);
  if (!owner || !owner.enabled || owner.revoked_at) return null;
  return withTokenRoutingPolicy(c.env, {
    ...owner,
    service_group_id: sub.service_group_id ?? null,
    auth_via: "sub",
    sub_token_id: sub.id,
  });
}
