import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { ensureSchema } from "../src/db/schema";
import { createServiceGroup, updateServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import type { Env } from "../src/types";
import { sha256Hex } from "../src/utils/crypto";
import {
  CollectingExecutionContext, DEVICE_ID, TOKEN, chatBody, createRealD1, holdRows, ledgerRows,
  makeEnv, makeKv, openAiAnswer, seedDevice, seedModel, seedProvider, sseAnswer, usageRows, wallet,
  type RealD1,
} from "./helpers/realGatewayEnv";

const PUBLIC_MODEL = "public-protocol-model";
const PRIVATE_MODEL = "private-upstream-model";
const MODEL_ID = "private-model-row";
const PROVIDER_ID = "private-provider-row";
const UPSTREAM_KEY = "sk-private-account-original";
const nativeConfig = JSON.stringify({ responses_mode: "native" });
const actualUsage = {
  input_tokens: 1000, output_tokens: 1000, total_tokens: 2000,
  input_tokens_details: { cached_tokens: 400 },
  output_tokens_details: { reasoning_tokens: 300 },
};
const opaqueItem = { type: "reasoning", id: "rs_original", encrypted_content: "opaque-encrypted-reasoning", summary: [] };

function nativeObject(extra: Record<string, unknown> = {}) {
  return {
    id: "resp_original", object: "response", created_at: 1, status: "completed", model: PRIVATE_MODEL,
    output: [{ id: "msg_original", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "hello" }] }],
    usage: actualUsage, ...extra,
  };
}
function nativeAnswer(extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify(nativeObject(extra)), { headers: { "content-type": "application/json" } });
}
function frame(type: string, fields: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}
function responsesBody(extra: Record<string, unknown> = {}) {
  return { model: PUBLIC_MODEL, input: "hi", max_output_tokens: 8, ...extra };
}
function replayBody(extra: Record<string, unknown> = {}) {
  return responsesBody({ input: [opaqueItem, { role: "user", content: "continue" }], ...extra });
}

let d1: RealD1;
let env: Env;
let kv: ReturnType<typeof makeKv>;
beforeEach(async () => {
  resetRateLimitMemory();
  clearMemoryCacheForTest();
  d1 = createRealD1();
  kv = makeKv();
  env = makeEnv(d1, kv);
  env.SESSION_SECRET = "protocol-proxy-local-test-session-secret";
  await ensureSchema(env);
  await seedDevice(d1, { balance_usd: 100 });
  seedProvider(d1, { id: PROVIDER_ID, endpoint: "https://original.example/v1", api_key: UPSTREAM_KEY });
  seedModel(d1, { id: MODEL_ID, provider_id: PROVIDER_ID, model_name: PUBLIC_MODEL, cache_enabled: 1,
    cache_read_price_per_m: 1, config_json: JSON.stringify({ responses_mode: "native", model_rewrite: PRIVATE_MODEL }) });
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });

type UpstreamCall = { url: string; body: Record<string, any>; headers: Headers; method: string };
function upstream(factory: (call: UpstreamCall, index: number) => Response | Promise<Response> = () => nativeAnswer()) {
  const calls: UpstreamCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call: UpstreamCall = { url: input instanceof Request ? input.url : String(input), body: {},
      headers: new Headers(init?.headers), method: init?.method ?? "GET" };
    calls.push(call);
    if (init?.body != null) call.body = JSON.parse(String(init.body));
    return factory(call, calls.length);
  });
  return calls;
}
async function request(path: string, body: Record<string, unknown>, affinity?: string, token = TOKEN) {
  const exec = new CollectingExecutionContext();
  const headers = new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  if (affinity !== undefined) headers.set("x-cpg-affinity", affinity);
  const response = await gatewayApp.request("http://gw.test" + path, {
    method: "POST", headers, body: JSON.stringify(body),
  }, env, exec as never);
  const text = await response.text();
  await Promise.all(exec.pending);
  return { response, text };
}
function untouchedWallet(before: ReturnType<typeof wallet>, ledgerCount = 0, usageCount = 0) {
  expect(wallet(d1)).toEqual(before);
  expect(holdRows(d1)).toEqual([]);
  expect(ledgerRows(d1)).toHaveLength(ledgerCount);
  expect(usageRows(d1)).toHaveLength(usageCount);
}
function assertActualBill(cost = 0.0172, count = 1) {
  const rows = usageRows(d1);
  expect(rows).toHaveLength(count);
  expect(rows[count - 1]).toMatchObject({ input_tokens: 1000, output_tokens: 1000, cache_hit: 0, status_code: 200 });
  expect(rows[count - 1].cost_usd).toBeCloseTo(cost, 8);
  expect(rows[count - 1].model).toBe(PUBLIC_MODEL);
  expect(d1.rows<{ cache_read_tokens: number }>("SELECT cache_read_tokens FROM usage ORDER BY id")[count - 1].cache_read_tokens).toBe(400);
  expect(ledgerRows(d1)[count - 1].delta_usd).toBeCloseTo(-cost, 8);
  expect(wallet(d1)?.balance_usd).toBeCloseTo(100 - cost * count, 8);
  expect(wallet(d1)?.reserved_usd).toBe(0);
  expect(holdRows(d1)).toEqual([]);
  expect(ledgerRows(d1)).toHaveLength(count);
}
function reserveStatements(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map(args => String(args[0])).filter(sql =>
    /INSERT INTO reserve_holds|reserved_usd\s*=\s*reserved_usd\s*\+/i.test(sql));
}
function tokenFrom(result: Awaited<ReturnType<typeof request>>) {
  expect(result.response.status, result.text).toBe(200);
  const token = result.response.headers.get("x-cpg-affinity");
  expect(token).toBeTruthy();
  return token!;
}

