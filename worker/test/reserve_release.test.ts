import { describe, expect, it } from "vitest";
import {
  ensureWallet,
  getWallet,
  releaseReserve,
  reserveBalance,
  settleBalance,
} from "../src/db/repo";
import { makeWalletFixture } from "./helpers/walletFixture";

const makeEnv = makeWalletFixture;

describe("reserve holds are recorded by request id", () => {
  it("writes a hold row for the request that took the reserve", async () => {
    const { env, holds } = await makeEnv();
    await ensureWallet(env, "dev-1", 5);
    expect(await reserveBalance(env, "dev-1", 1, "req-a")).toBe(true);
    expect(holds.get("req-a")?.amount_usd).toBe(1);
    expect((await getWallet(env, "dev-1")).reserved_usd).toBe(1);
  });

  it("does not double-hold when the same request reserves twice", async () => {
    const { env, holds } = await makeEnv();
    await ensureWallet(env, "dev-1", 5);
    expect(await reserveBalance(env, "dev-1", 1, "req-a")).toBe(true);
    expect(await reserveBalance(env, "dev-1", 1, "req-a")).toBe(true);
    expect(holds.size).toBe(1);
    expect((await getWallet(env, "dev-1")).reserved_usd).toBe(1);
  });

  it("still refuses a request the device cannot afford, and records no hold", async () => {
    const { env, holds } = await makeEnv();
    await ensureWallet(env, "dev-1", 0.5);
    expect(await reserveBalance(env, "dev-1", 1, "req-a")).toBe(false);
    expect(holds.size).toBe(0);
    expect((await getWallet(env, "dev-1")).reserved_usd).toBe(0);
  });

  it("drops the hold row when the request settles", async () => {
    const { env, holds } = await makeEnv();
    await ensureWallet(env, "dev-1", 5);
    await reserveBalance(env, "dev-1", 1, "req-a");
    await settleBalance(env, "dev-1", 1, 0.25, "req-a");
    expect(holds.has("req-a")).toBe(false);
    const wallet = await getWallet(env, "dev-1");
    expect(wallet.reserved_usd).toBe(0);
    expect(wallet.balance_usd).toBeCloseTo(4.75, 6);
  });
});

describe("releaseReserve", () => {
  it("gives the held amount back and forgets the hold", async () => {
    const { env, holds } = await makeEnv();
    await ensureWallet(env, "dev-1", 5);
    await reserveBalance(env, "dev-1", 2, "req-a");
    expect(await releaseReserve(env, "dev-1", "req-a")).toBe(true);
    expect(holds.has("req-a")).toBe(false);
    expect((await getWallet(env, "dev-1")).reserved_usd).toBe(0);
    expect((await getWallet(env, "dev-1")).balance_usd).toBe(5);
  });

  it("is idempotent: a second release for the same request does nothing", async () => {
    const { env } = await makeEnv();
    await ensureWallet(env, "dev-1", 5);
    await reserveBalance(env, "dev-1", 2, "req-a");
    expect(await releaseReserve(env, "dev-1", "req-a")).toBe(true);
    expect(await releaseReserve(env, "dev-1", "req-a")).toBe(false);
    expect((await getWallet(env, "dev-1")).reserved_usd).toBe(0);
  });

  it("reports false for a request that never held anything, without touching the wallet", async () => {
    const { env } = await makeEnv();
    await ensureWallet(env, "dev-1", 5);
    await reserveBalance(env, "dev-1", 2, "req-live");
    expect(await releaseReserve(env, "dev-1", "req-unknown")).toBe(false);
    expect((await getWallet(env, "dev-1")).reserved_usd).toBe(2);
  });

  it("does not release a hold that belongs to a different device", async () => {
    const { env } = await makeEnv();
    await ensureWallet(env, "dev-1", 5);
    await reserveBalance(env, "dev-1", 2, "req-a");
    expect(await releaseReserve(env, "dev-2", "req-a")).toBe(false);
    expect((await getWallet(env, "dev-1")).reserved_usd).toBe(2);
  });

  it("only releases its own hold when several requests hold funds at once", async () => {
    const { env } = await makeEnv();
    await ensureWallet(env, "dev-1", 10);
    await reserveBalance(env, "dev-1", 3, "req-a");
    await reserveBalance(env, "dev-1", 4, "req-b");
    expect(await releaseReserve(env, "dev-1", "req-a")).toBe(true);
    expect((await getWallet(env, "dev-1")).reserved_usd).toBe(4);
  });
});
