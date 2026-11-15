import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import {
  MAX_RESERVED_SEARCHES,
  computeCostUsd,
  estimateRequestCostUsd,
  estimateSearchCalls,
} from "../src/gateway/proxy";
import {
  CollectingExecutionContext,
  createRealD1,
  makeEnv,
  postJson,
  seedDevice,
  seedModel,
  seedProvider,
  wallet,
} from "./helpers/realGatewayEnv";
import type { Env, ModelWithProvider } from "../src/types";


let realFetch: typeof globalThis.fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetRateLimitMemory();
  clearMemoryCacheForTest();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function model(over: Partial<ModelWithProvider> = {}): ModelWithProvider {
  return {
    id: "model_1",
    provider_id: "prov_1",
    provider_name: "P",
    provider_type: "openai",
    provider_api_key: null,
    provider_secret_name: null,
    provider_endpoint: null,
    model_name: "m",
    display_name: null,
    alias: null,
    fallback_model_id: null,
    input_price_per_m: 3,
    output_price_per_m: 15,
    cache_enabled: 0,
    cache_ttl: 3600,
    model_public: 0,
    pricing_mode: "priced",
    peak_pricing_enabled: 0,
    enabled: 1,
    config_json: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  } as ModelWithProvider;
}

const ONE_M_IN = { input_tokens: 1000000, output_tokens: 0, total_tokens: 1000000 };

describe("the search fee is added to the bill, never multiplied by it", () => {
  it("charges the searches on top of the token cost", () => {
    const row = model({ search_price_per_call: 2 });
    const usage = { ...ONE_M_IN, search_calls: 3 };
    expect(computeCostUsd(row, usage)).toBeCloseTo(9, 10);
  });

  it("leaves the fee outside the peak multiplier", () => {
    const row = model({ search_price_per_call: 2 });
    const usage = { ...ONE_M_IN, search_calls: 3 };
    expect(computeCostUsd(row, usage, 2)).toBeCloseTo(12, 10);
  });

  it("charges nothing when no search price is configured", () => {
    const usage = { ...ONE_M_IN, search_calls: 3 };
    expect(computeCostUsd(model(), usage)).toBeCloseTo(3, 10);
    expect(computeCostUsd(model({ search_price_per_call: 0 }), usage)).toBeCloseTo(3, 10);
  });

  it("keeps the free and unset gates closed over the surcharge too", () => {
    const usage = { ...ONE_M_IN, search_calls: 3 };
    expect(computeCostUsd(model({ pricing_mode: "free", search_price_per_call: 2 }), usage)).toBe(0);
    expect(computeCostUsd(model({ pricing_mode: "unset", search_price_per_call: 2 }), usage)).toBe(0);
  });

  it("adds to a per-call charge instead of replacing it, and keeps the fee out of the band there too", () => {
    const row = model({ billing_unit: "call", price_per_call: 0.5, search_price_per_call: 2 });
    const usage = { ...ONE_M_IN, search_calls: 3 };
    expect(computeCostUsd(row, usage, 1, 1)).toBeCloseTo(6.5, 10);
    expect(computeCostUsd(row, usage, 2, 1)).toBeCloseTo(7, 10);
  });

  it("lets record() veto the count found in a body", () => {
    const row = model({ search_price_per_call: 2 });
    const usage = { ...ONE_M_IN, search_calls: 3 };
    expect(computeCostUsd(row, usage, 1, 0, 0)).toBeCloseTo(3, 10);
  });

  it("reads a missing or nonsensical count as zero searches", () => {
    const row = model({ search_price_per_call: 2 });
    expect(computeCostUsd(row, { ...ONE_M_IN })).toBeCloseTo(3, 10);
    expect(computeCostUsd(row, { ...ONE_M_IN, search_calls: 0 })).toBeCloseTo(3, 10);
    expect(computeCostUsd(row, { ...ONE_M_IN, search_calls: -4 })).toBeCloseTo(3, 10);
  });
});

describe("the searches a request may run are read off the tools it declares", () => {
  it("finds none when no server-side search tool is declared", () => {
    expect(estimateSearchCalls({ messages: [] })).toBe(0);
    expect(estimateSearchCalls({ tools: [] })).toBe(0);
    expect(estimateSearchCalls({ tools: [{ type: "function", name: "get_weather" }] })).toBe(0);
  });

  it("holds the worst case when the tool declares no limit", () => {
    expect(estimateSearchCalls({ tools: [{ type: "web_search_20250305", name: "web_search" }] })).toBe(
      MAX_RESERVED_SEARCHES
    );
    expect(estimateSearchCalls({ tools: [{ type: "web_search_20250305", max_uses: 9999 }] })).toBe(
      MAX_RESERVED_SEARCHES
    );
  });

  it("uses a declared limit and adds several tools together", () => {
    expect(estimateSearchCalls({ tools: [{ type: "web_search_20250305", max_uses: 3 }] })).toBe(3);
    expect(
      estimateSearchCalls({
        tools: [
          { name: "web_search", max_uses: 2 },
          { type: "web_search_preview", max_uses: 1 },
        ],
      })
    ).toBe(3);
  });

  it("puts the held searches into the pre-flight estimate", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search_20250305", max_uses: 2 }],
    };
    const withFee = estimateRequestCostUsd(model({ search_price_per_call: 5 }), body);
    const withoutFee = estimateRequestCostUsd(model({ search_price_per_call: 0 }), body);
    expect(withFee - withoutFee).toBeCloseTo(10, 10);

    const perCall = model({ search_price_per_call: 5 });
    const perCallRow = { ...perCall, billing_unit: "call" as const, price_per_call: 0.5 };
    expect(estimateRequestCostUsd(perCallRow, body)).toBeCloseTo(10.5, 10);
  });
});

