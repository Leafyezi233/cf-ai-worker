import type { Env } from "../types";


interface AccessJwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

interface JwksCacheEntry {
  keys: AccessJwk[];
  expiresAt: number;
}

const JWKS_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

const jwksCache = new Map<string, JwksCacheEntry>();

export function resetCfAccessCacheForTest(): void {
  jwksCache.clear();
}

function base64UrlToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(b64 + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function base64UrlToJson(value: string): any | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
  } catch {
    return null;
  }
}

export function normalizeTeamDomain(raw: string | undefined | null): string | null {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

async function fetchSigningKeys(teamDomain: string): Promise<AccessJwk[]> {
  const cached = jwksCache.get(teamDomain);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.keys;
  try {
    const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return cached?.keys ?? [];
    const body: any = await res.json();
    const keys: AccessJwk[] = Array.isArray(body?.keys) ? body.keys : [];
    jwksCache.set(teamDomain, { keys, expiresAt: now + JWKS_TTL_MS });
    return keys;
  } catch {
    return cached?.keys ?? [];
  }
}

export interface CfAccessIdentity {
  email: string;
  sub?: string;
}

export async function verifyCfAccessJwt(
  token: string | undefined | null,
  env: Pick<Env, "CF_ACCESS_TEAM_DOMAIN" | "CF_ACCESS_AUD"> | undefined
): Promise<CfAccessIdentity | null> {
  if (!token) return null;
  const teamDomain = normalizeTeamDomain(env?.CF_ACCESS_TEAM_DOMAIN);
  if (!teamDomain) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const header = base64UrlToJson(parts[0]);
  const payload = base64UrlToJson(parts[1]);
  if (!header || !payload) return null;
  if (header.alg !== "RS256") return null;

  const keys = await fetchSigningKeys(teamDomain);
  const jwk =
    keys.find((k) => header.kid && k.kid === header.kid) ??
    (keys.length === 1 ? keys[0] : undefined);
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) return null;

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
  } catch {
    return null;
  }

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      base64UrlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  const nowSeconds = Date.now() / 1000;
  if (typeof payload.exp === "number" && payload.exp < nowSeconds) return null;
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds + CLOCK_SKEW_SECONDS) return null;

  const audience = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === "string"
      ? [payload.aud]
      : [];
  const expectedAudience = String(env?.CF_ACCESS_AUD || "").trim();
  if (expectedAudience && !audience.includes(expectedAudience)) return null;

  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (!email) return null;

  return { email, sub: typeof payload.sub === "string" ? payload.sub : undefined };
}
