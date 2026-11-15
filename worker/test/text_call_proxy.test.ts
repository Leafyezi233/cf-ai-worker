import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { recoverBillingRequests } from "../src/db/request_billing";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import type { Env } from "../src/types";
import { createServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import {
  CollectingExecutionContext, chatBody, createRealD1, holdRows, ledgerRows,
  makeEnv, openAiAnswer, openAiStreamFrames, postJson, seedDevice, seedGroup,
  seedGroupMembers, seedModel, seedProvider, sseAnswer, usageRows, wallet, type RealD1,
} from "./helpers/realGatewayEnv";

const MODEL = "public-call-text";
const PRIVATE = "private-call-text";
const MESSAGE_MODEL = "public-call-text-messages";
const GROUP_MODEL = "public-call-text-group";
const NL = String.fromCharCode(10);
const PRICE = 0.25;
const GROUP_PRICE = 0.4;
const usage = {
  input_tokens: 1000, output_tokens: 1000, total_tokens: 2000,
  input_tokens_details: { cached_tokens: 400 }, output_tokens_details: { reasoning_tokens: 300 },
};
const chatUsage = {
  prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000,
  prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 300 },
};
const reverse = { chat_completions: false, responses: true, chat_route: "responses", loss_policy: "safe" };
let d1!: RealD1;
let env!: Env;

function configure(extra: Record<string, unknown> = {}) {
  d1.sql("UPDATE models SET config_json = ? WHERE id = 'model_a'", JSON.stringify({
    model_type: "text", model_rewrite: PRIVATE, ...extra,
  }));
}
function nativeObject(extra: Record<string, unknown> = {}) {
  return {
    id: "resp_call", object: "response", status: "completed", created_at: 1, model: PRIVATE,
    output: [{ id: "msg_call", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "hello" }] }],
    usage, ...extra,
  };
}
function nativeAnswer(extra: Record<string, unknown> = {}) {
  return Response.json(nativeObject(extra));
}
function frame(type: string, fields: Record<string, unknown>) {
  return "event: " + type + NL + "data: " + JSON.stringify({ type, ...fields }) + NL + NL;
}
type UpstreamCall = { url: string; body: Record<string, unknown> };
function upstream(factory: (call: UpstreamCall, index: number) => Response | Promise<Response> = () => openAiAnswer(chatUsage)) {
  const calls: UpstreamCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call = { url: input instanceof Request ? input.url : String(input), body: {} as Record<string, unknown> };
    calls.push(call);
    expect(wallet(d1)?.reserved_usd).toBeGreaterThan(0);
    expect(holdRows(d1)).toHaveLength(1);
    if (init?.body != null) call.body = JSON.parse(String(init.body));
    return factory(call, calls.length);
  });
  return calls;
}
async function request(path: string, body: unknown) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, path, body, exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text, exec };
}
function expectBilled(price = PRICE, model = MODEL) {
  const rows = usageRows(d1);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ model, cost_usd: price, input_tokens: 1000, output_tokens: 1000, status_code: 200 });
  expect(ledgerRows(d1).filter(row => row.reason === "usage")).toHaveLength(1);
  expect(wallet(d1)?.balance_usd).toBeCloseTo(1 - price, 8);
  expect(wallet(d1)?.reserved_usd).toBeCloseTo(0, 8);
  expect(holdRows(d1)).toEqual([]);
}
function expectZeroCharge(statusCode: number) {
  const rows = usageRows(d1);
  expect(rows).toHaveLength(1);
  expect(rows[0].cost_usd).toBe(0);
  expect(rows[0].status_code).toBe(statusCode);
  expect(rows[0].input_tokens + rows[0].output_tokens).toBeGreaterThan(0);
  expect(ledgerRows(d1).filter(row => row.reason === "usage").reduce((sum, row) => sum + row.delta_usd, 0)).toBe(0);
  expect(wallet(d1)?.balance_usd).toBeCloseTo(1, 8);
  expect(wallet(d1)?.reserved_usd).toBeCloseTo(0, 8);
  expect(holdRows(d1)).toEqual([]);
}

