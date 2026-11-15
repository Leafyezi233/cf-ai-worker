import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoTask } from "../src/db/video_tasks";
import { claimVideoPoll, createVideoTask, findVideoTask, finishVideoPoll, getVideoTask, listVideoTasks, markVideoSubmission } from "../src/db/video_tasks";
import { makeWalletFixture } from "./helpers/walletFixture";

const route = JSON.stringify({
  provider_id: "provider-1", provider_name: "Video provider", model: "actual-video-model", public_model: "public-video",
  service_group_id: "service-1", revision: 7, price_multiplier: 1.5, window_id: "evening",
  provider_api_key: "enc:v1:sealed-key-snapshot",
});
const pricing = JSON.stringify({ billing_unit: "call", price_per_call: 3, price_multiplier: 1.5 });
const resultUrl = "https://cdn.example.com/result.mp4?signature=kept";
const claims = new Map<string, string>();
function task(patch: Partial<VideoTask> = {}): VideoTask {
  const id = crypto.randomUUID();
  return {
    id, device_id: "dev-1", sub_token_id: "sub-1", idempotency_key: id, request_hash: "sha256:request",
    status: "submitting", upstream_task_id: null, route_json: route, price_usd: 3, pricing_snapshot_json: pricing,
    result_url: null, error_code: null, poll_after: null, poll_lease_until: null, poll_claim: null, poll_attempts: 0,
    created_at: Date.now(), updated_at: Date.now(), ...patch,
  };
}
async function setup(balance = 10) {
  const f = await makeWalletFixture({ deviceIds: ["dev-1", "other"] });
  f.d1.sql("INSERT INTO device_wallets (device_id, balance_usd, reserved_usd, created_at, updated_at) VALUES ('dev-1', ?, 0, 1, 1)", balance);
  return f;
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function pending(f: Fixture, patch: Partial<VideoTask> = {}, claim = true) {
  const t = task(patch);
  expect(await createVideoTask(f.env, t)).toBe(true);
  await markVideoSubmission(f.env, t.id, "upstream-" + t.id);
  if (claim) claims.set(t.id, (await claimVideoPoll(f.env, t.id, Date.now()))!);
  return t;
}
function wallet(f: Fixture) {
  return f.d1.row<{ balance_usd: number; reserved_usd: number }>("SELECT balance_usd, reserved_usd FROM device_wallets WHERE device_id = 'dev-1'");
}
function state(f: Fixture) {
  return ["video_tasks", "device_wallets", "reserve_holds", "wallet_ledger", "usage", "daily_stats"].map(name => f.d1.rows("SELECT * FROM " + name));
}
function expectUsageCount(f: Fixture, count: number) {
  expect(f.d1.row("SELECT COUNT(*) AS n FROM usage")).toEqual({ n: count });
  expect(f.d1.row("SELECT COUNT(*) AS n FROM wallet_ledger WHERE reason = 'usage'")).toEqual({ n: count });
  expect(f.d1.row("SELECT COALESCE(SUM(request_count), 0) AS n FROM daily_stats")).toEqual({ n: count });
}
afterEach(() => { vi.restoreAllMocks(); });

describe("persistent video tasks on real SQLite", () => {
  it("creates a full task and exact hold atomically, without billing on submission", async () => {
    const f = await setup(); const t = task();
    expect(await createVideoTask(f.env, t)).toBe(true);
    expect(await getVideoTask(f.env, t.id)).toEqual({ ...t, settlement_claim: null, upstream_usage_json: null });
    expect(f.holds.get(t.id)).toEqual({ request_id: t.id, device_id: "dev-1", amount_usd: 3, created_at: t.created_at });
    expect(wallet(f)).toEqual({ balance_usd: 10, reserved_usd: 3 }); expectUsageCount(f, 0);
    const columns = f.d1.rows<{ name: string }>("PRAGMA table_info(video_tasks)").map(c => c.name);
    expect(columns).not.toContain("prompt");
    expect(f.d1.rows("PRAGMA index_info(idx_video_tasks_device_created)").map(c => c.name)).toEqual(["device_id", "created_at"]);
    expect(f.d1.rows("PRAGMA index_info(idx_video_tasks_status_poll)").map(c => c.name)).toEqual(["status", "poll_after"]);
  });
  it("rejects insufficient balance without leaving a task or hold", async () => {
    const f = await setup(2); const t = task();
    expect(await createVideoTask(f.env, t)).toBe(false); expect(await getVideoTask(f.env, t.id)).toBeNull();
    expect(f.holds.size).toBe(0); expect(wallet(f)).toEqual({ balance_usd: 2, reserved_usd: 0 });
  });
  it("competing affordability checks cannot oversubscribe the same wallet", async () => {
    const f = await setup(3);
    expect((await Promise.all([createVideoTask(f.env, task()), createVideoTask(f.env, task())])).sort()).toEqual([false, true]);
    expect(wallet(f)).toEqual({ balance_usd: 3, reserved_usd: 3 }); expect(f.holds.size).toBe(1);
  });
  it("duplicate idempotency keys return false and can be read even after funds are exhausted", async () => {
    const f = await setup(3); const t = task({ idempotency_key: "same" });
    const duplicate = task({ idempotency_key: "same", request_hash: "different-body" });
    expect(await Promise.all([createVideoTask(f.env, t), createVideoTask(f.env, duplicate)])).toEqual([true, false]);
    expect(await findVideoTask(f.env, "dev-1", "same")).toEqual({ ...t, settlement_claim: null, upstream_usage_json: null });
    expect(await getVideoTask(f.env, duplicate.id)).toBeNull(); expect(wallet(f)?.reserved_usd).toBe(3);
    expect(await createVideoTask(f.env, t)).toBe(false);
  });
  it("free0 creates a zero hold/wallet even without funds, and settles one zero-cost usage", async () => {
    const f = await makeWalletFixture(); const t = task({ price_usd: 0 });
    expect(await createVideoTask(f.env, t)).toBe(true); expect(f.holds.get(t.id)?.amount_usd).toBe(0);
    await markVideoSubmission(f.env, t.id, "free-upstream");
    claims.set(t.id, (await claimVideoPoll(f.env, t.id, Date.now()))!);
    await finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: resultUrl }, claims.get(t.id)!);
    expect(f.d1.row("SELECT balance_usd, reserved_usd FROM device_wallets")).toEqual({ balance_usd: 0, reserved_usd: 0 });
    expectUsageCount(f as Fixture, 1);
  });
  it("device scoping covers get, find and ordered limit=30 listing", async () => {
    const f = await setup();
    const all = Array.from({ length: 32 }, (_, i) => task({ price_usd: 0, created_at: i, idempotency_key: "key-" + i }));
    for (const t of all) expect(await createVideoTask(f.env, t)).toBe(true);
    const other = task({ device_id: "other", price_usd: 0, idempotency_key: all[0].idempotency_key });
    expect(await createVideoTask(f.env, other)).toBe(true);
    expect(await getVideoTask(f.env, other.id, "dev-1")).toBeNull(); expect(await getVideoTask(f.env, other.id, "other")).not.toBeNull();
    expect((await findVideoTask(f.env, "dev-1", all[0].idempotency_key))?.id).toBe(all[0].id);
    expect(await findVideoTask(f.env, "other", "key-1")).toBeNull();
    expect((await listVideoTasks(f.env, "dev-1")).map(t => t.id)).toEqual(all.slice(2).reverse().map(t => t.id));
    expect((await listVideoTasks(f.env, "dev-1", 2)).map(t => t.id)).toEqual(all.slice(-2).reverse().map(t => t.id));
    expect(await listVideoTasks(f.env, "dev-1", 0)).toEqual([]);
  });
  it("does not steal preexisting holds or settlement request IDs", async () => {
    const f = await setup(); const t = task();
    f.d1.sql("INSERT INTO reserve_holds VALUES (?, 'other', 2, 1)", t.id);
    expect(await createVideoTask(f.env, t)).toBe(false); expect(await getVideoTask(f.env, t.id)).toBeNull();
    const settled = task(); f.d1.sql("INSERT INTO wallet_ledger (device_id, delta_usd, reason, request_id, created_at) VALUES ('dev-1', -1, 'usage', ?, 1)", settled.id);
    expect(await createVideoTask(f.env, settled)).toBe(false); expect(wallet(f)?.reserved_usd).toBe(0);
  });
  for (const price of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it("rejects invalid price " + price, async () => {
      const f = await setup(); await expect(createVideoTask(f.env, task({ price_usd: price }))).rejects.toThrow("Invalid video price");
      expect(f.holds.size).toBe(0);
    });
  }
  it("requires submitting and JSON object snapshots for new rows", async () => {
    const f = await setup();
    await expect(createVideoTask(f.env, task({ status: "succeeded" }))).rejects.toThrow("Invalid initial video task state");
    await expect(createVideoTask(f.env, task({ route_json: "[]" }))).rejects.toThrow("Invalid video route snapshot");
    await expect(createVideoTask(f.env, task({ pricing_snapshot_json: "null" }))).rejects.toThrow("Invalid video pricing snapshot");
    expect(f.holds.size).toBe(0);
  });
  for (const [event, table] of [["INSERT", "video_tasks"], ["INSERT", "reserve_holds"], ["UPDATE", "device_wallets"]]) {
    it("create rolls back every table when " + table + " fails", async () => {
      const f = await setup(); const before = state(f);
      f.d1.sql("CREATE TRIGGER injected BEFORE " + event + " ON " + table + " BEGIN SELECT RAISE(ABORT, 'injected'); END");
      await expect(createVideoTask(f.env, task())).rejects.toThrow("injected"); expect(state(f)).toEqual(before);
    });
  }
  it("null submission becomes unknown and cannot be re-submitted or polled", async () => {
    const f = await setup(); const t = task(); await createVideoTask(f.env, t);
    await markVideoSubmission(f.env, t.id, null); await markVideoSubmission(f.env, t.id, "late-id");
    expect((await getVideoTask(f.env, t.id))?.status).toBe("submission_unknown");
    expect(await claimVideoPoll(f.env, t.id, Date.now())).toBeNull();
    await finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: resultUrl }, claims.get(t.id)!);
    expect(wallet(f)).toEqual({ balance_usd: 10, reserved_usd: 3 }); expectUsageCount(f, 0);
  });
  it("pending submission is one-way and rejects empty upstream IDs", async () => {
    const f = await setup(); const t = await pending(f);
    await markVideoSubmission(f.env, t.id, null); await markVideoSubmission(f.env, t.id, "different");
    expect((await getVideoTask(f.env, t.id))?.upstream_task_id).toBe("upstream-" + t.id);
    await expect(markVideoSubmission(f.env, t.id, " ")).rejects.toThrow("Invalid upstream video task id");
  });
  it("claims one atomic 30s lease, throttles 15s, and allows abandoned lease recovery at expiry", async () => {
    const f = await setup(); const t = await pending(f, {}, false); const now = Date.now();
    const [winner, loser] = await Promise.all([claimVideoPoll(f.env, t.id, now), claimVideoPoll(f.env, t.id, now)]);
    expect(winner).toEqual(expect.any(String)); expect(loser).toBeNull();
    expect(await getVideoTask(f.env, t.id)).toMatchObject({ poll_lease_until: now + 30_000, poll_after: now + 15_000 });
    expect(await claimVideoPoll(f.env, t.id, now + 29_999)).toBeNull();
    expect(await claimVideoPoll(f.env, t.id, now + 30_000)).toEqual(expect.any(String));
  });
  it("pending finish releases lease without charging and preserves a fresh 15s throttle", async () => {
    const f = await setup(); const t = await pending(f); const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
    await finishVideoPoll(f.env, t.id, { status: "pending" }, claims.get(t.id)!);
    expect(await getVideoTask(f.env, t.id)).toMatchObject({ status: "pending", poll_lease_until: null, poll_after: now + 15_000 });
    expect(await claimVideoPoll(f.env, t.id, now + 14_999)).toBeNull(); expect(await claimVideoPoll(f.env, t.id, now + 15_000)).toEqual(expect.any(String));
    expect(wallet(f)).toEqual({ balance_usd: 10, reserved_usd: 3 }); expectUsageCount(f, 0);
  });
  it("only pending jobs with an upstream task id can be claimed", async () => {
    const f = await setup(); const t = task(); await createVideoTask(f.env, t);
    expect(await claimVideoPoll(f.env, t.id, Date.now())).toBeNull(); expect(await claimVideoPoll(f.env, "absent", Date.now())).toBeNull();
    f.d1.sql("UPDATE video_tasks SET status = 'pending' WHERE id = ?", t.id);
    expect(await claimVideoPoll(f.env, t.id, Date.now())).toBeNull();
  });
  it("concurrent terminal success settles once with immutable route/pricing attribution", async () => {
    const f = await setup(); const t = await pending(f); await pending(f, { price_usd: 4 });
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
    await Promise.all(Array.from({ length: 8 }, () => finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: resultUrl }, claims.get(t.id)!)));
    expect(wallet(f)).toEqual({ balance_usd: 7, reserved_usd: 4 }); expect(f.holds.has(t.id)).toBe(false); expect(f.holds.size).toBe(1);
    const stored = await getVideoTask(f.env, t.id); expect(stored).toMatchObject({ status: "succeeded", result_url: resultUrl, error_code: null, poll_after: null, poll_lease_until: null, route_json: route });
    expect(stored?.settlement_claim).toMatch(/^video-settlement:/);
    expect(f.d1.row("SELECT delta_usd, balance_after, note FROM wallet_ledger")).toEqual({ delta_usd: -3, balance_after: 7, note: stored?.settlement_claim });
    expect(f.d1.row("SELECT provider_id, provider_name, model, sub_token_id, cost_usd, service_group_id, service_group_revision, price_multiplier, price_window_id, pricing_snapshot_json, status_code, request_id FROM usage"))
      .toEqual({ provider_id: "provider-1", provider_name: "Video provider", model: "public-video", sub_token_id: "sub-1", cost_usd: 3, service_group_id: "service-1", service_group_revision: 7, price_multiplier: 1.5, price_window_id: "evening", pricing_snapshot_json: pricing, status_code: 200, request_id: t.id });
    expectUsageCount(f, 1); expect(JSON.stringify(f.d1.rows("SELECT * FROM usage"))).not.toContain("sealed-key-snapshot");
  });
  it("explicit failure costs zero and releases only the specified reservation", async () => {
    const f = await setup(); const t = await pending(f); await pending(f, { price_usd: 4 });
    await Promise.all([finishVideoPoll(f.env, t.id, { status: "failed", error_code: "UPSTREAM_FAILED" }, claims.get(t.id)!), finishVideoPoll(f.env, t.id, { status: "failed" }, claims.get(t.id)!)]);
    expect(wallet(f)).toEqual({ balance_usd: 10, reserved_usd: 4 });
    expect(await getVideoTask(f.env, t.id)).toMatchObject({ status: "failed", error_code: "UPSTREAM_FAILED", result_url: null });
    expect(f.d1.row("SELECT delta_usd FROM wallet_ledger")).toEqual({ delta_usd: 0 });
    expect(f.d1.row("SELECT cost_usd, status_code FROM usage")).toEqual({ cost_usd: 0, status_code: 502 });
    expect(f.d1.row("SELECT cost_usd, error_count FROM daily_stats")).toEqual({ cost_usd: 0, error_count: 1 }); expectUsageCount(f, 1);
  });
  it("success/failure races have exactly one winner and all later writes preserve that outcome", async () => {
    const f = await setup(); const t = await pending(f);
    await Promise.all([finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: resultUrl }, claims.get(t.id)!), finishVideoPoll(f.env, t.id, { status: "failed", error_code: "FAILED" }, claims.get(t.id)!)]);
    const before = state(f); await finishVideoPoll(f.env, t.id, { status: "pending" }, claims.get(t.id)!); await markVideoSubmission(f.env, t.id, null);
    await finishVideoPoll(f.env, t.id, { status: "failed" }, claims.get(t.id)!); await finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: resultUrl }, claims.get(t.id)!);
    expect(await claimVideoPoll(f.env, t.id, Date.now() + 99_000)).toBeNull(); expect(state(f)).toEqual(before); expectUsageCount(f, 1);
  });
  for (const url of [undefined, "", "http://cdn.example.com/a.mp4", "https:cdn.example.com/a.mp4", "javascript:alert(1)", "https://user:secret@cdn.example.com/a", "https://", " https://cdn.example.com/a", "https://cdn.example.com/a b"]) {
    it("invalid success URL cannot finalize or bill: " + String(url), async () => {
      const f = await setup(); const t = await pending(f); const before = state(f);
      await expect(finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: url }, claims.get(t.id)!)).rejects.toThrow(); expect(state(f)).toEqual(before);
    });
  }
  it("one success plus one failure increments the existing local-day bucket correctly", async () => {
    const f = await setup(); const now = Date.UTC(2026, 0, 1, 18); vi.spyOn(Date, "now").mockReturnValue(now);
    const a = await pending(f, { created_at: now - 1000 }); const b = await pending(f, { created_at: now - 3000 });
    await finishVideoPoll(f.env, a.id, { status: "succeeded", result_url: resultUrl }, claims.get(a.id)!);
    await finishVideoPoll(f.env, b.id, { status: "failed" }, claims.get(b.id)!);
    expect(f.d1.row("SELECT date, request_count, cost_usd, error_count, avg_latency_ms FROM daily_stats"))
      .toEqual({ date: "2026-01-02", request_count: 2, cost_usd: 3, error_count: 1, avg_latency_ms: 2000 }); expectUsageCount(f, 2);
  });
  for (const [event, table] of [["UPDATE", "video_tasks"], ["INSERT", "wallet_ledger"], ["UPDATE", "device_wallets"], ["DELETE", "reserve_holds"], ["INSERT", "usage"], ["INSERT", "daily_stats"]]) {
    it("terminal settlement rolls back all six tables when " + table + " fails", async () => {
      const f = await setup(); const t = await pending(f); const before = state(f);
      f.d1.sql("CREATE TRIGGER injected BEFORE " + event + " ON " + table + " BEGIN SELECT RAISE(ABORT, 'injected'); END");
      await expect(finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: resultUrl }, claims.get(t.id)!)).rejects.toThrow("injected");
      expect(state(f)).toEqual(before);
    });
  }
  it("an existing daily bucket update failure rolls back the entire settlement", async () => {
    const f = await setup(); const first = await pending(f); const second = await pending(f);
    await finishVideoPoll(f.env, first.id, { status: "succeeded", result_url: resultUrl }, claims.get(first.id)!); const before = state(f);
    f.d1.sql("CREATE TRIGGER injected BEFORE UPDATE ON daily_stats BEGIN SELECT RAISE(ABORT, 'injected update'); END");
    await expect(finishVideoPoll(f.env, second.id, { status: "failed", error_code: "FAILED" }, claims.get(second.id)!)).rejects.toThrow("injected update");
    expect(state(f)).toEqual(before);
  });
  it("free success writes one zero-cost settlement and releases its zero reservation", async () => {
    const f = await setup(); const t = await pending(f, { price_usd: 0 });
    await Promise.all([finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: resultUrl }, claims.get(t.id)!), finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: resultUrl }, claims.get(t.id)!)]);
    expect(wallet(f)).toEqual({ balance_usd: 10, reserved_usd: 0 }); expect(f.holds.size).toBe(0);
    expect(f.d1.row("SELECT delta_usd FROM wallet_ledger")).toEqual({ delta_usd: 0 });
    expect(f.d1.row("SELECT cost_usd, status_code FROM usage")).toEqual({ cost_usd: 0, status_code: 200 }); expectUsageCount(f, 1);
  });
  it("an absent own hold never releases another live task's reserve", async () => {
    const f = await setup(); const t = await pending(f); await pending(f, { price_usd: 4 });
    f.d1.sql("DELETE FROM reserve_holds WHERE request_id = ?", t.id); f.d1.sql("UPDATE device_wallets SET reserved_usd = 4");
    await finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: resultUrl }, claims.get(t.id)!);
    expect(wallet(f)).toEqual({ balance_usd: 7, reserved_usd: 4 }); expect(f.holds.size).toBe(1); expectUsageCount(f, 1);
  });
  it("wrong-owner hold corruption cannot debit or delete that hold", async () => {
    const f = await setup(); const t = await pending(f);
    f.d1.sql("UPDATE reserve_holds SET device_id = 'other' WHERE request_id = ?", t.id); const before = state(f);
    await finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: resultUrl }, claims.get(t.id)!); expect(state(f)).toEqual(before);
  });
  for (const operation of ["create", "finish"] as const) {
    it("ambiguous committed " + operation + " errors are not replayed, but explicit retry is idempotent", async () => {
      const f = await setup(); const t = operation === "finish" ? await pending(f) : task();
      const original = f.env.DB.batch.bind(f.env.DB); let calls = 0;
      f.env.DB.batch = (async (statements: D1PreparedStatement[]) => { calls++; await original(statements); throw new Error("transport lost"); }) as typeof f.env.DB.batch;
      const run = () => operation === "create" ? createVideoTask(f.env, t) : finishVideoPoll(f.env, t.id, { status: "succeeded", result_url: resultUrl }, claims.get(t.id)!);
      await expect(run()).rejects.toThrow("transport lost"); expect(calls).toBe(1); f.env.DB.batch = original;
      if (operation === "create") { expect(await run()).toBe(false); expect(wallet(f)).toEqual({ balance_usd: 10, reserved_usd: 3 }); expectUsageCount(f, 0); }
      else { await run(); expect(wallet(f)).toEqual({ balance_usd: 7, reserved_usd: 0 }); expectUsageCount(f, 1); }
    });
  }
});
