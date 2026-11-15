import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverBillingRequests } from "../src/db/request_billing";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { createServiceGroup, updateServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import { resolveAutoServiceRoutes } from "../src/gateway/service_groups";
import { seedGroup, seedGroupMembers } from "./helpers/realGatewayEnv";
import { estimateRequestCostUsd } from "../src/gateway/pricing";
import { applyRequestRewriteRules, parseRewriteRules } from "../src/gateway/rewrite";
import type { DeviceRow, Env } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { CollectingExecutionContext, DEVICE_ID, chatBody, makeEnv, makeKv, openAiAnswer, postJson,
  seedDevice, seedModel, seedProvider, wallet, openAiStreamFrames, sseAnswer } from "./helpers/realGatewayEnv";

let d1: RealD1;
let env: Env;
beforeEach(async () => {
  resetRateLimitMemory(); clearMemoryCacheForTest();
  d1 = createRealD1(); env = makeEnv(d1, makeKv());
  await seedDevice(d1, { balance_usd: 100 });
  d1.sql("UPDATE devices SET service_group_id='auto'");
  for (const id of ["cheap", "expensive", "backup"]) {
    seedProvider(d1, { id, endpoint: "https://" + id + ".example/v1" });
    seedModel(d1, { id, provider_id: id, model_name: id + "-model", input_price_per_m: 10, output_price_per_m: 20 });
  }
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });
async function offers() {
  const cheap = await createServiceGroup(env, { name: "cheap", multiplier: 1, public_selectable: 1 });
  const expensive = await createServiceGroup(env, { name: "expensive", multiplier: 3, public_selectable: 1 });
  for (const [group, id] of [[cheap, "cheap"], [expensive, "expensive"]] as const) {
    await upsertServiceGroupModel(env, group.id, { model_key: "public-model", target_type: "model", target_id: id,
      member_ids_json: JSON.stringify([id]) });
  }
  return { cheap: { ...cheap, revision: cheap.revision + 1 }, expensive: { ...expensive, revision: expensive.revision + 1 } };
}
function upstream(answer: (call: number) => Response | Promise<Response> = () => openAiAnswer()) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) }); return answer(calls.length);
  });
  return calls;
}
async function request(body: unknown = chatBody("public-model"), path = "/chat/completions") {
  const exec = new CollectingExecutionContext(); const response = await postJson(env, path, body, exec);
  const text = await response.text(); await Promise.all(exec.pending); return { response, text };
}
function usage() { return d1.rows<{ service_group_id: string; service_group_revision: number; pricing_snapshot_json: string; cost_usd: number }>("SELECT * FROM usage ORDER BY id"); }
async function expectUnknownUntilRecovery() {
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

function cleanHold() { expect(wallet(d1)?.reserved_usd).toBe(0); }

describe("Auto service group proxy", () => {
  it.each([null, "legacy"])("uses original route without service pricing for legacy selection %s", async selection => {
    await offers();
    d1.sql("UPDATE devices SET service_group_id=?, default_service_group_id=?", selection, selection === null ? null : "auto");
    const calls = upstream(); const { response } = await request(chatBody("cheap-model"));
    expect(response.status).toBe(200); expect(calls).toHaveLength(1);
    expect(usage()[0].service_group_id).toBeNull();
    expect(usage()[0].cost_usd).toBeCloseTo(0.03); cleanHold();
  });
  it.each(["auto"])("uses cheapest once for selection %s", async (selection) => {
    const { cheap } = await offers(); d1.sql("UPDATE devices SET service_group_id = ? WHERE id = ?", selection, DEVICE_ID);
    const calls = upstream(); const { response } = await request();
    expect(response.status).toBe(200); expect(response.headers.get("x-gateway-attempts")).toBeNull();
    expect(calls.map((call) => call.body.model)).toEqual(["cheap-model"]);
    expect(usage()[0]).toMatchObject({ service_group_id: cheap.id, service_group_revision: cheap.revision });
    expect(usage()[0].cost_usd).toBeCloseTo(0.03); cleanHold();
  });
  it("upgrades a transient failure and invoices the successful group frozen before upstream", async () => {
    const { expensive } = await offers();
    const calls = upstream(async (call) => {
      if (call === 1) {
        await updateServiceGroup(env, expensive.id, { multiplier: 99 });
        d1.sql("UPDATE models SET input_price_per_m = 900 WHERE id = 'expensive'");
        return new Response("busy", { status: 503 });
      }
      return openAiAnswer();
    });
    const { response } = await request(); expect(response.status).toBe(200);
    expect(calls.map((call) => call.body.model)).toEqual(["cheap-model", "expensive-model"]);
    expect(response.headers.get("x-gateway-attempts")).toBe("2"); expect(usage()).toHaveLength(1);
    expect(usage()[0]).toMatchObject({ service_group_id: expensive.id, service_group_revision: expensive.revision });
    expect(usage()[0].cost_usd).toBeCloseTo(0.09);
    expect(JSON.parse(usage()[0].pricing_snapshot_json).billing.input_price_per_m).toBe(30); cleanHold();
  });
  it("chooses free before priced and bills zero", async () => {
    const { cheap } = await offers(); d1.sql("UPDATE models SET pricing_mode = 'free' WHERE id = 'cheap'");
    const calls = upstream(() => {
      expect(d1.rows("SELECT * FROM reserve_holds")).toHaveLength(1);
      expect(d1.row("SELECT billing_state, reserved_usd FROM billing_requests")).toMatchObject({ billing_state: "active", reserved_usd: 0 });
      return openAiAnswer();
    }); await request(); expect(calls).toHaveLength(1);
    expect(usage()[0]).toMatchObject({ service_group_id: cheap.id, cost_usd: 0 }); expect(wallet(d1)?.balance_usd).toBe(100); cleanHold();
  });
  it("keeps explicit fixed groups isolated", async () => {
    const { cheap } = await offers(); d1.sql("UPDATE devices SET service_group_id = ? WHERE id = ?", cheap.id, DEVICE_ID);
    const calls = upstream(() => new Response("busy", { status: 503 })); const { response } = await request();
    expect(response.status).toBe(502); expect(calls).toHaveLength(1);
    expect(usage()).toHaveLength(1); expect(usage()[0].cost_usd).toBe(0);
    expect(d1.rows("SELECT delta_usd FROM wallet_ledger")).toEqual([{ delta_usd: 0 }]); cleanHold();
  });
  it.each([[400, "unsupported parameter"], [400, "invalid value"], [401, "bad key"], [403, "permission denied"]])(
    "does not cross groups for %s %s", async (status, text) => {
      await offers(); const calls = upstream(() => new Response(String(text), { status: Number(status) }));
      const { response } = await request(); expect(response.status).toBe(Number(status) === 400 ? 400 : 502);
      expect(calls).toHaveLength(1); cleanHold();
    });
  it("does not replay a per-call purchase", async () => {
    await offers(); d1.sql("UPDATE models SET billing_unit = 'call', price_per_call = 0.1");
    const calls = upstream(() => new Response("busy", { status: 503 }));
    const { response } = await request({ model: "public-model", prompt: "tree" }, "/images/generations");
    expect(response.status).toBe(502); expect(calls).toHaveLength(1); cleanHold();
  });
  it("does not replay after an upstream stream has started", async () => {
    const { cheap } = await offers(); const calls = upstream(() => sseAnswer(openAiStreamFrames()));
    const { response, text } = await request(chatBody("public-model", { stream: true }));
    expect(response.status).toBe(200); expect(text).toContain("public-model"); expect(calls).toHaveLength(1);
    expect(usage()[0].service_group_id).toBe(cheap.id); cleanHold();
  });
  it("rejects insufficient maximum-route balance before upstream even if cheap is affordable", async () => {
    await offers(); d1.sql("UPDATE device_wallets SET balance_usd = 0.0001");
    const calls = upstream(); const { response } = await request(); expect(response.status).toBe(429);
    expect(calls).toEqual([]); expect(usage()).toEqual([]); cleanHold();
  });
  it("holds the rewritten maximum once and passes the identical hold through upgrade settlement", async () => {
    await offers(); d1.sql("UPDATE models SET config_json = ? WHERE id = 'expensive'", JSON.stringify({ max_tokens: 10000 }));
    const body = chatBody("public-model");
    const routes = await resolveAutoServiceRoutes(env, d1.row<DeviceRow>("SELECT * FROM devices WHERE id = ?", DEVICE_ID)!, "public-model");
    const maximum = Math.max(...routes.map((route) => estimateRequestCostUsd(route.billingRow,
      applyRequestRewriteRules(body, parseRewriteRules(route.billingRow.config_json), "chat/completions"), route.autoPriceSnapshot!.multiplier, JSON.stringify(body).length)));
    d1.sql("UPDATE device_wallets SET balance_usd = ?", maximum * 2);
    const holds: number[] = [];
    const calls = upstream((call) => { holds.push(wallet(d1)!.reserved_usd); return call === 1 ? new Response("busy", { status: 503 }) : openAiAnswer(); });
    const { response } = await request(body); expect(response.status).toBe(200); expect(calls).toHaveLength(2);
    expect(holds[0]).toBeCloseTo(maximum, 6); expect(holds[1]).toBe(holds[0]);
    expect(calls[1].body.max_tokens).toBe(10000); expect(wallet(d1)?.balance_usd).toBeCloseTo(maximum * 2 - 0.09); cleanHold();
  });
  it("retains the single hold until lease recovery after an unknown network outcome", async () => {
    await offers(); d1.sql("UPDATE device_wallets SET balance_usd = 0.1");
    const calls = upstream(() => { expect(wallet(d1)!.reserved_usd).toBeGreaterThan(0); throw new Error("offline"); });
    const { response } = await request(); expect(response.status).toBe(502); expect(calls).toHaveLength(1);
    expect(usage()).toEqual([]); expect(wallet(d1)?.balance_usd).toBe(0.1); await expectUnknownUntilRecovery();
    expect(wallet(d1)?.balance_usd).toBe(0.1);
  });
  it("exhausts group member retries before upgrading", async () => {
    const { cheap, expensive } = await offers();
    seedGroup(d1, { id: "target", name: "target", input_price_per_m: 10, output_price_per_m: 20,
      config_json: JSON.stringify({ member_retries: 1 }) });
    seedGroupMembers(d1, "target", ["cheap", "backup"]);
    await upsertServiceGroupModel(env, cheap.id, { model_key: "public-model", target_type: "group", target_id: "target" });
    const calls = upstream((call) => call < 5 ? new Response("busy", { status: 503 }) : openAiAnswer());
    const { response } = await request(); expect(response.status).toBe(200);
    expect(calls.map((call) => call.body.model)).toEqual(["cheap-model", "cheap-model", "backup-model", "backup-model", "expensive-model"]);
    expect(response.headers.get("x-gateway-attempts")).toBe("5"); expect(usage()[0].service_group_id).toBe(expensive.id); cleanHold();
  });
  it("does not lose a parameter error behind unspent member retries", async () => {
    const { cheap } = await offers();
    d1.sql("UPDATE models SET config_json = ? WHERE id = 'cheap'", JSON.stringify({ member_retries: 2 }));
    const calls = upstream(() => new Response("unsupported parameter", { status: 400 }));
    const { response } = await request(); expect(response.status).toBe(400); expect(calls).toHaveLength(1); cleanHold();
  });
  it.each([
    ["/images/generations", { model: "public-model", prompt: "tree", stream: true }, "images_do_not_stream"],
    ["/images/generations", { model: "public-model", prompt: "tree" }, "model_not_billed_per_call"],
  ])("preserves request guard %s", async (path, body, error) => {
    await offers(); const calls = upstream(); const result = await request(body, path);
    expect(result.response.status).toBe(400); expect(JSON.parse(result.text).error).toBe(error); expect(calls).toEqual([]); cleanHold();
  });
  it("keeps per-call text and image count guards before upstream", async () => {
    await offers(); d1.sql("UPDATE models SET billing_unit = 'call', price_per_call = 0.1"); const calls = upstream();
    expect(JSON.parse((await request()).text).error).toBe("per_call_text_only");
    expect(JSON.parse((await request({ model: "public-model", prompt: "tree", n: 5 }, "/images/generations")).text).error).toBe("too_many_images");
    expect(calls).toEqual([]); cleanHold();
  });
  it("keeps its hold for recovery when the actual non-stream body read fails", async () => {
    await offers(); d1.sql("UPDATE device_wallets SET balance_usd = 0.1");
    const calls = upstream(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("broken body")); },
    }), { headers: { "content-type": "application/json" } }));
    const { response } = await request(); expect(response.status).toBe(500); expect(calls).toHaveLength(1);
    await expectUnknownUntilRecovery(); expect(wallet(d1)?.balance_usd).toBe(0.1);
  });
  it("does not spend a backup target quota until reached", async () => {
    await offers();
    d1.sql("INSERT INTO device_models (device_id, model_id, rpm) VALUES (?, 'expensive', 1)", DEVICE_ID);
    const calls = upstream(); await request();
    const { response } = await request(chatBody("expensive-model"));
    expect(response.status).toBe(200); expect(calls).toHaveLength(2);
  });
  it("does not upgrade an initial quota refusal", async () => {
    await offers(); d1.sql("INSERT INTO device_models (device_id, model_id, rpm) VALUES (?, 'cheap', 1)", DEVICE_ID);
    const calls = upstream(); await request(); const { response } = await request();
    expect(response.status).toBe(429); expect(calls).toHaveLength(1); cleanHold();
  });
  it("consumes a shared target once across service offers", async () => {
    const { expensive } = await offers();
    await upsertServiceGroupModel(env, expensive.id, { model_key: "public-model", target_type: "model", target_id: "cheap" });
    d1.sql("INSERT INTO device_models (device_id, model_id, rpm) VALUES (?, 'cheap', 1)", DEVICE_ID);
    const calls = upstream((call) => call === 1 ? new Response("busy", { status: 503 }) : openAiAnswer());
    const { response } = await request(); expect(response.status).toBe(200); expect(calls).toHaveLength(2);
    expect(usage()[0].service_group_id).toBe(expensive.id); cleanHold();
  });
  it("keeps legacy compatibility for names unmapped by service groups", async () => {
    await offers(); const calls = upstream(); const { response } = await request(chatBody("backup-model"));
    expect(response.status).toBe(200); expect(calls[0].body.model).toBe("backup-model");
  });
});
