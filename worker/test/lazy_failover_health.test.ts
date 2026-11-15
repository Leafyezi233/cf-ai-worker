import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import { durableBillingFixture } from "./helpers/durableBillingFixture";
import type { ModelWithProvider } from "../src/types";

const TOKEN = "offline-lazy-health-token";
const row = (id: string) => ({ id, model_name: "shared", display_name: "shared", alias: null,
  provider_id: "p_" + id, provider_name: id, provider_type: "openai", provider_endpoint: "https://" + id + ".example/v1",
  provider_api_key: "offline-key", provider_secret_name: null, pricing_mode: "priced", input_price_per_m: 3,
  output_price_per_m: 15, enabled: 1, model_public: 1, cache_enabled: 0, config_json: null,
  created_at: 1, updated_at: 1 } as ModelWithProvider);
const isHealth = (sql: string) => sql.includes("SUM(CASE WHEN status_code >= 400 AND status_code <> 0");
const answer = () => Response.json({ id: "offline", object: "chat.completion", model: "shared",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
async function call(env: any, extra: object = {}) {
  const pending: Promise<unknown>[] = [];
  const response = await gatewayApp.request("http://offline/chat/completions", { method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "shared", messages: [{ role: "user", content: "hi" }], max_tokens: 8, ...extra }) },
    env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} } as any);
  await response.text(); await Promise.all(pending); return response;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("legacy failover health reads are paid only on a replayable failover", () => {
  it("does not scan health before or after a successful primary", async () => {
    const f = await durableBillingFixture([row("a"), row("b"), row("c")], { token: TOKEN });
    const fetch = vi.fn(async () => { expect(f.queries.filter(isHealth)).toHaveLength(0); return answer(); });
    vi.stubGlobal("fetch", fetch);
    expect((await call(f.env)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1); expect(f.queries.filter(isHealth)).toHaveLength(0);
    expect(f.usages()).toHaveLength(1); expect(f.ledger()).toHaveLength(1); expect(f.holds()).toHaveLength(0);
  });
  it("reads once after a classified primary rejection, keeping primary identity and invoice", async () => {
    const f = await durableBillingFixture([row("a"), row("b"), row("c")], { token: TOKEN });
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      seen.push(String(url));
      if (seen.length === 1) { expect(f.queries.filter(isHealth)).toHaveLength(0); return Response.json({ error: { message: "unavailable" } }, { status: 503 }); }
      expect(f.queries.filter(isHealth)).toHaveLength(1); return answer();
    }));
    expect((await call(f.env)).status).toBe(200); expect(seen).toHaveLength(2);
    expect(f.queries.filter(isHealth)).toHaveLength(1); expect(f.holds()).toHaveLength(0);
  });
  it("does not scan health or replay an unknown network acceptance", async () => {
    const f = await durableBillingFixture([row("a"), row("b"), row("c")], { token: TOKEN });
    const fetch = vi.fn(async () => { throw Error("offline network failure"); }); vi.stubGlobal("fetch", fetch);
    expect((await call(f.env)).status).toBe(502); expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.queries.filter(isHealth)).toHaveLength(0);
    expect(f.holds()).toHaveLength(1); expect(f.ledger()).toHaveLength(0);
  });
  it("never pays for health for a request rejected before dispatch", async () => {
    const f = await durableBillingFixture([row("a"), row("b"), row("c")], { token: TOKEN, balanceUsd: 0 });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await call(f.env)).status).toBe(429);
    expect(fetch).not.toHaveBeenCalled(); expect(f.queries.filter(isHealth)).toHaveLength(0);
  });
  it("still demotes unhealthy backups after primary rejection without reordering the primary", async () => {
    const f = await durableBillingFixture([row("a"), row("b"), row("c")], { token: TOKEN });
    for (let i = 0; i < 3; i++) f.d1.sql("INSERT INTO usage (request_id, device_id, provider_id, model, status_code, created_at, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)", "historical-" + i, "dev_1", "p_b", "shared", 503, Date.now(), 0);
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      seen.push(new URL(String(url)).hostname);
      return seen.length === 1 ? Response.json({ error: { message: "unavailable" } }, { status: 503 }) : answer();
    }));
    expect((await call(f.env)).status).toBe(200);
    expect(seen).toEqual(["a.example", "c.example"]); expect(f.queries.filter(isHealth)).toHaveLength(1);
  });
  it("keeps health advisory if its late read fails", async () => {
    const f = await durableBillingFixture([row("a"), row("b"), row("c")], { token: TOKEN });
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = ((sql: string) => { if (isHealth(sql)) throw Error("offline advisory query failure"); return prepare(sql); }) as any;
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      seen.push(new URL(String(url)).hostname);
      return seen.length === 1 ? Response.json({ error: { message: "unavailable" } }, { status: 503 }) : answer();
    }));
    expect((await call(f.env)).status).toBe(200); expect(seen).toEqual(["a.example", "b.example"]);
    expect(f.ledger()).toHaveLength(1); expect(f.holds()).toHaveLength(0);
  });
});