async function expectUnknownUntilRecovery(statusCode: number) {
  const holds = holdRows(d1);
  expect(holds).toHaveLength(1);
  expect(holds[0].amount_usd).toBe(PRICE);
  expect(wallet(d1)?.balance_usd).toBe(1);
  expect(wallet(d1)?.reserved_usd).toBe(PRICE);
  expect(usageRows(d1)).toEqual([]);
  expect(ledgerRows(d1)).toEqual([]);
  const billing = d1.row("SELECT * FROM billing_requests WHERE request_id = ?", holds[0].request_id)!;
  expect(billing).toMatchObject({ billing_state: "needs_reconciliation", known_cost_usd: null });
  expect(JSON.parse(String(billing.terminal_snapshot_json))).toMatchObject({ status_code: statusCode });
  expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 0 });
  expect(holdRows(d1)).toEqual(holds);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Number(billing.lease_until) + 1);
  try {
    expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 1 });
    expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 0 });
  } finally { clock.mockRestore(); }
  expect(holdRows(d1)).toEqual([]);
  expect(wallet(d1)?.reserved_usd).toBe(0);
  expect(wallet(d1)?.balance_usd).toBe(1);
  expect(usageRows(d1)).toEqual([]);
  expect(ledgerRows(d1)).toEqual([]);
  expect(d1.row("SELECT billing_state, known_cost_usd FROM billing_requests WHERE request_id = ?", holds[0].request_id))
    .toMatchObject({ billing_state: "needs_reconciliation", known_cost_usd: null });
}

beforeEach(async () => {
  resetRateLimitMemory();
  clearMemoryCacheForTest();
  d1 = createRealD1();
  env = makeEnv(d1);
  await seedDevice(d1, { balance_usd: 1 });
  seedProvider(d1);
  seedModel(d1, {
    model_name: MODEL, billing_unit: "call", price_per_call: PRICE,
    config_json: JSON.stringify({ model_type: "text", model_rewrite: PRIVATE }),
  });
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });

