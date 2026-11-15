import { describe, expect, it } from "vitest";
import { computeCacheKey } from "../src/gateway/cache";
import { applyRequestRewriteRules } from "../src/gateway/rewrite";
import { estimateRequestCostUsd } from "../src/gateway/proxy";
import { convertResponsesRequest } from "../src/gateway/responses_adapter";
import { OUTPUT_TOKEN_FIELDS, outputTokenField, outputTokenLimit, setOutputTokenLimit } from "../src/gateway/token_fields";
import type { ModelWithProvider } from "../src/types";


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
    input_price_per_m: 0,
    output_price_per_m: 1000,
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

const prompt = { model: "m1", messages: [{ role: "user", content: "hi" }] };

describe("one helper knows every spelling of the output limit", () => {
  it("reads all three, in a fixed order, and ignores values that mean no limit", () => {
    expect(OUTPUT_TOKEN_FIELDS).toEqual(["max_tokens", "max_completion_tokens", "max_output_tokens"]);
    expect(outputTokenLimit({ max_tokens: 5 })).toBe(5);
    expect(outputTokenLimit({ max_completion_tokens: 6 })).toBe(6);
    expect(outputTokenLimit({ max_output_tokens: 7 })).toBe(7);
    expect(outputTokenLimit({ max_tokens: 5, max_output_tokens: 7 })).toBe(5);
    expect(outputTokenLimit({ max_completion_tokens: 6, max_output_tokens: 7 })).toBe(6);
    expect(outputTokenLimit({ max_tokens: 0 })).toBeUndefined();
    expect(outputTokenLimit({ max_tokens: "" })).toBeUndefined();
    expect(outputTokenLimit({ max_tokens: null })).toBeUndefined();
    expect(outputTokenLimit({ max_tokens: Number.NaN })).toBeUndefined();
    expect(outputTokenLimit({ max_tokens: -4 })).toBeUndefined();
    expect(outputTokenLimit({ max_tokens: true })).toBeUndefined();
    expect(outputTokenLimit({ max_tokens: true, max_output_tokens: 800 })).toBe(800);
    expect(outputTokenLimit(undefined)).toBeUndefined();
  });

  it("writes one spelling and deletes the other two", () => {
    const body: Record<string, any> = { max_completion_tokens: 10 };
    expect(setOutputTokenLimit(body, 99, "max_tokens")).toBe("max_completion_tokens");
    expect(body).toEqual({ max_completion_tokens: 99 });

    const empty: Record<string, any> = {};
    expect(setOutputTokenLimit(empty, 42, "max_tokens")).toBe("max_tokens");
    expect(empty).toEqual({ max_tokens: 42 });

    const oSeries: Record<string, any> = { max_tokens: 10 };
    setOutputTokenLimit(oSeries, 20, "max_completion_tokens");
    expect(oSeries).toEqual({ max_tokens: 20 });
  });

  it("names the spelling a body already uses", () => {
    expect(outputTokenField({ max_output_tokens: 3 })).toBe("max_output_tokens");
    expect(outputTokenField({ max_tokens: null })).toBeUndefined();
    expect(outputTokenField({ max_tokens: null, max_output_tokens: 5 })).toBe("max_output_tokens");
    expect(outputTokenField({})).toBeUndefined();
  });
});

describe("the reserve is sized against the limit whatever its spelling", () => {
  it("holds for max_completion_tokens instead of falling back to 2048", () => {
    const row = model();
    const small = estimateRequestCostUsd(row, { ...prompt, max_completion_tokens: 100 }, 1);
    const large = estimateRequestCostUsd(row, { ...prompt, max_completion_tokens: 100_000 }, 1);
    expect(large).toBeCloseTo(100, 10);
    expect(large).toBeGreaterThan(small * 100);
    expect(estimateRequestCostUsd(row, { ...prompt, max_tokens: 100_000 }, 1)).toBeCloseTo(large, 10);
    expect(estimateRequestCostUsd(row, { ...prompt, max_output_tokens: 100_000 }, 1)).toBeCloseTo(large, 10);
  });

  it("still falls back to 2048 when the caller set no limit at all", () => {
    const row = model();
    const expected = (2048 * 1000) / 1_000_000;
    expect(estimateRequestCostUsd(row, prompt, 1)).toBeCloseTo(expected, 10);
    expect(estimateRequestCostUsd(row, { ...prompt, max_tokens: 0 }, 1)).toBeCloseTo(expected, 10);
  });
});

