import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TZ_OFFSET_MINUTES,
  GROUPED_SCAN_MIN_WINDOW_MS,
  getCurrentMonthSpend,
  getRecentProviderAvgLatencies,
  getRecentProviderFailureStats,
  monthStartMs,
  preferGroupedScan,
  statsByModel,
  statsByProvider,
  statsModelLatency,
} from "../src/db/repo";
import { routeNeedsLatencies, selectCandidateRoute } from "../src/gateway/routing";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { gatewayApp } from "../src/gateway/index";
import {
  CollectingExecutionContext,
  chatBody,
  createRealD1,
  makeEnv,
  openAiAnswer,
  postJson,
  seedDevice,
  seedModel,
  seedProvider,
} from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";

function recordQueries(env: Env) {
  const seen: { sql: string; binds: unknown[] }[] = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql: string) => {
    const entry = { sql, binds: [] as unknown[] };
    seen.push(entry);
    const stmt = prepare(sql);
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...args: unknown[]) => {
      entry.binds = args;
      return bind(...args);
    };
    return stmt;
  };
  return seen;
}


let realFetch: typeof globalThis.fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetRateLimitMemory();
  clearMemoryCacheForTest();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function plan(d1: ReturnType<typeof createRealD1>, sql: string, ...params: unknown[]): string {
  return d1
    .rows<{ detail: string }>("EXPLAIN QUERY PLAN " + sql, ...params)
    .map((r) => r.detail)
    .join(" | ");
}

function usageRow(d1: ReturnType<typeof createRealD1>, over: {
  device_id?: string;
  provider_id?: string;
  model?: string;
  cost_usd?: number;
  latency_ms?: number;
  status_code?: number;
  created_at: number;
}) {
  d1.sql(
    "INSERT INTO usage (device_id, provider_id, provider_name, model, cost_usd, latency_ms, status_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    over.device_id ?? "dev_1",
    over.provider_id ?? "prov_a",
    "Provider A",
    over.model ?? "gw-primary",
    over.cost_usd ?? 0,
    over.latency_ms ?? 0,
    over.status_code ?? 200,
    over.created_at
  );
}

describe("the latency lookup only runs when a strategy reads it", () => {
  const model = (config_json: string | null, id = "m") =>
    ({ id, provider_id: "p", model_name: "gw-primary", alias: null, config_json } as any);

  it("says no for a single candidate, whatever it is configured with", () => {
    expect(routeNeedsLatencies([model('{"routing_strategy":"lowest_latency"}')])).toBe(false);
  });

  it("says no for priority, weighted and unconfigured candidates", () => {
    const other = model(null, "n");
    expect(routeNeedsLatencies([model('{"routing_strategy":"priority"}'), other])).toBe(false);
    expect(routeNeedsLatencies([model('{"routing_strategy":"weighted"}'), other])).toBe(false);
    expect(routeNeedsLatencies([model(null), other])).toBe(false);
  });

  it("says yes only for lowest_latency", () => {
    expect(routeNeedsLatencies([model('{"routing_strategy":"lowest_latency"}'), model(null, "n")])).toBe(true);
  });

  it("resolves the strategy the same way the router does: first candidate that names one wins", () => {
    const candidates = [model('{"routing_strategy":"priority"}'), model('{"routing_strategy":"lowest_latency"}', "n")];
    expect(routeNeedsLatencies(candidates)).toBe(false);
    const flipped = [model('{"routing_strategy":"lowest_latency"}'), model('{"routing_strategy":"priority"}', "n")];
    expect(routeNeedsLatencies(flipped)).toBe(true);
  });

  it("does not change the order the router produces under priority", () => {
    const candidates = [model(null, "model_b"), model(null, "model_a")];
    const withLatencies = selectCandidateRoute(candidates, "gw-primary", { p: 1 });
    const without = selectCandidateRoute(candidates, "gw-primary", {});
    expect(withLatencies.map((c: any) => c.id)).toEqual(without.map((c: any) => c.id));
    expect(without.map((c: any) => c.id)).toEqual(["model_a", "model_b"]);
  });
});

