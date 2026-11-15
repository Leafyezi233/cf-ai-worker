import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import type { Env } from "../src/types";
import {
  CollectingExecutionContext,
  chatBody,
  createRealD1,
  makeEnv,
  openAiAnswer,
  postJson,
  seedDevice,
  seedGroup,
  seedGroupMembers,
  seedModel,
  seedProvider,
  wallet,
} from "./helpers/realGatewayEnv";


let realFetch: typeof globalThis.fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetRateLimitMemory();
  clearMemoryCacheForTest();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function anthropicAnswer(searches: number) {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "gw-group",
      content: [{ type: "text", text: "pong" }],
      usage: {
        input_tokens: 1000,
        output_tokens: 1000,
        total_tokens: 2000,
        server_tool_use: { web_search_requests: searches },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function anthropicStream(searches: number) {
  const frames = [
    "event: message_start",
    "data: " + JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "gw-group",
        usage: { input_tokens: 1000, output_tokens: 1 },
      },
    }),
    "",
    "event: message_delta",
    "data: " + JSON.stringify({
      type: "message_delta",
      delta: {},
      usage: { output_tokens: 1000, server_tool_use: { web_search_requests: searches } },
    }),
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ];
  return new Response(frames.join(String.fromCharCode(10)), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function recordUpstreams(answer: (call: number) => Response) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: any) => {
    calls.push(String(input));
    return answer(calls.length);
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

interface UsageRow {
  model: string;
  cost_usd: number;
  cache_hit: number;
  search_calls: number;
  status_code: number | null;
}

function usageRows(d1: ReturnType<typeof createRealD1>): UsageRow[] {
  return d1.rows<UsageRow>(
    "SELECT model, cost_usd, cache_hit, search_calls, status_code FROM usage ORDER BY id ASC"
  );
}

function seedAnthropicGroup(
  d1: ReturnType<typeof createRealD1>,
  groupOver: Record<string, unknown> = {},
  memberSearchPrice = 99
) {
  seedProvider(d1, {
    id: "prov_ant",
    name: "Anthropic A",
    type: "anthropic",
    endpoint: "https://ant.example/v1",
    api_key: "sk-ant",
  });
  seedModel(d1, {
    id: "model_ant",
    provider_id: "prov_ant",
    model_name: "gw-member",
    search_price_per_call: memberSearchPrice,
  });
  seedGroup(d1, {
    id: "grp_a",
    name: "gw-group",
    input_price_per_m: 9,
    output_price_per_m: 45,
    search_price_per_call: 2,
    ...groupOver,
  });
  seedGroupMembers(d1, "grp_a", ["model_ant"]);
}

function messagesBody(extra: Record<string, unknown> = {}) {
  return {
    model: "gw-group",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  };
}

const SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 2 };

async function call(env: Env, path: string, body: unknown) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, path, body, exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

