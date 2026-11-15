import { describe, expect, it } from "vitest";
import { createRealD1 } from "./helpers/realD1";
import {
  adjustBalance,
  chargeBalanceIfAffordable,
  ensureWallet,
  insertLedgerEntry,
  releaseReserve,
  releaseStaleReserves,
  reserveBalance,
  settleBalance,
} from "../src/db/repo";
import { makeEnv, wallet } from "./helpers/realGatewayEnv";


const D1 = () => createRealD1();

async function withWallet(balanceUsd: number, deviceId = "dev-1") {
  const d1 = D1();
  const env = makeEnv(d1);
  await ensureWallet(env, deviceId, balanceUsd);
  return { d1, env, deviceId };
}

describe("the affordability gate is evaluated by SQLite, not by the test", () => {
  it("refuses a reserve that only fits when the funds already held are ignored", async () => {
    const { d1, env, deviceId } = await withWallet(1);
    expect(await reserveBalance(env, deviceId, 0.9, "req-a")).toBe(true);

    expect(await reserveBalance(env, deviceId, 0.5, "req-b")).toBe(false);
    expect(wallet(d1, deviceId)).toMatchObject({ balance_usd: 1, reserved_usd: 0.9 });
    expect(d1.rows("SELECT request_id FROM reserve_holds ORDER BY request_id")).toEqual([
      { request_id: "req-a" },
    ]);
  });

  it("refuses a cache-hit charge that only fits when held funds are ignored", async () => {
    const { d1, env, deviceId } = await withWallet(1);
    expect(await reserveBalance(env, deviceId, 0.9, "req-a")).toBe(true);

    expect(await chargeBalanceIfAffordable(env, deviceId, 0.5, "req-hit")).toBe(false);
    expect(wallet(d1, deviceId)).toMatchObject({ balance_usd: 1, reserved_usd: 0.9 });
    expect(d1.rows("SELECT COUNT(*) AS n FROM wallet_ledger")).toEqual([{ n: 0 }]);

    expect(await chargeBalanceIfAffordable(env, deviceId, 0.05, "req-hit-2")).toBe(true);
    expect(wallet(d1, deviceId)).toMatchObject({ balance_usd: 0.95, reserved_usd: 0.9 });
  });
});

describe("every charge leaves a ledger entry the operator can audit", () => {
  it("records the cache-hit charge with the balance it produced", async () => {
    const { d1, env, deviceId } = await withWallet(1);
    expect(await chargeBalanceIfAffordable(env, deviceId, 0.25, "req-hit")).toBe(true);

    expect(d1.rows("SELECT delta_usd, balance_after, reason, request_id, note FROM wallet_ledger")).toEqual([
      {
        delta_usd: -0.25,
        balance_after: 0.75,
        reason: "usage",
        request_id: "req-hit",
        note: "cache hit (billed at first-time price)",
      },
    ]);
  });

  it("records the settled usage charge, and only once for a replayed request id", async () => {
    const { d1, env, deviceId } = await withWallet(1);
    expect(await reserveBalance(env, deviceId, 0.5, "req-1")).toBe(true);
    expect(await settleBalance(env, deviceId, 0.5, 0.3, "req-1")).toBeCloseTo(0.7, 10);

    await settleBalance(env, deviceId, 0, 0.3, "req-1");

    expect(d1.rows("SELECT delta_usd, balance_after, reason FROM wallet_ledger")).toEqual([
      { delta_usd: -0.3, balance_after: 0.7, reason: "usage" },
    ]);
  });

  it("does not write a ledger row for a zero-cost charge, and still reports success", async () => {
    const { d1, env, deviceId } = await withWallet(0);
    expect(await chargeBalanceIfAffordable(env, deviceId, 0, "req-free")).toBe(true);
    expect(d1.rows("SELECT COUNT(*) AS n FROM wallet_ledger")).toEqual([{ n: 0 }]);
    expect(wallet(d1, deviceId)).toMatchObject({ balance_usd: 0 });
  });

  it("refuses a zero-cost charge for a device that has no wallet row at all", async () => {
    const d1 = D1();
    const env = makeEnv(d1);
    expect(await chargeBalanceIfAffordable(env, "dev-ghost", 0, "req-free")).toBe(true);
    expect(d1.rows("SELECT COUNT(*) AS n FROM device_wallets")).toEqual([{ n: 0 }]);
  });
});

describe("a release only touches the hold it was asked about", () => {
  it("will not release another device's hold even when the request id matches", async () => {
    const { d1, env } = await withWallet(1, "dev-1");
    await ensureWallet(env, "dev-2", 1);
    expect(await reserveBalance(env, "dev-1", 0.4, "req-shared")).toBe(true);

    expect(await releaseReserve(env, "dev-2", "req-shared")).toBe(false);
    expect(wallet(d1, "dev-1")).toMatchObject({ reserved_usd: 0.4 });
    expect(wallet(d1, "dev-2")).toMatchObject({ reserved_usd: 0 });
    expect(d1.rows("SELECT COUNT(*) AS n FROM reserve_holds")).toEqual([{ n: 1 }]);
  });

  it("releases exactly the held amount and leaves a concurrent hold intact", async () => {
    const { d1, env, deviceId } = await withWallet(1);
    expect(await reserveBalance(env, deviceId, 0.3, "req-a")).toBe(true);
    expect(await reserveBalance(env, deviceId, 0.4, "req-b")).toBe(true);

    expect(await releaseReserve(env, deviceId, "req-a")).toBe(true);
    expect(wallet(d1, deviceId)!.reserved_usd).toBeCloseTo(0.4, 10);

    expect(await releaseReserve(env, deviceId, "req-a")).toBe(false);
    expect(wallet(d1, deviceId)!.reserved_usd).toBeCloseTo(0.4, 10);
  });
});