describe("protocol proxy: native continuity receipts", () => {
  it("returns a confidential token on the initial native Responses JSON response and keeps native usage/opaque output", async () => {
    const calls = upstream(() => nativeAnswer({ output: [opaqueItem] }));
    const result = await request("/responses", responsesBody({ include: ["reasoning.encrypted_content"] }));
    const token = tokenFrom(result);
    expect(JSON.parse(result.text)).toMatchObject({ object: "response", status: "completed", model: PUBLIC_MODEL,
      output: [opaqueItem], usage: actualUsage });
    expect(result.response.headers.get("x-cpg-protocol-route")).toBe("responses->responses");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://original.example/v1/responses", method: "POST",
      body: { model: PRIVATE_MODEL, input: "hi", store: false } });
    const decoded = token.split(".").slice(1).map(part =>
      atob(part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - part.length % 4) % 4))).join("");
    for (const raw of [MODEL_ID, PROVIDER_ID, PRIVATE_MODEL, UPSTREAM_KEY, "original.example", DEVICE_ID]) {
      expect(token).not.toContain(raw);
      expect(decoded).not.toContain(raw);
    }
    expect(kv.writes).toEqual([]);
    assertActualBill();
  });

  it("returns the continuity receipt on an initial native Responses SSE response too", async () => {
    const calls = upstream(() => sseAnswer([
      frame("response.created", { response: { ...nativeObject(), output: [], usage: null, status: "in_progress" } }),
      frame("response.completed", { response: nativeObject({ output: [opaqueItem] }) }),
    ]));
    const result = await request("/responses", responsesBody({ stream: true, include: ["reasoning.encrypted_content"] }));
    tokenFrom(result);
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    expect(result.response.headers.get("x-cpg-protocol-route")).toBe("responses->responses");
    expect(result.text).toContain(opaqueItem.encrypted_content);
    expect(result.text).not.toContain(PRIVATE_MODEL);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://original.example/v1/responses", body: { model: PRIVATE_MODEL, stream: true } });
    expect(kv.writes).toEqual([]);
    assertActualBill();
  });

  it.each(["absent", "tampered", "expired", "secret-rotated"] as const)("drops %s opaque affinity and continues with actual billing", async variant => {
    const calls = upstream();
    const token = tokenFrom(await request("/responses", responsesBody()));
    const changed = token.slice(0, 25) + (token[25] === "A" ? "B" : "A") + token.slice(26);
    if (variant === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600000);
    if (variant === "secret-rotated") env.SESSION_SECRET += "-changed";
    const replay = await request("/responses", replayBody(), variant === "absent" ? undefined : variant === "tampered" ? changed : token);
    expect(replay.response.status, replay.text).toBe(200);
    expect(replay.response.headers.get("x-cpg-state-reset")).toBe("opaque-state-dropped");
    expect(calls).toHaveLength(2);
    expect(calls[1].body.input).toEqual([{ role: "user", content: "continue" }]);
    expect(calls[1].headers.get("x-cpg-affinity")).toBeNull();
    expect(kv.writes).toEqual([]);
    assertActualBill(0.0172, 2);
  });

  it("resets replay before native SSE dispatch, exposes notice and settles original usage once", async () => {
    const calls = upstream(() => sseAnswer([
      frame("response.created", { response: { ...nativeObject(), output: [], usage: null, status: "in_progress" } }),
      frame("response.completed", { response: nativeObject() }),
    ]));
    const result = await request("/responses", replayBody({ stream: true }));
    expect(result.response.status, result.text).toBe(200);
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    expect(result.response.headers.get("x-cpg-state-reset")).toBe("opaque-state-dropped");
    expect(result.response.headers.get("access-control-expose-headers")).toContain("X-Cpg-State-Reset");
    expect(result.response.headers.get("x-cpg-affinity")).toBeTruthy();
    expect(result.text).toContain("response.completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.input).toEqual([{ role: "user", content: "continue" }]);
    expect(kv.writes).toEqual([]);
    assertActualBill();
  });

  it("replays opaque input unchanged only to the original upstream model/provider/account", async () => {
    const calls = upstream();
    const token = tokenFrom(await request("/responses", responsesBody()));
    const result = await request("/responses", replayBody(), token);
    expect(result.response.status, result.text).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ url: calls[0].url, body: { model: PRIVATE_MODEL, input: replayBody().input } });
    expect(calls[1].headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(calls[1].headers.get("x-cpg-affinity")).toBeNull();
    expect(kv.writes).toEqual([]);
    assertActualBill(0.0172, 2);
  });

  it.each(["model", "upstream model", "provider", "account", "endpoint"] as const)("drops opaque state after original %s identity changes", async binding => {
    const calls = upstream();
    const token = tokenFrom(await request("/responses", responsesBody()));
    const before = wallet(d1);
    if (binding === "model") {
      d1.sql("UPDATE models SET enabled = 0 WHERE id = ?", MODEL_ID);
      seedModel(d1, { id: "replacement-model-row", provider_id: PROVIDER_ID, model_name: PUBLIC_MODEL, config_json: nativeConfig });
    } else if (binding === "upstream model") {
      d1.sql("UPDATE models SET config_json = ? WHERE id = ?",
        JSON.stringify({ responses_mode: "native", model_rewrite: "changed-private-upstream-model" }), MODEL_ID);
    } else if (binding === "provider") {
      seedProvider(d1, { id: "replacement-provider-row", endpoint: "https://other.example/v1" });
      d1.sql("UPDATE models SET provider_id = ? WHERE id = ?", "replacement-provider-row", MODEL_ID);
    } else if (binding === "account") {
      d1.sql("UPDATE providers SET api_key = ? WHERE id = ?", "sk-rotated-account", PROVIDER_ID);
    } else {
      d1.sql("UPDATE providers SET endpoint = ? WHERE id = ?", "https://changed.example/v1", PROVIDER_ID);
    }
    const result = await request("/responses", replayBody(), token);
    expect(result.response.status, result.text).toBe(200);
    expect(result.response.headers.get("x-cpg-state-reset")).toBe("opaque-state-dropped");
    expect(calls).toHaveLength(2);
    expect(calls[1].body.input).toEqual([{ role: "user", content: "continue" }]);
    expect(wallet(d1)?.reserved_usd).toBe(0);
    expect(ledgerRows(d1)).toHaveLength(2);
    expect(usageRows(d1)).toHaveLength(2);
  });

  it.each(["device", "selection", "requested model"] as const)("drops a receipt bound to another %s without bypassing authorization", async binding => {
    const calls = upstream();
    const token = tokenFrom(await request("/responses", responsesBody()));
    let callerToken = TOKEN;
    let body = replayBody();
    if (binding === "device") {
      callerToken = "ccs_protocol_other_device";
      await seedDevice(d1, { id: "other-device", balance_usd: 100, token_hash: await sha256Hex(callerToken) });
    } else if (binding === "selection") {
      d1.sql("UPDATE devices SET service_group_id = ? WHERE id = ?", "auto", DEVICE_ID);
    } else {
      seedModel(d1, { id: "alias-model", provider_id: PROVIDER_ID, model_name: "other-public-model", config_json: nativeConfig });
      body = replayBody({ model: "other-public-model" });
    }
    const result = await request("/responses", body, token, callerToken);
    expect(result.response.status, result.text).toBe(200);
    expect(result.response.headers.get("x-cpg-state-reset")).toBe("opaque-state-dropped");
    expect(calls).toHaveLength(2);
    expect(calls[1].body.input).toEqual([{ role: "user", content: "continue" }]);
    expect(holdRows(d1)).toEqual([]);
    expect(ledgerRows(d1)).toHaveLength(binding === "device" ? 1 : 2);
    if (binding === "device") expect(ledgerRows(d1, "other-device")).toHaveLength(1);
  });

});

