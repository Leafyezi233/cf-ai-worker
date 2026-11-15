import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema } from "../src/db/schema";
import { recoverBillingRequests } from "../src/db/request_billing";
import { DEFAULT_ROUTING_POLICY, ensureTokenPoliciesSchema, putTokenRoutingPolicy } from "../src/db/token_policies";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetCooldowns } from "../src/gateway/failover";
import { gatewayApp } from "../src/gateway/index";
import { MAX_PROXY_ATTEMPTS, PROXY_ATTEMPT_BUDGET_MS } from "../src/gateway/proxy";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import type { Env, TokenRoutingPolicy } from "../src/types";
import {
  CollectingExecutionContext, DEVICE_ID, TOKEN, chatBody, createRealD1, holdRows, ledgerRows,
  makeEnv, openAiAnswer, seedDevice, seedGroup, seedGroupMembers, seedModel, seedProvider,
  usageRows, wallet, type RealD1,
} from "./helpers/realGatewayEnv";

let d: RealD1;
let env: Env;
const INITIAL_BALANCE = 100;
const PUBLIC_MODEL = "budget-public";
type RouteMode = "multi" | "fixed" | "legacy";

beforeEach(async () => {
  resetRateLimitMemory();
  resetCooldowns();
  clearMemoryCacheForTest();
  d = createRealD1();
  env = makeEnv(d);
  await seedDevice(d, { balance_usd: INITIAL_BALANCE });
  await ensureSchema(env);
  await ensureTokenPoliciesSchema(env);
  d.sql("CREATE TABLE attempt_hold_audit(event TEXT, request_id TEXT, amount_usd REAL)");
  d.sql("CREATE TRIGGER budget_hold_insert AFTER INSERT ON reserve_holds BEGIN INSERT INTO attempt_hold_audit VALUES('insert', NEW.request_id, NEW.amount_usd); END");
  d.sql("CREATE TRIGGER budget_hold_delete AFTER DELETE ON reserve_holds BEGIN INSERT INTO attempt_hold_audit VALUES('delete', OLD.request_id, OLD.amount_usd); END");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  d.close();
});

async function setPolicy(mode: RouteMode, groups: string[] = []) {
  const policy: TokenRoutingPolicy = {
    ...structuredClone(DEFAULT_ROUTING_POLICY), mode, group_ids: groups,
    selection: "ordered", failure_fallback: true,
  };
  await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy);
}

function offer(id: string, target: string) {
  d.sql("INSERT INTO service_groups(id,name,enabled,selectable,public_selectable,multiplier,revision) VALUES(?,?,1,1,1,1,1)", id, id);
  d.sql("INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id) VALUES(?,?,?,'group',?)", "map-" + id, id, PUBLIC_MODEL, target);
  d.sql("INSERT OR IGNORE INTO public_model_identities(id,name,enabled) VALUES(?,?,1)", "identity-budget", PUBLIC_MODEL);
}

async function seedRoutes(mode: RouteMode, memberCounts = [2, 2, 2], retries = 1) {
  const services: string[] = [];
  const upstreams: string[][] = [];
  for (const [groupIndex, count] of memberCounts.entries()) {
    const groupId = "pool-" + groupIndex;
    const members: string[] = [];
    const names: string[] = [];
    for (let memberIndex = 0; memberIndex < count; memberIndex++) {
      const id = "g" + groupIndex + "m" + memberIndex;
      seedProvider(d, { id: "provider-" + id, endpoint: "https://" + id + ".example/v1" });
      seedModel(d, { id, provider_id: "provider-" + id, model_name: "upstream-" + id, input_price_per_m: 10, output_price_per_m: 20 });
      members.push(id);
      names.push("upstream-" + id);
    }
    seedGroup(d, { id: groupId, name: "budget-pool-" + groupIndex, input_price_per_m: 10, output_price_per_m: 20,
      config_json: JSON.stringify({ member_retries: retries }) });
    seedGroupMembers(d, groupId, members);
    const service = "service-" + groupIndex;
    offer(service, groupId);
    services.push(service);
    upstreams.push(names);
  }
  await setPolicy(mode, mode === "legacy" ? [] : mode === "fixed" ? services.slice(0, 1) : services);
  return { model: mode === "legacy" ? "budget-pool-0" : PUBLIC_MODEL, upstreams };
}

async function call(model: string, signal?: AbortSignal, path = "/chat/completions") {
  const exec = new CollectingExecutionContext();
  const body = path === "/responses" ? { model, input: "hi", max_output_tokens: 8 } : chatBody(model);
  const response = await gatewayApp.request("http://gw.test" + path, {
    method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    body: JSON.stringify(body), signal,
  }, env, exec as never);
  const text = await response.text();
  await Promise.all(exec.pending);
  return { response, text };
}

