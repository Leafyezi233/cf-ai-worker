import { describe, expect, it } from "vitest";
import { computeCostUsd, estimateRequestCostUsd } from "../src/gateway/proxy";
import type { ModelWithProvider, TokenUsage } from "../src/types";

function model(over: Partial<ModelWithProvider> = {}): ModelWithProvider {
  return {
    id: "m1",
    model_name: "m1",
    display_name: "m1",
    alias: null,
    provider_id: "p1",
    provider_name: "P1",
    provider_api_key: "sk",
    provider_endpoint: "https://x/v1",
    input_price_per_m: 1,
    output_price_per_m: 2,
    cache_enabled: 0,
    cache_ttl: 0,
    fallback_model_id: null,
    enabled: 1,
    model_public: 1,
    pricing_mode: "priced",
    peak_pricing_enabled: 0,
    config_json: null,
    created_at: 1,
    updated_at: 1,
    provider_type: "openai",
    provider_secret_name: null,
    ...over,
  } as ModelWithProvider;
}

const body = { model: "m1", messages: [{ role: "user", content: "hello world" }], max_tokens: 100 };

describe("estimateRequestCostUsd prices the dearest prompt band", () => {
  it("reserves at the cache-write price when it is the most expensive band", () => {
    const row = model({ input_price_per_m: 0.001, cache_write_price_per_m: 1000 });
    const usage: TokenUsage = { input_tokens: 8, output_tokens: 100, total_tokens: 108, cache_write_tokens: 8 };
    const estimate = estimateRequestCostUsd(row, body, 1);
    const worstActual = computeCostUsd(row, usage, 1);
    expect(estimate).toBeGreaterThanOrEqual(worstActual);
    expect(estimate).toBeGreaterThan(0.0001);
  });

  it("reserves at the cache-read price when it is the dearest band", () => {
    const row = model({ input_price_per_m: 0.001, cache_read_price_per_m: 5 });
    const usage: TokenUsage = { input_tokens: 8, output_tokens: 100, total_tokens: 108, cache_read_tokens: 8 };
    expect(estimateRequestCostUsd(row, body, 1)).toBeGreaterThanOrEqual(computeCostUsd(row, usage, 1));
  });

  it("stays at the input price when no cache price is configured", () => {
    const row = model({ input_price_per_m: 3, output_price_per_m: 15 });
    const usage: TokenUsage = { input_tokens: 8, output_tokens: 100, total_tokens: 108, cache_read_tokens: 8 };
    const estimate = estimateRequestCostUsd(row, body, 1);
    expect(estimate).toBeGreaterThanOrEqual(computeCostUsd(row, usage, 1));
    const inTokens = Math.ceil(JSON.stringify(body.messages).length / 4);
    expect(estimate).toBeCloseTo((inTokens * 3 + 100 * 15) / 1_000_000, 12);
  });

  it("applies the peak multiplier to the reserved amount too", () => {
    const row = model({ input_price_per_m: 3, output_price_per_m: 15 });
    const flat = estimateRequestCostUsd(row, body, 1);
    const peak = estimateRequestCostUsd(row, body, 2);
    expect(peak).toBeCloseTo(flat * 2, 12);
  });

  it("reserves nothing for a free model", () => {
    expect(estimateRequestCostUsd(model({ pricing_mode: "free" }), body, 1)).toBe(0);
    expect(estimateRequestCostUsd(model({ pricing_mode: "unset" }), body, 1)).toBe(0);
  });

  it("reserves nothing when every price is zero", () => {
    const row = model({ input_price_per_m: 0, output_price_per_m: 0, cache_read_price_per_m: 0, cache_write_price_per_m: 0 });
    expect(estimateRequestCostUsd(row, body, 1)).toBe(0);
  });
});