async function autoOffers() {
  d1.sql("UPDATE devices SET service_group_id = ? WHERE id = ?", "auto", DEVICE_ID);
  seedProvider(d1, { id: "other-provider", endpoint: "https://other.example/v1", api_key: "sk-other-account" });
  seedModel(d1, { id: "other-model", provider_id: "other-provider", model_name: "other-private-model",
    input_price_per_m: 3, output_price_per_m: 15, cache_read_price_per_m: 1, config_json: nativeConfig });
  const original = await createServiceGroup(env, { name: "original-offer", public_selectable: 1, multiplier: 1 });
  const other = await createServiceGroup(env, { name: "other-offer", public_selectable: 1, multiplier: 3 });
  for (const [group, model] of [[original, MODEL_ID], [other, "other-model"]] as const) {
    await upsertServiceGroupModel(env, group.id, { model_key: PUBLIC_MODEL, target_type: "model", target_id: model,
      member_ids_json: JSON.stringify([model]) });
  }
  return { original, other };
}

describe("protocol proxy: opaque Auto routing is pinned, ordinary turns are not", () => {
  it("keeps opaque replay on the exact original service group despite a cheaper alternative", async () => {
    const { original } = await autoOffers();
    const calls = upstream();
    const token = tokenFrom(await request("/responses", responsesBody()));
    await updateServiceGroup(env, original.id, { multiplier: 10 });
    const result = await request("/responses", replayBody(), token);
    expect(result.response.status, result.text).toBe(200);
    expect(calls.map(call => call.url)).toEqual(["https://original.example/v1/responses", "https://original.example/v1/responses"]);
    expect(d1.rows<{ service_group_id: string }>("SELECT service_group_id FROM usage ORDER BY id").map(row => row.service_group_id))
      .toEqual([original.id, original.id]);
    expect(wallet(d1)?.reserved_usd).toBe(0);
  });

  it("does not cross provider or service group after a transient pinned failure", async () => {
    await autoOffers();
    const calls = upstream((_call, index) => index === 1 ? nativeAnswer() : new Response("temporarily unavailable", { status: 503 }));
    const token = tokenFrom(await request("/responses", responsesBody()));
    const before = wallet(d1);
    const result = await request("/responses", replayBody(), token);
    expect(result.response.status, result.text).toBe(502);
    expect(calls.map(call => call.url)).toEqual(["https://original.example/v1/responses", "https://original.example/v1/responses"]);
    expect(wallet(d1)).toEqual(before);
    expect(holdRows(d1)).toEqual([]);
    expect(ledgerRows(d1)).toHaveLength(2);
    expect(ledgerRows(d1)[1].delta_usd).toBe(0);
    expect(usageRows(d1)).toHaveLength(2);
    expect(usageRows(d1)[1]).toMatchObject({ cost_usd: 0, input_tokens: 0, output_tokens: 0 });
  });

  it("resets after removal of the original group member before using a replacement account", async () => {
    const { original } = await autoOffers();
    const calls = upstream();
    const token = tokenFrom(await request("/responses", responsesBody()));
    const before = wallet(d1);
    await upsertServiceGroupModel(env, original.id, { model_key: PUBLIC_MODEL, target_type: "model", target_id: "other-model",
      member_ids_json: JSON.stringify(["other-model"]) });
    const result = await request("/responses", replayBody(), token);
    expect(result.response.status, result.text).toBe(200);
    expect(result.response.headers.get("x-cpg-state-reset")).toBe("opaque-state-dropped");
    expect(calls).toHaveLength(2);
    expect(calls[1].body.input).toEqual([{ role: "user", content: "continue" }]);
    expect(wallet(d1)?.reserved_usd).toBe(0);
    expect(ledgerRows(d1)).toHaveLength(2);
    expect(usageRows(d1)).toHaveLength(2);
  });

  it("ignores the same affinity header for non-opaque turns and preserves Auto low-price order", async () => {
    const { original, other } = await autoOffers();
    const calls = upstream();
    const token = tokenFrom(await request("/responses", responsesBody()));
    await updateServiceGroup(env, original.id, { multiplier: 10 });
    const result = await request("/responses", responsesBody({ input: "a new ordinary turn" }), token);
    expect(result.response.status, result.text).toBe(200);
    expect(calls.map(call => call.url)).toEqual(["https://original.example/v1/responses", "https://other.example/v1/responses"]);
    expect(calls[1].body.model).toBe("other-private-model");
    expect(d1.rows<{ service_group_id: string }>("SELECT service_group_id FROM usage ORDER BY id").map(row => row.service_group_id))
      .toEqual([original.id, other.id]);
    expect(JSON.parse(result.text).model).toBe(PUBLIC_MODEL);
    expect(wallet(d1)?.reserved_usd).toBe(0);
  });
});

