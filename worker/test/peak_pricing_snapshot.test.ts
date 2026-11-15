import { describe, expect, it } from "vitest";
import { initializedSchemaDouble } from "./helpers/initializedSchemaDouble";
import { replacePriceWindows, resolvePriceSnapshot, PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES } from "../src/db/repo";
import { MIGRATION_ALTERS, INIT_STATEMENTS } from "../src/db/schema";
import type { Env, PriceWindowRow } from "../src/types";

function makeEnv(seed: PriceWindowRow[][] = []) {
  const byModel = new Map<string, PriceWindowRow[]>();
  const deletes: string[] = [];
  const inserts: { modelId: string; row: PriceWindowRow }[] = [];
  seed.forEach((rows, i) => byModel.set("model_" + i, rows.map((r) => ({ ...r }))));
  let nextId = 1;

  const run = (sql: string, a: unknown[]) => {
    if (sql.startsWith("DELETE FROM price_windows")) {
      deletes.push(String(a[0]));
      byModel.delete(String(a[0]));
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO price_windows")) {
      const [id, modelId, dayType, startMinute, endMinute, multiplier, enabled, createdAt, updatedAt] = a as [
        string,
        string,
        string,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      const row: PriceWindowRow = {
        id,
        model_id: modelId,
        day_type: dayType,
        start_minute: startMinute,
        end_minute: endMinute,
        multiplier,
        enabled,
        created_at: createdAt,
        updated_at: updatedAt,
      };
      const list = byModel.get(modelId) ?? [];
      list.push(row);
      byModel.set(modelId, list);
      inserts.push({ modelId, row });
      return { meta: { changes: 1 } };
    }
    throw new Error("unexpected statement: " + sql);
  };

  const all = (sql: string, a: unknown[]) => {
    if (sql.includes("FROM price_windows")) {
      return { results: byModel.get(String(a[0])) ?? [] };
    }
    throw new Error("unexpected all() query: " + sql);
  };

  const stmt = (sql: string) => {
    let binds: unknown[] = [];
    const self = {
      sql,
      bind: (...args: unknown[]) => {
        binds = args;
        return self;
      },
      run: () => run(sql, binds),
      all: () => all(sql, binds),
      first: () => null,
    };
    return self;
  };

  const db = { prepare: (sql: string) => stmt(sql), batch: () => undefined } as unknown as Env["DB"];
  return {
    env: { DB: initializedSchemaDouble(db), ASSETS: null, RATE_LIMITER: null } as unknown as Env,
    inserts,
    deletes,
    nextId: () => nextId++,
  };
}

function band(over: Partial<PriceWindowRow> = {}): PriceWindowRow {
  return {
    id: "pw_seed",
    model_id: "model_0",
    day_type: "sat",
    start_minute: 20 * 60,
    end_minute: 23 * 60,
    multiplier: 3,
    enabled: 1,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const MON_AFTERNOON_MS = Date.UTC(2024, 0, 1, 6, 0);
const SAT_PEAK_MS = Date.UTC(2024, 0, 6, 12, 0);
describe("resolvePriceSnapshot", () => {
  it("returns the base rate when the model has peak pricing switched off", async () => {
    const { env } = makeEnv([[band({ multiplier: 5 })]]);
    expect(await resolvePriceSnapshot(env, "model_0", false, SAT_PEAK_MS)).toEqual({ multiplier: 1, window_id: null });
  });

  it("returns the base rate when the model has no bands configured", async () => {
    const { env } = makeEnv([]);
    expect(await resolvePriceSnapshot(env, "model_9", true, SAT_PEAK_MS)).toEqual({ multiplier: 1, window_id: null });
  });

  it("returns the base rate when the current instant misses every band", async () => {
    const { env } = makeEnv([[band({ start_minute: 20 * 60, end_minute: 23 * 60 })]]);
    expect(await resolvePriceSnapshot(env, "model_0", true, MON_AFTERNOON_MS)).toEqual({ multiplier: 1, window_id: null });
  });

  it("returns the band multiplier and its id when the instant is inside a band", async () => {
    const { env } = makeEnv([[band({ id: "pw_evening" })]]);
    expect(await resolvePriceSnapshot(env, "model_0", true, SAT_PEAK_MS)).toEqual({ multiplier: 3, window_id: "pw_evening" });
  });

  it("never reads another model's bands", async () => {
    const { env } = makeEnv([[band({ id: "pw_model_0" })], [band({ id: "pw_model_1", multiplier: 9 })]]);
    expect((await resolvePriceSnapshot(env, "model_1", true, SAT_PEAK_MS)).window_id).toBe("pw_model_1");
    expect((await resolvePriceSnapshot(env, "model_0", true, SAT_PEAK_MS)).window_id).toBe("pw_model_0");
    expect(await resolvePriceSnapshot(env, "model_2", true, SAT_PEAK_MS)).toEqual({ multiplier: 1, window_id: null });
  });

  it("returns the same snapshot for the same instant, so a crossing request cannot straddle two rates", async () => {
    const { env } = makeEnv([[band({ id: "pw_1", multiplier: 2, start_minute: 0, end_minute: 1440 })]]);
    const first = await resolvePriceSnapshot(env, "model_0", true, SAT_PEAK_MS);
    const second = await resolvePriceSnapshot(env, "model_0", true, SAT_PEAK_MS);
    expect(second).toEqual(first);
  });

  it("honours an explicit timezone instead of the default", async () => {
    const { env } = makeEnv([[band({ start_minute: 0, end_minute: 1440 })]]);
    expect((await resolvePriceSnapshot(env, "model_0", true, SAT_PEAK_MS, 0)).multiplier).toBe(3);
    expect(PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES).toBe(-480);
  });

  it("returns 0 for an explicit zero-multiplier band", async () => {
    const { env } = makeEnv([[band({ multiplier: 0 })]]);
    expect(await resolvePriceSnapshot(env, "model_0", true, SAT_PEAK_MS)).toEqual({ multiplier: 0, window_id: "pw_seed" });
  });
});

describe("replacePriceWindows", () => {
  it("replaces the whole set instead of merging, so a deleted band really disappears", async () => {
    const { env, deletes, inserts } = makeEnv([[band({ id: "pw_old" })]]);
    const items = await replacePriceWindows(env, "model_0", [
      { day_type: "sat", start_minute: 20 * 60, end_minute: 22 * 60, multiplier: 4 },
    ]);
    expect(deletes).toEqual(["model_0"]);
    expect(inserts).toHaveLength(1);
    expect(items.map((i) => i.day_type)).toEqual(["sat"]);
    expect(items[0].multiplier).toBe(4);
    expect(items[0].start_minute).toBe(20 * 60);
  });

  it("clears every band when an empty list is saved", async () => {
    const { env, deletes } = makeEnv([[band()]]);
    expect(await replacePriceWindows(env, "model_0", [])).toEqual([]);
    expect(deletes).toEqual(["model_0"]);
  });

  it("gives every band a distinct id so usage rows can point at the one that billed them", async () => {
    const { env, inserts } = makeEnv([]);
    await replacePriceWindows(env, "model_0", [
      { day_type: "mon", start_minute: 0, end_minute: 60, multiplier: 2 },
      { day_type: "mon", start_minute: 60, end_minute: 120, multiplier: 3 },
    ]);
    expect(new Set(inserts.map((i) => i.row.id)).size).toBe(2);
    expect(inserts.every((i) => i.row.id.startsWith("pw_"))).toBe(true);
  });

  it("only touches the requested model", async () => {
    const { env, deletes } = makeEnv([[band({ model_id: "model_0" })], [band({ model_id: "model_1", id: "pw_other" })]]);
    await replacePriceWindows(env, "model_1", [{ day_type: "mon", start_minute: 0, end_minute: 60, multiplier: 2 }]);
    expect(deletes).toEqual(["model_1"]);
    expect((await resolvePriceSnapshot(env, "model_0", true, SAT_PEAK_MS)).window_id).toBe("pw_seed");
  });
});

describe("price_windows schema", () => {
  it("is created on a fresh database", () => {
    expect(INIT_STATEMENTS.some((s) => s.includes("CREATE TABLE IF NOT EXISTS price_windows"))).toBe(true);
    expect(INIT_STATEMENTS.some((s) => s.includes("idx_price_windows_model"))).toBe(true);
  });

  it("backfills the usage snapshot columns for an existing database", () => {
    expect(MIGRATION_ALTERS.some((s) => s.includes("ALTER TABLE usage ADD COLUMN price_multiplier"))).toBe(true);
    expect(MIGRATION_ALTERS.some((s) => s.includes("ALTER TABLE usage ADD COLUMN price_window_id"))).toBe(true);
    expect(MIGRATION_ALTERS.some((s) => s.includes("ALTER TABLE models ADD COLUMN peak_pricing_enabled"))).toBe(true);
  });
});
