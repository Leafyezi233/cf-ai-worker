import { describe, expect, it } from "vitest";
import { detectRepetitionLoop } from "../src/gateway/responses_adapter";

describe("detectRepetitionLoop predicate is unchanged", () => {
  it("flags three repetitions of a long phrase", () => {
    const phrase = "the same sentence repeated";
    const result = detectRepetitionLoop("intro text. " + phrase.repeat(3));
    expect(result.isLoop).toBe(true);
    expect(result.loopPattern).toBe(phrase);
  });

  it("ignores text shorter than the minimum window", () => {
    expect(detectRepetitionLoop("ab").isLoop).toBe(false);
    expect(detectRepetitionLoop("a".repeat(35)).isLoop).toBe(false);
  });

  it("ignores ordinary prose", () => {
    expect(detectRepetitionLoop("This is a normal answer with varied wording and no repeats.").isLoop).toBe(false);
  });

  it("ignores separator lines even though they repeat", () => {
    const rule = "=".repeat(30);
    expect(detectRepetitionLoop("text " + rule.repeat(3)).isLoop).toBe(false);
    const dash = "-".repeat(30);
    expect(detectRepetitionLoop("text " + dash.repeat(3)).isLoop).toBe(false);
  });

  it("ignores a repeated pattern with fewer than four distinct characters", () => {
    const pattern = "abababababababab";
    expect(detectRepetitionLoop("x " + pattern.repeat(3)).isLoop).toBe(false);
  });

  it("ignores a pattern whose trimmed form is shorter than 12 characters", () => {
    const pattern = "   abcd     ";
    expect(pattern.trim().length).toBeLessThan(12);
    expect(new Set(pattern.trim()).size).toBeGreaterThanOrEqual(4);
    expect(detectRepetitionLoop("x".repeat(40) + pattern.repeat(3)).isLoop).toBe(false);
  });

  it("only inspects the tail, so a loop far in the past is not reported", () => {
    const phrase = "the same sentence repeated";
    const old = phrase.repeat(3) + " " + "y".repeat(700);
    expect(detectRepetitionLoop(old).isLoop).toBe(false);
  });

  it("stays cheap enough to run on every delta", () => {
    let text = "";
    const started = Date.now();
    for (let i = 0; i < 400; i++) {
      text += "这是第" + i + "个token的内容";
      detectRepetitionLoop(text);
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(250);
  });
});
