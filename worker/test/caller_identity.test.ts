import { describe, expect, it } from "vitest";
import {
  stripProviderHeaders,
  stampModel,
  maskJsonBody,
  maskJsonText,
  modelMaskingTransform,
} from "../src/gateway/caller_identity";

const PUBLIC_MODEL = "gateway-primary";

describe("stripProviderHeaders", () => {
  it("drops headers that name or fingerprint the upstream provider", () => {
    const h = new Headers({
      "content-type": "application/json",
      "server": "cloudflare",
      "x-request-id": "req_abc",
      "x-openai-processing-ms": "42",
      "x-ratelimit-remaining-requests": "9999",
      "cf-ray": "8a1b2c3d4e5f6789",
    });
    const out = stripProviderHeaders(h);
    expect(out.get("server")).toBeNull();
    expect(out.get("x-request-id")).toBeNull();
    expect(out.get("x-openai-processing-ms")).toBeNull();
    expect(out.get("x-ratelimit-remaining-requests")).toBeNull();
  });

  it("keeps protocol headers a client legitimately needs", () => {
    const out = stripProviderHeaders(
      new Headers({ "content-type": "text/event-stream", "retry-after": "30", "etag": 'W/"abc"' })
    );
    expect(out.get("content-type")).toBe("text/event-stream");
    expect(out.get("retry-after")).toBe("30");
    expect(out.get("etag")).toBe('W/"abc"');
  });

  it("does not touch headers on the request path", async () => {
    const { buildUpstreamHeaders } = await import("../src/utils/http");
    const headers = buildUpstreamHeaders(new Headers(), "openai", "sk-test");
    expect(headers.get("Authorization")).toBe("Bearer sk-test");
  });
});

describe("stampModel", () => {
  it("rewrites the top-level model field", () => {
    const node = { model: "real-upstream-model", choices: [{ text: "hi" }] };
    expect(stampModel(node, PUBLIC_MODEL)).toBe(true);
    expect(node.model).toBe(PUBLIC_MODEL);
  });

  it("rewrites the model inside an Anthropic message_start event", () => {
    const event = {
      type: "message_start",
      message: { id: "msg_1", model: "claude-real", usage: { input_tokens: 10 } },
    };
    expect(stampModel(event, PUBLIC_MODEL)).toBe(true);
    expect(event.message.model).toBe(PUBLIC_MODEL);
    expect(event.message.id).toBe("msg_1");
  });

  it("rewrites the model inside a Responses API event", () => {
    const event = {
      type: "response.created",
      response: { id: "resp_1", model: "gpt-real-2026" },
    };
    expect(stampModel(event, PUBLIC_MODEL)).toBe(true);
    expect(event.response.model).toBe(PUBLIC_MODEL);
  });

  it("leaves a model name quoted inside tool-call content alone", () => {
    const node = {
      model: "real",
      choices: [{ message: { tool_calls: [{ function: { arguments: "{\"model\":\"some-other-model\"}" } }] } }],
    };
    stampModel(node, PUBLIC_MODEL);
    expect(node.model).toBe(PUBLIC_MODEL);
    expect(node.choices[0].message.tool_calls[0].function.arguments).toContain("some-other-model");
  });

  it("reports no change when nothing needed rewriting", () => {
    expect(stampModel({ model: PUBLIC_MODEL }, PUBLIC_MODEL)).toBe(false);
    expect(stampModel({ error: "boom" }, PUBLIC_MODEL)).toBe(false);
    expect(stampModel(null, PUBLIC_MODEL)).toBe(false);
  });
});

describe("maskJsonText", () => {
  it("rewrites a serialized body that names another model", () => {
    const text = JSON.stringify({ model: "deepseek-r1", choices: [{ message: { content: "ok" } }] });
    const masked = maskJsonText(text, PUBLIC_MODEL);
    expect(JSON.parse(masked).model).toBe(PUBLIC_MODEL);
    expect(masked).not.toContain("deepseek-r1");
  });

  it("passes a body with no model field through byte for byte", () => {
    const text = JSON.stringify({ error: { message: "rate limited" } });
    expect(maskJsonText(text, PUBLIC_MODEL)).toBe(text);
  });

  it("passes a non-JSON payload through untouched instead of throwing", () => {
    const html = "<html>502 Bad Gateway</html>";
    expect(maskJsonText(html, PUBLIC_MODEL)).toBe(html);
  });

  it("does not reserialize when the visible model is already the one reported", () => {
    const text = `{"model":"${PUBLIC_MODEL}","x":1}`;
    expect(maskJsonText(text, PUBLIC_MODEL)).toBe(text);
  });
});

describe("maskJsonBody", () => {
  it("stamps in place and returns the same object", () => {
    const body = { model: "real", output: [] };
    const out = maskJsonBody(body, PUBLIC_MODEL);
    expect(out).toBe(body);
    expect(body.model).toBe(PUBLIC_MODEL);
  });
});

async function runStream(chunks: string[], model = PUBLIC_MODEL): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  const reader = source.pipeThrough(modelMaskingTransform(model)).getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

describe("modelMaskingTransform", () => {
  it("rewrites the model in every SSE event that reports one", async () => {
    const sse = [
      `data: ${JSON.stringify({ id: "c1", model: "upstream-secret", choices: [{ delta: { content: "hi" } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", model: "upstream-secret", choices: [{ delta: {} }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const out = await runStream([sse]);
    expect(out).not.toContain("upstream-secret");
    expect(JSON.parse(out.split("\n")[0].slice(6)).model).toBe(PUBLIC_MODEL);
    expect(out).toContain("data: [DONE]");
  });

  it("masks a frame split across two network chunks", async () => {
    const frame = `data: ${JSON.stringify({ model: "secret", type: "message_start" })}\n\n`;
    const cut = Math.floor(frame.length / 2);
    const out = await runStream([frame.slice(0, cut), frame.slice(cut)]);
    expect(out).not.toContain("secret");
    expect(JSON.parse(out.split("\n")[0].slice(6)).model).toBe(PUBLIC_MODEL);
  });

  it("leaves event frames that carry no model byte-identical", async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: "plain" } }] })}\n\n`;
    expect(await runStream([sse])).toBe(sse);
  });

  it("leaves non-data frames untouched", async () => {
    const sse = "event: message_start\nid: 42\n\n";
    expect(await runStream([sse])).toBe(sse);
  });

  it("forwards a final line that never got its newline", async () => {
    const out = await runStream([`data: ${JSON.stringify({ model: "secret" })}`]);
    expect(out).not.toContain("secret");
    expect(JSON.parse(out.slice(6)).model).toBe(PUBLIC_MODEL);
  });
});
