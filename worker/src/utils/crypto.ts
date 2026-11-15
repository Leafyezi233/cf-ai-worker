const enc = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToBase64Url(new Uint8Array(sig));
}

export function generateDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return "ccs_" + bytesToBase64Url(bytes);
}

export async function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const SESSION_COOKIE = "__Host-session";
const LEGACY_SESSION_COOKIE = "session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  admin: boolean;
  exp: number;
  epoch?: number;
}

export async function signSession(secret: string, epoch = 0): Promise<string> {
  const payload: SessionPayload = { admin: true, exp: Date.now() + SESSION_TTL_MS, epoch };
  const body = bytesToBase64Url(enc.encode(JSON.stringify(payload)));
  const sig = await hmacSha256Base64Url(secret, body);
  return `${body}.${sig}`;
}

export async function verifySession(secret: string, cookieHeader: string | null | undefined): Promise<SessionPayload | null> {
  if (!secret || !cookieHeader) return null;
  const parts = cookieHeader.split(";").map((s) => s.trim());
  const cookie =
    parts.find((s) => s.startsWith(`${SESSION_COOKIE}=`)) ??
    parts.find((s) => s.startsWith(`${LEGACY_SESSION_COOKIE}=`));
  if (!cookie) return null;
  const value = cookie.slice(cookie.indexOf("=") + 1);
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = await hmacSha256Base64Url(secret, body);
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))) as SessionPayload;
    if (!payload.admin || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildSessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearSessionCookies(): string[] {
  return [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${LEGACY_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  ];
}

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 20;
const PASSWORD_ALLOWED = /^[A-Za-z0-9!@#$%^&*()_\-+=.,:;?\/[\]{}|~]+$/;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BYTES = 32;

export function passwordPolicyError(password: unknown): string | null {
  if (typeof password !== "string" || password.length === 0) return "请输入密码";
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`;
  if (password.length > PASSWORD_MAX_LENGTH) return `密码不能超过 ${PASSWORD_MAX_LENGTH} 位`;
  if (!PASSWORD_ALLOWED.test(password))
    return "密码只能包含字母、数字和常见英文符号（不能有空格或中文）";
  return null;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, keyBytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    keyBytes * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_BYTES);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1_000 || iterations > 1_000_000) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64UrlToBytes(parts[2]);
    expected = base64UrlToBytes(parts[3]);
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await pbkdf2(password, salt, iterations, expected.length);
  return safeEqual(bytesToBase64Url(actual), parts[3]);
}

const USER_SESSION_COOKIE = "__Host-user-session";
const USER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface UserSessionPayload {
  sub: string;
  kind: "console";
  pv: number | null;
  exp: number;
}

export async function signUserSession(
  secret: string,
  sub: string,
  passwordUpdatedAt: number | null
): Promise<string> {
  const payload: UserSessionPayload = {
    sub,
    kind: "console",
    pv: typeof passwordUpdatedAt === "number" ? passwordUpdatedAt : null,
    exp: Date.now() + USER_SESSION_TTL_MS,
  };
  const body = bytesToBase64Url(enc.encode(JSON.stringify(payload)));
  const sig = await hmacSha256Base64Url(secret, body);
  return `${body}.${sig}`;
}

export async function verifyUserSessionValue(
  secret: string | null | undefined,
  value: string | null | undefined
): Promise<UserSessionPayload | null> {
  if (!secret || !value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = await hmacSha256Base64Url(secret, body);
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))) as UserSessionPayload;
    if (payload.kind !== "console") return null;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function verifyUserSession(
  secret: string | null | undefined,
  cookieHeader: string | null | undefined
): Promise<UserSessionPayload | null> {
  if (!secret || !cookieHeader) return null;
  const parts = cookieHeader.split(";").map((s) => s.trim());
  const cookie = parts.find((s) => s.startsWith(`${USER_SESSION_COOKIE}=`));
  if (!cookie) return null;
  return verifyUserSessionValue(secret, cookie.slice(cookie.indexOf("=") + 1));
}

export function buildUserSessionCookie(value: string): string {
  return `${USER_SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
    USER_SESSION_TTL_MS / 1000
  )}`;
}

export function clearUserSessionCookie(): string {
  return `${USER_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}


const ENC_PREFIX = "enc:v1:";
const IV_BYTES = 12;

function base64UrlToBytesLocal(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(b64 + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

const derivedKeyCache = new Map<string, Promise<CryptoKey>>();

export function __resetDerivedKeyCache(): void {
  derivedKeyCache.clear();
}

function deriveAesKey(key: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const cacheKey = usage + ":" + key;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;

  const derived = (async () => {
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(key));
    return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [usage]);
  })();
  derivedKeyCache.set(cacheKey, derived);
  derived.catch(() => derivedKeyCache.delete(cacheKey));
  return derived;
}

export async function sealSecret(plaintext: string, key: string | undefined | null): Promise<string> {
  if (!plaintext) return plaintext;
  if (isEncryptedSecret(plaintext)) return plaintext;
  if (!key) {
    throw new Error(
      "ENCRYPTION_KEY is not configured: refusing to store a provider credential in plaintext. " +
        "Set ENCRYPTION_KEY as a Worker secret and retry."
    );
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cryptoKey = await deriveAesKey(key, "encrypt");
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, enc.encode(plaintext))
  );
  return ENC_PREFIX + bytesToBase64Url(iv) + "." + bytesToBase64Url(ct);
}

export async function openSecret(value: string | null | undefined, key: string | undefined | null): Promise<string | null> {
  if (!value) return null;
  if (!isEncryptedSecret(value)) return value;
  if (!key) return null;
  const payload = value.slice(ENC_PREFIX.length);
  const dot = payload.indexOf(".");
  if (dot <= 0) return null;
  try {
    const iv = base64UrlToBytesLocal(payload.slice(0, dot));
    const ct = base64UrlToBytesLocal(payload.slice(dot + 1));
    const cryptoKey = await deriveAesKey(key, "decrypt");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function randomUUID(): string {
  return crypto.randomUUID();
}