describe("text call billing across gateway protocols", () => {
  it("serves ordinary Chat Completions and charges the flat call price, not token usage", async () => {
    const calls = upstream();
    const { res, text } = await request("/chat/completions", chatBody(MODEL));
    expect(res.status, text).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://a.example/v1/chat/completions", body: { model: PRIVATE } });
    expect(JSON.parse(text).model).toBe(MODEL);
    expectBilled();
  });

  it("serves native Responses JSON and charges once despite large token counts", async () => {
    configure({ responses_mode: "native" });
    const calls = upstream(() => nativeAnswer());
    const { res, text } = await request("/responses", { model: MODEL, input: "hi", max_output_tokens: 8 });
    expect(res.status, text).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://a.example/v1/responses", body: { model: PRIVATE, store: false } });
    expect(JSON.parse(text)).toMatchObject({ object: "response", status: "completed", model: MODEL, usage });
    expectBilled();
  });

  it("charges a completed native Responses SSE stream exactly once", async () => {
    configure({ responses_mode: "native" });
    const calls = upstream(() => sseAnswer([
      frame("response.output_text.delta", { delta: "hello" }),
      frame("response.completed", { response: nativeObject() }),
    ]));
    const { res, text } = await request("/responses", { model: MODEL, input: "hi", stream: true });
    expect(res.status, text).toBe(200);
    expect(text).toContain("event: response.completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://a.example/v1/responses");
    expectBilled();
  });

  it("routes Chat through the Responses reverse bridge and charges exactly once", async () => {
    configure({ protocol_capabilities: reverse });
    const calls = upstream(() => nativeAnswer());
    const { res, text } = await request("/chat/completions", chatBody(MODEL));
    expect(res.status, text).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://a.example/v1/responses", body: { model: PRIVATE, input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] } });
    expect(JSON.parse(text)).toMatchObject({ object: "chat.completion", model: MODEL });
    expectBilled();
  });

  it("charges a completed normal Chat SSE stream once", async () => {
    const calls = upstream(() => sseAnswer(openAiStreamFrames()));
    const { res, text } = await request("/chat/completions", chatBody(MODEL, { stream: true }));
    expect(res.status, text).toBe(200);
    expect(text).toContain("data: [DONE]");
    expect(calls).toHaveLength(1);
    expectBilled();
  });

  it("charges a completed reverse-bridge Responses SSE stream once", async () => {
    configure({ protocol_capabilities: reverse });
    const calls = upstream(() => sseAnswer([
      frame("response.created", { response: { ...nativeObject(), output: [], usage: null, status: "in_progress" } }),
      frame("response.output_text.delta", { delta: "hello", item_id: "msg_call", output_index: 0, content_index: 0 }),
      frame("response.completed", { response: nativeObject() }),
    ]));
    const { res, text } = await request("/chat/completions", chatBody(MODEL, { stream: true }));
    expect(res.status, text).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://a.example/v1/responses");
    expect(text).toContain("hello");
    expect(text).toContain("[DONE]");
    expectBilled();
  });

  it("serves Anthropic Messages for an explicitly text-configured call model", async () => {
    seedProvider(d1, { id: "prov_messages", type: "anthropic", endpoint: "https://ant.example/v1", api_key: "sk-ant" });
    seedModel(d1, {
      id: "model_messages", provider_id: "prov_messages", model_name: MESSAGE_MODEL,
      billing_unit: "call", price_per_call: PRICE,
      config_json: JSON.stringify({ model_type: "text", model_rewrite: PRIVATE }),
    });
    const calls = upstream(() => Response.json({
      id: "msg_call", type: "message", role: "assistant", model: PRIVATE, stop_reason: "end_turn",
      content: [{ type: "text", text: "hello" }], usage,
    }));
    const { res, text } = await request("/messages", {
      model: MESSAGE_MODEL, max_tokens: 64, messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status, text).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://ant.example/v1/messages", body: { model: PRIVATE } });
    expect(JSON.parse(text).model).toBe(MESSAGE_MODEL);
    expect(usageRows(d1)).toHaveLength(1);
    expect(usageRows(d1)[0]).toMatchObject({ model: MESSAGE_MODEL, cost_usd: PRICE, input_tokens: 1000, output_tokens: 1000, status_code: 200 });
    expect(wallet(d1)?.balance_usd).toBeCloseTo(1 - PRICE, 8);
    expect(wallet(d1)?.reserved_usd).toBe(0);
    expect(holdRows(d1)).toEqual([]);
    expect(ledgerRows(d1).filter(row => row.reason === "usage")).toHaveLength(1);
  });
});

describe("incomplete text calls distinguish known failures from unknown completion", () => {
  it("records usage but charges nothing for an upstream HTTP error", async () => {
    const calls = upstream(() => Response.json({ error: { message: "invalid request" }, usage: chatUsage }, { status: 400 }));
    const { res } = await request("/chat/completions", chatBody(MODEL));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(1);
    expectZeroCharge(400);
  });

  it("keeps reported native Responses failure usage without charging a call", async () => {
    configure({ responses_mode: "native" });
    const calls = upstream(() => nativeAnswer({ status: "failed", error: { code: "server_error", message: "failed" } }));
    const { res } = await request("/responses", { model: MODEL, input: "hi" });
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
    expectZeroCharge(502);
    expect(usageRows(d1)[0]).toMatchObject({ input_tokens: 1000, output_tokens: 1000 });
  });

  it("keeps an uncertain per-call hold when the Chat SSE reader cancels before terminal", async () => {
    const cancelled = vi.fn();
    const chunk = "data: " + JSON.stringify({
      id: "chat_partial", object: "chat.completion.chunk", model: PRIVATE,
      choices: [{ index: 0, delta: { content: "partial" } }],
    }) + NL + NL;
    const calls = upstream(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(chunk)); },
      cancel: cancelled,
    }), { headers: { "content-type": "text/event-stream" } }));
    const exec = new CollectingExecutionContext();
    const res = await postJson(env, "/chat/completions", chatBody(MODEL, { stream: true }), exec);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("client disconnected");
    await Promise.all(exec.pending);
    expect(calls).toHaveLength(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
    await expectUnknownUntilRecovery(499);
  });

  it("keeps an uncertain per-call hold when a native Responses stream breaks before terminal", async () => {
    configure({ responses_mode: "native" });
    let delivered = false;
    const calls = upstream(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (delivered) { controller.error(new Error("socket hang up")); return; }
        delivered = true;
        controller.enqueue(new TextEncoder().encode(frame("response.output_text.delta", { delta: "partial", usage })));
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const { res, text } = await request("/responses", { model: MODEL, input: "hi", stream: true });
    expect(res.status).toBe(200);
    expect(text).toContain("event: response.failed");
    expect(calls).toHaveLength(1);
    await expectUnknownUntilRecovery(502);
  });
});

