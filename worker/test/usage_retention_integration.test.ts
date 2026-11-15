import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";
import { ensureSchema } from "../src/db/schema";
import {
  getDeviceMonthlyCost, insertUsage, recordUsageSafe, releaseStaleReserves,
  reserveBalance, settleBalance, type UsageInsertData,
} from "../src/db/repo";
import {
  admitBillingRequest, persistBillingTerminal, recoverBillingRequests, settleBillingRequest,
} from "../src/db/request_billing";
import {
  claimVideoPoll, createVideoTask, finishVideoPoll, markVideoSubmission,
  videoBudgetError, type VideoBudget, type VideoTask,
} from "../src/db/video_tasks";
import {
  cleanupUsageDetails, previewUsageCleanup, verifyUsageRollups, type UsageCleanupCursor,
} from "../src/db/usage_rollups";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { sha256Hex } from "../src/utils/crypto";
import {
  CollectingExecutionContext, createRealD1, DEVICE_ID, TOKEN, chatBody, makeEnv,
  openAiAnswer, seedDevice, seedModel, seedProvider, type RealD1,
} from "./helpers/realGatewayEnv";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MONTH = Date.UTC(2026, 9, 31, 16);  
const WHEN = MONTH + 2 * DAY + 1234;
const CUTOFF = MONTH + 4 * DAY;  
const CHILD_TOKEN = "ccs_retention_child";
const handles: RealD1[] = [];

beforeEach(() => {
  resetRateLimitMemory();
  clearMemoryCacheForTest();
  vi.spyOn(Date, "now").mockReturnValue(WHEN);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected external fetch in local retention test"));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d1 of handles.splice(0)) d1.close();
});

async function fixture() {
  const d1 = createRealD1();
  handles.push(d1);
  const env = makeEnv(d1);
  await ensureSchema(env);
  await seedDevice(d1, { balance_usd: 100 });
  d1.sql("INSERT INTO device_sub_tokens(id,device_id,name,token_hash,enabled,created_at) VALUES('child',?,'Child',?,1,1)",
    DEVICE_ID, await sha256Hex(CHILD_TOKEN));
  return { d1, env };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function data(request_id: string, over: Partial<UsageInsertData> = {}): UsageInsertData {
  return {
    request_id, device_id: DEVICE_ID, sub_token_id: null, provider_id: "prov_a", provider_name: "Provider A",
    model: "gw-primary", usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30,
      cache_read_tokens: 3, cache_write_tokens: 4 }, cost_usd: 0.25, cache_hit: 0,
    status_code: 200, latency_ms: 40, created_at: WHEN, ...over,
  };
}
async function managed(f: Fixture, row: UsageInsertData, reserve = 1) {
  expect(await admitBillingRequest(f.env, {
    request_id: row.request_id, device_id: row.device_id!, sub_token_id: row.sub_token_id,
    model: row.model!, pricing_snapshot_json: "{}", reserved_usd: reserve,
  })).toBe(true);
  const receipt = await persistBillingTerminal(f.env, { ...row, outcome: "completed", usage_source: "reported_final" });
  await settleBillingRequest(f.env, row.request_id, receipt);
}
async function legacy(f: Fixture, row: UsageInsertData) {
  await recordUsageSafe(f.env, row);
  await settleBalance(f.env, row.device_id!, 0, row.cost_usd ?? 0, row.request_id);
}
function task(id: string, price = 0.75, over: Partial<VideoTask> = {}): VideoTask {
  return {
    id, device_id: DEVICE_ID, sub_token_id: null, idempotency_key: id, request_hash: id,
    status: "submitting", upstream_task_id: null,
    route_json: JSON.stringify({ provider_id: "prov_a", provider_name: "Provider A", public_model: "video" }),
    price_usd: price, pricing_snapshot_json: "{}", result_url: null, error_code: null,
    poll_after: null, poll_lease_until: null, created_at: WHEN, updated_at: WHEN, ...over,
  };
}
function snapshot(d1: RealD1) {
  return Object.fromEntries([
    "devices", "device_sub_tokens", "device_wallets", "reserve_holds", "wallet_ledger", "usage", "daily_stats",
    "billing_requests", "billing_attempts", "video_tasks", "monthly_pass_funding", "monthly_pass_buckets",
    "usage_rollup_receipts", "usage_hourly_rollups", "usage_monthly_rollups", "usage_rollup_write_context",
    "usage_rollup_cleanup_context", "usage_rollup_cleanup_permits", "usage_rollup_archived_hours",
  ].map(table => [table, d1.rows("SELECT * FROM " + table + " ORDER BY rowid")]));
}
function money(d1: RealD1) {
  return Object.fromEntries(["device_wallets", "reserve_holds", "wallet_ledger", "billing_requests", "video_tasks",
    "monthly_pass_funding", "monthly_pass_buckets"].map(table => [table, d1.rows("SELECT * FROM " + table + " ORDER BY rowid")]));
}
async function get(env: Env, path: string, token: string | null = TOKEN) {
  const response = await app.fetch(new Request("https://local.test" + path, {
    headers: token ? { authorization: "Bearer " + token } : {},
  }), env);
  return { status: response.status, body: await response.json() as any };
}
async function prune(env: Env, limit = 1) {
  let after: UsageCleanupCursor | undefined;
  let deleted = 0;
  let scanned = 0;
  for (let page = 0; page < 30; page++) {
    const result = await cleanupUsageDetails(env, { enabled: true, before: CUTOFF, limit, after });
    deleted += result.deleted;
    scanned += result.scanned;
    if (!result.next) return { deleted, scanned };
    if (after) expect(result.next.createdAt > after.createdAt ||
      (result.next.createdAt === after.createdAt && result.next.id > after.id)).toBe(true);
    after = result.next;
  }
  throw new Error("cleanup composite cursor did not terminate");
}

