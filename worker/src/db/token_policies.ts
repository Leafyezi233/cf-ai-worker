import type { AuthedDevice, DeviceRow, EffectiveTokenRoutingPolicy, Env, TokenRoutingPolicy } from "../types";
import { ensureSchema } from "./schema";

export { TOKEN_POLICY_SCHEMA } from "./token_policy_schema";

export async function ensureTokenPoliciesSchema(env: Env): Promise<void> {
  await ensureSchema(env);
}

export const DEFAULT_ROUTING_POLICY: TokenRoutingPolicy = {
  mode: "auto", group_ids: [], selection: "ordered", failure_fallback: false,
  model_overrides: {}, model_scope: null,
};
const stableKey = /^(public|model|group):[^\s:][^\s]*$/;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
export function parseTokenRoutingPolicy(value: unknown): TokenRoutingPolicy | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid routing policy");
  const p = value as Record<string, unknown>;
  const keys = ["mode", "group_ids", "selection", "failure_fallback", "model_overrides", "model_scope"];
  if (Object.keys(p).some(k => !keys.includes(k))) throw new Error("Unknown routing policy field");
  if (!["auto", "legacy", "fixed", "multi"].includes(String(p.mode))) throw new Error("Invalid routing mode");
  if (!Array.isArray(p.group_ids) || p.group_ids.length > 80 || p.group_ids.some(id => typeof id !== "string" || !id.trim() || id.length > 200 || ["auto", "legacy"].includes(id))
    || new Set(p.group_ids).size !== p.group_ids.length) throw new Error("Invalid selected groups");
  if ((p.mode === "fixed" && p.group_ids.length !== 1) || (p.mode === "multi" && p.group_ids.length < 1)
    || (["auto", "legacy"].includes(String(p.mode)) && p.group_ids.length !== 0)) throw new Error("Routing mode and groups do not match");
  const selection = p.selection ?? "ordered";
  if (selection !== "ordered" && selection !== "input_price") throw new Error("Invalid group selection order");
  const fallback = p.failure_fallback ?? false;
  if (typeof fallback !== "boolean") throw new Error("Invalid failure fallback");
  const overrides = p.model_overrides ?? {};
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) || Object.keys(overrides).length > 500) throw new Error("Invalid model overrides");
  for (const [key, group] of Object.entries(overrides)) {
    if (!stableKey.test(key) || key.length > 240 || typeof group !== "string" || !p.group_ids.includes(group)) throw new Error("Model override must select an already selected group");
  }
  const scope = own(p, "model_scope") ? p.model_scope : null;
  if (scope !== null && (!Array.isArray(scope) || scope.length > 1000 || scope.some(key => typeof key !== "string" || key.length > 240 || !stableKey.test(key))
    || new Set(scope).size !== scope.length)) throw new Error("Invalid model scope");
  return { mode: p.mode as TokenRoutingPolicy["mode"], group_ids: [...p.group_ids] as string[], selection,
    failure_fallback: fallback, model_overrides: { ...overrides } as Record<string, string>, model_scope: scope === null ? null : [...scope] as string[] };
}

export interface StoredTokenPolicy { token_id: string; policy_json: string | null; revision: number; }
export async function getTokenRoutingPolicy(env: Env, deviceId: string, tokenId: string): Promise<StoredTokenPolicy | null> {
  await ensureTokenPoliciesSchema(env);
  return env.DB.prepare("SELECT token_id, policy_json, revision FROM token_routing_policies WHERE device_id = ? AND token_id = ?")
    .bind(deviceId, tokenId).first<StoredTokenPolicy>();
}

export async function putTokenRoutingPolicy(env: Env, deviceId: string, tokenId: string, policy: TokenRoutingPolicy | null): Promise<void> {
  await ensureTokenPoliciesSchema(env);
  await env.DB.batch(tokenPolicyWriteStatements(env, deviceId, tokenId, policy));
}

