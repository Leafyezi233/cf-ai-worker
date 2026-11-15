import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { ThinkingSplitter, joinSegments } from "../src/gateway/thinking";
import {
  chatReasoningTransform,
  createChatReasoningState,
  normalizeChatCompletion,
  reasoningTextFromNode,
  stripFencesFromText,
} from "../src/gateway/thinking_sse";
import type { ChatReasoningState } from "../src/gateway/thinking_sse";
import {
  CollectingExecutionContext,
  chatBody,
  createRealD1,
  makeEnv,
  makeKv,
  postJson,
  seedDevice,
  seedModel,
  seedProvider,
  sseAnswer,
} from "./helpers/realGatewayEnv";


const LF = String.fromCharCode(10);

function frameFor(index: number, delta: Record<string, unknown>): string {
  return (
    "data: " +
    JSON.stringify({
      id: "chatcmpl-s",
      object: "chat.completion.chunk",
      model: "gw-primary",
      choices: [{ index, delta }],
    }) +
    LF +
    LF
  );
}

function deltaFrame(delta: Record<string, unknown>, model = "gw-primary"): string {
  return (
    "data: " +
    JSON.stringify({
      id: "chatcmpl-s",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta }],
    }) +
    LF +
    LF
  );
}

function finishFrame(): string {
  return (
    "data: " +
    JSON.stringify({
      id: "chatcmpl-s",
      object: "chat.completion.chunk",
      model: "gw-primary",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
    }) +
    LF +
    LF
  );
}

const DONE_FRAME = "data: [DONE]" + LF + LF;

async function runThrough(chunks: string[], state?: ChatReasoningState): Promise<string> {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return await new Response(body.pipeThrough(chatReasoningTransform(state))).text();
}

function payloads(out: string): any[] {
  const list: any[] = [];
  for (const line of out.split(LF)) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6).trim();
    if (!raw || raw === "[DONE]") continue;
    list.push(JSON.parse(raw));
  }
  return list;
}

function joined(out: string, key: string): string {
  return joinedFor(out, 0, key);
}

function joinedFor(out: string, index: number, key: string): string {
  let text = "";
  for (const item of payloads(out)) {
    const choice = (item?.choices ?? []).find((c: any) => c && c.index === index);
    const value = choice?.delta?.[key];
    if (typeof value === "string") text += value;
  }
  return text;
}

function contentChunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(deltaFrame({ content: text.slice(i, i + size) }));
  return out;
}

function splitAll(chunks: string[]): { content: string; reasoning: string } {
  const splitter = new ThinkingSplitter();
  let content = "";
  let reasoning = "";
  for (const chunk of chunks) {
    const segments = splitter.push(chunk);
    content += joinSegments(segments, false);
    reasoning += joinSegments(segments, true);
  }
  const tail = splitter.flush();
  content += joinSegments(tail, false);
  reasoning += joinSegments(tail, true);
  return { content, reasoning };
}

describe("the split never depends on how the stream was chunked", () => {
  const text = "before<think>inner</think>after";
  const expected = { content: "beforeafter", reasoning: "inner" };

  it("splits the whole answer at once", () => {
    expect(splitAll([text])).toEqual(expected);
  });

  it("splits one character at a time", () => {
    expect(splitAll(text.split(""))).toEqual(expected);
  });

  it("splits at three characters", () => {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 3) chunks.push(text.slice(i, i + 3));
    expect(splitAll(chunks)).toEqual(expected);
  });

  it("splits in the middle of the opening tag", () => {
    expect(splitAll(["before<thi", "nk>inner</think>after"])).toEqual(expected);
  });

  it("splits in the middle of the closing tag", () => {
    expect(splitAll(["before<think>inner</thi", "nk>after"])).toEqual(expected);
  });
});

describe("the splitter keeps the meaning of a fence", () => {
  it("recognises <thinking>, which a scan for <think> would leave half-matched", () => {
    expect(splitAll(["<thinking>plan</thinking>answer"])).toEqual({ content: "answer", reasoning: "plan" });
  });

  it("counts nesting so an inner block cannot end the outer one", () => {
    expect(splitAll(["<think>a<think>b</think>c</think>d"])).toEqual({ content: "d", reasoning: "abc" });
  });

  it("reports unclosed reasoning as reasoning, not as the answer", () => {
    expect(splitAll(["<think>secret"])).toEqual({ content: "", reasoning: "secret" });
  });

  it("drops a closing tag with no opener instead of emitting it as text", () => {
    expect(splitAll(["x</think>y"])).toEqual({ content: "xy", reasoning: "" });
  });

  it("leaves a lone less-than sign alone", () => {
    expect(splitAll(["a < b and c > d"])).toEqual({ content: "a < b and c > d", reasoning: "" });
  });
});

