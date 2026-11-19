import { afterEach, describe, expect, it, vi } from "vitest";
import { attentionItems } from "../src/admin/attention";
import { ensureSchema } from "../src/db/schema";
import { USAGE_ROLLUP_TRIGGERS } from "../src/db/usage_rollup_schema";
import { listDevices, monthStartMs } from "../src/db/repo";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedDevice, seedModel, seedProvider } from "./helpers/realGatewayEnv";
const open: RealD1[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of open.splice(0)) db.close(); });
async function setup() { const db=createRealD1();open.push(db);const env=makeEnv(db);await ensureSchema(env);return {db,env}; }
describe("PR1 bounded attention aggregation", () => {
 it("matches account list semantics for rollups, unreceipted usage, disabled/revoked and reserved wallets", async()=>{
  const now=Date.UTC(2026,10,19);vi.spyOn(Date,"now").mockReturnValue(now);
  const {db,env}=await setup();
  for(const id of ["raw","rolled","disabled","revoked","empty"]) await seedDevice(db,{id,token_hash:id,balance_usd:2,cost_limit_monthly:5});
  db.sql("UPDATE devices SET enabled=0 WHERE id='disabled'");db.sql("UPDATE devices SET revoked_at=1 WHERE id='revoked'");
  db.sql("UPDATE devices SET calls_enabled=0 WHERE id IN ('raw','disabled')");
  db.sql("UPDATE device_wallets SET reserved_usd=2 WHERE device_id IN ('raw','disabled')");
  expect(monthStartMs()).toBeLessThan(now);
  for(const [id,device,cost] of [[1,"raw",5],[2,"rolled",5],[3,"disabled",20],[4,"revoked",20]] as const) db.sql("INSERT INTO usage (id,device_id,model,cost_usd,created_at) VALUES (?,?, 'test',?,?)",id,device,cost,now);
  // Isolated legacy migration fixture: one old raw row predates automatic receipts.
  db.sql("DROP TRIGGER usage_rollup_raw_insert");
  db.sql("INSERT INTO usage (device_id,model,cost_usd,created_at) VALUES ('raw','legacy',1,?)",now);
  db.sql(USAGE_ROLLUP_TRIGGERS.find(sql=>sql.includes("CREATE TRIGGER IF NOT EXISTS usage_rollup_raw_insert AFTER"))!);
  const live=(await listDevices(env)).filter(d=>d.enabled&&!d.revoked_at) as any[];
  const counts=Object.fromEntries((await attentionItems(env,now)).map(i=>[i.key,i.count]));
  expect(counts.accounts_over_limit).toBe(live.filter(d=>d.cost_limit_monthly>0&&d.current_month_cost>=d.cost_limit_monthly).length);
  expect(counts.accounts_no_balance).toBe(live.filter(d=>d.balance_usd-d.reserved_usd<=0).length);
  expect(counts.accounts_calls_off).toBe(live.filter(d=>d.calls_enabled===0).length);
  expect(counts.accounts_over_limit).toBe(2); expect(counts.accounts_no_balance).toBe(1);
 });
 it("returns only bounded aggregate rows rather than accounts/models and keeps explicit pricing declarations",async()=>{
  const {db,env}=await setup();seedProvider(db);
  for(let i=0;i<300;i++){ await seedDevice(db,{id:"d"+i,token_hash:"h"+i,balance_usd:1});seedModel(db,{id:"m"+i,model_name:"m"+i,pricing_mode:i%3===0?"unset":i%3===1?"free":"priced",input_price_per_m:0,output_price_per_m:0}); }
  let rows=0,calls=0;const orig=env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB,"prepare").mockImplementation((sql:string)=>{const statement=orig(sql);for(const key of ["all","first"] as const){const fn=statement[key].bind(statement);(statement as any)[key]=async(...args:any[])=>{calls++;const value=await (fn as any)(...args);rows+=key==="all"?value.results.length:value?1:0;return value;};}return statement;});
  const items=await attentionItems(env);expect(items.find(i=>i.key==="models_unpriced")?.count).toBe(100);
  expect(rows).toBeLessThanOrEqual(7);expect(calls).toBeLessThanOrEqual(6);
 });
 it("propagates database failures instead of reporting an empty healthy dashboard",async()=>{const {env}=await setup();vi.spyOn(env.DB,"prepare").mockImplementation(()=>{throw Error("database_down");});await expect(attentionItems(env)).rejects.toThrow("database_down");});
});
