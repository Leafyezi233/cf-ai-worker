import { describe, expect, it } from "vitest";
import { ensureWallet, getWallet, releaseStaleReserves, reserveBalance } from "../src/db/repo";
import { makeWalletFixture } from "./helpers/walletFixture";

const makeEnv = makeWalletFixture;

describe("releaseStaleReserves", () => {
  it("releases a hold whose request died before it could settle", async () => {
    const { env, holds, ageHold, buckets } = await makeEnv();
    await ensureWallet(env, "dev-1", 5);
    await reserveBalance(env, "dev-1", 2, "req-dead");
    ageHold("req-dead", 90 * 60 * 1000);
    expect((await getWallet(env, "dev-1")).reserved_usd).toBe(2);

    expect(await releaseStaleReserves(env)).toBe(1);
    expect(holds.has("req-dead")).toBe(false);
    const wallet = await getWallet(env, "dev-1");
    expect(wallet.reserved_usd).toBe(0);
    expect(wallet.balance_usd).toBe(5);
    expect([...buckets.values()]).toEqual([{ request_count: 1, error_count: 0 }]);
  });

  it("leaves a hold alone while its request could still be running", async () => {
    const { env, ageHold } = await makeEnv();
    await ensureWallet(env, "dev-1", 5);
    await reserveBalance(env, "dev-1", 2, "req-live");
    ageHold("req-live", 60 * 1000);

    expect(await releaseStaleReserves(env)).toBe(0);
    expect((await getWallet(env, "dev-1")).reserved_usd).toBe(2);
  });

  it("only releases the stale hold when a live one shares the wallet", async () => {
    const { env, ageHold } = await makeEnv();
    await ensureWallet(env, "dev-1", 10);
    await reserveBalance(env, "dev-1", 3, "req-dead");
    await reserveBalance(env, "dev-1", 4, "req-live");
    ageHold("req-dead", 90 * 60 * 1000);

    expect(await releaseStaleReserves(env)).toBe(1);
    expect((await getWallet(env, "dev-1")).reserved_usd).toBe(4);
  });

  it("honours a caller-supplied threshold", async () => {
    const { env, ageHold } = await makeEnv();
    await ensureWallet(env, "dev-1", 5);
    await reserveBalance(env, "dev-1", 2, "req-a");
    ageHold("req-a", 5 * 60 * 1000);

    expect(await releaseStaleReserves(env, 90 * 60 * 1000)).toBe(0);
    expect((await getWallet(env, "dev-1")).reserved_usd).toBe(2);
    expect(await releaseStaleReserves(env, 60 * 1000)).toBe(1);
    expect((await getWallet(env, "dev-1")).reserved_usd).toBe(0);
  });

  it("reports 0 when there is nothing stale to release", async () => {
    const { env } = await makeEnv();
    await ensureWallet(env, "dev-1", 5);
    expect(await releaseStaleReserves(env)).toBe(0);
  });
});
