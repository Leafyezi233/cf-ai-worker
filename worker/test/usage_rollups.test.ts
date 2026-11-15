import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import { INIT_STATEMENTS } from "../src/db/schema";
import { MONTHLY_PASS_TABLES } from "../src/db/monthly_pass_schema";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import {
  USAGE_ROLLUP_TABLES, USAGE_ROLLUP_TRIGGERS, USAGE_ROLLUP_METRICS,
  usageMetricExpressions, usageMetricAggregate, USAGE_HOUR_MS as H,
} from "../src/db/usage_rollup_schema";
import {
  backfillUsageRollups, cleanupUsageDetails, previewUsageCleanup, usageCostExpression,
  usageReportSource, validateUsageRange, verifyUsageRollups,
} from "../src/db/usage_rollups";

const handles: RealD1[] = [];
function database(install = true): RealD1 {
  const core = new Set<string>([...USAGE_ROLLUP_TABLES, ...USAGE_ROLLUP_TRIGGERS]);
  const db = createRealD1({ init: INIT_STATEMENTS.filter(sql => !core.has(sql)) });
  handles.push(db);
  for (const sql of MONTHLY_PASS_TABLES.filter(sql => sql.startsWith("CREATE TABLE"))) db.sql(sql);
  if (install) installCore(db);
  return db;
}
function installCore(db: RealD1): void {
  for (const sql of [...USAGE_ROLLUP_TABLES, ...USAGE_ROLLUP_TRIGGERS]) db.sql(sql);
}
function env(db: RealD1): Env { return { DB: db.DB } as Env; }
function usage(db: RealD1, values: Record<string, unknown> = {}): number {
  const row = {
    device_id: "dev", sub_token_id: null, provider_id: "provider", provider_name: "Provider", model: "model",
    service_group_id: null, input_tokens: 10, output_tokens: 2, total_tokens: 12, cost_usd: 0.25,
    cache_hit: 0, cache_read_tokens: 0, cache_write_tokens: 0, pricing_missing: 0, status_code: 200,
    latency_ms: 10, image_count: 0, search_calls: 0, request_id: "req-" + Math.random(), created_at: H + 100,
    ...values,
  };
  db.sql("INSERT INTO usage(" + Object.keys(row).join(",") + ") VALUES(" + Object.keys(row).map(() => "?").join(",") + ")", ...Object.values(row));
  return Number(db.row<{ id: number }>("SELECT last_insert_rowid() AS id")!.id);
}
function ledger(db: RealD1, request: string, note: string | null = null, device = "dev"): void {
  db.sql("INSERT INTO wallet_ledger(device_id,delta_usd,reason,request_id,note,created_at) VALUES(?,-0.25,'usage',?,?,?)", device, request, note, H);
}
function billing(db: RealD1, request: string, overrides: Record<string, unknown> = {}): void {
  const row = { request_id: request, device_id: "dev", model: "model", pricing_snapshot_json: "{}", reserved_usd: 0,
    billing_state: "settled", outcome: "completed", known_cost_usd: 0.25, terminal_snapshot_json: "{}",
    hold_released_at: H + 1000, settled_at: H + 1000, admission_nonce: request, lease_until: 0,
    created_at: H, updated_at: H + 1000, ...overrides };
  db.sql("INSERT INTO billing_requests(" + Object.keys(row).join(",") + ") VALUES(" + Object.keys(row).map(() => "?").join(",") + ")", ...Object.values(row));
}
function video(db: RealD1, request: string, claim: string | null = "claimed"): void {
  db.sql("INSERT INTO video_tasks(id,device_id,idempotency_key,request_hash,status,route_json,price_usd,pricing_snapshot_json,created_at,updated_at,settlement_claim) VALUES(?,'dev',?,?,'succeeded','{}',0.25,'{}',?,?,?)", request, request, request, H, H + 1000, claim);
}
function sums(db: RealD1, from = 0, to?: number): Record<string, number> {
  const source = usageReportSource(from, to);
  return db.row<Record<string, number>>("SELECT " + USAGE_ROLLUP_METRICS.map(c => "COALESCE(" + usageMetricAggregate(c,c) + ",0) AS " + c).join(",") + " FROM " + source.sql, ...source.binds)!;
}
function rawSums(db: RealD1, from = 0, to?: number): Record<string, number> {
  return db.row<Record<string, number>>("SELECT " + usageMetricExpressions("u").map((e,i) => "COALESCE(" + usageMetricAggregate(USAGE_ROLLUP_METRICS[i],e) + ",0) AS " + USAGE_ROLLUP_METRICS[i]).join(",") +
    " FROM usage u WHERE created_at>=?" + (to === undefined ? "" : " AND created_at<?"), from, ...(to === undefined ? [] : [to]))!;
}
function cost(db: RealD1, monthStart: number, device?: string): number {
  return db.row<{ cost: number }>("SELECT " + usageCostExpression(String(monthStart), device === undefined ? undefined : "'" + device + "'") + " AS cost")!.cost;
}
afterEach(() => { for (const db of handles.splice(0)) db.close(); });

