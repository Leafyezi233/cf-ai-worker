import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INIT_STATEMENTS, ensureSchema, migrateSchema, resetSchemaCache } from "../src/db/schema";
import { MONTHLY_PASS_TABLES, MONTHLY_PASS_TRIGGERS } from "../src/db/monthly_pass_schema";
import { MONTHLY_PASS_OPERATIONS_SCHEMA } from "../src/db/monthly_pass_operations_schema";
import { createMonthlyPlan, issueMonthlyPass, renewMonthlyPass, stopMonthlyPass, updateMonthlyPlan, type MonthlyPassOperation } from "../src/db/monthly_passes";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, makeEnv, seedDevice } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";

const DAY = 86400000, T = Date.UTC(2026,10,12,12);
let d: RealD1, env: Env, clock: ReturnType<typeof vi.spyOn>;
const op = (operation_id: string, actor_scope = "admin:session"): MonthlyPassOperation => ({operation_id,actor_scope,ip:"192.0.2.44"});
const input = {name:"Frozen",enabled:1 as const,limits:{daily_usd:2,weekly_usd:10,five_hour_usd:1,total_usd:30},service_group_ids:null};
const audits = () => d.rows("SELECT * FROM audit_logs WHERE action IN ('monthly_pass.issue','monthly_pass.renew') ORDER BY id");
beforeEach(async () => {
  clock=vi.spyOn(Date,"now").mockReturnValue(T);
  d=createRealD1({init:[...INIT_STATEMENTS,...MONTHLY_PASS_TABLES.filter(s=>s.startsWith("CREATE ")),...MONTHLY_PASS_OPERATIONS_SCHEMA]});
  env=makeEnv(d); await seedDevice(d); await seedDevice(d,{id:"other",token_hash:"other-hash"});
  await ensureSchema(env);
});
afterEach(()=>{vi.restoreAllMocks();d.close();});
async function setup(){const plan=await createMonthlyPlan(env,input);const sub=await issueMonthlyPass(env,DEVICE_ID,plan.id,op("initial"));return {plan,sub};}
function isolateReads(){
  const prepare=d.DB.prepare.bind(d.DB);
  d.DB.prepare=(sql:string)=>{const st=prepare(sql);if(sql.startsWith("SELECT action,target_id"))st.first=async()=>{const rows=await d.DB.batch([st]);return rows[0].results[0]??null;};return st;};
}
describe("atomic monthly operation results on real SQLite",()=>{
  it("replays concurrent issue once, freezes the exact DTO after plan changes, stop, expiry and replacement",async()=>{
    const plan=await createMonthlyPlan(env,input);isolateReads();
    const results=await Promise.all(Array.from({length:12},()=>issueMonthlyPass(env,DEVICE_ID,plan.id,op("issue-key"))));
    const first=results[0];expect(results.every(s=>JSON.stringify(s)===JSON.stringify(first))).toBe(true);
    expect(d.rows("SELECT * FROM monthly_pass_subscriptions")).toHaveLength(1);expect(audits()).toHaveLength(1);
    await updateMonthlyPlan(env,plan.id,{...input,name:"Changed",limits:{...input.limits,total_usd:999}});
    await stopMonthlyPass(env,first.id);clock.mockReturnValue(first.expires_at+DAY);
    const replacement=await issueMonthlyPass(env,DEVICE_ID,plan.id,op("replacement"));expect(replacement.id).not.toBe(first.id);
    expect(await issueMonthlyPass(env,DEVICE_ID,plan.id,op("issue-key"))).toEqual(first);
    expect(audits()).toHaveLength(2);
  });
  it("concurrent same-key renewal extends once; distinct keys each extend once without resetting frozen quota",async()=>{
    const {plan,sub}=await setup();
    d.sql("INSERT INTO monthly_pass_buckets(subscription_id,kind,starts_at,ends_at,limit_usd,used_usd,reserved_usd) VALUES(?,'total_usd',?,?,30,4,1)",sub.id,sub.starts_at,sub.expires_at);
    d.sql("UPDATE monthly_pass_subscriptions SET five_hour_start=? WHERE id=?",T-1000,sub.id);
    await updateMonthlyPlan(env,plan.id,{...input,name:"Future",limits:{...input.limits,total_usd:999}});
    const buckets=d.rows("SELECT * FROM monthly_pass_buckets");isolateReads();
    const results=await Promise.all(Array.from({length:12},()=>renewMonthlyPass(env,sub.id,op("renew-key"))));
    expect(results.every(r=>JSON.stringify(r)===JSON.stringify(results[0]))).toBe(true);
    expect(results[0]).toMatchObject({id:sub.id,expires_at:sub.expires_at+30*DAY,limits:input.limits,plan_name:"Frozen",five_hour_start:T-1000});
    const next=await Promise.all([renewMonthlyPass(env,sub.id,op("distinct-a")),renewMonthlyPass(env,sub.id,op("distinct-b"))]);
    expect(next.map(r=>r!.expires_at).sort()).toEqual([sub.expires_at+60*DAY,sub.expires_at+90*DAY]);
    expect(await renewMonthlyPass(env,sub.id,op("renew-key"))).toEqual(results[0]);
    expect(d.rows("SELECT * FROM monthly_pass_buckets")).toEqual(buckets);expect(audits()).toHaveLength(4);
  });
  it("expired same-key renewals create exactly one fresh frozen cycle and replay after that cycle is replaced",async()=>{
    const {plan,sub}=await setup();clock.mockReturnValue(sub.expires_at+1);isolateReads();
    const results=await Promise.all(Array.from({length:8},()=>renewMonthlyPass(env,sub.id,op("expired"))));const first=results[0]!;
    expect(results.every(r=>JSON.stringify(r)===JSON.stringify(first))).toBe(true);expect(first.id).not.toBe(sub.id);
    expect(first.expires_at-first.starts_at).toBe(30*DAY);expect(first.limits).toEqual(sub.limits);
    expect(d.rows("SELECT * FROM monthly_pass_subscriptions")).toHaveLength(2);expect(audits()).toHaveLength(2);
    await stopMonthlyPass(env,first.id);await issueMonthlyPass(env,DEVICE_ID,plan.id,op("later"));
    expect(await renewMonthlyPass(env,sub.id,op("expired"))).toEqual(first);
    await expect(renewMonthlyPass(env,sub.id,op("different-expired"))).rejects.toThrow("monthly_subscription_not_current");
  });
  it("binds a global key across principal, account, action and plan",async()=>{
    const {plan,sub}=await setup();const second=await createMonthlyPlan(env,{...input,name:"Second"});
    await expect(issueMonthlyPass(env,"other",plan.id,op("initial"))).rejects.toThrow("monthly_operation_conflict");
    await expect(issueMonthlyPass(env,DEVICE_ID,second.id,op("initial"))).rejects.toThrow("monthly_operation_conflict");
    await expect(renewMonthlyPass(env,sub.id,op("initial"))).rejects.toThrow("monthly_operation_conflict");
    await expect(issueMonthlyPass(env,"other",plan.id,op("initial","admin:access:other@example.test"))).rejects.toThrow("monthly_operation_conflict");
    await issueMonthlyPass(env,"other",plan.id,op("separate-key","admin:access:other@example.test"));expect(audits()).toHaveLength(2);
  });
  it("recovers issue and renew lost commit acknowledgements from exact durable results, never extending twice",async()=>{
    const plan=await createMonthlyPlan(env,input);const batch=d.DB.batch.bind(d.DB);
    d.DB.batch=async(st:unknown[])=>{await batch(st);throw new Error("lost acknowledgement");};
    const issued=await issueMonthlyPass(env,DEVICE_ID,plan.id,op("lost-issue"));
    const renewed=(await renewMonthlyPass(env,issued.id,op("lost-renew")))!;
    expect(renewed.expires_at).toBe(issued.expires_at+30*DAY);
    d.DB.batch=batch;
    expect(await issueMonthlyPass(env,DEVICE_ID,plan.id,op("lost-issue"))).toEqual(issued);
    expect(await renewMonthlyPass(env,issued.id,op("lost-renew"))).toEqual(renewed);expect(audits()).toHaveLength(2);
  });
  it("rolls back operation claim, issue mutation and audit when the audit insert fails; retry can succeed",async()=>{
    const plan=await createMonthlyPlan(env,input);
    d.sql("CREATE TRIGGER fail_monthly_audit BEFORE INSERT ON audit_logs WHEN NEW.action='monthly_pass.issue' BEGIN SELECT RAISE(ABORT,'audit disk failure'); END");
    await expect(issueMonthlyPass(env,DEVICE_ID,plan.id,op("rollback"))).rejects.toThrow("audit disk failure");
    expect(d.rows("SELECT * FROM monthly_pass_operations")).toEqual([]);expect(d.rows("SELECT * FROM monthly_pass_subscriptions")).toEqual([]);expect(d.rows("SELECT * FROM monthly_pass_accounts")).toEqual([]);expect(audits()).toEqual([]);
    d.sql("DROP TRIGGER fail_monthly_audit");await issueMonthlyPass(env,DEVICE_ID,plan.id,op("rollback"));expect(audits()).toHaveLength(1);
  });
  it("rolls back renewal and claim if final audit fails, preserving prior expiry",async()=>{
    const {sub}=await setup();d.sql("CREATE TRIGGER fail_monthly_audit BEFORE INSERT ON audit_logs WHEN NEW.action='monthly_pass.renew' BEGIN SELECT RAISE(ABORT,'audit storage failure'); END");
    await expect(renewMonthlyPass(env,sub.id,op("rollback-renew"))).rejects.toThrow("audit storage failure");
    expect(d.row<{expires_at:number}>("SELECT expires_at FROM monthly_pass_subscriptions WHERE id=?",sub.id)!.expires_at).toBe(sub.expires_at);
    expect(d.row("SELECT * FROM monthly_pass_operations WHERE operation_id='rollback-renew'")).toBeNull();expect(audits()).toHaveLength(1);
  });
  it("refuses a stopped-unexpired subscription replaced before renewal's atomic claim, with durable rejection and no audit",async()=>{
    const {plan,sub}=await setup();await stopMonthlyPass(env,sub.id);const batch=d.DB.batch.bind(d.DB);let replacement="",intercept=true;
    d.DB.batch=async(st:Array<{sql:string}>)=>{if(intercept&&st.some(s=>s.sql.startsWith("INSERT INTO monthly_pass_operations"))){intercept=false;replacement=(await issueMonthlyPass(env,DEVICE_ID,plan.id,op("race-replacement"))).id;}return batch(st);};
    await expect(renewMonthlyPass(env,sub.id,op("raced"))).rejects.toThrow("monthly_subscription_not_current");
    expect(d.row("SELECT subscription_id FROM monthly_pass_accounts WHERE device_id=?",DEVICE_ID)).toEqual({subscription_id:replacement});
    expect(d.row("SELECT expires_at FROM monthly_pass_subscriptions WHERE id=?",sub.id)).toEqual({expires_at:sub.expires_at});expect(audits()).toHaveLength(2);
    expect(d.row("SELECT error_code,result_json FROM monthly_pass_operations WHERE operation_id='raced'")).toEqual({error_code:"monthly_subscription_not_current",result_json:null});
  });
  it("rejects an affected-row-zero renewal instead of returning unchanged state or false audit",async()=>{
    const {sub}=await setup();
    d.sql("CREATE TRIGGER ignore_renewal BEFORE UPDATE OF expires_at ON monthly_pass_subscriptions BEGIN SELECT RAISE(IGNORE); END");
    await expect(renewMonthlyPass(env,sub.id,op("zero-rows"))).rejects.toThrow("monthly_subscription_not_current");
    expect(d.row("SELECT expires_at FROM monthly_pass_subscriptions WHERE id=?",sub.id)).toEqual({expires_at:sub.expires_at});expect(audits()).toHaveLength(1);
    expect(d.row("SELECT error_code,result_json FROM monthly_pass_operations WHERE operation_id='zero-rows'")).toEqual({error_code:"monthly_subscription_not_current",result_json:null});
  });
  it("races different issue keys atomically: one entitlement, one success audit, durable refusal",async()=>{
    const plan=await createMonthlyPlan(env,input);isolateReads();const results=await Promise.allSettled([issueMonthlyPass(env,DEVICE_ID,plan.id,op("a")),issueMonthlyPass(env,DEVICE_ID,plan.id,op("b"))]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect(d.rows("SELECT * FROM monthly_pass_subscriptions")).toHaveLength(1);expect(audits()).toHaveLength(1);
    expect(d.rows("SELECT * FROM monthly_pass_operations WHERE error_code='monthly_pass_already_active'")).toHaveLength(1);
  });
  it("serializes stopped-unexpired replacement versus renewal: only the winning current entitlement is mutated",async()=>{
    const {plan,sub}=await setup();await stopMonthlyPass(env,sub.id);isolateReads();
    const results=await Promise.allSettled([issueMonthlyPass(env,DEVICE_ID,plan.id,op("replacement-race")),renewMonthlyPass(env,sub.id,op("renewal-race"))]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
    const winner=results.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<NonNullable<Awaited<ReturnType<typeof renewMonthlyPass>>>>;
    expect(d.row("SELECT subscription_id FROM monthly_pass_accounts WHERE device_id=?",DEVICE_ID)).toEqual({subscription_id:winner.value.id});
    expect(audits()).toHaveLength(2);
  });
  it("replays the first domain rejection even after state changes would allow a new operation",async()=>{
    const {plan,sub}=await setup();
    await expect(issueMonthlyPass(env,DEVICE_ID,plan.id,op("refused"))).rejects.toThrow("monthly_pass_already_active");
    await stopMonthlyPass(env,sub.id);
    await expect(issueMonthlyPass(env,DEVICE_ID,plan.id,op("refused"))).rejects.toThrow("monthly_pass_already_active");
    expect(audits()).toHaveLength(1);await issueMonthlyPass(env,DEVICE_ID,plan.id,op("new-intent"));expect(audits()).toHaveLength(2);
  });
  it("keeps completed evidence immutable even if audit retention deletes audit_logs",async()=>{
    const {sub}=await setup();const evidence=d.row<{result_json:string}>("SELECT result_json FROM monthly_pass_operations WHERE operation_id='initial'")!;
    expect(JSON.parse(evidence.result_json)).toEqual(sub);d.sql("DELETE FROM audit_logs");
    d.sql("DELETE FROM monthly_pass_accounts");d.sql("DELETE FROM monthly_pass_subscriptions");
    expect(await issueMonthlyPass(env,DEVICE_ID,sub.plan_id,op("initial"))).toEqual(sub);expect(audits()).toEqual([]);
    expect(()=>d.sql("DELETE FROM monthly_pass_operations")).toThrow("monthly operation evidence is durable");
    expect(()=>d.sql("UPDATE monthly_pass_operations SET result_json='{}'")).toThrow("monthly operation evidence is immutable");
  });
  it("propagates storage failures with no false durable success",async()=>{
    const {sub}=await setup();const batch=d.DB.batch.bind(d.DB);d.DB.batch=async()=>{throw new Error("monthly_unrecognized_storage_failure");};
    await expect(renewMonthlyPass(env,sub.id,op("storage"))).rejects.toThrow("monthly_unrecognized_storage_failure");d.DB.batch=batch;
    expect(d.row("SELECT * FROM monthly_pass_operations WHERE operation_id='storage'")).toBeNull();expect(audits()).toHaveLength(1);
  });
  it("appends one stage without changing the durable predecessors, and warm readiness adds no queries",async()=>{
    const manifest=d.rows<{id:string;checksum:string}>("SELECT id,checksum FROM cpg_schema_versions ORDER BY id");
    const predecessors=["core/0001-tables","core/0002-columns","core/0003-ready","monthly/0001-tables","monthly/0002-funding","monthly/0003-operations"];
    expect(manifest.filter(r=>predecessors.includes(r.id)).map(r=>r.id)).toEqual(predecessors);
    const prepare=vi.spyOn(env.DB,"prepare");await ensureSchema(env);expect(prepare).not.toHaveBeenCalled();prepare.mockRestore();
    await migrateSchema(env);expect(d.rows("SELECT id,checksum FROM cpg_schema_versions ORDER BY id")).toEqual(manifest);
    resetSchemaCache(env.DB);await ensureSchema(env);expect(d.rows("SELECT id,checksum FROM cpg_schema_versions ORDER BY id")).toEqual(manifest);
    expect(MONTHLY_PASS_TRIGGERS).toHaveLength(4);
  });
});
