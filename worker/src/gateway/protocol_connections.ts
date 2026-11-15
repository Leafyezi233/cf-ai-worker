import type { ProviderType } from "../types";
import { secretNamePolicyError, readEnvSecret } from "../utils/env-secret";
import { resolveProviderBase } from "./endpoints";

export type WireProtocol = "chat/completions" | "responses" | "messages";
export type ConnectionKey = "chat_completions" | "responses" | "messages";
export const CONNECTION_KEYS = ["chat_completions", "responses", "messages"] as const;
export interface ProtocolConnection {
  enabled?: boolean;
  base_url?: string;
  path?: string;
  auth?: "bearer" | "x-api-key" | "x-goog-api-key";
  secret_name?: string;
  version?: string;
  headers?: Partial<Record<"anthropic-beta" | "anthropic-version", string>>;
}
export interface ConnectionInput {
  provider_type?: string;
  provider_endpoint?: string | null;
  provider_config_json?: string | null;
  provider_secret_name?: string | null;
  provider_api_key?: string | null;
}
export interface ConnectionSet {
  explicit: boolean;
  valid: boolean;
  connections: Partial<Record<ConnectionKey, ProtocolConnection>>;
}
export function connectionKey(kind: WireProtocol): ConnectionKey {
  return kind === "chat/completions" ? "chat_completions" : kind;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function headerValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
}
function safeUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 4096 || !/^https?:\/\//i.test(raw)) return false;
  try { const url = new URL(raw); return !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}
function safePath(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//")) return false;
  try { const decoded = decodeURIComponent(raw); return !/[\x00-\x20\x7f?#\\]/.test(decoded) && !decoded.split("/").some(p => p === "." || p === ".."); } catch { return false; }
}
export function protocolConnectionsError(value: unknown): string | null {
  if (!object(value) || Object.keys(value).some(k => !CONNECTION_KEYS.includes(k as ConnectionKey))) return "protocol_connections must contain only chat_completions, responses and messages";
  for (const [key, conn] of Object.entries(value)) {
    if (!object(conn) || Object.keys(conn).some(k => !["enabled","base_url","path","auth","secret_name","version","headers"].includes(k))) return key + ": invalid connection fields (use shared API key or secret_name, never raw credentials)";
    if (conn.enabled !== undefined && typeof conn.enabled !== "boolean") return key + ": enabled must be boolean";
    if (conn.base_url !== undefined && !safeUrl(conn.base_url)) return key + ": base_url must be an absolute http(s) URL without credentials, query or fragment";
    if (conn.path !== undefined && !safePath(conn.path)) return key + ": path must be an absolute safe path without query, fragment or traversal";
    if (conn.auth !== undefined && !["bearer","x-api-key","x-goog-api-key"].includes(String(conn.auth))) return key + ": invalid auth";
    if (conn.secret_name !== undefined && (typeof conn.secret_name !== "string" || !conn.secret_name.trim() || conn.secret_name.length > 100 || secretNamePolicyError(conn.secret_name) !== null)) return key + ": invalid or reserved secret_name";
    if (conn.version !== undefined && !headerValue(conn.version)) return key + ": invalid version";
    if (conn.headers !== undefined && (!object(conn.headers) || Object.entries(conn.headers).some(([k,v]) => !["anthropic-beta","anthropic-version"].includes(k) || !headerValue(v)))) return key + ": only anthropic-beta and anthropic-version headers are allowed";
  }
  return null;
}
export function readConnectionSet(row: ConnectionInput): ConnectionSet {
  let cfg: unknown;
  try { cfg = JSON.parse(row.provider_config_json || "{}"); } catch { return { explicit: true, valid: false, connections: {} }; }
  if (!object(cfg) || !Object.prototype.hasOwnProperty.call(cfg, "protocol_connections")) return { explicit: false, valid: true, connections: {} };
  const value = cfg.protocol_connections;
  return protocolConnectionsError(value) ? { explicit: true, valid: false, connections: {} }
    : { explicit: true, valid: true, connections: value as ConnectionSet["connections"] };
}
export function resolveProtocolConnection(row: ConnectionInput, kind: WireProtocol): ProtocolConnection | null {
  const set = readConnectionSet(row);
  if (set.explicit) {
    const conn = set.connections[connectionKey(kind)];
    return set.valid && conn && conn.enabled !== false ? conn : null;
  }
  if (kind === "messages") return row.provider_type === "anthropic" ? {} : null;
  return row.provider_type === "anthropic" ? null : {};
}
export function protocolTargetUrl(row: ConnectionInput, kind: WireProtocol): string | null {
  const conn = resolveProtocolConnection(row, kind);
  if (!conn) return null;
  const base = conn.base_url || resolveProviderBase(row.provider_endpoint, (row.provider_type || "openai") as ProviderType);
  return base.replace(/\/+$/, "") + (conn.path || "/" + kind);
}
export function protocolUpstreamKey(row: ConnectionInput, kind: WireProtocol, env: Record<string, unknown>): string | undefined {
  const conn = resolveProtocolConnection(row, kind);
  if (!conn) return undefined;
  const key = conn.secret_name ? readEnvSecret(env, conn.secret_name) : row.provider_api_key || readEnvSecret(env, row.provider_secret_name);
  return typeof key === "string" && key ? key : undefined;
}
export function protocolModelName(row: { config_json?: string | null; model_name: string }, kind: WireProtocol): string {
  try {
    const cfg = JSON.parse(row.config_json || "{}");
    const value = cfg?.protocol_models?.[connectionKey(kind)];
    if (typeof value === "string" && value.trim()) return value.trim();
  } catch {}
  return row.model_name;
}
export function usageProviderType(kind: string): ProviderType { return kind === "messages" ? "anthropic" : "openai"; }