describe("the gateway does not read usage for a priority route", () => {
  function seedTwoProviders(d1: ReturnType<typeof createRealD1>, configA: string | null) {
    seedProvider(d1, { id: "prov_a", name: "Provider A", endpoint: "https://a.example/v1", api_key: "sk-a" });
    seedProvider(d1, { id: "prov_b", name: "Provider B", endpoint: "https://b.example/v1", api_key: "sk-b" });
    seedModel(d1, { id: "model_a", provider_id: "prov_a", model_name: "gw-primary", config_json: configA });
    seedModel(d1, { id: "model_b", provider_id: "prov_b", model_name: "gw-primary" });
  }

  async function call(env: Env, d1: ReturnType<typeof createRealD1>) {
    const exec = new CollectingExecutionContext();
    const res = await postJson(env, "/chat/completions", chatBody("gw-primary"), exec);
    await res.text();
    await Promise.all(exec.pending);
    return res;
  }

  function countLatencyQueries(d1: ReturnType<typeof createRealD1>) {
    let hits = 0;
    const realPrepare = d1.DB.prepare.bind(d1.DB);
    (d1.DB as any).prepare = (sql: string) => {
      if (sql.includes("AVG(latency_ms)")) hits++;
      return realPrepare(sql);
    };
    return () => hits;
  }

  it("skips the query entirely under the default priority strategy", async () => {
    const d1 = createRealD1();
    seedTwoProviders(d1, null);
    await seedDevice(d1, { balance_usd: 1 });
    usageRow(d1, { provider_id: "prov_a", latency_ms: 9_000, created_at: Date.now() - 1_000 });
    const env = makeEnv(d1);
    const hits = countLatencyQueries(d1);
    globalThis.fetch = vi.fn(async () => openAiAnswer()) as unknown as typeof globalThis.fetch;

    const res = await call(env, d1);

    expect(res.status).toBe(200);
    expect(hits()).toBe(0);
    d1.close();
  });

  it("still asks for them, and still reorders, under lowest_latency", async () => {
    const d1 = createRealD1();
    seedTwoProviders(d1, '{"routing_strategy":"lowest_latency"}');
    await seedDevice(d1, { balance_usd: 1 });
    usageRow(d1, { provider_id: "prov_a", latency_ms: 9_000, created_at: Date.now() - 1_000 });
    usageRow(d1, { provider_id: "prov_b", latency_ms: 40, created_at: Date.now() - 1_000 });
    const env = makeEnv(d1);
    const hits = countLatencyQueries(d1);
    const dialled: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      dialled.push(String(input));
      return openAiAnswer();
    }) as unknown as typeof globalThis.fetch;

    const res = await call(env, d1);

    expect(res.status).toBe(200);
    expect(hits()).toBe(1);
    expect(dialled[0]).toBe("https://b.example/v1/chat/completions");
    d1.close();
  });

  it("returns the same per-provider averages it did before the index hint", async () => {
    const d1 = createRealD1();
    const now = Date.now();
    usageRow(d1, { provider_id: "prov_a", latency_ms: 100, created_at: now - 1_000 });
    usageRow(d1, { provider_id: "prov_a", latency_ms: 300, created_at: now - 2_000 });
    usageRow(d1, { provider_id: "prov_a", latency_ms: 9_999, created_at: now - 10 * 3600_000 });
    usageRow(d1, { provider_id: "prov_b", latency_ms: 50, status_code: 500, created_at: now - 1_000 });
    const map = await getRecentProviderAvgLatencies(makeEnv(d1));
    expect(map.prov_a).toBe(200);
    expect(map.prov_b).toBeUndefined();
    d1.close();
  });
});