export function tokenPolicyWriteStatements(env: Env, deviceId: string, tokenId: string, policy: TokenRoutingPolicy | null): D1PreparedStatement[] {
  const parsed = parseTokenRoutingPolicy(policy);
  const statements = [env.DB.prepare("INSERT INTO token_routing_policies (device_id, token_id, policy_json, revision, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(device_id, token_id) DO UPDATE SET policy_json = excluded.policy_json, revision = token_routing_policies.revision + 1, updated_at = excluded.updated_at")
    .bind(deviceId, tokenId, parsed === null ? null : JSON.stringify(parsed), Date.now()),
  env.DB.prepare("DELETE FROM token_routing_policy_groups WHERE device_id = ? AND token_id = ?").bind(deviceId, tokenId)];
  for (const [position, id] of (parsed?.group_ids ?? []).entries()) statements.push(env.DB.prepare(
    "INSERT INTO token_routing_policy_groups (device_id, token_id, service_group_id, position) VALUES (?, ?, ?, ?)"
  ).bind(deviceId, tokenId, id, position));
  return statements;
}

export function singleSelectionPolicy(selection: string | null, previous: TokenRoutingPolicy | null): TokenRoutingPolicy | null {
  if (selection === null) return null;
  return { ...DEFAULT_ROUTING_POLICY, model_scope: previous?.model_scope ?? null, model_overrides: {},
    mode: selection === "auto" ? "auto" : selection === "legacy" ? "legacy" : "fixed",
    group_ids: ["auto", "legacy"].includes(selection) ? [] : [selection] };
}

function compatibilityPolicy(selection: string | null | undefined): TokenRoutingPolicy {
  const mode = selection === "auto" ? "auto" : selection == null || selection === "legacy" ? "legacy" : "fixed";
  return { ...DEFAULT_ROUTING_POLICY, mode, group_ids: mode === "fixed" ? [selection!] : [],
    selection: mode === "auto" ? "input_price" : "ordered", failure_fallback: mode === "auto", model_overrides: {} };
}

export async function resolveTokenRoutingPolicy(env: Env, device: DeviceRow, tokenId = "master"): Promise<EffectiveTokenRoutingPolicy> {
  await ensureTokenPoliciesSchema(env);
  const result = await env.DB.prepare("SELECT token_id, policy_json, revision FROM token_routing_policies WHERE device_id = ? AND token_id IN ('account', ?)")
    .bind(device.id, tokenId).all<StoredTokenPolicy>();
  const rows = result.results || [];
  const accountRow = rows.find(r => r.token_id === "account");
  const tokenRow = tokenId === "account" ? undefined : rows.find(r => r.token_id === tokenId);
  const decode = (r: StoredTokenPolicy | undefined) => r?.policy_json == null ? null : parseTokenRoutingPolicy(JSON.parse(r.policy_json));
  const account = decode(accountRow) ?? compatibilityPolicy(device.default_service_group_id);
  const explicit = decode(tokenRow);
  const oldOverride = !tokenRow && device.service_group_id != null ? compatibilityPolicy(device.service_group_id) : null;
  const policy = explicit ?? oldOverride ?? account;
  const scope_layers = policy.model_scope === null ? [] : [[...policy.model_scope]];
  return { policy: structuredClone(policy), scope_layers,
    version: "account:" + (accountRow?.revision ?? 0) + "/" + tokenId + ":" + (tokenRow?.revision ?? 0),
    source: explicit || oldOverride ? (explicit ? "token" : "compatibility") : accountRow ? "account" : "compatibility" };
}

export async function withTokenRoutingPolicy<T extends AuthedDevice>(env: Env, device: T): Promise<T> {
  const tokenId = device.auth_via === "sub" ? device.sub_token_id! : "master";
  return { ...device, token_routing_policy: await resolveTokenRoutingPolicy(env, device, tokenId) };
}

export function tokenScopeAllows(device: DeviceRow | null, keys: readonly string[]): boolean {
  return !device?.token_routing_policy || device.token_routing_policy.scope_layers.every(layer => keys.some(key => layer.includes(key)));
}