describe("a group bills search at its own price", () => {
  it("charges the group's search price and ignores the member's", async () => {
    const d1 = createRealD1();
    seedAnthropicGroup(d1);
    await seedDevice(d1, { balance_usd: 100 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => anthropicAnswer(2));

    const { res } = await call(env, "/messages", messagesBody({ tools: [SEARCH_TOOL] }));

    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://ant.example/v1/messages"]);
    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("gw-group");
    expect(rows[0].cost_usd).toBeCloseTo(4.054, 10);
    expect(rows[0].search_calls).toBe(2);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(95.946, 10);
    d1.close();
  });

  it("takes the count out of a streaming answer as well", async () => {
    const d1 = createRealD1();
    seedAnthropicGroup(d1);
    await seedDevice(d1, { balance_usd: 100 });
    const env = makeEnv(d1);
    recordUpstreams(() => anthropicStream(3));

    const { res } = await call(env, "/messages", messagesBody({ stream: true, tools: [SEARCH_TOOL] }));

    expect(res.status).toBe(200);
    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_usd).toBeCloseTo(6.054, 10);
    expect(rows[0].search_calls).toBe(3);
    d1.close();
  });

  it("keeps search free when the group declares no search price", async () => {
    const d1 = createRealD1();
    seedAnthropicGroup(d1, { search_price_per_call: 0 });
    await seedDevice(d1, { balance_usd: 100 });
    const env = makeEnv(d1);
    recordUpstreams(() => anthropicAnswer(2));

    const { res } = await call(env, "/messages", messagesBody({ tools: [SEARCH_TOOL] }));

    expect(res.status).toBe(200);
    const rows = usageRows(d1);
    expect(rows[0].cost_usd).toBeCloseTo(0.054, 10);
    expect(rows[0].search_calls).toBe(2);
    d1.close();
  });

  it("bills a failover at the group's price, once", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_ant", name: "Anthropic A", type: "anthropic", endpoint: "https://ant.example/v1", api_key: "sk-ant" });
    seedProvider(d1, { id: "prov_ant2", name: "Anthropic B", type: "anthropic", endpoint: "https://ant2.example/v1", api_key: "sk-ant2" });
    seedModel(d1, { id: "model_a", provider_id: "prov_ant", model_name: "gw-member", search_price_per_call: 99 });
    seedModel(d1, { id: "model_b", provider_id: "prov_ant2", model_name: "gw-member-b", search_price_per_call: 77 });
    seedGroup(d1, {
      id: "grp_a",
      name: "gw-group",
      input_price_per_m: 9,
      output_price_per_m: 45,
      search_price_per_call: 2,
    });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1, { balance_usd: 100 });
    const env = makeEnv(d1);
    const calls = recordUpstreams((n) =>
      n === 1 ? new Response("boom", { status: 503 }) : anthropicAnswer(2)
    );

    const { res } = await call(env, "/messages", messagesBody({ tools: [SEARCH_TOOL] }));

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("gw-group");
    expect(rows[0].cost_usd).toBeCloseTo(4.054, 10);
    expect(rows[0].search_calls).toBe(2);
    d1.close();
  });

  it("charges each actual Messages search while bypassing the lossy gateway response cache", async () => {
    const d1 = createRealD1();
    seedAnthropicGroup(d1, { cache_enabled: 1, cache_ttl: 300 });
    await seedDevice(d1, { balance_usd: 100 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => anthropicAnswer(2));
    const body = messagesBody({ tools: [SEARCH_TOOL] });

    await call(env, "/messages", body);
    const replay = await call(env, "/messages", body);

    expect(replay.res.headers.get("X-Cache")).not.toBe("HIT");
    expect(calls).toHaveLength(2);
    const rows = usageRows(d1);
    expect(rows).toHaveLength(2);
    expect(rows[1].cache_hit).toBe(0);
    expect(rows[1].cost_usd).toBeCloseTo(rows[0].cost_usd, 10);
    expect(rows[1].search_calls).toBe(2);
    d1.close();
  });

  it("cannot bill search for a group served over an openai protocol", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_o", name: "OpenAI A", type: "openai", endpoint: "https://o.example/v1", api_key: "sk-o" });
    seedModel(d1, { id: "model_o", provider_id: "prov_o", model_name: "gw-member-o" });
    seedGroup(d1, {
      id: "grp_o",
      name: "gw-group",
      input_price_per_m: 9,
      output_price_per_m: 45,
      search_price_per_call: 2,
    });
    seedGroupMembers(d1, "grp_o", ["model_o"]);
    await seedDevice(d1, { balance_usd: 100 });
    const env = makeEnv(d1);
    recordUpstreams(() => openAiAnswer());

    const { res } = await call(env, "/chat/completions", chatBody("gw-group", { tools: [SEARCH_TOOL] }));

    expect(res.status).toBe(200);
    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].search_calls).toBe(0);
    expect(rows[0].cost_usd).toBeCloseTo(0.054, 10);
    d1.close();
  });
});
