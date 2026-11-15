import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareJsonResponse } from "../src/gateway/json_response";
import { maskJsonText } from "../src/gateway/caller_identity";
import { createChatReasoningState, mayNeedChatNormalisation, normalizeChatCompletion } from "../src/gateway/thinking_sse";
import { parseJsonUsage, parseUsage } from "../src/gateway/usage";
import { UsageAccumulator } from "../src/gateway/usage_accumulator";
import { gatewayApp } from "../src/gateway";
import { ensureSchema } from "../src/db/schema";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { CollectingExecutionContext, TOKEN, createRealD1, makeEnv, makeKv, seedDevice, seedModel, seedProvider, chatBody, usageRows, ledgerRows, holdRows } from "./helpers/realGatewayEnv";
import type { ProviderType } from "../src/types";
import type { JsonDecodeResult } from "../src/gateway/json_decode";

function answer(extra: Record<string, any> = {}) {
  return { id: "single-decode-fixture", model: "private-model", choices: [{ index: 0,
    message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, ...extra };
}
function legacy(text: string, provider: ProviderType, normalize = true) {
  const usage = parseUsage(provider, text);
  let out = maskJsonText(text, "public-model");
  let reasoning: string | undefined;
  if (normalize && mayNeedChatNormalisation(out)) {
    try { const value = JSON.parse(out); const state = createChatReasoningState();
      if (normalizeChatCompletion(value, state)) { out = JSON.stringify(value); reasoning = state.reasoning || undefined; }
    } catch {}
  }
  return { text: out, usage, reasoning };
}
afterEach(() => vi.restoreAllMocks());
describe("one owned JSON response", () => {
  const fixtures = [answer(), answer({ model: "public-model" }),
    answer({ choices: [{ message: { content: "<think>secret</think>answer" }, finish_reason: "stop" }] }),
    answer({ choices: [{ message: { content: "answer", reasoning: "thought" }, finish_reason: "stop" }] }),
    answer({ choices: [{ message: { tool_calls: [{ function: { name: "f", arguments: '{"model":"tool-model"}' } }] }, finish_reason: "tool_calls" }] }),
    { message: { model: "private-model", usage: { input_tokens: 3, output_tokens: 4 } }, response: { model: "private-model" } },
    null, [], 7, "plain", { error: { message: "invalid" } }];
  it.each(fixtures.map((value, i) => [i, value] as const))("matches legacy output/usage for JSON fixture %s", (_i, value) => {
    const text = JSON.stringify(value);
    const expected = legacy(text, "openai");
    const actual = prepareJsonResponse(text, "openai", "public-model", true);
    expect({ text: actual.text, usage: actual.usage, reasoning: actual.reasoning }).toEqual(expected);
  });
  it("uses the original object for metering before masking or normalization", () => {
    let observed = "";
    const text = JSON.stringify(answer({ choices: [{ message: { content: "<think>secret</think>answer" }, finish_reason: "stop" }] }));
    const parse = vi.spyOn(JSON, "parse");
    const result = prepareJsonResponse(text, "openai", "public-model", true, obj => { observed = JSON.stringify(obj); });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(observed).toBe(text);
    expect(result.text).not.toContain("private-model");
    expect(result.reasoning).toBe("secret");
  });
  it("normalizes Unicode-escaped fences revealed by identity masking", () => {
    const text = JSON.stringify(answer({ choices: [{ message: { content: "<think>secret</think>answer" }, finish_reason: "stop" }] })).replaceAll("<", "\\u003c");
    const expected = legacy(text, "openai");
    const actual = prepareJsonResponse(text, "openai", "public-model", true);
    expect(actual.text).toBe(expected.text); expect(actual.reasoning).toBe("secret");
  });
  it("does not promote the meter's Unicode-whitespace tolerance into JSON validity", () => {
    for (const prefix of ["\u00a0", "\u2003"]) {
      const text = prefix + JSON.stringify(answer());
      const meter = new UsageAccumulator("chat/completions"); meter.push(new TextEncoder().encode(text));
      let decoded: JsonDecodeResult | undefined; meter.finish(result => { decoded = result; });
      expect(decoded?.ok).toBe(true);  
      const result = prepareJsonResponse(text, "openai", "public-model", true, undefined, decoded);
      expect(result.decoded.ok).toBe(false); expect(result.text).toBe(maskJsonText(text, "public-model"));
    }
  });
  it("retains original bytes and unnormalized cache object if deep normalization cannot serialize", () => {
    const text = '{"choices":[{"message":{"content":"<think>secret</think>answer"},"finish_reason":"stop"}],"deep":' + "[".repeat(12000) + "0" + "]".repeat(12000) + "}";
    const result = prepareJsonResponse(text, "openai", "public-model", true);
    expect(result.text).toBe(legacy(text, "openai").text);
    expect(result.text).toBe(text); expect(result.reasoning).toBeUndefined();
    expect(result.decoded.ok && result.decoded.value.choices[0].message.content).toBe("<think>secret</think>answer");
  });
  it("retains byte-for-byte whitespace when nothing changes", () => {
    const text = ' { "model" : "public-model", "choices": [], "usage": {"prompt_tokens":1} } ';
    expect(prepareJsonResponse(text, "openai", "public-model", true).text).toBe(text);
  });
  it.each(['{"model":"private-model",', '<html>error</html>', `data: {"usage":{"prompt_tokens":9,"completion_tokens":2}}

data: [DONE]
`])
    ("keeps malformed/non-JSON fallback masking and usage", text => {
      const expected = legacy(text, "openai");
      const result = prepareJsonResponse(text, "openai", "public-model", true);
      expect(result.text).toBe(expected.text); expect(result.usage).toEqual(expected.usage);
    });
  it("preserves Anthropic cache/search and nested envelope extraction", () => {
    const value = { type: "message", content: [], model: "private-model", usage: { input_tokens: 10, output_tokens: 4,
      cache_read_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 2 }, server_tool_use: { web_search_requests: 2 } } };
    expect(parseJsonUsage("anthropic", value)).toEqual(parseUsage("anthropic", JSON.stringify(value)));
  });
  it.each([100, 100_000])("shares bounded decoder or decodes oversized JSON exactly once (%s chars)", size => {
    const text = JSON.stringify(answer({ padding: "x".repeat(size) }));
    const meter = new UsageAccumulator("chat/completions");
    const parse = vi.spyOn(JSON, "parse");
    meter.push(new TextEncoder().encode(text));
    let decoded: JsonDecodeResult | undefined;
    meter.finish(result => { decoded = result; });
    const result = prepareJsonResponse(text, "openai", "public-model", true, undefined, decoded);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(result.usage?.total_tokens).toBe(120);
    expect(decoded !== undefined).toBe(size === 100);
    expect(meter.finish()).toEqual(meter.snapshot());
  });
});

describe("real gateway single body decode", () => {
  it.each([32, 100_000])("parses once with durable usage, normalized masked cache and no hold (%s chars)", async size => {
    resetRateLimitMemory(); clearMemoryCacheForTest();
    const db = createRealD1();
    try {
      const env = makeEnv(db, makeKv()); await ensureSchema(env); await seedDevice(db, { balance_usd: 100 });
      seedProvider(db); seedModel(db, { model_name: "public-model", cache_enabled: 1 });
      const text = JSON.stringify(answer({ padding: "x".repeat(size), choices: [{ index: 0, message: { role: "assistant", content: "<think>secret</think>answer" }, finish_reason: "stop" }] }));
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(text, { headers: { "content-type": "application/json" } }));
      const parse = vi.spyOn(JSON, "parse"); const exec = new CollectingExecutionContext();
      const request = () => gatewayApp.fetch(new Request("https://gateway.test/chat/completions", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(chatBody("public-model")) }), env, exec as any);
      const res = await request(); const output = await res.text(); await Promise.all(exec.pending);
      expect(res.status).toBe(200);
      expect(parse.mock.calls.filter(args => args[0] === text)).toHaveLength(1);
      const saved = usageRows(db); expect(saved).toHaveLength(1);
      expect(saved[0].input_tokens).toBe(100); expect(saved[0].output_tokens).toBe(20);
      expect(ledgerRows(db)).toHaveLength(1); expect(holdRows(db)).toHaveLength(0);
      expect(output).toContain('"model":"public-model"'); expect(output).toContain('"reasoning_content":"secret"');
      const cached = await request(); const cachedText = await cached.text(); await Promise.all(exec.pending);
      expect(cached.status).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
      expect(cachedText).not.toContain("private-model"); expect(cachedText).toContain("answer");
    } finally { db.close(); }
  });
});
