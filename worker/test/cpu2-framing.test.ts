import { expect, it } from "vitest";
import { UsageAccumulator } from "../src/gateway/usage_accumulator";
import { BaselineUsageAccumulator as Baseline } from "./cpu2-usage-baseline";
const enc = new TextEncoder();
const frame = (o: unknown) => "data: " + JSON.stringify(o) + "\n\n";
it("matches saved dirty baseline at every chunk and EOF for CPG framing/usage semantics", () => {
  const cases = [
    "", "   ", "data: [DONE]", "event: error\ndata: not-json", "data: [DONE]\r", "data: [DONE]\r\n\r\n",
    'event: response.completed\r\ndata: {\r\ndata: "response":{"request_id":"请求🙂","usage":{"input_tokens":0,"output_tokens":2}}}\r\n\r\n',
    frame({ usage: { prompt_tokens: 0 } }) + frame({ usage: { completion_tokens: 3 } }) + "data: [DONE]\n\n",
    frame({ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 3 } } } }) + frame({ type: "message_delta", usage: { cache_creation: { ephemeral_1h_input_tokens: 4 } } }) + "event: message_stop\n",
    frame({ type: "response.failed", response: { usage: { input_tokens: 2, output_tokens: 0 } } }) + "data: [DONE]\n\n",
    frame({ choices: [{ delta: { content: 'hello🙂 usage tokens "request_id":"fake"' } }] }),
    ...[65520, 65527, 65528, 65529, 65530, 65535, 65536, 65537, 150000].map(n => "data: " + "x".repeat(n) + "\r\n\r\n" + frame({ usage: { input_tokens: 2, output_tokens: 3 } }) + "data: [DONE]"),
    ":" + "x".repeat(65535) + "\n\n" + frame({ usage: { input_tokens: 0, output_tokens: 0 } }),
    "data: " + JSON.stringify({ usage: { input_tokens: 1, output_tokens: 2 }, padding: "x".repeat(70000) }),
    JSON.stringify({ usage: { input_tokens: 2, output_tokens: 3 } }),
  ];
  for (const protocol of ["messages", "chat/completions", "responses"] as const) for (const text of cases) {
    const bytes = enc.encode(text);
    for (const width of text.length > 1000 ? [4095, 4096, 200000] : [1, 2, 7, 4096]) {
      const before = new Baseline(protocol), after = new UsageAccumulator(protocol);
      for (let at = 0; at < bytes.length; at += width) {
        const chunk = bytes.subarray(at, at + width); before.push(chunk); after.push(chunk);
        expect(after.snapshot()).toEqual(before.snapshot());
        const state = after as unknown as { line: string; data: string[]; json: string };
        expect(state.line.length + state.data.join("").length + state.json.length).toBeLessThanOrEqual(65537);
      }
      expect(after.finish()).toEqual(before.finish()); expect(after.finish()).toEqual(before.finish());
    }
  }
});
it("covers mixed CR/LF spans, malformed fields and randomized chunk splits against CPG baseline", () => {
  let seed = 20261112;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const lines = ["", ":comment", "data:", "data: [DONE]", "event: response.completed", "event: error", "retry: 1", "data: {bad}", 'data: {"request_id":"请求🙂","usage":{"input_tokens":0,"output_tokens":1}}', "data: {}", "event", "data:  {}"];
  for (const protocol of ["messages", "chat/completions", "responses"] as const) for (let test = 0; test < 100; test++) {
    let text = ""; for (let i = 0; i < 20; i++) text += lines[random(lines.length)] + ["\n", "\r", "\r\n"][random(3)];
    if (random(2)) text += lines[random(lines.length)];
    const bytes = enc.encode(text), before = new Baseline(protocol), after = new UsageAccumulator(protocol);
    for (let at = 0; at < bytes.length;) { const width = 1 + random(17), chunk = bytes.subarray(at, at + width); before.push(chunk); after.push(chunk); at += width; expect(after.snapshot()).toEqual(before.snapshot()); }
    expect(after.finish()).toEqual(before.finish());
  }
});
it("semantic revision ignores text/duplicates but tracks zeros, provenance, ID and terminal facts", () => {
  const a = new UsageAccumulator("chat/completions") as UsageAccumulator & { revision: number };
  expect(a.revision).toBe(0); a.push(enc.encode(frame({ choices: [{ delta: { content: "x" } }] }))); expect(a.revision).toBe(0);
  for (const obj of [{ usage: { prompt_tokens: 0 } }, { usage: { input_tokens: 0 } }, { request_id: "new" }, { usage: { completion_tokens: 0 } }, { error: {} }]) {
    const old = a.revision; a.observeJson(obj); expect(a.revision).toBeGreaterThan(old);
    const changed = a.revision; a.observeJson(obj); expect(a.revision).toBe(changed);
  }
  const old = a.revision; a.push(enc.encode("data: [DONE]\n\n")); a.finish(); expect(a.revision).toBe(old);
});
