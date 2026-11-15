
import { resolveModelType } from "./model_type";
import type { BillingUnit, ModelWithProvider, PricingMode, TokenUsage } from "../types";
import { outputTokenLimit } from "./token_fields";

export function resolveRowPricingMode(row: ModelWithProvider): PricingMode {
  const declared = (row as { pricing_mode?: string }).pricing_mode;
  if (declared === "free" || declared === "priced" || declared === "unset") return declared;
  if ((row.input_price_per_m || 0) > 0 || (row.output_price_per_m || 0) > 0) return "priced";
  return "unset";
}


export function resolveRowPeakPricing(row: ModelWithProvider): boolean {
  return Number((row as { peak_pricing_enabled?: number }).peak_pricing_enabled || 0) === 1;
}

export function splitPromptTokens(row: ModelWithProvider, usage: TokenUsage | null): {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
} {
  const inTokens = usage?.input_tokens ?? 0;
  const cacheRead = Math.max(0, usage?.cache_read_tokens ?? 0);
  const cacheWrite = Math.max(0, usage?.cache_write_tokens ?? 0);
  const included = usage?.cache_read_included_in_input !== false;
  const readInsideInput = included ? Math.min(cacheRead, inTokens) : 0;
  return {
    uncachedInput: Math.max(0, inTokens - readInsideInput),
    cacheRead,
    cacheWrite,
  };
}


export function resolveRowBillingUnit(row: ModelWithProvider): BillingUnit {
  return (row as { billing_unit?: string }).billing_unit === "call" ? "call" : "token";
}

export function chatBodyHasImage(body: any): boolean {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && part.type === "image_url") return true;
    }
  }
  return false;
}

export function billableSearchCalls(usage: TokenUsage | null): number {
  const raw = usage?.search_calls ?? 0;
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function searchSurcharge(row: ModelWithProvider, searchCalls: number): number {
  const price = row.search_price_per_call || 0;
  if (price <= 0 || searchCalls <= 0) return 0;
  return searchCalls * price;
}

export function computeCostUsd(
  row: ModelWithProvider,
  usage: TokenUsage | null,
  priceMultiplier = 1,
  billedCalls = 0,
  billedSearches?: number
): number {
  if (resolveRowPricingMode(row) !== "priced") return 0;
  const searches = billedSearches ?? billableSearchCalls(usage);
  const m0 = Number.isFinite(priceMultiplier) && priceMultiplier >= 0 ? priceMultiplier : 1;
  if (resolveRowBillingUnit(row) === "call") {
    const calls = Math.max(0, Math.floor(billedCalls || 0));
    return (m0 * calls * (row.price_per_call || 0) || 0) + searchSurcharge(row, searches);
  }
  const outTokens = usage?.output_tokens ?? 0;
  if (resolveModelType(row) === "embedding") {
    const input = Math.max(0, usage?.input_tokens ?? 0);
    return m0 * input * (row.input_price_per_m || 0) / 1_000_000;
  }
  const { uncachedInput, cacheRead, cacheWrite } = splitPromptTokens(row, usage);
  const inputPrice = row.input_price_per_m || 0;
  const configuredRead = row.cache_read_price_per_m || 0;
  const configuredWrite = row.cache_write_price_per_m || 0;
  return (
    m0 *
      (uncachedInput * inputPrice +
        cacheRead * (configuredRead > 0 ? configuredRead : inputPrice) +
        cacheWrite * (configuredWrite > 0 ? configuredWrite : inputPrice) +
        outTokens * (row.output_price_per_m || 0)) /
      1_000_000
  ) + searchSurcharge(row, searches);
}

export function estimatePromptTokens(body: any, rawBytes?: number): number {
  if (typeof rawBytes === "number" && Number.isFinite(rawBytes) && rawBytes > 0) {
    return Math.max(1, Math.ceil(rawBytes / 4));
  }
  let promptChars = 0;
  try {
    promptChars = JSON.stringify(body?.messages ?? body?.input ?? body ?? {}).length;
  } catch {
    promptChars = 0;
  }
  return Math.max(1, Math.ceil(promptChars / 4));
}

export const MAX_RESERVED_SEARCHES = 20;

export function estimateSearchCalls(body: any): number {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  let calls = 0;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const type = typeof tool.type === "string" ? tool.type : "";
    const kind = type || (typeof tool.name === "string" ? tool.name : "");
    if (!/(^|[_-])web_search|web_search_(preview|[0-9])/.test(kind) && kind !== "web_search") continue;
    const declared = Number(tool.max_uses ?? tool.max_uses_per_call ?? 0);
    const perTool = Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : MAX_RESERVED_SEARCHES;
    calls += Math.min(perTool, MAX_RESERVED_SEARCHES);
  }
  return Math.min(calls, MAX_RESERVED_SEARCHES);
}

export function estimateRequestCostUsd(
  row: ModelWithProvider,
  body: any,
  priceMultiplier = 1,
  rawBytes?: number
): number {
  if (resolveRowPricingMode(row) !== "priced") return 0;
  const m = Number.isFinite(priceMultiplier) && priceMultiplier >= 0 ? priceMultiplier : 1;
  if (resolveRowBillingUnit(row) === "call") {
    return (m * (row.price_per_call || 0) || 0) + searchSurcharge(row, estimateSearchCalls(body));
  }
  if (resolveModelType(row) === "embedding") {
    const inputs = typeof body?.input === "string" ? [body.input] : Array.isArray(body?.input) ? body.input : [];
    const encoder = new TextEncoder();
    const bytes = inputs.reduce((n: number, text: string) => n + encoder.encode(text).byteLength, 0);
    return m * Math.max(1, bytes) * (row.input_price_per_m || 0) / 1_000_000;
  }
  const inTokens = estimatePromptTokens(body, rawBytes);
  const requestedOut = outputTokenLimit(body);
  const outTokens = requestedOut ?? 2048;
  const promptUnitPrice = Math.max(
    row.input_price_per_m || 0,
    row.cache_read_price_per_m || 0,
    row.cache_write_price_per_m || 0
  );
  return (
    (m * (inTokens * promptUnitPrice + outTokens * (row.output_price_per_m || 0))) / 1_000_000 +
    searchSurcharge(row, estimateSearchCalls(body))
  );
}

