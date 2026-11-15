import { describe, expect, it } from "vitest";
import {
  convertChatRequestToResponses,
  convertResponsesToChatJson,
  createResponsesToChatTransform,
  unsupportedChatToResponsesFields,
} from "../src/gateway/chat_responses_bridge";
import { MAX_NATIVE_EVENT_CHARS } from "../src/gateway/responses_native";

const encoder = new TextEncoder();
const publicModel = "public-chat-model";
const nativeUsage = {
  input_tokens: 23, output_tokens: 11, total_tokens: 34,
  input_tokens_details: { cached_tokens: 17 },
  output_tokens_details: { reasoning_tokens: 7 },
};
const chatUsage = {
  prompt_tokens: 23, completion_tokens: 11, total_tokens: 34,
  prompt_tokens_details: { cached_tokens: 17 },
  completion_tokens_details: { reasoning_tokens: 7 },
};
function response(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_bridge", object: "response", created_at: 123, model: "private-provider-model",
    status: "completed", output: [], usage: nativeUsage, ...overrides,
  };
}
function message(text: string) {
  return { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}
function frame(type: string, fields: Record<string, unknown> = {}) {
  return "event: " + type + "\ndata: " + JSON.stringify({ type, ...fields }) + "\n\n";
}
function terminal(overrides: Record<string, unknown> = {}) {
  return frame("response.completed", { response: response(overrides) });
}
async function convertStream(parts: (string | Uint8Array)[]) {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
      controller.close();
    },
  });
  const reader = source.pipeThrough(createResponsesToChatTransform(publicModel)).getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  text += decoder.decode();
  const payloads = text.split(/\r?\n\r?\n/).filter(Boolean).map((entry) => entry.replace(/^data: /, ""));
  const chunks = payloads.filter((entry) => entry !== "[DONE]").map((entry) => JSON.parse(entry));
  return { text, payloads, chunks };
}
function deltas(chunks: any[]) {
  return chunks.flatMap((chunk) => chunk.choices ?? []).map((choice) => choice.delta);
}
function finishReasons(chunks: any[]) {
  return chunks.flatMap((chunk) => chunk.choices ?? []).map((choice) => choice.finish_reason).filter(Boolean);
}
function expectStreamError(result: Awaited<ReturnType<typeof convertStream>>) {
  expect(result.chunks.filter((chunk) => chunk.error)).toEqual([
    { error: { type: "upstream_error", code: "invalid_responses_stream", message: expect.any(String) } },
  ]);
  expect(result.payloads.filter((entry) => entry === "[DONE]")).toHaveLength(1);
  expect(result.payloads.at(-1)).toBe("[DONE]");
  expect(finishReasons(result.chunks)).toEqual([]);
}