describe("legacy per-call rows remain image models", () => {
  it("rejects text Chat when config_json has no explicit model_type", async () => {
    d1.sql("UPDATE models SET config_json = NULL WHERE id = 'model_a'");
    const calls = upstream();
    const { res, text } = await request("/chat/completions", chatBody(MODEL));
    expect(res.status).toBe(400);
    expect(JSON.parse(text).error).toBe("per_call_text_only");
    expect(calls).toEqual([]);
    expect(usageRows(d1)).toEqual([]);
    expect(wallet(d1)?.balance_usd).toBeCloseTo(1, 8);
    expect(wallet(d1)?.reserved_usd).toBe(0);
    expect(holdRows(d1)).toEqual([]);
  });
});

describe("text call groups", () => {
  it("bills a text request at the group price rather than the member price", async () => {
    d1.sql("UPDATE models SET price_per_call = 9 WHERE id = 'model_a'");
    seedGroup(d1, {
      id: "group_text", name: GROUP_MODEL, billing_unit: "call", price_per_call: GROUP_PRICE,
      config_json: JSON.stringify({ model_type: "text" }),
    });
    seedGroupMembers(d1, "group_text", ["model_a"]);
    const calls = upstream();
    const { res, text } = await request("/chat/completions", chatBody(GROUP_MODEL));
    expect(res.status, text).toBe(200);
    expect(calls).toHaveLength(1);
    expect(usageRows(d1)).toHaveLength(1);
    expect(usageRows(d1)[0]).toMatchObject({ model: GROUP_MODEL, cost_usd: GROUP_PRICE, status_code: 200 });
    expect(wallet(d1)?.balance_usd).toBeCloseTo(1 - GROUP_PRICE, 8);
    expect(wallet(d1)?.reserved_usd).toBe(0);
    expect(holdRows(d1)).toEqual([]);
    expect(ledgerRows(d1).filter(row => row.reason === "usage")).toHaveLength(1);
  });
});

describe("selected service text-call pricing", () => {
  it("applies the service flat override once and records its pricing snapshot", async () => {
    const service = await createServiceGroup(env, { name: "flat-text-service", multiplier: 3, public_selectable: 1 });
    await upsertServiceGroupModel(env, service.id, {
      model_key: MODEL, target_type: "model", target_id: "model_a",
      member_ids_json: JSON.stringify(["model_a"]), pricing_json: JSON.stringify({ price_per_call: GROUP_PRICE }),
    });
    d1.sql("UPDATE devices SET service_group_id = ? WHERE id = 'dev_1'", service.id);
    const calls = upstream();
    const { res, text } = await request("/chat/completions", chatBody(MODEL));
    expect(res.status, text).toBe(200);
    expect(calls).toHaveLength(1);
    expectBilled(GROUP_PRICE);
    const row = d1.row<{ service_group_id: string; service_group_revision: number; pricing_snapshot_json: string }>(
      "SELECT service_group_id, service_group_revision, pricing_snapshot_json FROM usage");
    expect(row?.service_group_id).toBe(service.id);
    expect(row?.service_group_revision).toBe(service.revision + 1);
    expect(JSON.parse(row!.pricing_snapshot_json).billing.price_per_call).toBe(GROUP_PRICE);
  });

  it("settles completed Anthropic Messages SSE at one flat fee", async () => {
    d1.sql("UPDATE providers SET type = 'anthropic' WHERE id = 'prov_a'");
    const calls = upstream(() => sseAnswer([
      frame("message_start", { message: { id: "msg_sse", type: "message", role: "assistant", model: PRIVATE,
        content: [], usage: { input_tokens: 1000, output_tokens: 0 } } }),
      frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello" } }),
      frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1000 } }),
      frame("message_stop", {}),
    ]));
    const { res, text } = await request("/messages", { model: MODEL, max_tokens: 8,
      messages: [{ role: "user", content: "hi" }], stream: true });
    expect(res.status, text).toBe(200);
    expect(text).toContain("event: message_stop");
    expect(calls).toHaveLength(1);
    expectBilled();
  });
});