describe("the reaper reclaims holds that no request will ever settle", () => {
  it("releases a hold older than the cutoff and keeps a fresh one", async () => {
    const { d1, env, deviceId } = await withWallet(1);
    expect(await reserveBalance(env, deviceId, 0.25, "req-stale")).toBe(true);
    expect(await reserveBalance(env, deviceId, 0.35, "req-fresh")).toBe(true);

    d1.sql("UPDATE reserve_holds SET created_at = ? WHERE request_id = ?", Date.now() - 90 * 60 * 1000, "req-stale");

    expect(await releaseStaleReserves(env)).toBe(1);
    expect(wallet(d1, deviceId)).toMatchObject({ reserved_usd: 0.35 });
    expect(d1.rows("SELECT request_id FROM reserve_holds")).toEqual([{ request_id: "req-fresh" }]);
  });

  it("keeps a hold that is still inside the window", async () => {
    const { d1, env, deviceId } = await withWallet(1);
    expect(await reserveBalance(env, deviceId, 0.25, "req-young")).toBe(true);

    expect(await releaseStaleReserves(env)).toBe(0);
    expect(wallet(d1, deviceId)).toMatchObject({ reserved_usd: 0.25 });
    expect(d1.rows("SELECT COUNT(*) AS n FROM reserve_holds")).toEqual([{ n: 1 }]);
  });
});

describe("ledger insertion stays idempotent per (device, reason, request id)", () => {
  it("reports the second insert of the same request as a duplicate", async () => {
    const { d1, env, deviceId } = await withWallet(1);
    expect(
      await insertLedgerEntry(env, {
        device_id: deviceId,
        delta_usd: -0.1,
        reason: "usage",
        request_id: "req-dup",
        balance_after: 0.9,
      })
    ).toBe(true);
    expect(
      await insertLedgerEntry(env, {
        device_id: deviceId,
        delta_usd: -0.1,
        reason: "usage",
        request_id: "req-dup",
        balance_after: 0.8,
      })
    ).toBe(false);
    expect(d1.rows("SELECT delta_usd, balance_after FROM wallet_ledger")).toEqual([
      { delta_usd: -0.1, balance_after: 0.9 },
    ]);
  });
});

describe("an overrun is a debt, not something to forgive", () => {
  it("lets settle drive the balance negative and still writes a matching ledger row", async () => {
    const { d1, env, deviceId } = await withWallet(0.2);
    expect(await reserveBalance(env, deviceId, 0.2, "req-overrun")).toBe(true);
    expect(await settleBalance(env, deviceId, 0.2, 5, "req-overrun")).toBeCloseTo(-4.8, 10);
    expect(wallet(d1, deviceId)).toMatchObject({ balance_usd: -4.8, reserved_usd: 0 });

    expect(d1.rows("SELECT delta_usd, balance_after FROM wallet_ledger")).toEqual([
      { delta_usd: -5, balance_after: -4.8 },
    ]);
    const sum = (d1.rows("SELECT SUM(delta_usd) AS total FROM wallet_ledger")[0] as { total: number }).total;
    expect(sum).toBeCloseTo(wallet(d1, deviceId)!.balance_usd - 0.2, 10);
  });

  it("does not let a top-up wash a negative balance back to zero", async () => {
    const { d1, env, deviceId } = await withWallet(-1);
    d1.sql("INSERT OR REPLACE INTO devices (id, name, token_hash, enabled, rate_limit_rpm, created_at) VALUES (?, ?, ?, 1, 0, 1)", deviceId, "Laptop", "hash");
    const res = await adjustBalance(env, deviceId, 0.1, { reason: "topup" });
    expect(res?.balance_usd).toBeCloseTo(-0.9, 10);
    expect(wallet(d1, deviceId)).toMatchObject({ balance_usd: -0.9 });
    expect(d1.rows("SELECT delta_usd, balance_after FROM wallet_ledger")).toEqual([
      { delta_usd: 0.1, balance_after: -0.9 },
    ]);
  });

  it("still refuses to reserve or cache-charge against a negative balance", async () => {
    const { d1, env, deviceId } = await withWallet(-0.5);
    expect(await reserveBalance(env, deviceId, 0.01, "req-broke")).toBe(false);
    expect(await chargeBalanceIfAffordable(env, deviceId, 0.01, "req-broke-hit")).toBe(false);
    expect(d1.rows("SELECT COUNT(*) AS n FROM wallet_ledger")).toEqual([{ n: 0 }]);
    expect(wallet(d1, deviceId)).toMatchObject({ balance_usd: -0.5, reserved_usd: 0 });
  });
});