describe("a streamed chat answer is normalised", () => {
  it("moves a fenced scratchpad into reasoning_content", async () => {
    const out = await runThrough([...contentChunks("before<think>plan</think>after", 6), finishFrame(), DONE_FRAME]);
    expect(joined(out, "content")).toBe("beforeafter");
    expect(joined(out, "reasoning_content")).toBe("plan");
    expect(out).not.toContain("<think>");
  });

  it("handles a tag split across two frames", async () => {
    const frames = [
      deltaFrame({ content: "<thi" }),
      deltaFrame({ content: "nk>secret" }),
      deltaFrame({ content: "</think>answer" }),
      finishFrame(),
      DONE_FRAME,
    ];
    const out = await runThrough(frames);
    expect(joined(out, "content")).toBe("answer");
    expect(joined(out, "reasoning_content")).toBe("secret");
    expect(out).not.toContain("<thi");
  });

  it("folds a non-standard reasoning field onto the one clients read", async () => {
    const out = await runThrough([deltaFrame({ thinking: "why" }), finishFrame(), DONE_FRAME]);
    expect(joined(out, "reasoning_content")).toBe("why");
    const first = payloads(out)[0];
    expect(first.choices[0].delta.thinking).toBeUndefined();
  });

  it("flattens reasoning_details into the same field", async () => {
    const out = await runThrough([
      deltaFrame({ reasoning_details: [{ type: "reasoning.text", text: "a" }, { thinking: "b" }] }),
      finishFrame(),
      DONE_FRAME,
    ]);
    expect(joined(out, "reasoning_content")).toBe("ab");
  });

  it("releases text it is holding before the terminator, not after it", async () => {
    const frames = [deltaFrame({ content: "<think>secret</thi" }), DONE_FRAME];
    const out = await runThrough(frames);
    const released = out.indexOf("reasoning_content");
    expect(released).toBeGreaterThan(-1);
    expect(released).toBeLessThan(out.indexOf("[DONE]"));
    expect(joined(out, "reasoning_content")).toBe("secret</thi");
  });

  it("forwards a stream with nothing to normalise byte for byte", async () => {
    const frames = [
      deltaFrame({ role: "assistant", content: "hello" }),
      deltaFrame({ content: " world" }),
      finishFrame(),
      DONE_FRAME,
    ];
    const input = frames.join("");
    expect(await runThrough(frames)).toBe(input);
  });

  it("marks its counters incomplete once plain frames have already left", async () => {
    const state = createChatReasoningState();
    await runThrough(
      [
        deltaFrame({ content: "plain " }),
        deltaFrame({ content: "<think>plan</think>answer" }),
        finishFrame(),
        DONE_FRAME,
      ],
      state
    );
    expect(state.rewrote).toBe(true);
    expect(state.contentComplete).toBe(false);
    expect(state.content).toBe("answer");
  });

  it("reports a complete answer when the fence is the very first thing", async () => {
    const state = createChatReasoningState();
    await runThrough([deltaFrame({ content: "<think>plan</think>answer" }), finishFrame(), DONE_FRAME], state);
    expect(state.contentComplete).toBe(true);
    expect(state.content).toBe("answer");
  });

  it("strips fences out of text that arrived before the stage engaged", () => {
    expect(stripFencesFromText("plain <think>plan</think>answer")).toBe("plain answer");
    expect(stripFencesFromText("no fence here")).toBe("no fence here");
  });

  it("reports the answer and the reasoning it forwarded, for the cache", async () => {
    const state = createChatReasoningState();
    await runThrough([...contentChunks("<think>plan</think>answer", 4), finishFrame(), DONE_FRAME], state);
    expect(state.rewrote).toBe(true);
    expect(state.content).toBe("answer");
    expect(state.reasoning).toBe("plan");
  });

  it("keeps choices apart, so one open fence cannot swallow another choice", async () => {
    const out = await runThrough([
      frameFor(0, { content: "<think>plan" }),
      frameFor(1, { content: "second" }),
      frameFor(0, { content: "</think>first" }),
      finishFrame(),
      DONE_FRAME,
    ]);
    expect(joinedFor(out, 0, "content")).toBe("first");
    expect(joinedFor(out, 0, "reasoning_content")).toBe("plan");
    expect(joinedFor(out, 1, "content")).toBe("second");
    expect(joinedFor(out, 1, "reasoning_content")).toBe("");
  });

  it("does not glue one choice's half tag onto another choice's text", async () => {
    const out = await runThrough([
      frameFor(0, { content: "a<thi" }),
      frameFor(1, { content: "second" }),
      frameFor(0, { content: "nk>b" }),
      finishFrame(),
      DONE_FRAME,
    ]);
    expect(joinedFor(out, 1, "content")).toBe("second");
    expect(joinedFor(out, 1, "reasoning_content")).toBe("");
    expect(joinedFor(out, 0, "content")).toBe("a");
    expect(joinedFor(out, 0, "reasoning_content")).toBe("b");
  });
});

