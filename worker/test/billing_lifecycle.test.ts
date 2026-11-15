import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { gatewayApp } from "../src/gateway";
import { recoverBillingRequests } from "../src/db/request_billing";
import { TEXT_BODY_DEADLINE_MS, BILLING_HEARTBEAT_MS } from "../src/gateway/billing_lifecycle";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { CollectingExecutionContext, createRealD1, makeEnv, makeKv, seedDevice, seedModel, seedProvider, postJson, chatBody, openAiAnswer, sseAnswer, openAiStreamFrames, usageRows, ledgerRows, holdRows, wallet, type RealD1 } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";
import { createServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import { releaseStaleReserves } from "../src/db/repo";
let d1: RealD1, env: Env;
beforeEach(async () => {
  resetRateLimitMemory(); clearMemoryCacheForTest(); d1 = createRealD1(); env = makeEnv(d1, makeKv());
  seedProvider(d1); seedModel(d1); await seedDevice(d1, { balance_usd: 100 });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); d1.close(); });
function billing() { return d1.rows<any>("SELECT * FROM billing_requests ORDER BY created_at"); }
async function call(path = "/chat/completions", value: any = chatBody()) {
  const exec = new CollectingExecutionContext(); const response = await postJson(env, path, value, exec);
  const text = await response.text(); await Promise.all(exec.pending); return { response, text };
}
function paid(cost = 0.018) {
  expect(usageRows(d1)).toHaveLength(1); expect(ledgerRows(d1)).toHaveLength(1);
  expect(usageRows(d1)[0].cost_usd).toBeCloseTo(cost, 10); expect(wallet(d1)?.balance_usd).toBeCloseTo(100-cost,10);
  expect(holdRows(d1)).toEqual([]); expect(billing()[0].settled_at).not.toBeNull();
}
describe("durable billing through the actual gateway", () => {
  it.each([false, true])("Auto admission is durable before upstream and uses the frozen selected group (stream=%s)", async stream => {
    d1.sql("UPDATE devices SET service_group_id='auto'");
    const group = await createServiceGroup(env, { name: "durable-auto", multiplier: 2, public_selectable: 1 });
    await upsertServiceGroupModel(env, group.id, { model_key: "auto-product", target_type: "model", target_id: "model_a" });
    vi.spyOn(globalThis,"fetch").mockImplementation(async () => {
      expect(billing()).toHaveLength(1); expect(holdRows(d1)).toHaveLength(1);
      expect(d1.rows("SELECT * FROM billing_attempts")).toHaveLength(1);
      d1.sql("UPDATE service_groups SET multiplier=99");
      return stream ? sseAnswer(openAiStreamFrames()) : openAiAnswer();
    });
    const result = await call("/chat/completions", chatBody("auto-product", {stream}));
    expect(result.response.status).toBe(200); paid(.036);
    expect(d1.row<{service_group_id:string}>("SELECT service_group_id FROM usage")?.service_group_id).toBe(group.id);
  });
  it("a locally missing credential releases its own hold without fabricating usage", async () => {
    d1.sql("UPDATE providers SET config_json=?", JSON.stringify({protocol_connections:{chat_completions:{secret_name:"MISSING_LOCAL_KEY"}}}));
    const fetch=vi.spyOn(globalThis,"fetch"); const result=await call();
    expect(result.response.status).toBe(502); expect(fetch).not.toHaveBeenCalled();
    expect(billing()[0].outcome).toBe("not_dispatched"); expect(holdRows(d1)).toEqual([]);
    expect(usageRows(d1)).toEqual([]); expect(ledgerRows(d1)).toEqual([]);
  });
  it("a silent error body is bounded before failover classification", async () => {
    vi.useFakeTimers();
    let entered!: () => void; const fetching = new Promise<void>(resolve=>{entered=resolve;});
    vi.spyOn(globalThis,"fetch").mockImplementation(async()=>{entered();return new Response(new ReadableStream({start(){}}),{status:400});});
    const pending=call(); await fetching; await vi.advanceTimersByTimeAsync(1); await vi.advanceTimersByTimeAsync(TEXT_BODY_DEADLINE_MS+6_000);
    expect((await pending).response.status).toBeGreaterThanOrEqual(400);
    expect(billing()[0].outcome).toBe("timeout"); expect(billing()[0].known_cost_usd).toBeNull();
  });
  it("lease heartbeats protect a live slow body from both recovery scanners", async () => {
    vi.useFakeTimers(); let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let entered!: () => void; const fetching = new Promise<void>(resolve => { entered=resolve; });
    vi.spyOn(globalThis,"fetch").mockImplementation(async () => { entered(); return new Response(new ReadableStream<Uint8Array>({start(c){ctrl=c;}}),{headers:{"content-type":"application/json"}}); });
    const pending=call(); await fetching; await vi.advanceTimersByTimeAsync(1);
    const initial=billing()[0].lease_until;
    await vi.advanceTimersByTimeAsync(BILLING_HEARTBEAT_MS*5);
    expect(billing()[0].lease_until).toBeGreaterThan(initial);
    await recoverBillingRequests(env); await releaseStaleReserves(env);
    expect(holdRows(d1)).toHaveLength(1); expect(usageRows(d1)).toEqual([]);
    ctrl.enqueue(new TextEncoder().encode(await openAiAnswer().text())); ctrl.close();
    expect((await pending).response.status).toBe(200); paid();
  });
  it("commits admission and own hold before fetch, then awaits JSON settlement before returning", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      expect(billing()).toHaveLength(1); expect(billing()[0].billing_state).toBe("active");
      expect(holdRows(d1)).toHaveLength(1); expect(d1.rows("SELECT * FROM billing_attempts")).toHaveLength(1);
      return openAiAnswer();
    });
    const exec = new CollectingExecutionContext(); const response = await postJson(env,"/chat/completions",chatBody(),exec);
    expect(response.status).toBe(200); paid(); expect(billing()[0].usage_source).toBe("reported_final");
    await response.text(); await Promise.all(exec.pending);
  });
  it("accepts reported all-zero usage as known zero instead of inventing token estimates", async () => {
    vi.spyOn(globalThis,"fetch").mockResolvedValue(openAiAnswer({prompt_tokens:0,completion_tokens:0,total_tokens:0}));
    expect((await call()).response.status).toBe(200); paid(0);
    expect(usageRows(d1)[0].input_tokens).toBe(0); expect(billing()[0].usage_source).toBe("reported_final");
  });
  it("meters cumulative streaming reports once before forwarding the terminal event", async () => {
    vi.spyOn(globalThis,"fetch").mockResolvedValue(sseAnswer(openAiStreamFrames()));
    const result = await call("/chat/completions",chatBody("gw-primary",{stream:true}));
    expect(result.text).toContain("[DONE]"); paid(); expect(billing()[0].usage_source).toBe("reported_final");
  });
  it("legacy Chat-to-Responses bridge bills upstream reasoning/output usage, not visible text length", async () => {
    d1.sql("UPDATE models SET config_json = ?", JSON.stringify({responses_mode:"chat_adapter"}));
    const frames = openAiStreamFrames("pong");
    frames.splice(1,0,'data: '+JSON.stringify({object:"chat.completion.chunk", choices:[{index:0,delta:{reasoning_content:"r".repeat(400)}}]})+'\n\n');
    frames[2] = 'data: '+JSON.stringify({object:"chat.completion.chunk", choices:[{index:0,delta:{},finish_reason:"stop"}], usage:{prompt_tokens:1000,completion_tokens:2000,total_tokens:3000,completion_tokens_details:{reasoning_tokens:1000}}})+'\n\n';
    vi.spyOn(globalThis,"fetch").mockResolvedValue(sseAnswer(frames));
    const result=await call("/responses",{model:"gw-primary",input:"hi",stream:true});
    expect(result.text).toContain("response.completed"); paid(0.033); expect(usageRows(d1)[0].output_tokens).toBe(2000);
    expect(JSON.parse(billing()[0].terminal_snapshot_json).usage.reasoning_tokens).toBe(1000);
  });
  it("unknown pre-header acceptance is durable, not replayed, and expires without fake usage", async () => {
    const fetch=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("network gone after send"));
    expect((await call()).response.status).toBe(502); expect(fetch).toHaveBeenCalledTimes(1);
    expect(billing()[0].billing_state).toBe("needs_reconciliation"); expect(billing()[0].known_cost_usd).toBeNull();
    expect(usageRows(d1)).toEqual([]); expect(ledgerRows(d1)).toEqual([]); expect(holdRows(d1)).toHaveLength(1);
    d1.sql("UPDATE billing_requests SET lease_until = 0"); await recoverBillingRequests(env);
    expect(holdRows(d1)).toEqual([]); expect(usageRows(d1)).toEqual([]); expect(wallet(d1)?.balance_usd).toBe(100);
  });
  it("unknown per-call upstream acceptance is not finalized as a known-zero invoice", async () => {
    d1.sql("UPDATE models SET billing_unit='call', price_per_call=.25, pricing_mode='priced', config_json=?", JSON.stringify({model_type:"text"}));
    vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("unknown acceptance"));
    expect((await call()).response.status).toBe(502);
    expect(billing()[0].known_cost_usd).toBeNull(); expect(billing()[0].billing_state).toBe("needs_reconciliation");
    expect(usageRows(d1)).toEqual([]); expect(ledgerRows(d1)).toEqual([]);
    expect(holdRows(d1)).toHaveLength(1);
  });
  it("JSON body silence after headers is bounded and retains unknown cost", async () => {
    vi.useFakeTimers();
    let entered!: () => void; const fetching = new Promise<void>(resolve=>{entered=resolve;});
    vi.spyOn(globalThis,"fetch").mockImplementation(async()=>{entered();return new Response(new ReadableStream({start(){}}),{headers:{"content-type":"application/json"}});});
    const pending = call(); await fetching;
    await vi.advanceTimersByTimeAsync(1); await vi.advanceTimersByTimeAsync(TEXT_BODY_DEADLINE_MS+1);
    const result = await pending; expect(result.response.status).toBeGreaterThanOrEqual(500);
    expect(billing()[0].outcome).toBe("timeout"); expect(billing()[0].known_cost_usd).toBeNull();
  });
  it("a ledger failure leaves a durable terminal and no split usage/wallet changes; scanner settles once", async () => {
    d1.sql("CREATE TRIGGER deny_billing_ledger BEFORE INSERT ON wallet_ledger BEGIN SELECT RAISE(ABORT,'offline ledger unavailable'); END");
    vi.spyOn(globalThis,"fetch").mockResolvedValue(openAiAnswer());
    const result=await call(); expect(result.response.status).toBeGreaterThanOrEqual(500);
    expect(usageRows(d1)).toEqual([]); expect(ledgerRows(d1)).toEqual([]); expect(wallet(d1)?.balance_usd).toBe(100);
    expect(billing()[0].terminal_snapshot_json).not.toBeNull(); expect(billing()[0].settled_at).toBeNull();
    d1.sql("DROP TRIGGER deny_billing_ledger"); await recoverBillingRequests(env); await recoverBillingRequests(env); paid();
  });
  it("a cache hit uses the same atomic usage/wallet transaction and recovers a failed settlement", async () => {
    d1.sql("UPDATE models SET cache_enabled=1");
    const fetch=vi.spyOn(globalThis,"fetch").mockImplementation(async()=>openAiAnswer());
    await call(); paid();
    d1.sql("CREATE TRIGGER cache_usage_failure BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT,'cache usage failure'); END");
    const result=await call(); expect(result.response.status).toBeGreaterThanOrEqual(500);
    expect(fetch).toHaveBeenCalledTimes(1); expect(usageRows(d1)).toHaveLength(1); expect(ledgerRows(d1)).toHaveLength(1);
    expect(wallet(d1)?.balance_usd).toBeCloseTo(99.982,10);
    const pending=billing().find(r=>r.settled_at===null); expect(pending.usage_source).toBe("cached_final");
    d1.sql("DROP TRIGGER cache_usage_failure"); await recoverBillingRequests(env); await recoverBillingRequests(env);
    expect(usageRows(d1)).toHaveLength(2); expect(usageRows(d1)[1].cache_hit).toBe(1); expect(ledgerRows(d1)).toHaveLength(2);
    expect(wallet(d1)?.balance_usd).toBeCloseTo(99.964,10); expect(holdRows(d1)).toEqual([]);
  });
  it("uses frozen prices even when the model price changes while upstream is generating", async () => {
    vi.spyOn(globalThis,"fetch").mockImplementation(async () => { d1.sql("UPDATE models SET input_price_per_m=999, output_price_per_m=999"); return openAiAnswer(); });
    await call(); paid(); expect(billing()[0].pricing_snapshot_json).toContain('"input_price_per_m":3');
  });
  it("retains known partial stream usage after missing terminal without calling it a complete zero", async () => {
    vi.spyOn(globalThis,"fetch").mockResolvedValue(sseAnswer(openAiStreamFrames().slice(0,-1)));
    await call("/chat/completions",chatBody("gw-primary",{stream:true})); paid();
    expect(billing()[0].billing_state).toBe("needs_reconciliation"); expect(billing()[0].usage_source).toBe("reported_partial");
  });
  it("captures an admitted zero-priced request rather than bypassing durability", async () => {
    d1.sql("UPDATE models SET pricing_mode='free'");
    vi.spyOn(globalThis,"fetch").mockImplementation(async()=>{expect(holdRows(d1)[0].amount_usd).toBe(0); return openAiAnswer();});
    await call(); paid(0);
  });
});
