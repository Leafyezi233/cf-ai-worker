import { createRealD1 } from "./helpers/realD1";
import { SCHEMA_DEFINITION, ensureSchema, resetSchemaCache } from "../src/db/schema";
import { ensureVersionedSchema } from "../src/db/schema_versions";
import type { Env } from "../src/types";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
const { fileURLToPath } = require("node:url");
const { Buffer } = require("node:buffer");
const processEnv = require("node:process").env as Record<string, string | undefined>;
import { afterEach, expect, it, vi } from "vitest";
import { makeWalletFixture } from "./helpers/walletFixture";
import { videoTasksApp } from "../src/admin/video-tasks";
import { auditApp } from "../src/admin/audit";

const reportUrl = new URL("../../preview/admin-record-optimized-performance.json", import.meta.url);
const baseline = processEnv.ADMIN_RECORD_BASELINE === "1";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const publicRows = (rows: Record<string, unknown>[]) => rows.map(row => {
  if (!("model_json" in row)) return row;
  const {model_json, provider_id_json, ...value} = row;
  return {...value, model: model_json === null ? undefined : JSON.parse(String(model_json)),
    provider_id: provider_id_json === null ? undefined : JSON.parse(String(provider_id_json))};
});
const stats = (times: number[]) => { times.sort((a,b)=>a-b); return { p50Ms: times[7], p95Ms: times[14] }; };
afterEach(() => vi.restoreAllMocks());

