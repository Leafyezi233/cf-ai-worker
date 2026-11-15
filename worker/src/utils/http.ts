import { stripProviderHeaders } from "../gateway/caller_identity";
import type { ProviderType } from "../types";
import { readConnectionSet, resolveProtocolConnection } from "../gateway/protocol_connections";
import type { ConnectionInput, WireProtocol } from "../gateway/protocol_connections";

const BLOCKED_REQUEST_HEADERS = new Set([
  "host",
  "authorization",
  "x-api-key",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

const FORWARDED_X_HEADERS = new Set([
  "x-request-id",
  "x-client-request-id",
  "x-session-id",
  "anthropic-beta",
  "anthropic-version",
  "x-title",
  "x-cache",
]);

const BLOCKED_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "set-cookie",
  "x-cpg-affinity",
  "x-cpg-protocol-route",
  "x-cpg-state-reset",
]);

export function buildUpstreamHeaders(
  source: Headers,
  providerType: ProviderType,
  upstreamKey: string
): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) return;
    const lower = key.toLowerCase();
    if (lower.startsWith("x-") || lower.startsWith("anthropic-")) {
      if (FORWARDED_X_HEADERS.has(lower)) headers.append(key, value);
      return;
    }
    if (key.toLowerCase() === "content-type") return headers.append(key, value);
    if (key.toLowerCase() === "accept") return headers.append(key, value);
    if (key.toLowerCase() === "accept-language") return headers.append(key, value);
  });

  if (providerType === "anthropic") {
    headers.set("x-api-key", upstreamKey);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else if (providerType === "gemini") {
    headers.set("x-goog-api-key", upstreamKey);
    headers.set("Authorization", `Bearer ${upstreamKey}`);
  } else {
    headers.set("Authorization", `Bearer ${upstreamKey}`);
  }
  headers.set("User-Agent", "personal-ai-gateway/0.1");
  return headers;
}

export function cleanResponseHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (BLOCKED_RESPONSE_HEADERS.has(k)) return;
    out.set(key, value);
  });
  return stripProviderHeaders(out);
}

export function addGatewayCorsHeaders(
  headers: Headers,
  origin?: string | null,
  allowedOrigins?: string | null
): boolean {
  const allowList = String(allowedOrigins || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const requestOrigin = (origin || "").trim();

  if (allowList.length > 0 && requestOrigin && allowList.includes(requestOrigin)) {
    headers.set("Access-Control-Allow-Origin", requestOrigin);
    headers.set("Vary", "Origin");
  } else {
    headers.set("Access-Control-Allow-Origin", "*");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key, anthropic-version, anthropic-beta, X-Cpg-Affinity, Idempotency-Key");
  headers.set("Access-Control-Expose-Headers", "X-Cpg-Affinity, X-Cpg-Protocol-Route, X-Cpg-State-Reset, X-Gateway-Attempts");
  headers.set("Access-Control-Max-Age", "86400");
  return true;
}
export function buildProtocolHeaders(source: Headers, row: ConnectionInput, kind: WireProtocol, upstreamKey: string): Headers {
  const conn = resolveProtocolConnection(row, kind);
  const legacyGemini = !readConnectionSet(row).explicit && kind !== "messages" && row.provider_type === "gemini";
  const headers = buildUpstreamHeaders(source, kind === "messages" ? "anthropic" : legacyGemini ? "gemini" : "openai", upstreamKey);
  if (kind !== "messages") { headers.delete("anthropic-version"); headers.delete("anthropic-beta"); }
  if (conn?.auth) {
    for (const name of ["authorization", "x-api-key", "x-goog-api-key"]) headers.delete(name);
    headers.set(conn.auth === "bearer" ? "authorization" : conn.auth, conn.auth === "bearer" ? "Bearer " + upstreamKey : upstreamKey);
  }
  if (kind === "messages") {
    for (const [key,value] of Object.entries(conn?.headers || {})) headers.set(key, value!);
    if (conn?.version) headers.set("anthropic-version", conn.version);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  }
  headers.set("Content-Type", "application/json");
  return headers;
}
