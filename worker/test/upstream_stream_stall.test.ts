import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPSTREAM_FIRST_CHUNK_TIMEOUT_MS, UPSTREAM_STREAM_STALL_TIMEOUT_MS } from "../src/gateway/proxy";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import {
  CollectingExecutionContext,
  chatBody,
  createRealD1,
  makeEnv,
  makeKv,
  openAiStreamFrames,
  postJson,
  seedDevice,
  seedModel,
  seedProvider,
  sseAnswer,
} from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";


let realFetch: typeof globalThis.fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetRateLimitMemory();
  clearMemoryCacheForTest();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function shortenStreamTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const realNow = performance.now.bind(performance);
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => realNow() + elapsed);
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, delay?: number, ...rest: unknown[]) =>
    delay !== undefined && (fn.name === "onWatchdogTimeout" || delay === UPSTREAM_FIRST_CHUNK_TIMEOUT_MS || delay === UPSTREAM_STREAM_STALL_TIMEOUT_MS)
      ? realSetTimeout(() => { elapsed += Math.max(0, delay - 5); fn(); }, Math.min(5, delay))
      : realSetTimeout(fn, delay, ...(rest as []))) as unknown as typeof globalThis.setTimeout);
}

function stallingStream(firstFrame: string) {
  const encoder = new TextEncoder();
  let sent = false;
  globalThis.fetch = vi.fn(async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return new Promise<void>(() => {});
          sent = true;
          controller.enqueue(encoder.encode(firstFrame));
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    )
  ) as unknown as typeof globalThis.fetch;
}

async function seedEnv(cacheEnabled = false) {
  const d1 = createRealD1();
  seedProvider(d1);
  seedModel(d1, cacheEnabled ? { cache_enabled: 1, cache_ttl: 300 } : {});
  await seedDevice(d1, { balance_usd: 1 });
  const kv = makeKv();
  return { d1, kv, env: makeEnv(d1, kv) };
}

async function call(env: Env, path: string, body: unknown) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, path, body, exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

describe("an upstream that goes quiet mid-stream is cut off and reported", () => {
  it("ends the chat stream with the gateway error frame", async () => {
    shortenStreamTimers();
    const { d1, env } = await seedEnv();
    stallingStream('data: {"choices":[{"delta":{"content":"po"}}]}\n\n');

    const { res, text } = await call(env, "/chat/completions", chatBody("gw-primary", { stream: true }));

    expect(res.status).toBe(200);
    expect(text).toContain("po");
    expect(text).toContain("upstream_stream_stalled");
    expect(text).toContain('"type":"upstream_error"');
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain("Provider A");
    d1.close();
  });

  it("answers a stalled /responses stream with response.failed", async () => {
    shortenStreamTimers();
    const { d1, env } = await seedEnv();
    stallingStream('data: {"choices":[{"delta":{"content":"po"}}]}\n\n');

    const { res, text } = await call(env, "/responses", {
      model: "gw-primary",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(text).toContain("po");
    expect(text).toContain("event: response.failed");
    expect(text).toContain('"status":"failed"');
    expect(text).not.toContain("event: response.completed");
    expect(text).toContain("upstream_stream_stalled");
    d1.close();
  });

  it("leaves a healthy stream alone and reports it complete", async () => {
    shortenStreamTimers();
    const { d1, env } = await seedEnv();
    globalThis.fetch = vi.fn(async () => sseAnswer(openAiStreamFrames("pong"))) as unknown as typeof globalThis.fetch;

    const { res, text } = await call(env, "/responses", {
      model: "gw-primary",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(text).toContain("pong");
    expect(text).toContain("event: response.completed");
    expect(text).not.toContain("upstream_stream_stalled");
    d1.close();
  });
  it("never stores a stalled fragment as a cache entry", async () => {
    shortenStreamTimers();
    const { d1, kv, env } = await seedEnv(true);
    stallingStream('data: {"choices":[{"delta":{"content":"po"}}]}\n\n');

    await call(env, "/chat/completions", chatBody("gw-primary", { stream: true }));

    expect(kv.store.size).toBe(0);
    d1.close();
  });

  it("does store a healthy stream, so the guard above is not just a disabled cache", async () => {
    shortenStreamTimers();
    const { d1, kv, env } = await seedEnv(true);
    globalThis.fetch = vi.fn(async () => sseAnswer(openAiStreamFrames("pong"))) as unknown as typeof globalThis.fetch;

    const { text } = await call(env, "/chat/completions", chatBody("gw-primary", { stream: true }));

    expect(text).toContain("pong");
    expect(kv.store.size).toBe(1);
    d1.close();
  });
  it("never stores a stalled /responses fragment either", async () => {
    shortenStreamTimers();
    const { d1, kv, env } = await seedEnv(true);
    stallingStream('data: {"choices":[{"delta":{"content":"po"}}]}\n\n');

    await call(env, "/responses", {
      model: "gw-primary",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
    });

    expect(kv.store.size).toBe(0);
    d1.close();
  });
});


