import { describe, expect, it } from "vitest";
import { initializedSchemaDouble } from "./helpers/initializedSchemaDouble";
import { devicesApp } from "../src/admin/devices";
import type { Env, LedgerReason, WalletLedgerRow } from "../src/types";


function makeEnv(opts: { deviceIds?: string[]; initial?: Record<string, number> } = {}) {
  const known = new Set(opts.deviceIds ?? ["dev-1"]);
  const wallets = new Map<string, { balance: number; reserved: number; created: number }>();
  for (const [id, balance] of Object.entries(opts.initial ?? {})) {
    wallets.set(id, { balance, reserved: 0, created: 1 });
  }
  const ledger: WalletLedgerRow[] = [];
  let nextId = 1;

  const run = (sql: string, a: unknown[]) => {
    if (sql.startsWith("INSERT OR IGNORE INTO device_wallets")) {
      const deviceId = String(a[0]);
      const balance = a.length >= 4 ? Number(a[1]) : 0;
      if (!wallets.has(deviceId)) wallets.set(deviceId, { balance, reserved: 0, created: 1 });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET balance_usd = balance_usd + ?")) {
      const [delta, , deviceId] = a as [number, number, string];
      const w = wallets.get(deviceId);
      if (!w) return { meta: { changes: 0 } };
      w.balance = w.balance + delta;
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO wallet_ledger")) {
      const [deviceId, delta, balanceAfter, reason, requestId, note, t] = a as [
        string, number, number, LedgerReason, string | null, string | null, number,
      ];
      ledger.push({
        id: nextId++, device_id: deviceId, delta_usd: delta, balance_after: balanceAfter,
        reason, request_id: requestId, note, created_at: t,
      });
      return { meta: { changes: 1 } };
    }
    throw new Error("unexpected statement: " + sql);
  };

  const first = (sql: string, a: unknown[]) => {
    if (sql.includes("FROM devices")) return known.has(String(a[0])) ? { id: String(a[0]) } : null;
    if (sql.includes("SELECT balance_usd FROM device_wallets")) {
      const w = wallets.get(String(a[0]));
      return w ? { balance_usd: w.balance } : null;
    }
    if (sql.includes("FROM device_wallets")) {
      const deviceId = String(a[0]);
      const w = wallets.get(deviceId);
      return w
        ? { device_id: deviceId, balance_usd: w.balance, reserved_usd: w.reserved, created_at: w.created, updated_at: w.created }
        : null;
    }
    throw new Error("unexpected first() query: " + sql);
  };

  const stmt = (sql: string) => {
    let binds: unknown[] = [];
    const self = {
      sql,
      bind: (...args: unknown[]) => { binds = args; return self; },
      first: async () => first(sql, binds),
      all: async () => { throw new Error("unexpected all() query: " + sql); },
      run: async () => run(sql, binds),
    };
    return self;
  };

  const env = {
    DB: initializedSchemaDouble({ prepare: stmt, batch: async (s: unknown[]) => s }),
    ASSETS: null,
    RATE_LIMITER: null,
  } as unknown as Env;

  return { env, wallets, ledger };
}

