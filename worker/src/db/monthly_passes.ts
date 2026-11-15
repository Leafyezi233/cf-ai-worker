import type { Env } from "../types";
import { ensureSchema } from "./schema";
export const MONTHLY_PASS_DAYS = 30;
const DAY = 86_400_000, FIVE = 18_000_000;
export const MONTHLY_LIMIT_KEYS = ["daily_usd", "weekly_usd", "five_hour_usd", "total_usd"] as const;
export type MonthlyLimits = Record<typeof MONTHLY_LIMIT_KEYS[number], number | null>;
export interface MonthlyPlanInput { name: string; enabled: 0 | 1; limits: MonthlyLimits; service_group_ids: string[] | null; }
interface PlanRow { id: string; name: string; enabled: 0 | 1; limits_json: string; groups_json: string | null; created_at: number; updated_at: number; }
interface SubscriptionRow { id: string; device_id: string; plan_id: string; plan_name: string; enabled: 0 | 1; limits_json: string; groups_json: string | null; starts_at: number; expires_at: number; five_hour_start: number | null; created_at: number; updated_at: number; }
function publicPlan(p: PlanRow) { const { limits_json, groups_json, ...rest } = p; return { ...rest, limits: JSON.parse(limits_json) as MonthlyLimits, service_group_ids: groups_json === null ? null : JSON.parse(groups_json) as string[] }; }
function publicSubscription(s: SubscriptionRow) { const { limits_json, groups_json, ...rest } = s; return { ...rest, limits: JSON.parse(limits_json) as MonthlyLimits, service_group_ids: groups_json === null ? null : JSON.parse(groups_json) as string[] }; }
async function validPlan(env: Env, input: MonthlyPlanInput) {
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 100 || ![0,1].includes(input.enabled) || !input.limits ||
    Object.keys(input.limits).length !== 4 || !MONTHLY_LIMIT_KEYS.every(k => input.limits[k] === null || Number.isFinite(input.limits[k]) && input.limits[k]! > 0 && input.limits[k]! <= 1e9) || !MONTHLY_LIMIT_KEYS.some(k => input.limits[k] !== null) ||
    !(input.service_group_ids === null || Array.isArray(input.service_group_ids) && input.service_group_ids.length <= 100 && input.service_group_ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 200))) throw new Error("monthly_invalid_plan");
  if (input.service_group_ids !== null) {
    const ids = [...new Set(input.service_group_ids)];
    const found = await env.DB.prepare("SELECT COUNT(*) AS n FROM service_groups WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).first<{n:number}>();
    if (Number(found?.n) !== ids.length) throw new Error("monthly_scope_not_found");
  }
}
async function planRow(env: Env, id: string) { return env.DB.prepare("SELECT * FROM monthly_pass_plans WHERE id=?").bind(id).first<PlanRow>(); }
async function subscriptionRow(env: Env, id: string) { return env.DB.prepare("SELECT * FROM monthly_pass_subscriptions WHERE id=?").bind(id).first<SubscriptionRow>(); }
export async function listMonthlyPlans(env: Env) { await ensureSchema(env); return (await env.DB.prepare("SELECT * FROM monthly_pass_plans ORDER BY created_at,id").all<PlanRow>()).results.map(publicPlan); }
export async function createMonthlyPlan(env: Env, input: MonthlyPlanInput) {
  await ensureSchema(env); await validPlan(env,input); const id=crypto.randomUUID(), now=Date.now();
  await env.DB.prepare("INSERT INTO monthly_pass_plans(id,name,enabled,limits_json,groups_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .bind(id,input.name.trim(),input.enabled,JSON.stringify(input.limits),input.service_group_ids===null?null:JSON.stringify([...new Set(input.service_group_ids)]),now,now).run();
  return publicPlan((await planRow(env,id))!);
}
export async function updateMonthlyPlan(env: Env, id: string, input: MonthlyPlanInput) {
  await ensureSchema(env); await validPlan(env,input);
  await env.DB.prepare("UPDATE monthly_pass_plans SET name=?,enabled=?,limits_json=?,groups_json=?,updated_at=? WHERE id=?")
    .bind(input.name.trim(),input.enabled,JSON.stringify(input.limits),input.service_group_ids===null?null:JSON.stringify([...new Set(input.service_group_ids)]),Date.now(),id).run();
  const row=await planRow(env,id); return row ? publicPlan(row) : null;
}
export interface MonthlyPassOperation { operation_id: string; actor_scope: string; ip?: string | null; }
interface OperationRow { actor_scope: string; action: string; target_id: string; plan_id: string | null; result_json: string | null; error_code: string | null; }
type PublicSubscription = ReturnType<typeof publicSubscription>;
function frozenSubscription(value: unknown, action: "issue" | "renew", targetId: string, planId: string | null): PublicSubscription {
  const v=value as PublicSubscription | null;
  const fields=["id","device_id","plan_id","plan_name","enabled","starts_at","expires_at","five_hour_start","created_at","updated_at","limits","service_group_ids"];
  const epoch=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
  if (!v || typeof v!=="object" || Array.isArray(v) || Object.keys(v).length!==fields.length || !fields.every(k=>Object.hasOwn(v,k)) ||
      ![v.id,v.device_id,v.plan_id,v.plan_name].every(s=>typeof s==="string"&&s.length>0) || ![0,1].includes(v.enabled) ||
      ![v.starts_at,v.expires_at,v.created_at,v.updated_at].every(epoch) || v.expires_at<=v.starts_at || !(v.five_hour_start===null||epoch(v.five_hour_start)) ||
      !v.limits || typeof v.limits!=="object" || Array.isArray(v.limits) || Object.keys(v.limits).length!==4 ||
      !MONTHLY_LIMIT_KEYS.every(k=>v.limits[k]===null||typeof v.limits[k]==="number"&&Number.isFinite(v.limits[k])&&v.limits[k]!>0&&v.limits[k]!<=1e9) ||
      !MONTHLY_LIMIT_KEYS.some(k=>v.limits[k]!==null) || !(v.service_group_ids===null||Array.isArray(v.service_group_ids)&&v.service_group_ids.length<=100&&v.service_group_ids.every(id=>typeof id==="string"&&id.length>0&&id.length<=200)) ||
      action==="issue"&&(v.device_id!==targetId||v.plan_id!==planId)) throw new Error("Invalid durable monthly operation result");
  return v;
}
async function applyMonthlyOperation(env: Env, action: "issue" | "renew", targetId: string, planId: string | null, operation?: MonthlyPassOperation): Promise<PublicSubscription | null> {
  await ensureSchema(env);
  const op = operation ?? { operation_id: crypto.randomUUID(), actor_scope: "internal" };
  const key = op.operation_id.trim();
  if (!key || key.length > 200 || !op.actor_scope.trim()) throw new Error("monthly_invalid_operation");
  const read = () => env.DB.prepare("SELECT action,target_id,plan_id,result_json,error_code,actor_scope FROM monthly_pass_operations WHERE operation_id=?")
    .bind(key).first<OperationRow>();
  const decode = (row: OperationRow): PublicSubscription | null => {
    if (row.actor_scope !== op.actor_scope || row.action !== action || row.target_id !== targetId || row.plan_id !== planId) throw new Error("monthly_operation_conflict");
    if (row.error_code === "monthly_subscription_not_found") return null;
    if (row.error_code !== null) {
      switch (row.error_code) {
        case "monthly_account_not_found": case "monthly_plan_not_found": case "monthly_pass_already_active": case "monthly_subscription_not_current": throw new Error(row.error_code);
        default: throw new Error("Invalid durable monthly operation error");
      }
    }
    if (row.result_json === null) throw new Error("Monthly operation did not durably complete");
    return frozenSubscription(JSON.parse(row.result_json),action,targetId,planId);
  };
  const previous = await read();
  if (previous) return decode(previous);
  try {
    const results = await env.DB.batch([
      env.DB.prepare("INSERT INTO monthly_pass_operations(actor_scope,operation_id,action,target_id,plan_id,candidate_id,ip,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING")
        .bind(op.actor_scope,key,action,targetId,planId,crypto.randomUUID(),op.ip??null,Date.now()),
    ]);
    if (results.length !== 1 || results.some(r => r.success !== true)) throw new Error("Monthly operation transaction did not confirm");
  } catch (error) {
    const committed = await read();
    if (committed) return decode(committed);
    throw error;
  }
  const committed = await read();
  if (!committed) throw new Error("Monthly operation result missing after transaction");
  return decode(committed);
}
export async function issueMonthlyPass(env: Env, deviceId: string, planId: string, operation?: MonthlyPassOperation) {
  const result = await applyMonthlyOperation(env,"issue",deviceId,planId,operation);
  if (!result) throw new Error("Monthly issue returned no result");
  return result;
}
export async function stopMonthlyPass(env: Env, id: string) {
  await ensureSchema(env); const s=await subscriptionRow(env,id); if (!s) return null;
  const result=await env.DB.prepare("UPDATE monthly_pass_subscriptions SET enabled=0,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM monthly_pass_accounts WHERE subscription_id=?)").bind(Date.now(),id,id).run();
  if (Number(result.meta.changes)!==1) throw new Error("monthly_subscription_not_current");
  return publicSubscription((await subscriptionRow(env,id))!);
}
export async function renewMonthlyPass(env: Env, id: string, operation?: MonthlyPassOperation) {
  return applyMonthlyOperation(env,"renew",id,null,operation);
}
export function monthlyWindow(kind: typeof MONTHLY_LIMIT_KEYS[number], s: Pick<SubscriptionRow,"starts_at"|"expires_at"|"five_hour_start">, now: number) {
  const day=Math.floor((now+8*3600000)/DAY)*DAY-8*3600000;
  const week=day-((Math.floor((now+8*3600000)/DAY)+3)%7)*DAY;
  const start=kind==="daily_usd"?day:kind==="weekly_usd"?week:kind==="five_hour_usd"?(s.five_hour_start!==null&&s.five_hour_start+FIVE>now?s.five_hour_start:now):s.starts_at;
  return {starts_at:start,ends_at:kind==="daily_usd"?start+DAY:kind==="weekly_usd"?start+7*DAY:kind==="five_hour_usd"?start+FIVE:s.expires_at};
}
type MonthlyWindowView = ReturnType<typeof monthlyWindow> & {kind: typeof MONTHLY_LIMIT_KEYS[number]; limit_usd: number; used_usd: number; reserved_usd: number; remaining_usd: number};
type MonthlyAccountView = {device_id:string; wallet_fallback:boolean; subscription:(ReturnType<typeof publicSubscription> & {windows:MonthlyWindowView[]}) | null};
async function readMonthlyAccounts(env: Env, deviceId?: string): Promise<MonthlyAccountView[]> {
  const now=Date.now();
  const windowStart = `CASE j.key WHEN 'daily_usd' THEN ((CAST(?1 AS INTEGER)+28800000)/86400000)*86400000-28800000
    WHEN 'weekly_usd' THEN ((CAST(?1 AS INTEGER)+28800000)/86400000)*86400000-28800000-(((CAST(?1 AS INTEGER)+28800000)/86400000+3)%7)*86400000
    WHEN 'five_hour_usd' THEN CASE WHEN s.five_hour_start+18000000>CAST(?1 AS INTEGER) THEN s.five_hour_start ELSE CAST(?1 AS INTEGER) END ELSE s.starts_at END`;
  const statement=env.DB.prepare(`SELECT a.device_id AS account_device_id,a.wallet_fallback,s.*,j.key AS window_kind,
    b.used_usd AS window_used,b.reserved_usd AS window_reserved FROM monthly_pass_accounts a
    LEFT JOIN monthly_pass_subscriptions s ON s.id=a.subscription_id
    LEFT JOIN json_each(s.limits_json) j ON j.value IS NOT NULL
    LEFT JOIN monthly_pass_buckets b ON b.subscription_id=s.id AND b.kind=j.key AND b.starts_at=(${windowStart})
    ${deviceId===undefined?"":"WHERE a.device_id=?2"} ORDER BY a.device_id,j.key`);
  const rows=await statement.bind(...(deviceId===undefined?[now]:[now,deviceId])).all<SubscriptionRow & {
    account_device_id:string;wallet_fallback:number;window_kind:typeof MONTHLY_LIMIT_KEYS[number]|null;window_used:number|null;window_reserved:number|null;
  }>();
  const accounts=new Map<string,MonthlyAccountView>();
  for (const row of rows.results) {
    const {account_device_id,wallet_fallback,window_kind,window_used,window_reserved,...s}=row;
    let account=accounts.get(account_device_id);
    if (!account) {account={device_id:account_device_id,wallet_fallback:!!wallet_fallback,subscription:s.id?{...publicSubscription(s),windows:[]}:null};accounts.set(account_device_id,account);}
    if (account.subscription && window_kind) {
      const used=window_used??0,reserved=window_reserved??0,limit=account.subscription.limits[window_kind]!;
      account.subscription.windows.push({kind:window_kind,limit_usd:limit,used_usd:used,reserved_usd:reserved,remaining_usd:limit-used-reserved,...monthlyWindow(window_kind,s,now)});
    }
  }
  return [...accounts.values()];
}
export async function getMonthlyPassAccount(env: Env, deviceId: string): Promise<MonthlyAccountView> {
  await ensureSchema(env);return (await readMonthlyAccounts(env,deviceId))[0]??{device_id:deviceId,wallet_fallback:false,subscription:null};
}
export async function listMonthlyPassAccounts(env: Env) {
  await ensureSchema(env);return readMonthlyAccounts(env);
}
export async function setMonthlyWalletFallback(env: Env, deviceId: string, enabled: boolean) {
  await ensureSchema(env); const r=await env.DB.prepare("UPDATE monthly_pass_accounts SET wallet_fallback=? WHERE device_id=?").bind(enabled?1:0,deviceId).run();
  if (Number(r.meta.changes)!==1) throw new Error("monthly_account_not_found");
  return getMonthlyPassAccount(env,deviceId);
}
