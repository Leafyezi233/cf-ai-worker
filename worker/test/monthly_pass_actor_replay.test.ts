import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWalletFixture } from "./helpers/walletFixture";
import { createMonthlyPlan, issueMonthlyPass, renewMonthlyPass } from "../src/db/monthly_passes";
afterEach(()=>vi.restoreAllMocks());
describe("monthly operation identity survives authentication-path changes",()=>{
  it("never treats an existing operation key under another authenticated principal as a fresh renewal",async()=>{
    vi.spyOn(Date,"now").mockReturnValue(Date.UTC(2026,10,12));
    const f=await makeWalletFixture();
    const plan=await createMonthlyPlan(f.env,{name:"Replay",enabled:1,limits:{daily_usd:1,weekly_usd:null,five_hour_usd:null,total_usd:null},service_group_ids:null});
    const sub=await issueMonthlyPass(f.env,"dev-1",plan.id);
    const key="lost-response-then-access-to-cookie";
    const first=await renewMonthlyPass(f.env,sub.id,{operation_id:key,actor_scope:"admin:access:one@example.invalid"});
    await expect(renewMonthlyPass(f.env,sub.id,{operation_id:key,actor_scope:"admin:session"})).rejects.toThrow("monthly_operation_conflict");
    expect(f.d1.row("SELECT expires_at FROM monthly_pass_subscriptions WHERE id=?",sub.id)).toEqual({expires_at:first!.expires_at});
    expect(await renewMonthlyPass(f.env,sub.id,{operation_id:key,actor_scope:"admin:access:one@example.invalid"})).toEqual(first);
  });

  it("aborts an expired renewal when replacement insertion is silently suppressed",async()=>{
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.UTC(2026,10,12));const f=await makeWalletFixture();
    const plan=await createMonthlyPlan(f.env,{name:"Guard",enabled:1,limits:{daily_usd:1,weekly_usd:null,five_hour_usd:null,total_usd:null},service_group_ids:null});
    const sub=await issueMonthlyPass(f.env,"dev-1",plan.id);clock.mockReturnValue(sub.expires_at+1);
    f.d1.sql("CREATE TRIGGER suppress_new_cycle BEFORE INSERT ON monthly_pass_subscriptions BEGIN SELECT RAISE(IGNORE); END");
    await expect(renewMonthlyPass(f.env,sub.id,{operation_id:"suppressed-cycle",actor_scope:"admin:session"})).rejects.toThrow("monthly replacement insertion did not confirm");
    expect(f.d1.row("SELECT * FROM monthly_pass_operations WHERE operation_id='suppressed-cycle'")).toBeNull();
    expect(f.d1.row("SELECT subscription_id FROM monthly_pass_accounts")).toEqual({subscription_id:sub.id});expect(f.d1.rows("SELECT * FROM monthly_pass_subscriptions")).toHaveLength(1);
  });
  it("rolls back a renewal when the final audit INSERT silently affects zero rows",async()=>{
    const f=await makeWalletFixture();const plan=await createMonthlyPlan(f.env,{name:"Guard",enabled:1,limits:{daily_usd:1,weekly_usd:null,five_hour_usd:null,total_usd:null},service_group_ids:null});const sub=await issueMonthlyPass(f.env,"dev-1",plan.id);
    f.d1.sql("CREATE TRIGGER suppress_renew_audit BEFORE INSERT ON audit_logs WHEN NEW.action='monthly_pass.renew' BEGIN SELECT RAISE(IGNORE); END");
    await expect(renewMonthlyPass(f.env,sub.id,{operation_id:"suppressed-audit",actor_scope:"admin:session"})).rejects.toThrow("monthly operation audit did not confirm");
    expect(f.d1.row("SELECT * FROM monthly_pass_operations WHERE operation_id='suppressed-audit'")).toBeNull();expect(f.d1.row("SELECT expires_at FROM monthly_pass_subscriptions WHERE id=?",sub.id)).toEqual({expires_at:sub.expires_at});
  });
  it("rejects a malformed durable result instead of returning HTTP-shaped success",async()=>{
    const f=await makeWalletFixture();const prepare=f.env.DB.prepare.bind(f.env.DB);
    vi.spyOn(f.env.DB,"prepare").mockImplementation(sql=>{const st=prepare(sql);if(sql.startsWith("SELECT action,target_id"))st.first=(async()=>({actor_scope:"admin:session",action:"renew",target_id:"s",plan_id:null,error_code:null,result_json:"{}"})) as typeof st.first;return st;});
    await expect(renewMonthlyPass(f.env,"s",{operation_id:"malformed",actor_scope:"admin:session"})).rejects.toThrow("Invalid durable monthly operation result");expect(f.d1.rows("SELECT * FROM monthly_pass_operations")).toEqual([]);
  });
});
