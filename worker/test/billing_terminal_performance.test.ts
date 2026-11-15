import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import { ensureWallet, type UsageInsertData } from "../src/db/repo";
import {
  admitBillingRequest, beginBillingAttempt, persistBillingTerminal, recoverBillingRequests,
  settleBillingRequest, type BillingTerminalReceipt,
} from "../src/db/request_billing";
import { makeWalletFixture } from "./helpers/walletFixture";

const pricing = JSON.stringify({ billing_unit: "token", input_price_per_m: 1, output_price_per_m: 2 });
type Terminal = Parameters<typeof persistBillingTerminal>[1];
const admission = (request_id = "a", sub_token_id: string | null = null) => ({
  request_id, device_id: "dev-1", sub_token_id, model: "public-model",
  pricing_snapshot_json: pricing, reserved_usd: 3,
});
function terminal(request_id = "a", cost_usd: number | undefined = 2): Terminal {
  return {
    request_id, device_id: "dev-1", provider_id: "provider", provider_name: "Provider", model: "public-model",
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, cache_read_tokens: 5 },
    ...(cost_usd === undefined ? {} : { cost_usd }), status_code: 200, latency_ms: 50,
    created_at: 1700000000000, usage_source: "reported_final",
  };
}
async function fixture(subtoken = false) {
  const f = await makeWalletFixture({ deviceIds: ["dev-1", "dev-2"] });
  await ensureWallet(f.env, "dev-1", 20); await ensureWallet(f.env, "dev-2", 40);
  await recoverBillingRequests(f.env, 0);  
  if (subtoken) {
    for (const id of ["sub-a", "sub-b"]) f.d1.sql(
      "INSERT INTO device_sub_tokens (id, device_id, name, token_hash, created_at) VALUES (?, 'dev-1', ?, ?, 1)", id, id, id,
    );
  }
  expect(await admitBillingRequest(f.env, admission("a", subtoken ? "sub-a" : null))).toBe(true);
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function attempt(f: Fixture, request_id = "a") {
  return beginBillingAttempt(f.env, { request_id, provider_id: "provider", model: "public-model", protocol: "chat" });
}
function snapshot(f: Fixture) {
  return {
    wallets: f.d1.rows("SELECT * FROM device_wallets ORDER BY device_id"),
    holds: f.d1.rows("SELECT * FROM reserve_holds ORDER BY request_id"),
    ledger: f.d1.rows("SELECT * FROM wallet_ledger ORDER BY id"),
    usage: f.d1.rows("SELECT * FROM usage ORDER BY id"),
    daily: f.d1.rows("SELECT * FROM daily_stats ORDER BY date, device_id, provider_id, model"),
    requests: f.d1.rows("SELECT * FROM billing_requests ORDER BY request_id"),
    attempts: f.d1.rows("SELECT * FROM billing_attempts ORDER BY id"),
    devices: f.d1.rows("SELECT * FROM devices ORDER BY id"),
    subtokens: f.d1.rows("SELECT * FROM device_sub_tokens ORDER BY id"),
  };
}
function paid(f: Fixture, cost = 2) {
  expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets WHERE device_id='dev-1'"))
    .toEqual({ balance_usd: 20 - cost, reserved_usd: 0 });
  expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets WHERE device_id='dev-2'"))
    .toEqual({ balance_usd: 40, reserved_usd: 0 });
  expect(f.d1.rows("SELECT request_id, device_id, cost_usd FROM usage")).toEqual([{ request_id: "a", device_id: "dev-1", cost_usd: cost }]);
  expect(f.d1.rows("SELECT request_id, device_id, delta_usd FROM wallet_ledger"))
    .toEqual([{ request_id: "a", device_id: "dev-1", delta_usd: -cost }]);
  expect(f.d1.row("SELECT SUM(request_count) AS requests, SUM(cost_usd) AS cost FROM daily_stats"))
    .toEqual({ requests: 1, cost });
  expect(f.d1.rows("SELECT * FROM reserve_holds")).toEqual([]);
  expect(f.d1.row<{ settled_at: number | null }>("SELECT settled_at FROM billing_requests WHERE request_id='a'")!.settled_at).not.toBeNull();
}

function countCalls(env: Env) {
  const originalPrepare = env.DB.prepare.bind(env.DB), originalBatch = env.DB.batch.bind(env.DB);
  const calls: { kind: string; sql: string[] }[] = [];
  let batching = 0;
  env.DB.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    for (const method of ["first", "all", "run"] as const) {
      const original = statement[method].bind(statement);
      Object.assign(statement, { [method]: (...args: unknown[]) => {
        if (!batching) calls.push({ kind: method, sql: [sql] });
        return Reflect.apply(original, statement, args);
      } });
    }
    return statement;
  }) as typeof env.DB.prepare;
  env.DB.batch = (async (statements: D1PreparedStatement[]) => {
    calls.push({ kind: "batch", sql: statements.map(s => (s as unknown as { sql: string }).sql) });
    batching++;
    try { return await originalBatch(statements); } finally { batching--; }
  }) as typeof env.DB.batch;
  return { calls, restore: () => { env.DB.prepare = originalPrepare; env.DB.batch = originalBatch; } };
}
function pauseNextBatch(env: Env) {
  const original = env.DB.batch.bind(env.DB);
  let enter!: () => void, resume!: () => void, first = true;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  env.DB.batch = (async (statements: D1PreparedStatement[]) => {
    if (first) { first = false; enter(); await gate; }
    return original(statements);
  }) as typeof env.DB.batch;
  return { entered, resume, restore: () => { env.DB.batch = original; } };
}
async function pending(f: Fixture, data = terminal()) {
  const receipt = await persistBillingTerminal(f.env, data);
  expect(receipt.requestId).toBe(data.request_id);
  return receipt;
}
const invalidReceipt = /invalid.*receipt/i;

