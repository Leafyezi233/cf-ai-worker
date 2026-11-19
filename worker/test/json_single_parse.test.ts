import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareJsonResponse } from "../src/gateway/json_response";
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
afterEach(() => vi.restoreAllMocks());
describe("stable single-decode response contract", () => {
  it.each([100, 100_000])("borrows or decodes once while masking and preserving usage (%s chars)", size => {
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
    expect(result.text).toContain('"model":"public-model"');
    expect(result.text).not.toContain('private-model');
    expect(meter.finish()).toEqual(meter.snapshot());
  });
  it("preserves the stable best-effort malformed body fallback", () => {
    const text = "plain upstream body";
    const result = prepareJsonResponse(text, "openai", "public-model", false);
    expect(result.decoded.ok).toBe(false);
    expect(result.text).toBe(text);
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
