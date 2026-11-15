import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWalletFixture } from "./helpers/walletFixture";
import { ensureWallet } from "../src/db/repo";
import { createMonthlyPlan, issueMonthlyPass } from "../src/db/monthly_passes";
import { admitBillingRequest, beginBillingAttempt, persistBillingTerminal, settleBillingRequest, recoverBillingRequests, abandonUndispatchedBillingRequest } from "../src/db/request_billing";
import { cleanupMonthlyPassAttribution, MONTHLY_PASS_RETENTION_SCHEMA_SQL, MONTHLY_PASS_RETENTION_PAGE_SQL, MONTHLY_PASS_RETENTION_MAX_BATCH, type MonthlyPassRetentionOptions } from "../src/db/monthly_pass_retention";
import type { Env } from "../src/types";

const T = Date.UTC(2026, 10, 12, 12);
const admission = (request_id: string) => ({ request_id, device_id: "dev-1", model: "m", reserved_usd: 0.1, pricing_snapshot_json: "{}", monthly_service_group_ids: [null] });
const terminal = (request_id: string, cost_usd = 0.05) => ({ request_id, device_id: "dev-1", provider_id: "p", provider_name: "P", model: "m", cost_usd, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, status_code: 200, latency_ms: 1, created_at: T });
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  vi.spyOn(Date, "now").mockReturnValue(T);
  const f = await makeWalletFixture();
  await ensureWallet(f.env, "dev-1", 10);
  const plan = await createMonthlyPlan(f.env, { name: "retention test", enabled: 1, limits: { daily_usd: 1000, weekly_usd: 1000, five_hour_usd: 1000, total_usd: 1000 }, service_group_ids: null });
  await issueMonthlyPass(f.env, "dev-1", plan.id);
  for (const sql of MONTHLY_PASS_RETENTION_SCHEMA_SQL) f.d1.sql(sql);
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function settle(f: Fixture, id: string) {
  expect(await admitBillingRequest(f.env, admission(id))).toBe(true);
  const receipt = await persistBillingTerminal(f.env, terminal(id));
  await settleBillingRequest(f.env, id, receipt);
  return receipt;
}
function finances(f: Fixture) {
  return Object.fromEntries(["billing_requests", "billing_attempts", "monthly_pass_buckets", "monthly_pass_subscriptions", "monthly_pass_accounts", "device_wallets", "wallet_ledger", "usage", "daily_stats"].map(table => [table, f.d1.rows("SELECT * FROM " + table + " ORDER BY rowid")]));
}
const enabled = (patch: Partial<MonthlyPassRetentionOptions> = {}): MonthlyPassRetentionOptions => ({ enabled: true, before: T + 1, ...patch });

