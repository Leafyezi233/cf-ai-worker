import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWalletFixture } from "./helpers/walletFixture";
import { ensureWallet } from "../src/db/repo";
import { createMonthlyPlan, issueMonthlyPass, getMonthlyPassAccount, listMonthlyPassAccounts, stopMonthlyPass, renewMonthlyPass, setMonthlyWalletFallback, type MonthlyLimits } from "../src/db/monthly_passes";
import { admitBillingRequest, beginBillingAttempt, persistBillingTerminal, settleBillingRequest, abandonUndispatchedBillingRequest, recoverBillingRequests } from "../src/db/request_billing";
const T = Date.UTC(2026,10,15,15,59,59);  
const limits: MonthlyLimits={daily_usd:10,weekly_usd:20,five_hour_usd:5,total_usd:30};
const adm=(request_id="a",reserved_usd=2)=>({request_id,device_id:"dev-1",model:"m",pricing_snapshot_json:"{}",reserved_usd,monthly_service_group_ids:[null]});
const term=(request_id="a",cost_usd=1)=>({request_id,device_id:"dev-1",provider_id:"p",provider_name:"P",model:"m",cost_usd,usage:{input_tokens:10,output_tokens:5,total_tokens:15},status_code:200,latency_ms:1,created_at:Date.now()});
afterEach(()=>vi.restoreAllMocks());
async function fixture(overrides:Partial<MonthlyLimits>={},balance=0,groups:string[]|null=null){
 vi.spyOn(Date,"now").mockReturnValue(T);
 const f=await makeWalletFixture();await ensureWallet(f.env,"dev-1",balance);
 const plan=await createMonthlyPlan(f.env,{name:"Monthly",enabled:1,limits:{...limits,...overrides},service_group_ids:groups});
 const sub=await issueMonthlyPass(f.env,"dev-1",plan.id);return {...f,sub,plan};
}
async function settle(f:Awaited<ReturnType<typeof fixture>>,id="a",cost=1){const receipt=await persistBillingTerminal(f.env,term(id,cost));await settleBillingRequest(f.env,id,receipt);}
function buckets(f:Awaited<ReturnType<typeof fixture>>){return f.d1.rows<{kind:string;used_usd:number;reserved_usd:number;starts_at:number}>("SELECT kind,used_usd,reserved_usd,starts_at FROM monthly_pass_buckets ORDER BY kind,starts_at");}
describe("monthly pass durable funding",()=>{
 it("binds admission replay to the frozen monthly eligibility and service-group declaration",async()=>{
  const f=await fixture();expect(await admitBillingRequest(f.env,adm())).toBe(true);
  expect(await admitBillingRequest(f.env,{...adm(),monthly_service_group_ids:["changed-group"]})).toBe(false);
  expect(await admitBillingRequest(f.env,{...adm(),monthly_service_group_ids:undefined})).toBe(false);
  expect(await admitBillingRequest(f.env,adm())).toBe(true);
  expect(f.d1.rows("SELECT * FROM monthly_pass_funding")).toHaveLength(1);expect(buckets(f).every(b=>b.reserved_usd===2)).toBe(true);
 });
 it.each(["monthly_pass_unavailable","D1_ERROR: monthly_pass_unavailable: SQLITE_CONSTRAINT","D1_ERROR: monthly_pass_unavailable: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)"])("normalizes only the documented D1 refusal envelope %s",async message=>{
  const f=await fixture();vi.spyOn(f.env.DB,"batch").mockRejectedValueOnce(new Error(message));expect(await admitBillingRequest(f.env,adm())).toBe(false);
 });
 it("does not turn unrelated D1 storage failure into quota exhaustion",async()=>{const f=await fixture();vi.spyOn(f.env.DB,"batch").mockRejectedValueOnce(new Error("D1_ERROR: no such table: monthly_pass_funding"));await expect(admitBillingRequest(f.env,adm())).rejects.toThrow("no such table");});
 it("wallet fallbacks never manufacture unanchored five-hour bucket rows",async()=>{
  const f=await fixture({five_hour_usd:1},20);await setMonthlyWalletFallback(f.env,"dev-1",true);
  for(let i=0;i<5;i++){vi.mocked(Date.now).mockReturnValue(T+i*1000);expect(await admitBillingRequest(f.env,adm("wallet-"+i))).toBe(true);}
  expect(buckets(f)).toEqual([]);expect(f.d1.row("SELECT five_hour_start FROM monthly_pass_subscriptions")).toEqual({five_hour_start:null});
 });
 it("reads 167 four-window accounts in one indexed D1 query, not 1003 calls",async()=>{
  const f=await fixture();await admitBillingRequest(f.env,adm());
  for(let i=0;i<166;i++){const id="copy-"+i;f.d1.sql("INSERT INTO monthly_pass_accounts(device_id,subscription_id,wallet_fallback) VALUES(?,?,0)",id,f.sub.id);}
  const prepare=vi.spyOn(f.env.DB,"prepare");const accounts=await listMonthlyPassAccounts(f.env);
  expect(accounts).toHaveLength(167);expect(accounts.every(a=>a.subscription?.windows.length===4)).toBe(true);expect(prepare).toHaveBeenCalledTimes(1);
  const sql=prepare.mock.calls[0][0] as string;const plans=f.d1.rows<{detail:string}>("EXPLAIN QUERY PLAN "+sql,T);expect(plans.some(p=>p.detail.includes("SEARCH b USING INDEX sqlite_autoindex_monthly_pass_buckets_1"))).toBe(true);
 });
 it("funds with an empty wallet, reserves every window, and settles real usage once without wallet deduction",async()=>{
  const f=await fixture();expect(await admitBillingRequest(f.env,adm())).toBe(true);
  expect(buckets(f)).toHaveLength(4);expect(buckets(f).every(b=>b.reserved_usd===2)).toBe(true);
  expect(f.wallets.get("dev-1")).toMatchObject({balance:0,reserved:0});expect(f.holds.get("a")?.amount_usd).toBe(0);
  await settle(f);await settleBillingRequest(f.env,"a");expect(buckets(f).every(b=>b.used_usd===1&&b.reserved_usd===0)).toBe(true);
  expect(f.ledger()).toHaveLength(1);expect(f.ledger()[0].delta_usd).toBe(0);
  expect(f.d1.row("SELECT cost_usd FROM usage")).toEqual({cost_usd:1});expect(f.wallets.get("dev-1")?.balance).toBe(0);
  expect((await getMonthlyPassAccount(f.env,"dev-1")).subscription?.windows.every(w=>w.used_usd===1&&w.reserved_usd===0)).toBe(true);
 });
 it("allows only one concurrent reservation when any single window is exhausted and replay never duplicates",async()=>{
  const f=await fixture({five_hour_usd:3});expect((await Promise.all([admitBillingRequest(f.env,adm()),admitBillingRequest(f.env,adm("b"))])).sort()).toEqual([false,true]);
  const winner=f.d1.row<{request_id:string}>("SELECT request_id FROM billing_requests")!.request_id;
  expect(await admitBillingRequest(f.env,adm(winner))).toBe(true);expect(buckets(f).every(b=>b.reserved_usd===2)).toBe(true);
  expect(await admitBillingRequest(f.env,adm("c",4))).toBe(false);expect(f.d1.rows("SELECT * FROM billing_requests")).toHaveLength(1);
 });
 it.each(["daily_usd","weekly_usd","five_hour_usd","total_usd"] as const)("requires the %s budget independently",async key=>{
  const f=await fixture({[key]:1});expect(await admitBillingRequest(f.env,adm())).toBe(false);expect(buckets(f)).toEqual([]);expect(f.holds.size).toBe(0);
 });
 it("uses explicit whole-request wallet fallback only; switching it after admission cannot change the payer",async()=>{
  const f=await fixture({five_hour_usd:1},20);expect(await admitBillingRequest(f.env,adm())).toBe(false);
  await setMonthlyWalletFallback(f.env,"dev-1",true);expect(await admitBillingRequest(f.env,adm())).toBe(true);
  await setMonthlyWalletFallback(f.env,"dev-1",false);await settle(f,"a",3);
  expect(f.wallets.get("dev-1")).toMatchObject({balance:17,reserved:0});expect(buckets(f).every(b=>b.used_usd===0&&b.reserved_usd===0)).toBe(true);
 });
 it("never sends overrun to the wallet; negative remaining blocks further monthly requests",async()=>{
  const f=await fixture({five_hour_usd:3},20);await admitBillingRequest(f.env,adm());await settle(f,"a",8);
  expect(f.wallets.get("dev-1")?.balance).toBe(20);expect((await getMonthlyPassAccount(f.env,"dev-1")).subscription?.windows.find(w=>w.kind==="five_hour_usd")?.remaining_usd).toBe(-5);
  expect(await admitBillingRequest(f.env,adm("b",0))).toBe(false);
 });
 it("charges original daily, weekly and five-hour buckets across boundaries without touching new requests",async()=>{
  const f=await fixture();await admitBillingRequest(f.env,adm());const old=buckets(f).map(b=>({...b}));
  vi.mocked(Date.now).mockReturnValue(T+18000001);await admitBillingRequest(f.env,adm("b"));await settle(f,"a",3);
  for(const b of old){const row=f.d1.row<{used_usd:number;reserved_usd:number}>("SELECT used_usd,reserved_usd FROM monthly_pass_buckets WHERE kind=? AND starts_at=?",b.kind,b.starts_at)!;expect(row.used_usd).toBe(3);expect(row.reserved_usd).toBe(b.kind==="total_usd"?2:0);}
  expect(f.holds.has("b")).toBe(true);
 });
 it("anchors five hours on first funded request, not on issuance or denied/wallet attempts",async()=>{
  const f=await fixture();vi.mocked(Date.now).mockReturnValue(T+1000000);await admitBillingRequest(f.env,adm());
  expect(f.d1.row("SELECT five_hour_start FROM monthly_pass_subscriptions")).toEqual({five_hour_start:T+1000000});
  const view=await getMonthlyPassAccount(f.env,"dev-1");expect(view.subscription?.windows.find(w=>w.kind==="five_hour_usd")?.starts_at).toBe(T+1000000);
 });
 it("undispatched abandonment releases only original reservations without inventing usage",async()=>{
  const f=await fixture();await admitBillingRequest(f.env,adm());await admitBillingRequest(f.env,adm("b",1));
  await abandonUndispatchedBillingRequest(f.env,"a");await abandonUndispatchedBillingRequest(f.env,"a");
  expect(buckets(f).every(b=>b.used_usd===0&&b.reserved_usd===1)).toBe(true);expect(f.ledger()).toEqual([]);expect(f.d1.rows("SELECT * FROM usage")).toEqual([]);
 });
 it("unknown-usage recovery releases reservations without fabricating a free charge",async()=>{
  const f=await fixture();await admitBillingRequest(f.env,adm());await beginBillingAttempt(f.env,{request_id:"a",provider_id:"p",model:"m",protocol:"messages"});
  vi.mocked(Date.now).mockReturnValue(T+6*60000);await recoverBillingRequests(f.env);await recoverBillingRequests(f.env);
  expect(buckets(f).every(b=>b.used_usd===0&&b.reserved_usd===0)).toBe(true);expect(f.ledger()).toEqual([]);expect(f.d1.row("SELECT billing_state FROM billing_requests")).toEqual({billing_state:"needs_reconciliation"});
 });
 it("recovers crash after terminal and ambiguous committed settlement without duplicate quota debit",async()=>{
  const f=await fixture();await admitBillingRequest(f.env,adm());await persistBillingTerminal(f.env,term("a",2));
  const original=f.env.DB.batch.bind(f.env.DB);let fail=true;f.env.DB.batch=(async (statements:D1PreparedStatement[])=>{const result=await original(statements);if(fail){fail=false;throw new Error("lost ack");}return result;}) as typeof f.env.DB.batch;
  await expect(settleBillingRequest(f.env,"a")).rejects.toThrow("lost ack");await recoverBillingRequests(f.env);
  expect(buckets(f).every(b=>b.used_usd===2&&b.reserved_usd===0)).toBe(true);expect(f.ledger()).toHaveLength(1);
 });
 it("rolls quota, ledger, usage and wallet back together if settlement fails",async()=>{
  const f=await fixture();await admitBillingRequest(f.env,adm());const receipt=await persistBillingTerminal(f.env,term());
  f.d1.sql("CREATE TRIGGER fail_monthly_used BEFORE UPDATE OF used_usd ON monthly_pass_buckets BEGIN SELECT RAISE(ABORT,'monthly injected failure'); END");
  await expect(settleBillingRequest(f.env,"a",receipt)).rejects.toThrow("monthly injected failure");expect(buckets(f).every(b=>b.used_usd===0&&b.reserved_usd===2)).toBe(true);expect(f.ledger()).toEqual([]);expect(f.d1.rows("SELECT * FROM usage")).toEqual([]);
  f.d1.sql("DROP TRIGGER fail_monthly_used");await settleBillingRequest(f.env,"a");expect(buckets(f).every(b=>b.used_usd===1&&b.reserved_usd===0)).toBe(true);
 });
 it("stop and expiry deny new funding but still settle old requests to their frozen subscription",async()=>{
  const f=await fixture();await admitBillingRequest(f.env,adm());await stopMonthlyPass(f.env,f.sub.id);
  expect(await admitBillingRequest(f.env,adm("b"))).toBe(false);await settle(f,"a",2);expect(buckets(f).every(b=>b.used_usd===2)).toBe(true);
  vi.mocked(Date.now).mockReturnValue(T+31*86400000);const renewed=await renewMonthlyPass(f.env,f.sub.id);expect(renewed!.id).not.toBe(f.sub.id);expect(await admitBillingRequest(f.env,adm("c"))).toBe(true);
 });
 it("unsupported non-text admissions remain wallet-funded even with an active card",async()=>{
  const f=await fixture();const {monthly_service_group_ids,...nonText}=adm();expect(await admitBillingRequest(f.env,nonText)).toBe(false);
  f.d1.sql("UPDATE device_wallets SET balance_usd=10 WHERE device_id='dev-1'");expect(await admitBillingRequest(f.env,nonText)).toBe(true);await settle(f);expect(f.wallets.get("dev-1")?.balance).toBe(9);expect(buckets(f)).toEqual([]);
 });
 it("card scope never pays an uncovered group and fallback cannot split partial quota",async()=>{
  const f=await fixture({},10,[]);expect(await admitBillingRequest(f.env,adm())).toBe(false);await setMonthlyWalletFallback(f.env,"dev-1",true);expect(await admitBillingRequest(f.env,adm())).toBe(true);await settle(f);expect(f.wallets.get("dev-1")?.balance).toBe(9);expect(buckets(f)).toEqual([]);
 });
 it("master and sub-token reservations share all budgets",async()=>{
  const f=await fixture({five_hour_usd:3});f.d1.sql("INSERT INTO device_sub_tokens(id,device_id,name,token_hash,enabled,created_at) VALUES('sub','dev-1','sub','subhash',1,1)");
  await admitBillingRequest(f.env,adm());expect(await admitBillingRequest(f.env,{...adm("subrequest"),sub_token_id:"sub"})).toBe(false);await abandonUndispatchedBillingRequest(f.env,"a");expect(await admitBillingRequest(f.env,{...adm("subrequest"),sub_token_id:"sub"})).toBe(true);
 });
});
