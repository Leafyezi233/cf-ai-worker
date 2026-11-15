import { describe, expect, it, vi } from "vitest";
import type { AuthedDevice, Env } from "../src/types";
import type { VideoReferenceAsset } from "../src/db/video_reference_assets";
import { completeVideoReferenceWrite, discardVideoReferenceAsset, finishVideoReferenceAsset, getVideoReferenceAsset, pruneVideoReferenceAssets, reserveVideoReferenceAsset, VIDEO_REFERENCE_MAX_BYTES } from "../src/db/video_reference_assets";
import type { VideoTask } from "../src/db/video_tasks";
import { claimVideoPoll, createVideoTask, markVideoSubmission, reconcileVideoTask } from "../src/db/video_tasks";
import type { RealD1 } from "./helpers/realD1";
import { makeWalletFixture } from "./helpers/walletFixture";

interface Write { sql: string; primaryChanges: number; changes: number }
function triggerInclusiveMetadata(d1: RealD1): Write[] {
  const writes: Write[] = [];
  const total = () => Number(d1.row<{ n: number }>("SELECT total_changes() AS n")!.n);
  const db: Env["DB"] = d1.DB;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const statement = prepare(sql);
    const run = statement.run.bind(statement);
    statement.run = async <T>() => {
      const before = total();
      const pending = run<T>();
      const changes = total() - before;
      const result = await pending;
      writes.push({ sql, primaryChanges: Number(result.meta.changes), changes });
      return { ...result, meta: { ...result.meta, changes } };
    };
    return statement;
  };
  return writes;
}
async function setup() {
  const f = await makeWalletFixture({ deviceIds: ["dev-1", "other"] });
  for (const id of ["dev-1", "other"]) f.d1.sql("INSERT INTO device_wallets(device_id,balance_usd,reserved_usd,created_at,updated_at) VALUES (?,10,0,1,1)", id);
  const remove = vi.fn(async (_key: string) => {});
  f.env.VIDEO_REFERENCES = { delete: remove } as unknown as R2Bucket;
  const writes = triggerInclusiveMetadata(f.d1);
  const device = { id: "dev-1", auth_via: "master", sub_token_id: null } as AuthedDevice;
  return { ...f, device, writes, remove };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function seedAsset(f: Fixture, patch: Partial<VideoReferenceAsset> = {}): VideoReferenceAsset {
  const now = Date.now();
  const asset: VideoReferenceAsset = {
    id: "vref_" + crypto.randomUUID().replace(/-/g, ""), device_id: "dev-1", sub_token_id: null,
    object_key: "video-references/" + crypto.randomUUID(), content_type: "image/png", size_bytes: 64, width: 32, height: 24,
    checksum_sha256: null, state: "ready", task_id: null, created_at: now, updated_at: now, expires_at: now + 86_400_000,
    upload_lease_until: now + 60_000, upload_token: crypto.randomUUID(), write_outcome: "confirmed", cancelled_at: null, ...patch,
  };
  const keys = Object.keys(asset) as (keyof VideoReferenceAsset)[];
  f.d1.sql("INSERT INTO video_reference_assets(" + keys.join(",") + ") VALUES (" + keys.map(() => "?").join(",") + ")", ...keys.map(key => asset[key]));
  return asset;
}
function task(ids: string[] = [], patch: Partial<VideoTask> = {}): VideoTask {
  const id = crypto.randomUUID();
  return { id, device_id: "dev-1", sub_token_id: null, idempotency_key: id, request_hash: "hash", status: "submitting",
    upstream_task_id: null, route_json: JSON.stringify({ reference_image_ids: ids }), price_usd: 3, pricing_snapshot_json: "{}",
    result_url: null, error_code: null, poll_after: null, poll_lease_until: null, created_at: Date.now(), updated_at: Date.now(), ...patch };
}
function state(f: Fixture) {
  return ["video_tasks", "video_reference_assets", "video_reference_cleanup", "device_wallets", "reserve_holds", "wallet_ledger", "usage", "audit_logs"].map(table => f.d1.rows("SELECT * FROM " + table + " ORDER BY rowid"));
}
function lastWrite(f: Fixture, prefix: string) { return f.writes.filter(write => write.sql.startsWith(prefix)).at(-1); }
function wallet(f: Fixture) { return f.d1.row("SELECT balance_usd,reserved_usd FROM device_wallets WHERE device_id = 'dev-1'"); }

describe("video single-row writes with trigger-inclusive D1 metadata", () => {
  it("reserves one asset and durable cleanup intent when run metadata reports two changes", async () => {
    const f = await setup();
    const asset = await reserveVideoReferenceAsset(f.env, f.device, "image/png");
    expect(asset).toMatchObject({ device_id: "dev-1", state: "uploading", size_bytes: VIDEO_REFERENCE_MAX_BYTES, write_outcome: "pending" });
    expect(lastWrite(f, "INSERT INTO video_reference_assets")).toMatchObject({ primaryChanges: 1, changes: 2 });
    expect(f.d1.row("SELECT changes() AS n")).toEqual({ n: 1 });
    expect(f.d1.row("SELECT asset_id,object_key,next_attempt_at FROM video_reference_cleanup")).toEqual({ asset_id: asset!.id, object_key: asset!.object_key, next_attempt_at: asset!.upload_lease_until });
  });

  for (const gate of ["global-bytes", "device-bytes", "upload-leases", "hourly-count"] as const) {
    it("reserve still returns null and writes nothing at the " + gate + " limit", async () => {
      const f = await setup();
      if (gate === "global-bytes") seedAsset(f, { device_id: "other", size_bytes: 1_000_000_000 });
      if (gate === "device-bytes") seedAsset(f, { size_bytes: 104_857_600 });
      if (gate === "upload-leases") for (let i = 0; i < 2; i++) seedAsset(f, { state: "uploading" });
      if (gate === "hourly-count") for (let i = 0; i < 20; i++) seedAsset(f);
      const before = state(f);
      expect(await reserveVideoReferenceAsset(f.env, f.device, "image/png")).toBeNull();
      expect(lastWrite(f, "INSERT INTO video_reference_assets")).toMatchObject({ primaryChanges: 0, changes: 0 });
      expect(state(f)).toEqual(before);
    });
  }

  it("finishes a confirmed upload once and reschedules cleanup with two run changes", async () => {
    const f = await setup(); const asset = seedAsset(f, { state: "uploading", write_outcome: "pending", size_bytes: VIDEO_REFERENCE_MAX_BYTES });
    await completeVideoReferenceWrite(f.env, asset, true);
    expect(await finishVideoReferenceAsset(f.env, asset, 64, 32, 24, "checksum")).toBe(true);
    expect(lastWrite(f, "UPDATE video_reference_assets SET state = 'ready'")).toMatchObject({ primaryChanges: 1, changes: 2 });
    expect(await getVideoReferenceAsset(f.env, asset.id)).toMatchObject({ state: "ready", size_bytes: 64, width: 32, height: 24, checksum_sha256: "checksum" });
    expect(f.d1.row("SELECT next_attempt_at FROM video_reference_cleanup WHERE asset_id = ?", asset.id)).toEqual({ next_attempt_at: asset.expires_at });
    const before = state(f);
    expect(await finishVideoReferenceAsset(f.env, asset, 128, 64, 48, "replay")).toBe(false);
    expect(lastWrite(f, "UPDATE video_reference_assets SET state = 'ready'")).toMatchObject({ primaryChanges: 0, changes: 0 });
    expect(state(f)).toEqual(before);
  });

  for (const guard of ["missing", "cross-owner", "token", "expired", "unconfirmed", "cancelled", "cleanup-lease"] as const) {
    it("finish preserves the " + guard + " guard with trigger-inclusive metadata", async () => {
      const f = await setup(); const asset = seedAsset(f, { state: "uploading" });
      let supplied = asset;
      if (guard === "missing") supplied = { ...asset, id: "absent" };
      if (guard === "cross-owner") supplied = { ...asset, id: seedAsset(f, { state: "uploading", device_id: "other" }).id };
      if (guard === "token") supplied = { ...asset, upload_token: "wrong" };
      if (guard === "expired") f.d1.sql("UPDATE video_reference_assets SET upload_lease_until = 0 WHERE id = ?", asset.id);
      if (guard === "unconfirmed") f.d1.sql("UPDATE video_reference_assets SET write_outcome = 'pending' WHERE id = ?", asset.id);
      if (guard === "cancelled") f.d1.sql("UPDATE video_reference_assets SET cancelled_at = 1 WHERE id = ?", asset.id);
      if (guard === "cleanup-lease") f.d1.sql("UPDATE video_reference_cleanup SET lease_token = 'active', lease_until = ? WHERE asset_id = ?", Date.now() + 30_000, asset.id);
      const before = state(f);
      expect(await finishVideoReferenceAsset(f.env, supplied, 64, 32, 24, null)).toBe(false);
      expect(lastWrite(f, "UPDATE video_reference_assets SET state = 'ready'")).toMatchObject({ primaryChanges: 0, changes: 0 });
      expect(state(f)).toEqual(before);
    });
  }

  for (const count of [0, 1, 3]) {
    it("creates a task/hold once and claims " + count + " references exactly once in batch", async () => {
      const f = await setup(); const assets = Array.from({ length: count }, () => seedAsset(f)); const ids = assets.map(a => a.id); const t = task(ids);
      expect(await createVideoTask(f.env, t, undefined, ids)).toBe(true);
      expect(lastWrite(f, "INSERT INTO video_tasks")).toMatchObject({ primaryChanges: 1, changes: 1 + count * 2 });
      expect(f.holds.size).toBe(1); expect(f.holds.get(t.id)).toMatchObject({ amount_usd: 3, device_id: "dev-1" });
      expect(wallet(f)).toEqual({ balance_usd: 10, reserved_usd: 3 });
      expect(f.d1.rows("SELECT task_id FROM video_reference_assets")).toEqual(assets.map(() => ({ task_id: t.id })));
      const before = state(f);
      expect(await createVideoTask(f.env, t, undefined, ids)).toBe(false);
      expect(lastWrite(f, "INSERT INTO video_tasks")).toMatchObject({ primaryChanges: 0, changes: 0 });
      expect(state(f)).toEqual(before);
      if (count) {
        await expect(createVideoTask(f.env, task(ids), undefined, ids)).rejects.toThrow("invalid_video_references");
        expect(state(f)).toEqual(before);
      }
    });
  }

  for (const guard of ["cross-device", "cross-token", "expired", "missing", "unconfirmed", "cleanup-lease"] as const) {
    it("task binding atomically rejects " + guard + " references without a hold or claim", async () => {
      const f = await setup();
      const asset = seedAsset(f, guard === "expired" ? { expires_at: Date.now() - 1 } : guard === "cross-device" ? { device_id: "other" } : guard === "cross-token" ? { sub_token_id: "other-sub" } : guard === "unconfirmed" ? { write_outcome: "pending" } : {});
      if (guard === "cleanup-lease") f.d1.sql("UPDATE video_reference_cleanup SET lease_token = 'busy' WHERE asset_id = ?", asset.id);
      const ids = [guard === "missing" ? "vref_" + "f".repeat(32) : asset.id]; const before = state(f);
      await expect(createVideoTask(f.env, task(ids), undefined, ids)).rejects.toThrow("invalid_video_references");
      expect(state(f)).toEqual(before);
    });
  }

  for (const guard of ["balance", "global-budget", "device-budget"] as const) {
    it("does not insert or claim references when " + guard + " is unavailable", async () => {
      const f = await setup(); const ids = [seedAsset(f).id];
      if (guard === "balance") f.d1.sql("UPDATE device_wallets SET balance_usd = 0 WHERE device_id = 'dev-1'");
      const before = state(f);
      const budget = guard === "balance" ? undefined : { monthStartMs: 0, ...(guard === "global-budget" ? { globalLimit: 0 } : { deviceLimit: 0 }) };
      expect(await createVideoTask(f.env, task(ids), budget, ids)).toBe(false);
      expect(lastWrite(f, "INSERT INTO video_tasks")).toMatchObject({ primaryChanges: 0, changes: 0 });
      expect(state(f)).toEqual(before);
    });
  }

  it("keeps poll/attach exact-one checks while terminal settlement accepts linked trigger writes once", async () => {
    const f = await setup(); const ids = [seedAsset(f).id]; const t = task(ids);
    expect(await createVideoTask(f.env, t, undefined, ids)).toBe(true);
    await markVideoSubmission(f.env, t.id, null);
    expect(await reconcileVideoTask(f.env, t.id, { kind: "attach", upstreamId: "upstream" }, "admin")).toBe(true);
    expect(lastWrite(f, "UPDATE video_tasks SET status = 'pending'")).toMatchObject({ primaryChanges: 1, changes: 1 });
    expect(await claimVideoPoll(f.env, t.id, Date.now())).toEqual(expect.any(String));
    expect(lastWrite(f, "UPDATE video_tasks SET poll_claim")).toMatchObject({ primaryChanges: 1, changes: 1 });
    expect(await claimVideoPoll(f.env, t.id, Date.now())).toBeNull();
    expect(await reconcileVideoTask(f.env, t.id, { kind: "fail", note: "verified failure" }, "admin")).toBe(true);
    expect(lastWrite(f, "UPDATE video_tasks SET status = ?")).toMatchObject({ primaryChanges: 1, changes: 3 });
    expect(f.holds.size).toBe(0); expect(wallet(f)).toEqual({ balance_usd: 10, reserved_usd: 0 });
    expect(f.d1.row("SELECT COUNT(*) AS n FROM wallet_ledger")).toEqual({ n: 1 });
    expect(f.d1.row("SELECT COUNT(*) AS n FROM usage")).toEqual({ n: 1 });
    const before = state(f);
    expect(await reconcileVideoTask(f.env, t.id, { kind: "fail", note: "replay" }, "admin")).toBe(false);
    expect(lastWrite(f, "UPDATE video_tasks SET status = ?")).toMatchObject({ primaryChanges: 0, changes: 0 });
    expect(state(f)).toEqual(before);
  });

  it("discards an unbound settled asset and reports cleanup success despite trigger deletes", async () => {
    const f = await setup(); const asset = seedAsset(f);
    expect(await discardVideoReferenceAsset(f.env, asset)).toBe(true);
    expect(lastWrite(f, "UPDATE video_reference_assets SET state = 'lost'")).toMatchObject({ primaryChanges: 1, changes: 2 });
    expect(lastWrite(f, "UPDATE video_reference_assets SET state = CASE")).toMatchObject({ primaryChanges: 1, changes: 2 });
    expect(lastWrite(f, "UPDATE video_reference_cleanup SET lease_token")).toMatchObject({ primaryChanges: 1, changes: 1 });
    expect(f.remove).toHaveBeenCalledTimes(1); expect(f.remove).toHaveBeenCalledWith(asset.object_key);
    expect(await getVideoReferenceAsset(f.env, asset.id)).toMatchObject({ state: "deleted" });
    expect(f.d1.row("SELECT * FROM video_reference_cleanup WHERE asset_id = ?", asset.id)).toBeNull();
    const before = state(f);
    expect(await discardVideoReferenceAsset(f.env, asset)).toBe(false);
    expect(state(f)).toEqual(before); expect(f.remove).toHaveBeenCalledTimes(1);
  });

  it("minute cleanup counts a successful trigger-backed deletion", async () => {
    const f = await setup(); const asset = seedAsset(f, { expires_at: Date.now() - 1 });
    expect(await pruneVideoReferenceAssets(f.env)).toBe(1);
    expect(f.remove).toHaveBeenCalledTimes(1); expect(f.remove).toHaveBeenCalledWith(asset.object_key);
    expect(lastWrite(f, "UPDATE video_reference_assets SET state = CASE")).toMatchObject({ primaryChanges: 1, changes: 2 });
    expect(await pruneVideoReferenceAssets(f.env)).toBe(0); expect(f.remove).toHaveBeenCalledTimes(1);
  });
});
