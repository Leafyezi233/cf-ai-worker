import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as routesApi from "../src/gateway/service_groups";
import * as rewriteApi from "../src/gateway/rewrite";
import * as repo from "../src/db/repo";
import { createServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import { resolveTokenRoutingPolicy } from "../src/db/token_policies";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { estimateRequestCostUsd } from "../src/gateway/pricing";
import type { DeviceRow, Env } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { CollectingExecutionContext, DEVICE_ID, makeEnv, makeKv, openAiAnswer, postJson,
  seedDevice, seedGroup, seedGroupMembers, seedModel, seedProvider, wallet } from "./helpers/realGatewayEnv";

let d1: RealD1;
let env: Env;
beforeEach(async () => {
  resetRateLimitMemory(); clearMemoryCacheForTest();
  d1 = createRealD1(); env = makeEnv(d1, makeKv());
  await seedDevice(d1, { balance_usd: 100 });
  d1.sql("UPDATE devices SET service_group_id = 'auto'");
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });

async function offers(count: number) {
  for (let i = 0; i < count; i++) {
    const id = "m" + i;
    seedProvider(d1, { id, endpoint: "https://" + id + ".example/v1", api_key: "sk-private-" + i });
    seedModel(d1, { id, provider_id: id, model_name: id, input_price_per_m: 10, output_price_per_m: 20 });
    const group = await createServiceGroup(env, { name: id, multiplier: i + 1, public_selectable: 1 });
    await upsertServiceGroupModel(env, group.id, { model_key: "public-model", target_type: "model", target_id: id,
      member_ids_json: JSON.stringify([id]) });
  }
  const device = d1.row<DeviceRow>("SELECT * FROM devices WHERE id = ?", DEVICE_ID)!;
  return { device, routes: await routesApi.resolveAutoServiceRoutes(env, device, "public-model") };
}
async function request(body: unknown) {
  const exec = new CollectingExecutionContext();
  const response = await postJson(env, "/chat/completions", body, exec);
  await response.text(); await Promise.all(exec.pending);
  return response;
}
function freezeTree<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeTree); Object.freeze(value);
  }
  return value;
}
const redact = (key: string, value: unknown) => /api_key|secret|config_json|model_metadata|protocol_metadata/.test(key) ? undefined : value;

