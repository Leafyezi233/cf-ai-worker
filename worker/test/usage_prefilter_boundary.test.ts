import { describe, expect, it } from "vitest";
import { parseUsage } from "../src/gateway/usage";

describe("usage prefilter boundary", () => {
  it("reads every shape a real provider emits", () => {
    expect(parseUsage("openai", 'data: {"usage":{"prompt_tokens":5,"completion_tokens":6}}')).not.toBeNull();
    expect(parseUsage("gemini", 'data: {"usageMetadata":{"promptTokenCount":5}}')).not.toBeNull();
    expect(parseUsage("anthropic", 'data: {"message":{"usage":{"input_tokens":5}}}')).not.toBeNull();
  });

  it("DOCUMENTED GAP: an escaped \\u0075sage key is not seen", () => {
    const escaped = 'data: {"\\u0075sage":{"prompt_tokens":5,"completion_tokens":6}}';
    expect(escaped.includes("usage")).toBe(false);
    expect(parseUsage("openai", escaped)).toBeNull();
  });

  it("a non-streamed body still parses even without a literal usage hit", () => {
    expect(parseUsage("openai", '{"usage":{"prompt_tokens":1,"completion_tokens":2}}')).not.toBeNull();
  });
});
