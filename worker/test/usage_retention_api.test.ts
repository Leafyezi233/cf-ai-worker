import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { ensureSchema } from "../src/db/schema";
import type { Env } from "../src/types";
import { signSession, buildSessionCookie } from "../src/utils/crypto";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedDevice } from "./helpers/realGatewayEnv";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { resetIpRateLimitMemory } from "../src/middleware/ipRateLimit";
const H=3600000, BASE="/api/usage-retention";
let d:RealD1, env:Env, cookie:string;
beforeEach(async()=>{ resetRateLimitMemory(); resetIpRateLimitMemory(); d=createRealD1(); env={...makeEnv(d),SESSION_SECRET:"retention-api-local-secret",ADMIN_SECRET:"local-admin"}; await ensureSchema(env); await seedDevice(d); cookie=buildSessionCookie(await signSession(env.SESSION_SECRET!)).split(";")[0]; });
afterEach(()=>d.close());
function req(path:string,method="GET",body?:unknown,headers:Record<string,string>={cookie}){return app.request("https://retention.test"+BASE+path,{method,headers:{"content-type":"application/json",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})},env);}
function row(id:string,time=H){d.sql("INSERT INTO usage(device_id,provider_id,model,input_tokens,output_tokens,total_tokens,cost_usd,request_id,created_at) VALUES('d','p','m',1,2,3,.5,?,?)",id,time);d.sql("INSERT INTO wallet_ledger(device_id,delta_usd,reason,request_id,created_at) VALUES('d',-.5,'usage',?,?)",id,time);}
const page={before:4*H,limit:1};
describe("manual retained usage admin API",()=>{
 it("rejects unauthenticated reads and mutations without exposing data",async()=>{for(const [p,m,b] of [["/status","GET",undefined],["/backfill","POST",{limit:1}],["/verify","POST",{}],["/preview","POST",page],["/cleanup","POST",{...page,enabled:true,confirm:"DELETE_USAGE_DETAILS",operation_id:"x"}]] as const)expect((await req(p,m,b,{})).status).toBe(401);});
 it("requires JSON, rejects foreign Origin and malformed/extra mutation keys",async()=>{expect((await req("/verify","POST",{},{cookie,"content-type":"text/plain"})).status).toBe(415);expect((await req("/verify","POST",{},{cookie,origin:"https://sibling.test"})).status).toBe(403);for(const body of [{...page,before:page.before+1},{...page,limit:1001},{...page,after:5},{...page,erase_audit:true}])expect((await req("/preview","POST",body)).status).toBe(400);expect((await req("/cleanup","POST",{...page,enabled:false,confirm:"DELETE_USAGE_DETAILS",operation_id:"x"})).status).toBe(400);});
 it("returns actual verification, previews only bounded candidates and retains totals after cleanup",async()=>{row("one");row("two",2*H);const s=await req("/status");expect(s.status).toBe(200);expect((await s.json() as any).item).toMatchObject({ok:true,automatic_cleanup:false});const v=await req("/verify","POST",{});expect((await v.json() as any).item.ok).toBe(true);const p=await req("/preview","POST",page);expect((await p.json() as any).item).toMatchObject({scanned:1,eligible:1,next:{createdAt:H,id:1}});const b={...page,enabled:true,confirm:"DELETE_USAGE_DETAILS",operation_id:"batch-one"};const c=await req("/cleanup","POST",b);expect(c.status,await c.clone().text()).toBe(200);expect((await c.json() as any).item.deleted).toBe(1);expect(d.row<{n:number}>("SELECT COUNT(*) n FROM usage")!.n).toBe(1);expect(d.row<{n:number}>("SELECT SUM(cost_usd) n FROM usage_monthly_rollups")!.n).toBe(1);expect(d.row<{n:number}>("SELECT COUNT(*) n FROM wallet_ledger")!.n).toBe(2);const replay=await req("/cleanup","POST",b);expect(replay.status).toBe(200);expect((await replay.json() as any).item.deleted).toBe(1);expect(d.row<{n:number}>("SELECT COUNT(*) n FROM usage")!.n).toBe(1);expect((await req("/cleanup","POST",{...b,limit:2})).status).toBe(409);});
 it("never treats a missing-history verification response as cleanup permission",async()=>{d.sql("INSERT INTO daily_stats(date,device_id,provider_id,model,request_count,input_tokens,output_tokens,total_tokens,cost_usd) VALUES('1970-01-01','lost','p','m',2,2,4,6,1)");const r=await req("/verify","POST",{});expect((await r.json() as any).item).toMatchObject({ok:false,status:"history_missing"});expect((await req("/cleanup","POST",{...page,enabled:true,confirm:"DELETE_USAGE_DETAILS",operation_id:"blocked"})).status).toBe(409);});
});
