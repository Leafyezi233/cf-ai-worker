import { describe, it, expect } from "vitest";
import {
  peakWindowCovers,
  peakPricingDayKey,
  selectPriceWindow,
  PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES,
} from "../src/db/repo";
import type { PriceWindowRow } from "../src/types";
import { PriceWindowsSchema } from "../src/admin/schemas";

function localMs(day: string, hhmm: string, tzOffsetMinutes = PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES): number {
  const [h, m] = hhmm.split(":").map((n) => Number(n));
  const base = Date.UTC(2024, 0, Number(day), h, m);
  return base + tzOffsetMinutes * 60_000;
}

const DAY_OFFSET: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
};

function at(day: string, hhmm: string, tzOffsetMinutes?: number): number {
  const off = tzOffsetMinutes ?? PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES;
  return localMs(String(DAY_OFFSET[day]), hhmm, off);
}

function band(over: Partial<PriceWindowRow>): PriceWindowRow {
  return {
    id: "pw_" + Math.random().toString(36).slice(2, 8),
    model_id: "model_1",
    day_type: "weekday",
    start_minute: 0,
    end_minute: 0,
    multiplier: 1,
    enabled: 1,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const MIN = (h: number, m = 0) => h * 60 + m;

describe("peakWindowCovers", () => {
  it("covers a same-day band inclusively at the start and exclusively at the end", () => {
    expect(peakWindowCovers(MIN(20), MIN(23), MIN(20))).toBe(true);
    expect(peakWindowCovers(MIN(20), MIN(23), MIN(22, 59))).toBe(true);
    expect(peakWindowCovers(MIN(20), MIN(23), MIN(23))).toBe(false);
    expect(peakWindowCovers(MIN(20), MIN(23), MIN(19, 59))).toBe(false);
  });

  it("treats end <= start as wrapping past midnight", () => {
    expect(peakWindowCovers(MIN(22), MIN(2), MIN(23))).toBe(true);
    expect(peakWindowCovers(MIN(22), MIN(2), MIN(1))).toBe(true);
    expect(peakWindowCovers(MIN(22), MIN(2), MIN(2))).toBe(false);
    expect(peakWindowCovers(MIN(22), MIN(2), MIN(12))).toBe(false);
  });

  it("treats a zero-length band as covering nothing", () => {
    expect(peakWindowCovers(MIN(3), MIN(3), MIN(3))).toBe(false);
  });
});

describe("peakPricingDayKey", () => {
  it("maps the UTC instant to the configured timezone wall clock", () => {
    expect(peakPricingDayKey(-480, at("mon", "00:00")).day).toBe("mon");
    expect(peakPricingDayKey(-480, at("mon", "12:00"))).toEqual({ day: "mon", minute: MIN(12) });
  });

  it("pins Saturday 20:00 in UTC+8 to sat 1200", () => {
    expect(peakPricingDayKey(-480, at("sat", "20:00"))).toEqual({ day: "sat", minute: MIN(20) });
  });

  it("moves the day when the timezone is wrong, which is exactly the silent shift to avoid", () => {
    const ms = Date.UTC(2024, 0, 5, 16, 0);
    expect(peakPricingDayKey(0, ms).day).toBe("fri");
    expect(peakPricingDayKey(-480, ms).day).toBe("sat");
    expect(peakPricingDayKey(-480, ms).minute).toBe(MIN(0));
  });
});

describe("selectPriceWindow", () => {
  it("returns null when no band matches", () => {
    expect(selectPriceWindow([band({ start_minute: MIN(9), end_minute: MIN(12) })], "mon", MIN(15))).toBeNull();
  });

  it("ignores disabled bands", () => {
    expect(selectPriceWindow([band({ start_minute: MIN(9), end_minute: MIN(12), enabled: 0 })], "mon", MIN(10))).toBeNull();
  });

  it("matches a weekday group only on Mon-Fri", () => {
    const w = band({ day_type: "weekday", start_minute: MIN(9), end_minute: MIN(18) });
    expect(selectPriceWindow([w], "mon", MIN(10))?.day_type).toBe("weekday");
    expect(selectPriceWindow([w], "fri", MIN(10))?.day_type).toBe("weekday");
    expect(selectPriceWindow([w], "sat", MIN(10))).toBeNull();
  });

  it("matches the weekend group on Saturday and Sunday", () => {
    const w = band({ day_type: "weekend", start_minute: MIN(10), end_minute: MIN(20) });
    expect(selectPriceWindow([w], "sat", MIN(12))).not.toBeNull();
    expect(selectPriceWindow([w], "sun", MIN(12))).not.toBeNull();
    expect(selectPriceWindow([w], "fri", MIN(12))).toBeNull();
  });

  it("lets an exact day beat the group it falls in", () => {
    const broad = band({ day_type: "weekend", start_minute: MIN(0), end_minute: 1440, multiplier: 1.5 });
    const exact = band({ day_type: "sat", start_minute: MIN(0), end_minute: 1440, multiplier: 3 });
    expect(selectPriceWindow([broad, exact], "sat", MIN(12))?.multiplier).toBe(3);
    expect(selectPriceWindow([broad, exact], "sun", MIN(12))?.multiplier).toBe(1.5);
  });

  it("resolves ties at the same specificity by the later start_minute", () => {
    const early = band({ start_minute: MIN(9), end_minute: MIN(18), multiplier: 2 });
    const late = band({ start_minute: MIN(13), end_minute: MIN(15), multiplier: 5 });
    expect(selectPriceWindow([early, late], "mon", MIN(14))?.multiplier).toBe(5);
    expect(selectPriceWindow([late, early], "mon", MIN(14))?.multiplier).toBe(5);
  });

  it("is order-independent", () => {
    const windows = [
      band({ day_type: "mon", start_minute: MIN(9), end_minute: MIN(18), multiplier: 2 }),
      band({ day_type: "weekday", start_minute: MIN(0), end_minute: 0, multiplier: 1.2 }),
      band({ day_type: "mon", start_minute: MIN(13), end_minute: MIN(14), multiplier: 9 }),
    ];
    const a = selectPriceWindow(windows, "mon", MIN(13, 30));
    const b = selectPriceWindow([...windows].reverse(), "mon", MIN(13, 30));
    expect(a?.id).toBe(b?.id);
    expect(a?.multiplier).toBe(9);
  });

  it("returns the base rate when nothing overlaps, including multiplier 0 bands being explicit", () => {
    const free = band({ start_minute: MIN(9), end_minute: MIN(10), multiplier: 0 });
    expect(selectPriceWindow([free], "mon", MIN(11))).toBeNull();
    expect(selectPriceWindow([free], "mon", MIN(9, 30))?.multiplier).toBe(0);
  });
});

describe("PriceWindowsSchema", () => {
  const ok = (w: Record<string, unknown>) => PriceWindowsSchema.safeParse({ windows: [w] }).success;
  const band = (over: Record<string, unknown> = {}) =>
    ({ day_type: "sat", start: "09:00", end: "10:00", multiplier: 2, ...over });

  it("accepts a well-formed band", () => {
    expect(ok(band())).toBe(true);
  });

  it("requires a zero-padded HH:MM, so an unpadded clock is rejected rather than guessed", () => {
    expect(ok(band({ start: "9:00" }))).toBe(false);
    expect(ok(band({ end: "10:0" }))).toBe(false);
  });

  it("rejects impossible clock values", () => {
    expect(ok(band({ start: "24:00" }))).toBe(false);
    expect(ok(band({ end: "09:60" }))).toBe(false);
  });

  it("bounds the multiplier", () => {
    expect(ok(band({ multiplier: -1 }))).toBe(false);
    expect(ok(band({ multiplier: 1001 }))).toBe(false);
    expect(ok(band({ multiplier: 0 }))).toBe(true);
    expect(ok(band({ multiplier: 1000 }))).toBe(true);
  });

  it("rejects an unknown day_type and requires the windows array", () => {
    expect(ok(band({ day_type: "funday" }))).toBe(false);
    expect(PriceWindowsSchema.safeParse({}).success).toBe(false);
    expect(PriceWindowsSchema.safeParse({ windows: [] }).success).toBe(true);
  });

  it("accepts a band that crosses midnight, and caps the set at 200", () => {
    expect(ok(band({ start: "23:00", end: "02:00" }))).toBe(true);
    const many = Array.from({ length: 200 }, () => band());
    expect(PriceWindowsSchema.safeParse({ windows: many }).success).toBe(true);
    expect(PriceWindowsSchema.safeParse({ windows: [...many, band()] }).success).toBe(false);
  });
});