describe("the monthly spend window is the same month, without scanning the table", () => {
  it("sums the local calendar month and nothing else", async () => {
    const d1 = createRealD1();
    const start = monthStartMs(DEFAULT_TZ_OFFSET_MINUTES);
    usageRow(d1, { cost_usd: 10, created_at: start - 1 });           
    usageRow(d1, { cost_usd: 2.25, created_at: start });
    usageRow(d1, { cost_usd: 0.25, created_at: Date.now() });
    const spend = await getCurrentMonthSpend(makeEnv(d1));
    expect(spend).toBeCloseTo(2.5, 6);
    d1.close();
  });

  it("agrees with the strftime expression it replaced", async () => {
    const d1 = createRealD1();
    const start = monthStartMs(DEFAULT_TZ_OFFSET_MINUTES);
    for (const [cost, at] of [[10, start - 1], [2.25, start], [0.25, Date.now()], [7, start - 86400_000]] as const) {
      usageRow(d1, { cost_usd: cost, created_at: at });
    }
    const legacy = d1.row<{ v: number }>(
      "SELECT COALESCE(SUM(cost_usd), 0) as v FROM usage " +
        "WHERE strftime('%Y-%m', datetime(created_at / 1000, 'unixepoch', '+480 minutes')) = strftime('%Y-%m', 'now', '+480 minutes')"
    );
    expect(await getCurrentMonthSpend(makeEnv(d1))).toBeCloseTo(Number(legacy!.v), 4);
    d1.close();
  });

  it("honours an explicit timezone modifier", async () => {
    const d1 = createRealD1();
    const utcStart = monthStartMs(0);
    usageRow(d1, { cost_usd: 1, created_at: utcStart - 1 });
    usageRow(d1, { cost_usd: 4, created_at: utcStart });
    expect(await getCurrentMonthSpend(makeEnv(d1), "0 minutes")).toBeCloseTo(4, 6);
    d1.close();
  });

  it("searches monthly history and raw time ranges in the actual prepared query", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const seen = recordQueries(env);
    await getCurrentMonthSpend(env);
    const query = seen.find(s => s.sql.includes("as total_cost") && s.sql.includes("usage_monthly_rollups"));
    expect(query).toBeDefined();
    expect(query!.sql).toContain("usage_rollup_receipts");
    expect(query!.sql).not.toContain("daily_stats");
    const text = plan(d1, query!.sql, ...query!.binds);
    expect(text).toMatch(/SEARCH m USING INDEX/);
    expect(text).toMatch(/SEARCH u USING INDEX (?:idx_usage_created_at|idx_usage_rollup_cleanup_page) \(created_at>\?\)/);
    expect(text).toMatch(/SEARCH r USING INTEGER PRIMARY KEY/);
    expect(text).not.toMatch(/SCAN (?:m|u|r)\b/);
    d1.close();
  });
});

describe("the report queries stop walking the model index", () => {
  it("latency, by-model and per-model-latency all use the time index", () => {
    const d1 = createRealD1();
    expect(
      plan(d1, "SELECT provider_id, COALESCE(AVG(latency_ms), 0) as avg_latency FROM usage INDEXED BY idx_usage_created_at WHERE created_at >= ? AND latency_ms > 0 GROUP BY provider_id", 0)
    ).toContain("idx_usage_created_at");
    expect(
      plan(d1, "SELECT model, COUNT(*) as requests FROM usage INDEXED BY idx_usage_created_at WHERE created_at >= ? GROUP BY model", 0)
    ).toContain("idx_usage_created_at");
    expect(
      plan(d1, "SELECT model, COUNT(*) as requests FROM usage INDEXED BY idx_usage_created_at WHERE created_at >= ? AND latency_ms > 0 GROUP BY model", 0)
    ).toContain("idx_usage_created_at");
    d1.close();
  });

  it("a per-device window uses the composite index", () => {
    const d1 = createRealD1();
    const text = plan(d1, "SELECT COALESCE(SUM(cost_usd), 0) as total_cost FROM usage WHERE device_id = ? AND created_at >= ?", "dev_1", 0);
    expect(text).toContain("idx_usage_device_created");
    d1.close();
  });

  it("statsByModel and statsModelLatency still return the same numbers", async () => {
    const d1 = createRealD1();
    const now = Date.now();
    usageRow(d1, { model: "gw-a", cost_usd: 1, latency_ms: 100, created_at: now - 1_000 });
    usageRow(d1, { model: "gw-a", cost_usd: 1, latency_ms: 300, created_at: now - 2_000 });
    usageRow(d1, { model: "gw-b", cost_usd: 2, latency_ms: 50, status_code: 500, created_at: now - 3_000 });
    usageRow(d1, { model: "gw-b", cost_usd: 5, latency_ms: 50, created_at: now - 40 * 86400_000 });
    const env = makeEnv(d1);

    const byModel = (await statsByModel(env, now - 86400_000)) as any[];
    const a = byModel.find((r) => r.name === "gw-a");
    expect(a.requests).toBe(2);
    expect(a.cost_usd).toBeCloseTo(2, 6);
    expect(a.errors).toBe(0);

    const latency = await statsModelLatency(env, now - 86400_000);
    const b = latency.find((r) => r.model === "gw-b");
    expect(b!.requests).toBe(1);
    expect(b!.error_count).toBe(1);
    d1.close();
  });
});

