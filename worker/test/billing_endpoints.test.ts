import { beforeEach, describe, expect, it } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import { BILLING_RATE_LIMIT_RPM } from "../src/gateway/billing";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, TOKEN, makeEnv, seedDevice } from "./helpers/realGatewayEnv";
import { sha256Hex } from "../src/utils/crypto";
import type { Env } from "../src/types";


const ENV = (d1: RealD1): Env => makeEnv(d1) as unknown as Env;

function req(token: string | null, path: string): Request {
  return new Request("https://gateway.example.com" + path, {
    headers: token ? { Authorization: "Bearer " + token } : {},
  });
}

async function hit(env: Env, path: string, token: string | null = TOKEN) {
  const res = await gatewayApp.fetch(req(token, path), env);
  const body = (await res.clone().json()) as any;
  return { status: res.status, body };
}

const SUB = "/dashboard/billing/subscription";
const USAGE = "/dashboard/billing/usage";

describe("the OpenAI-compatible billing endpoints", () => {
  beforeEach(() => {
    resetRateLimitMemory();
  });

  it("reports the wallet as subscription limits", async () => {
    const d1 = createRealD1();
    await seedDevice(d1, { balance_usd: 12.5 });
    const env = ENV(d1);

    const { status, body } = await hit(env, SUB);
    expect(status).toBe(200);
    expect(body.object).toBe("billing_subscription");
    expect(body.has_payment_method).toBe(true);
    expect(body.hard_limit_usd).toBe(12.5);
    expect(body.system_hard_limit_usd).toBe(12.5);
    expect(body.soft_limit_usd).toBe(12.5);
    expect(body.access_until).toBeNull();
  });

  it("subtracts reserved from the soft limit only", async () => {
    const d1 = createRealD1();
    await seedDevice(d1, { balance_usd: 10 });
    d1.sql("UPDATE device_wallets SET reserved_usd = 2.25 WHERE device_id = ?", DEVICE_ID);
    const env = ENV(d1);

    const { body } = await hit(env, SUB);
    expect(body.hard_limit_usd).toBe(10);
    expect(body.soft_limit_usd).toBe(7.75);
  });

  it("answers usage in cents over the requested window", async () => {
    const d1 = createRealD1();
    await seedDevice(d1, { balance_usd: 5 });
    d1.sql(
      "INSERT INTO usage (device_id, model, cost_usd, status_code, created_at) VALUES (?, 'gw-primary', 0.5, 200, ?)",
      DEVICE_ID,
      Date.UTC(2026, 9, 2, 12, 0, 0)
    );
    d1.sql(
      "INSERT INTO usage (device_id, model, cost_usd, status_code, created_at) VALUES (?, 'gw-primary', 0.25, 200, ?)",
      DEVICE_ID,
      Date.UTC(2026, 9, 15, 12, 0, 0)
    );
    d1.sql(
      "INSERT INTO usage (device_id, model, cost_usd, status_code, created_at) VALUES (?, 'gw-primary', 9.99, 200, ?)",
      DEVICE_ID,
      Date.UTC(2026, 11, 1, 12, 0, 0)
    );
    const env = ENV(d1);

    const full = await hit(env, USAGE + "?start_date=2026-10-01&end_date=2026-10-31");
    expect(full.status).toBe(200);
    expect(full.body.object).toBe("list");
    expect(full.body.total_usage).toBe(75);

    const one = await hit(env, USAGE + "?start_date=2026-10-15&end_date=2026-10-15");
    expect(one.body.total_usage).toBe(25);
  });

  it("gives a sub-token exactly the master's numbers", async () => {
    const d1 = createRealD1();
    await seedDevice(d1, { balance_usd: 3.5 });
    const subToken = "ccs_sub_billing_probe";
    d1.sql(
      "INSERT INTO device_sub_tokens (id, device_id, name, token_hash, enabled, created_at, revoked_at) VALUES ('sub_b1', ?, 'probe', ?, 1, 1, NULL)",
      DEVICE_ID,
      await sha256Hex(subToken)
    );
    const env = ENV(d1);

    const master = await hit(env, SUB, TOKEN);
    const sub = await hit(env, SUB, subToken);
    expect(sub.status).toBe(200);
    expect(sub.body.hard_limit_usd).toBe(master.body.hard_limit_usd);
    expect(sub.body.soft_limit_usd).toBe(master.body.soft_limit_usd);
  });

  it("rejects a bad token with the OpenAI error shape", async () => {
    const d1 = createRealD1();
    await seedDevice(d1);
    const env = ENV(d1);

    for (const path of [SUB, USAGE]) {
      const { status, body } = await hit(env, path, "ccs_wrong_token");
      expect(status).toBe(401);
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.message).toBeTruthy();
    }
  });

  it("reports a negative balance as-is", async () => {
    const d1 = createRealD1();
    await seedDevice(d1, { balance_usd: -0.5 });
    const env = ENV(d1);

    const { body } = await hit(env, SUB);
    expect(body.hard_limit_usd).toBe(-0.5);
    expect(body.soft_limit_usd).toBe(-0.5);
  });

  it("enforces the strict 3 RPM billing bucket", async () => {
    const d1 = createRealD1();
    await seedDevice(d1, { balance_usd: 1 });
    const env = ENV(d1);

    for (let i = 0; i < BILLING_RATE_LIMIT_RPM; i++) {
      expect((await hit(env, SUB)).status).toBe(200);
    }
    const denied = await hit(env, SUB);
    expect(denied.status).toBe(429);
    expect(denied.body.error.type).toBe("rate_limit_error");
  });
});

