import { expect, it, vi } from "vitest";
import { parseUsage, parseJsonUsage } from "../src/gateway/usage";
import type { ProviderType } from "../src/types";

const fixtures: unknown[] = [
  null,
  {},
  [],
  { usage: {} },
  { usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30,
    prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 4 } } },
  { response: { usage: { input_tokens: 5, output_tokens: 9,
    input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } } } },
  { message: { usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4,
    cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 6 },
    server_tool_use: { web_search_requests: 2 } } } },
  { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, cachedContentTokenCount: 3 } },
  { usage: { prompt_tokens: -1, completion_tokens: "20", total_tokens: null } },
  { usage: { input_tokens: 5, output_tokens: 8 }, response: { usage: { input_tokens: 9, output_tokens: 3 } } },
];

it.each(["openai", "anthropic", "gemini"] as ProviderType[])(
  "matches string parser and never parses or serializes for %s", provider => {
    for (const value of fixtures) {
      const encoded = JSON.stringify(value);
      const object = JSON.parse(encoded);
      const expected = parseUsage(provider, encoded);
      const parse = vi.spyOn(JSON, "parse");
      const stringify = vi.spyOn(JSON, "stringify");
      try {
        expect(parseJsonUsage(provider, object)).toEqual(expected);
        expect(parse).not.toHaveBeenCalled();
        expect(stringify).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
        stringify.mockRestore();
      }
      expect(object).toEqual(value);
    }
  }
);