describe("the cache key moves with the limit, in every spelling", () => {
  it("separates two requests that differ only in max_completion_tokens", async () => {
    const short = await computeCacheKey("chat/completions", "m1", { ...prompt, max_completion_tokens: 16 });
    const long = await computeCacheKey("chat/completions", "m1", { ...prompt, max_completion_tokens: 4096 });
    expect(short).not.toBe(long);
  });

  it("gives the same number the same key under any spelling", async () => {
    const byMaxTokens = await computeCacheKey("chat/completions", "m1", { ...prompt, max_tokens: 512 });
    const byCompletion = await computeCacheKey("chat/completions", "m1", { ...prompt, max_completion_tokens: 512 });
    expect(byMaxTokens).toBe(byCompletion);

    const byOutput = await computeCacheKey("responses", "m1", { ...prompt, max_output_tokens: 512 });
    const byMaxTokensResponses = await computeCacheKey("responses", "m1", { ...prompt, max_tokens: 512 });
    expect(byOutput).toBe(byMaxTokensResponses);
  });

  it("leaves the key of a request with no limit exactly where it was", async () => {
    const none = await computeCacheKey("chat/completions", "m1", prompt);
    const zero = await computeCacheKey("chat/completions", "m1", { ...prompt, max_tokens: 0 });
    expect(none).toBe(zero);
  });
});

describe("an administrator limit reaches every spelling", () => {
  it("clamps max_output_tokens, which /v1/responses callers use", () => {
    const rewritten = applyRequestRewriteRules(
      { model: "gpt-4o", max_output_tokens: 40000, input: "hi" } as any,
      { max_tokens_limit: 500 },
      "openai"
    ) as any;
    expect(rewritten.max_output_tokens).toBe(500);
  });

  it("clamps max_completion_tokens and leaves the spelling alone", () => {
    const rewritten = applyRequestRewriteRules(
      { model: "o3", max_completion_tokens: 40000, messages: [] } as any,
      { max_tokens_limit: 500 },
      "openai"
    ) as any;
    expect(rewritten.max_completion_tokens).toBe(500);
    expect("max_tokens" in rewritten).toBe(false);
  });

  it("does not add a limit where the caller set none", () => {
    const rewritten = applyRequestRewriteRules({ model: "gpt-4o", messages: [] } as any, { max_tokens_limit: 500 }, "openai") as any;
    expect(outputTokenField(rewritten)).toBeUndefined();
  });

  it("replaces the caller spelling on an override instead of adding a second one", () => {
    const rewritten = applyRequestRewriteRules(
      { model: "o3", max_completion_tokens: 100, messages: [] } as any,
      { max_tokens: 2000 },
      "openai"
    ) as any;
    expect(rewritten.max_completion_tokens).toBe(2000);
    expect("max_tokens" in rewritten).toBe(false);
  });
});

describe("the Responses adapter forwards the same number it was billed for", () => {
  it("resolves two spellings the way the helper does", () => {
    const converted = convertResponsesRequest({
      model: "gpt-4o",
      input: "hi",
      max_completion_tokens: 6,
      max_output_tokens: 7,
    });
    expect(converted.max_tokens).toBe(6);
    expect("max_output_tokens" in converted).toBe(false);
    expect("max_completion_tokens" in converted).toBe(false);
  });

  it("routes to max_completion_tokens for models that reject max_tokens", () => {
    const converted = convertResponsesRequest({ model: "o3-mini", input: "hi", max_output_tokens: 900 });
    expect(converted.max_completion_tokens).toBe(900);
    expect("max_tokens" in converted).toBe(false);
  });
});