describe("sealed atomic usage rollups on real SQLite", () => {
  it("installs idempotently in two stages; every raw writer aggregates all metrics, subtokens and NULL dimensions", async () => {
    const db = database();
    installCore(db);
    usage(db, { cache_hit: 1, cache_read_tokens: 4, cache_write_tokens: 3, pricing_missing: 1, search_calls: 2, image_count: 3, latency_ms: 0, status_code: 500 });
    usage(db, { sub_token_id: "sub", service_group_id: "", provider_name: "", latency_ms: null });
    usage(db, { sub_token_id: "", service_group_id: null, provider_name: null, latency_ms: 99 });
    expect(sums(db)).toEqual(rawSums(db));
    expect(sums(db)).toMatchObject({ request_count: 3, latency_sum: 99, latency_count: 2, error_count: 1, cache_hit_count: 1, cost_saved_usd: 0.25 });
    expect(db.rows("SELECT * FROM usage_hourly_rollups")).toHaveLength(3);
    expect(db.rows("SELECT * FROM usage_rollup_receipts")).toHaveLength(3);
    expect(db.rows("SELECT * FROM usage_rollup_write_context")).toEqual([]);
    expect(await verifyUsageRollups(env(db))).toMatchObject({ ok: true, status: "verified" });
  });

  it("retains cache token/latency splits and positive latency extrema across hours and cleanup", async () => {
    const db = database();
    const points = [
      {request_id:"metric-hit-zero",cache_hit:1,latency_ms:0,status_code:500},
      {request_id:"metric-hit-five",cache_hit:1,latency_ms:5},
      {request_id:"metric-direct-null",latency_ms:null},
      {request_id:"metric-direct-eleven",latency_ms:11,status_code:503},
      {request_id:"metric-later-three",latency_ms:3,created_at:2*H+1},
    ];
    for (const p of points) { usage(db,p); ledger(db,p.request_id); }
    const before = sums(db);
    expect(before).toMatchObject({request_count:5,cache_saved_tokens:24,cached_latency_sum:5,cached_latency_count:2,
      direct_latency_sum:14,direct_latency_count:2,positive_latency_sum:19,positive_latency_count:3,
      positive_latency_min:3,positive_latency_max:11,positive_latency_error_count:1});
    expect(db.row("SELECT positive_latency_min,positive_latency_max FROM usage_hourly_rollups WHERE hour_start=?",H))
      .toEqual({positive_latency_min:5,positive_latency_max:11});
    expect(db.row("SELECT positive_latency_min,positive_latency_max FROM usage_monthly_rollups"))
      .toEqual({positive_latency_min:3,positive_latency_max:11});
    expect(before).toEqual(rawSums(db));
    expect(await cleanupUsageDetails(env(db),{enabled:true,before:3*H})).toMatchObject({deleted:5});
    expect(sums(db)).toEqual(before);
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:true});
  });

  it("claims historical duplicate request IDs once while live inserts and concurrent backfills race", async () => {
    const db = database(false);
    for (let i = 0; i < 12; i++) usage(db, { request_id: "historical-duplicate", created_at: i * H + 100 });
    installCore(db);
    expect(await verifyUsageRollups(env(db))).toMatchObject({ status: "backfill_required", unprocessed: 12 });
    const results = await Promise.all([
      backfillUsageRollups(env(db), { limit: 5 }),
      db.DB.batch([db.DB.prepare("INSERT INTO usage(device_id,request_id,created_at,cost_usd) VALUES('dev','live',?,2)").bind(H + 5)]),
      backfillUsageRollups(env(db), { limit: 5 }),
      backfillUsageRollups(env(db), { limit: 5 }),
    ]);
    expect(results[0]).toMatchObject({ processed: 5 });
    expect(await backfillUsageRollups(env(db))).toEqual({ processed: 0, remaining: 0 });
    expect(sums(db)).toEqual(rawSums(db));
    expect(sums(db).request_count).toBe(13);
    expect(await verifyUsageRollups(env(db))).toMatchObject({ ok: true });
  });

  it("does not replay a committed backfill after a lost acknowledgment", async () => {
    const db = database(false);
    usage(db); usage(db);
    installCore(db);
    const base = env(db);
    const lost = { DB: { prepare: db.DB.prepare, batch: async (stmts: D1PreparedStatement[]) => {
      await db.DB.batch(stmts); throw new Error("lost acknowledgment");
    } } } as unknown as Env;
    await expect(backfillUsageRollups(lost)).rejects.toThrow("lost acknowledgment");
    expect(await backfillUsageRollups(base)).toEqual({ processed: 0, remaining: 0 });
    expect(sums(db).request_count).toBe(2);
  });

  it("uses exact raw boundaries and unprocessed interior history without double counting", async () => {
    const db = database(false);
    const times = [H, H + 99, H + 100, H + 101, 2 * H, 3 * H + 1, 4 * H + 199, 4 * H + 200];
    for (const [i,t] of times.entries()) usage(db, { created_at: t, sub_token_id: i % 2 ? "sub" : null, service_group_id: i % 2 ? "" : null, cost_usd: i + 0.125 });
    installCore(db);
    await backfillUsageRollups(env(db), { limit: 4 });
    usage(db, { created_at: 2 * H + 500, cost_usd: 7 });
    for (const [from,to] of [[H + 100,4 * H + 200], [H + 100,H + 101], [2 * H,4 * H], [H + 100,H + 100], [0,undefined]] as const) {
      expect(sums(db,from,to)).toEqual(rawSums(db,from,to));
      await expect(validateUsageRange(env(db),from,to)).resolves.toBeUndefined();
    }
    const source = usageReportSource(H, 4 * H);
    expect(source.sql.startsWith("(")).toBe(true);
    expect(source.sql.endsWith(")")).toBe(true);
    expect(db.rows("SELECT * FROM " + source.sql + " WHERE sub_token_id='sub'", ...source.binds).length).toBeGreaterThan(0);
  });

  it("keeps existing UTC+8 budget months exact across raw startup, backfill and per-device sums", async () => {
    const db = database(false);
    const month = Date.UTC(2026, 10, 1) - 8 * H;
    usage(db, { created_at: month - 1, cost_usd: 100 });
    usage(db, { created_at: month, cost_usd: 3 });
    usage(db, { created_at: month + H, cost_usd: 4, sub_token_id: "sub" });
    usage(db, { device_id: "other", created_at: month + H, cost_usd: 5 });
    installCore(db);
    expect(cost(db,month)).toBe(12);
    expect(cost(db,month,"dev")).toBe(7);
    await backfillUsageRollups(env(db), { limit: 2 });
    expect(cost(db,month)).toBe(12);
    expect(cost(db,month,"dev")).toBe(7);
    await backfillUsageRollups(env(db));
    expect(cost(db,month)).toBe(12);
    expect(db.rows("SELECT DISTINCT month_start FROM usage_monthly_rollups ORDER BY month_start")).toHaveLength(2);
    expect(await verifyUsageRollups(env(db))).toMatchObject({ ok: true });
  });

  it("defaults cleanup off without even touching DB and requires explicit aligned bounded inputs", async () => {
    const noDb = { DB: { prepare() { throw new Error("must not touch DB"); } } } as unknown as Env;
    expect(await cleanupUsageDetails(noDb)).toEqual({ enabled: false, scanned: 0, deleted: 0, next: null });
    await expect(cleanupUsageDetails(noDb,{ enabled: true })).rejects.toThrow("cutoff_required");
    await expect(cleanupUsageDetails(noDb,{ enabled: true, before: H + 1 })).rejects.toThrow("hour_alignment_required");
    await expect(backfillUsageRollups(noDb,{ limit: 501 })).rejects.toThrow("invalid_limit");
    await expect(previewUsageCleanup(noDb,{ before: H, limit: 1001 })).rejects.toThrow("invalid_limit");
    expect(() => usageReportSource(-1)).toThrow("invalid_timestamp");
    expect(() => usageReportSource(H,0)).toThrow("invalid_range");
  });

  it("limits candidate scan BEFORE eligibility and advances past ineligible rows", async () => {
    const db = database();
    usage(db, { request_id: "pending", created_at: H + 1 }); billing(db,"pending",{ billing_state: "pending", settled_at: null });
    usage(db, { request_id: "held", created_at: H + 2 }); ledger(db,"held");
    db.sql("INSERT INTO reserve_holds VALUES('held','dev',1,?)",H);
    usage(db, { request_id: "eligible", created_at: H + 3 }); ledger(db,"eligible");
    const first = await previewUsageCleanup(env(db), { before: 2 * H, limit: 2 });
    expect(first).toMatchObject({ scanned: 2, eligible: 0 });
    const cleanup = await cleanupUsageDetails(env(db), { enabled: true, before: 2 * H, limit: 2 });
    expect(cleanup).toMatchObject({ scanned: 2, deleted: 0, next: first.next });
    const second = await cleanupUsageDetails(env(db), { enabled: true, before: 2 * H, limit: 2, after: first.next! });
    expect(second).toMatchObject({ scanned: 1, deleted: 1 });
    expect(db.rows("SELECT * FROM usage")).toHaveLength(2);
  });

  it("cleans only known settled billing, claimed finalized video, or legacy ledger without any holds", async () => {
    const db = database();
    const requests = ["settled","unknown","pending","held","legacy","video","bad-video","unknown-video","wrong-device","no-evidence"];
    for (const request_id of requests) usage(db,{ request_id });
    billing(db,"settled"); billing(db,"unknown",{ billing_state:"needs_reconciliation" }); ledger(db,"unknown");
    billing(db,"pending",{ settled_at:null, hold_released_at:null }); ledger(db,"pending");
    billing(db,"held"); db.sql("INSERT INTO reserve_holds VALUES('held','dev',1,?)",H);
    ledger(db,"legacy"); video(db,"video"); ledger(db,"video","claimed");
    video(db,"bad-video"); ledger(db,"bad-video","wrong"); video(db,"unknown-video",null); ledger(db,"unknown-video");
    billing(db,"wrong-device",{device_id:"other"}); ledger(db,"wrong-device");
    usage(db,{request_id:null});
    const preservedTables = ["billing_requests","video_tasks","wallet_ledger","reserve_holds","device_wallets","daily_stats","audit_logs"];
    const snapshots = preservedTables.map(t => db.rows("SELECT * FROM " + t + " ORDER BY rowid"));
    const before = sums(db);
    const result = await cleanupUsageDetails(env(db),{ enabled:true,before:2 * H });
    expect(result).toMatchObject({ scanned:11,deleted:3 });
    expect(db.rows<{request_id:string}>("SELECT request_id FROM usage WHERE request_id IN ('settled','legacy','video')")).toEqual([]);
    expect(sums(db)).toEqual(before);
    expect(cost(db,-8 * H,"dev")).toBe(before.cost_usd);
    expect(db.rows("SELECT * FROM usage_rollup_receipts")).toHaveLength(11);
    preservedTables.forEach((t,i) => expect(db.rows("SELECT * FROM " + t + " ORDER BY rowid")).toEqual(snapshots[i]));
    expect(await verifyUsageRollups(env(db))).toMatchObject({ ok:true });
    expect(db.rows("SELECT * FROM usage_rollup_cleanup_context")).toEqual([]);
    expect(db.rows("SELECT * FROM usage_rollup_cleanup_permits")).toEqual([]);
  });

  it("archives per-hour granularity, blocks replayed request IDs and safely adds late old usage", async () => {
    const db = database(false);
    usage(db,{ request_id:"duplicate", created_at:H+10 }); usage(db,{ request_id:"duplicate",created_at:H+20 });
    installCore(db); await backfillUsageRollups(env(db)); ledger(db,"duplicate");
    const before = sums(db);
    expect(await cleanupUsageDetails(env(db),{ enabled:true,before:2 * H })).toMatchObject({deleted:2});
    expect(db.rows("SELECT * FROM usage_rollup_archived_hours")).toEqual([{hour_start:H}]);
    expect(sums(db)).toEqual(before);
    await expect(validateUsageRange(env(db),H+1,2 * H)).rejects.toThrow("usage_history_granularity_required");
    await expect(validateUsageRange(env(db),0,H+100)).rejects.toThrow("usage_history_granularity_required");
    await expect(validateUsageRange(env(db),H,2 * H)).resolves.toBeUndefined();
    await expect(validateUsageRange(env(db),H+1,H+1)).resolves.toBeUndefined();
    expect(() => usage(db,{request_id:"duplicate",created_at:3 * H})).toThrow("usage_request_id_archived");
    usage(db,{request_id:"late",created_at:H+30,cost_usd:3});
    expect(sums(db).cost_usd).toBe(before.cost_usd+3);
    expect(sums(db).request_count).toBe(3);
    expect(await backfillUsageRollups(env(db))).toEqual({processed:0,remaining:0});
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:true});
  });

  it("rolls back raw, receipts and both rollups if downstream settlement batch fails", async () => {
    const db = database();
    await expect(db.DB.batch([
      db.DB.prepare("INSERT INTO usage(device_id,request_id,created_at,cost_usd) VALUES('dev','rollback',?,9)").bind(H),
      db.DB.prepare("INSERT INTO reserve_holds(request_id,device_id,amount_usd,created_at) VALUES(NULL,NULL,NULL,NULL)"),
    ])).rejects.toThrow();
    for (const table of ["usage","usage_rollup_receipts","usage_hourly_rollups","usage_monthly_rollups","usage_rollup_write_context"]) expect(db.rows("SELECT * FROM " + table)).toEqual([]);
    usage(db,{request_id:"rollback"});
    expect(sums(db).request_count).toBe(1);
  });

  it("rolls back controlled deletion, archive markers and capabilities on a middle-row failure", async () => {
    const db = database();
    usage(db,{request_id:"one"}); ledger(db,"one"); const second = usage(db,{request_id:"two"}); ledger(db,"two");
    db.sql("CREATE TRIGGER test_fail_delete BEFORE DELETE ON usage WHEN OLD.id=" + second + " BEGIN SELECT RAISE(ABORT,'forced retention failure'); END");
    const before = sums(db);
    await expect(cleanupUsageDetails(env(db),{enabled:true,before:2 * H})).rejects.toThrow("forced retention failure");
    expect(db.rows("SELECT * FROM usage")).toHaveLength(2);
    expect(sums(db)).toEqual(before);
    for (const t of ["usage_rollup_archived_hours","usage_rollup_cleanup_context","usage_rollup_cleanup_permits"]) expect(db.rows("SELECT * FROM " + t)).toEqual([]);
    db.sql("DROP TRIGGER test_fail_delete");
    expect(await cleanupUsageDetails(env(db),{enabled:true,before:2 * H})).toMatchObject({deleted:2});
  });

  it("allows retry after lost cleanup acknowledgment without deleting or charging twice", async () => {
    const db = database(); usage(db,{request_id:"lost-cleanup"}); ledger(db,"lost-cleanup");
    const lost = { DB: { prepare: db.DB.prepare, batch: async (stmts: D1PreparedStatement[]) => {
      await db.DB.batch(stmts); throw new Error("lost cleanup ack");
    } } } as unknown as Env;
    await expect(cleanupUsageDetails(lost,{enabled:true,before:2 * H})).rejects.toThrow("lost cleanup ack");
    expect(await cleanupUsageDetails(env(db),{enabled:true,before:2 * H})).toMatchObject({deleted:0});
    expect(sums(db)).toMatchObject({request_count:1,cost_usd:0.25});
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:true});
  });

  it("detects raw history lost before installation against UTC+8 daily_stats and fails cleanup closed", async () => {
    const db = database(false);
    const id = usage(db,{request_id:"lost"}); usage(db,{request_id:"retained"}); ledger(db,"retained");
    db.sql("INSERT INTO daily_stats(date,device_id,provider_id,model,request_count,input_tokens,output_tokens,total_tokens,cost_usd) VALUES('1970-01-01','dev','provider','model',2,20,4,24,0.5)");
    db.sql("DELETE FROM usage WHERE id=?",id);
    installCore(db); await backfillUsageRollups(env(db));
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:false,status:"history_missing",missing_history:1});
    await expect(cleanupUsageDetails(env(db),{enabled:true,before:2 * H})).rejects.toThrow("history_missing");
    expect(db.rows("SELECT * FROM usage")).toHaveLength(1);
    expect(sums(db).request_count).toBe(1);  
  });

  it("guards immutable usage/receipts/aggregates against UPDATE DELETE and REPLACE bypasses", async () => {
    const db = database(); const id = usage(db,{request_id:"guard"});
    for (const sql of [
      "UPDATE usage SET cost_usd=99 WHERE id="+id,
      "UPDATE usage SET id=99 WHERE id="+id,
      "DELETE FROM usage", "DELETE FROM usage_rollup_receipts", "UPDATE usage_rollup_receipts SET request_id='other'",
      "INSERT OR REPLACE INTO usage_rollup_receipts SELECT * FROM usage_rollup_receipts",
      "INSERT INTO usage_rollup_write_context VALUES(1,"+id+")",
      "INSERT INTO usage_rollup_archived_hours VALUES("+H+")",
      "DELETE FROM usage_hourly_rollups", "UPDATE usage_hourly_rollups SET request_count=100",
      "DELETE FROM usage_monthly_rollups", "UPDATE usage_monthly_rollups SET cost_usd=100",
      "INSERT OR REPLACE INTO usage_hourly_rollups SELECT * FROM usage_hourly_rollups",
      "INSERT OR REPLACE INTO usage(id,request_id,created_at) VALUES("+id+",'guard',"+H+")",
    ]) expect(() => db.sql(sql),sql).toThrow();
    expect(() => db.sql("INSERT INTO usage_rollup_receipts VALUES(999,'fake','dev',?)",H)).toThrow("invalid_receipt");
    expect(sums(db)).toEqual(rawSums(db));
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:true});
  });

  it("keeps unreleased monthly funding and reconciles normalized legacy NULL dimensions without collapsing rolls", async () => {
    const db = database();
    usage(db,{request_id:"monthly-held",device_id:null,provider_id:null,model:null});
    usage(db,{request_id:"monthly-settled"}); billing(db,"monthly-settled");
    db.sql("INSERT INTO monthly_pass_funding VALUES('monthly-settled',NULL,0,0,0)");
    db.sql("INSERT INTO daily_stats(date,device_id,provider_id,model,request_count,input_tokens,output_tokens,total_tokens,cost_usd) VALUES('1970-01-01','','','',1,10,2,12,0.25)");
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:true});
    expect(await cleanupUsageDetails(env(db),{enabled:true,before:2*H})).toMatchObject({deleted:0});
    db.sql("UPDATE monthly_pass_funding SET released=1,settled=1 WHERE request_id='monthly-settled'");
    const fundingBefore = db.rows("SELECT * FROM monthly_pass_funding");
    expect(await cleanupUsageDetails(env(db),{enabled:true,before:2*H})).toMatchObject({deleted:1});
    expect(db.rows("SELECT * FROM monthly_pass_funding")).toEqual(fundingBefore);
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:true});
  });

  it("rechecks eligibility inside the cleanup transaction after preview and rejects stale authorization", async () => {
    const db = database(); usage(db,{request_id:"racing"}); ledger(db,"racing");
    const racing = { DB: { prepare: db.DB.prepare, batch: async (stmts: D1PreparedStatement[]) => {
      db.sql("INSERT INTO reserve_holds VALUES('racing','dev',1,?)",H);
      return db.DB.batch(stmts);
    } } } as unknown as Env;
    expect(await cleanupUsageDetails(racing,{enabled:true,before:2*H})).toMatchObject({scanned:1,deleted:0});
    expect(db.rows("SELECT * FROM usage")).toHaveLength(1);
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:true});
  });

  it("rejects verification drift created after preview in the cleanup transaction", async () => {
    const db = database(); usage(db,{request_id:"drift"}); ledger(db,"drift");
    const racing = { DB: { prepare: db.DB.prepare, batch: async (stmts: D1PreparedStatement[]) => {
      db.sql("INSERT INTO daily_stats(date,device_id,provider_id,model,request_count) VALUES('1970-01-01','dev','provider','model',100)");
      return db.DB.batch(stmts);
    } } } as unknown as Env;
    await expect(cleanupUsageDetails(racing,{enabled:true,before:2*H})).rejects.toThrow("usage_rollup_verification_required");
    expect(db.rows("SELECT * FROM usage")).toHaveLength(1);
    expect(db.rows("SELECT * FROM usage_rollup_cleanup_context")).toEqual([]);
    expect(db.rows("SELECT * FROM usage_rollup_archived_hours")).toEqual([]);
  });

  it("rolls back all claims when a historical aggregation fails halfway through its bounded statement", async () => {
    const db = database(false); usage(db,{request_id:"backfill-one"}); const second = usage(db,{request_id:"backfill-two"});
    installCore(db);
    db.sql("CREATE TRIGGER test_fail_backfill BEFORE INSERT ON usage_monthly_rollups WHEN EXISTS(SELECT 1 FROM usage_rollup_write_context WHERE usage_id="+second+") BEGIN SELECT RAISE(ABORT,'forced aggregate failure'); END");
    await expect(backfillUsageRollups(env(db))).rejects.toThrow("forced aggregate failure");
    for (const t of ["usage_rollup_receipts","usage_hourly_rollups","usage_monthly_rollups","usage_rollup_write_context"]) expect(db.rows("SELECT * FROM "+t)).toEqual([]);
    db.sql("DROP TRIGGER test_fail_backfill");
    expect(await backfillUsageRollups(env(db))).toEqual({processed:2,remaining:0});
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:true});
  });

  it("detects hourly and monthly numeric corruption and never authorizes cleanup over it", async () => {
    const db = database(); usage(db,{request_id:"corrupt"}); ledger(db,"corrupt");
    db.sql("DROP TRIGGER usage_monthly_rollups_guard_update");
    db.sql("UPDATE usage_monthly_rollups SET cost_usd=99");
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:false,status:"mismatch",monthly_mismatches:1});
    await expect(cleanupUsageDetails(env(db),{enabled:true,before:2*H})).rejects.toThrow("verification_required");
    db.sql("DROP TRIGGER usage_hourly_rollups_guard_update");
    db.sql("UPDATE usage_hourly_rollups SET cost_usd=99");
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:false,status:"mismatch",hourly_mismatches:1});
    expect(db.rows("SELECT * FROM usage")).toHaveLength(1);
  });

  it("requires backfill before cleanup and never fabricates invalid historical timestamps", async () => {
    const db = database(false); usage(db,{created_at:null,request_id:"undated"}); usage(db,{request_id:"normal"}); ledger(db,"normal");
    installCore(db);
    expect(await backfillUsageRollups(env(db))).toEqual({processed:1,remaining:1});
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:false,status:"mismatch",invalid_timestamps:1,unprocessed:1});
    await expect(cleanupUsageDetails(env(db),{enabled:true,before:2 * H})).rejects.toThrow("verification_required");
    expect(db.rows("SELECT * FROM usage")).toHaveLength(2);
  });

  it("serializes competing cleanups and bounds a real eligible deletion page to 1000", async () => {
    const db = database();
    for (let i=0;i<1003;i++) { usage(db,{request_id:"cleanup-bulk-"+i}); ledger(db,"cleanup-bulk-"+i); }
    const before = sums(db);
    const page = await previewUsageCleanup(env(db),{before:2*H});
    expect(page).toMatchObject({scanned:1000,eligible:1000});
    const results = await Promise.all([
      cleanupUsageDetails(env(db),{enabled:true,before:2*H}),
      cleanupUsageDetails(env(db),{enabled:true,before:2*H}),
    ]);
    expect(results.reduce((n,r)=>n+r.deleted,0)).toBe(1000);
    expect(results.every(r=>r.scanned<=1000 && r.deleted<=1000)).toBe(true);
    expect(db.rows("SELECT * FROM usage")).toHaveLength(3);
    expect(await cleanupUsageDetails(env(db),{enabled:true,before:2*H,after:page.next!})).toMatchObject({scanned:3,deleted:3});
    expect(db.rows("SELECT * FROM usage")).toEqual([]);
    expect(sums(db)).toEqual(before);
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:true});
  });

  it("hard-bounds historical claims to 500 and cleanup candidates to 1000", async () => {
    const db = database(false);
    for (let i=0;i<505;i++) usage(db,{request_id:"bulk-"+i});
    installCore(db);
    expect(await backfillUsageRollups(env(db))).toEqual({processed:500,remaining:5});
    expect(await backfillUsageRollups(env(db))).toEqual({processed:5,remaining:0});
    expect(sums(db).request_count).toBe(505);
    expect(await previewUsageCleanup(env(db),{before:2 * H,limit:4})).toMatchObject({scanned:4,eligible:0});
    expect(await verifyUsageRollups(env(db))).toMatchObject({ok:true});
  });
});
