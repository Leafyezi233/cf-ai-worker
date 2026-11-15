import type { ModelWithProvider } from "../types";

export interface AffinityClaim {
  version: 1;
  issuedAt: number;
  expiresAt: number;
  deviceId: string;
  selection: string;
  modelKey: string;
  serviceGroupId: string | null;
  modelId: string;
  providerId: string;
  credentialFingerprint: string;
}

export type AffinityRow = Pick<ModelWithProvider,
  "id" | "provider_id" | "provider_endpoint" | "provider_type" | "provider_secret_name">;
export interface AffinityExpected {
  deviceId: string;
  selection: string;
  modelKey: string;
}
export interface AffinityTarget {
  serviceGroupId: string | null;
  row: AffinityRow;
  upstreamKey: string;
  upstreamModelName?: string;
  wireIdentity?: string;
}
export type AffinityIssueInput = AffinityExpected & AffinityTarget;
type AffinityEnv = { SESSION_SECRET?: string };

const enc = new TextEncoder();
const KEY_DOMAIN = "cpg:protocol-affinity:aes-gcm:v1\0";
const FINGERPRINT_DOMAIN = "cpg:protocol-affinity:credential:v1\0";
const AAD = enc.encode("cpg:protocol-affinity:token:v1");
const PREFIX = "pa1";
const TTL_SECONDS = 60 * 60;
const MAX_PLAINTEXT_BYTES = 4096;
const MAX_TOKEN_CHARS = 5600;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const keyCache = new Map<string, Promise<CryptoKey>>();

function validSecret(secret: unknown): secret is string {
  return typeof secret === "string" && secret.length > 0 && secret.length <= 16384 && secret.trim().length > 0;
}

function asciiId(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[^\x21-\x7e]/.test(value);
}

function validExpected(value: AffinityExpected): boolean {
  return !!value && asciiId(value.deviceId) && asciiId(value.selection) && asciiId(value.modelKey, 512);
}

function validTarget(value: AffinityTarget): boolean {
  if (!value || !(value.serviceGroupId === null || asciiId(value.serviceGroupId))) return false;
  const row = value.row;
  return !!row && asciiId(row.id) && asciiId(row.provider_id)
    && ["anthropic", "openai", "gemini"].includes(row.provider_type)
    && (row.provider_endpoint === null || (typeof row.provider_endpoint === "string" && row.provider_endpoint.length <= 4096))
    && (row.provider_secret_name === null || (typeof row.provider_secret_name === "string" && row.provider_secret_name.length <= 512))
    && typeof value.upstreamKey === "string" && value.upstreamKey.length > 0 && value.upstreamKey.length <= 16384
    && (value.upstreamModelName === undefined || typeof value.upstreamModelName === "string" && value.upstreamModelName.length > 0 && value.upstreamModelName.length <= 4096);
}

function deriveKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) {
    keyCache.delete(secret);
    keyCache.set(secret, cached);
    return cached;
  }
  const promise = (async () => {
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(KEY_DOMAIN + secret));
    return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  })();
  keyCache.set(secret, promise);
  while (keyCache.size > 2) keyCache.delete(keyCache.keys().next().value!);
  void promise.catch(() => {
    if (keyCache.get(secret) === promise) keyCache.delete(secret);
  });
  return promise;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return base64url(bytes) === value ? bytes : null;
}

async function credentialFingerprint(target: AffinityTarget): Promise<string> {
  const { row, upstreamKey } = target;
  const input = FINGERPRINT_DOMAIN + JSON.stringify([
    upstreamKey, row.provider_endpoint, row.provider_type, row.provider_secret_name, target.upstreamModelName ?? null,
    ...(target.wireIdentity === undefined ? [] : [target.wireIdentity]),
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(input)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

const claimKeys = ["version", "issuedAt", "expiresAt", "deviceId", "selection", "modelKey",
  "serviceGroupId", "modelId", "providerId", "credentialFingerprint"];

function validClaim(value: unknown): value is AffinityClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as AffinityClaim;
  if (Object.keys(value).length !== claimKeys.length || !claimKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) return false;
  const now = Math.floor(Date.now() / 1000);
  return claim.version === 1 && validExpected(claim)
    && Number.isSafeInteger(claim.issuedAt) && claim.issuedAt >= 0 && claim.issuedAt <= now
    && Number.isSafeInteger(claim.expiresAt) && claim.expiresAt === claim.issuedAt + TTL_SECONDS && claim.expiresAt > now
    && (claim.serviceGroupId === null || asciiId(claim.serviceGroupId))
    && asciiId(claim.modelId) && asciiId(claim.providerId)
    && typeof claim.credentialFingerprint === "string" && claim.credentialFingerprint.length === 64
    && /^[a-f0-9]{64}$/.test(claim.credentialFingerprint);
}

export async function issueProtocolAffinity(env: AffinityEnv, input: AffinityIssueInput): Promise<string | null> {
  try {
    const secret = env.SESSION_SECRET;
    if (!validSecret(secret) || !validExpected(input) || !validTarget(input)) return null;
    const issuedAt = Math.floor(Date.now() / 1000);
    const claim: AffinityClaim = {
      version: 1, issuedAt, expiresAt: issuedAt + TTL_SECONDS,
      deviceId: input.deviceId, selection: input.selection, modelKey: input.modelKey,
      serviceGroupId: input.serviceGroupId, modelId: input.row.id, providerId: input.row.provider_id,
      credentialFingerprint: await credentialFingerprint(input),
    };
    if (!validClaim(claim)) return null;
    const plain = enc.encode(JSON.stringify(claim));
    if (plain.byteLength > MAX_PLAINTEXT_BYTES) return null;
    const key = await deriveKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 }, key, plain);
    return PREFIX + "." + base64url(iv) + "." + base64url(new Uint8Array(ciphertext));
  } catch {
    return null;
  }
}

export async function verifyProtocolAffinity(env: AffinityEnv, token: string, expected: AffinityExpected): Promise<AffinityClaim | null> {
  try {
    const secret = env.SESSION_SECRET;
    if (!validSecret(secret) || !validExpected(expected) || typeof token !== "string"
      || token.length > MAX_TOKEN_CHARS || token.length < 44) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX || parts[1].length !== 16) return null;
    const iv = decodeBase64url(parts[1]);
    const ciphertext = decodeBase64url(parts[2]);
    if (!iv || iv.byteLength !== NONCE_BYTES || !ciphertext || ciphertext.byteLength <= TAG_BYTES
      || ciphertext.byteLength > MAX_PLAINTEXT_BYTES + TAG_BYTES) return null;
    const key = await deriveKey(secret);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 }, key, ciphertext);
    if (plain.byteLength > MAX_PLAINTEXT_BYTES) return null;
    const claim: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain));
    if (!validClaim(claim) || claim.deviceId !== expected.deviceId || claim.selection !== expected.selection
      || claim.modelKey !== expected.modelKey) return null;
    return Object.freeze(claim);
  } catch {
    return null;
  }
}

export async function matchProtocolAffinity(claim: AffinityClaim, target: AffinityTarget): Promise<boolean> {
  try {
    if (!validClaim(claim) || !validTarget(target) || claim.serviceGroupId !== target.serviceGroupId
      || claim.modelId !== target.row.id || claim.providerId !== target.row.provider_id) return false;
    const fingerprint = await credentialFingerprint(target);
    let difference = 0;
    for (let i = 0; i < 64; i++) difference |= fingerprint.charCodeAt(i) ^ claim.credentialFingerprint.charCodeAt(i);
    return difference === 0;
  } catch {
    return false;
  }
}