function observeHold() {
  const holds = holdRows(d);
  expect(holds).toHaveLength(1);
  expect(holds[0].amount_usd).toBeGreaterThan(0);
  expect(wallet(d)?.reserved_usd).toBeCloseTo(holds[0].amount_usd, 8);
  return holds[0];
}

function expectOneReleasedHold() {
  const audit = d.rows<{ event: string; request_id: string; amount_usd: number }>("SELECT * FROM attempt_hold_audit ORDER BY rowid");
  expect(audit.map((row) => row.event)).toEqual(["insert", "delete"]);
  expect(audit[1]).toEqual({ ...audit[0], event: "delete" });
  expect(holdRows(d)).toEqual([]);
  expect(wallet(d)?.reserved_usd).toBe(0);
}

function expectUncharged() {
  expectOneReleasedHold();
  expect(wallet(d)?.balance_usd).toBe(INITIAL_BALANCE);
  const ledger = ledgerRows(d), usage = usageRows(d);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ delta_usd: 0, reason: "usage" });
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ cost_usd: 0, input_tokens: 0, output_tokens: 0 });
  expect(d.row<{ request_id: string }>("SELECT request_id FROM usage")?.request_id).toBe(ledger[0].request_id);
}

async function expectUnknownUntilRecovery() {
  const hold = observeHold();
  expect(wallet(d)?.balance_usd).toBe(INITIAL_BALANCE);
  expect(usageRows(d)).toEqual([]); expect(ledgerRows(d)).toEqual([]);
  const row = d.row<{ lease_until: number; billing_state: string; known_cost_usd: null }>("SELECT * FROM billing_requests")!;
  expect(row).toMatchObject({ billing_state: "needs_reconciliation", known_cost_usd: null });
  expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 0 });
  expect(holdRows(d)).toEqual([hold]);
  const clock = vi.spyOn(Date, "now").mockReturnValue(row.lease_until + 1);
  try { expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 1 }); }
  finally { clock.mockRestore(); }
  expectOneReleasedHold();
  expect(usageRows(d)).toEqual([]); expect(ledgerRows(d)).toEqual([]);
  expect(wallet(d)?.balance_usd).toBe(INITIAL_BALANCE);
}

function sentModel(init?: RequestInit) {
  return (JSON.parse(String(init?.body)) as { model: string }).model;
}

function busy() { return new Response("busy", { status: 503 }); }

describe("one request-wide proxy attempt budget (real SQLite)", () => {
  it.each([
    { retries: 1, members: [2, 2, 2] },
    { retries: 2, members: [1, 1, 2] },
  ])("caps multi groups × members × retries at eight: $members, retries=$retries", async ({ retries, members }) => {
    const { model, upstreams } = await seedRoutes("multi", members, retries);
    const seen: string[] = [];
    const holds: ReturnType<typeof observeHold>[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      seen.push(sentModel(init)); holds.push(observeHold()); return busy();
    });
    const result = await call(model);
    expect(MAX_PROXY_ATTEMPTS).toBe(8);
    expect(result.response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(seen).toEqual(upstreams.flatMap((names) => names.flatMap((name) => Array<string>(retries + 1).fill(name))).slice(0, 8));
    expect(new Set(holds.map((hold) => JSON.stringify(hold))).size).toBe(1);
    expectUncharged();
  });

  it("also caps the legacy member/retry chain at eight", async () => {
    const { model } = await seedRoutes("legacy", [3], 3);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { observeHold(); return busy(); });
    expect((await call(model)).response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(8);
    expectUncharged();
  });

  it.each(["multi", "legacy"] as const)("stops %s dispatches at the cumulative elapsed deadline and passes only remaining header time", async (mode) => {
    const { model } = await seedRoutes(mode, mode === "multi" ? [1, 1, 2] : [3], mode === "multi" ? 0 : 3);
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      observeHold(); await vi.advanceTimersByTimeAsync(100_000); return busy();
    });
    const result = await call(model);
    expect(PROXY_ATTEMPT_BUDGET_MS).toBe(300_000);
    expect(result.response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(timer.mock.calls.map((args) => args[1]).filter((delay) => Number(delay) >= 100_000 && Number(delay) <= PROXY_ATTEMPT_BUDGET_MS)).toEqual([300_000, 200_000, 100_000]);
    expectUncharged();
  });

  it("starts a fresh budget for the next request after exhausting the previous eight attempts", async () => {
    const { model } = await seedRoutes("multi", [2, 2, 2], 1);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { observeHold(); return busy(); });
    expect((await call(model)).response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(8);
    expectUncharged();
    fetch.mockImplementation(async () => { observeHold(); return openAiAnswer(); });
    expect((await call(model)).response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(9);
    const audit = d.rows<{ event: string; request_id: string }>("SELECT * FROM attempt_hold_audit ORDER BY rowid");
    expect(audit.map((row) => row.event)).toEqual(["insert", "delete", "insert", "delete"]);
    expect(audit[0].request_id).not.toBe(audit[2].request_id);
    expect(holdRows(d)).toEqual([]);
    expect(wallet(d)?.reserved_usd).toBe(0);
    expect(ledgerRows(d)).toHaveLength(2);
    expect(usageRows(d)).toHaveLength(2);
    expect(ledgerRows(d).map(row => row.delta_usd)).toEqual([0, -0.03]);
    expect(wallet(d)?.balance_usd).toBeCloseTo(INITIAL_BALANCE - 0.03, 8);
  });

  it("settles one success after seven rejections with one hold and no duplicate debit", async () => {
    const { model } = await seedRoutes("multi", [2, 2, 2], 1);
    const holds: ReturnType<typeof observeHold>[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      holds.push(observeHold()); return holds.length < 8 ? busy() : openAiAnswer();
    });
    const result = await call(model);
    expect(result.response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(result.response.headers.get("x-gateway-attempts")).toBe("8");
    expect(new Set(holds.map((hold) => JSON.stringify(hold))).size).toBe(1);
    expectOneReleasedHold();
    const usage = usageRows(d);
    const ledger = ledgerRows(d);
    expect(usage).toHaveLength(1);
    expect(usage[0].cost_usd).toBeCloseTo(0.03, 8);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ reason: "usage", request_id: holds[0].request_id });
    expect(ledger[0].delta_usd).toBeCloseTo(-0.03, 8);
    expect(wallet(d)?.balance_usd).toBeCloseTo(INITIAL_BALANCE - 0.03, 8);
  });
});

