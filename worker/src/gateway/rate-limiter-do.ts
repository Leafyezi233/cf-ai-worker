import type { Env } from "../types";

export class RateLimiterDO {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/peek")) {
      return this.peek(Number(url.searchParams.get("rpm") || "0"));
    }
    if (request.method !== "POST") {
      return new Response("method_not_allowed", { status: 405 });
    }

    const rpm = Number(url.searchParams.get("rpm") || "0");
    if (!rpm || rpm <= 0) {
      return Response.json({ allowed: true, remaining: null, reset_ms: 0 });
    }

    const windowMs = 60000;
    const now = Date.now();
    const stored = (await this.state.storage.get<number[]>("window")) || [];
    const recent = stored.filter((t) => t > now - windowMs);

    if (recent.length >= rpm) {
      const oldest = recent[0];
      return Response.json({
        allowed: false,
        remaining: 0,
        reset_ms: Math.max(0, oldest + windowMs - now),
      });
    }

    recent.push(now);
    await this.state.storage.put("window", recent);

    return Response.json({
      allowed: true,
      remaining: rpm - recent.length,
      reset_ms: Math.max(0, recent[0] + windowMs - now),
    });
  }

  private async peek(rpm: number): Promise<Response> {
    if (!rpm || rpm <= 0) {
      return Response.json({ remaining: null, reset_ms: 0, window_ms: 60000 });
    }

    const windowMs = 60000;
    const now = Date.now();
    const stored = (await this.state.storage.get<number[]>("window")) || [];
    const recent = stored.filter((t) => t > now - windowMs);

    return Response.json({
      remaining: Math.max(0, rpm - recent.length),
      used: recent.length,
      reset_ms: recent.length ? Math.max(0, recent[0] + windowMs - now) : 0,
      window_ms: windowMs,
    });
  }
}

export async function peekViaDurableObject(
  env: Env,
  deviceId: string,
  rpm: number
): Promise<{ remaining: number | null; used?: number; reset_ms: number; window_ms?: number } | null> {
  const ns = env.RATE_LIMITER;
  if (!ns) return null;
  const stub = ns.get(ns.idFromName(deviceId));
  const res = await stub.fetch(`https://rate-limiter.internal/peek?rpm=${rpm}`);
  return (await res.json()) as {
    remaining: number | null;
    used?: number;
    reset_ms: number;
    window_ms?: number;
  };
}

export async function checkViaDurableObject(env: Env, deviceId: string, rpm: number): Promise<boolean> {
  const ns = env.RATE_LIMITER;
  if (!ns) return true;
  const stub = ns.get(ns.idFromName(deviceId));
  const res = await stub.fetch(`https://rate-limiter.internal/consume?rpm=${rpm}`, { method: "POST" });
  const data = (await res.json()) as { allowed?: boolean };
  return data.allowed !== false;
}
