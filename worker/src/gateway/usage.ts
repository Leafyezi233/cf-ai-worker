import type { ProviderType, TokenUsage } from "../types";

function pushUsageBlocks(blocks: Array<Record<string, any>>, obj: Record<string, any>) {
  if (obj.usage) blocks.push(obj.usage);
  if (obj.usageMetadata) blocks.push(obj.usageMetadata);
  if (obj.message && obj.message.usage) blocks.push(obj.message.usage);
  if (obj.response && obj.response.usage) blocks.push(obj.response.usage);
}

function extractUsageBlocks(text: string, jsonFallback = true): Array<Record<string, any>> {
  const blocks: Array<Record<string, any>> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("usage")) continue;
    const m = line.match(/^data:\s*(.*)$/);
    if (!m) continue;
    const payload = m[1].trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      if (obj) pushUsageBlocks(blocks, obj);
    } catch {
    }
  }
  if (blocks.length === 0 && jsonFallback) {
    try {
      const obj = JSON.parse(text);
      if (obj) pushUsageBlocks(blocks, obj);
    } catch {
    }
  }
  return blocks;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function anthropicCacheTokens(b: Record<string, any>): { read: number; write: number } {
  const creation = b.cache_creation && typeof b.cache_creation === 'object' ? b.cache_creation : {};
  const flat = num(b.cache_creation_input_tokens);
  const buckets = num(creation.ephemeral_5m_input_tokens) + num(creation.ephemeral_1h_input_tokens);
  return { read: num(b.cache_read_input_tokens), write: flat > 0 ? flat : buckets };
}

function openaiCacheRead(b: Record<string, any>): number {
  const details = b.prompt_tokens_details && typeof b.prompt_tokens_details === 'object' ? b.prompt_tokens_details : {};
  const inputDetails = b.input_tokens_details && typeof b.input_tokens_details === 'object' ? b.input_tokens_details : {};
  return Math.max(
    num(b.cached_tokens),
    num(details.cached_tokens),
    num(inputDetails.cached_tokens),
    num(b.cachedContentTokenCount)
  );
}

function thinkingTokens(b: Record<string, any>, providerType: ProviderType): number {
  const completion = b.completion_tokens_details && typeof b.completion_tokens_details === 'object' ? b.completion_tokens_details : {};
  const output = b.output_tokens_details && typeof b.output_tokens_details === 'object' ? b.output_tokens_details : {};
  if (providerType === 'anthropic') return num(output.thinking_tokens);
  return Math.max(num(completion.reasoning_tokens), num(output.reasoning_tokens));
}

function webSearchCalls(b: Record<string, any>, providerType: ProviderType): number {
  if (providerType !== 'anthropic') return 0;
  const toolUse = b.server_tool_use && typeof b.server_tool_use === 'object' ? b.server_tool_use : {};
  return num(toolUse.web_search_requests);
}

export function parseUsage(providerType: ProviderType, bodyText: string): TokenUsage | null {
  return parseUsageBlocks(providerType, extractUsageBlocks(bodyText));
}

export function parseJsonUsage(providerType: ProviderType, value: any): TokenUsage | null {
  const blocks: Array<Record<string, any>> = [];
  if (value) pushUsageBlocks(blocks, value);
  return parseUsageBlocks(providerType, blocks);
}

export function parseSseUsage(providerType: ProviderType, text: string): TokenUsage | null {
  return parseUsageBlocks(providerType, extractUsageBlocks(text, false));
}

export function parseUsageBlocks(providerType: ProviderType, blocks: Array<Record<string, any>>): TokenUsage | null {
  if (blocks.length === 0) return null;
  let input = 0;
  let output = 0;
  let total = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let searches = 0;
  for (const b of blocks) {
    const inTokens =
      providerType === 'anthropic'
        ? num(b.input_tokens)
        : Math.max(
            num(b.input_tokens),
            num(b.prompt_tokens ?? b.promptTokens ?? b.promptTokenCount ?? b.prompt_token_count)
          );
    const outTokens =
      providerType === 'anthropic'
        ? num(b.output_tokens)
        : Math.max(
            num(b.output_tokens),
            num(b.completion_tokens ?? b.completionTokens ?? b.candidatesTokenCount ?? b.candidates_token_count)
          );
    if (inTokens > 0) input = Math.max(input, inTokens);
    if (outTokens > 0) output = Math.max(output, outTokens);
    const totTokens = num(b.total_tokens ?? b.totalTokens ?? b.totalTokenCount ?? b.total_token_count);
    const cache =
      providerType === 'anthropic'
        ? anthropicCacheTokens(b)
        : { read: openaiCacheRead(b), write: 0 };
    if (cache.read > 0) cacheRead = Math.max(cacheRead, cache.read);
    if (cache.write > 0) cacheWrite = Math.max(cacheWrite, cache.write);
    const think = thinkingTokens(b, providerType);
    if (think > 0) reasoning = Math.max(reasoning, think);
    const searches_here = webSearchCalls(b, providerType);
    if (searches_here > 0) searches = Math.max(searches, searches_here);
    const cacheOutsideInput = providerType === 'anthropic' ? cacheRead + cacheWrite : 0;
    total = Math.max(total, totTokens, input + output + cacheOutsideInput);
  }
  if (input === 0 && output === 0 && total === 0) return null;
  const usage: TokenUsage = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total > 0 ? total : input + output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cache_read_included_in_input: providerType !== 'anthropic',
  };
  if (reasoning > 0) usage.reasoning_tokens = reasoning;
  if (searches > 0) usage.search_calls = searches;
  return usage;
}
