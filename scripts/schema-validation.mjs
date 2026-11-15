import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import assert from "node:assert/strict";
import baseline from "./schema-baseline.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(realpathSync(fileURLToPath(new URL("../worker/node_modules/wrangler/package.json", import.meta.url))));
const { build } = require("esbuild");
const bytes = Buffer.from(baseline, "base64");
assert.equal(createHash("sha256").update(bytes).digest("hex"), "6e18fe783f54a94301c2cef190ef72d2b3d48db33590acbc20928ad732ead58e");
const load = async options => {
  const result = await build({ ...options, bundle: true, format: "esm", platform: "browser", write: false });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
};
const old = await load({ stdin: { contents: bytes.toString("utf8"), loader: "ts", resolveDir: fileURLToPath(new URL("../worker/src/db/", import.meta.url)) } });
const current = await load({ entryPoints: [fileURLToPath(new URL("../worker/src/db/schema.ts", import.meta.url))] });
for (const key of ["INIT_STATEMENTS", "MIGRATION_ALTERS", "COLUMN_PROBE_SQL"]) assert.deepEqual(current[key], old[key], key);
for (const columns of [new Set(), new Set(["devices.password_hash", "usage.sub_token_id"])]) {
  assert.deepEqual(current.pendingMigrations(columns), old.pendingMigrations(columns));
  assert.deepEqual(current.splitPendingForIndexes(current.pendingMigrations(columns)), old.splitPendingForIndexes(old.pendingMigrations(columns)));
}
console.log("PASS exact current baseline: 45003 bytes, SHA256 6e18fe783f54a94301c2cef190ef72d2b3d48db33590acbc20928ad732ead58e; SQL arrays/probe/helper behavior unchanged");
if (process.argv.includes("--full")) {
  const index = process.argv.indexOf("--pnpm");
  assert(index >= 0 && process.argv[index + 1], "supply bundled pnpm.mjs with --pnpm");
  const result = spawnSync(process.execPath, [process.argv[index + 1], "--filter", "@aigw/worker", "exec", "vitest", "run", "--maxWorkers=2", "--minWorkers=2", "--reporter=json"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  const start = result.stdout.indexOf("{"); const end = result.stdout.lastIndexOf("}");
  if (start < 0 || end < start) { console.error(result.stdout, result.stderr); process.exitCode = result.status || 1; }
  else {
    const report = JSON.parse(result.stdout.slice(start, end + 1));
    console.log(JSON.stringify({ totalTests: report.numTotalTests, passedTests: report.numPassedTests, failedTests: report.numFailedTests, totalSuites: report.numTotalTestSuites, failedSuites: report.numFailedTestSuites, failedFiles: report.testResults.filter(r => r.status !== "passed").map(r => ({ file: relative(root, r.name), failed: r.assertionResults.filter(a => a.status === "failed").length, message: r.message.slice(0, 300), firstFailure: r.assertionResults.find(a => a.status === "failed")?.failureMessages?.[0]?.slice(0, 300) })) }, null, 2));
    process.exitCode = result.status || 0;
  }
}