it("measures actual task/audit handlers plus JSON on mixed 10k/100k rows with exact before/after equality", async () => {
  const previous = existsSync(reportUrl) ? JSON.parse(readFileSync(reportUrl,"utf8")) : {};
  const report = { ...previous, producer: "moyuugpt/gpt-6.1-sol", warmups: 3, samples: 15,
    note: "Local node:sqlite, actual Hono handlers plus response serialization/body consumption; schema warmed; excludes parent authentication/network/D1 latency. No online or billing claims. Before/after use identical seeded data. Timing is informational, not a CI threshold.",
    diagnosis: "Legacy all-state SQL uses the status/created_at index plus a global temporary ORDER BY B-tree. The same historical SELECT id still scans/sorts the range, so handler JSON serialization does not explain the main gap. Optimized all-state SQL streams the global created_at/id index without a temporary sort. projectionInvestigation replays both projected and ID-only SQL on identical data; reviewStrategyComparison tests mixed and sparse distributions.",
    [baseline ? "before" : "after"]: [] as unknown[] };
  if (!baseline && Array.isArray(previous.before)) expect(previous.before, "retain the captured preoptimization baseline").toHaveLength(2);
  for (const n of [10000,100000]) {
    const { d1, env } = await makeWalletFixture(); const base = Date.UTC(2026,10,15);
    if (baseline) expect(d1.row("SELECT name FROM sqlite_master WHERE name='idx_video_tasks_created_id'")).toBeNull();
    const cte = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<"+n+") ";
    d1.sql(cte+"INSERT INTO audit_logs(actor_type,action,target_type,summary,created_at) SELECT 'admin',CASE WHEN x=1 THEN 'rare' ELSE 'common' END,'device','synthetic',"+base+"+x FROM n");
    d1.sql(cte+"INSERT INTO video_tasks(id,device_id,idempotency_key,request_hash,status,route_json,price_usd,pricing_snapshot_json,created_at,updated_at) SELECT printf('scale-%06d',x),'dev-1',printf('key-%06d',x),'private-hash',CASE x%5 WHEN 0 THEN 'pending' WHEN 1 THEN 'succeeded' WHEN 2 THEN 'failed' WHEN 3 THEN 'submitting' ELSE 'submission_unknown' END,json_object('public_model','video','provider_id','p','provider_api_key','SECRET'),0,'{}',"+base+"+x/3,"+base+"+x/3 FROM n");
    const q="from="+base+"&to="+(base+n+1)+"&limit=50";
    const first=await (await videoTasksApp.request("https://local.test/?"+q+"&status=all",{},env)).json<{next_cursor:string}>();
    const routes: Record<string,unknown> = {};
    for (const [name,app,path] of [
      ["taskId",videoTasksApp,"/?"+q+"&status=all&task_id=scale-000001"],
      ["device",videoTasksApp,"/?"+q+"&status=all&device_id=dev-1"],
      ["single",videoTasksApp,"/?"+q+"&status=pending"],
      ["all",videoTasksApp,"/?"+q+"&status=all"],
      ["review",videoTasksApp,"/?"+q],
      ["cursor",videoTasksApp,"/?"+q+"&status=all&cursor="+encodeURIComponent(first.next_cursor)],
      ["export",videoTasksApp,"/export?"+q+"&status=all"],
      ["auditSparse",auditApp,"/?"+q+"&action=rare"],
    ] as const) {
      const original=env.DB.prepare.bind(env.DB); let sql="", values: unknown[]=[];
      const spy=vi.spyOn(env.DB,"prepare").mockImplementation((s: string)=>{ const stmt=original(s); const bind=stmt.bind.bind(stmt); if (/^(SELECT|WITH)/i.test(s)) { sql=s; stmt.bind=(...v: unknown[])=>{ values=v; return bind(...v); }; } return stmt; });
      const times:number[]=[]; let text="", selects=0;
      for(let i=-3;i<15;i++) { spy.mockClear(); const t=performance.now(); const r=await app.request("https://local.test"+path,{},env); text=await r.text(); const elapsed=performance.now()-t; expect(r.status).toBe(200); selects=spy.mock.calls.filter(c=>/^(SELECT|WITH)/i.test(String(c[0]))).length; expect(selects).toBe(1); if(i>=0) times.push(elapsed); }
      spy.mockRestore(); expect(sql).not.toMatch(/COUNT\(|SELECT \*/i);
      expect(text).not.toMatch(/SECRET|private-hash|route_json|pricing_snapshot_json|result_url/);
      const value={...stats(times),responseBytes:Buffer.byteLength(text),rows:JSON.parse(text).items.length,bodySelects:selects,sha256:digest(text),sql,binds:values,plan:d1.rows("EXPLAIN QUERY PLAN "+sql,...values)};
      if(!baseline && previous.before) expect(value.sha256,name+" full response equality").toBe(previous.before.find((s: {rowsPerTable:number})=>s.rowsPerTable===n).routes[name].sha256);
      routes[name]=value;
    }
    const projectionInvestigation: Record<string, unknown> = {};
    if (!baseline && previous.before) {
      const old=previous.before.find((s:{rowsPerTable:number})=>s.rowsPerTable===n).routes.all;
      const current=routes.all as {sql:string;binds:unknown[]};
      for (const [name,sql,values] of [["legacyFullProjection",old.sql,old.binds],["legacyIdsOnly","SELECT id "+old.sql.slice(old.sql.indexOf("FROM video_tasks")),old.binds],["optimizedFullProjection",current.sql,current.binds],["optimizedIdsOnly","SELECT id "+current.sql.slice(current.sql.indexOf("FROM video_tasks")),current.binds]] as [string,string,unknown[]][]) {
        const times:number[]=[];
        for(let i=-3;i<15;i++){const t=performance.now();d1.rows(sql,...values);if(i>=0)times.push(performance.now()-t);}
        projectionInvestigation[name]={...stats(times),plan:d1.rows("EXPLAIN QUERY PLAN "+sql,...values)};
      }
      expect(publicRows(d1.rows(old.sql,...old.binds))).toEqual(publicRows(d1.rows(current.sql,...current.binds)));
    }
    const reviewStrategyComparison: Record<string, unknown> = {};
    if (!baseline && previous.before) {
      const old=previous.before.find((s:{rowsPerTable:number})=>s.rowsPerTable===n).routes.review;
      const current=routes.review as {sql:string;binds:unknown[]};
      for(const distribution of ["mixed40PercentReview","sparseTwoReviewRows"]) {
        if(distribution==="sparseTwoReviewRows") d1.sql("UPDATE video_tasks SET status='succeeded' WHERE status IN ('pending','submission_unknown') AND id NOT IN ('scale-000004','scale-000005')");
        const strategies:Record<string,unknown>={};
        const expected=d1.rows(old.sql,...old.binds);
        for(const [name,sql,values] of [["legacyMultiStateSort",old.sql,old.binds],["globalOrderedScan",old.sql.replace("FROM video_tasks WHERE","FROM video_tasks INDEXED BY idx_video_tasks_created_id WHERE"),old.binds],["boundedStatusUnion",current.sql,current.binds]] as [string,string,unknown[]][]) {
          expect(publicRows(d1.rows(sql,...values))).toEqual(publicRows(expected));
          const times:number[]=[];for(let i=-3;i<15;i++){const t=performance.now();d1.rows(sql,...values);if(i>=0)times.push(performance.now()-t);}
          strategies[name]={...stats(times),plan:d1.rows("EXPLAIN QUERY PLAN "+sql,...values)};
        }
        reviewStrategyComparison[distribution]=strategies;
      }
    }
    report[baseline?"before":"after"].push({rowsPerTable:n,routes,projectionInvestigation,reviewStrategyComparison});
  }
  mkdirSync(dirname(fileURLToPath(reportUrl)),{recursive:true});writeFileSync(reportUrl,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({ mode: baseline ? "before" : "after", scales: report[baseline?"before":"after"].map((s: any) => ({ rowsPerTable: s.rowsPerTable, routes: Object.fromEntries(Object.entries(s.routes).map(([k,v]: [string,any]) => [k,{p50Ms:v.p50Ms,p95Ms:v.p95Ms}])) })) }));
},120000);