describe("the grouped reports use authoritative indexed hourly and raw sources", () => {
  it("retains the old scan-threshold helper for compatibility", () => {
    const now = Date.UTC(2026, 9, 24, 12, 0, 0);
    expect(preferGroupedScan(now - 86400_000 + 1, now)).toBe(false);
    expect(preferGroupedScan(now - 3600_000, now)).toBe(false);
    expect(preferGroupedScan(now - GROUPED_SCAN_MIN_WINDOW_MS, now)).toBe(true);
    expect(preferGroupedScan(now - 7 * 86400_000, now)).toBe(true);
    expect(preferGroupedScan(now - 30 * 86400_000, now)).toBe(true);
  });

  it("groups by provider identity over the same independent source at either window width", async () => {
    const d1 = createRealD1();
    const now = Date.now();
    usageRow(d1, { provider_id: "prov_a", model: "gw-a", cost_usd: 1, created_at: now - 3 * 86400_000 });
    const env = makeEnv(d1);
    const seen: string[] = [];
    const realPrepare = env.DB.prepare;
    env.DB.prepare = (sql: string) => {
      seen.push(sql);
      return realPrepare(sql);
    };

    await statsByProvider(env, now - 7 * 86400_000);
    expect(seen.join("|")).toContain("GROUP BY provider_id");
    expect(seen.join("|")).toContain("LEFT JOIN providers");
    expect(seen.join("|")).toContain("usage_hourly_rollups");
    expect(seen.join("|")).toContain("usage_rollup_receipts");
    expect(seen.filter(sql => sql.includes(") u LEFT JOIN providers p")).join("|")).not.toContain("daily_stats");

    seen.length = 0;
    await statsByProvider(env, now - 3600_000);
    expect(seen.join("|")).toContain("GROUP BY provider_id");
    expect(seen.join("|")).toContain("LEFT JOIN providers");
    expect(seen.join("|")).toContain("usage_hourly_rollups");
    expect(seen.join("|")).toContain("usage_rollup_receipts");
    expect(seen.filter(sql => sql.includes(") u LEFT JOIN providers p")).join("|")).not.toContain("daily_stats");
    d1.close();
  });

  it("names a provider from its historical rows even after the provider is gone", async () => {
    const d1 = createRealD1();
    const now = Date.now();
    usageRow(d1, { provider_id: "prov_gone", model: "gw-a", cost_usd: 1, created_at: now - 3 * 86400_000 });
    usageRow(d1, { provider_id: "prov_gone", model: "gw-a", cost_usd: 1, created_at: now - 4 * 86400_000 });
    usageRow(d1, { provider_id: "prov_gone", model: "gw-a", cost_usd: 1, created_at: now - 60_000 });
    const env = makeEnv(d1);

    const wide = (await statsByProvider(env, now - 7 * 86400_000)) as any[];
    expect(wide).toHaveLength(1);
    expect(wide[0].name).toBe("Provider A");
    expect(wide[0].requests).toBe(3);

    const narrow = (await statsByProvider(env, now - 3600_000)) as any[];
    expect(narrow).toHaveLength(1);
    expect(narrow[0].name).toBe("Provider A");
    expect(narrow[0].requests).toBe(1);
    d1.close();
  });

  it("plans indexed hourly, raw boundary and receipt searches at both window widths", async () => {
    const d1 = createRealD1();
    const now = Date.now();
    usageRow(d1, { provider_id: "prov_a", model: "gw-a", cost_usd: 1, latency_ms: 100, created_at: now - 3600_000 });
    const env = makeEnv(d1);
    const seen = recordQueries(env);

    for (const since of [now - 7 * 86400_000, now - 3600_000]) {
      seen.length = 0;
      await statsByProvider(env, since);
      await statsByModel(env, since);
      await statsModelLatency(env, since);
      const reports = seen.filter(s => s.sql.trimStart().startsWith("SELECT COALESCE(") && s.sql.includes("FROM usage_hourly_rollups h WHERE"));
      expect(reports).toHaveLength(3);
      for (const query of reports) {
        expect(query.sql).not.toContain("daily_stats");
        const detail = plan(d1, query.sql, ...query.binds);
        expect(detail).toMatch(/SEARCH h USING INDEX/);
        expect(detail).toMatch(/SEARCH u USING INDEX (?:idx_usage_created_at|idx_usage_rollup_cleanup_page) \(created_at>\?\)/);
        expect(detail).toMatch(/SEARCH r USING INTEGER PRIMARY KEY/);
        expect(detail).not.toMatch(/SCAN (?:h|r)\b/);
        expect(detail).not.toMatch(/SCAN u USING/);
        expect(detail).not.toContain("idx_usage_provider_id");
        expect(detail).not.toContain("idx_usage_model");
      }
    }
    d1.close();
  });

  it("answers the same numbers through either plan", async () => {
    const d1 = createRealD1();
    const now = Date.now();
    usageRow(d1, { provider_id: "prov_a", model: "gw-a", cost_usd: 1, latency_ms: 100, created_at: now - 10 * 86400_000 });
    usageRow(d1, { provider_id: "prov_a", model: "gw-a", cost_usd: 2, latency_ms: 300, status_code: 500, created_at: now - 2_000 });
    usageRow(d1, { provider_id: "prov_b", model: "gw-b", cost_usd: 4, latency_ms: 50, created_at: now - 3_000 });
    const env = makeEnv(d1);

    const wide = (await statsByModel(env, now - 30 * 86400_000)) as any[];
    const narrow = (await statsByModel(env, now - 3600_000)) as any[];
    expect(wide.find((r) => r.name === "gw-a").requests).toBe(2);
    expect(narrow.find((r) => r.name === "gw-a").requests).toBe(1);
    for (const row of narrow) {
      const twin = wide.find((r) => r.name === row.name);
      expect(twin.requests).toBeGreaterThanOrEqual(row.requests);
      expect(twin.cost_usd).toBeGreaterThanOrEqual(row.cost_usd);
    }

    const latency = await statsModelLatency(env, now - 30 * 86400_000);
    expect(latency.map((r) => r.model).sort()).toEqual(["gw-a", "gw-b"]);
    d1.close();
  });
});

