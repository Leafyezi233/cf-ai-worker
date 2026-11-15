import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import type { VideoTask } from "../src/db/video_tasks";
import { claimVideoPoll, createVideoTask, finishVideoPoll, getVideoTask, listVideoTasks, markVideoSubmission, reconcileVideoTask, videoBudgetError } from "../src/db/video_tasks";
import { makeWalletFixture } from "./helpers/walletFixture";
import { createRealD1 } from "./helpers/realD1";

const MONTH_START = Date.UTC(2026, 9, 31, 16);
const NOW = Date.UTC(2026, 10, 12, 12);

function task(patch: Partial<VideoTask> = {}): VideoTask {
  const id = crypto.randomUUID();
  return { id, device_id: "dev-1", sub_token_id: "sub-1", idempotency_key: id, request_hash: "hash",
    status: "submitting", upstream_task_id: null, route_json: JSON.stringify({ provider_id: "p", model: "m" }),
    price_usd: 3, pricing_snapshot_json: "{}", result_url: null, error_code: null,
    poll_after: null, poll_lease_until: null, created_at: Date.now(), updated_at: Date.now(), ...patch };
}
async function setup() {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const f = await makeWalletFixture({ deviceIds: ["dev-1", "other"] });
  for (const id of ["dev-1", "other"]) f.d1.sql("INSERT INTO device_wallets VALUES (?, 100, 0, 1, 1)", id);
  return f;
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function snapshot(f: Fixture) {
  return ["video_tasks", "device_wallets", "reserve_holds", "wallet_ledger", "usage", "daily_stats", "audit_logs"]
    .map(table => f.d1.rows("SELECT * FROM " + table + " ORDER BY rowid"));
}
async function pending(f: Fixture) {
  const t = task(); await createVideoTask(f.env, t); await markVideoSubmission(f.env, t.id, "upstream"); return t;
}
function usage(f: Fixture, device: string, cost: number, at: number) {
  f.d1.sql("INSERT INTO usage (device_id, cost_usd, created_at) VALUES (?, ?, ?)", device, cost, at);
}
function collectSql(f: Fixture) {
  const sql: string[] = [];
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  vi.spyOn(f.env.DB, "prepare").mockImplementation((text: string) => { sql.push(text); return prepare(text); });
  return sql;
}
function plan(f: Fixture, sql: string) {
  return f.d1.rows<{ detail: string }>("EXPLAIN QUERY PLAN " + sql, ...Array((sql.match(/\?/g) ?? []).length).fill(null)).map(r => r.detail);
}
afterEach(() => vi.restoreAllMocks());

describe("atomic video budget SQL", () => {
  for (const cap of ["globalLimit", "deviceLimit"] as const) {
    it(cap + " serializes competing creates at exact boundary", async () => {
      const f = await setup(); const budget = { monthStartMs: MONTH_START, [cap]: 5 };
      usage(f, "dev-1", 2, MONTH_START);
      const result = await Promise.all([createVideoTask(f.env, task(), budget), createVideoTask(f.env, task(), budget)]);
      expect(result.sort()).toEqual([false, true]);
      expect(f.d1.row("SELECT reserved_usd FROM device_wallets WHERE device_id = 'dev-1'")).toEqual({ reserved_usd: 3 });
      expect(f.holds.size).toBe(1);
      expect(await videoBudgetError(f.env, "dev-1", 0, budget)).toBeNull();
      expect(await videoBudgetError(f.env, "dev-1", 0.01, budget)).toBe(cap === "globalLimit" ? "monthly_budget_exceeded" : "device_budget_exceeded");
      expect(await createVideoTask(f.env, task({ price_usd: 0.01 }), budget)).toBe(false);
    });
  }
  it("global cap serializes competing accounts, not just competing wallet holds", async () => {
    const f = await setup(); const budget = { monthStartMs: MONTH_START, globalLimit: 3 };
    expect((await Promise.all([createVideoTask(f.env, task(), budget), createVideoTask(f.env, task({ device_id: "other" }), budget)])).sort()).toEqual([false, true]);
    expect(f.d1.row("SELECT SUM(reserved_usd) AS reserved FROM device_wallets")).toEqual({ reserved: 3 });
  });
  it("global cap includes other devices while device cap isolates them", async () => {
    const f = await setup(); usage(f, "other", 2, MONTH_START); usage(f, "dev-1", 999, MONTH_START - 1);
    await createVideoTask(f.env, task({ device_id: "other", price_usd: 3 }));
    expect(await createVideoTask(f.env, task(), { monthStartMs: MONTH_START, globalLimit: 7 })).toBe(false);
    expect(await videoBudgetError(f.env, "dev-1", 3, { monthStartMs: MONTH_START, globalLimit: 7, deviceLimit: 2 })).toBe("monthly_budget_exceeded");
    expect(await createVideoTask(f.env, task(), { monthStartMs: MONTH_START, deviceLimit: 3 })).toBe(true);
  });
  for (const status of ["submitting", "submission_unknown", "pending"] as const) {
    it("counts cross-month " + status + " liabilities without a hold or created-at cutoff", async () => {
      const f = await setup(); const old = task({ created_at: 1 }); await createVideoTask(f.env, old);
      if (status !== "submitting") await markVideoSubmission(f.env, old.id, status === "pending" ? "up" : null);
      f.d1.sql("DELETE FROM reserve_holds WHERE request_id = ?", old.id);
      for (const cap of ["globalLimit", "deviceLimit"] as const) {
        const budget = { monthStartMs: MONTH_START, [cap]: 5 };
        expect(await createVideoTask(f.env, task(), budget)).toBe(false);
        expect(await createVideoTask(f.env, task({ price_usd: 2 }), budget)).toBe(true);
        f.d1.sql("DELETE FROM video_tasks WHERE id <> ?", old.id);
      }
    });
  }
  it("settlement transfers active liability into this month's usage exactly once", async () => {
    const f = await setup(); const t = await pending(f); const claim = (await claimVideoPoll(f.env, t.id, Date.now()))!;
    await finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: "https://cdn.example/video" }, claim);
    const budget = { monthStartMs: MONTH_START, globalLimit: 6, deviceLimit: 6 };
    expect(await createVideoTask(f.env, task(), budget)).toBe(true);
    expect(await createVideoTask(f.env, task({ price_usd: 0.01 }), budget)).toBe(false);
  });
  it("old settled usage is excluded, failed tasks cost zero, exact zero cap allows only free tasks", async () => {
    const f = await setup(); usage(f, "dev-1", 100, MONTH_START - 1);
    const t = await pending(f); await reconcileVideoTask(f.env, t.id, { kind: "fail", note: "verified failed" }, "operator");
    const budget = { monthStartMs: MONTH_START, globalLimit: 0, deviceLimit: 0 };
    expect(await createVideoTask(f.env, task({ price_usd: 0 }), budget)).toBe(true);
    expect(await createVideoTask(f.env, task({ price_usd: 0.001 }), budget)).toBe(false);
  });
  it("disabled caps produce no aggregate SQL, including diagnosis", async () => {
    const f = await setup(); const sql = collectSql(f);
    await createVideoTask(f.env, task()); await createVideoTask(f.env, task(), { monthStartMs: MONTH_START });
    expect(await videoBudgetError(f.env, "dev-1", 3, { monthStartMs: MONTH_START })).toBeNull();
    expect(sql.join(" ")).not.toMatch(/SUM\s*\(/i);
  });
  it("diagnostic may race and never replaces the atomic gate", async () => {
    const f = await setup(); const budget = { monthStartMs: MONTH_START, globalLimit: 3 };
    expect(await videoBudgetError(f.env, "dev-1", 3, budget)).toBeNull();
    expect(await createVideoTask(f.env, task(), budget)).toBe(true);
    expect(await createVideoTask(f.env, task(), budget)).toBe(false);
  });
  it("rejects invalid cap and period inputs before reserving", async () => {
    const f = await setup(); const before = snapshot(f);
    for (const budget of [{ monthStartMs: -1 }, { monthStartMs: NaN }, { monthStartMs: 0, globalLimit: Infinity }, { monthStartMs: 0, deviceLimit: -1 }]) {
      await expect(createVideoTask(f.env, task(), budget)).rejects.toThrow("Invalid video budget");
    }
    expect(snapshot(f)).toEqual(before);
  });
});

