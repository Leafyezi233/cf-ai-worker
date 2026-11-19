import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
const { fileURLToPath } = require("node:url");
import { expect, it } from "vitest";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { SCHEMA_DEFINITION, resetSchemaCache } from "../src/db/schema";
import { ensureVersionedSchema } from "../src/db/schema_versions";

const reportUrl=new URL("../../preview/admin-record-optimized-performance.json",import.meta.url);
const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {p50Ms:a[7],p95Ms:a[14]};};
const bytes=(d:RealD1)=>Number(d.row<{page_count:number}>("PRAGMA page_count")!.page_count)*Number(d.row<{page_size:number}>("PRAGMA page_size")!.page_size);
it("records paired seeded real-SQLite task insert/update and audit append costs plus incremental index allocation",async()=>{
  const results:unknown[]=[]; const operationsPerSample=200;
  const previous={...SCHEMA_DEFINITION,extensions:SCHEMA_DEFINITION.extensions.filter(e=>!e.id.startsWith("admin-record/"))};
  for(const n of [10000,100000]) {
    const before=createRealD1({init:[],alters:[]}),after=createRealD1({init:[],alters:[]});
    try {
      for(const d of [before,after]) {
        await ensureVersionedSchema(d.DB,previous);
        d.sql("INSERT INTO devices(id,name,token_hash) VALUES('dev-1','synthetic','token')");
        const cte="WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<"+n+") ";
        d.sql(cte+"INSERT INTO video_tasks(id,device_id,idempotency_key,request_hash,status,route_json,price_usd,pricing_snapshot_json,created_at,updated_at) SELECT printf('seed-%06d',x),'dev-1',printf('key-%06d',x),'local',CASE x%5 WHEN 0 THEN 'pending' WHEN 1 THEN 'succeeded' WHEN 2 THEN 'failed' WHEN 3 THEN 'submitting' ELSE 'submission_unknown' END,'{}',0,'{}',x/3,x/3 FROM n");
        d.sql(cte+"INSERT INTO audit_logs(actor_type,action,target_type,summary,created_at) SELECT 'admin',CASE WHEN x=1 THEN 'rare' ELSE 'common' END,'device','synthetic',x FROM n");
      }
      expect(bytes(after)).toBe(bytes(before));
      const indexBytes:Record<string,number>={};
      const extension=SCHEMA_DEFINITION.extensions.find(e=>e.id.startsWith("admin-record/"))!;
      for(const sql of extension.sql) {const start=bytes(after);after.sql(sql);indexBytes[/EXISTS (\w+)/.exec(sql)![1]]=bytes(after)-start;}
      await ensureVersionedSchema(after.DB,SCHEMA_DEFINITION);
      const operations:Record<string,(d:RealD1,i:number)=>void>={
        taskInsert:(d,i)=>d.sql("INSERT INTO video_tasks(id,device_id,idempotency_key,request_hash,status,route_json,price_usd,pricing_snapshot_json,created_at,updated_at) VALUES(?,'dev-1',?,'local','pending','{}',0,'{}',?,?)","insert-"+i,"insert-key-"+i,n+i,n+i),
        taskStatusUpdate:(d,i)=>d.sql("UPDATE video_tasks SET status='succeeded',updated_at=updated_at+1 WHERE id=?","seed-"+String((i+1)*5).padStart(6,"0")),
        taskPollUpdate:(d,i)=>d.sql("UPDATE video_tasks SET poll_attempts=COALESCE(poll_attempts,0)+1,poll_after=1000000,updated_at=updated_at+1 WHERE id=?","seed-"+String(i+1).padStart(6,"0")),
        auditInsert:(d,i)=>d.sql("INSERT INTO audit_logs(actor_type,action,target_type,summary,created_at) VALUES('admin',?,'device','synthetic',?)",i%100===0?"rare":"common",n+i),
      };
      const costs:Record<string,unknown>={};
      for(const [name,op] of Object.entries(operations)) {
        const times={before:[] as number[],after:[] as number[]};
        for(let sample=-3;sample<15;sample++) for(const [label,d] of (sample%2===0?[["before",before],["after",after]]:[["after",after],["before",before]]) as ["before"|"after",RealD1][]) {
          d.sql("BEGIN"); const start=performance.now();
          try { for(let i=0;i<operationsPerSample;i++) op(d,i); if(sample>=0) times[label].push(performance.now()-start); }
          finally {d.sql("ROLLBACK");}
        }
        const pre=stats(times.before),post=stats(times.after);
        costs[name]={before:pre,after:post,p50Ratio:post.p50Ms/pre.p50Ms};
      }
      results.push({seededRowsPerTable:n,incrementalIndexBytes:indexBytes,costs});
    } finally {resetSchemaCache(before.DB);resetSchemaCache(after.DB);before.close();after.close();}
  }
  mkdirSync(dirname(fileURLToPath(reportUrl)),{recursive:true});
  const report=existsSync(reportUrl)?JSON.parse(readFileSync(reportUrl,"utf8")):{};
  report.writeCost={producer:"moyuugpt/gpt-6.1-sol",warmups:3,samples:15,operationsPerSample,
    methodology:"Two independently seeded identical in-memory SQLite databases with the full prior schema and mixed states. Only post DB receives the two new indexes. Alternating paired sample order; each sample runs 200 real prepared INSERT/UPDATE statements inside BEGIN then ROLLBACK. Timing includes statement preparation/execution, excludes BEGIN/ROLLBACK; not durable disk commit/network/D1 billing. Index bytes are incremental page_count*page_size during isolated per-index creation before writes (not an estimated row size). No performance pass/fail threshold.",results};
  writeFileSync(reportUrl,JSON.stringify(report,null,2)+"\n"); console.log(JSON.stringify(report.writeCost));
},120000);
