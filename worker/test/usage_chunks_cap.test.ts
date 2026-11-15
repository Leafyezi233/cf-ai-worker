import { describe, expect, it } from "vitest";
import { appendCapped } from "../src/gateway/proxy";

describe("usage capture buffer is capped", () => {
  const LIMIT = 32 * 1024;

  it("keeps small appends verbatim", () => {
    expect(appendCapped("", "abc")).toBe("abc");
    expect(appendCapped("abc", "def")).toBe("abcdef");
  });

  it("keeps at most the limit", () => {
    const big = "x".repeat(LIMIT);
    expect(appendCapped("", big).length).toBe(LIMIT);
    expect(appendCapped(big, "y").length).toBe(LIMIT);
  });

  it("drops the OLDEST bytes, keeping the newest window", () => {
    const first = "A".repeat(LIMIT);
    const result = appendCapped(first, "TAIL");
    expect(result.length).toBe(LIMIT);
    expect(result.endsWith("TAIL")).toBe(true);
    expect(result.startsWith("AAAA")).toBe(true);
    expect(result.includes("T")).toBe(true);
  });

  it("does not grow when a chatty answer keeps matching the capture filter", () => {
    let buffer = "";
    const chunk = 'data: {"choices":[{"delta":{"content":"tokens tokens"}}]}\n\n';
    for (let i = 0; i < 5000; i++) buffer = appendCapped(buffer, chunk);
    expect(buffer.length).toBeLessThanOrEqual(LIMIT);
    expect(buffer.length).toBe(LIMIT);
  });

  it("preserves a usage frame that arrives last even after a large body", () => {
    let buffer = "";
    for (let i = 0; i < 500; i++) {
      buffer = appendCapped(buffer, 'data: {"choices":[{"delta":{"content":"tokens"}}]}\n\n');
    }
    const usageFrame = 'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":6}}';
    buffer = appendCapped(buffer, usageFrame);
    expect(buffer.includes(usageFrame)).toBe(true);
  });
});