describe("terminal receipt D1 round-trip budget", () => {
  it.each([
    { withAttempt: false, cacheHit: false, subtoken: false },
    { withAttempt: false, cacheHit: true, subtoken: false },
    { withAttempt: true, cacheHit: false, subtoken: false },
    { withAttempt: true, cacheHit: false, subtoken: true },
  ])("uses exactly one SELECT and two atomic batches ($withAttempt attempt, $cacheHit cache, $subtoken subtoken)", async ({ withAttempt, cacheHit, subtoken }) => {
    const f = await fixture(subtoken), data = terminal();
    if (withAttempt) data.attempt_id = await attempt(f);
    if (subtoken) data.sub_token_id = "sub-a";
    data.cache_hit = cacheHit ? 1 : 0;
    const meter = countCalls(f.env);
    try {
      const receipt = await persistBillingTerminal(f.env, data);
      await settleBillingRequest(f.env, "a", receipt);
      expect(meter.calls.map(c => c.kind)).toEqual(["first", "batch", "batch"]);
      expect(meter.calls).toHaveLength(3);
      expect(meter.calls[0].sql[0]).toMatch(/SELECT/i);
      expect(meter.calls[0].sql[0]).toContain("billing_requests");
      if (withAttempt) expect(meter.calls[0].sql[0]).toContain("billing_attempts");
      expect(meter.calls[1].sql).toHaveLength(1);
      expect(meter.calls[1].sql[0]).toContain("terminal_snapshot_json");
      expect(meter.calls[2].sql.some(sql => sql.includes("wallet_ledger"))).toBe(true);
      paid(f);
      expect(f.d1.row("SELECT cache_hit FROM usage")).toEqual({ cache_hit: cacheHit ? 1 : 0 });
    } finally { meter.restore(); }
  });

  it("keeps the no-receipt durable-read recovery path", async () => {
    const f = await fixture(); await pending(f);
    const meter = countCalls(f.env);
    try {
      await settleBillingRequest(f.env, "a");
      expect(meter.calls.map(c => c.kind)).toEqual(["first", "batch"]);
      paid(f);
    } finally { meter.restore(); }
  });
});