describe("the DeepSeek-format /user/balance endpoint", () => {
  beforeEach(() => {
    resetRateLimitMemory();
  });

  it("reports the wallet as balance_infos with two-decimal strings", async () => {
    const d1 = createRealD1();
    await seedDevice(d1, { balance_usd: 12.5 });
    const env = ENV(d1);

    for (const path of ["/user/balance", "/user/balance"]) {
      const { status, body } = await hit(env, path);
      expect(status).toBe(200);
      expect(body.is_available).toBe(true);
      expect(body.balance_infos).toHaveLength(1);
      const info = body.balance_infos[0];
      expect(info.currency).toBe("CNY");
      expect(info.total_balance).toBe("12.50");
      expect(info.granted_balance).toBe("0.00");
      expect(info.topped_up_balance).toBe("12.50");
    }
  });

  it("reports a fully reserved wallet as unavailable", async () => {
    const d1 = createRealD1();
    await seedDevice(d1, { balance_usd: 5 });
    d1.sql("UPDATE device_wallets SET reserved_usd = 5 WHERE device_id = ?", DEVICE_ID);
    const env = ENV(d1);

    const { body } = await hit(env, "/user/balance");
    expect(body.is_available).toBe(false);
    expect(body.balance_infos[0].total_balance).toBe("5.00");
  });

  it("reports a negative balance as-is in the string form", async () => {
    const d1 = createRealD1();
    await seedDevice(d1, { balance_usd: -0.5 });
    const env = ENV(d1);

    const { body } = await hit(env, "/user/balance");
    expect(body.is_available).toBe(false);
    expect(body.balance_infos[0].total_balance).toBe("-0.50");
  });

  it("rejects a bad token and shares the 3 RPM billing bucket", async () => {
    const d1 = createRealD1();
    await seedDevice(d1, { balance_usd: 1 });
    const env = ENV(d1);

    const bad = await hit(env, "/user/balance", "ccs_wrong_token");
    expect(bad.status).toBe(401);
    expect(bad.body.error.type).toBe("invalid_request_error");

    for (let i = 0; i < BILLING_RATE_LIMIT_RPM; i++) {
      expect((await hit(env, "/user/balance")).status).toBe(200);
    }
    const denied = await hit(env, "/user/balance");
    expect(denied.status).toBe(429);
    expect(denied.body.error.type).toBe("rate_limit_error");
  });
});