describe("Auto preparation cost and isolation", () => {
  it.each([1, 3, 6])("does zero body clones and one candidate serialization for %i offers, retaining exact frozen invoices", async count => {
    const { device, routes } = await offers(count);
    const policy = await resolveTokenRoutingPolicy(env, device);
    routes.forEach((route, i) => {
      Object.assign(route.billingRow, { snapshot_test: { note: 'quote" slash\\ 雪\n', nil: null,
        nested: { api_key: "hidden", secret_name: "hidden", config_json: "hidden", model_metadata: "hidden",
          protocol_metadata: "hidden", keep: [i, null, "visible"] } } });
    });
    const expected = routes.map(route => JSON.stringify({ billing: route.billingRow,
      multiplier: route.autoPriceSnapshot!.multiplier, window_id: route.autoPriceSnapshot!.window_id, policy_version: policy.version,
      candidate_groups: routes.map(r => ({ id: r.group.id, revision: r.group.revision, mapping_id: r.mapping.id,
        billing: r.billingRow, peak: r.autoPriceSnapshot })) }, redact));
    vi.spyOn(routesApi, "resolveAutoServiceRoutes").mockResolvedValue(routes);
    const clone = vi.spyOn(globalThis, "structuredClone");
    const stringify = JSON.stringify;
    let candidateVisits = 0, candidateSerializations = 0;
    vi.spyOn(JSON, "stringify").mockImplementation((value: any, replacer?: any, space?: any) => {
      if (Array.isArray(value) && value.length && value.every(v => v?.mapping_id)) candidateSerializations++;
      return typeof replacer === "function" ? stringify(value, function (this: unknown, key: string, v: unknown) {
        if (key === "mapping_id") candidateVisits++;
        return replacer.call(this, key, v);
      }, space) : stringify(value, replacer, space);
    });
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        expect(d1.row<{ pricing_snapshot_json: string }>("SELECT pricing_snapshot_json FROM billing_requests")!.pricing_snapshot_json).toBe(expected[0]);
        routes.forEach(route => { route.group.revision += 100; (route.billingRow as any).snapshot_test.note = "changed"; });
      }
      return calls < count ? new Response("busy", { status: 503 }) : openAiAnswer();
    });
    const response = await request({ model: "public-model", messages: [{ role: "user", content: "large " .repeat(10000) }], max_tokens: 128 });
    expect(response.status).toBe(200); expect(calls).toBe(count);
    expect(clone.mock.calls.filter(([body]) => (body as any)?.model === "public-model")).toHaveLength(0);
    expect(candidateSerializations).toBe(1); expect(candidateVisits).toBe(count);  
    const invoice = d1.row<{ pricing_snapshot_json: string }>("SELECT pricing_snapshot_json FROM usage")!.pricing_snapshot_json;
    expect(invoice).toBe(expected[count - 1]);
    expect(invoice).not.toContain("sk-private-"); expect(invoice).not.toContain("hidden");
    expect(JSON.parse(invoice).candidate_groups.map((v: any) => v.id)).toEqual(routes.map(r => r.group.id));
    expect(wallet(d1)?.reserved_usd).toBe(0);
  });

  it("preserves omitted candidate peaks when an invoice needs a fallback price lookup", async () => {
    const { device, routes } = await offers(2);
    const policy = await resolveTokenRoutingPolicy(env, device);
    const peak = routes[1].autoPriceSnapshot!;
    delete routes[1].autoPriceSnapshot;
    const expected = JSON.stringify({ billing: routes[1].billingRow, multiplier: peak.multiplier, window_id: peak.window_id,
      policy_version: policy.version, candidate_groups: routes.map(r => ({ id: r.group.id, revision: r.group.revision,
        mapping_id: r.mapping.id, billing: r.billingRow, peak: r.autoPriceSnapshot })) }, redact);
    vi.spyOn(routesApi, "resolveAutoServiceRoutes").mockResolvedValue(routes);
    const lookup = vi.spyOn(repo, "resolvePriceSnapshot").mockResolvedValue(peak);
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ++calls === 1 ? new Response("busy", { status: 503 }) : openAiAnswer());
    expect((await request({ model: "public-model", messages: [{ role: "user", content: "hello" }], max_tokens: 128 })).status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    const actual = d1.row<{ pricing_snapshot_json: string }>("SELECT pricing_snapshot_json FROM usage")!.pricing_snapshot_json;
    expect(actual).toBe(expected); expect(JSON.parse(actual).candidate_groups[1]).not.toHaveProperty("peak");
  });

  it.each(["prepend", "append", "override"] as const)("rewrites frozen native histories copy-on-write in %s mode", mode => {
    const messages = freezeTree({ model: "public-model", system: [{ type: "text", text: "native", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], max_tokens: 128 });
    const responses = freezeTree({ model: "public-model", instructions: "native", input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }], max_output_tokens: 128 });
    for (const [kind, body] of [["messages", messages], ["responses", responses]] as const) {
      const before = JSON.stringify(body);
      const first = rewriteApi.applyRequestRewriteRules(body, { system_prompt: "first", system_prompt_mode: mode, max_tokens: 256 }, kind);
      const second = rewriteApi.applyRequestRewriteRules(body, { system_prompt: "second", system_prompt_mode: mode, max_tokens: 512 }, kind);
      expect(first).not.toBe(body); expect(second).not.toBe(body); expect(JSON.stringify(body)).toBe(before);
      expect(JSON.stringify(first)).toContain("first"); expect(JSON.stringify(second)).not.toContain("first");
      if (kind === "messages" && mode !== "override") {
        expect(first.system.find((v: any) => v.text === "native")).toBe(messages.system[0]);
        expect(second.system.find((v: any) => v.text === "native")).toBe(messages.system[0]);
      }
    }
    const embedding = freezeTree({ model: "public-model", input: [[1, 2, 3]], dimensions: 3 });
    expect(rewriteApi.applyRequestRewriteRules(embedding, { model_rewrite: "vector", system_prompt: "ignored", max_tokens: 9 }, "embeddings"))
      .toEqual({ ...embedding, model: "vector" });
  });

  it.each(["prepend", "append", "override"] as const)("isolates %s system rewrites and nested reasoning across group/member/retry", async mode => {
    const { routes } = await offers(2);
    seedProvider(d1, { id: "backup", endpoint: "https://backup.example/v1" });
    seedModel(d1, { id: "backup", provider_id: "backup", model_name: "backup", config_json: JSON.stringify({ capabilities: ["reasoning"] }) });
    d1.sql("UPDATE models SET config_json = ? WHERE id = 'm1'", JSON.stringify({ capabilities: ["reasoning"], system_prompt: "expensive", system_prompt_mode: mode, max_tokens: 2000 }));
    seedGroup(d1, { id: "pool", input_price_per_m: 10, output_price_per_m: 20,
      config_json: JSON.stringify({ member_retries: 1, system_prompt: "cheap", system_prompt_mode: mode }) });
    seedGroupMembers(d1, "pool", ["m0", "backup"]);
    await upsertServiceGroupModel(env, routes[0].group.id, { model_key: "public-model", target_type: "group", target_id: "pool" });
    const fresh = await routesApi.resolveAutoServiceRoutes(env, d1.row<DeviceRow>("SELECT * FROM devices")!, "public-model");
    vi.spyOn(routesApi, "resolveAutoServiceRoutes").mockResolvedValue(fresh);
    const body = { model: "public-model", messages: [{ role: "system", content: "original", metadata: { keep: true } },
      { role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }],
      reasoning: { effort: "high", summary: "auto" }, output_config: { effort: "high", keep: true }, max_tokens: 128 };
    const raw = JSON.stringify(body);
    const maximum = Math.max(...fresh.map(route => estimateRequestCostUsd(route.billingRow,
      rewriteApi.applyRequestRewriteRules(body, rewriteApi.parseRewriteRules(route.billingRow.config_json), "chat/completions"),
      route.autoPriceSnapshot!.multiplier, raw.length)));
    const apply = rewriteApi.applyRequestRewriteRules;
    const originals: Record<string, any>[] = [];
    vi.spyOn(rewriteApi, "applyRequestRewriteRules").mockImplementation((input, rules, kind) => {
      originals.push(input); freezeTree(input); return apply(input, rules, kind);
    });
    const sent: any[] = [], holds: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body))); holds.push(wallet(d1)!.reserved_usd);
      return sent.length < 5 ? new Response("busy", { status: 503 }) : openAiAnswer();
    });
    expect((await request(body)).status).toBe(200);
    expect(sent.map(v => v.model)).toEqual(["m0", "m0", "backup", "backup", "m1"]);
    const system = (prompt: string) => mode === "override" ? prompt : mode === "append" ? "original\n\n" + prompt : prompt + "\n\noriginal";
    expect(sent.map(v => v.messages[0].content)).toEqual([system("cheap"), system("cheap"), system("cheap"), system("cheap"), system("expensive")]);
    expect(sent[0].reasoning).toEqual({ summary: "auto" }); expect(sent[1].output_config).toEqual({ keep: true });
    for (const index of [2, 3, 4]) {
      expect(sent[index].reasoning).toEqual(body.reasoning); expect(sent[index].output_config).toEqual(body.output_config);
    }
    expect(originals).toHaveLength(2); expect(originals[0]).toBe(originals[1]); expect(originals[0]).toEqual(body);
    expect(JSON.stringify(body)).toBe(raw);
    holds.forEach(hold => expect(hold).toBeCloseTo(maximum, 8));
    expect(wallet(d1)?.reserved_usd).toBe(0);
    expect(d1.rows("SELECT * FROM usage")).toHaveLength(1);
  });
});