describe("terminal ownership and acknowledgment", () => {
  it.each(["owner", "subtoken", "missing-attempt", "foreign-attempt"])("rejects %s before any write", async mismatch => {
    const f = await fixture(true), data = { ...terminal(), sub_token_id: "sub-a" };
    if (mismatch === "owner") data.device_id = "dev-2";
    if (mismatch === "subtoken") data.sub_token_id = "sub-b";
    if (mismatch === "missing-attempt") Object.assign(data, { attempt_id: "missing" });
    if (mismatch === "foreign-attempt") {
      await admitBillingRequest(f.env, admission("b"));
      Object.assign(data, { attempt_id: await attempt(f, "b") });
    }
    const before = snapshot(f), meter = countCalls(f.env);
    try {
      await expect(persistBillingTerminal(f.env, data)).rejects.toThrow(/owner mismatch|attempt mismatch/);
      expect(meter.calls.map(c => c.kind)).toEqual(["first"]);
      expect(snapshot(f)).toEqual(before);
    } finally { meter.restore(); }
  });

  it.each(["delete", "reassign"])("rechecks attempt membership at terminal UPDATE after concurrent %s", async change => {
    const f = await fixture(), id = await attempt(f);
    await admitBillingRequest(f.env, admission("b"));
    const gate = pauseNextBatch(f.env);
    const writing = persistBillingTerminal(f.env, { ...terminal(), attempt_id: id });
    const rejected = expect(writing).rejects.toThrow(/attempt mismatch|not persisted/);
    await gate.entered;
    if (change === "delete") f.d1.sql("DELETE FROM billing_attempts WHERE id=?", id);
    else f.d1.sql("UPDATE billing_attempts SET request_id='b' WHERE id=?", id);
    const before = snapshot(f);
    gate.resume(); await rejected; gate.restore();
    expect(snapshot(f)).toEqual(before);
    await settleBillingRequest(f.env, "a");
    expect(snapshot(f)).toEqual(before);
  });

  it("does not mint a receipt or release/charge money on a rolled-back terminal", async () => {
    const f = await fixture(), before = snapshot(f);
    f.d1.sql("CREATE TRIGGER fail_terminal BEFORE UPDATE OF terminal_snapshot_json ON billing_requests BEGIN SELECT RAISE(ABORT, 'terminal write failed'); END");
    let minted: BillingTerminalReceipt | undefined;
    await expect(persistBillingTerminal(f.env, terminal()).then(value => { minted = value; })).rejects.toThrow("terminal write failed");
    expect(minted).toBeUndefined(); expect(snapshot(f)).toEqual(before);
    await settleBillingRequest(f.env, "a"); expect(snapshot(f)).toEqual(before);
    f.d1.sql("DROP TRIGGER fail_terminal");
    await settleBillingRequest(f.env, "a", await pending(f)); paid(f);
  });

  it.each(["throw", "invalid-result"])("withholds a receipt after committed terminal %s and recovers durable first-wins data", async fault => {
    const f = await fixture(), original = f.env.DB.batch.bind(f.env.DB); let batches = 0;
    f.env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      batches++; await original(statements);
      if (fault === "throw") throw new Error("terminal commit response lost");
      return [];
    }) as typeof f.env.DB.batch;
    let minted: BillingTerminalReceipt | undefined;
    await expect(persistBillingTerminal(f.env, terminal()).then(value => { minted = value; }))
      .rejects.toThrow(fault === "throw" ? "terminal commit response lost" : /invalid result/);
    expect(batches).toBe(1); expect(minted).toBeUndefined();
    f.env.DB.batch = original;
    expect(f.d1.row("SELECT known_cost_usd FROM billing_requests WHERE request_id='a'")).toEqual({ known_cost_usd: 2 });
    expect(f.d1.rows("SELECT * FROM usage")).toEqual([]);
    expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets WHERE device_id='dev-1'"))
      .toEqual({ balance_usd: 20, reserved_usd: 3 });
    const receipt = await persistBillingTerminal(f.env, { ...terminal("a", 9), outcome: "failed" });
    await settleBillingRequest(f.env, "a", receipt); paid(f);
  });

  it("recovers a terminal commit with lost response without obtaining a replacement receipt", async () => {
    const f = await fixture(), original = f.env.DB.batch.bind(f.env.DB);
    f.env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      await original(statements); throw new Error("terminal ack lost");
    }) as typeof f.env.DB.batch;
    await expect(persistBillingTerminal(f.env, terminal())).rejects.toThrow("terminal ack lost");
    f.env.DB.batch = original;
    expect(await recoverBillingRequests(f.env)).toEqual({ settled: 1, expired: 0 });
    paid(f);
  });

  it("returns a receipt for the unchanged existing terminal, not changed caller cost/usage", async () => {
    const f = await fixture(); await pending(f);
    const before = snapshot(f), meter = countCalls(f.env);
    let receipt!: BillingTerminalReceipt;
    try {
      receipt = await persistBillingTerminal(f.env, { ...terminal("a", 9), usage: null, outcome: "unknown", cache_hit: 1 });
      expect(meter.calls.map(c => c.kind)).toEqual(["first"]);
      expect(snapshot(f)).toEqual(before);
    } finally { meter.restore(); }
    await settleBillingRequest(f.env, "a", receipt); paid(f);
    expect(f.d1.row("SELECT input_tokens, output_tokens, cache_hit FROM usage"))
      .toEqual({ input_tokens: 20, output_tokens: 10, cache_hit: 0 });
  });

  it("an existing unknown-cost terminal wins over a later fabricated known cost", async () => {
    const f = await fixture(), unknown = terminal(); delete unknown.cost_usd;
    await pending(f, { ...unknown, usage: null, outcome: "unknown" });
    const before = snapshot(f), receipt = await persistBillingTerminal(f.env, terminal("a", 9));
    await settleBillingRequest(f.env, "a", receipt);
    expect(snapshot(f)).toEqual(before);
    f.d1.sql("UPDATE billing_requests SET lease_until=1 WHERE request_id='a'");
    expect(await recoverBillingRequests(f.env)).toEqual({ settled: 0, expired: 1 });
    expect(f.d1.rows("SELECT * FROM usage")).toEqual([]);
    expect(f.d1.rows("SELECT * FROM wallet_ledger")).toEqual([]);
    expect(f.d1.rows("SELECT * FROM daily_stats")).toEqual([]);
    expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets WHERE device_id='dev-1'"))
      .toEqual({ balance_usd: 20, reserved_usd: 0 });
    expect(f.d1.row("SELECT known_cost_usd, billing_state FROM billing_requests WHERE request_id='a'"))
      .toEqual({ known_cost_usd: null, billing_state: "needs_reconciliation" });
  });
});