describe("poll claim fencing and replay", () => {
  it("old lease pending/success/failure and missing tokens cannot touch the new lease", async () => {
    const f = await setup(); const t = await pending(f); const now = Date.now();
    const old = (await claimVideoPoll(f.env, t.id, now))!;
    const current = (await claimVideoPoll(f.env, t.id, now + 30_000))!;
    expect(current).toEqual(expect.any(String)); expect(current).not.toBe(old);
    expect(await getVideoTask(f.env, t.id)).toMatchObject({ poll_claim: current, poll_attempts: 2 });
    const before = snapshot(f);
    for (const claim of [old, "", undefined as unknown as string]) {
      await finishVideoPoll(f.env, t.id, { status: "pending", error_code: "stale" }, claim);
      await finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: "https://cdn.example/video" }, claim);
      await finishVideoPoll(f.env, t.id, { status: "failed" }, claim);
    }
    expect(snapshot(f)).toEqual(before);
    await finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: "https://cdn.example/video" }, current);
    const settled = snapshot(f);
    await finishVideoPoll(f.env, t.id, { status: "failed" }, current);
    expect(snapshot(f)).toEqual(settled);
    expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets WHERE device_id = 'dev-1'")).toEqual({ balance_usd: 97, reserved_usd: 0 });
  });
  it("retry delay cannot bypass the 15-second floor or overflow", async () => {
    const f = await setup(); const t = await pending(f); const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
    const claim = (await claimVideoPoll(f.env, t.id, now))!;
    const before = snapshot(f);
    for (const next_poll_ms of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      await expect(finishVideoPoll(f.env, t.id, { status: "pending", next_poll_ms }, claim)).rejects.toThrow("Invalid video poll delay");
    }
    await expect(claimVideoPoll(f.env, t.id, Number.MAX_SAFE_INTEGER)).rejects.toThrow("Invalid video poll time");
    expect(snapshot(f)).toEqual(before);
    await finishVideoPoll(f.env, t.id, { status: "pending", next_poll_ms: 0 }, claim);
    expect((await getVideoTask(f.env, t.id))?.poll_after).toBe(now + 15_000);
  });
  it("pending clears its claim, applies bounded-below backoff and rejects replay", async () => {
    const f = await setup(); const t = await pending(f); const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
    const claim = (await claimVideoPoll(f.env, t.id, now))!;
    await finishVideoPoll(f.env, t.id, { status: "pending", next_poll_ms: 120_000, error_code: "RETRY" }, claim);
    expect(await getVideoTask(f.env, t.id)).toMatchObject({ poll_claim: null, poll_lease_until: null, poll_after: now + 120_000, poll_attempts: 1 });
    const before = snapshot(f); await finishVideoPoll(f.env, t.id, { status: "failed" }, claim); expect(snapshot(f)).toEqual(before);
    expect(await claimVideoPoll(f.env, t.id, now + 119_999)).toBeNull();
    expect(await claimVideoPoll(f.env, t.id, now + 120_000)).toEqual(expect.any(String));
  });
});

