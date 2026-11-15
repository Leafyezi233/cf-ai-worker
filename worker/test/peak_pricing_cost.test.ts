import { describe, it, expect } from "vitest";
import { computeCostUsd, estimateRequestCostUsd } from "../src/gateway/proxy";
import type { ModelWithProvider } from "../src/types";

function model(over: Partial<ModelWithProvider> = {}): ModelWithProvider {
  return {
    id: "model_1",
    provider_id: "prov_1",
    provider_name: "P",
    provider_type: "openai",
    provider_api_key: null,
    provider_secret_name: null,
    provider_endpoint: null,
    model_name: "m",
    display_name: null,
    alias: null,
    fallback_model_id: null,
    input_price_per_m: 3,
    output_price_per_m: 15,
    cache_enabled: 0,
    cache_ttl: 3600,
    model_public: 0,
    pricing_mode: "priced",
    peak_pricing_enabled: 0,
    enabled: 1,
    config_json: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  } as ModelWithProvider;
}

const USAGE = { input_tokens: 1000000, output_tokens: 0, total_tokens: 1000000 };

describe("computeCostUsd with a peak multiplier", () => {
  it("scales the base price by the multiplier", () => {
    expect(computeCostUsd(model(), USAGE, 1)).toBeCloseTo(3, 10);
    expect(computeCostUsd(model(), USAGE, 2)).toBeCloseTo(6, 10);
    expect(computeCostUsd(model(), USAGE, 0.5)).toBeCloseTo(1.5, 10);
  });

  it("defaults to the base rate when no band matched", () => {
    expect(computeCostUsd(model(), USAGE)).toBeCloseTo(3, 10);
  });

  it("ignores the multiplier for unset and free models, which never bill", () => {
    expect(computeCostUsd(model({ pricing_mode: "unset" }), USAGE, 5)).toBe(0);
    expect(computeCostUsd(model({ pricing_mode: "free" }), USAGE, 5)).toBe(0);
  });

  it("falls back to 1 for a nonsensical multiplier rather than billing garbage", () => {
    expect(computeCostUsd(model(), USAGE, NaN)).toBeCloseTo(3, 10);
    expect(computeCostUsd(model(), USAGE, -1)).toBeCloseTo(3, 10);
    expect(computeCostUsd(model(), USAGE, Infinity)).toBeCloseTo(3, 10);
  });

  it("honours a zero multiplier, which is how a band makes a priced model free", () => {
    expect(computeCostUsd(model(), USAGE, 0)).toBe(0);
  });

  it("returns 0 without usage", () => {
    expect(computeCostUsd(model(), null, 2)).toBe(0);
  });
});

describe("estimateRequestCostUsd with a peak multiplier", () => {
  const body = { messages: [{ role: "user", content: "hello" }], max_tokens: 1000 };

  it("scales the reservation estimate, so pre-auth covers the peak price", () => {
    const offPeak = estimateRequestCostUsd(model(), body, 1);
    const peak = estimateRequestCostUsd(model(), body, 3);
    expect(peak).toBeCloseTo(offPeak * 3, 10);
  });

  it("reserves more in a peak band than off-peak for the same request", () => {
    expect(estimateRequestCostUsd(model(), body, 4)).toBeGreaterThan(estimateRequestCostUsd(model(), body, 1));
  });

  it("estimates 0 for models that never bill", () => {
    expect(estimateRequestCostUsd(model({ pricing_mode: "unset" }), body, 3)).toBe(0);
    expect(estimateRequestCostUsd(model({ pricing_mode: "free" }), body, 3)).toBe(0);
  });

  it("scales the reserve and the settle by the same factor, so the hold stays proportional", () => {
    const body = { messages: [{ role: "user", content: "hello world" }], max_tokens: 1000 };
    const settle = (m: number) => computeCostUsd(model(), { input_tokens: 13, output_tokens: 1000, total_tokens: 1013 }, m);
    const reserve = (m: number) => estimateRequestCostUsd(model(), body, m);
    expect(reserve(3) / reserve(1)).toBeCloseTo(3, 10);
    expect(settle(3) / settle(1)).toBeCloseTo(3, 10);
    expect(reserve(2) / settle(2)).toBeCloseTo(reserve(1) / settle(1), 10);
  });
});
