import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { makeWalletFixture } from "./helpers/walletFixture";
import { usageApp } from "../src/admin/usage";
import { auditApp } from "../src/admin/audit";
import { videoTasksApp } from "../src/admin/video-tasks";
const require=createRequire(import.meta.url);const {writeFileSync,mkdirSync}=require("node:fs");const {dirname}=require("node:path");const {fileURLToPath}=require("node:url");const {Buffer}=require("node:buffer");
it("measures disclosed 10000-row-per-table native SQLite seek costs without network claims",async()=>{
 const {d1,env}=await makeWalletFixture();const base=Date.UTC(2026,10,15);const cte="WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) ";
 d1.sql(cte+"INSERT INTO usage(device_id,model,status_code,created_at) SELECT 'dev-1','bench',200,"+base+"+x FROM n");
 d1.sql(cte+"INSERT INTO audit_logs(actor_type,action,target_type,summary,created_at) SELECT 'admin','bench','device','synthetic',"+base+"+x FROM n");
 d1.sql(cte+"INSERT INTO video_tasks(id,device_id,idempotency_key,request_hash,status,route_json,price_usd,pricing_snapshot_json,created_at,updated_at) SELECT printf('bench-%05d',x),'dev-1',printf('local-%05d',x),'local','pending','{}',0,'{}',"+base+"+x,"+base+"+x FROM n");
 const samples=30,warmups=5;const report:any={producer:"moyuugpt/gpt-6.1-sol",rowsPerTable:10000,samples,warmups,note:"Local warm SQLite handler+JSON timings, excludes auth/schema initialization/network. No online CPU/D1 billing claim. Seek cursors are not a transaction snapshot.",routes:{}};
 for(const [name,app,extra] of [["usage",usageApp,""],["audit",auditApp,""],["tasks",videoTasksApp,"&status=pending"]] as const){
  const query="from="+base+"&to="+(base+11000)+"&limit=50"+extra;const first=await (await app.request("https://local.test/?"+query,{},env)).json() as any;expect(first.items).toHaveLength(50);expect(first.next_cursor).toBeTruthy();
  const timings:number[]=[],counts:number[]=[],bytes:number[]=[];const spy=vi.spyOn(env.DB,"prepare");let bodyQuery="";
  for(let i=-warmups;i<samples;i++){spy.mockClear();const start=performance.now();const response=await app.request("https://local.test/?"+query+"&cursor="+encodeURIComponent(first.next_cursor),{},env);expect(response.status).toBe(200);const text=await response.text();const duration=performance.now()-start;
   const reads=spy.mock.calls.map(c=>String(c[0])).filter(s=>new RegExp("FROM "+(name==="audit"?"audit_logs":name==="tasks"?"video_tasks":"usage")+"\\b","i").test(s));
   expect(reads).toHaveLength(1);expect(reads[0]).not.toMatch(/COUNT\(/i);expect(reads[0]).toContain("created_at");expect(JSON.parse(text).items).toHaveLength(50);bodyQuery=reads[0];
   if(i>=0){timings.push(duration);counts.push(reads.length);bytes.push(Buffer.byteLength(text));}
  }
  spy.mockRestore();timings.sort((a,b)=>a-b);report.routes[name]={p50Ms:timings[14],p95Ms:timings[28],responseBytes:bytes[0],bodySelects:Math.max(...counts),sql:bodyQuery};
 }
 const seek="SELECT id,created_at FROM usage WHERE created_at>=? AND created_at<=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT 50";
 const offset="SELECT id,created_at FROM usage WHERE created_at>=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET 9000";
 const args=[base,base+1001,base+1001,1001];expect(d1.rows(seek,...args).map(r=>r.id)).toEqual(d1.rows(offset,base,base+11000).map(r=>r.id));
 report.plans={seek:d1.rows("EXPLAIN QUERY PLAN "+seek,...args),offset:d1.rows("EXPLAIN QUERY PLAN "+offset,base,base+11000)};
 report.plans.tasks=d1.rows("EXPLAIN QUERY PLAN SELECT id FROM video_tasks WHERE status='pending' AND created_at>=? AND created_at<=? AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT 51",base+50,base+11000,base+50,"bench-00050");
 report.plans.audit=d1.rows("EXPLAIN QUERY PLAN SELECT id FROM audit_logs WHERE created_at>=? AND created_at<=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT 51",...args);
 report.allStatusTaskPlan=d1.rows("EXPLAIN QUERY PLAN SELECT id FROM video_tasks WHERE status IN ('submitting','submission_unknown','pending','succeeded','failed') AND created_at>=? AND created_at<=? ORDER BY created_at,id LIMIT 51",base,base+11000);
 expect(JSON.stringify(report.allStatusTaskPlan)).not.toContain("SCAN video_tasks");
 const timing=(sql:string,values:any[])=>{const ms=[];for(let i=-warmups;i<samples;i++){const t=performance.now();d1.rows(sql,...values);if(i>=0)ms.push(performance.now()-t);}ms.sort((a,b)=>a-b);return {p50Ms:ms[14],p95Ms:ms[28]};};report.deepPage={offset9000:timing(offset,[base,base+11000]),seekEquivalent:timing(seek,args)};
 expect(JSON.stringify(report.plans)).not.toMatch(/SCAN usage|SCAN audit_logs|SCAN video_tasks/);{const reportUrl=new URL("../../preview/admin-all-phases-performance.json",import.meta.url);mkdirSync(dirname(fileURLToPath(reportUrl)),{recursive:true});writeFileSync(reportUrl,JSON.stringify(report,null,2)+"\n");};console.log(JSON.stringify(report));
});