function configureCapabilities(capabilities: Record<string, unknown>) {
  d1.sql("UPDATE models SET config_json = ? WHERE id = ?", JSON.stringify({
    model_rewrite: PRIVATE_MODEL, protocol_capabilities: capabilities,
  }), MODEL_ID);
}
const reverseCapabilities = { chat_completions: false, responses: true, chat_route: "responses", loss_policy: "safe" };
const chatUsage = {
  prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000,
  prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 300 },
};
const functionOutput = { type: "function_call", id: "fc_private_item", call_id: "call_weather", name: "weather",
  arguments: '{"city":"Paris"}', status: "completed" };
function chatChunks(text: string): any[] {
  return text.split(/\r?\n/).filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice(6)));
}

describe("protocol proxy: Chat to Responses bridge", () => {
  it("maps supported tools, history and controls, exposes the public final model, and bills JSON actual usage", async () => {
    configureCapabilities(reverseCapabilities);
    const calls = upstream(() => nativeAnswer({ output: [...nativeObject().output, functionOutput] }));
    const parameters = { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false };
    const schema = { type: "object", properties: { answer: { type: "string" } }, additionalProperties: false };
    const body = chatBody(PUBLIC_MODEL, {
      messages: [
        { role: "system", content: "Be helpful" },
        { role: "user", content: [{ type: "text", text: "weather?" },
          { type: "image_url", image_url: { url: "https://image.example/paris.png", detail: "low" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "call_previous", type: "function",
          function: { name: "weather", arguments: '{"city":"Paris"}' } }] },
        { role: "tool", tool_call_id: "call_previous", content: "sunny" },
      ],
      tools: [{ type: "function", function: { name: "weather", description: "Get weather", parameters, strict: true } }],
      tool_choice: { type: "function", function: { name: "weather" } }, parallel_tool_calls: false,
      max_completion_tokens: 32, reasoning_effort: "high", n: 1,
      response_format: { type: "json_schema", json_schema: { name: "answer", schema, strict: true } },
    });
    const result = await request("/chat/completions", body);
    expect(result.response.status, result.text).toBe(200);
    expect(result.response.headers.get("x-cpg-protocol-route")).toBe("chat/completions->responses");
    expect(calls).toHaveLength(1);  
    expect(calls[0]).toMatchObject({ url: "https://original.example/v1/responses", method: "POST", body: {
      model: PRIVATE_MODEL, store: false, max_output_tokens: 32, reasoning: { effort: "high" },
      tools: [{ type: "function", name: "weather", description: "Get weather", parameters, strict: true }],
      tool_choice: { type: "function", name: "weather" }, parallel_tool_calls: false,
      text: { format: { type: "json_schema", name: "answer", schema, strict: true } },
      input: [
        { role: "system", content: [{ type: "input_text", text: "Be helpful" }] },
        { role: "user", content: [{ type: "input_text", text: "weather?" },
          { type: "input_image", image_url: "https://image.example/paris.png", detail: "low" }] },
        { type: "function_call", call_id: "call_previous", name: "weather", arguments: '{"city":"Paris"}' },
        { type: "function_call_output", call_id: "call_previous", output: "sunny" },
      ],
    } });
    for (const key of ["messages", "max_tokens", "max_completion_tokens", "reasoning_effort", "response_format", "n"]) {
      expect(calls[0].body).not.toHaveProperty(key);
    }
    const answer = JSON.parse(result.text);
    expect(answer).toMatchObject({ object: "chat.completion", model: PUBLIC_MODEL, usage: chatUsage,
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "hello",
        tool_calls: [{ id: "call_weather", type: "function", function: { name: "weather", arguments: '{"city":"Paris"}' } }] } }] });
    expect(result.text).not.toContain(PRIVATE_MODEL);
    expect(kv.writes).toEqual([]);
    assertActualBill();
  });

  it("converts SSE text/tools and terminal usage without duplicate final content and bills the actual cached usage", async () => {
    configureCapabilities(reverseCapabilities);
    const completed = nativeObject({ output: [...nativeObject().output, functionOutput] });
    const calls = upstream(() => sseAnswer([
      frame("response.created", { response: { ...nativeObject(), output: [], usage: null, status: "in_progress" } }),
      frame("response.output_text.delta", { output_index: 0, content_index: 0, delta: "hel" }),
      frame("response.output_text.delta", { output_index: 0, content_index: 0, delta: "lo" }),
      frame("response.output_item.added", { output_index: 1, item: { ...functionOutput, arguments: "", status: "in_progress" } }),
      frame("response.function_call_arguments.delta", { output_index: 1, delta: '{"city":' }),
      frame("response.function_call_arguments.delta", { output_index: 1, delta: '"Paris"}' }),
      frame("response.output_item.done", { output_index: 1, item: functionOutput }),
      frame("response.completed", { response: completed }),
    ]));
    const result = await request("/chat/completions", chatBody(PUBLIC_MODEL, { stream: true, stream_options: { include_usage: true } }));
    expect(result.response.status, result.text).toBe(200);
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://original.example/v1/responses", body: {
      model: PRIVATE_MODEL, stream: true, store: false, max_output_tokens: 8,
    } });
    expect(calls[0].body).not.toHaveProperty("stream_options");
    const chunks = chatChunks(result.text);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(chunk => chunk.model === PUBLIC_MODEL)).toBe(true);
    const deltas = chunks.flatMap(chunk => chunk.choices.map((choice: any) => choice.delta));
    expect(deltas.map(delta => delta.content ?? "").join("")).toBe("hello");
    const tools = deltas.flatMap(delta => delta.tool_calls ?? []);
    expect(tools.filter(tool => tool.id)).toEqual([{ index: 0, id: "call_weather", type: "function",
      function: { name: "weather", arguments: "" } }]);
    expect(tools.map(tool => tool.function?.arguments ?? "").join("")).toBe('{"city":"Paris"}');
    expect(chunks.flatMap(chunk => chunk.choices).filter(choice => choice.finish_reason))
      .toEqual([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
    expect(chunks.filter(chunk => chunk.usage)).toEqual([expect.objectContaining({ choices: [], usage: chatUsage })]);
    expect(result.text.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(result.text).not.toContain(PRIVATE_MODEL);
    expect(kv.writes).toEqual([]);
    assertActualBill();
  });

  it.each([
    { label: "multiple choices", extra: { n: 2 } },
    { label: "stop sequences", extra: { stop: ["END"] } },
    { label: "audio output", extra: { modalities: ["text", "audio"], audio: { voice: "alloy", format: "wav" } } },
    { label: "audio input", extra: { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }] }] } },
  ])("rejects unsupported $label before reserve/upstream and leaves wallet unchanged", async ({ extra }) => {
    configureCapabilities(reverseCapabilities);
    const calls = upstream();
    const before = wallet(d1);
    const prepare = vi.spyOn(d1.DB, "prepare");
    const result = await request("/chat/completions", chatBody(PUBLIC_MODEL, extra));
    expect(result.response.status, result.text).toBe(400);
    expect(calls).toEqual([]);
    expect(reserveStatements(prepare)).toEqual([]);
    expect(kv.writes).toEqual([]);
    untouchedWallet(before);
  });

  it("preserves valid Chat reasoning replay and resets missing or tampered receipts", async () => {
    configureCapabilities(reverseCapabilities);
    const calls = upstream(() => nativeAnswer({ output: [opaqueItem, ...nativeObject().output] }));
    const initial = await request("/chat/completions", chatBody(PUBLIC_MODEL));
    const token = tokenFrom(initial);
    expect(JSON.parse(initial.text).choices[0].message.reasoning_details).toEqual([opaqueItem]);
    const body = chatBody(PUBLIC_MODEL, { messages: [
      { role: "assistant", content: "hello", reasoning_details: [opaqueItem] },
      { role: "user", content: "continue" },
    ] });
    const before = wallet(d1);
    const prepare = vi.spyOn(d1.DB, "prepare");
    const absent = await request("/chat/completions", body);
    expect(absent.response.status, absent.text).toBe(200);
    expect(absent.response.headers.get("x-cpg-state-reset")).toBe("opaque-state-dropped");
    const tampered = await request("/chat/completions", body, token.slice(0, 25) + (token[25] === "A" ? "B" : "A") + token.slice(26));
    expect(tampered.response.status, tampered.text).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls[1].body.input).toEqual(calls[2].body.input);
    expect(JSON.stringify(calls[1].body)).not.toContain(opaqueItem.encrypted_content);
    const replay = await request("/chat/completions", body, token);
    expect(replay.response.status, replay.text).toBe(200);
    expect(calls).toHaveLength(4);
    expect(calls[3]).toMatchObject({ url: "https://original.example/v1/responses", body: { model: PRIVATE_MODEL,
      input: [opaqueItem, { role: "assistant", content: [{ type: "output_text", text: "hello" }] },
        { role: "user", content: [{ type: "input_text", text: "continue" }] }],
    } });
    expect(calls[1].headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(calls[1].headers.get("x-cpg-affinity")).toBeNull();
    expect(kv.writes).toEqual([]);
    assertActualBill(0.0172, 4);
  });

  it.each(["strict", "native"] as const)("does not bridge when %s is explicitly requested in capability config", async mode => {
    configureCapabilities({ ...reverseCapabilities, ...(mode === "strict" ? { loss_policy: "strict" } : { chat_route: "native" }) });
    const calls = upstream();
    const before = wallet(d1);
    const prepare = vi.spyOn(d1.DB, "prepare");
    const result = await request("/chat/completions", chatBody(PUBLIC_MODEL));
    expect(result.response.status, result.text).toBe(400);
    expect(calls).toEqual([]);
    expect(reserveStatements(prepare)).toEqual([]);
    untouchedWallet(before);
  });
});