describe("a non-streamed answer is normalised the same way", () => {
  it("moves the fenced text out of the message", () => {
    const json = {
      choices: [{ index: 0, message: { role: "assistant", content: "<think>plan</think>answer" } }],
    };
    const state = createChatReasoningState();
    expect(normalizeChatCompletion(json, state)).toBe(true);
    expect((json.choices[0].message as any).content).toBe("answer");
    expect((json.choices[0].message as any).reasoning_content).toBe("plan");
  });

  it("drops a content part that was nothing but reasoning", () => {
    const json = {
      choices: [{ index: 0, message: { role: "assistant", content: [{ type: "text", text: "<think>plan</think>" }] } }],
    };
    expect(normalizeChatCompletion(json)).toBe(true);
    expect((json.choices[0].message as any).content).toBe("");
    expect((json.choices[0].message as any).reasoning_content).toBe("plan");
  });

  it("changes nothing when there is no fence", () => {
    const json = { choices: [{ index: 0, message: { role: "assistant", content: "plain answer" } }] };
    expect(normalizeChatCompletion(json)).toBe(false);
    expect((json.choices[0].message as any).reasoning_content).toBeUndefined();
  });

  it("splits each choice with its own scanner", () => {
    const json = {
      choices: [
        { index: 0, message: { role: "assistant", content: "<think>plan</think>first" } },
        { index: 1, message: { role: "assistant", content: "second" } },
      ],
    };
    expect(normalizeChatCompletion(json)).toBe(true);
    expect((json.choices[0].message as any).content).toBe("first");
    expect((json.choices[0].message as any).reasoning_content).toBe("plan");
    expect((json.choices[1].message as any).content).toBe("second");
    expect((json.choices[1].message as any).reasoning_content).toBeUndefined();
  });
});

describe("the reasoning field table", () => {
  it("prefers the standard name", () => {
    expect(reasoningTextFromNode({ reasoning_content: "a", reasoning: "b" })).toBe("a");
  });
  it("reads the aliases", () => {
    expect(reasoningTextFromNode({ reasoning: "a" })).toBe("a");
    expect(reasoningTextFromNode({ thinking: "a" })).toBe("a");
  });
  it("joins reasoning_details blocks", () => {
    expect(reasoningTextFromNode({ reasoning_details: [{ text: "a" }, { thinking: "b" }] })).toBe("ab");
  });
  it("returns nothing for a message without any of them", () => {
    expect(reasoningTextFromNode({ content: "a" })).toBe("");
  });
});

let realFetch: typeof globalThis.fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetRateLimitMemory();
  clearMemoryCacheForTest();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function callStream(env: any) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, "/chat/completions", chatBody("gw-primary", { stream: true }), exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

function seedChatModel() {
  const d1 = createRealD1();
  seedProvider(d1);
  seedModel(d1, { cache_enabled: 1 });
  return d1;
}

