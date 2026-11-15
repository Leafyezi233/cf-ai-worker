import { describe, expect, it } from "vitest";
import type { Env, TokenUsage } from "../src/types";
import { ensureWallet, releaseReserve, releaseStaleReserves, reserveBalance, type UsageInsertData } from "../src/db/repo";
import {
  admitBillingRequest, beginBillingAttempt, heartbeatBillingRequest, observeBillingAttempt,
  persistBillingTerminal, recoverBillingRequests, settleBillingRequest, abandonUndispatchedBillingRequest,
} from "../src/db/request_billing";
import { makeWalletFixture } from "./helpers/walletFixture";

const pricing = JSON.stringify({ billing_unit: "token", input_price_per_m: 1, output_price_per_m: 2 });
const usage: TokenUsage = { input_tokens: 20, output_tokens: 10, total_tokens: 30, cache_read_tokens: 5 };
const admission = (request_id = "a", reserved_usd = 3) => ({ request_id, device_id: "dev-1", model: "public-model", pricing_snapshot_json: pricing, reserved_usd });
const terminal = (request_id = "a", cost_usd = 2): UsageInsertData => ({
  request_id, device_id: "dev-1", provider_id: "provider", provider_name: "Provider", model: "public-model",
  usage, cost_usd, status_code: 200, latency_ms: 50, created_at: 1700000000000,
});
async function fixture(balance = 10) {
  const f = await makeWalletFixture();
  await ensureWallet(f.env, "dev-1", balance);
  await recoverBillingRequests(f.env, 0);
  return f;
}
async function pending() {
  const f = await fixture();
  expect(await admitBillingRequest(f.env, admission())).toBe(true);
  await persistBillingTerminal(f.env, terminal());
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function financialSnapshot(f: Fixture) {
  return {
    wallets: f.d1.rows("SELECT * FROM device_wallets ORDER BY device_id"),
    holds: f.d1.rows("SELECT * FROM reserve_holds ORDER BY request_id"),
    ledger: f.d1.rows("SELECT * FROM wallet_ledger ORDER BY id"),
    usage: f.d1.rows("SELECT * FROM usage ORDER BY id"),
    daily: f.d1.rows("SELECT * FROM daily_stats ORDER BY date, device_id, provider_id, model"),
    requests: f.d1.rows("SELECT * FROM billing_requests ORDER BY request_id"),
  };
}
function pauseNextBatch(env: Env) {
  const original = env.DB.batch.bind(env.DB);
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const gate = new Promise<void>(r => { resume = r; });
  let first = true;
  env.DB.batch = (async (statements: D1PreparedStatement[]) => {
    if (first) { first = false; enter(); await gate; }
    return original(statements);
  }) as typeof env.DB.batch;
  return { entered, resume, restore: () => { env.DB.batch = original; } };
}

describe("durable request billing", () => {
  it("admits request, zero or nonzero hold, and wallet reserve in one durable batch", async () => {
    const f = await fixture();
    expect(await admitBillingRequest(f.env, admission())).toBe(true);
    expect(await admitBillingRequest(f.env, admission("free", 0))).toBe(true);
    expect(f.d1.row("SELECT billing_state, terminal_snapshot_json FROM billing_requests WHERE request_id='a'"))
      .toEqual({ billing_state: "active", terminal_snapshot_json: null });
    expect(f.d1.row("SELECT reserved_usd FROM device_wallets")).toEqual({ reserved_usd: 3 });
    expect(f.d1.rows("SELECT request_id, amount_usd FROM reserve_holds ORDER BY request_id"))
      .toEqual([{ request_id: "a", amount_usd: 3 }, { request_id: "free", amount_usd: 0 }]);
  });

  it("undispatched finalization is idempotent, never invoices, and preserves unrelated wallet/holds", async () => {
    const f = await fixture(); await admitBillingRequest(f.env, admission());
    await reserveBalance(f.env, "dev-1", 4, "live");
    const before=f.d1.row("SELECT balance_usd FROM device_wallets");
    await abandonUndispatchedBillingRequest(f.env,"a"); await abandonUndispatchedBillingRequest(f.env,"a");
    expect(f.d1.row("SELECT balance_usd FROM device_wallets")).toEqual(before);
    expect(f.d1.row("SELECT reserved_usd FROM device_wallets")).toEqual({reserved_usd:4});
    expect(f.d1.rows("SELECT request_id FROM reserve_holds")).toEqual([{request_id:"live"}]);
    expect(f.d1.rows("SELECT * FROM usage")).toEqual([]); expect(f.d1.rows("SELECT * FROM wallet_ledger")).toEqual([]);
    expect(f.d1.row("SELECT outcome,billing_state FROM billing_requests")).toEqual({outcome:"not_dispatched",billing_state:"settled"});
  });
  it("undispatched finalization cannot erase a dispatched request or release its hold", async () => {
    const f=await fixture(); await admitBillingRequest(f.env,admission());
    await beginBillingAttempt(f.env,{request_id:"a",provider_id:"p",model:"m",protocol:"messages"});
    const before=financialSnapshot(f); await abandonUndispatchedBillingRequest(f.env,"a");
    expect(financialSnapshot(f)).toEqual(before);
  });
  it("insufficient admission leaves no request/hold/attempt and cannot start upstream state", async () => {
    const f = await fixture(1);
    expect(await admitBillingRequest(f.env, admission())).toBe(false);
    expect(f.d1.rows("SELECT * FROM billing_requests")).toEqual([]);
    expect(f.d1.rows("SELECT * FROM reserve_holds")).toEqual([]);
    await expect(beginBillingAttempt(f.env, { request_id: "a", provider_id: "p", model: "m", protocol: "chat" })).rejects.toThrow("not active");
    expect(f.d1.rows("SELECT * FROM billing_attempts")).toEqual([]);
    expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets")).toEqual({ balance_usd: 1, reserved_usd: 0 });
  });

  it("concurrent admissions cannot overspend and identical replay cannot duplicate the hold", async () => {
    const f = await fixture(3);
    expect((await Promise.all([admitBillingRequest(f.env, admission()), admitBillingRequest(f.env, admission("b"))])).sort()).toEqual([false, true]);
    const winner = f.d1.row<{ request_id: string }>("SELECT request_id FROM billing_requests")!.request_id;
    expect(await admitBillingRequest(f.env, admission(winner))).toBe(true);
    expect(await admitBillingRequest(f.env, admission(winner, 4))).toBe(false);
    expect(f.d1.row("SELECT reserved_usd FROM device_wallets")).toEqual({ reserved_usd: 3 });
    expect(f.d1.row("SELECT COUNT(*) AS n FROM reserve_holds")).toEqual({ n: 1 });
  });

  it("admission rolls back its request when hold insertion fails", async () => {
    const f = await fixture(); const before = financialSnapshot(f);
    f.d1.sql("CREATE TRIGGER fail_hold BEFORE INSERT ON reserve_holds BEGIN SELECT RAISE(ABORT, 'hold failure'); END");
    await expect(admitBillingRequest(f.env, admission())).rejects.toThrow("hold failure");
    expect(financialSnapshot(f)).toEqual(before);
  });

  it("ambiguous committed admission rejects, then durable replay succeeds without a second reserve", async () => {
    const f = await fixture(); const original = f.env.DB.batch.bind(f.env.DB); let calls = 0;
    f.env.DB.batch = (async (statements: D1PreparedStatement[]) => { calls++; await original(statements); throw new Error("commit response lost"); }) as typeof f.env.DB.batch;
    await expect(admitBillingRequest(f.env, admission())).rejects.toThrow("commit response lost");
    expect(calls).toBe(1); f.env.DB.batch = original;
    expect(await admitBillingRequest(f.env, admission())).toBe(true);
    expect(f.d1.row("SELECT reserved_usd FROM device_wallets")).toEqual({ reserved_usd: 3 });
  });

  it("records independent durable provider attempts and normalized usage observations", async () => {
    const f = await fixture(); await admitBillingRequest(f.env, admission());
    const first = await beginBillingAttempt(f.env, { request_id: "a", provider_id: "p1", model: "m1", protocol: "chat" });
    const second = await beginBillingAttempt(f.env, { request_id: "a", provider_id: "p2", model: "m2", protocol: "responses" });
    expect(first).not.toBe(second);
    await observeBillingAttempt(f.env, first, { usage, usage_source: "upstream", provenance_json: '{"cumulative":true}', outcome: "failed", upstream_request_id: "up-1" });
    await observeBillingAttempt(f.env, first, { outcome: "unknown" });
    const rows = f.d1.rows<{ attempt_number: number; usage_json: string | null; outcome: string }>("SELECT attempt_number, usage_json, outcome FROM billing_attempts ORDER BY attempt_number");
    expect(rows.map(r => r.attempt_number)).toEqual([1, 2]);
    expect(JSON.parse(rows[0].usage_json!)).toEqual(usage);
    expect(rows[0].outcome).toBe("unknown"); expect(rows[1].usage_json).toBeNull();
  });

  it("freezes first terminal snapshot and validates device/subtoken and attempt ownership", async () => {
    const f = await fixture(); await admitBillingRequest(f.env, admission());
    await expect(persistBillingTerminal(f.env, { ...terminal(), device_id: "other" })).rejects.toThrow("owner mismatch");
    await expect(persistBillingTerminal(f.env, { ...terminal(), sub_token_id: "other-token" })).rejects.toThrow("owner mismatch");
    await expect(persistBillingTerminal(f.env, { ...terminal(), attempt_id: "missing" })).rejects.toThrow("attempt mismatch");
    await persistBillingTerminal(f.env, terminal());
    const before = f.d1.row("SELECT terminal_snapshot_json, known_cost_usd FROM billing_requests");
    await persistBillingTerminal(f.env, { ...terminal("a", 9), outcome: "failed" });
    expect(f.d1.row("SELECT terminal_snapshot_json, known_cost_usd FROM billing_requests")).toEqual(before);
    await expect(beginBillingAttempt(f.env, { request_id: "a", provider_id: "p", model: "m", protocol: "chat" })).rejects.toThrow("not active");
  });

  it("rejects cross-device subtoken admission and attributes valid subtoken terminals", async () => {
    const f = await fixture();
    f.d1.sql("INSERT INTO device_sub_tokens (id, device_id, name, token_hash, created_at) VALUES ('sub', 'dev-1', 'sub', 'sub-hash', 1)");
    expect(await admitBillingRequest(f.env, { ...admission(), sub_token_id: "missing" })).toBe(false);
    expect(await admitBillingRequest(f.env, { ...admission(), sub_token_id: "sub" })).toBe(true);
    await expect(persistBillingTerminal(f.env, terminal())).rejects.toThrow("owner mismatch");
    await persistBillingTerminal(f.env, { ...terminal(), sub_token_id: "sub" });
    await settleBillingRequest(f.env, "a");
    expect(f.d1.row("SELECT sub_token_id FROM usage")).toEqual({ sub_token_id: "sub" });
  });

  it("rejects secret/prompt metadata and copies no accidental extra body fields into snapshots", async () => {
    const f = await fixture();
    await expect(admitBillingRequest(f.env, { ...admission(), pricing_snapshot_json: '{"api_key":"secret"}' })).rejects.toThrow("Sensitive data");
    await admitBillingRequest(f.env, admission());
    await expect(persistBillingTerminal(f.env, { ...terminal(), usage_provenance_json: '{"messages":["private"]}' })).rejects.toThrow("Sensitive data");
    await persistBillingTerminal(f.env, Object.assign(terminal(), { prompt: "private", api_key: "secret" }));
    const snapshot = f.d1.row<{ terminal_snapshot_json: string }>("SELECT terminal_snapshot_json FROM billing_requests")!.terminal_snapshot_json;
    expect(snapshot).not.toContain("private"); expect(snapshot).not.toContain("secret"); expect(snapshot).not.toContain("api_key");
  });

  it("recovers a crash after terminal persistence from the durable snapshot exactly once", async () => {
    const f = await pending();
    expect(f.d1.rows("SELECT * FROM usage")).toEqual([]);
    expect(await recoverBillingRequests(f.env)).toEqual({ settled: 1, expired: 0 });
    expect(await recoverBillingRequests(f.env)).toEqual({ settled: 0, expired: 0 });
    expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets")).toEqual({ balance_usd: 8, reserved_usd: 0 });
    expect(f.d1.row("SELECT request_count, input_tokens, output_tokens, cost_usd FROM daily_stats"))
      .toEqual({ request_count: 1, input_tokens: 20, output_tokens: 10, cost_usd: 2 });
    expect(f.d1.row("SELECT delta_usd, balance_after FROM wallet_ledger")).toEqual({ delta_usd: -2, balance_after: 8 });
    expect(f.d1.row("SELECT billing_state, settlement_nonce FROM billing_requests")).toEqual({ billing_state: "settled", settlement_nonce: null });
  });

  for (const target of ["usage", "wallet_ledger", "daily_stats", "device_wallets", "reserve_holds", "terminal_state"] as const) {
    it(target + " failure rolls back claim, usage, bucket, ledger, wallet, own hold, and state", async () => {
      const f = await pending(); const before = financialSnapshot(f);
      const table = target === "terminal_state" ? "billing_requests" : target;
      const event = target === "device_wallets" ? "UPDATE" : target === "reserve_holds" ? "DELETE" : target === "terminal_state" ? "UPDATE OF settled_at" : "INSERT";
      f.d1.sql("CREATE TRIGGER injected BEFORE " + event + " ON " + table + " BEGIN SELECT RAISE(ABORT, 'injected billing failure'); END");
      await expect(settleBillingRequest(f.env, "a")).rejects.toThrow("injected billing failure");
      expect(financialSnapshot(f)).toEqual(before);
      f.d1.sql("DROP TRIGGER injected");
      await settleBillingRequest(f.env, "a");
      expect(f.d1.row("SELECT COUNT(*) AS n FROM usage")).toEqual({ n: 1 });
      expect(f.d1.row("SELECT balance_usd FROM device_wallets")).toEqual({ balance_usd: 8 });
    });
  }

  it("ambiguous committed settlement rejects once and replay never repeats any write", async () => {
    const f = await pending(); const original = f.env.DB.batch.bind(f.env.DB); let calls = 0;
    f.env.DB.batch = (async (statements: D1PreparedStatement[]) => { calls++; await original(statements); throw new Error("commit response lost"); }) as typeof f.env.DB.batch;
    await expect(settleBillingRequest(f.env, "a")).rejects.toThrow("commit response lost");
    expect(calls).toBe(1); f.env.DB.batch = original;
    const committed = financialSnapshot(f);
    await settleBillingRequest(f.env, "a"); expect(financialSnapshot(f)).toEqual(committed);
    expect(f.d1.row("SELECT balance_usd FROM device_wallets")).toEqual({ balance_usd: 8 });
  });

  it("concurrent duplicate settlement and recovery commit only one complete accounting set", async () => {
    const f = await pending();
    await Promise.all([settleBillingRequest(f.env, "a"), settleBillingRequest(f.env, "a"), recoverBillingRequests(f.env)]);
    expect(f.d1.row("SELECT COUNT(*) AS n FROM usage")).toEqual({ n: 1 });
    expect(f.d1.row("SELECT COUNT(*) AS n FROM wallet_ledger")).toEqual({ n: 1 });
    expect(f.d1.row("SELECT SUM(request_count) AS n FROM daily_stats")).toEqual({ n: 1 });
    expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets")).toEqual({ balance_usd: 8, reserved_usd: 0 });
  });

  it("settlement releases only its own hold even after prior hold release, never another live reserve", async () => {
    const f = await pending(); await reserveBalance(f.env, "dev-1", 4, "live");
    await releaseReserve(f.env, "dev-1", "a");
    await settleBillingRequest(f.env, "a");
    expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets")).toEqual({ balance_usd: 8, reserved_usd: 4 });
    expect(f.d1.rows("SELECT request_id FROM reserve_holds")).toEqual([{ request_id: "live" }]);
  });

  it("known debt beyond the estimate is recorded without clamping the wallet", async () => {
    const f = await fixture(3); await admitBillingRequest(f.env, admission());
    await persistBillingTerminal(f.env, terminal("a", 5)); await settleBillingRequest(f.env, "a");
    expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets")).toEqual({ balance_usd: -2, reserved_usd: 0 });
    expect(f.d1.row("SELECT delta_usd, balance_after FROM wallet_ledger")).toEqual({ delta_usd: -5, balance_after: -2 });
  });

  it("known partial charge settles once while retaining needs_reconciliation", async () => {
    const f = await fixture(); await admitBillingRequest(f.env, admission());
    await persistBillingTerminal(f.env, { ...terminal(), billing_state: "needs_reconciliation", outcome: "unknown", usage_source: "partial" });
    await settleBillingRequest(f.env, "a"); await settleBillingRequest(f.env, "a");
    expect(f.d1.row("SELECT billing_state, outcome FROM billing_requests")).toEqual({ billing_state: "needs_reconciliation", outcome: "unknown" });
    expect(f.d1.row<{ settled_at: number | null }>("SELECT settled_at FROM billing_requests")!.settled_at).not.toBeNull();
    expect(f.d1.row("SELECT balance_usd FROM device_wallets")).toEqual({ balance_usd: 8 });
    expect(await recoverBillingRequests(f.env)).toEqual({ settled: 0, expired: 0 });
  });

  it("explicit known zero usage still produces one ledger, usage row and daily request", async () => {
    const f = await fixture(0); await admitBillingRequest(f.env, admission("a", 0));
    await persistBillingTerminal(f.env, { ...terminal("a", 0), usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
    await settleBillingRequest(f.env, "a"); await settleBillingRequest(f.env, "a");
    expect(f.d1.row("SELECT cost_usd, total_tokens FROM usage")).toEqual({ cost_usd: 0, total_tokens: 0 });
    expect(f.d1.row("SELECT COUNT(*) AS n FROM wallet_ledger")).toEqual({ n: 1 });
    expect(f.d1.row("SELECT request_count, cost_usd FROM daily_stats")).toEqual({ request_count: 1, cost_usd: 0 });
  });

  it("expires unknown requests and only their holds without synthetic zero usage or invented cost", async () => {
    const f = await fixture(); await admitBillingRequest(f.env, admission());
    await reserveBalance(f.env, "dev-1", 4, "live");
    const attempt = await beginBillingAttempt(f.env, { request_id: "a", provider_id: "p", model: "m", protocol: "chat" });
    await observeBillingAttempt(f.env, attempt, { usage, usage_source: "partial" });
    f.d1.sql("UPDATE billing_requests SET lease_until=1 WHERE request_id='a'");
    expect(await recoverBillingRequests(f.env)).toEqual({ settled: 0, expired: 1 });
    expect(await recoverBillingRequests(f.env)).toEqual({ settled: 0, expired: 0 });
    expect(f.d1.row("SELECT billing_state, outcome, known_cost_usd, terminal_snapshot_json FROM billing_requests"))
      .toEqual({ billing_state: "needs_reconciliation", outcome: "unknown", known_cost_usd: null, terminal_snapshot_json: null });
    expect(f.d1.row("SELECT outcome FROM billing_attempts")).toEqual({ outcome: "unknown" });
    expect(f.d1.rows("SELECT * FROM usage")).toEqual([]); expect(f.d1.rows("SELECT * FROM daily_stats")).toEqual([]); expect(f.d1.rows("SELECT * FROM wallet_ledger")).toEqual([]);
    expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets")).toEqual({ balance_usd: 10, reserved_usd: 4 });
    await expect(heartbeatBillingRequest(f.env, "a")).rejects.toThrow("not active");
  });

  it("a terminal with omitted unknown cost never becomes a free usage charge", async () => {
    const f = await fixture(); await admitBillingRequest(f.env, admission());
    const unknown = { ...terminal(), usage: null }; delete unknown.cost_usd;
    await persistBillingTerminal(f.env, { ...unknown, outcome: "unknown" });
    await settleBillingRequest(f.env, "a");
    f.d1.sql("UPDATE billing_requests SET lease_until=1");
    expect(await recoverBillingRequests(f.env)).toEqual({ settled: 0, expired: 1 });
    expect(f.d1.rows("SELECT * FROM usage")).toEqual([]); expect(f.d1.rows("SELECT * FROM wallet_ledger")).toEqual([]);
    expect(f.d1.row("SELECT billing_state, known_cost_usd FROM billing_requests")).toEqual({ billing_state: "needs_reconciliation", known_cost_usd: null });
  });

  it("active leases survive recovery and legacy stale-hold sweeps regardless of hold age", async () => {
    const f = await fixture(); await admitBillingRequest(f.env, admission());
    f.ageHold("a", 7200000);
    await heartbeatBillingRequest(f.env, "a", 600000);
    expect(await releaseStaleReserves(f.env)).toBe(0);
    expect(await recoverBillingRequests(f.env)).toEqual({ settled: 0, expired: 0 });
    expect(f.holds.has("a")).toBe(true); expect(f.d1.rows("SELECT * FROM usage")).toEqual([]);
    await persistBillingTerminal(f.env, { ...terminal(), billing_state: "needs_reconciliation" });
    expect(await releaseStaleReserves(f.env)).toBe(0);
  });

  it("rechecks expiry inside the batch so a refreshed candidate cannot lose its live hold", async () => {
    const f = await fixture(); await admitBillingRequest(f.env, admission());
    f.d1.sql("UPDATE billing_requests SET lease_until=1");
    const gate = pauseNextBatch(f.env), recovering = recoverBillingRequests(f.env);
    await gate.entered;
    f.d1.sql("UPDATE billing_requests SET lease_until=?", Date.now() + 60000);
    gate.resume(); expect(await recovering).toEqual({ settled: 0, expired: 0 }); gate.restore();
    expect(f.holds.has("a")).toBe(true);
    expect(f.d1.row("SELECT reserved_usd FROM device_wallets")).toEqual({ reserved_usd: 3 });
  });

  it("expiry failure propagates and rolls back request state and own hold release", async () => {
    const f = await fixture(); await admitBillingRequest(f.env, admission());
    f.d1.sql("UPDATE billing_requests SET lease_until=1"); const before = financialSnapshot(f);
    f.d1.sql("CREATE TRIGGER fail_expire BEFORE DELETE ON reserve_holds BEGIN SELECT RAISE(ABORT, 'expiry failure'); END");
    await expect(recoverBillingRequests(f.env)).rejects.toThrow("expiry failure");
    expect(financialSnapshot(f)).toEqual(before);
  });

  it("one poisoned pending invoice does not starve later invoices or expired unknown holds", async () => {
    const f = await fixture();
    for (const id of ["a", "b", "unknown"]) await admitBillingRequest(f.env, admission(id, 1));
    await persistBillingTerminal(f.env, terminal("a", 1)); await persistBillingTerminal(f.env, terminal("b", 1));
    f.d1.sql("UPDATE billing_requests SET lease_until=0 WHERE request_id='unknown'");
    f.d1.sql("CREATE TRIGGER poison_invoice BEFORE INSERT ON wallet_ledger WHEN NEW.request_id='a' BEGIN SELECT RAISE(ABORT,'poisoned invoice'); END");
    await expect(recoverBillingRequests(f.env, 3)).rejects.toThrow("poisoned invoice");
    expect(f.d1.rows("SELECT request_id FROM usage")).toEqual([{request_id:"b"}]);
    expect(f.d1.rows("SELECT request_id FROM reserve_holds")).toEqual([{request_id:"a"}]);
    expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets")).toEqual({balance_usd:9,reserved_usd:1});
  });
  it("recovery bounds combined pending and expired candidates", async () => {
    const f = await fixture();
    for (const id of ["a", "b", "c"]) await admitBillingRequest(f.env, admission(id, 1));
    await persistBillingTerminal(f.env, terminal("a", 1));
    f.d1.sql("UPDATE billing_requests SET lease_until=1 WHERE request_id IN ('b','c')");
    expect(await recoverBillingRequests(f.env, 1)).toEqual({ settled: 1, expired: 0 });
    expect(await recoverBillingRequests(f.env, 1)).toEqual({ settled: 0, expired: 1 });
    expect(f.d1.row("SELECT COUNT(*) AS n FROM reserve_holds")).toEqual({ n: 1 });
    expect(await recoverBillingRequests(f.env, 0)).toEqual({ settled: 0, expired: 0 });
  });

  it("refuses an unavailable atomic DB rather than returning a fabricated success", async () => {
    await expect(admitBillingRequest({ DB: undefined } as unknown as Env, admission())).rejects.toThrow();
  });
});
