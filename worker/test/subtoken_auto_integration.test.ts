import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { resetVideoReadLimits } from "../src/gateway/video";
import { createServiceGroup, setDeviceServiceGroups, updateServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import { sha256Hex } from "../src/utils/crypto";
import type { Env, ServiceGroupRow } from "../src/types";
import {
  CollectingExecutionContext, DEVICE_ID, TOKEN, chatBody, createRealD1, holdRows,
  ledgerRows, makeEnv, openAiAnswer, seedDevice, seedDeviceGroups, seedDeviceModels,
  seedGroup, seedGroupMembers, seedModel, seedProvider, wallet, type RealD1,
} from "./helpers/realGatewayEnv";

const PUBLIC_MODEL = "sub-auto-chat";
const SUB_ID = "auto-sub";
const SUB_TOKEN = "auto-sub-credential";
const INITIAL_BALANCE = 100;
let db: RealD1;
let env: Env;
type Call = { url: string; method: string; body: Record<string, unknown> | null; auth: string | null };
let calls: Call[];
let fetchErrors: unknown[];
type Invoice = {
  device_id: string; sub_token_id: string | null; provider_id: string; model: string;
  service_group_id: string | null; service_group_revision: number | null;
  pricing_snapshot_json: string; cost_usd: number; price_multiplier: number;
  price_window_id: string | null; request_id: string;
};
const invoices = () => db.rows<Invoice>("SELECT * FROM usage ORDER BY id");

beforeEach(async () => {
  resetRateLimitMemory(); clearMemoryCacheForTest(); resetVideoReadLimits();
  db = createRealD1(); env = makeEnv(db);
  env.ENCRYPTION_KEY = "subtoken-auto-integration-test-key";
  await seedDevice(db, { balance_usd: INITIAL_BALANCE });
  db.sql("INSERT INTO device_sub_tokens (id, device_id, name, token_hash, enabled, created_at, service_group_id) VALUES (?, ?, ?, ?, 1, 1, NULL)",
    SUB_ID, DEVICE_ID, "Auto integration", await sha256Hex(SUB_TOKEN));
  calls = []; fetchErrors = [];
  stubFetch();
});
afterEach(() => {
  vi.restoreAllMocks(); db.close();
  expect(fetchErrors).toEqual([]);
});

function stubFetch(reply: (call: Call, index: number) => Response | Promise<Response> = () => openAiAnswer()) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const call = { url: String(url), method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
      auth: new Headers(init?.headers).get("authorization") };
    calls.push(call);
    try { return await reply(call, calls.length); }
    catch (error) { fetchErrors.push(error); throw error; }
  });
}
async function request(token = SUB_TOKEN, model = PUBLIC_MODEL, extra: Record<string, unknown> = {}) {
  const exec = new CollectingExecutionContext();
  const response = await gatewayApp.request("https://gw.test/chat/completions", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(chatBody(model, extra)),
  }, env, exec as never);
  const body = response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text();
  await Promise.all(exec.pending);
  return { response, body };
}
async function offer(id: string, multiplier = 1, publicSelectable = 1, key = PUBLIC_MODEL) {
  seedProvider(db, { id, endpoint: "https://" + id + ".test/v1", api_key: "key-" + id });
  seedModel(db, { id, provider_id: id, model_name: id + "-upstream", input_price_per_m: 10, output_price_per_m: 20 });
  const group = await createServiceGroup(env, { name: id, multiplier, public_selectable: publicSelectable });
  await upsertServiceGroupModel(env, group.id, { model_key: key, target_type: "model", target_id: id });
  return { ...group, revision: group.revision + 1 };
}
function select(account: string | null, master: string | null, sub: string | null = null) {
  db.sql("UPDATE devices SET default_service_group_id=?, service_group_id=? WHERE id=?", account, master, DEVICE_ID);
  db.sql("UPDATE device_sub_tokens SET service_group_id=? WHERE id=?", sub, SUB_ID);
}
function noHolds() {
  expect(wallet(db)?.reserved_usd).toBe(0);
  expect(holdRows(db)).toEqual([]);
  expect(db.rows("SELECT device_id FROM device_wallets")).toEqual([{ device_id: DEVICE_ID }]);
}
function billed(group: ServiceGroupRow, cost: number, sub: string | null = SUB_ID, model = PUBLIC_MODEL) {
  expect(invoices().at(-1)).toMatchObject({ device_id: DEVICE_ID, sub_token_id: sub,
    model, service_group_id: group.id, service_group_revision: group.revision });
  expect(invoices().at(-1)?.cost_usd).toBeCloseTo(cost, 10);
  noHolds();
}

