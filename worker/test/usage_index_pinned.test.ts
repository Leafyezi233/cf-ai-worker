import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/schema";
import { getDeviceMonthlyCost, monthStartMs } from "../src/db/repo";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { seedDevice } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";

interface Recorded {
  sql: string;
  binds: unknown[];
}

function recordingEnv(d1: RealD1): { env: Env; seen: Recorded[] } {
  const seen: Recorded[] = [];
  const DB = {
    prepare(sql: string) {
      const recorded: Recorded = { sql, binds: [] };
      seen.push(recorded);
      const statement = d1.DB.prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...args: unknown[]) => {
        recorded.binds = args;
        return bind(...args);
      };
      return statement;
    },
    batch: (statements: any[]) => d1.DB.batch(statements),
  };
  return { env: { DB, ASSETS: null } as unknown as Env, seen };
}

function spendStatement(seen: Recorded[]): Recorded {
  const statement = seen.find(s => s.sql.includes("AS total_cost") && s.sql.includes("usage_monthly_rollups"));
  expect(statement).toBeDefined();
  return statement!;
}

describe("the monthly device cost read uses indexed authoritative history", () => {
  it("reads monthly rollups with receipt-deduplicated raw fallback", async () => {
    const d1 = createRealD1();
    await seedDevice(d1);
    const { env, seen } = recordingEnv(d1);

    await getDeviceMonthlyCost(env, "dev_1");

    const statement = spendStatement(seen);
    expect(statement.sql).toContain("usage_monthly_rollups");
    expect(statement.sql).toContain("FROM usage u");
    expect(statement.sql).toContain("NOT EXISTS");
    expect(statement.sql).toContain("usage_rollup_receipts");
    expect(statement.sql).not.toContain("daily_stats");
    expect(statement.binds).toEqual(["dev_1"]);
    d1.close();
  });

  it("plans device/time searches for both monthly and raw branches", async () => {
    const d1 = createRealD1();
    await seedDevice(d1);
    const { env, seen } = recordingEnv(d1);
    await getDeviceMonthlyCost(env, "dev_1");
    const statement = spendStatement(seen);
    const detail = d1.rows<{ detail: string }>("EXPLAIN QUERY PLAN " + statement.sql, ...statement.binds)
      .map(r => r.detail).join(" | ");

    expect(detail).toMatch(/SEARCH m USING INDEX idx_usage_monthly_device/);
    expect(detail).toMatch(/SEARCH u USING INDEX idx_usage_device_created/);
    expect(detail).toMatch(/SEARCH r USING INTEGER PRIMARY KEY/);
    expect(detail).not.toMatch(/SCAN (?:m|u|r)\b/);
    d1.close();
  });

  it("returns exact totals without double-counting processed raw rows or other devices", async () => {
    const d1 = createRealD1();
    await seedDevice(d1);
    const { env } = recordingEnv(d1);
    await ensureSchema(env);
    const now = Date.now();
    for (const cost of [0.5, 0.25, 2]) {
      d1.sql(
        "INSERT INTO usage (device_id, provider_id, provider_name, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit, pricing_missing, price_multiplier, status_code, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?, 0, 0, 1, 200, ?)",
        "dev_1", "prov_a", "Provider A", "gw-primary", cost, now
      );
    }
    d1.sql("INSERT INTO usage (device_id, cost_usd, created_at) VALUES ('dev_elsewhere', 19, ?)", now);
    d1.sql("INSERT INTO usage (device_id, cost_usd, created_at) VALUES ('dev_1', 11, ?)", monthStartMs() - 1);
    expect(await getDeviceMonthlyCost(env, "dev_1")).toBe(2.75);
    expect(await getDeviceMonthlyCost(env, "dev_1", now - 1000)).toBe(2.75);
    expect(await getDeviceMonthlyCost(env, "dev_other", now - 1000)).toBe(0);
    expect(await getDeviceMonthlyCost(env, "dev_elsewhere")).toBe(19);
    d1.close();
  });
});
