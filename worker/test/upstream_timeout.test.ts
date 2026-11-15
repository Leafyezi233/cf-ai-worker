import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverBillingRequests } from "../src/db/request_billing";
import { UPSTREAM_FETCH_TIMEOUT_MS } from "../src/gateway/proxy";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import {
  CollectingExecutionContext,
  TOKEN,
  chatBody,
  createRealD1,
  holdRows,
  ledgerRows,
  makeEnv,
  makeKv,
  openAiAnswer,
  postJson,
  seedDevice,
  seedModel,
  seedProvider,
  wallet,
} from "./helpers/realGatewayEnv";


function chatText() {
  return JSON.stringify(chatBody());
}

async function seed() {
  const d1 = createRealD1();
  seedProvider(d1);
  seedModel(d1);
  await seedDevice(d1, { balance_usd: 1 });
  return { d1, env: makeEnv(d1, makeKv()) };
}

function isInitialHeaderDeadline(delay: unknown): delay is number {
  return typeof delay === "number" && delay > UPSTREAM_FETCH_TIMEOUT_MS - 10_000 && delay <= UPSTREAM_FETCH_TIMEOUT_MS;
}

function timeoutHandle(spy: { mock: { calls: unknown[][]; results: { value?: unknown }[] } }) {
  const index = spy.mock.calls.findIndex((call) => isInitialHeaderDeadline(call[1]));
  return index < 0 ? null : { index, handle: spy.mock.results[index]?.value };
}

async function expectUnknownUntilRecovery(d1: ReturnType<typeof createRealD1>, env: ReturnType<typeof makeEnv>) {
  const holds = d1.rows<{ amount_usd: number }>("SELECT * FROM reserve_holds");
  expect(holds).toHaveLength(1); expect(holds[0].amount_usd).toBeGreaterThan(0);
  expect(wallet(d1)?.reserved_usd).toBeCloseTo(holds[0].amount_usd, 8);
  expect(d1.rows("SELECT * FROM usage")).toEqual([]);
  expect(d1.rows("SELECT * FROM wallet_ledger")).toEqual([]);
  const billing = d1.row<{ lease_until: number }>("SELECT * FROM billing_requests")!;
  expect(billing).toMatchObject({ billing_state: "needs_reconciliation", known_cost_usd: null });
  expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 0 });
  expect(d1.rows("SELECT * FROM reserve_holds")).toEqual(holds);
  const clock = vi.spyOn(Date, "now").mockReturnValue(billing.lease_until + 1);
  try { expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 1 }); }
  finally { clock.mockRestore(); }
  expect(wallet(d1)?.reserved_usd).toBe(0);
  expect(d1.rows("SELECT * FROM reserve_holds")).toEqual([]);
  expect(d1.rows("SELECT * FROM usage")).toEqual([]);
  expect(d1.rows("SELECT * FROM wallet_ledger")).toEqual([]);
}

describe("an upstream attempt is bounded while it waits for headers", () => {
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

  it("is a generous ceiling, not a short one", () => {
    expect(UPSTREAM_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * 60 * 1000);
    expect(Number.isFinite(UPSTREAM_FETCH_TIMEOUT_MS)).toBe(true);
  });

  it("arms the timer for one attempt and disarms it once headers arrive", async () => {
    const { env } = await seed();
    let signal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_input: any, init: any) => {
      signal = init.signal;
      return openAiAnswer();
    }) as unknown as typeof globalThis.fetch;

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const exec = new CollectingExecutionContext();
    const res = await postJson(env, "/chat/completions", chatText(), exec);
    await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(200);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);

    const armed = timeoutHandle(setTimeoutSpy as never);
    expect(armed).not.toBeNull();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(armed!.handle);
  });

  it("bounds the responses branch too", async () => {
    const { env } = await seed();
    let signal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_input: any, init: any) => {
      signal = init.signal;
      return openAiAnswer();
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postJson(
      env,
      "/responses",
      JSON.stringify({
        model: "gw-primary",
        instructions: "be brief",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        max_output_tokens: 8,
      }),
      exec
    );
    await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(200);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  it("gives up on a stalled upstream, answers 502 and retains the hold until lease recovery", async () => {
    const { d1, env } = await seed();
    globalThis.fetch = vi.fn(
      (_input: any, init: any) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    ) as unknown as typeof globalThis.fetch;

    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, delay?: number, ...rest: unknown[]) =>
      isInitialHeaderDeadline(delay)
        ? realSetTimeout(fn, 5)
        : realSetTimeout(fn, delay, ...(rest as []))) as unknown as typeof globalThis.setTimeout);

    const exec = new CollectingExecutionContext();
    const res = await postJson(env, "/chat/completions", chatText(), exec);
    await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(502);
    await expectUnknownUntilRecovery(d1, env);
    expect(wallet(d1)!.balance_usd).toBeCloseTo(1, 10);
    expect(holdRows(d1)).toHaveLength(0);
    expect(ledgerRows(d1)).toHaveLength(0);
    expect(d1.rows("SELECT id FROM usage")).toHaveLength(0);
  });
});
