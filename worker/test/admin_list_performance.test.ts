import { createRequire } from "node:module";
const requireNode = createRequire(import.meta.url);
const { Buffer } = requireNode("node:buffer");
const { writeFileSync, mkdirSync } = requireNode("node:fs");
const { dirname } = requireNode("node:path");
const { fileURLToPath } = requireNode("node:url");
const { version: nodeVersion } = requireNode("node:process");
import { expect, it } from "vitest";
import { devicesApp } from "../src/admin/devices";
import { listDevices, listModels, monthStartMs } from "../src/db/repo";
import { ensureSchema } from "../src/db/schema";
import { createRealD1 } from "./helpers/realD1";
import { makeEnv, seedDevice, seedModel, seedProvider } from "./helpers/realGatewayEnv";

const SAMPLE_COUNT = 30;
const WARMUP_ROUNDS = 5;
const OMITTED_PROVIDER_FIELDS = ["provider_api_key", "provider_secret_name", "provider_config_json", "provider_endpoint"];
type Items = { items: Record<string, unknown>[] };
type Sample = { elapsedMs: number; jsonBytes: number; statements: string[] };

it("reports warm local SQLite admin list payloads and verifies narrow query boundaries", async () => {
  const db = createRealD1();
  const env = makeEnv(db);
  const originalPrepare = env.DB.prepare.bind(env.DB);
  const statements: string[] = [];
  try {
    await ensureSchema(env);
    const suffix = (i: number) => String(i).padStart(3, "0");
    for (let i = 0; i < 32; i++) {
      const id = "provider_" + suffix(i);
      seedProvider(db, { id, name: "Synthetic provider " + i, endpoint: "https://provider-" + i + ".invalid/v1", api_key: "NOT_A_REAL_KEY_" + i });
      db.sql("UPDATE providers SET secret_name = ?, config_json = ? WHERE id = ?",
        "SYNTHETIC_SECRET_NAME_" + i, JSON.stringify({ fixture: true, region: "local-only", note: "synthetic provider configuration" }), id);
    }
    for (let i = 0; i < 95; i++) {
      seedModel(db, { id: "model_" + suffix(i), provider_id: "provider_" + suffix(i % 32),
        model_name: "synthetic-model-" + i, enabled: i % 9 === 0 ? 0 : 1,
        config_json: JSON.stringify({ context_window: 64000, max_output_tokens: 8000, fixture: true }) });
    }
    const usageTimestamp = monthStartMs() + 60_000;
    for (let i = 0; i < 106; i++) {
      const id = "account_" + suffix(i);
      await seedDevice(db, { id, token_hash: "synthetic-noncredential-hash-" + i, enabled: i % 7 === 0 ? 0 : 1, balance_usd: 10 + i / 100 });
      db.sql("UPDATE devices SET name = ?, created_at = ? WHERE id = ?", "合成账户 " + suffix(i), i + 1, id);
      for (let j = 0; j < 10; j++) db.sql(
        "INSERT INTO usage (device_id, provider_id, provider_name, model, cost_usd, input_tokens, output_tokens, total_tokens, status_code, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id, "provider_000", "Synthetic provider 0", "synthetic-model-0", 0.001, 10, 5, 15, 200, "fixture_" + i + "_" + j, usageTimestamp + j);
    }
    for (const [table, count] of [["devices", 106], ["models", 95], ["providers", 32], ["usage", 1060]] as const) {
      expect(db.row<{ n: number }>("SELECT COUNT(*) AS n FROM " + table)?.n).toBe(count);
    }
    env.DB.prepare = ((sql: string) => {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return originalPrepare(sql);
    }) as typeof env.DB.prepare;
    const operations = {
      devicesLegacyFull: async () => JSON.stringify({ items: await listDevices(env) }),
      modelsLegacyProjection: async () => JSON.stringify({ items: await listModels(env, { includeSecrets: false }) }),
      modelsAdminProjection: async () => JSON.stringify({ items: await listModels(env, { includeSecrets: false, adminProjection: true }) }),
      devicesChoices: async () => {
        const response = await devicesApp.request("http://admin.test/choices", {}, env);
        if (response.status !== 200) throw new Error("choices returned " + response.status);
        return response.text();
      },
    };
    const names = Object.keys(operations) as (keyof typeof operations)[];
    const samples = Object.fromEntries(names.map(name => [name, [] as Sample[]])) as Record<keyof typeof operations, Sample[]>;
    const latest = {} as Record<keyof typeof operations, Items>;
    for (let round = -WARMUP_ROUNDS; round < SAMPLE_COUNT; round++) {
      const order = round % 2 === 0 ? names : [...names].reverse();
      for (const name of order) {
        statements.length = 0;
        const start = performance.now();
        const text = await operations[name]();
        const jsonBytes = Buffer.byteLength(text, "utf8");
        const elapsedMs = performance.now() - start;
        if (round >= 0) samples[name].push({ elapsedMs, jsonBytes, statements: [...statements] });
        latest[name] = JSON.parse(text) as Items;
      }
    }
    expect(latest.devicesLegacyFull.items).toHaveLength(106);
    expect(latest.devicesChoices.items).toHaveLength(106);
    expect(latest.modelsLegacyProjection.items).toHaveLength(95);
    expect(latest.modelsAdminProjection.items).toHaveLength(95);
    expect(latest.devicesLegacyFull.items[0].current_month_cost).toBeCloseTo(0.01, 8);
    expect(latest.devicesChoices.items).toEqual(latest.devicesLegacyFull.items.map(({ id, name, enabled }) => ({ id, name, enabled })));
    for (const item of latest.devicesChoices.items) expect(Object.keys(item).sort()).toEqual(["enabled", "id", "name"]);
    expect(latest.devicesChoices.items.some(item => item.enabled === 0)).toBe(true);
    for (const item of latest.modelsAdminProjection.items) {
      for (const field of OMITTED_PROVIDER_FIELDS) expect(item).not.toHaveProperty(field);
      expect(item).toHaveProperty("config_json");
    }
    expect(latest.modelsAdminProjection.items).toEqual(latest.modelsLegacyProjection.items.map(item =>
      Object.fromEntries(Object.entries(item).filter(([key]) => !OMITTED_PROVIDER_FIELDS.includes(key)))));
    for (const name of names) {
      expect(samples[name]).toHaveLength(SAMPLE_COUNT);
      for (const sample of samples[name]) {
        expect(sample.statements).toHaveLength(1);
        expect(sample.statements[0]).toMatch(/^SELECT\b/i);
        if (name === "devicesChoices") {
          expect(sample.statements[0]).not.toMatch(/usage|wallet|JOIN|password|token_hash/i);
          expect(sample.statements[0]).toMatch(/^SELECT id, name, enabled FROM devices WHERE revoked_at IS NULL/i);
        }
        if (name === "modelsAdminProjection") expect(sample.statements[0]).not.toMatch(/p\.(api_key|secret_name|config_json|endpoint)\b/i);
      }
    }
    db.sql("UPDATE devices SET revoked_at = ? WHERE id = ?", usageTimestamp, "account_000");
    statements.length = 0;
    const afterRevocation = JSON.parse(await operations.devicesChoices()) as Items;
    expect(afterRevocation.items).toHaveLength(105);
    expect(afterRevocation.items.some(item => item.id === "account_000")).toBe(false);
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toMatch(/usage|wallet/i);

    const results = Object.fromEntries(names.map(name => {
      const sorted = samples[name].map(sample => sample.elapsedMs).sort((a, b) => a - b);
      const bytes = [...new Set(samples[name].map(sample => sample.jsonBytes))];
      expect(bytes).toHaveLength(1);
      return [name, {
        sampleCount: samples[name].length, jsonBytes: bytes[0],
        p50Ms: sorted[Math.ceil(SAMPLE_COUNT * 0.50) - 1], p95Ms: sorted[Math.ceil(SAMPLE_COUNT * 0.95) - 1],
        preparedStatementsPerCall: [...new Set(samples[name].map(sample => sample.statements.length))],
        uniquePreparedSql: [...new Set(samples[name].flatMap(sample => sample.statements))],
        samplesMs: samples[name].map(sample => sample.elapsedMs),
      }];
    }));
    const reduction = (oldBytes: number, newBytes: number) => ({ oldBytes, newBytes, savedBytes: oldBytes - newBytes, savedPercent: (oldBytes - newBytes) / oldBytes * 100 });
    const report = {
      producer: "local-benchmark", generatedAt: new Date().toISOString(),
      fixture: { accounts: 106, models: 95, providers: 32, wallets: 106, usageRows: 1060, usageRowsPerAccount: 10, syntheticOnly: true, realSecrets: false },
      methodology: {
        engine: "realD1 node:sqlite in-memory SQLite", node: nodeVersion,
        scope: "Local wall-clock including real repository/handler calls, JSON serialization/body read and UTF-8 byte length; not production CPU or D1 billing data.",
        samplesPerOperation: SAMPLE_COUNT, excludedWarmupRounds: WARMUP_ROUNDS,
        schemaInitializationExcluded: true, order: "alternating forward/reverse per round", percentile: "nearest rank",
        modelsLegacy: "listModels(includeSecrets:false), existing full provider projection, not historical deployed code",
        modelsNarrow: "listModels(includeSecrets:false,adminProjection:true); model config_json retained, provider config omitted",
        devicesLegacy: "listDevices real full list wrapped in {items}; choices uses actual devicesApp /choices response",
        limitations: ["One local process/database, 30 warm samples per operation; no statistical significance or latency threshold assertion.", "Synthetic fixture and bounded usage history are not a production workload.", "No network, admin-auth middleware, edge startup, TLS, compression, remote D1 latency, production Worker CPU or billed rows measured.", "DB.prepare counts top-level statements, not SQLite internal subqueries, rows scanned, trigger work, or D1 billing.", "Models comparison excludes decryption in both variants; no real secrets or paid upstream calls."],
      },
      verification: { choicesSingleSelectNoUsageOrWallet: true, narrowModelsOmitProviderCredentialsAndConfig: true, modelOwnConfigRetained: true, revokedExcludedAfterSeparateCheck: true, disabledAccountsIncluded: true },
      results,
      payloadReduction: {
        devices: reduction(results.devicesLegacyFull.jsonBytes, results.devicesChoices.jsonBytes),
        models: reduction(results.modelsLegacyProjection.jsonBytes, results.modelsAdminProjection.jsonBytes),
      },
    };
    const reportPath = fileURLToPath(new URL("../../preview/admin-filter-performance-20261115.json", import.meta.url));
  mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ producer: report.producer, fixture: report.fixture, localSQLiteNotProductionCpuOrD1Billing: true,
      samplesPerOperation: SAMPLE_COUNT, payloadReduction: report.payloadReduction,
      results: Object.fromEntries(Object.entries(results).map(([name, value]) => [name, { jsonBytes: value.jsonBytes, p50Ms: value.p50Ms, p95Ms: value.p95Ms, preparedStatementsPerCall: value.preparedStatementsPerCall }])), reportPath }));
  } finally {
    env.DB.prepare = originalPrepare;
    db.close();
  }
}, 30_000);
