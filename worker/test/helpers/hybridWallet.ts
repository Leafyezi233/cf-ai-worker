import { afterEach } from "vitest";
import { createRealD1 } from "./realD1";
const open: ReturnType<typeof createRealD1>[] = [];
afterEach(() => { for (const d1 of open.splice(0)) d1.close(); });
export function hybridWallet(deviceId: string, balance: number, fallback: (sql: string) => any) {
  const d1 = createRealD1(); open.push(d1);
  d1.sql("INSERT INTO device_wallets (device_id,balance_usd,reserved_usd,created_at,updated_at) VALUES (?, ?, 0, 1, 1)", deviceId, balance);
  const isWallet = (sql: string) => /\b(device_wallets|reserve_holds|wallet_ledger)\b/i.test(sql);
  const db = {
    prepare: (sql: string) => isWallet(sql) ? d1.DB.prepare(sql) : fallback(sql),
    batch: async (statements: any[]) => {
      if (statements.every(s => isWallet(s.sql))) return d1.DB.batch(statements);
      const out = []; for (const s of statements) out.push(await s.run()); return out;
    },
  };
  const wallets = { get(id: string) {
    if (!d1.row("SELECT 1 FROM device_wallets WHERE device_id = ?", id)) return undefined;
    return {
      get balance() { return d1.row<{value:number}>("SELECT balance_usd AS value FROM device_wallets WHERE device_id = ?",id)!.value; },
      set balance(v: number) { d1.sql("UPDATE device_wallets SET balance_usd = ? WHERE device_id = ?",v,id); },
      get reserved() { return d1.row<{value:number}>("SELECT reserved_usd AS value FROM device_wallets WHERE device_id = ?",id)!.value; },
      set reserved(v: number) { d1.sql("UPDATE device_wallets SET reserved_usd = ? WHERE device_id = ?",v,id); },
      get created() { return 1; },
    };
  }};
  const holds = { get size() { return d1.row<{n:number}>("SELECT COUNT(*) AS n FROM reserve_holds")!.n; } };
  return { db, wallets, holds };
}