describe("admin reconciliation CAS and atomic audit", () => {
  it("attaches verified unknown IDs once, retains reservation and never replaces a known pending ID", async () => {
    const f = await setup(); const t = task(); await createVideoTask(f.env, t);
    expect(await reconcileVideoTask(f.env, t.id, { kind: "attach", upstreamId: "up" }, "admin")).toBe(false);
    await markVideoSubmission(f.env, t.id, null);
    expect(await Promise.all([reconcileVideoTask(f.env, t.id, { kind: "attach", upstreamId: "up" }, "admin"), reconcileVideoTask(f.env, t.id, { kind: "attach", upstreamId: "other-up" }, "admin")])).toEqual([true, false]);
    expect(await getVideoTask(f.env, t.id)).toMatchObject({ status: "pending", upstream_task_id: "up", poll_claim: null });
    expect(f.holds.has(t.id)).toBe(true);
    expect(f.d1.rows("SELECT action, details_json FROM audit_logs")).toEqual([{ action: "video.reconcile.attach", details_json: JSON.stringify({ actor: "admin", upstreamId: "up" }) }]);
    expect(f.ledger()).toHaveLength(0);
  });
  for (const initial of ["submission_unknown", "pending"] as const) {
    it("zero-settles verified " + initial + " failure once, invalidating active poll claims", async () => {
      const f = await setup(); const t = task(); await createVideoTask(f.env, t); await markVideoSubmission(f.env, t.id, initial === "pending" ? "up" : null);
      const claim = await claimVideoPoll(f.env, t.id, Date.now());
      const fail = () => reconcileVideoTask(f.env, t.id, { kind: "fail", note: "provider confirmed failure" }, "admin-1");
      expect(await Promise.all([fail(), fail()])).toEqual([true, false]);
      const before = snapshot(f); if (claim) await finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: "https://cdn.example/video" }, claim);
      expect(await fail()).toBe(false); expect(snapshot(f)).toEqual(before);
      expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets WHERE device_id = 'dev-1'")).toEqual({ balance_usd: 100, reserved_usd: 0 });
      expect(f.d1.rows("SELECT cost_usd FROM usage")).toEqual([{ cost_usd: 0 }]); expect(f.ledger()).toHaveLength(1);
      expect(f.d1.rows("SELECT action, details_json FROM audit_logs")).toEqual([{ action: "video.reconcile.fail", details_json: JSON.stringify({ actor: "admin-1", note: "provider confirmed failure" }) }]);
    });
  }
  for (const kind of ["attach", "fail"] as const) {
    it(kind + " audit failure rolls back the entire state transition", async () => {
      const f = await setup(); const t = task(); await createVideoTask(f.env, t); await markVideoSubmission(f.env, t.id, null);
      const before = snapshot(f);
      f.d1.sql("CREATE TRIGGER audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit rejected'); END");
      await expect(reconcileVideoTask(f.env, t.id, kind === "attach" ? { kind, upstreamId: "up" } : { kind, note: "verified" }, "admin")).rejects.toThrow("audit rejected");
      expect(snapshot(f)).toEqual(before);
    });
  }
  for (const kind of ["attach", "fail"] as const) {
    it(kind + " survives an ambiguous commit without replay or duplicate audit", async () => {
      const f = await setup(); const t = task(); await createVideoTask(f.env, t); await markVideoSubmission(f.env, t.id, null);
      const original = f.env.DB.batch.bind(f.env.DB); let calls = 0;
      f.env.DB.batch = (async (statements: D1PreparedStatement[]) => { calls++; await original(statements); throw new Error("transport lost"); }) as typeof f.env.DB.batch;
      const reconcile = () => reconcileVideoTask(f.env, t.id, kind === "attach" ? { kind, upstreamId: "verified-up" } : { kind, note: "verified failed" }, "admin");
      await expect(reconcile()).rejects.toThrow("transport lost"); expect(calls).toBe(1); f.env.DB.batch = original;
      const committed = snapshot(f); expect(await reconcile()).toBe(false); expect(snapshot(f)).toEqual(committed);
      expect(f.d1.rows("SELECT * FROM audit_logs")).toHaveLength(1);
    });
  }
  it("rejects absent audit evidence and never releases uncertain reservations", async () => {
    const f = await setup(); const t = await pending(f); const before = snapshot(f);
    await expect(reconcileVideoTask(f.env, t.id, { kind: "fail", note: "" }, "admin")).rejects.toThrow("Invalid video reconciliation note");
    await expect(reconcileVideoTask(f.env, t.id, { kind: "fail", note: "checked" }, "")).rejects.toThrow("Invalid video reconciliation actor");
    await expect(reconcileVideoTask(f.env, t.id, { kind: "attach", upstreamId: " " }, "admin")).rejects.toThrow("Invalid upstream video task id");
    expect(snapshot(f)).toEqual(before);
  });
  it("cannot synthesize success or free submitting/settled jobs", async () => {
    const f = await setup(); const t = task(); await createVideoTask(f.env, t);
    expect(await reconcileVideoTask(f.env, t.id, { kind: "fail", note: "verified" }, "admin")).toBe(false);
    await expect(reconcileVideoTask(f.env, t.id, { kind: "succeed" } as never, "admin")).rejects.toThrow();
    await markVideoSubmission(f.env, t.id, "up"); const claim = (await claimVideoPoll(f.env, t.id, Date.now()))!;
    await finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: "https://cdn.example/video" }, claim);
    const before = snapshot(f);
    expect(await reconcileVideoTask(f.env, t.id, { kind: "fail", note: "verified" }, "admin")).toBe(false);
    expect(await reconcileVideoTask(f.env, t.id, { kind: "attach", upstreamId: "up2" }, "admin")).toBe(false);
    expect(snapshot(f)).toEqual(before);
  });
});

