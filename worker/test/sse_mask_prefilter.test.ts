import { describe, expect, it } from "vitest";
import { modelMaskingTransform } from "../src/gateway/caller_identity";

async function runMask(publicModel: string, input: string): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(input));
      controller.close();
    },
  });
  const reader = stream.pipeThrough(modelMaskingTransform(publicModel)).getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const frame = (model: string, content = "hi") =>
  'data: ' + JSON.stringify({ id: "c", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content } }] });

describe("SSE model masking", () => {
  it("leaves a frame untouched when the model already matches", async () => {
    const input = frame("gw-primary") + "\n\n";
    expect(await runMask("gw-primary", input)).toBe(input);
  });

  it("rewrites a foreign model name", async () => {
    const out = await runMask("gw-primary", frame("deepseek-chat") + "\n\n");
    expect(out).toContain('"model":"gw-primary"');
    expect(out).not.toContain("deepseek-chat");
  });

  it("rewrites a nested message.model (Anthropic message_start)", async () => {
    const input =
      "data: " +
      JSON.stringify({ type: "message_start", message: { id: "m", model: "claude-real" } }) +
      "\n\n";
    const out = await runMask("gw-primary", input);
    expect(out).toContain('"model":"gw-primary"');
    expect(out).not.toContain("claude-real");
  });

  it("rewrites a nested response.model (Responses API event)", async () => {
    const input =
      "data: " + JSON.stringify({ type: "response.created", response: { id: "r", model: "gpt-real" } }) + "\n\n";
    const out = await runMask("gw-primary", input);
    expect(out).toContain('"model":"gw-primary"');
    expect(out).not.toContain("gpt-real");
  });

  it("does not touch a model name quoted inside the answer text", async () => {
    const input = frame("gw-primary", 'the model is "deepseek-chat"') + "\n\n";
    const out = await runMask("gw-primary", input);
    expect(out).toBe(input);
    expect(out).toContain('the model is \\"deepseek-chat\\"');
  });

  it("rewrites every frame of a multi-frame stream", async () => {
    const input = frame("deepseek-chat", "a") + "\n\n" + frame("deepseek-chat", "b") + "\n\n";
    const out = await runMask("gw-primary", input);
    expect(out.match(/"model":"gw-primary"/g)?.length).toBe(2);
    expect(out).not.toContain("deepseek-chat");
  });

  it("passes through non-data lines and [DONE] unchanged", async () => {
    const input = ": keepalive\n\ndata: [DONE]\n\n";
    expect(await runMask("gw-primary", input)).toBe(input);
  });

  it("still masks when the frame is split across network chunks", async () => {
    const whole = frame("deepseek-chat") + "\n\n";
    const bytes = new TextEncoder().encode(whole);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
        controller.close();
      },
    });
    const reader = stream.pipeThrough(modelMaskingTransform("gw-primary")).getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    expect(out).toContain('"model":"gw-primary"');
    expect(out).not.toContain("deepseek-chat");
  });
});
