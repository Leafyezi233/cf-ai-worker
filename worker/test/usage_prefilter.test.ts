import { describe, expect, it } from "vitest";
import { parseUsage } from "../src/gateway/usage";

describe("parseUsage is not blinded by the usage prefilter", () => {
  it("still reads an OpenAI-style usage block", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}',
      "data: [DONE]",
    ].join("\n");
    const usage = parseUsage("openai", sse);
    expect(usage).not.toBeNull();
    expect(usage!.input_tokens).toBe(10);
    expect(usage!.output_tokens).toBe(20);
  });

  it("still reads Gemini usageMetadata", () => {
    const sse = 'data: {"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":9,"totalTokenCount":16}}';
    const usage = parseUsage("gemini", sse);
    expect(usage).not.toBeNull();
    expect(usage!.input_tokens).toBe(7);
    expect(usage!.output_tokens).toBe(9);
  });

  it("still reads Anthropic message.usage", () => {
    const sse = [
      'data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":11,"cache_read_input_tokens":4}}}',
      'data: {"type":"message_delta","usage":{"output_tokens":6}}',
    ].join("\n");
    const usage = parseUsage("anthropic", sse);
    expect(usage).not.toBeNull();
    expect(usage!.input_tokens).toBe(11);
    expect(usage!.output_tokens).toBe(6);
    expect(usage!.cache_read_tokens).toBe(4);
  });

  it("still reads a non-streamed JSON body", () => {
    const usage = parseUsage("openai", '{"usage":{"prompt_tokens":3,"completion_tokens":4}}');
    expect(usage).not.toBeNull();
    expect(usage!.input_tokens).toBe(3);
    expect(usage!.output_tokens).toBe(4);
  });

  it("returns null when no frame reports usage", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"a"}}]}',
      'data: {"choices":[{"delta":{"content":"b"}}]}',
      "data: [DONE]",
    ].join("\n");
    expect(parseUsage("openai", sse)).toBeNull();
  });

  it("keeps a usage frame that arrives after thousands of ordinary frames", () => {
    const frames: string[] = [];
    for (let i = 0; i < 3000; i++) frames.push('data: {"choices":[{"delta":{"content":"x"}}]}');
    frames.push('data: {"choices":[],"usage":{"prompt_tokens":123,"completion_tokens":456}}');
    frames.push("data: [DONE]");
    const usage = parseUsage("openai", frames.join("\n"));
    expect(usage).not.toBeNull();
    expect(usage!.input_tokens).toBe(123);
    expect(usage!.output_tokens).toBe(456);
  });
});
