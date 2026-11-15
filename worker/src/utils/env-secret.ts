
export const RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set([
  "ADMIN_SECRET",
  "SESSION_SECRET",
  "ENCRYPTION_KEY",
  "DB",
  "ASSETS",
  "CACHE_KV",
  "RATE_LIMITER",
  "GATEWAY_BASE_URL",
  "APP_NAME",
  "TRUST_FORWARD_HEADERS",
  "CORS_ALLOWED_ORIGINS",
]);

const RESERVED_SECRET_PREFIXES = ["CF_ACCESS_"];

export function isReservedSecretName(name: string | null | undefined): boolean {
  if (!name) return false;
  const upper = name.trim().toUpperCase();
  if (!upper) return false;
  if (RESERVED_SECRET_NAMES.has(upper)) return true;
  return RESERVED_SECRET_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function secretNamePolicyError(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  if (trimmed.length > 100) return "环境变量名不能超过 100 个字符";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    return "环境变量名只能包含字母、数字和下划线，且不能以数字开头";
  }
  if (isReservedSecretName(trimmed)) {
    return `不能把网关自身的变量 ${trimmed} 当作上游密钥`;
  }
  return null;
}

export function readEnvSecret(env: Record<string, unknown> | undefined, name: string | null | undefined): string | undefined {
  if (!env || !name) return undefined;
  const trimmed = String(name).trim();
  if (!trimmed || isReservedSecretName(trimmed)) return undefined;
  const value = env[trimmed];
  return typeof value === "string" && value ? value : undefined;
}