describe("sub-token Auto integration (real SQLite, fetch-only upstream)", () => {
  it("inherits account Auto, not the master fixed override, and honors an explicit sub fixed override", async () => {
    const cheap = await offer("cheap");
    const fixed = await offer("fixed", 3);
    select("auto", fixed.id);
    expect((await request(TOKEN)).response.status).toBe(200);
    billed(fixed, 0.09, null);
    expect((await request()).response.status).toBe(200);
    billed(cheap, 0.03);
    db.sql("UPDATE device_sub_tokens SET service_group_id=? WHERE id=?", fixed.id, SUB_ID);
    expect((await request()).response.status).toBe(200);
    billed(fixed, 0.09);
    expect(calls.map(c => c.body?.model)).toEqual(["fixed-upstream", "cheap-upstream", "fixed-upstream"]);
    expect(invoices()).toHaveLength(3);
    expect(ledgerRows(db)).toHaveLength(3);
    expect(wallet(db)?.balance_usd).toBeCloseTo(INITIAL_BALANCE - 0.21, 10);
    expect(db.row("SELECT default_service_group_id, service_group_id FROM devices WHERE id=?", DEVICE_ID))
      .toEqual({ default_service_group_id: "auto", service_group_id: fixed.id });
  });

  it("keeps explicit sub Auto distinct from null inheritance of a fixed account default and the master Auto override", async () => {
    const cheap = await offer("cheap");
    const fixed = await offer("fixed", 3);
    select(fixed.id, "auto");
    expect((await request()).response.status).toBe(200);
    billed(fixed, 0.09);
    expect((await request(TOKEN)).response.status).toBe(200);
    billed(cheap, 0.03, null);
    db.sql("UPDATE device_sub_tokens SET service_group_id='auto' WHERE id=?", SUB_ID);
    expect((await request()).response.status).toBe(200);
    billed(cheap, 0.03);
    expect(calls.map(c => c.body?.model)).toEqual(["fixed-upstream", "cheap-upstream", "cheap-upstream"]);
    expect(invoices()).toHaveLength(3);
    expect(wallet(db)?.balance_usd).toBeCloseTo(INITIAL_BALANCE - 0.15, 10);
  });

  it("uses owner private-group authorization and observes grant withdrawal on the next sub request", async () => {
    const publicGroup = await offer("public", 3);
    const privateGroup = await offer("private", 1, 0);
    seedProvider(db, { id: "legacy", endpoint: "https://legacy.test/v1" });
    seedModel(db, { id: "legacy", provider_id: "legacy", alias: PUBLIC_MODEL });
    select("auto", null);
    expect((await request()).response.status).toBe(200);
    billed(publicGroup, 0.09);
    await setDeviceServiceGroups(env, DEVICE_ID, [privateGroup.id]);
    expect((await request()).response.status).toBe(200);
    billed(privateGroup, 0.03);
    await setDeviceServiceGroups(env, DEVICE_ID, []);
    expect((await request()).response.status).toBe(200);
    billed(publicGroup, 0.09);
    db.sql("UPDATE devices SET model_scope='list' WHERE id=?", DEVICE_ID);
    seedDeviceModels(db, ["public", "private"]);  
    await updateServiceGroup(env, publicGroup.id, { enabled: 0 });
    const denied = await request();
    expect(denied.response.status).toBe(403); expect(denied.body).toMatchObject({ error: "model_not_in_scope" });
    expect(calls.map(c => c.body?.model)).toEqual(["public-upstream", "private-upstream", "public-upstream"]);
    expect(invoices()).toHaveLength(3); expect(ledgerRows(db)).toHaveLength(3);
    expect(wallet(db)?.balance_usd).toBeCloseTo(INITIAL_BALANCE - 0.21, 10); noHolds();
  });

  it("retains authorized legacy routing with no Auto offers but rechecks the original target scope", async () => {
    seedProvider(db, { id: "legacy", endpoint: "https://legacy.test/v1" });
    seedModel(db, { id: "legacy", provider_id: "legacy", alias: PUBLIC_MODEL, input_price_per_m: 10, output_price_per_m: 20 });
    select("auto", null);
    expect((await request()).response.status).toBe(200);
    expect(invoices()).toHaveLength(1);
    expect(invoices()[0]).toMatchObject({ device_id: DEVICE_ID, sub_token_id: SUB_ID, service_group_id: null, cost_usd: 0.03 });
    expect(calls).toHaveLength(1);
    db.sql("UPDATE devices SET model_scope='list' WHERE id=?", DEVICE_ID);
    seedDeviceModels(db, []);
    const denied = await request();
    expect(denied.response.status).toBe(403); expect(denied.body).toMatchObject({ error: "model_not_in_scope" });
    expect(calls).toHaveLength(1); expect(invoices()).toHaveLength(1); expect(ledgerRows(db)).toHaveLength(1);
    expect(wallet(db)?.balance_usd).toBeCloseTo(INITIAL_BALANCE - 0.03, 10); noHolds();
  });

  it("enforces and rechecks owner target scope for both model and model-group offers after withdrawal", async () => {
    const modelGroup = await offer("scoped-model");
    const poolOffer = await createServiceGroup(env, { name: "pool-offer", public_selectable: 1 });
    seedGroup(db, { id: "scoped-pool", name: "pool", input_price_per_m: 20, output_price_per_m: 40 });
    seedGroupMembers(db, "scoped-pool", ["scoped-model"]);
    const poolKey = "sub-auto-pool";
    await upsertServiceGroupModel(env, poolOffer.id, { model_key: poolKey, target_type: "group", target_id: "scoped-pool" });
    select("auto", null); db.sql("UPDATE devices SET model_scope='list' WHERE id=?", DEVICE_ID);
    expect((await request()).response.status).toBe(503);
    expect(calls).toEqual([]); expect(invoices()).toEqual([]); noHolds();
    seedDeviceModels(db, ["scoped-model"]);
    expect((await request()).response.status).toBe(200); billed(modelGroup, 0.03);
    seedDeviceModels(db, []);
    expect((await request()).response.status).toBe(503); expect(calls).toHaveLength(1);
    seedDeviceGroups(db, ["scoped-pool"]);
    expect((await request(SUB_TOKEN, poolKey)).response.status).toBe(200);
    billed({ ...poolOffer, revision: poolOffer.revision + 1 }, 0.06, SUB_ID, poolKey);
    seedDeviceGroups(db, []);
    expect((await request(SUB_TOKEN, poolKey)).response.status).toBe(503); expect(calls).toHaveLength(2);
    expect(invoices()).toHaveLength(2); expect(ledgerRows(db)).toHaveLength(2);
    expect(wallet(db)?.balance_usd).toBeCloseTo(INITIAL_BALANCE - 0.09, 10); noHolds();
  });

  it("upgrades a transient 503 and settles only the successful frozen group against the owner with sub attribution", async () => {
    await offer("cheap"); const expensive = await offer("expensive", 3);
    select("auto", null);
    const balance = 0.2;
    db.sql("UPDATE device_wallets SET balance_usd=? WHERE device_id=?", balance, DEVICE_ID);
    const reservations: number[] = [];
    stubFetch(async (_call, index) => {
      expect(wallet(db)?.balance_usd).toBe(balance);
      const reserved = wallet(db)!.reserved_usd;
      expect(reserved).toBeGreaterThan(0.06);
      reservations.push(reserved);
      expect(holdRows(db)).toHaveLength(1);
      expect(holdRows(db)[0].device_id).toBe(DEVICE_ID);
      expect(invoices()).toEqual([]); expect(ledgerRows(db)).toEqual([]);
      if (index === 1) {
        await updateServiceGroup(env, expensive.id, { multiplier: 99 });
        db.sql("UPDATE models SET input_price_per_m=900, output_price_per_m=900 WHERE id='expensive'");
        return new Response("busy", { status: 503 });
      }
      return openAiAnswer();
    });
    const { response } = await request(SUB_TOKEN, PUBLIC_MODEL, { max_tokens: 1000 });
    expect(response.status).toBe(200); expect(response.headers.get("x-gateway-attempts")).toBe("2");
    expect(reservations).toHaveLength(2);
    expect(reservations[1]).toBe(reservations[0]);
    expect(calls.map(c => [c.url, c.body?.model])).toEqual([
      ["https://cheap.test/v1/chat/completions", "cheap-upstream"],
      ["https://expensive.test/v1/chat/completions", "expensive-upstream"],
    ]);
    expect(invoices()).toHaveLength(1); billed(expensive, 0.09);
    expect(invoices()[0].provider_id).toBe("expensive");
    expect(JSON.parse(invoices()[0].pricing_snapshot_json).billing)
      .toMatchObject({ input_price_per_m: 30, output_price_per_m: 60 });
    expect(ledgerRows(db)).toMatchObject([{ delta_usd: -0.09, reason: "usage", request_id: invoices()[0].request_id }]);
    expect(wallet(db)?.balance_usd).toBeCloseTo(balance - 0.09, 10);
  });

  it("pauses master calls without disabling inherited Auto calls made by its sub-token", async () => {
    const cheap = await offer("cheap"); select("auto", null);
    db.sql("UPDATE devices SET calls_enabled=0 WHERE id=?", DEVICE_ID);
    expect((await request(TOKEN)).response.status).toBe(403);
    expect(calls).toEqual([]); expect(invoices()).toEqual([]); noHolds();
    expect((await request()).response.status).toBe(200);
    expect(calls).toHaveLength(1); billed(cheap, 0.03);
    expect(ledgerRows(db)).toHaveLength(1);
    expect(wallet(db)?.balance_usd).toBeCloseTo(INITIAL_BALANCE - 0.03, 10);
    expect(db.row("SELECT calls_enabled FROM devices WHERE id=?", DEVICE_ID)).toEqual({ calls_enabled: 0 });
  });

  it("ranks multi-offer VIDEO Auto by Monday peak price, freezes one channel/credential/quote, replays without POST and settles once for the sub", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 2, 4));
    const videoModel = "sub-auto-video";
    const config = { model_type: "video", video: { adapter: "generic", task_id_path: "data.task_id",
      sizes: ["1920x1080"], seconds_min: 3, seconds_max: 15, failed_statuses: ["FAILED"] } };
    const groups: Record<string, ServiceGroupRow> = {};
    for (const [id, price, peak] of [["base-cheap", 1, 5], ["chosen", 2, 1.5], ["third", 4, 1]] as const) {
      seedProvider(db, { id, endpoint: "https://" + id + ".test/v1", api_key: "video-key-" + id });
      seedModel(db, { id, provider_id: id, model_name: id + "-video", billing_unit: "call", price_per_call: price,
        input_price_per_m: 0, output_price_per_m: 0, peak_pricing_enabled: 1, config_json: JSON.stringify(config) });
      const group = await createServiceGroup(env, { name: id, public_selectable: 1 });
      await upsertServiceGroupModel(env, group.id, { model_key: videoModel, target_type: "model", target_id: id });
      groups[id] = { ...group, revision: group.revision + 1 };
      db.sql("INSERT INTO price_windows (id,model_id,day_type,start_minute,end_minute,multiplier,enabled) VALUES (?,?,'mon',660,780,?,1)",
        "peak-" + id, id, peak);
    }
    select("auto", groups.third.id);
    const input = { model: videoModel, prompt: "A quiet river", seconds: 5, size: "1920x1080" };
    type VideoView = { id: string; status: string; price_per_call: number; cost_usd: number };
    async function video(method = "POST", path = "/video/generations") {
      const exec = new CollectingExecutionContext();
      const response = await gatewayApp.request("https://gw.test" + path, {
        method, headers: { authorization: "Bearer " + SUB_TOKEN, "content-type": "application/json", "Idempotency-Key": "sub-video-key-0001" },
        ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
      }, env, exec as never);
      const body = await response.json() as VideoView; await Promise.all(exec.pending);
      return { response, body };
    }
    stubFetch(call => {
      expect(call.url).toBe("https://chosen.test/v1/video/generations");
      expect(call.method).toBe("POST"); expect(call.auth).toBe("Bearer video-key-chosen");
      expect(call.body).toEqual({ ...input, model: "chosen-video" });
      expect(wallet(db)).toEqual({ balance_usd: INITIAL_BALANCE, reserved_usd: 3 });
      expect(holdRows(db)).toMatchObject([{ device_id: DEVICE_ID, amount_usd: 3 }]);
      return Response.json({ data: { task_id: "private-video-task" } });
    });
    const created = await video(); expect(created.response.status).toBe(202);
    expect(created.body).toMatchObject({ status: "pending", price_per_call: 3, cost_usd: 0 });
    const task = db.row<{ route_json: string; pricing_snapshot_json: string; sub_token_id: string; price_usd: number }>(
      "SELECT * FROM video_tasks WHERE id=?", created.body.id)!;
    expect(task).toMatchObject({ sub_token_id: SUB_ID, price_usd: 3 });
    expect(JSON.parse(task.route_json)).toMatchObject({ provider_id: "chosen", upstream_model: "chosen-video",
      endpoint: "https://chosen.test/v1/video/generations", service_group_id: groups.chosen.id,
      revision: groups.chosen.revision, price_multiplier: 1.5, window_id: "peak-chosen", credential: expect.stringContaining("enc:v1:") });
    expect(task.route_json).not.toContain("video-key-chosen");
    expect(JSON.parse(task.pricing_snapshot_json)).toMatchObject({ price_per_call: 2, price_usd: 3,
      price_multiplier: 1.5, price_window_id: "peak-chosen", service_group_id: groups.chosen.id, revision: groups.chosen.revision });
    expect(invoices()).toEqual([]); expect(ledgerRows(db)).toEqual([]);
    clock.mockReturnValue(Date.UTC(2026, 10, 3, 4));
    db.sql("UPDATE providers SET endpoint='https://changed.test/v1', api_key='changed-credential'");
    db.sql("UPDATE models SET price_per_call=99, model_name='changed-model'");
    db.sql("UPDATE price_windows SET multiplier=99");
    await updateServiceGroup(env, groups.chosen.id, { multiplier: 99, enabled: 0 });
    const replay = await video(); expect(replay.response.status).toBe(200);
    expect(replay.body.id).toBe(created.body.id); expect(calls).toHaveLength(1);
    expect(holdRows(db)).toHaveLength(1); expect(wallet(db)?.reserved_usd).toBe(3);
    stubFetch(call => {
      expect(call).toMatchObject({ method: "GET", url: "https://chosen.test/v1/video/generations/private-video-task", auth: "Bearer video-key-chosen" });
      return Response.json({ status: "SUCCESS", result_url: "https://cdn.test/result.mp4" });
    });
    db.sql("UPDATE video_tasks SET poll_after=0, poll_lease_until=NULL WHERE id=?", created.body.id);
    const detail = await video("GET", "/video/generations/" + created.body.id);
    expect(detail.response.status).toBe(200); expect(detail.body).toMatchObject({ status: "succeeded", price_per_call: 3, cost_usd: 3 });
    await video("GET", "/video/generations/" + created.body.id); await video();
    expect(calls.filter(c => c.method === "POST")).toHaveLength(1); expect(calls).toHaveLength(2);
    expect(invoices()).toHaveLength(1);
    expect(invoices()[0]).toMatchObject({ device_id: DEVICE_ID, sub_token_id: SUB_ID, provider_id: "chosen", model: videoModel,
      service_group_id: groups.chosen.id, service_group_revision: groups.chosen.revision, cost_usd: 3,
      price_multiplier: 1.5, price_window_id: "peak-chosen", request_id: created.body.id, pricing_snapshot_json: task.pricing_snapshot_json });
    expect(ledgerRows(db)).toMatchObject([{ delta_usd: -3, request_id: created.body.id, reason: "usage" }]);
    expect(db.row("SELECT SUM(cost_usd) AS cost, SUM(request_count) AS count FROM daily_stats")).toEqual({ cost: 3, count: 1 });
    expect(wallet(db)?.balance_usd).toBe(INITIAL_BALANCE - 3); noHolds();
    expect(db.row("SELECT route_json, pricing_snapshot_json FROM video_tasks WHERE id=?", created.body.id))
      .toEqual({ route_json: task.route_json, pricing_snapshot_json: task.pricing_snapshot_json });
  });
});