it("appends indexes on fresh/upgrade schemas without changing old phase checksums or data; cold/warm idempotent", async () => {
  const previous = { ...SCHEMA_DEFINITION, extensions: SCHEMA_DEFINITION.extensions.filter(e => !e.id.startsWith("admin-record/")) };
  for (const upgrade of [false, true]) {
    const d = createRealD1({init:[],alters:[]});
    try {
      let old: unknown[] = [];
      if (upgrade) {
        await ensureVersionedSchema(d.DB, previous);
        d.sql("INSERT INTO devices(id,name,token_hash) VALUES('preserve','untouched','token')");
        old = d.rows("SELECT id,checksum,completed,applied_at FROM cpg_schema_versions ORDER BY id");
      }
      const env={DB:d.DB} as Env; await ensureSchema(env);
      const manifest=d.rows("SELECT id,checksum,completed,applied_at FROM cpg_schema_versions ORDER BY id");
      if (upgrade) {
        expect(manifest.filter((s:any)=>!s.id.startsWith("admin-record/"))).toEqual(old);
        expect(d.row("SELECT name FROM devices WHERE id='preserve'")).toEqual({name:"untouched"});
        expect(d.row("SELECT * FROM device_wallets WHERE device_id='preserve'")).toBeNull();
      }
      for(const [name, columns] of [["idx_video_tasks_created_id",["created_at","id"]],["idx_audit_logs_action_created_id",["action","created_at","id"]]] as const) {
        const info=d.rows<{name:string;desc:number;key:number}>("PRAGMA index_xinfo("+name+")").filter(r=>r.key);
        expect(info.map(r=>r.name)).toEqual(columns);
        expect(info.map(r=>r.desc)).toEqual(columns.map(c=>c==="action"?0:1));
      }
      const batch=vi.spyOn(d.DB,"batch");
      await ensureSchema(env); expect(batch).not.toHaveBeenCalled();
      resetSchemaCache(d.DB); await ensureSchema(env); expect(batch).not.toHaveBeenCalled();
      expect(d.rows("SELECT id,checksum,completed,applied_at FROM cpg_schema_versions ORDER BY id")).toEqual(manifest);
      expect(manifest.filter((s:any)=>s.id.startsWith("core/"))).toMatchObject([
        {id:"core/0001-tables",checksum:"95e4240d6ca771ec3d943864af1292324dd9c9a992032ec051baf1dbaa0f52fe"},
        {id:"core/0002-columns",checksum:"7f94b56fe22e6c15594581ffae611a419ef4e732a04d04dfdac0e638ad38109e"},
        {id:"core/0003-ready",checksum:"d54ef52b8d4b4d7c475a199e7eb48d609085e015c0a9e3df96798d9c9a6c71b2"},
      ]);
    } finally { resetSchemaCache(d.DB); d.close(); }
  }
});

