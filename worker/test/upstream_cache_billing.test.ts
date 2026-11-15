import { describe, expect, it } from "vitest";
import { parseUsage } from "../src/gateway/usage";
import { computeCostUsd, splitPromptTokens } from "../src/gateway/proxy";
import type { ModelWithProvider, TokenUsage } from "../src/types";

function pricedRow(over: Partial<ModelWithProvider> = {}): ModelWithProvider {
  return {
    id: "model_a",
    model_name: "m",
    provider_id: "prov_a",
    input_price_per_m: 3,
    output_price_per_m: 15,
    cache_read_price_per_m: 0.3,
    cache_write_price_per_m: 3.75,
    pricing_mode: "priced",
    provider_type: "anthropic",
    ...over,
  } as unknown as ModelWithProvider;
}

describe("parseUsage: upstream prompt-cache token extraction", () => {
  it("reads Anthropic cache_read_input_tokens and leaves input_tokens alone", () => {
    const body = JSON.stringify({ usage: { input_tokens: 30, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } });
    const u = parseUsage("anthropic", body)!;
    expect(u.input_tokens).toBe(30);
    expect(u.cache_read_tokens).toBe(900);
    expect(u.cache_write_tokens).toBe(0);
    expect(u.total_tokens).toBe(935);
  });

  it("splits Anthropic nested cache_creation into ephemeral 5m and 1h buckets", () => {
    const body = JSON.stringify({ usage: { input_tokens: 10, output_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 100 } } });
    const u = parseUsage("anthropic", body)!;
    expect(u.cache_write_tokens).toBe(500);
    expect(u.cache_read_tokens).toBe(0);
  });

  it("reads OpenAI prompt_tokens_details.cached_tokens", () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 800 } } });
    const u = parseUsage("openai", body)!;
    expect(u.input_tokens).toBe(1000);
    expect(u.cache_read_tokens).toBe(800);
    expect(u.total_tokens).toBe(1020);
  });

  it("falls back to the sibling cached_tokens / cachedContentTokenCount keys", () => {
    expect(parseUsage("openai", JSON.stringify({ usage: { prompt_tokens: 5, cached_tokens: 4 } }))!.cache_read_tokens).toBe(4);
    expect(parseUsage("gemini", JSON.stringify({ usageMetadata: { promptTokenCount: 5, cachedContentTokenCount: 3 } }))!.cache_read_tokens).toBe(3);
  });

  it("reports zero cache tokens when the provider sends none", () => {
    const u = parseUsage("anthropic", JSON.stringify({ usage: { input_tokens: 7, output_tokens: 3 } }))!;
    expect(u.cache_read_tokens).toBe(0);
    expect(u.cache_write_tokens).toBe(0);
  });
});

describe("splitPromptTokens", () => {
  it("does not double-bill Anthropic, where cached tokens sit outside input_tokens", () => {
    const usage: TokenUsage = { input_tokens: 30, output_tokens: 5, total_tokens: 935, cache_read_tokens: 900, cache_read_included_in_input: false };
    const split = splitPromptTokens(pricedRow(), usage);
    expect(split).toEqual({ uncachedInput: 30, cacheRead: 900, cacheWrite: 0 });
  });

  it("peels the cached slice out of input_tokens for OpenAI-style shapes", () => {
    const usage: TokenUsage = { input_tokens: 1000, output_tokens: 20, total_tokens: 1020, cache_read_tokens: 800, cache_read_included_in_input: true };
    expect(splitPromptTokens(pricedRow(), usage)).toEqual({ uncachedInput: 200, cacheRead: 800, cacheWrite: 0 });
    expect(splitPromptTokens(pricedRow(), { input_tokens: 1000, output_tokens: 0, total_tokens: 1020, cache_read_tokens: 800 }).uncachedInput).toBe(200);
  });

  it("never reports negative uncached input when the cache count exceeds input", () => {
    const usage: TokenUsage = { input_tokens: 10, output_tokens: 1, total_tokens: 11, cache_read_tokens: 99 };
    expect(splitPromptTokens(pricedRow(), usage).uncachedInput).toBe(0);
  });
});

describe("computeCostUsd with upstream cache prices", () => {
  it("bills each bucket at its own price", () => {
    const usage: TokenUsage = { input_tokens: 1000, output_tokens: 1000, total_tokens: 2000, cache_read_tokens: 500, cache_write_tokens: 200 };
    expect(computeCostUsd(pricedRow(), usage)).toBeCloseTo(0.0174, 9);
  });

  it("falls back to the plain input price when no cache price is configured", () => {
    const row = pricedRow({ cache_read_price_per_m: undefined, cache_write_price_per_m: 0 });
    const usage: TokenUsage = { input_tokens: 1000, output_tokens: 0, total_tokens: 1500, cache_read_tokens: 500 };
    expect(computeCostUsd(row, usage)).toBeCloseTo(0.003, 9);
  });

  it("still multiplies the whole cache-inclusive total by the peak band", () => {
    const usage: TokenUsage = { input_tokens: 1000, output_tokens: 1000, total_tokens: 2000, cache_read_tokens: 500, cache_write_tokens: 200 };
    expect(computeCostUsd(pricedRow(), usage, 2)).toBeCloseTo(computeCostUsd(pricedRow(), usage) * 2, 12);
  });

  it("returns 0 for an unpriced model regardless of cache traffic", () => {
    const usage: TokenUsage = { input_tokens: 10, output_tokens: 10, total_tokens: 1020, cache_read_tokens: 1000 };
    expect(computeCostUsd(pricedRow({ pricing_mode: "free" }), usage)).toBe(0);
  });

  it("leaves cache-free usage at exactly the pre-existing price", () => {
    const row = pricedRow();
    const usage: TokenUsage = { input_tokens: 1000, output_tokens: 1000, total_tokens: 2000 };
    expect(computeCostUsd(row, usage)).toBeCloseTo((3 + 15) / 1000, 9);
  });
});
