import { afterEach } from "vitest";
import { createRealD1 } from "./realD1";
import { ensureSchema } from "../../src/db/schema";
import type { Env, WalletLedgerRow } from "../../src/types";
const open: ReturnType<typeof createRealD1>[] = [];
afterEach(() => { for (const d1 of open.splice(0)) d1.close(); });
export async function makeWalletFixture(opts: { deviceIds?: string[] } = {}) {
  const d1 = createRealD1(); open.push(d1);
  const env = { DB: d1.DB, ASSETS: null, RATE_LIMITER: null } as unknown as Env;
  await ensureSchema(env);
  for (const id of opts.deviceIds ?? ["dev-1"]) d1.sql("INSERT INTO devices (id, name, token_hash, enabled, rate_limit_rpm, created_at) VALUES (?, ?, ?, 1, 0, 1)", id, id, id);
  const wallets = { get: (id: string) => d1.row<{ balance: number; reserved: number; created: number }>("SELECT balance_usd AS balance, reserved_usd AS reserved, created_at AS created FROM device_wallets WHERE device_id = ?", id) ?? undefined };
  const holds = {
    get: (id: string) => d1.row<{ device_id: string; amount_usd: number; created_at: number }>("SELECT * FROM reserve_holds WHERE request_id = ?", id) ?? undefined,
    has: (id: string) => !!d1.row("SELECT 1 FROM reserve_holds WHERE request_id = ?", id),
    get size() { return d1.row<{ n: number }>("SELECT COUNT(*) AS n FROM reserve_holds")!.n; },
  };
  const ledger = () => d1.rows<WalletLedgerRow>("SELECT * FROM wallet_ledger ORDER BY id");
  const ageHold = (id: string, ageMs: number) => d1.sql("UPDATE reserve_holds SET created_at = ? WHERE request_id = ?", Date.now() - ageMs, id);
  const buckets = { values: () => d1.rows("SELECT request_count, error_count FROM daily_stats").values() };
  return { env, d1, wallets, holds, ledger, ageHold, buckets };
}
