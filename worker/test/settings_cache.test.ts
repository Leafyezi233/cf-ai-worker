import { beforeEach, describe, expect, it } from "vitest";
import { getSetting, resetSettingsCacheForTest, setSetting } from "../src/db/repo";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import type { Env } from "../src/types";

function makeEnv(d1: RealD1): Env {
  return { DB: d1.DB, ASSETS: null } as unknown as Env;
}

function settingRow(d1: RealD1, key: string) {
  return d1.row<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", key);
}

describe("settings that are read on every request are cached briefly", () => {
  beforeEach(() => {
    resetSettingsCacheForTest();
  });

  it("answers a repeated read without going back to D1", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await setSetting(env, "budget_config", { monthly_budget_usd: 12.5 });

    expect(await getSetting(env, "budget_config")).toEqual({ monthly_budget_usd: 12.5 });
    d1.sql("UPDATE settings SET value_json = ? WHERE key = ?", JSON.stringify({ monthly_budget_usd: 99 }), "budget_config");
    expect(await getSetting(env, "budget_config")).toEqual({ monthly_budget_usd: 12.5 });
  });

  it("also caches the answer that nothing is configured", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);

    expect(await getSetting(env, "budget_config")).toBeNull();
    await setSetting(env, "budget_config", { monthly_budget_usd: 7 });
    expect(await getSetting(env, "budget_config")).toEqual({ monthly_budget_usd: 7 });
  });

  it("shows a write on the very next read", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await setSetting(env, "budget_config", { monthly_budget_usd: 1 });
    expect(await getSetting(env, "budget_config")).toEqual({ monthly_budget_usd: 1 });

    await setSetting(env, "budget_config", { monthly_budget_usd: 2 });
    expect(await getSetting(env, "budget_config")).toEqual({ monthly_budget_usd: 2 });
  });

  it("keeps two environments apart even with the same key", async () => {
    const d1a = createRealD1();
    const d1b = createRealD1();
    const a = makeEnv(d1a);
    const b = makeEnv(d1b);
    await setSetting(a, "budget_config", { monthly_budget_usd: 10 });
    await setSetting(b, "budget_config", { monthly_budget_usd: 20 });

    expect(await getSetting(a, "budget_config")).toEqual({ monthly_budget_usd: 10 });
    expect(await getSetting(b, "budget_config")).toEqual({ monthly_budget_usd: 20 });
  });
});

describe("settings whose freshness is a security property are never cached", () => {
  beforeEach(() => {
    resetSettingsCacheForTest();
  });

  it("reads session_epoch from D1 every time", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await setSetting(env, "session_epoch", 1);
    expect(await getSetting(env, "session_epoch")).toBe(1);

    d1.sql("UPDATE settings SET value_json = ? WHERE key = ?", JSON.stringify(2), "session_epoch");
    expect(await getSetting(env, "session_epoch")).toBe(2);
  });

  it("reads webhook_config and ip_whitelist_config from D1 every time", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await setSetting(env, "webhook_config", { url: "https://hook.example/a", secret: "k" });
    await setSetting(env, "ip_whitelist_config", { ips: ["203.0.113.9"] });
    expect((await getSetting<{ url: string }>(env, "webhook_config"))!.url).toBe("https://hook.example/a");
    expect(await getSetting(env, "ip_whitelist_config")).toEqual({ ips: ["203.0.113.9"] });

    d1.sql("UPDATE settings SET value_json = ? WHERE key = ?", JSON.stringify({ ips: ["198.51.100.1"] }), "ip_whitelist_config");
    d1.sql("UPDATE settings SET value_json = ? WHERE key = ?", JSON.stringify({ url: "https://hook.example/b", secret: "k" }), "webhook_config");
    expect(await getSetting(env, "ip_whitelist_config")).toEqual({ ips: ["198.51.100.1"] });
    expect((await getSetting<{ url: string }>(env, "webhook_config"))!.url).toBe("https://hook.example/b");
  });

  it("reads provider health from D1 every time", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await setSetting(env, "provider_health:prov_a", { status: "down" });
    expect(await getSetting(env, "provider_health:prov_a")).toEqual({ status: "down" });

    d1.sql("UPDATE settings SET value_json = ? WHERE key = ?", JSON.stringify({ status: "ok" }), "provider_health:prov_a");
    expect(await getSetting(env, "provider_health:prov_a")).toEqual({ status: "ok" });
  });

  it("still caches an ordinary key next to the denied ones", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await setSetting(env, "session_epoch", 1);
    await setSetting(env, "budget_config", { monthly_budget_usd: 3 });
    await getSetting(env, "budget_config");
    await getSetting(env, "session_epoch");

    d1.sql("UPDATE settings SET value_json = ? WHERE key = ?", JSON.stringify({ monthly_budget_usd: 4 }), "budget_config");
    d1.sql("UPDATE settings SET value_json = ? WHERE key = ?", JSON.stringify(2), "session_epoch");
    expect(await getSetting(env, "budget_config")).toEqual({ monthly_budget_usd: 3 });
    expect(await getSetting(env, "session_epoch")).toBe(2);
  });
});
