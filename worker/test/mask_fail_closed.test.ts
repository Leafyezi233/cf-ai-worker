import { describe, expect, it } from "vitest";
import {
  maskJsonText,
  maskUnparseableModelValues,
  modelMaskingTransform,
} from "../src/gateway/caller_identity";

const BSLASH = String.fromCharCode(92);

const PUBLIC = "gw-primary";

async function runMask(input: string, publicModel = PUBLIC): Promise<string> {
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

describe("unparseable frames no longer leak the upstream model name", () => {
  const malformed = [
    ['{"model":"evil-model"} GARBAGE', "trailing garbage"],
    ['{"model":"evil-model"', "truncated object"],
    ['{"model":"evil', "unterminated value"],
    ['{"model":"evil-model"}{"x":1}', "two objects"],
    ['{"model":"evil-model","n":NaN}', "NaN value"],
    ['{"message":{"model":"evil-model"', "nested + truncated"],
    ['{"model"\t:\t"evil-model"}', "tab spacing"],
  ] as const;

  for (const [payload, label] of malformed) {
    it(`rewrites the model in a data frame with ${label}`, async () => {
      const out = await runMask("data: " + payload);
      expect(out).not.toContain("evil-model");
      expect(out).toContain('"model":"gw-primary"');
    });
  }

  it("rewrites an unterminated value EXACTLY, without dropping following characters", () => {
    expect(maskUnparseableModelValues('{"model":"evil', PUBLIC)).toBe('{"model":"gw-primary"');
    expect(maskUnparseableModelValues('{"model":"evil"rest', PUBLIC)).toBe('{"model":"gw-primary"rest');
  });

  it("rewrites a model payload on an SSE comment line", async () => {
    const out = await runMask(': {"model":"evil-model"}');
    expect(out).not.toContain("evil-model");
    expect(out).toContain('"model":"gw-primary"');
  });

  it("rewrites a bare JSON line that is not a data frame", async () => {
    const out = await runMask('{"model":"evil-model"');
    expect(out).not.toContain("evil-model");
    expect(out).toContain('"model":"gw-primary"');
  });

  it("rewrites inside an array element", async () => {
    const out = await runMask('[{"model":"evil-model"}]');
    expect(out).not.toContain("evil-model");
  });
});

describe("well-formed frames keep the previous behaviour", () => {
  const frame = (model: string, content = "hi") =>
    'data: ' + JSON.stringify({ id: "c", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content } }] });

  it("returns a frame whose model already matches byte-for-byte", async () => {
    const input = frame(PUBLIC) + "\n\n";
    expect(await runMask(input)).toBe(input);
  });

  it("still rewrites a foreign model name", async () => {
    const out = await runMask(frame("deepseek-chat") + "\n\n");
    expect(out).toContain('"model":"gw-primary"');
    expect(out).not.toContain("deepseek-chat");
  });

  it("leaves a model name quoted inside answer content alone", async () => {
    const input = frame(PUBLIC, 'the reply is {"model": "deepseek-chat"}') + "\n\n";
    const out = await runMask(input);
    expect(out).toBe(input);
    expect(out).toContain("deepseek-chat");
  });

  it("leaves an escaped model key in content alone even when the frame is malformed", async () => {
    const payload = '{"choices":[{"delta":{"content":"see \\"model\\":\\"evil\\""' + "}}]}";
    const out = await runMask("data: " + payload);
    expect(out).toContain('\\"model\\"');
    expect(out).not.toContain('"model":"gw-primary"');
  });

  it("does not touch a frame with no model literal", async () => {
    const input = "data: " + JSON.stringify({ choices: [{ delta: { content: "plain" } }] });
    expect(await runMask(input)).toBe(input);
  });

  it("passes a comment with no model literal through unchanged", async () => {
    const input = ": keepalive";
    expect(await runMask(input)).toBe(input);
  });
});

describe("maskUnparseableModelValues boundaries", () => {
  it("ignores a model value that is not a string", () => {
    expect(maskUnparseableModelValues('{"model":123}', PUBLIC)).toBe('{"model":123}');
  });

  it("ignores a model key that is not in key position", () => {
    expect(maskUnparseableModelValues('{"x":"model":"evil"}', PUBLIC)).toBe('{"x":"model":"evil"}');
  });

  it("leaves an already-public value untouched", () => {
    expect(maskUnparseableModelValues('{"model":"gw-primary"', PUBLIC)).toBe('{"model":"gw-primary"');
  });

  it("preserves surrounding whitespace and the rest of the frame", () => {
    expect(maskUnparseableModelValues('{ "model" : "evil" , "keep" : 1 }', PUBLIC))
      .toBe('{ "model" : "gw-primary" , "keep" : 1 }');
  });

  it("rewrites every foreign model field, not just the first", () => {
    const out = maskUnparseableModelValues('{"model":"a","message":{"model":"b"', PUBLIC);
    expect(out).toBe('{"model":"gw-primary","message":{"model":"gw-primary"');
  });

  it("keeps an escaped quote inside the value from cutting the replacement short", () => {
    const escapedQuote = '{"model":"a' + BSLASH + '"b","keep":1';
    expect(escapedQuote).toContain(BSLASH + '"');
    expect(maskUnparseableModelValues(escapedQuote, PUBLIC)).toBe('{"model":"gw-primary","keep":1');
  });

  it("stays cheap on a large malformed body", () => {
    const big = '{"model":"evil","x":"' + "A".repeat(200_000) + '" GARBAGE';
    const started = Date.now();
    maskUnparseableModelValues(big, PUBLIC);
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe("the non-streamed body follows the same contract", () => {
  it("masks a well-formed body", () => {
    const out = maskJsonText('{"model":"deepseek-chat","x":1}', PUBLIC);
    expect(JSON.parse(out).model).toBe(PUBLIC);
  });

  it("masks a body the parser rejects", () => {
    const out = maskJsonText('{"model":"deepseek-chat"} GARBAGE', PUBLIC);
    expect(out).not.toContain("deepseek-chat");
    expect(out).toContain('"model":"gw-primary"');
  });

  it("returns a body with no model literal unchanged", () => {
    expect(maskJsonText('{"x":1}', PUBLIC)).toBe('{"x":1}');
  });
});
