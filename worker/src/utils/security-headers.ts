import type { Context, Next } from "hono";

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

function isHtmlResponse(res: Response): boolean {
  return (res.headers.get("Content-Type") || "").toLowerCase().includes("text/html");
}

export function withSecurityHeaders(res: Response): Response {
  const values: Record<string, string> = { ...BASE_HEADERS };
  if (isHtmlResponse(res)) values["Content-Security-Policy"] = CSP;
  try {
    for (const [k, v] of Object.entries(values)) res.headers.set(k, v);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(values)) headers.set(k, v);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
}

export async function applySecurityHeaders(c: Context, next: Next) {
  await next();
  c.res = withSecurityHeaders(c.res);
}