describe("protocol proxy: settlement and query cost", () => {
  it.each([false,true])("records reverse conversion failure as 502 exactly once (stream=%s)", async stream => {
    configureCapabilities(reverseCapabilities);
    const invalid = nativeObject({output:[{type:"web_search_call",id:"unsupported"}]});
    upstream(()=>stream ? sseAnswer([frame("response.completed",{response:invalid})]) : nativeAnswer({output:invalid.output}));
    const result=await request("/chat/completions",chatBody(PUBLIC_MODEL,{stream}));
    if(stream){expect(result.text).toContain("invalid_responses_stream");expect(result.text).not.toContain('"finish_reason":"stop"');}
    else expect(result.response.status).toBe(502);
    expect(usageRows(d1)).toHaveLength(1);expect(usageRows(d1)[0].status_code).toBe(502);
    expect(ledgerRows(d1)).toHaveLength(1);expect(ledgerRows(d1)[0].delta_usd).toBeCloseTo(-0.0172,8);
    expect(wallet(d1)?.reserved_usd).toBe(0);expect(holdRows(d1)).toEqual([]);
  });
  it("adds no SQL for reverse JSON/SSE or per-delta conversion with session receipts enabled",async()=>{
    const executed:string[]=[];const prepare=d1.DB.prepare.bind(d1.DB);
    d1.DB.prepare=(sql:string)=>{const stmt=prepare(sql);for(const op of ["first","all","run"]){const f=stmt[op].bind(stmt);stmt[op]=(...a:unknown[])=>{executed.push(sql);return f(...a);};}return stmt;};
    const protocolOps = () => executed.filter(sql => !/\bbilling_(?:requests|attempts)\b/.test(sql));
    upstream();await request("/responses",responsesBody());executed.length=0;
    await request("/responses",responsesBody());const baseline=protocolOps();
    configureCapabilities(reverseCapabilities);executed.length=0;
    await request("/chat/completions",chatBody(PUBLIC_MODEL));expect(protocolOps()).toEqual(baseline);
    let singleDeltaOps: string[] | undefined;
    for(const n of [1,400]){upstream(()=>sseAnswer([...Array.from({length:n},()=>frame("response.output_text.delta",{output_index:0,content_index:0,delta:"x"})),frame("response.completed",{response:nativeObject()})]));executed.length=0;
      const result = await request("/chat/completions",chatBody(PUBLIC_MODEL,{stream:true}));
      expect(result.response.headers.get("x-cpg-affinity")).toBeTruthy();
      expect(protocolOps()).toEqual(baseline);
      if (singleDeltaOps) expect(executed).toEqual(singleDeltaOps);
      else singleDeltaOps = [...executed];}
    console.info("[protocol D1] native/reverse JSON/reverse SSE identical protocol-only SQL count="+baseline.length+"; 1/400 deltas add zero; receipts enabled");
  });
});

