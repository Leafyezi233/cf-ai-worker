import { describe, expect, it } from "vitest";
import { UsageAccumulator, type UsageSnapshot } from "../src/gateway/usage_accumulator";
import { createChatToResponsesTransform, type ChatToResponsesFinishMetadata } from "../src/gateway/responses_adapter";

const encoder = new TextEncoder();
function event(obj: unknown, name?: string): string {
  return `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(obj)}\n\n`;
}
function pushText(acc: UsageAccumulator, text: string, width = 7): void {
  const bytes = encoder.encode(text);
  for (let at = 0; at < bytes.length; at += width) acc.push(bytes.subarray(at, at + width));
}

describe("original-wire UsageAccumulator", () => {
  it("keeps explicitly reported zero distinct from absent usage", () => {
    const absent = new UsageAccumulator("chat/completions");
    absent.observeJson({ usage: {} });
    expect(absent.finish()).toMatchObject({ usage: null, source: "unknown", completed: false });
    const zero = new UsageAccumulator("chat/completions");
    pushText(zero, event({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) + "data: [DONE]\n\n");
    expect(zero.finish()).toMatchObject({
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      source: "reported_final", completed: true, failed: false,
      provenance: { input_tokens: "usage.prompt_tokens", output_tokens: "usage.completion_tokens", total_tokens: "usage.total_tokens" },
    });
  });

  it("preserves field-level missing versus zero in partial reports", () => {
    const acc = new UsageAccumulator("responses");
    acc.observeJson({ type: "response.completed", response: { usage: { input_tokens: 0 }, status: "completed" } });
    const partial = acc.finish();
    expect(partial.source).toBe("reported_partial");
    expect(partial.completed).toBe(true);
    expect(partial.usage?.input_tokens).toBe(0);
    expect(partial.provenance.input_tokens).toBe("response.usage.input_tokens");
    expect(partial.provenance.output_tokens).toBeUndefined();
    expect(partial.provenance.total_tokens).toBe("derived:reported_fields");
  });

  it("merges cumulative snapshots without double charging and accepts a later explicit correction to zero", () => {
    const acc = new UsageAccumulator("chat/completions");
    const report = { usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, completion_tokens_details: { reasoning_tokens: 3 } } };
    pushText(acc, event(report) + event(report));
    expect(acc.snapshot().usage).toMatchObject({ input_tokens: 12, output_tokens: 5, total_tokens: 17, reasoning_tokens: 3 });
    acc.observeJson({ usage: { completion_tokens: 0, total_tokens: 12, completion_tokens_details: { reasoning_tokens: 0 } } });
    pushText(acc, "data: [DONE]\n\n");
    expect(acc.finish()).toMatchObject({
      source: "reported_final",
      usage: { input_tokens: 12, output_tokens: 0, total_tokens: 12, reasoning_tokens: 0 },
    });
  });

  it("merges Messages start and delta usage with outside-input cache and reasoning as an output subset", () => {
    const acc = new UsageAccumulator("messages");
    pushText(acc, event({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 7 } } } }));
    pushText(acc, event({ type: "message_delta", usage: { output_tokens: 8, output_tokens_details: { thinking_tokens: 6 }, server_tool_use: { web_search_requests: 1 } } }));
    pushText(acc, event({ type: "message_delta", usage: { output_tokens: 8, server_tool_use: { web_search_requests: 1 } } }));
    pushText(acc, event({ type: "message_stop" }));
    expect(acc.finish()).toMatchObject({
      source: "reported_final", completed: true,
      usage: { input_tokens: 10, output_tokens: 8, total_tokens: 68, cache_read_tokens: 40, cache_write_tokens: 10, cache_read_included_in_input: false, reasoning_tokens: 6, search_calls: 1 },
    });
  });

  it("keeps a flat zero cache creation total authoritative over simultaneous nonzero TTL buckets", () => {
    const acc = new UsageAccumulator("messages");
    acc.observeJson({ type: "message", stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } } });
    expect(acc.finish()).toMatchObject({ source: "reported_final", usage: { cache_write_tokens: 0, total_tokens: 0 } });
  });

  it("accepts native Messages stop names and drains a final unterminated event", () => {
    for (const type of ["message_stop", "messages_stop"]) {
      const acc = new UsageAccumulator("messages");
      pushText(acc, event({ type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } })
        + `event: ${type}\ndata: {}`);
      expect(acc.finish()).toMatchObject({ completed: true, source: "reported_final", usage: { total_tokens: 0 } });
    }
  });

  it("uses actual Responses wire semantics for cached and reasoning tokens", () => {
    const acc = new UsageAccumulator("responses");
    pushText(acc, event({ type: "response.completed", response: { status: "completed", request_id: "req-native", usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 15 } } } }));
    expect(acc.finish()).toMatchObject({
      source: "reported_final", upstreamRequestId: "req-native",
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, cache_read_tokens: 80, cache_read_included_in_input: true, reasoning_tokens: 15 },
    });
  });

  it("decodes fragmented UTF8, split CRLF and multiline SSE JSON with event-name terminals", () => {
    const acc = new UsageAccumulator("responses");
    const frame = "event: response.completed\r\ndata: {\r\ndata: \"response\": {\"request_id\": \"请求-🙂\",\r\ndata: \"usage\": {\"input_tokens\": 2, \"output_tokens\": 3}}}\r\n\r\n";
    pushText(acc, frame, 1);
    expect(acc.finish()).toMatchObject({
      source: "reported_final", completed: true, upstreamRequestId: "请求-🙂",
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });
  });

  it.each(["response.failed", "response.incomplete", "response.error", "error"])("keeps %s sticky despite a later DONE or completed event", (terminal) => {
    const acc = new UsageAccumulator("responses");
    pushText(acc, event({ type: terminal, response: { usage: { input_tokens: 2, output_tokens: 3 } } })
      + "data: [DONE]\n\n" + event({ type: "response.completed" }));
    expect(acc.finish()).toMatchObject({ source: "reported_partial", failed: true, completed: false });
  });

  it("records an envelope error and a non-JSON SSE error without retaining its body", () => {
    for (const wire of [event({ error: { message: "private upstream error" } }), "event: error\ndata: private upstream error\n\ndata: [DONE]\n\n"]) {
      const acc = new UsageAccumulator("chat/completions");
      pushText(acc, wire);
      expect(acc.finish()).toEqual({ usage: null, source: "unknown", provenance: {}, failed: true, completed: false, upstreamRequestId: null });
    }
  });

  it("does not mistake truncated EOF or streaming finish_reason for a native terminal", () => {
    const acc = new UsageAccumulator("chat/completions");
    pushText(acc, event({ choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
    expect(acc.finish()).toMatchObject({ source: "reported_partial", completed: false, failed: false });
  });

  it("supports bounded JSON bodies and large already-parsed JSON without storing content", () => {
    const bounded = new UsageAccumulator("chat/completions");
    pushText(bounded, JSON.stringify({ object: "chat.completion", usage: { prompt_tokens: 1, completion_tokens: 2 } }), 1);
    expect(bounded.finish()).toMatchObject({ source: "reported_final", usage: { total_tokens: 3 } });
    const large = new UsageAccumulator("messages");
    large.observeJson({ type: "message", stop_reason: "end_turn", content: [{ text: "private".repeat(100000) }], usage: { input_tokens: 0, output_tokens: 0 } });
    expect(large.finish()).toMatchObject({ source: "reported_final", usage: { total_tokens: 0 } });
    expect(JSON.stringify(large)).not.toContain("private");
  });

  it("drops oversized SSE events whole and recovers at the next event boundary", () => {
    const acc = new UsageAccumulator("chat/completions");
    pushText(acc, `data: {"content":"${"x".repeat(70000)}"}\ndata: {"usage":{"prompt_tokens":900,"completion_tokens":900}}\n\n`, 1024);
    expect(acc.snapshot().usage).toBeNull();
    pushText(acc, event({ usage: { prompt_tokens: 2, completion_tokens: 1 } }) + "data: [DONE]\n\n");
    expect(acc.finish()).toMatchObject({ source: "reported_final", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } });
  });

  it("drops oversized JSON bytes instead of mining the tail for usage", () => {
    const acc = new UsageAccumulator("chat/completions");
    pushText(acc, JSON.stringify({ object: "chat.completion", content: "x".repeat(70000), usage: { prompt_tokens: 900, completion_tokens: 900 } }), 1024);
    expect(acc.finish().usage).toBeNull();
  });

  it("ignores usage impostors in tool arguments, signatures, nested content and non-envelope events", () => {
    const fake = { usage: { input_tokens: 999, output_tokens: 999, prompt_tokens: 999, completion_tokens: 999 } };
    const chat = new UsageAccumulator("chat/completions");
    chat.observeJson({ choices: [{ delta: { content: JSON.stringify(fake), tool_calls: [{ function: { arguments: JSON.stringify(fake) } }], reasoning_details: [{ signature: JSON.stringify(fake), ...fake }] } }], message: fake });
    chat.observeJson({ type: "tool_result", ...fake });
    expect(chat.finish().usage).toBeNull();
    const messages = new UsageAccumulator("messages");
    messages.observeJson({ type: "content_block_delta", delta: { type: "signature_delta", signature: JSON.stringify(fake), ...fake }, ...fake });
    expect(messages.finish().usage).toBeNull();
    const responses = new UsageAccumulator("responses");
    responses.observeJson({ type: "response.function_call_arguments.delta", delta: JSON.stringify(fake), ...fake });
    responses.observeJson({ type: "response.completed", response: { output: [{ content: [fake], arguments: JSON.stringify(fake) }] } });
    expect(responses.finish().usage).toBeNull();
  });

  it("ignores invalid counts, does not confuse response IDs with request IDs, and returns detached snapshots", () => {
    const acc = new UsageAccumulator("responses");
    acc.observeJson({ id: "resp-not-request", usage: { input_tokens: -1, output_tokens: "2", total_tokens: NaN } });
    expect(acc.snapshot().usage).toBeNull();
    acc.observeJson({ usage: { input_tokens: 0, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 } } });
    const copy = acc.snapshot();
    copy.usage!.input_tokens = 999;
    copy.provenance.output_tokens = "tampered";
    const final = acc.finish();
    expect(final).toMatchObject({ upstreamRequestId: null, usage: { input_tokens: 0, output_tokens: 2, reasoning_tokens: 0 } });
    expect(final.provenance.output_tokens).toBe("usage.output_tokens");
    expect(acc.finish()).toEqual(final);
    acc.observeJson({ usage: { input_tokens: 999 } });
    expect(acc.snapshot()).toEqual(final);
  });
});

