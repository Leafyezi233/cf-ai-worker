import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest, computeCacheKey } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import {
  CollectingExecutionContext,
  TOKEN,
  createRealD1,
  makeEnv,
  makeKv,
  openAiAnswer,
  seedDevice,
  seedModel,
  seedProvider,
  sseAnswer,
  usageRows,
} from "./helpers/realGatewayEnv";
import { gatewayApp } from "../src/gateway/index";
import {
  convertChatToResponsesJson,
  convertResponsesRequest,
  createChatToResponsesTransform,
  unsupportedResponsesFields,
} from "../src/gateway/responses_adapter";
import type { Env } from "../src/types";


let realFetch: typeof globalThis.fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetRateLimitMemory();
  clearMemoryCacheForTest();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function responsesBody(extra: Record<string, unknown> = {}) {
  return {
    model: "gw-primary",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    ...extra,
  };
}

async function callResponses(env: Env, body: unknown) {
  const exec = new CollectingExecutionContext();
  const res = await gatewayApp.request(
    "http://gw.test/responses",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
    exec as never
  );
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

async function seed(cacheEnabled = 0) {
  const d1 = createRealD1();
  seedProvider(d1);
  seedModel(d1, { cache_enabled: cacheEnabled });
  await seedDevice(d1, { balance_usd: 1 });
  const kv = makeKv();
  return { d1, kv, env: makeEnv(d1, kv) };
}

function recordUpstreams(answer: () => Response) {
  const bodies: any[] = [];
  globalThis.fetch = vi.fn(async (_input: any, init: any) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return bodies;
}

describe("stateful Responses fields are refused instead of ignored", () => {
  it("names every field it cannot honour", () => {
    expect(unsupportedResponsesFields({ input: "hi" })).toEqual([]);
    expect(
      unsupportedResponsesFields({
        previous_response_id: "resp_1",
        conversation: "conv_1",
        context_management: [{ type: "truncation" }],
      })
    ).toEqual(["previous_response_id", "conversation", "context_management"]);
  });

  it("does not refuse a string prompt, which the adapter can still use", () => {
    expect(unsupportedResponsesFields({ prompt: "hello" })).toEqual([]);
    expect(unsupportedResponsesFields({ prompt: { id: "pmpt_1" } })).toEqual(["prompt"]);
  });

  it("answers 400 before reaching the upstream, and never bills for it", async () => {
    const { d1, env } = await seed();
    const bodies = recordUpstreams(() => openAiAnswer());

    const { res, text } = await callResponses(env, responsesBody({ previous_response_id: "resp_prev" }));
    expect(res.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({
      error: "unsupported_field",
      unsupported_fields: ["previous_response_id"],
    });
    expect(bodies).toHaveLength(0);
    expect(usageRows(d1)).toHaveLength(0);
  });
});

describe("request shaping", () => {
  it("sends max_completion_tokens to the models that reject max_tokens", () => {
    const forGpt5 = convertResponsesRequest({ model: "gpt-5", input: "hi", max_output_tokens: 32 });
    expect(forGpt5.max_completion_tokens).toBe(32);
    expect("max_tokens" in forGpt5).toBe(false);

    const forO3 = convertResponsesRequest({ model: "o3-mini", input: "hi", max_output_tokens: 32 });
    expect(forO3.max_completion_tokens).toBe(32);

    const forRelay = convertResponsesRequest({ model: "deepseek-chat", input: "hi", max_output_tokens: 32 });
    expect(forRelay.max_tokens).toBe(32);
    expect("max_completion_tokens" in forRelay).toBe(false);

    const namespaced = convertResponsesRequest({ model: "openai/gpt-5.1", input: "hi", max_output_tokens: 32 });
    expect(namespaced.max_completion_tokens).toBe(32);
  });

  it("maps text.format to response_format, including a json_schema", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    const converted = convertResponsesRequest({
      model: "m",
      input: "hi",
      text: { format: { type: "json_schema", name: "answer", schema } },
    });
    expect(converted.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "answer", schema },
    });

    const plain = convertResponsesRequest({ model: "m", input: "hi", text: { format: { type: "text" } } });
    expect("response_format" in plain).toBe(false);
  });

  it("forwards parallel_tool_calls, which decides whether one turn may carry several calls", () => {
    const off = convertResponsesRequest({ model: "m", input: "hi", parallel_tool_calls: false });
    expect(off.parallel_tool_calls).toBe(false);
    const absent = convertResponsesRequest({ model: "m", input: "hi" });
    expect("parallel_tool_calls" in absent).toBe(false);
  });

  it("passes a hosted tool through instead of deleting it", () => {
    const converted = convertResponsesRequest({
      model: "m",
      input: "hi",
      tools: [{ type: "web_search" }],
    });
    expect(converted.tools).toEqual([{ type: "web_search" }]);
  });

  it("keeps a function tool unchanged", () => {
    const converted = convertResponsesRequest({
      model: "m",
      input: "hi",
      tools: [{ type: "function", name: "read", description: "read a file", parameters: { type: "object" } }],
    });
    expect(converted.tools).toEqual([
      { type: "function", function: { name: "read", description: "read a file", parameters: { type: "object" } } },
    ]);
  });
});