describe("opaque receipt snapshot and binding", () => {
  it("caller-data and visible receipt mutations cannot redirect durable accounting", async () => {
    const f = await fixture(true), data = { ...terminal(), sub_token_id: "sub-a" };
    const receipt = await pending(f, data);
    data.device_id = "dev-2"; data.sub_token_id = "sub-b"; data.request_id = "b"; data.cost_usd = 19;
    data.usage!.input_tokens = 999; data.provider_id = "other-provider";
    Reflect.set(receipt, "requestId", "b");
    for (const [key, value] of Object.entries({ device_id: "dev-2", sub_token_id: "sub-b", cost_usd: 19,
      terminal_snapshot_json: JSON.stringify(data), row: data, data })) Reflect.set(receipt, key, value);
    await settleBillingRequest(f.env, "a", receipt); paid(f);
    expect(f.d1.row("SELECT sub_token_id, provider_id, input_tokens FROM usage"))
      .toEqual({ sub_token_id: "sub-a", provider_id: "provider", input_tokens: 20 });
    expect(f.d1.row<{ last_used_at: number | null }>("SELECT last_used_at FROM device_sub_tokens WHERE id='sub-a'")!.last_used_at).not.toBeNull();
    expect(f.d1.row("SELECT last_used_at FROM device_sub_tokens WHERE id='sub-b'")).toEqual({ last_used_at: null });
  });

  it.each(["wrong-id", "other-db", "forged", "serialized", "spread", "null", "primitive"])("rejects explicit %s receipt without accounting writes", async kind => {
    const f = await fixture(), receipt = await pending(f);
    await admitBillingRequest(f.env, admission("b"));
    let env = f.env, requestId = "a", supplied: unknown = receipt;
    let other: Fixture | undefined;
    if (kind === "wrong-id") requestId = "b";
    if (kind === "other-db") { other = await fixture(); await pending(other); env = other.env; }
    if (kind === "forged") supplied = { requestId: "a" };
    if (kind === "serialized") supplied = JSON.parse(JSON.stringify(receipt));
    if (kind === "spread") supplied = { ...receipt };
    if (kind === "null") supplied = null;
    if (kind === "primitive") supplied = "a";
    const before = snapshot(f), otherBefore = other && snapshot(other);
    await expect(settleBillingRequest(env, requestId, supplied as BillingTerminalReceipt)).rejects.toThrow(invalidReceipt);
    expect(snapshot(f)).toEqual(before);
    if (other) expect(snapshot(other)).toEqual(otherBefore);
  });

  it("allows an Env wrapper sharing the exact same DB binding", async () => {
    const f = await fixture(), receipt = await pending(f);
    await settleBillingRequest({ ...f.env }, "a", receipt); paid(f);
  });

  it.each(["snapshot", "cost", "owner", "subtoken"])("stale receipt cannot claim after durable %s changes", async change => {
    const f = await fixture(true), receipt = await pending(f, { ...terminal(), sub_token_id: "sub-a" });
    if (change === "snapshot") {
      const durable = f.d1.row<{ terminal_snapshot_json: string }>("SELECT terminal_snapshot_json FROM billing_requests WHERE request_id='a'")!;
      const changed = JSON.parse(durable.terminal_snapshot_json) as UsageInsertData;
      changed.provider_id = "new-provider"; changed.usage!.input_tokens = 123;
      f.d1.sql("UPDATE billing_requests SET terminal_snapshot_json=? WHERE request_id='a'", JSON.stringify(changed));
    }
    if (change === "cost") f.d1.sql("UPDATE billing_requests SET known_cost_usd=9 WHERE request_id='a'");
    if (change === "owner") f.d1.sql("UPDATE billing_requests SET device_id='dev-2' WHERE request_id='a'");
    if (change === "subtoken") f.d1.sql("UPDATE billing_requests SET sub_token_id='sub-b' WHERE request_id='a'");
    const before = snapshot(f);
    await Promise.allSettled([settleBillingRequest(f.env, "a", receipt)]);
    expect(snapshot(f)).toEqual(before);
  });

  it.each(["owner", "subtoken"])("SQL rechecks %s after receipt validation but before the financial batch", async change => {
    const f = await fixture(true), receipt = await pending(f, { ...terminal(), sub_token_id: "sub-a" });
    const gate = pauseNextBatch(f.env), settling = settleBillingRequest(f.env, "a", receipt);
    const completed = Promise.allSettled([settling]);
    await gate.entered;
    f.d1.sql(change === "owner" ? "UPDATE billing_requests SET device_id='dev-2' WHERE request_id='a'"
      : "UPDATE billing_requests SET sub_token_id='sub-b' WHERE request_id='a'");
    const before = snapshot(f); gate.resume(); await completed; gate.restore();
    expect(snapshot(f)).toEqual(before);
  });

  it("a competing terminal winner cannot be charged from the losing in-flight snapshot", async () => {
    const f = await fixture(), gate = pauseNextBatch(f.env);
    const losing = persistBillingTerminal(f.env, terminal("a", 9));
    await gate.entered;
    const winning = await persistBillingTerminal(f.env, terminal("a", 2));
    const durable = f.d1.row("SELECT terminal_snapshot_json, known_cost_usd FROM billing_requests WHERE request_id='a'");
    gate.resume(); const receipt = await losing; gate.restore();
    expect(f.d1.row("SELECT terminal_snapshot_json, known_cost_usd FROM billing_requests WHERE request_id='a'")).toEqual(durable);
    await settleBillingRequest(f.env, "a", receipt); paid(f);
    const before = snapshot(f);
    await settleBillingRequest(f.env, "a", winning); expect(snapshot(f)).toEqual(before);
  });

  it("a receipt stays harmless after another normal settlement wins", async () => {
    const f = await fixture(), receipt = await pending(f);
    await settleBillingRequest(f.env, "a"); const before = snapshot(f);
    await settleBillingRequest(f.env, "a", receipt); expect(snapshot(f)).toEqual(before); paid(f);
  });

  it("concurrent receipt, normal settlement, and recovery commit one accounting set", async () => {
    const f = await fixture(), receipt = await pending(f);
    await Promise.all([
      settleBillingRequest(f.env, "a", receipt), settleBillingRequest(f.env, "a"),
      recoverBillingRequests(f.env), settleBillingRequest(f.env, "a", receipt),
    ]);
    paid(f);
    const before = snapshot(f); await recoverBillingRequests(f.env);
    await settleBillingRequest(f.env, "a", receipt); expect(snapshot(f)).toEqual(before);
  });
});