it("keeps review UNION pages correct across tied timestamps, state changes, insertion, filter signatures and safe exports", async () => {
  const {d1,env}=await makeWalletFixture();
  const seed=(id:string,status:string,time=100,route="{}")=>d1.sql("INSERT INTO video_tasks(id,device_id,idempotency_key,request_hash,status,route_json,price_usd,pricing_snapshot_json,created_at,updated_at) VALUES(?,'dev-1',?,'private-hash',?,?,0,'{}',?,?)",id,id,status,route,time,time);
  for(const [id,status] of [["a","pending"],["b","submission_unknown"],["c","pending"],["d","failed"],["e","submission_unknown"],["f","pending"]]) seed(id,status);
  seed("null-route","pending",101,"null"); seed("invalid-route","pending",102);
  d1.sql("UPDATE video_tasks SET route_json='not-json' WHERE id='invalid-route'");
  const read=async(path:string)=>{ const r=await videoTasksApp.request("https://local.test"+path,{},env); expect(r.status).toBe(200); return r.json<{items:{id:string}[];next_cursor:string;has_more:boolean}>(); };
  const first=await read("/?limit=1"); expect(first.items.map(r=>r.id)).toEqual(["a"]);
  d1.sql("UPDATE video_tasks SET status='succeeded' WHERE id='b'");
  d1.sql("UPDATE video_tasks SET status='pending' WHERE id='d'"); seed("0","pending",99);
  const second=await read("/?limit=2&cursor="+encodeURIComponent(first.next_cursor)); expect(second.items.map(r=>r.id)).toEqual(["c","d"]);
  const tail=await read("/?limit=20&cursor="+encodeURIComponent(second.next_cursor)); expect(tail.items.map(r=>r.id)).toEqual(["e","f","null-route","invalid-route"]);
  for(const suffix of ["&status=all","&device_id=dev-1","&from=0&to=1000","&task_id=e"]) expect((await videoTasksApp.request("https://local.test/?cursor="+encodeURIComponent(first.next_cursor)+suffix,{},env)).status).toBe(400);
  for(const status of ["all","review","pending","failed"]) for(const extra of ["","&device_id=dev-1","&task_id=d"]) {
    const q="status="+status+"&from=0&to=1000&limit=20"+extra;
    const listed=await read("/?"+q), exported=await read("/export?"+q);
    expect(exported.items).toEqual(listed.items);
    expect(JSON.stringify(exported)).not.toMatch(/route_json|private-hash|SECRET|pricing_snapshot_json|result_url/);
  }
  for(const id of ["null-route","invalid-route"]) expect((await videoTasksApp.request("https://local.test/"+id,{},env)).status).toBe(200);
});

it("uses PK/single-state/global ordered plans and bounded status-index review branches in one SELECT", async () => {
  const {env,d1}=await makeWalletFixture(); const original=env.DB.prepare.bind(env.DB);
  for(const [query,index] of [["status=all&task_id=missing","sqlite_autoindex_video_tasks_1"],["status=pending","idx_video_tasks_status_created"],["status=all","idx_video_tasks_created_id"],["status=review","idx_video_tasks_status_created"],["device_id=dev-1&status=all","idx_video_tasks_device_created_id"]]) {
    let sql="",values:unknown[]=[];
    const spy=vi.spyOn(env.DB,"prepare").mockImplementation((s:string)=>{const stmt=original(s); const bind=stmt.bind.bind(stmt); sql=s; stmt.bind=(...v:unknown[])=>{values=v;return bind(...v);};return stmt;});
    expect((await videoTasksApp.request("https://local.test/?"+query,{},env)).status).toBe(200); expect(spy).toHaveBeenCalledTimes(1); spy.mockRestore();
    const plan=d1.rows<{detail:string}>("EXPLAIN QUERY PLAN "+sql,...values).map(r=>r.detail).join(" "); expect(plan).toContain(index);
    expect(sql).not.toMatch(/COUNT\(|SELECT \*|OFFSET/i);
    if(query==="status=all") { expect(sql).not.toContain("status IN"); expect(plan).not.toContain("TEMP B-TREE"); }
    if(query==="status=review") { expect(sql.match(/LIMIT \?/g)).toHaveLength(3); expect(sql).toContain("UNION ALL"); }
  }
});