describe("protocol proxy: legacy forward compatibility and declaration refresh", () => {
  it("retains existing Responses to Chat JSON routing, function tools, public model and actual-usage billing", async () => {
    d1.sql("UPDATE models SET cache_enabled = 0, config_json = ? WHERE id = ?",
      JSON.stringify({ responses_mode: "chat_adapter", model_rewrite: PRIVATE_MODEL }), MODEL_ID);
    const calls = upstream(() => openAiAnswer(chatUsage));
    const result = await request("/responses", responsesBody({
      tools: [{ type: "function", name: "weather", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "weather" },
    }));
    expect(result.response.status, result.text).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://original.example/v1/chat/completions", body: {
      model: PRIVATE_MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 8,
      tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "weather" } },
    } });
    expect(JSON.parse(result.text)).toMatchObject({ object: "response", status: "completed", model: PUBLIC_MODEL,
      output: [expect.objectContaining({ type: "message", content: [expect.objectContaining({ type: "output_text", text: "pong" })] })] });
    expect(result.text).not.toContain(PRIVATE_MODEL);
    expect(kv.writes).toEqual([]);
    assertActualBill();
  });

  it.each(["strict", "native"] as const)("refuses the forward bridge when Responses %s is explicitly required", async mode => {
    configureCapabilities({ chat_completions: true, responses: false, responses_route: mode === "native" ? "native" : "chat",
      loss_policy: mode === "strict" ? "strict" : "safe" });
    const calls = upstream(() => openAiAnswer(chatUsage));
    const before = wallet(d1);
    const prepare = vi.spyOn(d1.DB, "prepare");
    const result = await request("/responses", responsesBody());
    expect(result.response.status, result.text).toBe(400);
    expect(calls).toEqual([]);
    expect(reserveStatements(prepare)).toEqual([]);
    expect(kv.writes).toEqual([]);
    untouchedWallet(before);
  });

  it("applies changed capabilities on the very next request without reset, capability fetch or cache write", async () => {
    const calls = upstream(call => call.url.endsWith("/responses") ? nativeAnswer() : openAiAnswer(chatUsage));
    configureCapabilities(reverseCapabilities);
    const first = await request("/chat/completions", chatBody(PUBLIC_MODEL));
    expect(first.response.status, first.text).toBe(200);
    configureCapabilities({ chat_completions: false, responses: true, chat_route: "responses", loss_policy: "strict" });
    const beforeDenied = wallet(d1);
    const refused = await request("/chat/completions", chatBody(PUBLIC_MODEL));
    expect(refused.response.status, refused.text).toBe(400);
    untouchedWallet(beforeDenied, 1, 1);
    configureCapabilities({ chat_completions: true, responses: false, chat_route: "native", loss_policy: "safe" });
    d1.sql("UPDATE models SET cache_enabled = 0 WHERE id = ?", MODEL_ID);
    const third = await request("/chat/completions", chatBody(PUBLIC_MODEL));
    expect(third.response.status, third.text).toBe(200);
    expect(calls.map(call => call.url)).toEqual(["https://original.example/v1/responses", "https://original.example/v1/chat/completions"]);
    expect(JSON.parse(third.text).model).toBe(PUBLIC_MODEL);
    expect(kv.writes).toEqual([]);
    assertActualBill(0.0172, 2);
  });
});