describe("monthly attribution manual retention, real SQLite", () => {
  it("defaults off and performs NO schema query/mutation without both opt-in and cutoff", async () => {
    const prepare = vi.fn(() => { throw new Error("unexpected query"); }), batch = vi.fn();
    const env = { DB: { prepare, batch } } as unknown as Env;
    for (const options of [undefined, {}, { before: T }, { enabled: false, before: T }, { enabled: true }]) {
      expect(await cleanupMonthlyPassAttribution(env, options)).toMatchObject({ enabled: false, scanned: 0 });
    }
    expect(prepare).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid cutoff %s before ANY database access", async before => {
    const prepare = vi.fn(), batch = vi.fn();
    await expect(cleanupMonthlyPassAttribution({ DB: { prepare, batch } } as unknown as Env, enabled({ before }))).rejects.toThrow("cutoff");
    expect(prepare).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity, 1.5, MONTHLY_PASS_RETENTION_MAX_BATCH + 1])("rejects invalid batch bound %s without queries", async batchLimit => {
    const prepare = vi.fn();
    await expect(cleanupMonthlyPassAttribution({ DB: { prepare } } as unknown as Env, enabled({ batchLimit }))).rejects.toThrow("batch limit");
    expect(prepare).not.toHaveBeenCalled();
  });
  it("validates keyset cursor before querying", async () => {
    const prepare = vi.fn();
    for (const after of [{ settledAt: 0, requestId: "a" }, { settledAt: T, requestId: "" }, { settledAt: T, requestId: "bad\n" }]) {
      await expect(cleanupMonthlyPassAttribution({ DB: { prepare } } as unknown as Env, enabled({ after }))).rejects.toThrow("cursor");
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("removes only released+settled attribution, retaining immutable terminal evidence and every financial/window total", async () => {
    const f = await fixture(); const receipt = await settle(f, "settled");
    expect((await cleanupMonthlyPassAttribution(f.env, enabled({ before: T }))).scanned).toBe(0);  
    const before = finances(f);
    expect(await cleanupMonthlyPassAttribution(f.env, enabled())).toMatchObject({ scanned: 1, requestBucketsDeleted: 4, fundingDeleted: 1 });
    expect(f.d1.rows("SELECT * FROM monthly_pass_request_buckets")).toEqual([]);
    expect(f.d1.rows("SELECT * FROM monthly_pass_funding")).toEqual([]);
    expect(finances(f)).toEqual(before);
    await settleBillingRequest(f.env, "settled"); await settleBillingRequest(f.env, "settled", receipt);
    await persistBillingTerminal(f.env, terminal("settled", 999));
    expect(await admitBillingRequest(f.env, admission("settled"))).toBe(false);
    await expect(beginBillingAttempt(f.env, { request_id: "settled", provider_id: "p", model: "m", protocol: "chat" })).rejects.toThrow("not active");
    expect(finances(f)).toEqual(before);
    expect(f.d1.rows("SELECT * FROM monthly_pass_funding")).toEqual([]);
    expect(f.d1.rows("SELECT * FROM monthly_pass_request_buckets")).toEqual([]);
  });

  it("retained billing receipt alone blocks financial replay even without usage/ledger acceleration rows", async () => {
    const source = await fixture(); await settle(source, "receipt-only");
    await cleanupMonthlyPassAttribution(source.env, enabled());
    expect(() => source.d1.sql("DELETE FROM usage WHERE request_id='receipt-only'")).toThrow("usage_cleanup_not_authorized");
    const sourceBefore = finances(source);
    const durable = source.d1.row<Record<string, unknown>>("SELECT * FROM billing_requests WHERE request_id='receipt-only'")!;

    const f = await fixture();
    const columns = Object.keys(durable);
    const pending: Record<string, unknown> = { ...durable, monthly_groups_json: null, billing_state: "pending", settled_at: null, hold_released_at: null };
    f.d1.sql("INSERT INTO billing_requests (" + columns.join(",") + ") VALUES (" + columns.map(() => "?").join(",") + ")",
      ...columns.map(column => pending[column]));
    const receipt = await persistBillingTerminal(f.env, terminal("receipt-only"));
    f.d1.sql("UPDATE billing_requests SET " + columns.map(column => column + "=?").join(",") + " WHERE request_id=?",
      ...columns.map(column => durable[column]), "receipt-only");
    for (const table of ["usage", "wallet_ledger", "usage_rollup_receipts", "monthly_pass_funding", "monthly_pass_request_buckets"]) {
      expect(f.d1.rows("SELECT * FROM " + table)).toEqual([]);
    }
    const before = finances(f);
    expect(await admitBillingRequest(f.env, admission("receipt-only"))).toBe(false);
    await settleBillingRequest(f.env, "receipt-only", receipt); await settleBillingRequest(f.env, "receipt-only");
    await persistBillingTerminal(f.env, terminal("receipt-only", 99)); await recoverBillingRequests(f.env);
    expect(finances(f)).toEqual(before);
    expect(f.d1.rows("SELECT * FROM monthly_pass_funding")).toEqual([]); expect(f.d1.rows("SELECT * FROM monthly_pass_request_buckets")).toEqual([]);
    expect(f.holds.size).toBe(0); expect(f.wallets.get("dev-1")?.balance).toBe(10);
    expect(f.d1.rows("SELECT * FROM usage_rollup_receipts")).toEqual([]);
    expect(finances(source)).toEqual(sourceBefore);
  });

  it("replays safely after lost settlement ACK then lost cleanup ACK, including stale terminal receipt", async () => {
    const f = await fixture(); await admitBillingRequest(f.env, admission("lost"));
    const receipt = await persistBillingTerminal(f.env, terminal("lost"));
    const original = f.env.DB.batch.bind(f.env.DB);
    let loseAck = true;
    f.env.DB.batch = (async statements => { const result = await original(statements); if (loseAck) { loseAck = false; throw new Error("lost ack"); } return result; }) as typeof f.env.DB.batch;
    await expect(settleBillingRequest(f.env, "lost", receipt)).rejects.toThrow("lost ack");
    await recoverBillingRequests(f.env); const before = finances(f);
    loseAck = true;
    await expect(cleanupMonthlyPassAttribution(f.env, enabled())).rejects.toThrow("lost ack");
    expect(await cleanupMonthlyPassAttribution(f.env, enabled())).toMatchObject({ requestBucketsDeleted: 0, fundingDeleted: 0 });
    await settleBillingRequest(f.env, "lost", receipt); await recoverBillingRequests(f.env);
    expect(await admitBillingRequest(f.env, admission("lost"))).toBe(false);
    expect(finances(f)).toEqual(before); expect(f.ledger()).toHaveLength(1);
  });

  it("keeps pending, needs_reconciliation, unknown, open, unreleased, and incomplete funding rows", async () => {
    const f = await fixture();
    for (const id of ["pending", "unknown", "reconciliation", "active", "unreleased", "unsettled-funding", "held", "recent-release", "not-dispatched"]) await admitBillingRequest(f.env, admission(id));
    await persistBillingTerminal(f.env, terminal("pending"));
    await persistBillingTerminal(f.env, { ...terminal("unknown"), cost_usd: undefined, outcome: "unknown" });
    await persistBillingTerminal(f.env, { ...terminal("reconciliation"), billing_state: "needs_reconciliation" });
    await settleBillingRequest(f.env, "reconciliation");
    for (const id of ["unreleased", "unsettled-funding", "held", "recent-release"]) { await persistBillingTerminal(f.env, terminal(id)); await settleBillingRequest(f.env, id); }
    f.d1.sql("UPDATE monthly_pass_funding SET released=0 WHERE request_id='unreleased'");
    f.d1.sql("UPDATE monthly_pass_funding SET settled=0 WHERE request_id='unsettled-funding'");
    f.d1.sql("INSERT INTO reserve_holds(request_id,device_id,amount_usd,created_at) VALUES('held','dev-1',0,?)", T);
    f.d1.sql("UPDATE billing_requests SET hold_released_at=? WHERE request_id='recent-release'", T + 1);
    await abandonUndispatchedBillingRequest(f.env, "not-dispatched");
    for (const id of ["settled-unknown", "missing-terminal", "missing-cost", "missing-outcome"]) await settle(f, id);
    f.d1.sql("UPDATE billing_requests SET outcome='unknown' WHERE request_id='settled-unknown'");
    f.d1.sql("UPDATE billing_requests SET terminal_snapshot_json=NULL WHERE request_id='missing-terminal'");
    f.d1.sql("UPDATE billing_requests SET known_cost_usd=NULL WHERE request_id='missing-cost'");
    f.d1.sql("UPDATE billing_requests SET outcome=NULL WHERE request_id='missing-outcome'");
    const financial = finances(f), funding = f.d1.rows("SELECT * FROM monthly_pass_funding ORDER BY request_id"), detail = f.d1.rows("SELECT * FROM monthly_pass_request_buckets ORDER BY request_id,kind");
    expect(await cleanupMonthlyPassAttribution(f.env, enabled())).toMatchObject({ requestBucketsDeleted: 0, fundingDeleted: 0 });
    expect(finances(f)).toEqual(financial); expect(f.d1.rows("SELECT * FROM monthly_pass_funding ORDER BY request_id")).toEqual(funding);
    expect(f.d1.rows("SELECT * FROM monthly_pass_request_buckets ORDER BY request_id,kind")).toEqual(detail);
  });

  it("retains released expired unknown evidence for later reconciliation and can then recover its original monthly payer", async () => {
    const f = await fixture(); await admitBillingRequest(f.env, admission("expired-unknown"));
    await beginBillingAttempt(f.env, { request_id: "expired-unknown", provider_id: "p", model: "m", protocol: "chat" });
    vi.mocked(Date.now).mockReturnValue(T + 6 * 60000); await recoverBillingRequests(f.env);
    expect(f.d1.row("SELECT released,settled FROM monthly_pass_funding")).toEqual({ released: 1, settled: 0 });
    const before = finances(f);
    expect(await cleanupMonthlyPassAttribution(f.env, enabled({ before: T + 6 * 60000 + 1 }))).toMatchObject({ scanned: 0, requestBucketsDeleted: 0, fundingDeleted: 0 });
    expect(finances(f)).toEqual(before); expect(f.d1.rows("SELECT * FROM monthly_pass_request_buckets")).toHaveLength(4);
    await persistBillingTerminal(f.env, terminal("expired-unknown")); await recoverBillingRequests(f.env);
    expect(f.d1.rows<{ used_usd: number }>("SELECT used_usd FROM monthly_pass_buckets").every(b => b.used_usd === .05)).toBe(true);
    expect(f.wallets.get("dev-1")?.balance).toBe(10); expect(f.ledger()[0].delta_usd).toBe(0);
    expect(await cleanupMonthlyPassAttribution(f.env, enabled({ before: T + 6 * 60000 + 1 }))).toMatchObject({ requestBucketsDeleted: 0, fundingDeleted: 0 });
    expect(f.d1.rows("SELECT * FROM monthly_pass_funding")).toHaveLength(1);
  });

  it("rechecks release/settlement state inside the DELETE transaction after candidate selection", async () => {
    const f = await fixture(); await settle(f, "raced");
    const original = f.env.DB.batch.bind(f.env.DB);
    f.env.DB.batch = (async statements => {
      f.d1.sql("UPDATE billing_requests SET billing_state='needs_reconciliation' WHERE request_id='raced'");
      return original(statements);
    }) as typeof f.env.DB.batch;
    expect(await cleanupMonthlyPassAttribution(f.env, enabled())).toMatchObject({ scanned: 1, requestBucketsDeleted: 0, fundingDeleted: 0 });
    expect(f.d1.rows("SELECT * FROM monthly_pass_request_buckets")).toHaveLength(4); expect(f.d1.rows("SELECT * FROM monthly_pass_funding")).toHaveLength(1);
  });

  it("fails closed without the optional retention index instead of falling back to a scan", async () => {
    const f = await fixture(); await settle(f, "missing-index");
    f.d1.sql("DROP INDEX idx_monthly_retention_settled");
    await expect(cleanupMonthlyPassAttribution(f.env, enabled())).rejects.toThrow("no such index");
    expect(f.d1.rows("SELECT * FROM monthly_pass_request_buckets")).toHaveLength(4); expect(f.d1.rows("SELECT * FROM monthly_pass_funding")).toHaveLength(1);
  });

  it("rolls back BOTH detail removals when the second statement fails, with no hidden replay", async () => {
    const f = await fixture(); await settle(f, "rollback");
    f.d1.sql("CREATE TRIGGER retention_fail BEFORE DELETE ON monthly_pass_funding BEGIN SELECT RAISE(ABORT,'retention failure'); END");
    await expect(cleanupMonthlyPassAttribution(f.env, enabled())).rejects.toThrow("retention failure");
    expect(f.d1.rows("SELECT * FROM monthly_pass_request_buckets")).toHaveLength(4); expect(f.d1.rows("SELECT * FROM monthly_pass_funding")).toHaveLength(1);
    f.d1.sql("DROP TRIGGER retention_fail");
    expect(await cleanupMonthlyPassAttribution(f.env, enabled())).toMatchObject({ requestBucketsDeleted: 4, fundingDeleted: 1 });
  });

  it("caps indexed candidates and physical deletions, and continues ties by request ID", async () => {
    const f = await fixture();
    for (let i = 0; i < 103; i++) await settle(f, "r-" + String(i).padStart(3, "0"));
    const before = finances(f);
    const first = await cleanupMonthlyPassAttribution(f.env, enabled());
    expect(first).toMatchObject({ scanned: 100, requestBucketsDeleted: 400, fundingDeleted: 100, next: { settledAt: T, requestId: "r-099" } });
    const second = await cleanupMonthlyPassAttribution(f.env, enabled({ after: first.next! }));
    expect(second).toMatchObject({ scanned: 3, requestBucketsDeleted: 12, fundingDeleted: 3, next: { settledAt: T, requestId: "r-102" } });
    expect(await cleanupMonthlyPassAttribution(f.env, enabled({ after: second.next! }))).toMatchObject({ scanned: 0, next: null });
    expect(finances(f)).toEqual(before);
  });

  it("bounds detail deletion even for malformed excessive child rows, keeping funding until children are gone", async () => {
    const f = await fixture(); await settle(f, "extra");
    const child = f.d1.row<{ subscription_id: string; starts_at: number }>("SELECT subscription_id,starts_at FROM monthly_pass_request_buckets LIMIT 1")!;
    for (let i = 0; i < 20; i++) f.d1.sql("INSERT INTO monthly_pass_request_buckets(request_id,subscription_id,kind,starts_at,reserved_usd) VALUES('extra',?,?,?,0)", child.subscription_id, "invalid-" + i, child.starts_at);
    expect(await cleanupMonthlyPassAttribution(f.env, enabled({ batchLimit: 1 }))).toMatchObject({ scanned: 1, requestBucketsDeleted: 4, fundingDeleted: 0 });
    expect(f.d1.rows("SELECT * FROM monthly_pass_request_buckets")).toHaveLength(20); expect(f.d1.rows("SELECT * FROM monthly_pass_funding")).toHaveLength(1);
    for (let i = 0; i < 5; i++) await cleanupMonthlyPassAttribution(f.env, enabled({ batchLimit: 1 }));
    expect(f.d1.rows("SELECT * FROM monthly_pass_request_buckets")).toEqual([]); expect(f.d1.rows("SELECT * FROM monthly_pass_funding")).toEqual([]);
  });

  it("bounds nonmonthly backlog before filtering and proves index SEARCH plans for page and both DELETEs", async () => {
    const f = await fixture();
    for (let i = 0; i < 6; i++) {
      const request = { ...admission("wallet-" + i), monthly_service_group_ids: undefined };
      await admitBillingRequest(f.env, request); await persistBillingTerminal(f.env, terminal(request.request_id)); await settleBillingRequest(f.env, request.request_id);
    }
    vi.mocked(Date.now).mockReturnValue(T + 1); await settle(f, "monthly");
    const options = enabled({ before: T + 2, batchLimit: 3 });
    const first = await cleanupMonthlyPassAttribution(f.env, options);
    expect(first).toMatchObject({ scanned: 3, requestBucketsDeleted: 0, fundingDeleted: 0 });
    const second = await cleanupMonthlyPassAttribution(f.env, { ...options, after: first.next! });
    expect(second).toMatchObject({ scanned: 3, requestBucketsDeleted: 0, fundingDeleted: 0 });
    const plans = f.d1.rows<{ detail: string }>("EXPLAIN QUERY PLAN " + MONTHLY_PASS_RETENTION_PAGE_SQL, 0, "", T + 2, 3).map(r => r.detail);
    expect(plans.some(p => p.includes("SEARCH r USING INDEX idx_monthly_retention_settled"))).toBe(true);
    expect(plans.some(p => /SCAN r|TEMP B-TREE/.test(p))).toBe(false);
    const batch = vi.spyOn(f.env.DB, "batch");
    expect(await cleanupMonthlyPassAttribution(f.env, { ...options, after: second.next! })).toMatchObject({ scanned: 1, requestBucketsDeleted: 4, fundingDeleted: 1 });
    const statements = batch.mock.calls.at(-1)![0] as unknown as Array<{ sql: string }>;
    expect(statements).toHaveLength(2);
    for (let i = 0; i < statements.length; i++) {
      const binds = i === 0 ? [JSON.stringify(["monthly"]), T + 2, T + 2, 12] : [JSON.stringify(["monthly"]), T + 2, T + 2];
      const explain = f.d1.rows<{ detail: string }>("EXPLAIN QUERY PLAN " + statements[i].sql, ...binds).map(r => r.detail);
      expect(explain.some(p => /SEARCH r USING INDEX sqlite_autoindex_billing_requests_1/.test(p))).toBe(true);
      expect(explain.some(p => /SEARCH f USING INDEX sqlite_autoindex_monthly_pass_funding_1/.test(p))).toBe(true);
      expect(explain.some(p => /SEARCH h USING (?:COVERING )?INDEX sqlite_autoindex_monthly_pass_request_buckets_1/.test(p))).toBe(true);
      expect(explain.some(p => /SCAN (?:r|f|h|monthly_pass_request_buckets|monthly_pass_funding)(?: |$)/.test(p))).toBe(false);
    }
  });
});