describe("video SQL query plans", () => {
  it("all six settlement statements use point lookups, not outer wallet/hold scans", async () => {
    const f = await setup(); const t = await pending(f); const claim = (await claimVideoPoll(f.env, t.id, Date.now()))!; const sql = collectSql(f);
    await finishVideoPoll(f.env, t.id, { status: "failed" }, claim);
    expect(sql).toHaveLength(6);
    const plans = sql.map(s => plan(f, s));
    expect(plans.flat().filter(p => /SCAN (?:device_wallets|reserve_holds|w\b|h\b)/i.test(p))).toEqual([]);
    expect(plans[2].some(p => /SEARCH device_wallets USING INDEX .*\(device_id=\?\)/.test(p))).toBe(true);
    expect(plans[3].some(p => /SEARCH reserve_holds USING INDEX .*\(request_id=\?\)/.test(p))).toBe(true);
    console.log("Video settlement outer plans:", plans[2][0], ";", plans[3][0]);
  });
  it("device/sub-token ordered lists and status-age cleanup have covering prefixes", async () => {
    const f = await setup(); const sql = collectSql(f); await listVideoTasks(f.env, "dev-1"); await listVideoTasks(f.env, "dev-1", 30, "sub-1");
    for (const query of sql) { const details = plan(f, query); expect(details.some(p => p.includes("SEARCH video_tasks USING INDEX"))).toBe(true); expect(details.join(" ")).not.toContain("TEMP B-TREE"); }
    const details = plan(f, "SELECT id FROM video_tasks WHERE status = ? AND created_at < ?");
    expect(details.join(" ")).toContain("idx_video_tasks_status_created");
    expect(f.d1.rows("PRAGMA index_info(idx_video_tasks_device_sub_created_id)").map(r => r.name)).toEqual(["device_id", "sub_token_id", "created_at", "id"]);
  });
  it("active liability sums use indexes and current usage uses period/device ranges", async () => {
    const f = await setup(); const sql = collectSql(f); await createVideoTask(f.env, task(), { monthStartMs: MONTH_START, globalLimit: 10, deviceLimit: 10 });
    const query = sql.find(s => s.startsWith("INSERT INTO video_tasks"))!; const details = plan(f, query);
    expect(details.filter(p => /^SCAN video_tasks$/.test(p))).toEqual([]);
    expect(details.some(p => /idx_video_tasks_(active|status)/.test(p))).toBe(true);
    expect(details.some(p => /SEARCH m USING INDEX .*\(month_start>\?\)/.test(p))).toBe(true);
    expect(details.join(" ")).toContain("idx_usage_monthly_device");
    expect(details.some(p => /SEARCH u USING INDEX idx_usage_(?:created_at|rollup_cleanup_page) \(created_at>\?\)/.test(p))).toBe(true);
    expect(details.join(" ")).toContain("idx_usage_device_created");
    expect(details.filter(p => /^SCAN (?:u|m|usage|usage_monthly_rollups)(?: |$)/.test(p))).toEqual([]);
  });
});