describe("Chat request to Responses conversion", () => {
  it("preserves ordered system/developer/user/assistant messages without mutating the request", () => {
    const body = { model: "m", messages: [
      { role: "system", content: "system rules" },
      { role: "developer", content: [{ type: "text", text: "developer rules" }] },
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ] };
    const before = JSON.stringify(body);
    expect(convertChatRequestToResponses(body)).toEqual({ model: "m", store: false, input: [
      { role: "system", content: [{ type: "input_text", text: "system rules" }] },
      { role: "developer", content: [{ type: "input_text", text: "developer rules" }] },
      { role: "user", content: [{ type: "input_text", text: "question" }] },
      { role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    ] });
    expect(JSON.stringify(body)).toBe(before);
  });

  it("converts image URL objects and data URLs while keeping detail and part order", () => {
    const image = "data:image/png;base64,AA==";
    const result = convertChatRequestToResponses({ model: "m", messages: [{ role: "user", content: [
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url: "https://images.example/a.png", detail: "high" } },
      { type: "image_url", image_url: image },
    ] }] });
    expect(result.input[0].content).toEqual([
      { type: "input_text", text: "describe" },
      { type: "input_image", image_url: "https://images.example/a.png", detail: "high" },
      { type: "input_image", image_url: image },
    ]);
  });

  it("converts function definitions, forced choice, assistant calls and tool results", () => {
    const parameters = { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false };
    const result = convertChatRequestToResponses({ model: "m", tools: [{ type: "function", function: {
      name: "weather", description: "Get weather", parameters, strict: true,
    } }], tool_choice: { type: "function", function: { name: "weather" } }, parallel_tool_calls: false,
    messages: [
      { role: "user", content: "weather?" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"北京"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"temperature":20}' },
    ] });
    expect(result.tools).toEqual([{ type: "function", name: "weather", description: "Get weather", parameters, strict: true }]);
    expect(result.tool_choice).toEqual({ type: "function", name: "weather" });
    expect(result.parallel_tool_calls).toBe(false);
    expect(result.input.slice(1)).toEqual([
      { type: "function_call", call_id: "call_1", name: "weather", arguments: '{"city":"北京"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"temperature":20}' },
    ]);
  });

  it.each(["auto", "none", "required"])("preserves string tool choice %s", (tool_choice) => {
    expect(convertChatRequestToResponses({ messages: [{ role: "user", content: "hi" }], tool_choice }).tool_choice).toBe(tool_choice);
  });

  it("maps schema, reasoning effort, limits and cache hints without leaking Chat-only fields", () => {
    const json_schema = { name: "result", description: "answer schema", schema: { type: "object", properties: {} }, strict: true };
    const result = convertChatRequestToResponses({ model: "m", messages: [{ role: "user", content: "hi" }],
      max_tokens: 90, max_completion_tokens: 100, reasoning_effort: "high", response_format: { type: "json_schema", json_schema },
      stream: true, stream_options: { include_usage: true }, n: 1, store: false,
      temperature: 0, top_p: 0.9, metadata: { trace: "t" }, user: "u", service_tier: "auto",
      prompt_cache_key: "stable-key", prompt_cache_retention: "24h",
    });
    expect(result).toMatchObject({ max_output_tokens: 100, reasoning: { effort: "high" }, text: { format: { type: "json_schema", ...json_schema } },
      stream: true, store: false, temperature: 0, top_p: 0.9, metadata: { trace: "t" }, user: "u", service_tier: "auto",
      prompt_cache_key: "stable-key", prompt_cache_retention: "24h" });
    for (const field of ["messages", "max_tokens", "max_completion_tokens", "reasoning_effort", "response_format", "stream_options", "n"]) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it.each(["text", "json_object"])("maps %s response format and legacy max_tokens", (type) => {
    expect(convertChatRequestToResponses({ messages: [{ role: "user", content: "hi" }], response_format: { type }, max_tokens: 12 }))
      .toMatchObject({ max_output_tokens: 12, text: { format: { type } } });
  });

  it.each([
    ["n", { n: 2 }], ["store", { store: true }], ["stop", { stop: ["end"] }],
    ["logprobs", { logprobs: true }], ["audio", { audio: { voice: "alloy" } }],
    ["stream_options", { stream_options: { include_usage: true, unknown: true } }],
    ["tools[0]", { tools: [{ type: "custom", name: "patch" }] }],
    ["tool_choice", { tool_choice: { type: "custom", name: "patch" } }],
    ["response_format", { response_format: { type: "json_schema", json_schema: { schema: {} } } }],
  ])("rejects unsupported request semantics at %s", (field, extra) => {
    const body = { messages: [{ role: "user", content: "hi" }], ...extra as Record<string, unknown> };
    expect(unsupportedChatToResponsesFields(body)).toContain(field);
    expect(() => convertChatRequestToResponses(body)).toThrow("unsupported_chat_to_responses_fields");
  });

  it("rejects malformed message arrays rather than guessing semantics", () => {
    const cases = [
      [], [{ role: "function", content: "old role" }], [{ role: "tool", content: "missing call id" }],
      [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AA==", format: "wav" } }] }],
      [{ role: "assistant", content: [{ type: "image_url", image_url: { url: "https://images.example/a.png" } }] }],
      [{ role: "assistant", content: null, tool_calls: [{ type: "function", id: "call_1", function: { name: "f", arguments: {} } }] }],
      [{ role: "user", content: "hi", reasoning_details: [{ type: "reasoning", encrypted_content: "signed" }] }],
    ];
    for (const messages of cases) {
      expect(unsupportedChatToResponsesFields({ messages }).length).toBeGreaterThan(0);
      expect(() => convertChatRequestToResponses({ messages })).toThrow();
    }
  });

  it("rejects nested provider-owned fields instead of silently discarding them", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "hi", provider_signature: "signed" }] }] };
    expect(unsupportedChatToResponsesFields(body).length).toBeGreaterThan(0);
    expect(() => convertChatRequestToResponses(body)).toThrow();
  });
});

