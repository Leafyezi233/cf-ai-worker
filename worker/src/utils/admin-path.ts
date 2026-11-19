import type { Env } from "../types";
export function adminPrefix(env: Env): string | null {
  const value = env.ADMIN_PATH_PREFIX ?? "admin-prefix-example";
  return /^[A-Za-z0-9_-]{6,80}$/.test(value) && !["console", "assets", "__admin", "api", "v1", "me", "health", "user", "models"].includes(value) ? "/" + value : null;
}
