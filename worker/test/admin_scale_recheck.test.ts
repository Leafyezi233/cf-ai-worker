import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { makeWalletFixture } from "./helpers/walletFixture";
import { usageApp } from "../src/admin/usage";
import { auditApp } from "../src/admin/audit";
import { videoTasksApp } from "../src/admin/video-tasks";
const require=createRequire(import.meta.url);const {writeFileSync,mkdirSync}=require("node:fs");const {dirname}=require("node:path");const {fileURLToPath}=require("node:url");const {Buffer}=require("node:buffer");
it("records 10k/100k mixed-state and sparse-filter local scalability",async()=>{
 const report:any={producer:"moyuugpt/gpt-6.1-sol",samples:15,warmups:3,note:"Local warm SQLite handler+JSON; excludes auth/schema/network. Measures current app schema including admin-record indexes; extra local_probe indexes are isolated diagnostic duplicates, not a preoptimization baseline. No latency SLA or online billing conclusion.",scales:[]};
 for(const n of [10000,100000]){
 const {d1,env}=await makeWalletFixture();const base=Date.UTC(2026,10,15);const cte="WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<"+n+") ";
 d1.sql(cte+"INSERT INTO usage(device_id,model,status_code,created_at) SELECT 'dev-1',CASE WHEN x=1 THEN 'rare' ELSE 'common' END,200,"+base+"+x FROM n");
 d1.sql(cte+"INSERT INTO audit_logs(actor_type,action,target_type,summary,created_at) SELECT 'admin',CASE WHEN x=1 THEN 'rare' ELSE 'common' END,'device','synthetic',"+base+"+x FROM n");
 d1.sql(cte+"INSERT INTO video_tasks(id,device_id,idempotency_key,request_hash,status,route_json,price_usd,pricing_snapshot_json,created_at,updated_at) SELECT printf('scale-%06d',x),'dev-1',printf('key-%06d',x),'local',CASE x%5 WHEN 0 THEN 'pending' WHEN 1 THEN 'succeeded' WHEN 2 THEN 'failed' WHEN 3 THEN 'submitting' ELSE 'submission_unknown' END,'{}',0,'{}',"+base+"+x,"+base+"+x FROM n");
 const allocatedBytes=()=>Number(d1.row<any>("PRAGMA page_count").page_count)*Number(d1.row<any>("PRAGMA page_size").page_size);
 const result:any={rowsPerTable:n,routes:{}};const q="from="+base+"&to="+(base+n+1)+"&limit=50";
 for(const [name,app,extra] of [["usage",usageApp,""],["usageSparse",usageApp,"&model=rare"],["auditSparse",auditApp,"&action=rare"],["tasksAll",videoTasksApp,"&status=all"],["tasksSingle",videoTasksApp,"&status=pending"]] as const){
 const spy=vi.spyOn(env.DB,"prepare"),times:number[]=[];let bytes=0,rows=0,selects=0;
 for(let i=-3;i<15;i++){spy.mockClear();const t=performance.now();const r=await app.request("https://local.test/?"+q+extra,{},env);expect(r.status).toBe(200);const text=await r.text();const elapsed=performance.now()-t;const parsed=JSON.parse(text);rows=parsed.items.length;bytes=Buffer.byteLength(text);selects=spy.mock.calls.filter(c=>/^SELECT/i.test(String(c[0]))).length;expect(selects).toBe(1);if(i>=0)times.push(elapsed);}
 spy.mockRestore();times.sort((a,b)=>a-b);result.routes[name]={p50Ms:times[7],p95Ms:times[14],responseBytes:bytes,rows,bodySelects:selects};
 }
 const sql="SELECT id FROM video_tasks WHERE status IN ('submitting','submission_unknown','pending','succeeded','failed') AND created_at>=? AND created_at<=? ORDER BY created_at,id LIMIT 51";
 const values=[base,base+n+1];const measure=(s:string)=>{const a:number[]=[];for(let i=-3;i<15;i++){const t=performance.now();d1.rows(s,...values);if(i>=0)a.push(performance.now()-t);}a.sort((a,b)=>a-b);return {p50Ms:a[7],p95Ms:a[14],plan:d1.rows("EXPLAIN QUERY PLAN "+s,...values)};};
 result.taskIndexPrototype={before:measure(sql)};const videoBytesBefore=allocatedBytes();d1.sql("CREATE INDEX local_probe_video_created_id ON video_tasks(created_at,id)");const candidate=sql.replace("FROM video_tasks WHERE","FROM video_tasks INDEXED BY local_probe_video_created_id WHERE");expect(d1.rows(candidate,...values)).toEqual(d1.rows(sql,...values));result.taskIndexPrototype.after=measure(candidate);result.taskIndexPrototype.allocatedBytesDelta=allocatedBytes()-videoBytesBefore;result.taskIndexPrototype.unforcedPlanAfter=d1.rows("EXPLAIN QUERY PLAN "+sql,...values);const auditSql="SELECT id FROM audit_logs WHERE action=? AND created_at>=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT 51";
 const auditValues=["rare",base,base+n+1];const auditMeasure=(s:string)=>{const a:number[]=[];for(let i=-3;i<15;i++){const t=performance.now();d1.rows(s,...auditValues);if(i>=0)a.push(performance.now()-t);}a.sort((a,b)=>a-b);return {p50Ms:a[7],p95Ms:a[14],plan:d1.rows("EXPLAIN QUERY PLAN "+s,...auditValues)};};
 result.auditIndexPrototype={before:auditMeasure(auditSql)};const auditBytesBefore=allocatedBytes();d1.sql("CREATE INDEX local_probe_audit_action_created_id ON audit_logs(action,created_at,id)");const auditCandidate=auditSql.replace("FROM audit_logs WHERE","FROM audit_logs INDEXED BY local_probe_audit_action_created_id WHERE");expect(d1.rows(auditCandidate,...auditValues)).toEqual(d1.rows(auditSql,...auditValues));result.auditIndexPrototype.after=auditMeasure(auditCandidate);result.auditIndexPrototype.allocatedBytesDelta=allocatedBytes()-auditBytesBefore;result.auditIndexPrototype.unforcedPlanAfter=d1.rows("EXPLAIN QUERY PLAN "+auditSql,...auditValues);report.scales.push(result);
 }
 {const reportUrl=new URL("../../preview/admin-scale-recheck-current-performance.json",import.meta.url);mkdirSync(dirname(fileURLToPath(reportUrl)),{recursive:true});writeFileSync(reportUrl,JSON.stringify(report,null,2)+String.fromCharCode(10));};console.log(JSON.stringify(report));
},120000);