describe("Responses JSON to Chat conversion", () => {
  it("maps public identity, text and cached/reasoning usage without mutating the source", () => {
    const original = response({ output: [message("hello "), message("世界")] });
    const before = JSON.stringify(original);
    expect(convertResponsesToChatJson(original, publicModel)).toEqual({
      id: "resp_bridge", object: "chat.completion", created: 123, model: publicModel,
      choices: [{ index: 0, message: { role: "assistant", content: "hello 世界" }, finish_reason: "stop" }], usage: chatUsage,
    });
    expect(JSON.stringify(original)).toBe(before);
  });

  it("maps function call IDs and preserves argument strings, not parsed objects", () => {
    const result = convertResponsesToChatJson(response({ output: [
      { type: "function_call", id: "fc_internal", call_id: "call_public", name: "read", arguments: '{ "path": "a" }' },
      { type: "function_call", id: "fc_2", call_id: "call_2", name: "list", arguments: "{}" },
    ] }), publicModel);
    expect(result.choices[0]).toEqual({ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
      { id: "call_public", type: "function", function: { name: "read", arguments: '{ "path": "a" }' } },
      { id: "call_2", type: "function", function: { name: "list", arguments: "{}" } },
    ] } });
  });

  it("represents refusal separately from assistant text", () => {
    const output = [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "Cannot help." }] }];
    expect(convertResponsesToChatJson(response({ output }), publicModel).choices[0].message)
      .toEqual({ role: "assistant", content: null, refusal: "Cannot help." });
  });

  it.each([["max_output_tokens", "length"], ["content_filter", "content_filter"]])("maps incomplete reason %s", (reason, expected) => {
    const result = convertResponsesToChatJson(response({ status: "incomplete", incomplete_details: { reason }, output: [message("partial")] }), publicModel);
    expect(result.choices[0].finish_reason).toBe(expected);
    expect(result.usage).toEqual(chatUsage);
  });

  it("handles zero token usage, missing total and absent usage", () => {
    expect(convertResponsesToChatJson(response({ usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }), publicModel).usage)
      .toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    expect(convertResponsesToChatJson(response({ usage: { input_tokens: 3, output_tokens: 4 } }), publicModel).usage.total_tokens).toBe(7);
    expect(convertResponsesToChatJson(response({ usage: null }), publicModel)).not.toHaveProperty("usage");
  });

  it("round-trips opaque reasoning exactly, including provider-looking metadata", () => {
    const opaque = { id: "rs_1", type: "reasoning", encrypted_content: "signed+blob/==", summary: [{ type: "summary_text", text: "thinking" }],
      metadata: { model: "private-provider-model", nested: { signature: "do-not-redact" } } };
    const result = convertResponsesToChatJson(response({ output: [opaque, message("answer")] }), publicModel);
    expect(result.choices[0].message.reasoning_content).toBe("thinking");
    expect(result.choices[0].message.reasoning_details).toEqual([opaque]);
    const replay = convertChatRequestToResponses({ model: publicModel, messages: [result.choices[0].message, { role: "user", content: "next" }] });
    expect(replay.input[0]).toEqual(opaque);
    expect(replay.input[1]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "answer" }] });
  });

  it.each([
    { object: "chat.completion" }, { status: "failed" }, { status: "in_progress" },
    { output: [{ type: "web_search_call", id: "ws_1" }] },
    { output: [{ type: "message", content: [{ type: "output_audio", data: "AA==" }] }] },
    { output: [{ type: "message", content: [{ type: "output_text", text: 42 }] }] },
    { output: [{ type: "function_call", call_id: "call_1", name: "f", arguments: {} }] },
    { output: {} },
  ])("fails closed on invalid or unrepresentable JSON output %j", (overrides) => {
    expect(() => convertResponsesToChatJson(response(overrides), publicModel)).toThrow();
  });
});

