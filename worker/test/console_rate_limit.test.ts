import { beforeEach, describe, expect, it } from "vitest";
import { consoleApp } from "../src/console";
import { CONSOLE_RATE_LIMIT_RPM } from "../src/console/account";
import { checkDeviceRateLimit } from "../src/db/repo";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, TOKEN, makeEnv, seedDevice } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";

const ENV = (d1: RealD1): Env => ({ ...makeEnv(d1), SESSION_SECRET: "console-session-secret" } as unknown as Env);

function req(token: string | null, path = "/me"): Request {
  return new Request("https://gateway.example.com" + path, {
    headers: token ? { Authorization: "Bearer " + token } : {},
  });
}

async function hit(env: Env, path = "/me", token: string | null = TOKEN) {
  const res = await consoleApp.fetch(req(token, path), env);
  const body = (await res.clone().json()) as any;
  return { status: res.status, body, retryAfter: res.headers.get("Retry-After") };
}
describe("the console rate limits a device token on its own bucket", () => {
  beforeEach(() => {
    resetRateLimitMemory();
  });

  it("answers 429 once the caller exceeds the console budget", async () => {
    const d1 = createRealD1();
    await seedDevice(d1);
    const env = ENV(d1);

    for (let i = 0; i < CONSOLE_RATE_LIMIT_RPM; i++) {
      expect((await hit(env)).status).toBe(200);
    }
    const denied = await hit(env);
    expect(denied.status).toBe(429);
    expect(denied.body.error).toBe("console_rate_limited");
    expect(denied.retryAfter).toBe("60");
  });

  it("counts every console endpoint, not just the one being hammered", async () => {
    const d1 = createRealD1();
    await seedDevice(d1);
    const env = ENV(d1);

    for (let i = 0; i < CONSOLE_RATE_LIMIT_RPM; i++) {
      expect((await hit(env, i % 2 === 0 ? "/me" : "/quota")).status).toBe(200);
    }
    const denied = await hit(env, "/usage");
    expect(denied.status).toBe(429);
    expect(denied.body.error).toBe("console_rate_limited");
  });

  it("does not double count the account routes that also require a password", async () => {
    const d1 = createRealD1();
    await seedDevice(d1);
    const env = ENV(d1);

    const half = Math.ceil(CONSOLE_RATE_LIMIT_RPM / 2);
    for (let i = 0; i < half; i++) {
      expect((await hit(env, "/tokens")).status).toBe(401);
    }
    expect((await hit(env)).status).toBe(200);
  });

  it("keeps the model bucket separate so a busy console cannot stop paid traffic", async () => {
    const d1 = createRealD1();
    await seedDevice(d1, { rate_limit_rpm: 5 });
    const env = ENV(d1);

    for (let i = 0; i <= CONSOLE_RATE_LIMIT_RPM; i++) await hit(env);
    expect((await hit(env)).status).toBe(429);

    for (let i = 0; i < 5; i++) {
      expect(await checkDeviceRateLimit(env, DEVICE_ID + "::model::gw-primary", 5)).toBe(true);
    }
    expect(await checkDeviceRateLimit(env, DEVICE_ID + "::model::gw-primary", 5)).toBe(false);
  });

  it("leaves anonymous callers out of the budget entirely", async () => {
    const d1 = createRealD1();
    await seedDevice(d1);
    const env = ENV(d1);

    for (let i = 0; i < CONSOLE_RATE_LIMIT_RPM + 5; i++) {
      expect((await consoleApp.fetch(req(null), env)).status).toBe(401);
    }
    expect((await hit(env)).status).toBe(200);
  });
});