describe("protocol reset edge cases", () => {
  it.each([false, true])("does not leak holds when reset leaves no conversation (Auto=%s)", async auto => {
    if (auto) await autoOffers();
    const calls = upstream(); const before = wallet(d1);
    const result = await request("/responses", responsesBody({ input: [opaqueItem] }));
    expect(result.response.status, result.text).toBe(400);
    expect(calls).toEqual([]); untouchedWallet(before);
    expect(d1.rows("SELECT * FROM billing_attempts")).toEqual([]);
  });
  it.each([false, true])("never reuses large raw opaque history after reset (valid receipt=%s)", async valid => {
    d1.sql("UPDATE models SET config_json = ? WHERE id = ?", nativeConfig, MODEL_ID);
    const calls = upstream();
    const token = valid ? tokenFrom(await request("/responses", responsesBody())) : undefined;
    if (valid) d1.sql("UPDATE providers SET api_key = ? WHERE id = ?", "rotated", PROVIDER_ID);
    const text = "x".repeat(300 * 1024);
    const result = await request("/responses", replayBody({ store: false, input: [opaqueItem, { role: "user", content: text }] }), token);
    expect(result.response.status, result.text).toBe(200);
    expect(result.response.headers.get("x-cpg-state-reset")).toBe("opaque-state-dropped");
    expect(calls.at(-1)?.body.input).toEqual([{ role: "user", content: text }]);
    expect(kv.writes).toEqual([]); assertActualBill(0.0172, valid ? 2 : 1);
  });
  it("can use the declared Chat adapter after removing native-only encrypted history", async () => {
    d1.sql("UPDATE models SET cache_enabled = 0, config_json = ? WHERE id = ?", JSON.stringify({ responses_mode: "chat_adapter" }), MODEL_ID);
    const calls = upstream(() => openAiAnswer(chatUsage));
    const call = { type: "function_call", call_id: "c1", name: "f", arguments: "{}" };
    const output = { type: "function_call_output", call_id: "c1", output: "done" };
    const result = await request("/responses", replayBody({ input: [opaqueItem, call, output, { role: "user", content: "continue" }] }));
    expect(result.response.status, result.text).toBe(200);
    expect(calls).toHaveLength(1); expect(calls[0].url).toContain("/chat/completions");
    expect(calls[0].body.messages).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "done" }, { role: "user", content: "continue" },
    ]);
    assertActualBill();
  });
  it("does not use affinity reset to bypass model authorization", async () => {
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID);
    const calls = upstream(); const before = wallet(d1);
    const result = await request("/responses", replayBody());
    expect(result.response.status).toBe(403); expect(calls).toEqual([]); untouchedWallet(before);
  });
  it("resets when the original Auto group is disabled and uses currently authorized offers", async () => {
    const { original, other } = await autoOffers();
    const calls = upstream(); const token = tokenFrom(await request("/responses", responsesBody()));
    await updateServiceGroup(env, original.id, { enabled: 0 });
    const result = await request("/responses", replayBody(), token);
    expect(result.response.status, result.text).toBe(200);
    expect(result.response.headers.get("x-cpg-state-reset")).toBe("opaque-state-dropped");
    expect(calls[1].url).toContain("other.example");
    expect(calls[1].body.input).toEqual([{ role: "user", content: "continue" }]);
    expect(d1.rows<{ service_group_id: string }>("SELECT service_group_id FROM usage ORDER BY id").map(row => row.service_group_id)).toEqual([original.id, other.id]);
    expect(holdRows(d1)).toEqual([]);
  });
});