describe("the gateway stops printing a scratchpad as the answer", () => {
  it("normalises a real streamed request end to end", async () => {
    const d1 = seedChatModel();
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1, makeKv());
    globalThis.fetch = vi.fn(async () =>
      sseAnswer([
        deltaFrame({ content: "before<think>plan" }),
        deltaFrame({ content: "ning</think>after" }),
        finishFrame(),
        DONE_FRAME,
      ])
    ) as unknown as typeof globalThis.fetch;

    const { res, text } = await callStream(env);

    expect(res.status).toBe(200);
    expect(text).not.toContain("<think>");
    expect(joined(text, "content")).toBe("beforeafter");
    expect(joined(text, "reasoning_content")).toBe("planning");
    d1.close();
  });

  it("replays the reasoning on a cache hit, so a hit is not a worse answer", async () => {
    const d1 = seedChatModel();
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1, makeKv());
    globalThis.fetch = vi.fn(async () =>
      sseAnswer([
        deltaFrame({ content: "<think>planning</think>answer" }),
        finishFrame(),
        DONE_FRAME,
      ])
    ) as unknown as typeof globalThis.fetch;

    await callStream(env);

    globalThis.fetch = vi.fn(async () => {
      throw new Error("a cache hit must not reach the upstream");
    }) as unknown as typeof globalThis.fetch;
    const second = await callStream(env);

    expect(second.res.headers.get("X-Cache")).toBe("HIT");
    expect(joined(second.text, "content")).toBe("answer");
    expect(joined(second.text, "reasoning_content")).toBe("planning");
    d1.close();
  });

  it("keeps the whole answer when the fence starts partway through the stream", async () => {
    const d1 = seedChatModel();
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1, makeKv());
    globalThis.fetch = vi.fn(async () =>
      sseAnswer([
        deltaFrame({ content: "before " }),
        deltaFrame({ content: "<think>planning</think>after" }),
        finishFrame(),
        DONE_FRAME,
      ])
    ) as unknown as typeof globalThis.fetch;

    const first = await callStream(env);
    expect(joined(first.text, "content")).toBe("before after");

    globalThis.fetch = vi.fn(async () => {
      throw new Error("a cache hit must not reach the upstream");
    }) as unknown as typeof globalThis.fetch;
    const second = await callStream(env);

    expect(second.res.headers.get("X-Cache")).toBe("HIT");
    expect(joined(second.text, "content")).toBe("before after");
    expect(joined(second.text, "reasoning_content")).toBe("planning");
    d1.close();
  });

  it("keeps an aliased reasoning field when it replays the answer from cache", async () => {
    const d1 = seedChatModel();
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1, makeKv());
    globalThis.fetch = vi.fn(async () =>
      sseAnswer([deltaFrame({ thinking: "why" }), deltaFrame({ content: "answer" }), finishFrame(), DONE_FRAME])
    ) as unknown as typeof globalThis.fetch;

    const first = await callStream(env);
    expect(joined(first.text, "reasoning_content")).toBe("why");
    expect(first.text).not.toContain("thinking");

    globalThis.fetch = vi.fn(async () => {
      throw new Error("a cache hit must not reach the upstream");
    }) as unknown as typeof globalThis.fetch;
    const second = await callStream(env);

    expect(second.res.headers.get("X-Cache")).toBe("HIT");
    expect(joined(second.text, "content")).toBe("answer");
    expect(joined(second.text, "reasoning_content")).toBe("why");
    d1.close();
  });

  it("leaves the Anthropic path alone, where reasoning already has its own block type", async () => {
    const d1 = createRealD1();
    seedProvider(d1, {
      id: "prov_ant",
      name: "Anthropic A",
      type: "anthropic",
      endpoint: "https://ant.example/v1",
      api_key: "sk-ant",
    });
    seedModel(d1, { id: "model_ant", provider_id: "prov_ant", model_name: "gw-ant" });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const frames = [
      "event: message_start" +
        LF +
        "data: " +
        JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "gw-ant",
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        }) +
        LF +
        LF,
      "event: content_block_delta" +
        LF +
        "data: " +
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "<think>x</think>y" },
        }) +
        LF +
        LF,
      "event: message_stop" + LF + "data: " + JSON.stringify({ type: "message_stop" }) + LF + LF,
    ];
    globalThis.fetch = vi.fn(async () => sseAnswer(frames)) as unknown as typeof globalThis.fetch;
    const exec = new CollectingExecutionContext();
    const res = await postJson(
      env,
      "/messages",
      { model: "gw-ant", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] },
      exec
    );
    const text = await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(200);
    expect(text).toContain("<think>x</think>y");
    d1.close();
  });
});
