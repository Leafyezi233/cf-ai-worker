import { describe, expect, it } from "vitest";
import { computeCacheKey } from "../src/gateway/cache";
import { maskUnparseableModelValues, modelMaskingTransform } from "../src/gateway/caller_identity";
import { createChatToResponsesTransform } from "../src/gateway/responses_adapter";

const CEILING_MS = 400;

function nested(depth: number): any {
  let node: any = { leaf: true };
  for (let i = 0; i < depth; i++) node = { nested: node };
  return node;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function chunksOf(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe("E: a deeply nested body cannot crash the cache key", () => {
  it("refuses to cache a body nested past the depth cap instead of throwing", async () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: nested(5000) } }],
    };
    const key = await computeCacheKey("chat/completions", "gpt-4o", body, "dev_1");
    expect(key).toBeUndefined();
  });

  it("still caches a body nested as deeply as a real client produces", async () => {
    const body = {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
        },
      ],
      tools: [{ type: "function", function: { name: "f", parameters: nested(20) } }],
    };
    const key = await computeCacheKey("chat/completions", "gpt-4o", body, "dev_1");
    expect(key).toMatch(/^aigw:cache:v3:chat\/completions:gpt-4o:/);
  });
});

describe("C: masking many model fields stays linear", () => {
  it("rewrites every field of a large malformed body without quadratic splicing", () => {
    const parts: string[] = [];
    for (let i = 0; i < 20000; i++) parts.push('"model":"evil-model"');
    const text = "{" + parts.join(",");
    const started = Date.now();
    const masked = maskUnparseableModelValues(text, "gw-primary");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(CEILING_MS);
    expect(masked).not.toContain("evil-model");
    expect(masked).toContain('"model":"gw-primary"');
    expect(masked.split('"gw-primary"').length - 1).toBe(20000);
  });
});

describe("A: the responses translator survives a line that never ends", () => {
  it("does not rescan its buffer per chunk when the upstream sends no newline", async () => {
    const payload = "x".repeat(2 * 1024 * 1024);
    const chunks = chunksOf("data: " + payload, 4096);
    chunks[chunks.length - 1] += "\n\n";

    const transform = createChatToResponsesTransform("resp_pending", "gw-model");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    const started = Date.now();
    const out = await drain(stream.pipeThrough(transform));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(CEILING_MS);
    expect(out).toContain("response.completed");
  });

  it("still emits the content of a frame that only completes at flush", async () => {
    const transform = createChatToResponsesTransform("resp_tail", "gw-model");
    const frame = 'data: {"choices":[{"delta":{"content":"tail answer"}}]}';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunksOf(frame, 7)) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    const out = await drain(stream.pipeThrough(transform));
    expect(out).toContain("tail answer");
  });
});

describe("B: the masking stage survives a line that never ends", () => {
  it("does not rescan its buffer per chunk when the upstream sends no newline", async () => {
    const line = 'data: {"model":"evil-model","pad":"' + "x".repeat(2 * 1024 * 1024) + '"}';
    const chunks = chunksOf(line, 4096);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    const started = Date.now();
    const out = await drain(stream.pipeThrough(modelMaskingTransform("gw-primary")));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(CEILING_MS);
    expect(out).not.toContain("evil-model");
  });

  it("keeps masking multi-line streams exactly as before", async () => {
    const input =
      'data: {"model":"evil-model","n":1}\n\n' +
      'data: {"model":"gw-primary","n":2}\n\n' +
      'data: [DONE]\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunksOf(input, 5)) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    const out = await drain(stream.pipeThrough(modelMaskingTransform("gw-primary")));
    expect(out).not.toContain("evil-model");
    expect(out).toContain('"model":"gw-primary","n":1');
    expect(out).toContain("data: [DONE]");
  });
});
