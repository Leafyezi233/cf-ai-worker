import { describe, expect, it } from "vitest";
import { consoleApp } from "../src/console";
import { PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES, peakPricingDayKey } from "../src/db/repo";
import { createRealD1 } from "./helpers/realD1";
import {
  DEVICE_ID,
  TOKEN,
  makeEnv,
  seedDevice,
  seedModel,
  seedProvider,
} from "./helpers/realGatewayEnv";


function todayDay(): string {
  return peakPricingDayKey(PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES, Date.now()).day;
}

async function seedBands(d1: ReturnType<typeof createRealD1>, modelId: string, bands: Array<{ day_type: string; start: number; end: number; multiplier: number; enabled?: number }>) {
  for (const [i, b] of bands.entries()) {
    d1.sql(
      "INSERT INTO price_windows (id, model_id, day_type, start_minute, end_minute, multiplier, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      `pw_${modelId}_${i}`,
      modelId,
      b.day_type,
      b.start,
      b.end,
      b.multiplier,
      b.enabled ?? 1,
      1,
      1
    );
  }
}

async function listModels(env: ReturnType<typeof makeEnv>) {
  const res = await consoleApp.fetch(
    new Request("https://gw.test/models", { headers: { authorization: "Bearer " + TOKEN } }),
    env
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  return body;
}

describe("GET /console/models peak pricing", () => {
  it("reports the band in force, the bands themselves and the server timezone", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1);
    const id = seedModel(d1, { peak_pricing_enabled: 1, model_public: 1 });
    await seedBands(d1, id, [{ day_type: todayDay(), start: 0, end: 1440, multiplier: 3 }]);
    const env = makeEnv(d1);
    const body = await listModels(env);

    const model = body.items.find((m: any) => m.id === id);
    expect(model.peak_pricing_enabled).toBe(true);
    expect(model.current_price_multiplier).toBe(3);
    expect(model.current_price_window_id).toBe("pw_" + id + "_0");
    expect(model.price_windows).toHaveLength(1);
    expect(model.price_windows[0]).toMatchObject({ day_type: todayDay(), start_minute: 0, end_minute: 1440, multiplier: 3 });
    expect(typeof body.peak_pricing_tz_offset_minutes).toBe("number");
    d1.close();
  });

  it("says enabled-but-no-band rather than inventing a multiplier", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1);
    const id = seedModel(d1, { peak_pricing_enabled: 1, model_public: 1 });
    await seedBands(d1, id, [{ day_type: "weekday", start: 0, end: 1, multiplier: 0 }]);
    const env = makeEnv(d1);
    const body = await listModels(env);

    const model = body.items.find((m: any) => m.id === id);
    expect(model.peak_pricing_enabled).toBe(true);
    expect(model.price_windows).toHaveLength(1);
    expect(typeof model.current_price_multiplier).toBe("number");
    if (model.current_price_window_id === null) expect(model.current_price_multiplier).toBe(1);
    else expect(model.current_price_multiplier).toBe(0);
    d1.close();
  });

  it("reports nothing when the switch is off, even with bands on disk", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1);
    const id = seedModel(d1, { peak_pricing_enabled: 0, model_public: 1 });
    await seedBands(d1, id, [{ day_type: "weekday", start: 0, end: 1440, multiplier: 5 }]);
    const env = makeEnv(d1);
    const body = await listModels(env);

    const model = body.items.find((m: any) => m.id === id);
    expect(model.peak_pricing_enabled).toBe(false);
    expect(model.current_price_multiplier).toBe(1);
    expect(model.current_price_window_id).toBeNull();
    expect(model.price_windows).toEqual([]);
    d1.close();
  });

  it("stays quiet for a free model, where no multiplier can ever be billed", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1);
    const id = seedModel(d1, { peak_pricing_enabled: 1, pricing_mode: "free", model_public: 1 });
    await seedBands(d1, id, [{ day_type: "weekday", start: 0, end: 1440, multiplier: 3 }]);
    const env = makeEnv(d1);
    const body = await listModels(env);

    const model = body.items.find((m: any) => m.id === id);
    expect(model.peak_pricing_enabled).toBe(false);
    expect(model.current_price_multiplier).toBe(1);
    expect(model.price_windows).toEqual([]);
    d1.close();
  });

  it("resolves bands for every model in one query instead of one query per model", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1);
    const a = seedModel(d1, { id: "m_a", model_name: "gw-a", peak_pricing_enabled: 1, model_public: 1 });
    const b = seedModel(d1, { id: "m_b", model_name: "gw-b", peak_pricing_enabled: 1, model_public: 1 });
    await seedBands(d1, a, [{ day_type: todayDay(), start: 0, end: 1440, multiplier: 2 }]);
    await seedBands(d1, b, [{ day_type: todayDay(), start: 0, end: 1440, multiplier: 4 }]);

    let priceWindowQueries = 0;
    const realPrepare = d1.DB.prepare.bind(d1.DB);
    (d1.DB as any).prepare = (sql: string) => {
      if (sql.includes("FROM price_windows")) priceWindowQueries++;
      return realPrepare(sql);
    };

    const env = makeEnv(d1);
    const body = await listModels(env);

    expect(body.items.find((m: any) => m.id === a).current_price_multiplier).toBe(2);
    expect(body.items.find((m: any) => m.id === b).current_price_multiplier).toBe(4);
    expect(priceWindowQueries).toBe(1);
    d1.close();
  });

  it("hides disabled bands from a device, matching what the proxy will charge", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1);
    const id = seedModel(d1, { peak_pricing_enabled: 1, model_public: 1 });
    await seedBands(d1, id, [
      { day_type: "weekday", start: 0, end: 1440, multiplier: 3, enabled: 0 },
      { day_type: "weekend", start: 0, end: 1440, multiplier: 2 },
    ]);
    const env = makeEnv(d1);
    const body = await listModels(env);

    const model = body.items.find((m: any) => m.id === id);
    expect(model.price_windows).toHaveLength(1);
    expect(model.price_windows[0].day_type).toBe("weekend");
    d1.close();
  });

  it("does not list another model's bands", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1);
    const a = seedModel(d1, { id: "m_a", model_name: "gw-a", peak_pricing_enabled: 1, model_public: 1 });
    const b = seedModel(d1, { id: "m_b", model_name: "gw-b", peak_pricing_enabled: 1, model_public: 1 });
    await seedBands(d1, a, [{ day_type: todayDay(), start: 0, end: 1440, multiplier: 2 }]);
    const env = makeEnv(d1);
    const body = await listModels(env);

    const mb = body.items.find((m: any) => m.id === b);
    expect(mb.price_windows).toEqual([]);
    expect(mb.current_price_window_id).toBeNull();
    d1.close();
  });

  it("still authenticates: no token means no listing and no bands", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1);
    const id = seedModel(d1, { peak_pricing_enabled: 1, model_public: 1 });
    await seedBands(d1, id, [{ day_type: "weekday", start: 0, end: 1440, multiplier: 3 }]);
    const env = makeEnv(d1);
    const res = await consoleApp.fetch(new Request("https://gw.test/models"), env);
    expect(res.status).toBe(401);
    d1.close();
  });
});
