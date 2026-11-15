import { describe, expect, it } from "vitest";
import {
  adjustBalance,
  ensureWallet,
  getBalance,
  getWallet,
  insertLedgerEntry,
  listLedger,
  reserveBalance,
  resolvePricingMode,
  settleBalance,
} from "../src/db/repo";
import { makeWalletFixture } from "./helpers/walletFixture";
import { MIGRATION_ALTERS } from "../src/db/schema";

const makeEnv = makeWalletFixture;

describe("resolvePricingMode", () => {
  it("never guesses free: an unconfigured model stays unset", () => {
    expect(resolvePricingMode(undefined, 0, 0)).toBe("unset");
    expect(resolvePricingMode("unset", 2.5, 10)).toBe("unset");
  });

  it("treats any non-zero price as priced and honours an explicit mode", () => {
    expect(resolvePricingMode(undefined, 0, 10)).toBe("priced");
    expect(resolvePricingMode(undefined, 2.5, 0)).toBe("priced");
    expect(resolvePricingMode("free", 2.5, 10)).toBe("free");
  });

  it("keeps the stored mode as the fallback when a partial update arrives", () => {
    expect(resolvePricingMode(undefined, 0, 0, "priced")).toBe("priced");
    expect(resolvePricingMode(undefined, 0, 0, "free")).toBe("free");
  });
});

describe("device wallet reserve/settle", () => {
  it("reports a lazily-created absent wallet as a $0 wallet", async () => {
    const { env } = await makeEnv();
    const wallet = await getWallet(env, "dev-unknown");
    expect(wallet.balance_usd).toBe(0);
    expect(wallet.reserved_usd).toBe(0);
    expect(wallet.created_at).toBeNull();
  });

  it("blocks any paid request on a device with no wallet row", async () => {
    const { env } = await makeEnv();
    expect(await reserveBalance(env, "dev-1", 0.01)).toBe(false);
  });

  it("lets a free (zero-cost) request through regardless of balance", async () => {
    const { env } = await makeEnv();
    expect(await reserveBalance(env, "dev-1", 0)).toBe(true);
  });

  it("rejects a reserve larger than the balance", async () => {
    const { env } = await makeEnv();
    await ensureWallet(env, "dev-1", 1);
    expect(await reserveBalance(env, "dev-1", 1.5)).toBe(false);
    expect(await reserveBalance(env, "dev-1", 1)).toBe(true);
  });

  it("does not let two concurrent requests dip into the same last dollar", async () => {
    const { env } = await makeEnv();
    await ensureWallet(env, "dev-1", 1);
    expect(await reserveBalance(env, "dev-1", 1)).toBe(true);
    expect(await reserveBalance(env, "dev-1", 1)).toBe(false);
  });

  it("settles the actual cost and releases the unused part of the reserve", async () => {
    const { env, wallets } = await makeEnv();
    await ensureWallet(env, "dev-1", 10);
    await reserveBalance(env, "dev-1", 2);
    const after = await settleBalance(env, "dev-1", 2, 0.5, "req-1");
    expect(after).toBeCloseTo(9.5, 6);
    expect(wallets.get("dev-1")?.balance).toBeCloseTo(9.5, 6);
    expect(wallets.get("dev-1")?.reserved).toBe(0);
  });

  it("releases the whole reserve when a free model settles at $0", async () => {
    const { env, wallets } = await makeEnv();
    await ensureWallet(env, "dev-1", 10);
    await reserveBalance(env, "dev-1", 2);
    await settleBalance(env, "dev-1", 2, 0, "req-2");
    expect(wallets.get("dev-1")?.balance).toBe(10);
    expect(wallets.get("dev-1")?.reserved).toBe(0);
  });

  it("drives the balance negative when the actual cost exceeds what the device held", async () => {
    const { env, wallets, ledger } = await makeEnv();
    await ensureWallet(env, "dev-1", 0.2);
    const after = await settleBalance(env, "dev-1", 0, 5, "req-3");
    expect(after).toBeCloseTo(-4.8, 6);
    expect(wallets.get("dev-1")?.balance).toBeCloseTo(-4.8, 6);
    expect(ledger()[0].delta_usd).toBeCloseTo(-5, 6);
    expect(ledger()[0].balance_after).toBeCloseTo(-4.8, 6);
  });
  it("charges the cache-hit path too, via settle with a zero hold", async () => {
    const { env, wallets } = await makeEnv();
    await ensureWallet(env, "dev-1", 10);
    await settleBalance(env, "dev-1", 0, 0.25, "req-cache");
    expect(wallets.get("dev-1")?.balance).toBeCloseTo(9.75, 6);
  });
});

describe("wallet ledger", () => {
  it("returns null when topping up a device that does not exist", async () => {
    const { env } = await makeEnv({ deviceIds: ["dev-1"] });
    expect(await adjustBalance(env, "dev-ghost", 5)).toBeNull();
  });

  it("records a top-up with the resulting balance", async () => {
    const { env, ledger } = await makeEnv();
    await adjustBalance(env, "dev-1", 5, { note: "first month" });
    const res = await adjustBalance(env, "dev-1", 2.5, { reason: "topup" });
    expect(res?.balance_usd).toBeCloseTo(7.5, 6);
    expect(ledger()).toHaveLength(2);
    expect(ledger()[1].reason).toBe("topup");
    expect(ledger()[1].balance_after).toBeCloseTo(7.5, 6);
    expect(ledger()[0].note).toBe("first month");
  });

  it("supports a negative adjustment as an admin-side deduction", async () => {
    const { env, wallets, ledger } = await makeEnv();
    await adjustBalance(env, "dev-1", 4);
    await adjustBalance(env, "dev-1", -1.5, { reason: "adjust" });
    expect(wallets.get("dev-1")?.balance).toBeCloseTo(2.5, 6);
    expect(ledger()[1].reason).toBe("adjust");
    expect(ledger()[1].delta_usd).toBeCloseTo(-1.5, 6);
  });

  it("is idempotent per request_id: a retried settle does not charge twice", async () => {
    const { env, ledger } = await makeEnv();
    await ensureWallet(env, "dev-1", 10);
    expect(await insertLedgerEntry(env, { device_id: "dev-1", delta_usd: -1, reason: "usage", request_id: "req-x", balance_after: 9 })).toBe(true);
    expect(await insertLedgerEntry(env, { device_id: "dev-1", delta_usd: -1, reason: "usage", request_id: "req-x", balance_after: 9 })).toBe(false);
    expect(ledger()).toHaveLength(1);
  });

  it("keeps the ledger scoped to one device", async () => {
    const { env, ledger } = await makeEnv({ deviceIds: ["dev-1", "dev-2"] });
    await adjustBalance(env, "dev-1", 5);
    await adjustBalance(env, "dev-2", 3);
    const rows = await listLedger(env, "dev-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].device_id).toBe("dev-1");
    expect(ledger()).toHaveLength(2);
  });

  it("returns null when settling against a wallet row that does not exist", async () => {
    const { env } = await makeEnv();
    expect(await settleBalance(env, "dev-nobody", 1, 1, "req-y")).toBeNull();
    expect(await getBalance(env, "dev-nobody")).toBeNull();
  });

  it("backfills a wallet row for every device that lacks one, so legacy devices are not locked out", () => {
    const backfills = MIGRATION_ALTERS.filter((sql) => /INSERT OR IGNORE INTO device_wallets/.test(sql));
    expect(backfills).toHaveLength(1);
    expect(backfills[0]).toMatch(/SELECT id, MAX\(COALESCE\(cost_limit_monthly, 0\), 0\)/);
  });
});