function topup(env: Env, deviceId: string, body: unknown) {
  return devicesApp.request(`/${deviceId}/topup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, env);
}

describe("admin top-up endpoint", () => {
  it("applies a signed delta unchanged (the original behaviour)", async () => {
    const { env, wallets, ledger } = makeEnv({ initial: { "dev-1": 10 } });
    const res = await topup(env, "dev-1", { amount_usd: 5 });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: { balance_usd: number } };
    expect(json.item.balance_usd).toBeCloseTo(15, 6);
    expect(wallets.get("dev-1")?.balance).toBeCloseTo(15, 6);
    expect(ledger[0].delta_usd).toBeCloseTo(5, 6);
    expect(ledger[0].reason).toBe("topup");
  });

  it("still debits when the amount is negative", async () => {
    const { env, wallets, ledger } = makeEnv({ initial: { "dev-1": 10 } });
    expect((await topup(env, "dev-1", { amount_usd: -2.5 })).status).toBe(200);
    expect(wallets.get("dev-1")?.balance).toBeCloseTo(7.5, 6);
    expect(ledger[0].reason).toBe("adjust");
  });

  it("set mode tops the wallet up to the target in one step", async () => {
    const { env, wallets, ledger } = makeEnv({ initial: { "dev-1": 4 } });
    const res = await topup(env, "dev-1", { mode: "set", target_balance_usd: 20 });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: { balance_usd: number } };
    expect(json.item.balance_usd).toBeCloseTo(20, 6);
    expect(wallets.get("dev-1")?.balance).toBeCloseTo(20, 6);
    expect(ledger[0].delta_usd).toBeCloseTo(16, 6);
    expect(ledger[0].balance_after).toBeCloseTo(20, 6);
    expect(ledger[0].reason).toBe("topup");
  });

  it("set mode can also drain a wallet by naming a smaller target", async () => {
    const { env, wallets, ledger } = makeEnv({ initial: { "dev-1": 30 } });
    expect((await topup(env, "dev-1", { mode: "set", target_balance_usd: 3 })).status).toBe(200);
    expect(wallets.get("dev-1")?.balance).toBeCloseTo(3, 6);
    expect(ledger[0].delta_usd).toBeCloseTo(-27, 6);
    expect(ledger[0].reason).toBe("adjust");
  });

  it("set mode accepts a negative target, so a debt can be written off or set deliberately", async () => {
    const { env, wallets, ledger } = makeEnv({ initial: { "dev-1": 10 } });
    const res = await topup(env, "dev-1", { mode: "set", target_balance_usd: -1 });
    expect(res.status).toBe(200);
    expect(wallets.get("dev-1")?.balance).toBeCloseTo(-1, 6);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].delta_usd).toBeCloseTo(-11, 6);
    expect(ledger[0].reason).toBe("adjust");
    expect(ledger[0].balance_after).toBeCloseTo(-1, 6);
  });

  it("top-up on a negative balance is added to the debt, not swallowed by a floor", async () => {
    const { env, wallets } = makeEnv({ initial: { "dev-1": -3 } });
    await topup(env, "dev-1", { amount_usd: 1 });
    expect(wallets.get("dev-1")?.balance).toBeCloseTo(-2, 6);
  });

  it("set mode rejects a target equal to the current balance as a no-op", async () => {
    const { env, ledger } = makeEnv({ initial: { "dev-1": 10 } });
    const res = await topup(env, "dev-1", { mode: "set", target_balance_usd: 10 });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_amount");
    expect(ledger).toHaveLength(0);
  });

  it("set mode works on a device that has no wallet row yet", async () => {
    const { env, wallets, ledger } = makeEnv();
    expect((await topup(env, "dev-1", { mode: "set", target_balance_usd: 7.5 })).status).toBe(200);
    expect(wallets.get("dev-1")?.balance).toBeCloseTo(7.5, 6);
    expect(ledger[0].balance_after).toBeCloseTo(7.5, 6);
  });

  it("404s an unknown device in both modes", async () => {
    const { env, ledger } = makeEnv({ deviceIds: ["dev-1"] });
    expect((await topup(env, "dev-ghost", { amount_usd: 5 })).status).toBe(404);
    expect((await topup(env, "dev-ghost", { mode: "set", target_balance_usd: 5 })).status).toBe(404);
    expect(ledger).toHaveLength(0);
  });

  it("rejects a zero delta", async () => {
    const { env, ledger } = makeEnv({ initial: { "dev-1": 10 } });
    expect((await topup(env, "dev-1", { amount_usd: 0 })).status).toBe(400);
    expect(ledger).toHaveLength(0);
  });

  it("keeps the ledger note an admin supplied", async () => {
    const { env, ledger } = makeEnv({ initial: { "dev-1": 0 } });
    await topup(env, "dev-1", { mode: "set", target_balance_usd: 9, note: "renewal" });
    expect(ledger[0].note).toBe("renewal");
  });
});