describe("input content parts", () => {
  it("sends an input_image as an image_url part instead of a JSON string", () => {
    const converted = convertResponsesRequest({
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what is this?" },
            { type: "input_image", image_url: "https://example.test/a.png", detail: "high" },
          ],
        },
      ],
    });
    expect(converted.messages).toHaveLength(1);
    expect(converted.messages[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "https://example.test/a.png", detail: "high" } },
    ]);
  });

  it("drops a detail value an older provider would reject", () => {
    const converted = convertResponsesRequest({
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "https://example.test/a.png", detail: "original" }],
        },
      ],
    });
    expect(converted.messages[0].content).toEqual([
      { type: "image_url", image_url: { url: "https://example.test/a.png" } },
    ]);
  });

  it("collapses an all-text part list back to a plain string", () => {
    const converted = convertResponsesRequest({
      model: "m",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }] }],
    });
    expect(converted.messages[0].content).toBe("a\nb");
  });

  it("does not stringify a file part it cannot express", () => {
    const converted = convertResponsesRequest({
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "summarise" },
            { type: "input_file", file_id: "file_123" },
          ],
        },
      ],
    });
    const content = converted.messages[0].content;
    expect(JSON.stringify(content)).not.toContain("file_123");
    expect(content).toBe("summarise\n[file]");
  });
});

describe("tool calls and their results", () => {
  it("groups every call of one turn into a single assistant message", () => {
    const converted = convertResponsesRequest({
      model: "m",
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
        { type: "function_call", call_id: "c2", name: "write", arguments: "{}" },
      ],
    });
    const assistants = converted.messages.filter((m: any) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].tool_calls.map((t: any) => t.id)).toEqual(["c1", "c2"]);
  });

  it("understands custom_tool_call and custom_tool_call_output", () => {
    const converted = convertResponsesRequest({
      model: "m",
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "custom_tool_call", call_id: "c1", name: "shell", input: "ls -la" },
        { type: "custom_tool_call_output", call_id: "c1", output: "a.txt" },
      ],
    });
    expect(converted.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "c1", function: { name: "shell", arguments: JSON.stringify({ input: "ls -la" }) } }],
    });
    expect(converted.messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "a.txt" });
  });

  it("keeps tool messages contiguous and hoists their media after the batch", () => {
    const converted = convertResponsesRequest({
      model: "m",
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "function_call", call_id: "c1", name: "shot", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "c1",
          output: [
            { type: "input_text", text: "here it is" },
            { type: "input_image", image_url: "https://example.test/s.png" },
          ],
        },
      ],
    });
    expect(converted.messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "here it is" });
    expect(converted.messages[3]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.test/s.png" } }],
    });
  });
});

describe("answers the caller can read", () => {
  it("puts the thinking into the reasoning item instead of an empty summary", () => {
    const json = convertChatToResponsesJson(
      {
        id: "chatcmpl-1",
        model: "gw-primary",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "42", reasoning_content: "six times seven" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      "resp_1",
      "gw-primary"
    );
    const reasoning = json.output.find((o: any) => o.type === "reasoning");
    expect(reasoning.summary).toEqual([{ type: "summary_text", text: "six times seven" }]);
    expect(reasoning.content).toEqual([{ type: "reasoning_text", text: "six times seven" }]);
  });

  async function drain(transform: TransformStream<Uint8Array, Uint8Array>, frames: string[]) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      },
    });
    const reader = stream.pipeThrough(transform).getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value);
    }
    return out;
  }

  function framesFor(delta: Record<string, unknown>, finishReason: string) {
    return [
      `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
  }

  it("reports the input tokens the proxy measured instead of zero", async () => {
    const transform = createChatToResponsesTransform("resp_1", "gw-primary", undefined, 1234);
    const out = await drain(transform, framesFor({ content: "pong" }, "stop"));
    expect(out).toContain("event: response.completed");
    expect(out).toContain('"input_tokens":1234');
  });

  it("reports a truncated answer as incomplete", async () => {
    const transform = createChatToResponsesTransform("resp_1", "gw-primary", undefined, 10);
    const out = await drain(transform, framesFor({ content: "partial" }, "length"));
    expect(out).toContain("event: response.incomplete");
    expect(out).not.toContain("event: response.completed");
    expect(out).toContain('"reason":"max_output_tokens"');
  });

  it("keeps the thinking text on the streamed reasoning item too", async () => {
    const transform = createChatToResponsesTransform("resp_1", "gw-primary", undefined, 10);
    const out = await drain(transform, [
      `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { reasoning_content: "think" } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "answer" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    expect(out).toContain('"summary":[{"type":"summary_text","text":"think"}]');
  });
});

describe("cache keys follow the fields that change the answer", () => {
  const base = { model: "gpt-5", input: "hi" };

  it("separates parallel_tool_calls and text.format", async () => {
    const plain = await computeCacheKey("responses", "gpt-5", base);
    const serial = await computeCacheKey("responses", "gpt-5", { ...base, parallel_tool_calls: false });
    const parallel = await computeCacheKey("responses", "gpt-5", { ...base, parallel_tool_calls: true });
    const json = await computeCacheKey("responses", "gpt-5", {
      ...base,
      text: { format: { type: "json_object" } },
    });

    expect(serial).not.toBe(plain);
    expect(parallel).not.toBe(serial);
    expect(json).not.toBe(plain);
  });

  it("leaves the key of a body without those fields alone", async () => {
    const again = await computeCacheKey("responses", "gpt-5", { ...base, parallel_tool_calls: undefined });
    expect(again).toBe(await computeCacheKey("responses", "gpt-5", base));
  });
});