describe("old video schema upgrade", () => {
  it("ensureSchema adds fencing and settlement columns without rewriting old liabilities, including cold restarts", async () => {
    const d1 = createRealD1();
    try {
      d1.sql("ALTER TABLE video_tasks DROP COLUMN poll_claim"); d1.sql("ALTER TABLE video_tasks DROP COLUMN poll_attempts"); d1.sql("ALTER TABLE video_tasks DROP COLUMN settlement_claim");
      d1.sql("INSERT INTO video_tasks (id, device_id, idempotency_key, request_hash, status, route_json, price_usd, pricing_snapshot_json, created_at, updated_at) VALUES ('old', 'dev-1', 'old', 'hash', 'submission_unknown', '{}', 3, '{}', 1, 2)");
      d1.sql("INSERT INTO device_wallets VALUES ('dev-1', 100, 3, 1, 2)"); d1.sql("INSERT INTO reserve_holds VALUES ('old', 'dev-1', 3, 1)");
      const before = d1.row("SELECT * FROM video_tasks");
      for (let i = 0; i < 3; i++) {
        vi.resetModules(); const { ensureSchema } = await import("../src/db/schema"); await ensureSchema({ DB: d1.DB } as Env);
        expect(d1.row("SELECT * FROM video_tasks")).toEqual({ ...before, poll_claim: null, poll_attempts: 0, settlement_claim: null, upstream_usage_json: null });
        expect(d1.row("SELECT reserved_usd FROM device_wallets")).toEqual({ reserved_usd: 3 }); expect(d1.rows("SELECT * FROM reserve_holds")).toHaveLength(1);
      }
    } finally { d1.close(); }
  });
});
