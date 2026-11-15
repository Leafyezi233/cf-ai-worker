export function videoApiEndpoint(value: unknown, suffix: string): string | null {
  if (typeof value !== "string" || value.length > 2000 || /[\\\s%]/.test(value) || /\/\.{1,2}(?:\/|$)/.test(value)) return null;
  try {
    const u = new URL(value), h = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.port && u.port !== "443")
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(h)
      || /(?:^|\.)(?:localhost|local|internal|home|lan|onion|arpa)$/.test(h)) return null;
    const base = u.pathname.replace(/\/$/, "");
    if (base && base.split("/").slice(1).some(s => !/^[A-Za-z0-9_~-]+$/.test(s))) return null;
    const canonical = u.origin + base;
    if (value !== canonical && value !== canonical + "/") return null;
    return canonical + suffix;
  } catch { return null; }
}
export function videoUpstreamModel(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
}