describe("unknown acceptance and caller abort never replay (real SQLite)", () => {
  it.each(["multi", "fixed", "legacy"] as const)("does not replay an unknown network result in %s even with member retries", async (mode) => {
    const { model } = await seedRoutes(mode, [2, 2], 3);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      observeHold(); throw new TypeError("socket ended after request write; acceptance unknown");
    });
    expect((await call(model)).response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expectUnknownUntilRecovery();
  });

  it.each(["/chat/completions", "/responses"])("propagates caller abort to the fetch signal and does not cross groups after 503 on %s", async (path) => {
    const { model } = await seedRoutes("multi", [2, 2], 3);
    const caller = new AbortController();
    let upstreamSignal: AbortSignal | null | undefined;
    let propagated = false;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      observeHold(); upstreamSignal = init?.signal;
      upstreamSignal?.addEventListener("abort", () => { propagated = true; }, { once: true });
      caller.abort();
      return busy();
    });
    expect((await call(model, caller.signal, path)).response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(upstreamSignal).toBeDefined();
    expect(upstreamSignal?.aborted).toBe(true);
    expect(propagated).toBe(true);
    expectUncharged();
  });

  it("keeps the only hold until recovery when the propagated fetch signal rejects in flight", async () => {
    const { model } = await seedRoutes("multi", [2, 2], 3);
    const caller = new AbortController();
    let propagated = false;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      observeHold();
      const rejected = new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          propagated = true; reject(new DOMException("caller canceled", "AbortError"));
        }, { once: true });
      });
      caller.abort();
      if (!propagated) throw new Error("caller abort was not forwarded to fetch signal");
      return rejected;
    });
    expect((await call(model, caller.signal)).response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(propagated).toBe(true);
    await expectUnknownUntilRecovery();
  });
});

const REJECTIONS = [
  { name: "credential 401", status: 401, error: { message: "invalid api key" } },
  { name: "credential 403", status: 403, error: { message: "credential forbidden" } },
  { name: "model not found", status: 400, error: { message: "no such model", code: "model_not_found" } },
];

describe.each(["fixed", "legacy"] as const)("%s same-price provider compatibility (real SQLite)", (mode) => {
  it.each(REJECTIONS)("moves $name to the next provider, never retries that same member", async ({ status, error }) => {
    const { model, upstreams } = await seedRoutes(mode, [2], 3);
    const seen: string[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      observeHold();
      const name = sentModel(init); seen.push(name);
      return name === upstreams[0][0] ? new Response(JSON.stringify({ error }), { status }) : openAiAnswer();
    });
    const result = await call(model);
    expect(seen).toEqual(upstreams[0]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
    expectOneReleasedHold();
    expect(usageRows(d)).toHaveLength(1);
    expect(ledgerRows(d)).toHaveLength(1);
    expect(wallet(d)?.balance_usd).toBeCloseTo(INITIAL_BALANCE - 0.03, 8);
  });
});
