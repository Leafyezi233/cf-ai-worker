import { describe, expect, it, vi } from "vitest";
import { makeWalletFixture } from "./helpers/walletFixture";
import { ensureWallet, reserveBalance, releaseReserve, releaseStaleReserves, settleBalance, getWallet } from "../src/db/repo";
async function setup() {
 const f = await makeWalletFixture(); await ensureWallet(f.env, "dev-1", 10);
 await reserveBalance(f.env, "dev-1", 3, "a"); await reserveBalance(f.env, "dev-1", 4, "live"); return f;
}
function pauseBatch(env: Awaited<ReturnType<typeof setup>>["env"]) {
 const original = env.DB.batch.bind(env.DB); let enter!: () => void; let resume!: () => void;
 const entered = new Promise<void>(r => { enter = r; }); const gate = new Promise<void>(r => { resume = r; }); let first = true;
 env.DB.batch = (async (stmts: any[]) => { if(first) { first=false; enter(); await gate; } return original(stmts); }) as typeof env.DB.batch;
 return { entered, resume };
}
describe("atomic reservation and idempotent settlement regressions", () => {
 it("duplicate reserve succeeds even when the first hold exhausted funds", async () => {
  const { env, d1 } = await makeWalletFixture(); await ensureWallet(env,"dev-1",1);
  expect(await reserveBalance(env,"dev-1",1,"a")).toBe(true); expect(await reserveBalance(env,"dev-1",1,"a")).toBe(true);
  expect(d1.row("SELECT reserved_usd FROM device_wallets")).toEqual({reserved_usd:1});
 });
 it("duplicate reserve cannot claim a larger estimate or another owner", async () => {
  const { env } = await setup(); await ensureWallet(env,"other",10);
  expect(await reserveBalance(env,"dev-1",3.1,"a")).toBe(false); expect(await reserveBalance(env,"other",1,"a")).toBe(false);
  expect((await getWallet(env,"dev-1")).reserved_usd).toBe(7);
 });
 it("concurrent affordability checks cannot double-spend", async () => {
  const { env } = await makeWalletFixture(); await ensureWallet(env,"dev-1",1);
  expect((await Promise.all([reserveBalance(env,"dev-1",1,"a"),reserveBalance(env,"dev-1",1,"b")])).sort()).toEqual([false,true]);
 });
 it("duplicate settlements debit once and retain the other live hold", async () => {
  const { env, d1 } = await setup(); const results=await Promise.all([settleBalance(env,"dev-1",3,2,"a"),settleBalance(env,"dev-1",3,2,"a")]);
  expect(results).toEqual([8,8]); expect((await getWallet(env,"dev-1")).reserved_usd).toBe(4);
  expect(d1.row("SELECT COUNT(*) AS n FROM wallet_ledger")).toEqual({n:1}); expect(await reserveBalance(env,"dev-1",1,"a")).toBe(false);
 });
 it("wrong-owner settlement cannot debit or delete another hold", async () => {
  const { env, holds }=await setup(); await ensureWallet(env,"other",10);
  expect(await settleBalance(env,"other",3,2,"a")).toBeNull(); expect(holds.has("a")).toBe(true);
  expect((await getWallet(env,"other")).balance_usd).toBe(10);
 });
 for(const op of ["reserve", "settle", "release", "sweep"] as const) {
  it(op+" rolls back all wallet/hold/ledger mutations on statement failure",async()=>{
   const {env,d1,ageHold}=await setup(); ageHold("a",7200000);
   const before=d1.rows("SELECT * FROM device_wallets"); const holds=d1.rows("SELECT * FROM reserve_holds ORDER BY request_id");
   const table=op==="reserve"?"reserve_holds":op==="settle"?"wallet_ledger":"reserve_holds";
   const event=op==="reserve"?"INSERT":op==="settle"?"UPDATE":"DELETE";
   d1.sql("CREATE TRIGGER injected BEFORE "+event+" ON "+table+" BEGIN SELECT RAISE(ABORT, 'injected'); END");
   if(op==="sweep") { const spy=vi.spyOn(console,"error").mockImplementation(()=>{}); expect(await releaseStaleReserves(env)).toBe(0); spy.mockRestore(); }
   else await expect(op==="reserve"?reserveBalance(env,"dev-1",1,"b"):op==="settle"?settleBalance(env,"dev-1",3,2,"a"):releaseReserve(env,"dev-1","a")).rejects.toThrow("injected");
   expect(d1.rows("SELECT * FROM device_wallets")).toEqual(before); expect(d1.rows("SELECT * FROM reserve_holds ORDER BY request_id")).toEqual(holds);
   expect(d1.rows("SELECT * FROM wallet_ledger")).toEqual([]); expect(d1.rows("SELECT * FROM usage")).toEqual([]); expect(d1.rows("SELECT * FROM daily_stats")).toEqual([]);
  });
 }
 for(const pair of ["release-release","release-settle","sweep-release","sweep-settle","sweep-sweep","settle-release"] as const) {
  it(pair+" rechecks state at write time and preserves the live request", async()=>{
   const {env,d1,ageHold}=await setup(); ageHold("a",7200000); const [one,two]=pair.split("-");
   const run=(op:string)=>op==="release"?releaseReserve(env,"dev-1","a"):op==="settle"?settleBalance(env,"dev-1",3,2,"a"):releaseStaleReserves(env);
   const gate=pauseBatch(env); const pending=run(one); await gate.entered; await run(two); gate.resume(); await pending;
   const wallet=await getWallet(env,"dev-1"); expect(wallet.reserved_usd).toBe(4); expect(wallet.balance_usd).toBe(pair.includes("settle")?8:10);
   expect(d1.rows("SELECT request_id FROM reserve_holds")).toEqual([{request_id:"live"}]);
   if(one==="sweep"&&two!=="sweep") expect(d1.rows("SELECT * FROM usage")).toEqual([]);
   if(pair==="sweep-sweep") { expect(d1.row("SELECT COUNT(*) AS n FROM usage")).toEqual({n:1}); expect(d1.row("SELECT SUM(request_count) AS n FROM daily_stats")).toEqual({n:1}); }
  });
 }
 it("a refreshed hold is not reaped from an old candidate snapshot",async()=>{
  const {env,d1,ageHold}=await setup(); ageHold("a",7200000); const gate=pauseBatch(env); const pending=releaseStaleReserves(env); await gate.entered;
  d1.sql("UPDATE reserve_holds SET created_at=? WHERE request_id='a'",Date.now()); gate.resume(); expect(await pending).toBe(0); expect((await getWallet(env,"dev-1")).reserved_usd).toBe(7);
 });
 it("ambiguous committed reserve result is not replayed",async()=>{
  const {env,d1}=await makeWalletFixture(); await ensureWallet(env,"dev-1",1); const original=env.DB.batch.bind(env.DB); let calls=0;
  env.DB.batch=(async (s:any[])=>{calls++; await original(s); throw Error("transport lost");}) as typeof env.DB.batch;
  await expect(reserveBalance(env,"dev-1",1,"a")).rejects.toThrow("transport lost"); expect(calls).toBe(1);
  env.DB.batch=original; expect(await reserveBalance(env,"dev-1",1,"a")).toBe(true); expect(d1.row("SELECT reserved_usd FROM device_wallets")).toEqual({reserved_usd:1});
 });
 it("ambiguous committed settlement can be safely retried",async()=>{
  const {env}=await setup(); const original=env.DB.batch.bind(env.DB); let calls=0;
  env.DB.batch=(async(s:any[])=>{calls++; await original(s); throw Error("transport lost");}) as typeof env.DB.batch;
  await expect(settleBalance(env,"dev-1",3,2,"a")).rejects.toThrow("transport lost"); expect(calls).toBe(1); env.DB.batch=original;
  expect(await settleBalance(env,"dev-1",3,2,"a")).toBe(8); expect((await getWallet(env,"dev-1")).reserved_usd).toBe(4);
 });
 it("legacy unnamed reserve is released without consuming named holds",async()=>{
  const {env}=await setup(); await reserveBalance(env,"dev-1",2); await settleBalance(env,"dev-1",9,1,"legacy");
  expect((await getWallet(env,"dev-1")).reserved_usd).toBe(7);
 });
});
