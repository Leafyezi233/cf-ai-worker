import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
const require = createRequire(realpathSync(fileURLToPath(new URL("../worker/node_modules/wrangler/package.json", import.meta.url))));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
async function main() {
const bundle = await build({ entryPoints: [fileURLToPath(new URL("../worker/src/db/schema.ts", import.meta.url))], bundle: true, format: "esm", platform: "browser", write: false });
const schema = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const expectedStages = 3 + schema.SCHEMA_DEFINITION.extensions.length;
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {fetch(){return new Response('local-only')}}", compatibilityDate: "2024-11-01", d1Databases: ["DB", "LEGACY", "FAULT"], d1Persist: false, telemetry: { enabled: false } }));
try {
  const DB = await mf.getD1Database("DB");
  await Promise.all([schema.migrateSchema({ DB }), schema.migrateSchema({ DB })]);
  assert.equal((await DB.prepare("SELECT count(*) AS n FROM cpg_schema_versions WHERE completed=1").first()).n, expectedStages);
  const first = await DB.prepare("SELECT * FROM cpg_schema_versions ORDER BY id").all();
  await schema.ensureSchema({ DB }); await schema.ensureSchema({ DB });
  assert.deepEqual((await DB.prepare("SELECT * FROM cpg_schema_versions ORDER BY id").all()).results, first.results);
  const coldReads = [];
  const coldBinding = { prepare(sql) { const statement = DB.prepare(sql); return { first: async () => {
    const response = await statement.all(); coldReads.push({ sql, rows_read: response.meta.rows_read }); return response.results[0];
  } }; }, batch() { throw new Error("applied readiness must not write"); } };
  await schema.ensureSchema({ DB: coldBinding }); await schema.ensureSchema({ DB: coldBinding });
  assert.equal(coldReads.length, 1);
  console.log("Applied cold/warm query measurement:", JSON.stringify(coldReads.map(({ rows_read }) => ({ calls: 1, rows_read }))));
  const LEGACY = await mf.getD1Database("LEGACY");
  for (const sql of schema.INIT_STATEMENTS.filter(s => /^CREATE TABLE/i.test(s))) await LEGACY.prepare(sql).run();
  for (const sql of schema.INIT_STATEMENTS.filter(s => !/^CREATE TABLE/i.test(s))) await LEGACY.prepare(sql).run();
  await LEGACY.prepare("INSERT INTO devices(id,name,token_hash,cost_limit_monthly) VALUES('old','old','old',25)").run();
  await LEGACY.prepare("INSERT INTO device_wallets(device_id,balance_usd,reserved_usd) VALUES('old',0,0)").run();
  await LEGACY.prepare("INSERT INTO providers(id,name,type) VALUES('p','p','openai')").run();
  await LEGACY.prepare("INSERT INTO models(id,provider_id,model_name,input_price_per_m,pricing_mode) VALUES('m','p','m',9,'unset')").run();
  await LEGACY.prepare("ALTER TABLE devices DROP COLUMN password_hash").run();
  await LEGACY.prepare("CREATE TABLE audit_migration_runs(n INTEGER)").run();
  await LEGACY.prepare("CREATE TRIGGER audit_pricing AFTER UPDATE OF pricing_mode ON models BEGIN INSERT INTO audit_migration_runs VALUES(1); END").run();
  await Promise.all([schema.migrateSchema({ DB: LEGACY }), schema.migrateSchema({ DB: LEGACY })]);
  assert.equal((await LEGACY.prepare("SELECT balance_usd FROM device_wallets WHERE device_id='old'").first()).balance_usd, 0);
  assert.equal((await LEGACY.prepare("SELECT count(*) AS n FROM audit_migration_runs").first()).n, 1);
  assert.equal((await LEGACY.prepare("SELECT count(*) AS n FROM cpg_schema_versions").first()).n, expectedStages);
  schema.resetSchemaCache(LEGACY); await schema.ensureSchema({ DB: LEGACY });
  const FAULT = await mf.getD1Database("FAULT");
  for (const sql of schema.INIT_STATEMENTS.filter(s => /^CREATE TABLE/i.test(s))) await FAULT.prepare(sql).run();
  await FAULT.prepare("INSERT INTO providers(id,name,type) VALUES('p','p','openai')").run();
  await FAULT.prepare("INSERT INTO models(id,provider_id,model_name,input_price_per_m,pricing_mode) VALUES('m','p','m',9,'unset')").run();
  await FAULT.prepare("INSERT INTO devices(id,name,token_hash,cost_limit_monthly) VALUES('d','d','d',25)").run();
  await FAULT.prepare("CREATE TABLE injection(n INTEGER CHECK(n=0))").run();
  await FAULT.prepare("CREATE TABLE audit_migration_runs(n INTEGER)").run();
  await FAULT.prepare("CREATE TRIGGER audit_pricing AFTER UPDATE OF pricing_mode ON models BEGIN INSERT INTO audit_migration_runs VALUES(1); END").run();
  let batches = 0;
  const failing = { prepare: sql => FAULT.prepare(sql), batch: async statements => {
    if (++batches === 4) return FAULT.batch([...statements.slice(0, -1), FAULT.prepare("INSERT INTO injection VALUES(1)"), statements.at(-1)]);
    return FAULT.batch(statements);
  } };
  await assert.rejects(schema.ensureSchema({ DB: failing }), /CHECK constraint failed/);
  assert.equal((await FAULT.prepare("SELECT count(*) AS n FROM cpg_schema_versions").first()).n, 2);
  assert.equal((await FAULT.prepare("SELECT count(*) AS n FROM device_wallets").first()).n, 0);
  assert.equal((await FAULT.prepare("SELECT pricing_mode FROM models WHERE id='m'").first()).pricing_mode, "unset");
  let lost = false;
  const ambiguous = { prepare: sql => FAULT.prepare(sql), batch: async statements => {
    const result = await FAULT.batch(statements); lost = true; throw new Error("lost local acknowledgement");
  } };
  await schema.ensureSchema({ DB: ambiguous }); assert.equal(lost, true);
  assert.equal((await FAULT.prepare("SELECT count(*) AS n FROM audit_migration_runs").first()).n, 1);
  assert.equal((await FAULT.prepare("SELECT count(*) AS n FROM cpg_schema_versions").first()).n, expectedStages);
  console.log("PASS local workerd D1: empty + partial legacy, two independent runners, exactly-once backfill, zero wallet, reset audit, transactional rollback, ambiguous commit");
  console.log(JSON.stringify(first.results.map(({id,checksum,completed}) => ({id,checksum,completed}))));
} finally { await mf.dispose(); }
}
await main().catch(error => { console.error("LOCAL_SCHEMA_ERROR:",error?.message ?? String(error)); if (error?.cause) console.error("CAUSE:",error.cause?.message ?? String(error.cause)); process.exitCode=1; });
