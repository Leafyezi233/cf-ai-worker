import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ record: vi.fn().mockResolvedValue({ costUsd: 0 }), cache: vi.fn().mockResolvedValue(undefined), parse: vi.fn().mockReturnValue(null) }));
vi.mock("../src/gateway/usage_record", () => ({ record: mocks.record, buildBillingSnapshot: () => ({}) }));
vi.mock("../src/gateway/usage", () => ({ parseUsage: mocks.parse }));
vi.mock("../src/gateway/cache", () => ({ setCachedEntry: mocks.cache }));
vi.mock("../src/gateway/caller_identity", async importOriginal => ({ ...await importOriginal<typeof import("../src/gateway/caller_identity")>(), modelMaskingTransform: () => new TransformStream(), identityRedactionTransform: () => new TransformStream() }));
vi.mock("../src/gateway/thinking_sse", () => ({ createChatReasoningState: () => ({}), chatReasoningTransform: () => new TransformStream(), splitFencesFromText: (content: string) => ({ content }) }));
import { passthroughStream } from "../src/gateway/stream_relay";
import { UsageAccumulator } from "../src/gateway/usage_accumulator";
import type { ProxyContext } from "../src/gateway/proxy_context";
const enc = new TextEncoder();
beforeEach(() => { mocks.record.mockResolvedValue({ costUsd: 0 }); mocks.cache.mockResolvedValue(undefined); mocks.parse.mockReturnValue(null); });
afterEach(() => { vi.restoreAllMocks(); mocks.record.mockClear(); mocks.parse.mockClear(); mocks.cache.mockClear(); });
async function run(managed: boolean, cache = false, call = false, known = true) {
  const pending: Promise<unknown>[] = []; const meter = new UsageAccumulator("chat/completions");
  if (known) meter.observeJson({ usage: { prompt_tokens: 1, completion_tokens: 0 } });
  const row = { config_json: '{"model_type":"text"}', billing_unit: call ? "call" : "token", model_name: "public", cache_enabled: cache ? 1 : 0, cache_ttl: 30 };
  const ctx = { c: { env: {}, executionCtx: { waitUntil: (p: Promise<unknown>) => pending.push(p) } }, kind: "chat/completions", row, billingRow: row, visibleModel: "public", cacheKey: "k", requestId: "r", createdAt: 0,
    ...(managed ? { billingAttempt: { meter, mark: vi.fn() } } : {}) } as unknown as ProxyContext;
  const bytes = enc.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
  const upstream = new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }));
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  const response = passthroughStream(ctx, upstream); const reader = response.body!.getReader(); const chunks: Uint8Array[] = [];
  for (;;) { const r = await reader.read(); if (r.done) break; chunks.push(r.value); }
  await Promise.all(pending);
  return { calls: decode.mock.calls.length, ctx, bytes, chunks };
}
it("removes the redundant managed token relay decoder/legacy parse when usage is authoritative", async () => {
  const r = await run(true); expect(r.calls).toBe(0); expect(mocks.parse).not.toHaveBeenCalled();
  expect(r.chunks).toEqual([r.bytes]); expect(mocks.record.mock.calls[0][1]).toMatchObject({ input_tokens: 1, output_tokens: 0 });
});
it("keeps missing-usage and unmanaged legacy fallback capture", async () => {
  expect((await run(true, false, false, false)).calls).toBe(2); expect(mocks.parse).toHaveBeenCalledTimes(1);
  vi.mocked(TextDecoder.prototype.decode).mockRestore(); expect((await run(false)).calls).toBe(2); expect(mocks.parse).toHaveBeenCalledTimes(2);
});
it("keeps call completion decode and billability evidence", async () => {
  const r = await run(true, false, true); expect(r.calls).toBe(2); expect(r.ctx.billableCall).toBe(true);
});
it("keeps cache text capture even when managed usage is authoritative", async () => {
  const r = await run(true, true); expect(r.calls).toBe(2); expect(mocks.cache).toHaveBeenCalledTimes(1);
  expect(mocks.cache.mock.calls[0][2].jsonBody.choices[0].message.content).toBe("hello");
});
