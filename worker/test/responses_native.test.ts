import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway";
import { recoverBillingRequests } from "../src/db/request_billing";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { parseUsage, parseUsageBlocks } from "../src/gateway/usage";
import { readResponsesMode } from "../src/gateway/responses_mode";
import { MAX_NATIVE_EVENT_CHARS, MAX_NATIVE_JSON_BYTES, ResponsesEventFramer } from "../src/gateway/responses_native";
import { CreateModelSchema } from "../src/admin/schemas";
import { applyRequestRewriteRules } from "../src/gateway/rewrite";
import { UPSTREAM_STREAM_STALL_TIMEOUT_MS } from "../src/gateway/stream_relay";
import {
  CollectingExecutionContext, TOKEN, createRealD1, makeEnv, makeKv, openAiAnswer,
  seedDevice, seedModel, seedProvider, seedGroup, seedGroupMembers, usageRows, wallet,
} from "./helpers/realGatewayEnv";

const nativeConfig = JSON.stringify({ responses_mode: "native" });
const actualUsage = {
  input_tokens: 1000, output_tokens: 1000, total_tokens: 2000,
  input_tokens_details: { cached_tokens: 400 }, output_tokens_details: { reasoning_tokens: 300 },
};
function answer(extra: Record<string, unknown> = {}) {
  return {
    id: "resp_upstream", object: "response", created_at: 1, status: "completed", model: "private-upstream",
    output: [{ id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
    usage: actualUsage, ...extra,
  };
}
function jsonAnswer(extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify(answer(extra)), { headers: { "content-type": "application/json" } });
}
function frame(type: string, fields: Record<string, unknown> = {}, crlf = false) {
  const text = `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}
function nativeStream(parts?: string[]) {
  const frames = parts ?? [
    frame("response.created", { sequence_number: 0, response: answer({ status: "in_progress", usage: null, output: [] }) }),
    frame("response.output_text.delta", { sequence_number: 1, delta: "hello", item_id: "msg_1", output_index: 0, content_index: 0 }),
    frame("response.completed", { sequence_number: 2, response: answer() }),
  ];
  return new Response(new ReadableStream<Uint8Array>({
    start(ctrl) { for (const part of frames) ctrl.enqueue(new TextEncoder().encode(part)); ctrl.close(); },
  }), { headers: { "content-type": "text/event-stream" } });
}

const databases: ReturnType<typeof createRealD1>[] = [];
let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetRateLimitMemory();
  clearMemoryCacheForTest();
});
afterEach(() => { vi.useRealTimers(); globalThis.fetch = originalFetch; for (const db of databases.splice(0)) db.close(); });

async function seed(config: string | null = nativeConfig, cache = 0) {
  const d1 = createRealD1();
  databases.push(d1);
  seedProvider(d1);
  seedModel(d1, { config_json: config, cache_enabled: cache, cache_read_price_per_m: 1 });
  await seedDevice(d1);
  const kv = makeKv();
  const env = makeEnv(d1, kv);
  env.SESSION_SECRET = "native-protocol-local-test-session";
  return { d1, kv, env };
}
async function request(env: ReturnType<typeof makeEnv>, body: Record<string, unknown> = {}, affinity?: string) {
  const exec = new CollectingExecutionContext();
  const res = await gatewayApp.request("http://gw.test/responses", {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(affinity ? { "x-cpg-affinity": affinity } : {}) },
    body: JSON.stringify({ model: "gw-primary", input: "hi", ...body }),
  }, env, exec as never);
  return { res, exec };
}
async function call(env: ReturnType<typeof makeEnv>, body: Record<string, unknown> = {}, affinity?: string) {
  const { res, exec } = await request(env, body, affinity);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}
function upstream(factory: () => Response = jsonAnswer) {
  const calls: { url: string; body: any; raw: string }[] = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), raw: init.body });
    return factory();
  }) as typeof fetch;
  return calls;
}

describe("native Responses routing and billing", () => {
  it("calls /responses, disables store, masks only the envelope and bills actual cached/reasoning usage", async () => {
    const { d1, env } = await seed();
    const opaque = { type: "reasoning", encrypted_content: "private-upstream", metadata: { model: "untouched" } };
    const calls = upstream(() => jsonAnswer({ output: [opaque] }));
    const { res, text } = await call(env, { include: ["reasoning.encrypted_content"] });
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("https://a.example/v1/responses");
    expect(calls[0].body.store).toBe(false);
    expect(calls[0].body.input).toBe("hi");
    expect(calls[0].body.messages).toBeUndefined();
    expect(JSON.parse(text)).toMatchObject({ model: "gw-primary", output: [opaque], usage: actualUsage });
    expect(usageRows(d1)).toHaveLength(1);
    expect(usageRows(d1)[0].cost_usd).toBeCloseTo(0.0172, 8);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(0.9828, 8);
    expect(wallet(d1)!.reserved_usd).toBe(0);
  });

  it("keeps legacy rows on the Chat adapter", async () => {
    const { env } = await seed(null);
    const calls = upstream(openAiAnswer);
    const { text } = await call(env);
    expect(calls[0].url).toBe("https://a.example/v1/chat/completions");
    expect(JSON.parse(text).object).toBe("response");
  });

  it("never reads/writes response cache in native mode even when enabled", async () => {
    const { env, kv, d1 } = await seed(nativeConfig, 1);
    const calls = upstream();
    await call(env);
    await call(env);
    expect(calls).toHaveLength(2);
    expect(kv.writes).toHaveLength(0);
    expect(usageRows(d1)).toHaveLength(2);
  });

  it.each([false, true])("preserves upstream cache hints, replayed reasoning and cache usage (stream=%s)", async (stream) => {
    const { env, d1, kv } = await seed(nativeConfig, 1);
    const history = [{ role: "user", content: [{ type: "input_text", text: "stable prefix ".repeat(200) }] }];
    const output = [
      { id: "rs_1", type: "reasoning", encrypted_content: "opaque_signed_reasoning", summary: [] },
      { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ];
    let turn = 0;
    const calls = upstream(() => {
      const response = answer({ output, usage: { ...actualUsage, input_tokens_details: { cached_tokens: turn++ === 0 ? 0 : 400 } } });
      return stream ? nativeStream([frame("response.completed", { response })]) : new Response(JSON.stringify(response));
    });
    const hints = { stream, store: false, prompt_cache_key: "stable_session_cache_key", prompt_cache_retention: "24h", include: ["reasoning.encrypted_content"] };
    const first = await call(env, { ...hints, input: history });
    const affinity = first.res.headers.get("x-cpg-affinity");
    expect(affinity).toBeTruthy();
    const replay = [...history, ...output, { role: "user", content: [{ type: "input_text", text: "next turn" }] }];
    const second = await call(env, { ...hints, input: replay }, affinity!);
    expect(calls.map((c) => c.url)).toEqual(["https://a.example/v1/responses", "https://a.example/v1/responses"]);
    expect(calls[0].body).toMatchObject({ ...hints, input: history });
    expect(calls[1].body).toMatchObject({ ...hints, input: replay });
    expect(second.text).toContain('"cached_tokens":400');
    const rows = d1.rows<{ cache_read_tokens: number; cache_hit: number; cost_usd: number }>(
      "SELECT cache_read_tokens, cache_hit, cost_usd FROM usage ORDER BY id"
    );
    expect(rows.map((r) => r.cache_read_tokens)).toEqual([0, 400]);
    expect(rows.map((r) => r.cache_hit)).toEqual([0, 0]);
    expect(rows[0].cost_usd).toBeCloseTo(0.018, 8);
    expect(rows[1].cost_usd).toBeCloseTo(0.0172, 8);
    expect(kv.writes).toHaveLength(0);
  });

  it.each([
    { previous_response_id: "resp_1" }, { conversation: "conv_1" }, { store: true }, { background: true },
    { tools: [{ type: "web_search" }] }, { tools: [{ type: "code_interpreter" }] },
    { input: [{ type: "item_reference", id: "item_other_device" }] },
    { input: [{ role: "user", content: [{ type: "input_file", file_id: "file_other_device" }] }] },
  ])("rejects unsupported state/tool fields before upstream/reserve: %j", async (body) => {
    const { d1, env } = await seed();
    const calls = upstream();
    expect((await call(env, body)).res.status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(usageRows(d1)).toHaveLength(0);
    expect(d1.rows("SELECT * FROM reserve_holds")).toHaveLength(0);
  });

  it.each(["disabled", "chat_adapter"])("does not send an empty conversation after state reset in mode %s", async (mode) => {
    const { d1, env } = await seed(JSON.stringify({ responses_mode: mode }));
    const calls = upstream();
    const result = await call(env, { input: [{ type: "reasoning", encrypted_content: "signed" }] });
    expect(result.res.status).toBe(400);
    expect(result.res.headers.get("x-cpg-state-reset")).toBe("opaque-state-dropped");
    expect(calls).toHaveLength(0);
    expect(usageRows(d1)).toHaveLength(0);
    expect(d1.rows("SELECT * FROM reserve_holds")).toHaveLength(0);
  });

  it("preserves native function/custom tools, outputs, instructions and format", async () => {
    const { env } = await seed();
    const calls = upstream();
    const body = {
      tools: [{ type: "function", name: "read", parameters: { type: "object" } }, { type: "custom", name: "patch" }],
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
      instructions: "rules", text: { format: { type: "json_schema", name: "result", schema: { type: "object" } } },
      parallel_tool_calls: false, reasoning: { effort: "high" },
    };
    await call(env, body);
    expect(calls[0].body).toMatchObject(body);
  });

  it("reuses large original bodies only when store=false and no fields change", async () => {
    const { env } = await seed();
    const calls = upstream();
    const input = "x".repeat(270000);
    await call(env, { input, store: false });
    expect(calls[0].raw).toBe(JSON.stringify({ model: "gw-primary", input, store: false }));
  });

  it("retains input image URLs and file payloads without Chat conversion", async () => {
    const { env } = await seed();
    const calls = upstream();
    const input = [{ role: "user", content: [{ type: "input_image", image_url: "https://img.test/a.png" }, { type: "input_file", file_data: "data:application/pdf;base64,AA==" }] }];
    await call(env, { input });
    expect(calls[0].body.input).toEqual(input);
  });

  it("uses the selected group member mode and prevents lossy fallback", async () => {
    const { env, d1 } = await seed(null);
    seedProvider(d1, { id: "prov_b", endpoint: "https://b.example/v1" });
    seedModel(d1, { id: "model_b", provider_id: "prov_b", model_name: "second", config_json: nativeConfig });
    seedGroup(d1);
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    const calls = upstream();
    const { text } = await call(env, { model: "gw-group", include: ["reasoning.encrypted_content"] });
    expect(calls.map((c) => c.url)).toEqual(["https://b.example/v1/responses"]);
    expect(JSON.parse(text).model).toBe("gw-group");
    expect(usageRows(d1)[0].cost_usd).toBeCloseTo(0.054, 8);
  });

  it("may fail over from native to adapter for a representable text request", async () => {
    const { env, d1, kv } = await seed();
    seedProvider(d1, { id: "prov_b", endpoint: "https://b.example/v1" });
    seedModel(d1, { id: "model_b", provider_id: "prov_b", model_name: "second", cache_enabled: 1 });
    seedGroup(d1, { cache_enabled: 1 });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    let attempts = 0;
    const calls = upstream(() => ++attempts === 1 ? new Response("down", { status: 503 }) : openAiAnswer());
    expect((await call(env, { model: "gw-group" })).res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["https://a.example/v1/responses", "https://b.example/v1/chat/completions"]);
    expect(usageRows(d1)).toHaveLength(1);
    expect(kv.writes).toHaveLength(0);
  });

  it("releases a real hold when every native upstream fails", async () => {
    const { env, d1 } = await seed();
    d1.sql("UPDATE device_wallets SET balance_usd = 0.05");
    upstream(() => new Response("down", { status: 503 }));
    expect((await call(env)).res.status).toBe(502);
    expect(wallet(d1)!.reserved_usd).toBe(0);
    expect(wallet(d1)!.balance_usd).toBe(0.05);
  });

  it.each(["incomplete", "failed"])("settles actual usage for a %s JSON response", async (status) => {
    const { env, d1 } = await seed();
    upstream(() => jsonAnswer({ status }));
    await call(env);
    expect(usageRows(d1)).toHaveLength(1);
    expect(usageRows(d1)[0].cost_usd).toBeCloseTo(0.0172, 8);
  });

  it("bounds JSON bodies and releases the wallet hold on invalid JSON", async () => {
    const { env, d1 } = await seed();
    d1.sql("UPDATE device_wallets SET balance_usd = 0.05");
    upstream(() => new Response("bad json"));
    expect((await call(env)).res.status).toBe(502);
    expect(wallet(d1)!.reserved_usd).toBe(0);
    expect(usageRows(d1)).toHaveLength(1);
  });

  it("rejects a declared oversized response without reading it", async () => {
    const { env } = await seed();
    upstream(() => new Response("{}", { headers: { "content-length": String(MAX_NATIVE_JSON_BYTES + 1) } }));
    expect((await call(env)).res.status).toBe(502);
  });

  it("enforces the JSON size limit without trusting content-length", async () => {
    const { env } = await seed();
    upstream(() => new Response("x".repeat(MAX_NATIVE_JSON_BYTES + 1)));
    expect((await call(env)).res.status).toBe(502);
  });

  it("accepts explicitly reported zero usage without estimating a charge", async () => {
    const { env, d1 } = await seed();
    upstream(() => jsonAnswer({ usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }));
    await call(env);
    expect(usageRows(d1)[0].cost_usd).toBe(0);
    expect(wallet(d1)!.balance_usd).toBe(1);
  });

  it("marks a JSON usage estimate when the upstream omits usage", async () => {
    const { env, d1 } = await seed();
    upstream(() => jsonAnswer({ usage: null }));
    const { res } = await call(env);
    expect(res.headers.get("x-gateway-usage-estimated")).toBe("true");
    expect(usageRows(d1)[0].cost_usd).toBeGreaterThan(0);
  });

  it("rejects JSON in place of a requested stream but still settles actual usage", async () => {
    const { env, d1 } = await seed();
    upstream();
    expect((await call(env, { stream: true })).res.status).toBe(502);
    expect(usageRows(d1)[0].cost_usd).toBeCloseTo(0.0172, 8);
  });

  it.each([false, true])("keeps client-error status and redacts upstream details (JSON=%s)", async (json) => {
    const { env } = await seed(JSON.stringify({ responses_mode: "native", model_rewrite: "private-upstream" }));
    const message = "Provider A rejects private-upstream: invalid parameter";
    upstream(() => new Response(json ? JSON.stringify({ error: { message } }) : message, { status: 400 }));
    const { res, text } = await call(env);
    expect(res.status).toBe(400);
    expect(text).not.toContain("private-upstream");
    expect(text).not.toContain("Provider A");
    expect(text).toContain("invalid parameter");
  });
});

describe("native SSE", () => {
  it("forwards native deltas and terminal usage exactly once", async () => {
    const { env, d1 } = await seed();
    upstream(nativeStream);
    const { text } = await call(env, { stream: true });
    expect(text).toContain('"delta":"hello"');
    expect(text).toContain('"model":"gw-primary"');
    expect(text).not.toContain("private-upstream");
    expect(text.match(/event: response.completed/g)).toHaveLength(1);
    expect(usageRows(d1)).toHaveLength(1);
    expect(usageRows(d1)[0].cost_usd).toBeCloseTo(0.0172, 8);
  });

  it("handles byte-fragmented UTF-8, CRLF, comments and multiline data", async () => {
    const { env } = await seed();
    const created = frame("response.created", { response: answer({ status: "in_progress", usage: null }) }, true);
    const delta = `: heartbeat\r\n\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"你好"}\r\n\r\n`;
    const bytes = new TextEncoder().encode(created + delta + frame("response.completed", { response: answer() }));
    upstream(() => new Response(new ReadableStream({
      start(ctrl) { for (const byte of bytes) ctrl.enqueue(new Uint8Array([byte])); ctrl.close(); },
    }), { headers: { "content-type": "text/event-stream" } }));
    const { text } = await call(env, { stream: true });
    expect(text).toContain("你好");
    expect(text).toContain(": heartbeat");
    expect(text).not.toContain("response.failed");
  });

  it.each(["response.incomplete", "response.failed"])("preserves terminal event %s and its usage", async (type) => {
    const { env, d1 } = await seed();
    upstream(() => nativeStream([frame(type, { response: answer({ status: type.slice(9) }) })]));
    const { text } = await call(env, { stream: true });
    expect(text.match(new RegExp(`event: ${type}`, "g"))).toHaveLength(1);
    expect(usageRows(d1)[0].cost_usd).toBeCloseTo(0.0172, 8);
  });

  it.each([
    [frame("response.output_text.delta", { delta: "partial" })],
    [frame("response.output_text.delta", { delta: "partial" }), "data: {"],
    ["data: {bad}\n\n"],
    ["data: " + "x".repeat(MAX_NATIVE_EVENT_CHARS)],
  ])("fails an incomplete/malformed/oversized stream instead of fabricating completion", async (...parts) => {
    const { env, d1 } = await seed();
    upstream(() => nativeStream(parts));
    const { text } = await call(env, { stream: true });
    expect(text).toContain("event: response.failed");
    expect(text).not.toContain("event: response.completed");
    if (parts.some(part => part.includes('"delta":"partial"'))) {
      expect(usageRows(d1)).toHaveLength(1);
      expect(usageRows(d1)[0].status_code).toBe(502);
      expect(wallet(d1)!.reserved_usd).toBe(0);
    } else {
      expect(usageRows(d1)).toEqual([]);
      expect(d1.rows("SELECT * FROM wallet_ledger")).toEqual([]);
      const held = wallet(d1)!.reserved_usd;
      expect(held).toBeGreaterThan(0);
      const billing = d1.row<{ lease_until: number }>("SELECT * FROM billing_requests")!;
      expect(billing).toMatchObject({ billing_state: "needs_reconciliation", known_cost_usd: null });
      expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 0 });
      expect(wallet(d1)!.reserved_usd).toBe(held);
      const clock = vi.spyOn(Date, "now").mockReturnValue(billing.lease_until + 1);
      try { expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 1 }); }
      finally { clock.mockRestore(); }
      expect(wallet(d1)!.reserved_usd).toBe(0);
      expect(d1.rows("SELECT * FROM reserve_holds")).toEqual([]);
      expect(usageRows(d1)).toEqual([]);
      expect(d1.rows("SELECT * FROM wallet_ledger")).toEqual([]);
    }
  });

  it("settles and cancels the source on a transport error", async () => {
    const { env, d1 } = await seed();
    let pulls = 0;
    upstream(() => new Response(new ReadableStream({
      pull(ctrl) {
        if (++pulls === 1) ctrl.enqueue(new TextEncoder().encode(frame("response.output_text.delta", { delta: "partial" })));
        else ctrl.error(new Error("socket lost"));
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    expect((await call(env, { stream: true })).text).toContain("event: response.failed");
    expect(usageRows(d1)).toHaveLength(1);
  });

  it("cancels upstream and settles once when the reader leaves mid-stream", async () => {
    const { env, d1 } = await seed();
    d1.sql("UPDATE device_wallets SET balance_usd = 0.05");
    const cancelled = vi.fn();
    upstream(() => new Response(new ReadableStream({
      start(ctrl) { ctrl.enqueue(new TextEncoder().encode(frame("response.output_text.delta", { delta: "partial" }))); },
      cancel: cancelled,
    }), { headers: { "content-type": "text/event-stream" } }));
    const { res, exec } = await request(env, { stream: true });
    const reader = res.body!.getReader();
    await reader.read();
    expect(usageRows(d1)).toHaveLength(0);
    expect(wallet(d1)!.reserved_usd).toBeGreaterThan(0);
    await reader.cancel();
    await Promise.all(exec.pending);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(usageRows(d1)).toHaveLength(1);
    expect(wallet(d1)!.reserved_usd).toBe(0);
    expect(wallet(d1)!.balance_usd).toBeLessThan(0.05);
  });

  it("does not retry after sending any native events", async () => {
    const { env, d1 } = await seed();
    seedModel(d1, { id: "model_b", model_name: "backup", config_json: nativeConfig });
    d1.sql("UPDATE models SET fallback_model_id = 'model_b' WHERE id = 'model_a'");
    const calls = upstream(() => nativeStream([frame("response.output_text.delta", { delta: "partial" })]));
    await call(env, { stream: true });
    expect(calls).toHaveLength(1);
  });

  it("does not rewrite model-like strings inside tool arguments or encrypted reasoning events", async () => {
    const { env } = await seed();
    const argumentFrame = frame("response.function_call_arguments.delta", { delta: '{"model":"private-upstream"}', item_id: "fc_1", output_index: 0 });
    const reasoningFrame = frame("response.output_item.done", { item: { type: "reasoning", encrypted_content: "private-upstream" } });
    upstream(() => nativeStream([argumentFrame, reasoningFrame, frame("response.completed", { response: answer() })]));
    const { text } = await call(env, { stream: true });
    expect(text).toContain(argumentFrame);
    expect(text).toContain(reasoningFrame);
  });

  it("redacts native SSE errors without changing their event type", async () => {
    const { env } = await seed(JSON.stringify({ responses_mode: "native", model_rewrite: "private-upstream" }));
    upstream(() => nativeStream([frame("error", { message: "Provider A rejected private-upstream" })]));
    const { text } = await call(env, { stream: true });
    expect(text).toContain("event: error");
    expect(text).not.toContain("Provider A");
    expect(text).not.toContain("private-upstream");
  });

  it("does not accept a mismatched SSE event name or malformed terminal envelope", async () => {
    const { env } = await seed();
    upstream(() => nativeStream(['event: response.completed\ndata: {"type":"response.failed"}\n\n']));
    const { text } = await call(env, { stream: true });
    expect(text).toContain("event: response.failed");
    expect(text).not.toContain("event: response.completed");
  });

  it("turns a stalled native stream into a failure and settles its partial output", async () => {
    vi.useFakeTimers();
    const { env, d1 } = await seed();
    upstream(() => new Response(new ReadableStream({
      start(ctrl) { ctrl.enqueue(new TextEncoder().encode(frame("response.output_text.delta", { delta: "partial" }))); },
    }), { headers: { "content-type": "text/event-stream" } }));
    const { res, exec } = await request(env, { stream: true });
    const textPromise = res.text();
    await vi.advanceTimersByTimeAsync(UPSTREAM_STREAM_STALL_TIMEOUT_MS + 1);
    expect(await textPromise).toContain("event: response.failed");
    await Promise.all(exec.pending);
    expect(usageRows(d1)).toHaveLength(1);
    expect(wallet(d1)!.reserved_usd).toBe(0);
  });
});

describe("cost and configuration contracts", () => {
  it("adds no D1 operations versus an uncached adapter call and no writes per SSE delta", async () => {
    const { env, d1 } = await seed(null);
    const executed: string[] = [];
    const prepare = d1.DB.prepare.bind(d1.DB);
    d1.DB.prepare = (sql: string) => {
      const stmt = prepare(sql);
      for (const op of ["first", "all", "run"]) {
        const original = stmt[op].bind(stmt);
        stmt[op] = (...args: unknown[]) => { executed.push(sql); return original(...args); };
      }
      return stmt;
    };
    upstream(openAiAnswer);
    await call(env);  
    executed.length = 0;
    await call(env);
    const protocolOps = () => executed.filter(sql => !/\bbilling_(?:requests|attempts)\b/.test(sql));
    const adapterOps = protocolOps();
    d1.sql("UPDATE models SET config_json = ? WHERE id = 'model_a'", nativeConfig);
    executed.length = 0;
    upstream();
    await call(env);
    expect(protocolOps()).toEqual(adapterOps);
    const nativeOps = protocolOps();
    let singleDeltaOps: string[] | undefined;
    for (const deltas of [1, 400]) {
      executed.length = 0;
      upstream(() => nativeStream([
        ...Array.from({ length: deltas }, () => frame("response.output_text.delta", { delta: "x" })),
        frame("response.completed", { response: answer() }),
      ]));
      const { res } = await call(env, { stream: true });
      expect(res.headers.get("x-cpg-affinity")).toBeTruthy();
      expect(protocolOps()).toEqual(nativeOps);
      if (singleDeltaOps) expect(executed).toEqual(singleDeltaOps);
      else singleDeltaOps = [...executed];
    }
    console.info(`[responses D1] adapter/native JSON/native SSE: ${nativeOps.length} identical protocol-only hot-path SQL executions; 1 vs 400 deltas add zero`);
  });

  it("parses Responses envelopes and cached/reasoning details without double billing", () => {
    expect(parseUsage("openai", frame("response.completed", { response: answer() }))).toMatchObject({
      input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 400, reasoning_tokens: 300,
    });
    expect(parseUsageBlocks("openai", [actualUsage, actualUsage])!.total_tokens).toBe(2000);
  });

  it("defaults legacy config and fails closed on an unknown explicit mode", () => {
    expect(readResponsesMode({ config_json: null })).toBe("chat_adapter");
    expect(readResponsesMode({ config_json: '{"responses_mode":"typo"}' })).toBe("disabled");
    expect(CreateModelSchema.safeParse({ provider_id: "p", model_name: "m", config_json: '{"responses_mode":"typo"}' }).success).toBe(false);
  });

  it("injects Responses instructions and uses max_output_tokens for new limits", () => {
    expect(applyRequestRewriteRules({ instructions: "user rules" }, { system_prompt: "admin", max_tokens: 12 }, "responses"))
      .toMatchObject({ instructions: "admin\n\nuser rules", max_output_tokens: 12 });
  });

  it("frames a large byte-fragmented event and rejects unbounded carry", () => {
    const framer = new ResponsesEventFramer();
    let emitted = 0;
    const text = "data: " + "x".repeat(128 * 1024) + "\n\n";
    for (let i = 0; i < text.length; i += 7) framer.feed(text.slice(i, i + 7), () => { emitted++; });
    expect(emitted).toBe(1);
    expect(framer.pending).toBe(false);
    expect(() => framer.feed("x".repeat(MAX_NATIVE_EVENT_CHARS + 1), () => {})).toThrow("responses_event_too_large");
  });
});