function anthropicAnswer(searches: number) {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "gw-anthropic",
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
    'event: message_start',
    'data: ' + JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "gw-anthropic",
        usage: { input_tokens: 1000, output_tokens: 1 },
      },
    }),
    "",
    'event: message_delta',
    'data: ' + JSON.stringify({
      type: "message_delta",
      delta: {},
      usage: { output_tokens: 1000, server_tool_use: { web_search_requests: searches } },
    }),
    "",
    'event: message_stop',
    'data: {"type":"message_stop"}',
    "",
  ];
  return new Response(frames.join(String.fromCharCode(10)), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function recordUpstreams(answer: () => Response) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: any) => {
    calls.push(String(input));
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

function messagesBody(extra: Record<string, unknown> = {}) {
  return {
    model: "gw-anthropic",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  };
}

const SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 2 };

async function callMessages(env: Env, body: unknown) {
  const exec = new CollectingExecutionContext();
  const res = await postJson(env, "/messages", body, exec);
  const text = await res.text();
  await Promise.all(exec.pending);
  return { res, text };
}

async function seedAnthropic(d1: ReturnType<typeof createRealD1>, over: Record<string, unknown> = {}) {
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
    model_name: "gw-anthropic",
    search_price_per_call: 1,
    ...over,
  });
  await seedDevice(d1, { balance_usd: 100 });
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

describe("an anthropic answer is billed for the searches it reports", () => {
  it("records the count and adds it to the token charge", async () => {
    const d1 = createRealD1();
    await seedAnthropic(d1);
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => anthropicAnswer(2));

    const { res } = await callMessages(env, messagesBody({ tools: [SEARCH_TOOL] }));

    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://ant.example/v1/messages"]);
    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_usd).toBeCloseTo(2.018, 10);
    expect(rows[0].search_calls).toBe(2);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(97.982, 10);
    d1.close();
  });

  it("takes the count out of a streaming delta as well", async () => {
    const d1 = createRealD1();
    await seedAnthropic(d1);
    const env = makeEnv(d1);
    recordUpstreams(() => anthropicStream(3));

    const { res } = await callMessages(env, messagesBody({ stream: true, tools: [SEARCH_TOOL] }));

    expect(res.status).toBe(200);
    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_usd).toBeCloseTo(3.018, 10);
    expect(rows[0].search_calls).toBe(3);
    d1.close();
  });

  it("charges no search fee for a request the upstream refused", async () => {
    const d1 = createRealD1();
    await seedAnthropic(d1);
    const env = makeEnv(d1);
    recordUpstreams(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "nope" },
            usage: {
              input_tokens: 100,
              output_tokens: 0,
              total_tokens: 100,
              server_tool_use: { web_search_requests: 5 },
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
    );

    const { res } = await callMessages(env, messagesBody({ tools: [SEARCH_TOOL] }));

    expect(res.status).toBe(400);
    const rows = usageRows(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].status_code).toBe(400);
    expect(rows[0].search_calls).toBe(0);
    expect(rows[0].cost_usd).toBeCloseTo((100 * 3) / 1000000, 10);
    d1.close();
  });

  it("bypasses gateway response caching and settles each actual Messages search", async () => {
    const d1 = createRealD1();
    await seedAnthropic(d1, { cache_enabled: 1, cache_ttl: 300 });
    const env = makeEnv(d1);
    const calls = recordUpstreams(() => anthropicAnswer(2));
    const body = messagesBody({ tools: [SEARCH_TOOL] });

    await callMessages(env, body);
    const replay = await callMessages(env, body);

    expect(replay.res.headers.get("X-Cache")).not.toBe("HIT");
    expect(calls).toHaveLength(2);
    const rows = usageRows(d1);
    expect(rows).toHaveLength(2);
    expect(rows[0].cache_hit).toBe(0);
    expect(rows[1].cache_hit).toBe(0);
    expect(rows[1].cost_usd).toBeCloseTo(rows[0].cost_usd, 10);
    expect(rows[1].search_calls).toBe(2);
    d1.close();
  });
});
