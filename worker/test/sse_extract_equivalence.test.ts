import { describe, expect, it } from "vitest";
import { extractTextFromSse } from "../src/gateway/proxy";

describe("extractTextFromSse keeps the JSON.parse contract", () => {
  it("concatenates content deltas and ignores [DONE]", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      "data: [DONE]",
    ].join("\n");
    expect(extractTextFromSse("chat/completions", sse)).toBe("Hello world");
  });

  it("decodes JSON escapes", () => {
    const sse = 'data: {"choices":[{"delta":{"content":"a\\\"b\\\\c\\nd"}}]}';
    expect(extractTextFromSse("chat/completions", sse)).toBe('a"b\\c\nd');
  });

  it("decodes \\uXXXX escapes", () => {
    const sse = 'data: {"choices":[{"delta":{"content":"\\u4f60\\u597d"}}]}';
    expect(extractTextFromSse("chat/completions", sse)).toBe("\u4f60\u597d");
  });

  it("skips frames whose delta carries no text", () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":null}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"t","function":{"name":"f","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}',
    ].join("\n");
    expect(extractTextFromSse("chat/completions", sse)).toBe("ok");
  });

  it("finds content when a nested object sits BEFORE it in the delta", () => {
    const sse = 'data: {"choices":[{"delta":{"function_call":{"name":"f"},"content":"Y"}}]}';
    expect(extractTextFromSse("chat/completions", sse)).toBe("Y");
  });

  it("finds content when a nested object sits AFTER it", () => {
    const sse = 'data: {"choices":[{"delta":{"content":"X","extra":{"a":1}}}]}';
    expect(extractTextFromSse("chat/completions", sse)).toBe("X");
  });

  it("does not let a brace inside the answer text unbalance the scan", () => {
    const sse = 'data: {"choices":[{"delta":{"content":"a } b { c"}}]}';
    expect(extractTextFromSse("chat/completions", sse)).toBe("a } b { c");
  });

  it("does not pick up a delta quoted inside the answer text", () => {
    const sse = 'data: {"choices":[{"delta":{"content":"say \\"delta\\": {\\"content\\": \\"x\\"}"}}]}';
    expect(extractTextFromSse("chat/completions", sse)).toBe('say "delta": {"content": "x"}');
  });

  it("reads only the FIRST choice, matching the previous choices[0] behaviour", () => {
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"A"}},{"index":1,"delta":{"content":"B"}}]}';
    expect(extractTextFromSse("chat/completions", sse)).toBe("A");
  });

  it("extracts Anthropic text_delta and ignores thinking_delta", () => {
    const sse = [
      'data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":5}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ok"}}',
      'data: {"type":"message_stop"}',
    ].join("\n");
    expect(extractTextFromSse("messages", sse)).toBe("ok");
  });

  it("tolerates keepalive comments and empty input", () => {
    expect(extractTextFromSse("chat/completions", "")).toBe("");
    expect(
      extractTextFromSse("chat/completions", ': keepalive\n\ndata: {"choices":[{"delta":{"content":"k"}}]}')
    ).toBe("k");
  });

  it("ignores a text field on a non content_block_delta event", () => {
    const sse = [
      'data: {"type":"message_delta","delta":{"text":"NOT-ANSWER"},"usage":{"output_tokens":3}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"real"}}',
    ].join("\n");
    expect(extractTextFromSse("messages", sse)).toBe("real");
  });

  it("ignores a chat frame whose delta has no delta object at all", () => {
    const sse = [
      'data: {"choices":[{"index":0,"finish_reason":"stop"}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"z"}}]}',
    ].join("\n");
    expect(extractTextFromSse("chat/completions", sse)).toBe("z");
  });
});
