import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { TOKEN, makeEnv, seedDevice, seedModel, seedProvider, usageRows } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";

const CJK_PROMPT = "请把下面这段话翻译成英文，只输出译文，不要解释，也不要保留原句：今天的天气很好，我们去公园散步吧。";
const NO_USAGE = "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"gw-primary\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"abcdefghij\"}}]}\n\n";

class CollectingExecutionContext {
  readonly pending: Promise<unknown>[] = [];
  waitUntil(p: Promise<unknown>) {
    this.pending.push(p.catch(() => undefined));
  }
  passThroughOnException() {}
  readonly props: unknown = undefined;
  readonly tracing: unknown = undefined;
  readonly access: unknown = undefined;
}

function streamWithoutUsage(chunks = 4): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < chunks; i++) controller.enqueue(enc.encode(NO_USAGE));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function envOf(d1: RealD1): Env {
  return makeEnv(d1) as unknown as Env;
}

async function seed(over: { balance?: number } = {}) {
  const d1 = createRealD1();
  seedProvider(d1);
  seedModel(d1, { id: "model_a", model_name: "gw-primary", cache_enabled: 0 });
  await seedDevice(d1, { balance_usd: over.balance ?? 1 });
  return d1;
}

const chatBody = { model: "gw-primary", messages: [{ role: "user", content: CJK_PROMPT }], max_tokens: 8, stream: true };

async function cancelMidStream(env: Env, exec: CollectingExecutionContext, withLength: boolean) {
  const text = JSON.stringify(chatBody);
  const bytes = new TextEncoder().encode(text).length;
  const headers: Record<string, string> = { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };
  if (withLength) headers["Content-Length"] = String(bytes);
  const res = await gatewayApp.request(
    "http://gw.test/chat/completions",
    { method: "POST", headers, body: text },
    env,
    exec as never
  );
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel("client disconnected");
  await Promise.all(exec.pending);
  return { text, bytes };
}
describe("a cancelled stream bills its input from the bytes the request carried", () => {
  let realFetch: typeof globalThis.fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    resetRateLimitMemory();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("records the byte-based input estimate on the usage row", async () => {
    const d1 = await seed();
    const env = envOf(d1);
    globalThis.fetch = vi.fn(async () => streamWithoutUsage()) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const { text, bytes } = await cancelMidStream(env, exec, true);

    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(Math.ceil(bytes / 4));
    expect(rows[0].input_tokens).toBeGreaterThan(Math.ceil(text.length / 4));
    expect(rows[0].status_code).toBe(499);
  });

  it("leaves a CJK prompt under-billed only when the request declares no length", async () => {
    const d1 = await seed();
    const env = envOf(d1);
    const exec = new CollectingExecutionContext();
    globalThis.fetch = vi.fn(async () => streamWithoutUsage()) as unknown as typeof globalThis.fetch;

    const { text } = await cancelMidStream(env, exec, false);

    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(Math.ceil(text.length / 4));
  });

  it("does not let a dishonest Content-Length inflate the estimate", async () => {
    const d1 = await seed();
    const env = envOf(d1);
    globalThis.fetch = vi.fn(async () => streamWithoutUsage()) as unknown as typeof globalThis.fetch;

    const text = JSON.stringify(chatBody);
    const bytes = new TextEncoder().encode(text).length;
    const exec = new CollectingExecutionContext();
    const res = await gatewayApp.request(
      "http://gw.test/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + TOKEN,
          "Content-Type": "application/json",
          "Content-Length": String(bytes * 1000),
        },
        body: text,
      },
      env,
      exec as never
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("client disconnected");
    await Promise.all(exec.pending);

    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBeLessThanOrEqual(Math.ceil((bytes * 3) / 4));
  });

  it("still prefers the provider usage frame when one arrives", async () => {
    const d1 = await seed();
    const env = envOf(d1);
    const frame =
      "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"gw-primary\"," +
      "\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]," +
      "\"usage\":{\"prompt_tokens\":1234,\"completion_tokens\":56,\"total_tokens\":1290}}\n\n";
    globalThis.fetch = vi.fn(async () => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(frame));
          controller.enqueue(enc.encode(NO_USAGE));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    await cancelMidStream(env, exec, true);

    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(1234);
    expect(rows[0].output_tokens).toBe(56);
  });
});