async function adapt(wire: string, original?: () => UsageSnapshot) {
  let metadata: ChatToResponsesFinishMetadata | undefined;
  const transform = createChatToResponsesTransform("resp-fixture", "fixture", (_text, meta) => { metadata = meta; }, 99, undefined, original);
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(wire)); controller.close(); } });
  const text = await new Response(body.pipeThrough(transform)).text();
  const events = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  const terminal = events.find((obj) => ["response.completed", "response.failed", "response.incomplete"].includes(obj.type));
  return { metadata, terminal };
}

describe("Responses adapter original usage metadata", () => {
  it("reports upstream zero to callback and final client usage without minimum-one or prompt estimates", async () => {
    const { metadata, terminal } = await adapt(event({ choices: [{ delta: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) + "data: [DONE]\n\n");
    expect(metadata).toMatchObject({ usage_source: "reported_final", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, billableCall: true });
    expect(terminal.response.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  });

  it("preserves original reasoning and cached counts in both callback and emitted usage", async () => {
    const { metadata, terminal } = await adapt(event({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 15 } } }) + "data: [DONE]\n\n");
    expect(metadata?.usage).toMatchObject({ input_tokens: 100, output_tokens: 20, total_tokens: 120, reasoning_tokens: 15, cache_read_tokens: 80 });
    expect(terminal.response.usage).toEqual({ input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 15 } });
  });

  it("uses the original-wire supplier instead of treating converted reports as authoritative", async () => {
    const original = new UsageAccumulator("messages");
    original.observeJson({ type: "message", stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 6, output_tokens_details: { thinking_tokens: 5 } } });
    const { metadata, terminal } = await adapt(event({ usage: { prompt_tokens: 400, completion_tokens: 600 } }) + "data: [DONE]\n\n", () => original.snapshot());
    expect(metadata?.usage).toMatchObject({ input_tokens: 4, output_tokens: 6, reasoning_tokens: 5 });
    expect(terminal.response.usage).toMatchObject({ input_tokens: 4, output_tokens: 6, total_tokens: 10, output_tokens_details: { reasoning_tokens: 5 } });
  });

  it("uses estimates only for unreported fields and marks raw metadata partial", async () => {
    const { metadata, terminal } = await adapt(event({ choices: [{ delta: { content: "hello" } }], usage: { prompt_tokens: 0 } }) + "data: [DONE]\n\n");
    expect(metadata?.usage_source).toBe("reported_partial");
    expect(metadata?.usage_provenance?.output_tokens).toBeUndefined();
    expect(terminal.response.usage).toMatchObject({ input_tokens: 0, output_tokens: 2, total_tokens: 2 });
  });

  it("does not emit successful completion after an upstream error followed by DONE", async () => {
    const { metadata, terminal } = await adapt(event({ error: { message: "provider details" }, usage: { prompt_tokens: 2, completion_tokens: 0 } }) + "data: [DONE]\n\n");
    expect(terminal.type).toBe("response.failed");
    expect(metadata).toMatchObject({ billableCall: false, usage_source: "reported_partial" });
  });
});
