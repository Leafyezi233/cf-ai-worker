import { beforeEach, describe, expect, it } from "vitest";
import { consoleApp } from "../src/console";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { TOKEN, makeEnv, seedDevice } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";

const DELAY_MS = 5;

interface Caught {
  sql: string;
  binds: unknown[];
}

function probeEnv(d1: RealD1): { env: Env; caught: Caught[]; events: string[]; peak: () => number } {
  const caught: Caught[] = [];
  const events: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const usage = (sql: string) => /\bFROM usage\b/.test(sql) && sql.includes("WHERE device_id = ?");
  const enter = (sql: string) => {
    if (!usage(sql)) return;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
  };
  const leave = (sql: string) => {
    if (usage(sql)) inFlight -= 1;
  };
  const DB = {
    prepare(sql: string) {
      const statement = d1.DB.prepare(sql);
      const run = async <T>(call: () => Promise<T>): Promise<T> => {
        if (sql.startsWith("SELECT hour_start FROM usage_rollup_archived_hours")) events.push("archive");
        if (usage(sql)) events.push("report");
        enter(sql);
        try {
          if (usage(sql)) await new Promise((r) => setTimeout(r, DELAY_MS));
          return await call();
        } finally {
          leave(sql);
        }
      };
      return {
        sql,
        bind(...binds: unknown[]) {
          if (usage(sql)) caught.push({ sql, binds });
          statement.bind(...binds);
          return this;
        },
        first: () => run(() => statement.first()),
        all: () => run(() => statement.all()),
        run: () => run(() => statement.run()),
      };
    },
    batch: (statements: any[]) => d1.DB.batch(statements),
  };
  const env = { ...makeEnv(d1), DB, SESSION_SECRET: "console-session-secret" } as unknown as Env;
  return { env, caught, events, peak: () => peak };
}

function usageReq(extra = ""): Request {
  const from = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 7 * 86_400_000 + 123;
  return new Request(`https://gateway.example.com/usage?from=${from}&limit=5` + extra, {
    headers: { Authorization: "Bearer " + TOKEN },
  });
}
describe("/console/usage issues its four reads together", () => {
  beforeEach(() => {
    resetRateLimitMemory();
  });

  it("has all four statements in flight at the same time", async () => {
    const d1 = createRealD1();
    await seedDevice(d1);
    const { env, caught, events, peak } = probeEnv(d1);

    const res = await consoleApp.fetch(usageReq(), env);
    expect(res.status).toBe(200);
    expect(peak()).toBe(4);
    expect(caught).toHaveLength(4);
    expect(events).toEqual(["archive", "report", "report", "report", "report", "archive"]);
  });

  it("keeps the daily timezone in SQL and source binds before the device", async () => {
    const d1 = createRealD1();
    await seedDevice(d1);
    const { env, caught } = probeEnv(d1);

    const res = await consoleApp.fetch(usageReq(), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { range: { from: number } };

    const daily = caught.find((c) => c.sql.includes("strftime"));
    expect(daily).toBeDefined();
    expect(daily!.sql).toContain("strftime('%Y-%m-%d',created_at/1000,'unixepoch','+480 minutes')");
    const start = Math.ceil(body.range.from / 3_600_000) * 3_600_000;
    expect(daily!.binds).toEqual([start, body.range.from, start, "dev_1"]);
  });

  it("keeps limit and offset as the last binds of the rows query", async () => {
    const d1 = createRealD1();
    await seedDevice(d1);
    const { env, caught } = probeEnv(d1);

    await consoleApp.fetch(usageReq(), env);

    const rows = caught.find((c) => c.sql.includes("LIMIT ?"));
    expect(rows).toBeDefined();
    const binds = rows!.binds;
    expect(binds[binds.length - 2]).toBe(5);
    expect(binds[binds.length - 1]).toBe(0);
    expect(binds[0]).toBe("dev_1");
  });

  it("adds the sub-token filter to all four reads when it is asked for", async () => {
    const d1 = createRealD1();
    await seedDevice(d1);
    const { env, caught } = probeEnv(d1);

    await consoleApp.fetch(usageReq("&sub_token_id=sub_1"), env);

    expect(caught).toHaveLength(4);
    for (const c of caught) {
      expect(c.sql).toContain("sub_token_id = ?");
      expect(c.binds).toContain("sub_1");
    }
  });

  it("still returns all four sections of the answer", async () => {
    const d1 = createRealD1();
    await seedDevice(d1);
    const now = Date.now();
    d1.sql(
      "INSERT INTO usage (device_id, provider_id, provider_name, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit, pricing_missing, price_multiplier, status_code, created_at) VALUES (?, ?, ?, ?, 10, 20, 30, ?, 0, 0, 1, 200, ?)",
      "dev_1", "prov_a", "Provider A", "gw-primary", 0.5, now
    );
    const { env } = probeEnv(d1);

    const res = await consoleApp.fetch(usageReq(), env);
    const body = (await res.json()) as any;

    expect(body.summary.request_count).toBe(1);
    expect(body.summary.cost_usd).toBeCloseTo(0.5, 6);
    expect(body.by_model).toHaveLength(1);
    expect(body.by_model[0].model).toBe("gw-primary");
    expect(body.daily).toHaveLength(1);
    expect(body.items).toHaveLength(1);
    expect(body.page).toEqual({ limit: 5, offset: 0 });
    expect(body.sub_token_id).toBeNull();
  });
});