describe("receipt settlement retains the original atomic financial transaction", () => {
  const failures = [
    ["wallet_ledger", "INSERT"], ["usage", "INSERT"], ["daily_stats", "INSERT"],
    ["devices", "UPDATE"], ["device_sub_tokens", "UPDATE"], ["device_wallets", "UPDATE"],
    ["reserve_holds", "DELETE"], ["billing_requests", "UPDATE OF settled_at"],
  ] as const;
  it.each(failures)("%s %s failure rolls back every financial and nonce mutation then recovers", async (table, event) => {
    const f = await fixture(true), receipt = await pending(f, { ...terminal(), sub_token_id: "sub-a" });
    const before = snapshot(f);
    f.d1.sql("CREATE TRIGGER fail_financial BEFORE " + event + " ON " + table + " BEGIN SELECT RAISE(ABORT, 'receipt settlement failed'); END");
    await expect(settleBillingRequest(f.env, "a", receipt)).rejects.toThrow("receipt settlement failed");
    expect(snapshot(f)).toEqual(before);
    f.d1.sql("DROP TRIGGER fail_financial");
    expect(await recoverBillingRequests(f.env)).toEqual({ settled: 1, expired: 0 }); paid(f);
    const committed = snapshot(f); await settleBillingRequest(f.env, "a", receipt);
    expect(snapshot(f)).toEqual(committed);
  });

  it("retries a rolled-back financial batch with the original receipt", async () => {
    const f = await fixture(), receipt = await pending(f), before = snapshot(f);
    f.d1.sql("CREATE TRIGGER fail_once BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'retry receipt'); END");
    await expect(settleBillingRequest(f.env, "a", receipt)).rejects.toThrow("retry receipt");
    expect(snapshot(f)).toEqual(before); f.d1.sql("DROP TRIGGER fail_once");
    await settleBillingRequest(f.env, "a", receipt); paid(f);
  });

  it("committed financial response loss cannot cause duplicate charge on receipt or recovery replay", async () => {
    const f = await fixture(), receipt = await pending(f), original = f.env.DB.batch.bind(f.env.DB); let batches = 0;
    f.env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      batches++; await original(statements); throw new Error("financial commit response lost");
    }) as typeof f.env.DB.batch;
    await expect(settleBillingRequest(f.env, "a", receipt)).rejects.toThrow("financial commit response lost");
    expect(batches).toBe(1); f.env.DB.batch = original; paid(f);
    const committed = snapshot(f);
    await settleBillingRequest(f.env, "a", receipt); await settleBillingRequest(f.env, "a");
    expect(await recoverBillingRequests(f.env)).toEqual({ settled: 0, expired: 0 });
    expect(snapshot(f)).toEqual(committed);
  });
});