describe("retained usage through actual app and video budget gates (real SQLite)", () => {
  it.each(["submitting", "submission_unknown", "pending"] as const)(
    "retained totals still atomically gate global/device budgets with cross-month %s liabilities", async status => {
      for (const scope of ["global", "device"] as const) {
        const f = await fixture();
        await seedDevice(f.d1, { id: "other", token_hash: "other-hash", balance_usd: 100 });
        await legacy(f, data("own-paid", { cost_usd: 4 }));
        await legacy(f, data("other-paid", { device_id: "other", cost_usd: 1 }));
        expect(await createVideoTask(f.env, task("old-own", 2, { created_at: MONTH - DAY, updated_at: MONTH - DAY }))).toBe(true);
        expect(await createVideoTask(f.env, task("old-other", 1, { device_id: "other", created_at: MONTH - DAY, updated_at: MONTH - DAY }))).toBe(true);
        if (status !== "submitting") {
          await markVideoSubmission(f.env, "old-own", status === "pending" ? "up-own" : null);
          await markVideoSubmission(f.env, "old-other", status === "pending" ? "up-other" : null);
        }
        const budget: VideoBudget = { monthStartMs: MONTH, ...(scope === "global" ? { globalLimit: 9 } : { deviceLimit: 7 }) };
        const expectedError = scope === "global" ? "monthly_budget_exceeded" : "device_budget_exceeded";
        expect(await videoBudgetError(f.env, DEVICE_ID, 1.25, budget)).toBe(expectedError);
        expect(await createVideoTask(f.env, task("denied-before", 1.25), budget)).toBe(false);
        const finances = money(f.d1);
        expect(await prune(f.env)).toEqual({ deleted: 2, scanned: 2 });
        expect(f.d1.rows("SELECT * FROM usage")).toEqual([]);
        expect(money(f.d1)).toEqual(finances);
        expect(await getDeviceMonthlyCost(f.env, DEVICE_ID, MONTH)).toBe(4);
        expect(await videoBudgetError(f.env, DEVICE_ID, 1.25, budget)).toBe(expectedError);
        expect(await createVideoTask(f.env, task("denied-after", 1.25), budget)).toBe(false);
        expect(money(f.d1)).toEqual(finances);
        const results = await Promise.all([
          createVideoTask(f.env, task("race-a"), budget), createVideoTask(f.env, task("race-b"), budget),
        ]);
        expect(results.sort()).toEqual([false, true]);
        expect(f.d1.row("SELECT balance_usd,reserved_usd FROM device_wallets WHERE device_id=?", DEVICE_ID))
          .toEqual({ balance_usd: 96, reserved_usd: 2.75 });
        expect(f.d1.rows("SELECT * FROM reserve_holds")).toHaveLength(3);
        expect((await verifyUsageRollups(f.env)).ok).toBe(true);
      }
    });

  it("keeps authenticated owner/sub-token console aggregates and legacy billing cents after pruning, but not raw detail", async () => {
    const f = await fixture();
    await seedDevice(f.d1, { id: "other", token_hash: "other-hash", balance_usd: 100 });
    f.d1.sql("INSERT INTO device_sub_tokens(id,device_id,name,token_hash,created_at) VALUES('foreign-child','other','Foreign','foreign-hash',1)");
    await managed(f, data("owner-paid", { cost_usd: 0.5, latency_ms: null }));
    await managed(f, data("child-paid", { sub_token_id: "child", cost_usd: 0.25, cache_hit: 1, search_calls: 2 }));
    await managed(f, data("foreign-paid", { device_id: "other", sub_token_id: "foreign-child", cost_usd: 9 }), 10);
    const usagePath = "/console/usage?from=" + MONTH + "&to=" + (CUTOFF - 1) + "&limit=50";
    const billPath = "/v1/dashboard/billing/usage?start_date=2026-11-01&end_date=2026-11-30";
    async function views() {
      resetRateLimitMemory();  
      return {
        owner: await get(f.env, usagePath), child: await get(f.env, usagePath + "&sub_token_id=child"),
        foreign: await get(f.env, usagePath + "&sub_token_id=foreign-child"),
        me: await get(f.env, "/console/me"), quota: await get(f.env, "/console/quota"),
        bill: await get(f.env, billPath), childBill: await get(f.env, billPath, CHILD_TOKEN),
      };
    }
    const before = await views();
    for (const view of Object.values(before)) expect(view.status).toBe(200);
    expect(before.owner.body.summary).toMatchObject({ request_count: 2, cost_usd: 0.75, total_tokens: 60, search_calls: 2 });
    expect(before.child.body.summary).toMatchObject({ request_count: 1, cost_usd: 0.25, cache_hit_count: 1 });
    expect(before.foreign.body.summary).toMatchObject({ request_count: 0, cost_usd: 0 });
    expect(before.bill.body).toEqual({ object: "list", total_usage: 75 });
    expect(before.childBill).toEqual(before.bill);  
    expect(before.owner.body.items).toHaveLength(2);
    expect(before.child.body.items).toHaveLength(1);
    expect((await get(f.env, usagePath, CHILD_TOKEN)).status).toBe(403);
    expect((await get(f.env, usagePath, "wrong-token")).status).toBe(401);
    expect((await get(f.env, billPath, null)).status).toBe(401);
    const finances = money(f.d1);
    expect(await prune(f.env)).toEqual({ deleted: 3, scanned: 3 });
    expect(money(f.d1)).toEqual(finances);
    const after = await views();
    for (const key of ["owner", "child", "foreign"] as const) {
      expect(after[key]).toEqual({ status: 200, body: { ...before[key].body, items: [] } });
    }
    for (const key of ["me", "quota", "bill", "childBill"] as const) expect(after[key]).toEqual(before[key]);
    expect(f.d1.rows("SELECT * FROM usage")).toEqual([]);
    expect(f.d1.rows("SELECT * FROM usage_rollup_receipts")).toHaveLength(3);
    expect(await admitBillingRequest(f.env, { request_id: "child-paid", device_id: DEVICE_ID, sub_token_id: "child",
      model: "gw-primary", pricing_snapshot_json: "{}", reserved_usd: 1 })).toBe(false);
    expect(money(f.d1)).toEqual(finances);
  });

  it("examines tied-timestamp pages without pruning unknown, pending or monthly-unsettled raw rows", async () => {
    const f = await fixture();
    await managed(f, data("eligible"));
    for (const [id, outcome] of [["unknown", "unknown"], ["pending", "completed"]] as const) {
      expect(await admitBillingRequest(f.env, { request_id: id, device_id: DEVICE_ID, model: "gw-primary",
        pricing_snapshot_json: "{}", reserved_usd: 1 })).toBe(true);
      await persistBillingTerminal(f.env, { ...data(id), outcome });
      await insertUsage(f.env, data(id));
    }
    await legacy(f, data("monthly-unsettled"));
    f.d1.sql("INSERT INTO monthly_pass_funding(request_id,subscription_id,wallet_reserved_usd,released,settled) VALUES('monthly-unsettled',NULL,0,1,0)");
    await insertUsage(f.env, data("no-proof"));
    const page = await previewUsageCleanup(f.env, { before: CUTOFF, limit: 100 });
    expect(page).toMatchObject({ scanned: 5, eligible: 1 });
    const finances = money(f.d1);
    expect(await prune(f.env)).toEqual({ deleted: 1, scanned: 5 });
    expect(f.d1.rows("SELECT request_id FROM usage ORDER BY request_id")).toEqual([
      { request_id: "monthly-unsettled" }, { request_id: "no-proof" }, { request_id: "pending" }, { request_id: "unknown" },
    ]);
    expect(money(f.d1)).toEqual(finances);
    expect((await verifyUsageRollups(f.env)).ok).toBe(true);
  });
});