describe("Responses SSE to Chat conversion", () => {
  it("decodes every-byte UTF-8 fragments and CRLF framing with one usage and DONE frame", async () => {
    const native = (frame("response.created", { response: response({ output: [], status: "in_progress", usage: null }) }) +
      frame("response.output_text.delta", { output_index: 0, content_index: 0, delta: "你好🌍" }) +
      terminal({ output: [message("你好🌍")] })).replace(/\n/g, "\r\n");
    const bytes = encoder.encode(native);
    const result = await convertStream(Array.from(bytes, (_, index) => bytes.slice(index, index + 1)));
    expect(result.chunks.every((chunk) => chunk.model === publicModel && chunk.object === "chat.completion.chunk")).toBe(true);
    expect(result.chunks.every((chunk) => chunk.id === "resp_bridge" && chunk.created === 123)).toBe(true);
    expect(deltas(result.chunks).filter((delta) => delta.role)).toEqual([{ role: "assistant", content: "" }]);
    expect(deltas(result.chunks).map((delta) => delta.content ?? "").join("")).toBe("你好🌍");
    expect(finishReasons(result.chunks)).toEqual(["stop"]);
    expect(result.chunks.filter((chunk) => chunk.usage)).toEqual([expect.objectContaining({ choices: [], usage: chatUsage })]);
    expect(result.payloads.filter((entry) => entry === "[DONE]")).toHaveLength(1);
  });

  it("uses terminal full output when no deltas were sent", async () => {
    const result = await convertStream([terminal({ output: [message("full output")] })]);
    expect(deltas(result.chunks).map((delta) => delta.content ?? "").join("")).toBe("full output");
    expect(finishReasons(result.chunks)).toEqual(["stop"]);
  });

  it("handles interleaved multiple tool deltas without duplicate names, IDs or argument text", async () => {
    const first = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a"}' };
    const second = { type: "function_call", id: "fc_2", call_id: "call_2", name: "list", arguments: "{}" };
    const result = await convertStream([
      frame("response.output_item.added", { output_index: 0, item: { ...first, arguments: "" } }),
      frame("response.output_item.added", { output_index: 1, item: { ...second, arguments: "" } }),
      frame("response.function_call_arguments.delta", { output_index: 0, delta: '{"path":' }),
      frame("response.function_call_arguments.delta", { output_index: 1, delta: "{}" }),
      frame("response.function_call_arguments.delta", { output_index: 0, delta: '"a"}' }),
      frame("response.output_item.done", { output_index: 0, item: first }),
      terminal({ output: [first, second] }),
    ]);
    const calls = deltas(result.chunks).flatMap((delta) => delta.tool_calls ?? []);
    expect(calls.filter((call) => call.id)).toEqual([
      { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } },
      { index: 1, id: "call_2", type: "function", function: { name: "list", arguments: "" } },
    ]);
    expect(calls.filter((call) => call.index === 0).map((call) => call.function.arguments ?? "").join("")).toBe(first.arguments);
    expect(calls.filter((call) => call.index === 1).map((call) => call.function.arguments ?? "").join("")).toBe(second.arguments);
    expect(finishReasons(result.chunks)).toEqual(["tool_calls"]);
  });

  it("does not duplicate refusal deltas when item.done and terminal repeat the full message", async () => {
    const item = { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "Not allowed" }] };
    const result = await convertStream([
      frame("response.refusal.delta", { output_index: 0, content_index: 0, delta: "Not " }),
      frame("response.refusal.delta", { output_index: 0, content_index: 0, delta: "allowed" }),
      frame("response.output_item.done", { output_index: 0, item }), terminal({ output: [item] }),
    ]);
    expect(deltas(result.chunks).map((delta) => delta.refusal ?? "").join("")).toBe("Not allowed");
    expect(finishReasons(result.chunks)).toEqual(["stop"]);
  });

  it("preserves opaque reasoning from done once and replays it losslessly", async () => {
    const item = { type: "reasoning", id: "rs_1", encrypted_content: "signed-opaque", summary: [{ type: "summary_text", text: "思考" }], metadata: { model: "private-provider-model" } };
    const result = await convertStream([
      frame("response.reasoning_summary_text.delta", { output_index: 0, delta: "思考" }),
      frame("response.output_item.done", { output_index: 0, item }), terminal({ output: [item, message("ok")] }),
    ]);
    const details = deltas(result.chunks).flatMap((delta) => delta.reasoning_details ?? []);
    expect(details).toEqual([item]);
    expect(deltas(result.chunks).map((delta) => delta.reasoning_content ?? "").join("")).toBe("思考");
    expect(convertChatRequestToResponses({ messages: [{ role: "assistant", content: "ok", reasoning_details: details }] }).input[0]).toEqual(item);
  });

  it.each([["max_output_tokens", "length"], ["content_filter", "content_filter"]])("maps incomplete SSE reason %s and retains final usage", async (reason, expected) => {
    const result = await convertStream([frame("response.incomplete", { response: response({ status: "incomplete", incomplete_details: { reason }, output: [message("partial")] }) })]);
    expect(finishReasons(result.chunks)).toEqual([expected]);
    expect(result.chunks.find((chunk) => chunk.usage).usage).toEqual(chatUsage);
    expect(result.payloads.at(-1)).toBe("[DONE]");
  });

  it("ignores heartbeats, comments and trailing provider DONE after a valid terminal", async () => {
    const result = await convertStream([": heartbeat\n\n", terminal(), "data: [DONE]\n\n", "data: malformed trailing data\n\n"]);
    expect(result.chunks.filter((chunk) => chunk.error)).toEqual([]);
    expect(finishReasons(result.chunks)).toEqual(["stop"]);
    expect(result.payloads.filter((entry) => entry === "[DONE]")).toHaveLength(1);
  });

  it.each([
    ["empty", ""], ["truncated event", 'data: {"type":"response.completed"'],
    ["missing terminal", frame("response.output_text.delta", { delta: "partial" })],
    ["bare DONE", "data: [DONE]\n\n"], ["malformed JSON", "data: {not-json}\n\n"],
    ["missing event type", 'data: {"delta":"text"}\n\n'],
    ["event mismatch", 'event: response.completed\ndata: {"type":"response.output_text.delta","delta":"text"}\n\n'],
    ["failed", frame("response.failed", { response: response({ status: "failed", error: { message: "secret-upstream-name" } }) })],
    ["error", frame("error", { error: { message: "secret-upstream-name" } })],
    ["invalid terminal status", frame("response.completed", { response: response({ status: "in_progress" }) })],
    ["invalid output index", frame("response.output_text.delta", { output_index: -1, delta: "text" })],
    ["invalid content index", frame("response.output_text.delta", { content_index: 4097, delta: "text" })],
    ["arguments without call start", frame("response.function_call_arguments.delta", { output_index: 0, delta: "{}" })],
    ["unsupported output", terminal({ output: [{ type: "web_search_call" }] })],
    ["non-string delta", frame("response.output_text.delta", { delta: { text: "not a string" } }) + terminal()],
  ])("fails closed for %s without a success finish", async (_label, source) => {
    const result = await convertStream([source]);
    expectStreamError(result);
    expect(result.text).not.toContain("secret-upstream-name");
  });

  it("rejects oversize fragmented events with one terminal error", async () => {
    const result = await convertStream(["data: ", "x".repeat(MAX_NATIVE_EVENT_CHARS), "\n\n", terminal()]);
    expectStreamError(result);
  });

  it.each([
    new Uint8Array([0xc3, 0x28]),
    new Uint8Array([0xf0, 0x9f, 0x8c]),
  ])("rejects malformed or truncated UTF-8 bytes %#", async (bytes) => {
    expectStreamError(await convertStream([bytes]));
  });
});
