import { describe, expect, it } from "vitest";
import { stripVolatileMetadata } from "../src/gateway/cache";


const OPEN = "<ADDITIONAL_METADATA>";

function timed(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

describe("stripVolatileMetadata cannot be turned into a CPU bomb", () => {
  it("strips a normal paired block the same way as before", () => {
    expect(stripVolatileMetadata("a<ADDITIONAL_METADATA>ts</ADDITIONAL_METADATA>b")).toBe("ab");
    expect(stripVolatileMetadata("a<additional_metadata>ts</ADDITIONAL_METADATA>b")).toBe("ab");
    expect(stripVolatileMetadata("a<Additional_Metadata>ts</additional_metadata>b")).toBe("ab");
    expect(stripVolatileMetadata("<ADDITIONAL_METADATA>1</ADDITIONAL_METADATA>x<ADDITIONAL_METADATA>2</ADDITIONAL_METADATA>")).toBe("x");
  });

  it("leaves an unclosed block in place instead of swallowing the prompt", () => {
    const input = "keep me <ADDITIONAL_METADATA>no closing tag";
    expect(stripVolatileMetadata(input)).toBe(input);
  });

  it("stays linear on thousands of unmatched opening tags", () => {
    const hostile = OPEN.repeat(5000) + "x".repeat(200 * 1024);
    const ms = timed(() => stripVolatileMetadata(hostile));
    expect(hostile.length).toBeGreaterThan(200 * 1024);
    expect(ms).toBeLessThan(250);
  });

  it("stays linear on a 4 MB all-unmatched body", () => {
    const hostile = OPEN.repeat(Math.floor((4 * 1024 * 1024) / OPEN.length));
    const ms = timed(() => stripVolatileMetadata(hostile));
    expect(ms).toBeLessThan(250);
  });

  it("stays linear on a 4 MB body with one real block and a huge payload", () => {
    const big = OPEN + "ts</ADDITIONAL_METADATA>" + "x".repeat(4 * 1024 * 1024);
    const ms = timed(() => stripVolatileMetadata(big));
    expect(ms).toBeLessThan(250);
    expect(stripVolatileMetadata(OPEN + "ts</ADDITIONAL_METADATA>tail")).toBe("tail");
  });
});