describe("the failover health read stays inside its window", () => {
  it("walks the time index rather than the provider index", () => {
    const d1 = createRealD1();
    const text = plan(
      d1,
      "SELECT provider_id, COUNT(*) as attempts, SUM(CASE WHEN status_code >= 400 AND status_code <> 0 THEN 1 ELSE 0 END) as failures FROM usage INDEXED BY idx_usage_created_at WHERE created_at >= ? AND provider_id IS NOT NULL GROUP BY provider_id",
      0
    );
    expect(text).toContain("idx_usage_created_at");
    expect(text).not.toContain("SCAN usage");
    d1.close();
  });

  it("counts errors but never the row a stale-reserve sweep wrote", async () => {
    const d1 = createRealD1();
    const now = Date.now();
    usageRow(d1, { provider_id: "prov_a", cost_usd: 0, status_code: 200, created_at: now - 1_000 });
    usageRow(d1, { provider_id: "prov_a", cost_usd: 0, status_code: 200, created_at: now - 2_000 });
    usageRow(d1, { provider_id: "prov_a", cost_usd: 0, status_code: 500, created_at: now - 3_000 });
    usageRow(d1, { provider_id: "prov_a", cost_usd: 0, status_code: 0, created_at: now - 4_000 });
    const env = makeEnv(d1);

    const stats = await getRecentProviderFailureStats(env, 3600_000);
    expect(stats.prov_a.samples).toBe(4);
    expect(stats.prov_a.failureRate).toBeCloseTo(0.25, 6);
    d1.close();
  });

  it("ignores traffic older than the window", async () => {
    const d1 = createRealD1();
    const now = Date.now();
    usageRow(d1, { provider_id: "prov_old", status_code: 500, created_at: now - 10 * 60_000 });
    usageRow(d1, { provider_id: "prov_now", status_code: 500, created_at: now - 1_000 });
    usageRow(d1, { provider_id: "prov_now", status_code: 200, created_at: now - 2_000 });
    const env = makeEnv(d1);

    const stats = await getRecentProviderFailureStats(env, 300_000);
    expect(stats.prov_old).toBeUndefined();
    expect(stats.prov_now.samples).toBe(2);
    expect(stats.prov_now.failureRate).toBeCloseTo(0.5, 6);
    d1.close();
  });
});