const targets = ["usage_rollup_receipts", "usage_hourly_rollups", "usage_monthly_rollups"] as const;
function failRollup(d1: RealD1, table: typeof targets[number]) {
  d1.sql("CREATE TRIGGER retention_fault BEFORE INSERT ON " + table + " BEGIN SELECT RAISE(ABORT,'injected retained aggregate failure'); END");
}

describe("all usage writers inherit atomic rollup failure on real SQLite", () => {
  it.each(targets)("actual managed text gateway rolls back financial/report writes when %s fails; recovery settles once", async table => {
    const f = await fixture();
    seedProvider(f.d1);
    seedModel(f.d1);
    expect(await reserveBalance(f.env, DEVICE_ID, 3, "unrelated-live")).toBe(true);
    const baseline = money(f.d1);
    failRollup(f.d1, table);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let admitted: ReturnType<typeof snapshot> | undefined;
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      admitted = snapshot(f.d1);
      expect(f.d1.rows("SELECT * FROM billing_requests")).toHaveLength(1);
      expect(f.d1.rows("SELECT * FROM reserve_holds")).toHaveLength(2);
      return openAiAnswer();
    });
    const exec = new CollectingExecutionContext();
    const response = await app.fetch(new Request("https://local.test/v1/chat/completions", {
      method: "POST", headers: { authorization: "Bearer " + CHILD_TOKEN, "content-type": "application/json" },
      body: JSON.stringify(chatBody()),
    }), f.env, exec as never);
    await response.text();
    await Promise.all(exec.pending);
    expect(response.status).toBe(500);
    expect(errors).toHaveBeenCalledWith("Worker unhandled error:", expect.objectContaining({ message: "injected retained aggregate failure" }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(admitted).toBeDefined();
    for (const name of ["usage", "daily_stats", "wallet_ledger", "usage_rollup_receipts", "usage_hourly_rollups", "usage_monthly_rollups", "usage_rollup_write_context"]) {
      expect(snapshot(f.d1)[name]).toEqual(admitted![name]);
    }
    expect(f.d1.rows("SELECT * FROM device_wallets")).toEqual(admitted!.device_wallets);
    expect(f.d1.rows("SELECT * FROM reserve_holds")).toEqual(admitted!.reserve_holds);
    expect(f.d1.rows("SELECT * FROM device_sub_tokens")).toEqual(admitted!.device_sub_tokens);
    const request = f.d1.row<any>("SELECT * FROM billing_requests")!;
    expect(request).toMatchObject({ billing_state: "pending", settled_at: null, settlement_nonce: null, known_cost_usd: 0.018 });
    expect(request.terminal_snapshot_json).not.toBeNull();  
    const pending = snapshot(f.d1);
    await expect(settleBillingRequest(f.env, request.request_id)).rejects.toThrow("injected retained aggregate failure");
    expect(snapshot(f.d1)).toEqual(pending);
    f.d1.sql("DROP TRIGGER retention_fault");
    expect(await recoverBillingRequests(f.env)).toEqual({ settled: 1, expired: 0 });
    const settled = snapshot(f.d1);
    expect(await recoverBillingRequests(f.env)).toEqual({ settled: 0, expired: 0 });
    expect(snapshot(f.d1)).toEqual(settled);
    expect(f.d1.row("SELECT balance_usd,reserved_usd FROM device_wallets WHERE device_id=?", DEVICE_ID))
      .toEqual({ balance_usd: 99.982, reserved_usd: 3 });
    expect(f.d1.rows("SELECT * FROM wallet_ledger")).toHaveLength(1);
    expect(f.d1.rows("SELECT request_id FROM reserve_holds")).toEqual([{ request_id: "unrelated-live" }]);
    expect(f.d1.row("SELECT request_count,cost_usd FROM usage_monthly_rollups")).toEqual({ request_count: 1, cost_usd: 0.018 });
    expect((await verifyUsageRollups(f.env)).ok).toBe(true);
    expect(baseline.wallet_ledger).toEqual([]);
    expect(await prune(f.env)).toEqual({ deleted: 1, scanned: 1 });
    await settleBillingRequest(f.env, request.request_id);
    expect(f.d1.rows("SELECT * FROM wallet_ledger")).toEqual(settled.wallet_ledger);
    expect(f.d1.rows("SELECT * FROM device_wallets")).toEqual(settled.device_wallets);
  });

  it.each(targets)("video settlement and legacy/import/stale writers cannot split raw from %s", async table => {
    const f = await fixture();
    expect(await createVideoTask(f.env, task("video-paid", 2, { sub_token_id: "child" }))).toBe(true);
    await markVideoSubmission(f.env, "video-paid", "upstream-video");
    const claim = await claimVideoPoll(f.env, "video-paid", WHEN);
    expect(claim).not.toBeNull();
    failRollup(f.d1, table);
    const beforeVideo = snapshot(f.d1);
    await expect(finishVideoPoll(f.env, "video-paid", { status: "succeeded", result_url: "https://video.example.test/out.mp4" }, claim!))
      .rejects.toThrow("injected retained aggregate failure");
    expect(snapshot(f.d1)).toEqual(beforeVideo);
    const imported = data("imported");
    await expect(insertUsage(f.env, imported)).rejects.toThrow("injected retained aggregate failure");
    expect(snapshot(f.d1)).toEqual(beforeVideo);
    await recordUsageSafe(f.env, data("legacy"));
    expect(snapshot(f.d1)).toEqual(beforeVideo);
    expect(await reserveBalance(f.env, DEVICE_ID, 3, "stale")).toBe(true);
    f.d1.sql("UPDATE reserve_holds SET created_at=? WHERE request_id='stale'", MONTH - DAY);
    const beforeStale = snapshot(f.d1);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await releaseStaleReserves(f.env)).toBe(0);
    expect(error).toHaveBeenCalledWith("[wallet] stale reserve transaction failed", { request_id: "stale" });
    expect(snapshot(f.d1)).toEqual(beforeStale);
    f.d1.sql("DROP TRIGGER retention_fault");
    await finishVideoPoll(f.env, "video-paid", { status: "succeeded", result_url: "https://video.example.test/out.mp4" }, claim!);
    await insertUsage(f.env, imported);
    await recordUsageSafe(f.env, data("legacy"));
    expect(await releaseStaleReserves(f.env)).toBe(1);
    expect(f.d1.rows("SELECT * FROM usage")).toHaveLength(4);
    expect(f.d1.row("SELECT SUM(request_count) AS n FROM usage_hourly_rollups")).toEqual({ n: 4 });
    expect(f.d1.rows("SELECT * FROM usage_rollup_receipts")).toHaveLength(4);
    expect(f.d1.row("SELECT balance_usd,reserved_usd FROM device_wallets WHERE device_id=?", DEVICE_ID))
      .toEqual({ balance_usd: 98, reserved_usd: 0 });
    expect(f.d1.rows("SELECT * FROM reserve_holds")).toEqual([]);
    expect((await verifyUsageRollups(f.env)).ok).toBe(true);
    const finances = money(f.d1);
    expect(await prune(f.env)).toEqual({ deleted: 1, scanned: 4 });
    expect(money(f.d1)).toEqual(finances);
    expect(f.d1.rows("SELECT request_id FROM usage ORDER BY request_id"))
      .toEqual([{ request_id: "imported" }, { request_id: "legacy" }, { request_id: "stale" }]);
  });
});
