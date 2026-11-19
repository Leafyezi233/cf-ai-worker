import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(realpathSync(fileURLToPath(new URL("../worker/node_modules/wrangler/package.json", import.meta.url))));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const modulePath = name => fileURLToPath(new URL("../worker/src/db/" + name + ".ts", import.meta.url));

async function main() {
  const contents = [
    "export * as schema from " + JSON.stringify(modulePath("schema")) + ";",
    "export * as usage from " + JSON.stringify(modulePath("usage_rollups")) + ";",
    "export * as core from " + JSON.stringify(modulePath("usage_rollup_schema")) + ";",
  ].join("\n");
  const bundle = await build({ stdin: { contents, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "usage-retention-local-entry.ts" }, bundle: true, format: "esm", platform: "browser", write: false });
  const { schema, usage, core } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
  const H = core.USAGE_HOUR_MS;
  const before = 4 * H;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: "export default {fetch(){return new Response('local-only')}}",
    compatibilityDate: "2024-11-01",
    d1Databases: ["FRESH", "HISTORY"],
    d1Persist: false,
    telemetry: { enabled: false },
  }));
  try {
    const FRESH = await mf.getD1Database("FRESH");
    await schema.migrateSchema({ DB: FRESH });
    const versions = (await FRESH.prepare("SELECT id,checksum,completed FROM cpg_schema_versions ORDER BY id").all()).results;
    assert.equal(versions.length, 3 + schema.SCHEMA_DEFINITION.extensions.length);
    assert.ok(versions.every(row => row.completed === 1 && /^[a-f0-9]{64}$/.test(row.checksum)));
    assert.deepEqual(versions.filter(row => row.id.startsWith("usage/")).map(row => row.id), ["usage/0001-tables", "usage/0002-rollups"]);
    await schema.ensureSchema({ DB: FRESH });
    await schema.migrateSchema({ DB: FRESH });
    assert.deepEqual((await FRESH.prepare("SELECT id,checksum,completed FROM cpg_schema_versions ORDER BY id").all()).results, versions);
    assert.equal((await usage.verifyUsageRollups({ DB: FRESH })).status, "verified");
    console.log("PASS fresh native D1 migration + idempotent readiness:", JSON.stringify({ stages: versions.length, usageStages: versions.filter(row => row.id.startsWith("usage/")) }));

    const DB = await mf.getD1Database("HISTORY");
    for (const sql of schema.INIT_STATEMENTS.filter(sql => /^CREATE TABLE/i.test(sql))) await DB.prepare(sql).run();
    for (const sql of schema.INIT_STATEMENTS.filter(sql => !/^CREATE TABLE/i.test(sql))) await DB.prepare(sql).run();
    assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='usage_rollup_receipts'").first()).n, 0);
    const insert = async overrides => {
      const row = {
        device_id: "smoke-device", sub_token_id: null, provider_id: "smoke-provider", provider_name: "Local fixture",
        model: "smoke-model", service_group_id: null, input_tokens: 10, output_tokens: 2, total_tokens: 12,
        cost_usd: 0.25, cache_hit: 0, cache_read_tokens: 3, cache_write_tokens: 1, pricing_missing: 0,
        status_code: 200, latency_ms: 10, image_count: 0, search_calls: 0,
        request_id: "local-only", created_at: H + 1, ...overrides,
      };
      return DB.prepare("INSERT INTO usage(" + Object.keys(row).join(",") + ") VALUES(" + Object.keys(row).map(() => "?").join(",") + ")").bind(...Object.values(row)).run();
    };
    const ledger = request => DB.prepare("INSERT INTO wallet_ledger(device_id,delta_usd,reason,request_id,created_at) VALUES('smoke-device',-0.25,'usage',?,?)").bind(request, H).run();
    await insert({ request_id: "pending", created_at: H + 1 });
    await insert({ request_id: "paid-a", created_at: H + 2 });
    await insert({ request_id: "paid-b", created_at: H + 3, cost_usd: 0.5, cache_hit: 1, latency_ms: 5, status_code: 503 });
    await insert({ request_id: "paid-c", created_at: 2 * H + 1, cost_usd: 0.75, sub_token_id: "local-sub", service_group_id: "", latency_ms: 20 });
    await insert({ request_id: "paid-d", created_at: 2 * H + 2, cost_usd: 1, latency_ms: null, search_calls: 2 });
    for (const request of ["paid-a", "paid-b", "paid-c", "paid-d"]) await ledger(request);
    await schema.migrateSchema({ DB });
    const env = { DB };
    assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM usage_rollup_receipts").first()).n, 0);
    assert.equal((await usage.verifyUsageRollups(env)).status, "backfill_required");
    await assert.rejects(usage.cleanupUsageDetails(env, { enabled: true, before, operation_id: "before-backfill" }), /usage_rollup_verification_required:backfill_required/);
    assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM usage_rollup_cleanup_operations").first()).n, 0);
    assert.deepEqual(await usage.cleanupUsageDetails({ DB: { prepare() { throw new Error("default-off must not touch DB"); } } }), { enabled: false, scanned: 0, deleted: 0, next: null });

    const measurements = [];
    const measuredEnv = label => ({ DB: {
      prepare: sql => DB.prepare(sql),
      batch: async statements => {
        const results = await DB.batch(statements);
        measurements.push({ label, statements: results.map(result => result.meta) });
        return results;
      },
    } });
    const metricSelect = core.USAGE_ROLLUP_METRICS.map(metric => "COALESCE(" + core.usageMetricAggregate(metric, metric) + ",0) AS " + metric).join(",");
    const report = async (from = 0, to = before) => {
      await usage.validateUsageRange(env, from, to);
      const source = usage.usageReportSource(from, to);
      return DB.prepare("SELECT " + metricSelect + " FROM " + source.sql).bind(...source.binds).first();
    };
    const rawReport = () => DB.prepare("SELECT " + core.usageMetricExpressions("u").map((expression, i) => "COALESCE(" + core.usageMetricAggregate(core.USAGE_ROLLUP_METRICS[i], expression) + ",0) AS " + core.USAGE_ROLLUP_METRICS[i]).join(",") + " FROM usage u WHERE created_at>=0 AND created_at<?").bind(before).first();
    const historicalTotals = await rawReport();
    assert.deepEqual(await report(), historicalTotals);
    const backfillResults = [];
    for (const [page, remaining] of [3, 1, 0, 0].entries()) {
      const result = await usage.backfillUsageRollups(page === 0 ? measuredEnv("backfill-first") : env, { limit: 2 });
      backfillResults.push(result);
      assert.equal(result.remaining, remaining);
      assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM usage_rollup_receipts").first()).n, 5 - remaining);
      assert.deepEqual(await report(), historicalTotals);
    }
    assert.deepEqual(await report(), historicalTotals);
    assert.equal((await usage.verifyUsageRollups(env)).status, "verified");
    console.log("PASS historical native D1: bounded backfill 2/2/1/0; startup/partial/complete reports identical; cleanup fails closed before verification");

    const live = await insert({ request_id: "live-paid", created_at: 3 * H + 1, cost_usd: 1.25, latency_ms: 30, image_count: 2 });
    await ledger("live-paid");
    assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM usage_rollup_receipts").first()).n, 6);
    const totals = await rawReport();
    assert.deepEqual(await report(), totals);
    assert.equal(totals.request_count, 6);
    assert.equal(totals.cost_usd, 4);
    const spend = () => DB.prepare("SELECT " + usage.usageCostExpression(String(-8 * H), "'smoke-device'") + " AS cost").first();
    const spendBefore = await spend();
    assert.equal(spendBefore.cost, 4);
    const financialTables = ["device_wallets", "wallet_ledger", "reserve_holds", "billing_requests", "video_tasks", "monthly_pass_funding", "monthly_pass_buckets", "daily_stats"];
    const snapshot = async tables => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await DB.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()).results])));
    const financialBefore = await snapshot(financialTables);
    const allTables = ["usage", "usage_rollup_receipts", "usage_hourly_rollups", "usage_monthly_rollups", "usage_rollup_archived_hours", "usage_rollup_write_context", "usage_rollup_cleanup_context", "usage_rollup_cleanup_permits", "usage_rollup_cleanup_operations", ...financialTables];
    const beforePreview = await snapshot(allTables);
    const preview = await usage.previewUsageCleanup(env, { before, limit: 2 });
    assert.equal(preview.scanned, 2);
    assert.equal(preview.eligible, 1);
    assert.deepEqual(preview.candidates.map(row => row.id), [1, 2]);
    assert.deepEqual(await snapshot(allTables), beforePreview);
    const options = { enabled: true, before, limit: 2, operation_id: "native-page-one" };
    const first = await usage.cleanupUsageDetails(measuredEnv("cleanup-first"), options);
    assert.deepEqual(first, { enabled: true, scanned: 2, deleted: 1, next: { createdAt: H + 2, id: 2 } });
    const afterFirst = await snapshot(allTables);
    assert.deepEqual(await usage.cleanupUsageDetails(env, options), first);
    assert.deepEqual(await snapshot(allTables), afterFirst, "same operation replay must not consume the next page");
    await assert.rejects(usage.cleanupUsageDetails(env, { ...options, limit: 3 }), /usage_cleanup_operation_conflict/);
    await assert.rejects(usage.cleanupUsageDetails(env, { ...options, after: first.next }), /usage_cleanup_operation_conflict/);
    assert.deepEqual(await snapshot(allTables), afterFirst);
    assert.deepEqual(await report(), totals);
    await assert.rejects(usage.validateUsageRange(env, H + 1, before), /usage_history_granularity_required/);
    console.log("PASS preview is read-only; bounded cleanup scanned=2/deleted=1; same-operation replay leaves next page untouched; conflicting limit/cursor rejected; archived partial hour rejected");

    await DB.prepare("CREATE TABLE local_retention_fault(n INTEGER CHECK(n=0))").run();
    let faultReached = false;
    const faultyEnv = { DB: {
      prepare: sql => DB.prepare(sql),
      batch: async statements => {
        assert.equal(statements.length, 7);
        faultReached = true;
        return DB.batch([...statements.slice(0, 5), DB.prepare("INSERT INTO local_retention_fault VALUES(1)"), ...statements.slice(5)]);
      },
    } };
    const beforeFault = await snapshot(allTables);
    const faultOptions = { enabled: true, before, limit: 2, after: first.next, operation_id: "native-rollback" };
    await assert.rejects(usage.cleanupUsageDetails(faultyEnv, faultOptions), /CHECK constraint failed/);
    assert.equal(faultReached, true);
    assert.deepEqual(await snapshot(allTables), beforeFault, "raw rows, rollups, archived hours, operation result and financial evidence must roll back together");
    assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM usage_rollup_cleanup_operations WHERE operation_id='native-rollback'").first()).n, 0);
    assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM local_retention_fault").first()).n, 0);
    const retried = await usage.cleanupUsageDetails(env, faultOptions);
    assert.equal(retried.scanned, 2);
    assert.equal(retried.deleted, 2);
    console.log("PASS native D1 injected CHECK failure after raw DELETE + operation result UPDATE: full rollback; exact operation retry succeeds scanned=2/deleted=2");

    let after = retried.next;
    let subsequentDeleted = 0;
    let ended = false;
    for (let page = 0; page < 10; page++) {
      const result = await usage.cleanupUsageDetails(env, { enabled: true, before, limit: 2, after, operation_id: "native-rest-" + page });
      subsequentDeleted += result.deleted;
      assert.ok(result.scanned <= 2);
      if (result.next === null) { ended = true; break; }
      assert.ok(result.next.createdAt > after.createdAt || (result.next.createdAt === after.createdAt && result.next.id > after.id));
      after = result.next;
    }
    assert.equal(ended, true);
    assert.equal(subsequentDeleted, 2);
    assert.deepEqual((await DB.prepare("SELECT request_id FROM usage ORDER BY id").all()).results, [{ request_id: "pending" }]);
    assert.deepEqual(await report(), totals);
    assert.deepEqual(await spend(), spendBefore);
    assert.deepEqual(await snapshot(financialTables), financialBefore);
    assert.equal((await usage.verifyUsageRollups(env)).status, "verified");
    for (const table of ["usage_rollup_write_context", "usage_rollup_cleanup_context", "usage_rollup_cleanup_permits"]) assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM " + table).first()).n, 0);
    await assert.rejects(DB.prepare("INSERT INTO usage(device_id,request_id,created_at) VALUES('smoke-device','paid-a',?)").bind(H + 2).run(), /usage_request_id_archived/);
    console.log("PASS archived whole-hour reports preserve all " + core.USAGE_ROLLUP_METRICS.length + " metrics and UTC+8 monthly spend; live insert auto-rolls; 5 paid details removed, pending retained; financial tables unchanged; capabilities empty; archived request replay rejected");
    const finalVerify = await DB.prepare(core.USAGE_ROLLUP_VERIFY_SQL).all();
    const finalReport = usage.usageReportSource(0, before);
    const nativeReport = await DB.prepare("SELECT " + metricSelect + " FROM " + finalReport.sql).bind(...finalReport.binds).all();
    console.log("Native local D1 metadata (workerd query timing, NOT deployed Worker CPU):", JSON.stringify({ liveInsert: live.meta, batches: measurements, finalVerification: finalVerify.meta, finalReport: nativeReport.meta }));
    assert.deepEqual(backfillResults, [{ processed: 2, remaining: 3 }, { processed: 2, remaining: 1 }, { processed: 1, remaining: 0 }, { processed: 0, remaining: 0 }]);
    console.log("PASS LOCAL_USAGE_RETENTION: " + JSON.stringify({ runtime: "Miniflare/workerd native D1", persistent: false, remote: false, metrics: totals, verification: finalVerify.results[0], remainingRawRows: 1 }));
  } finally { await mf.dispose(); }
}

await main().catch(error => {
  const bounded = value => String(value).slice(0, 3000);
  console.error("LOCAL_USAGE_RETENTION_ERROR:", bounded(error?.message ?? error));
  if (error?.cause) console.error("CAUSE:", bounded(error.cause?.message ?? error.cause));
  process.exitCode = 1;
});
