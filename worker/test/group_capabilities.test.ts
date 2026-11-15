import { describe, expect, it } from "vitest";
import { buildModelCatalog } from "../src/gateway/catalog";
import { gatewayApp } from "../src/gateway/index";
import type { Env } from "../src/types";
import {
  createRealD1,
  makeEnv,
  seedDevice,
  seedGroup,
  seedGroupMembers,
  seedModel,
  seedProvider,
  TOKEN,
} from "./helpers/realGatewayEnv";


function get(env: Env, path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return gatewayApp.request("http://gw.test" + path, { method: "GET", headers }, env);
}

async function seedGroupOfOne(d1: ReturnType<typeof createRealD1>, config: string | null, memberConfig: string | null = null) {
  seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
  seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a", config_json: memberConfig });
  seedGroup(d1, { id: "grp_a", name: "gw-group", config_json: config });
  seedGroupMembers(d1, "grp_a", ["model_a"]);
  await seedDevice(d1, { balance_usd: 1 });
  return makeEnv(d1);
}

describe("a group's capability list carries the reasoning it advertises", () => {
  it("adds reasoning to a group with no config at all", async () => {
    const d1 = createRealD1();
    const env = await seedGroupOfOne(d1, null);

    const res = await get(env, "/models", TOKEN);
    const json = (await res.json()) as any;
    const entry = json.data.find((x: any) => x.id === "gw-group");

    expect(entry.supports_reasoning).toBe(true);
    expect(entry.capabilities).toContain("reasoning");
    d1.close();
  });

  it("keeps the capabilities an administrator declared and only appends reasoning", async () => {
    const d1 = createRealD1();
    const env = await seedGroupOfOne(d1, JSON.stringify({ capabilities: ["tool_call", "vision"] }));

    const res = await get(env, "/models", TOKEN);
    const json = (await res.json()) as any;
    const entry = json.data.find((x: any) => x.id === "gw-group");

    expect(entry.capabilities).toEqual(["tool_call", "vision", "reasoning"]);
    d1.close();
  });

  it("does not list reasoning twice when the administrator already declared it", async () => {
    const d1 = createRealD1();
    const env = await seedGroupOfOne(d1, JSON.stringify({ capabilities: ["reasoning"] }));

    const res = await get(env, "/models", TOKEN);
    const json = (await res.json()) as any;
    const entry = json.data.find((x: any) => x.id === "gw-group");

    expect(entry.capabilities).toEqual(["reasoning"]);
    d1.close();
  });

  it("leaves the veto alone: a group that says no publishes no reasoning capability", async () => {
    const d1 = createRealD1();
    const env = await seedGroupOfOne(d1, JSON.stringify({ supports_reasoning: false }));

    const res = await get(env, "/models", TOKEN);
    const json = (await res.json()) as any;
    const entry = json.data.find((x: any) => x.id === "gw-group");

    expect(entry.supports_reasoning).toBe(false);
    expect(entry.capabilities).not.toContain("reasoning");
    d1.close();
  });

  it("does not touch an ordinary model whose name the heuristic cannot classify", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai", endpoint: "https://a.example/v1", api_key: "sk-a" });
    seedModel(d1, { id: "model_a", model_name: "codebuddy_gpt-5", provider_id: "prov_a", config_json: null });
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);

    const res = await get(env, "/models", TOKEN);
    const json = (await res.json()) as any;
    const entry = json.data.find((x: any) => x.id === "codebuddy_gpt-5");

    expect(entry.capabilities).not.toContain("reasoning");
    d1.close();
  });

  it("answers a single-model lookup with the same capability list as the list endpoint", async () => {
    const d1 = createRealD1();
    const env = await seedGroupOfOne(d1, null);

    const res = await get(env, "/models/gw-group", TOKEN);
    const entry = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(entry.capabilities).toContain("reasoning");
    expect(entry.supports_reasoning).toBe(true);
    d1.close();
  });
});

describe("the Codex catalog agrees with the OpenAI shape", () => {
  const base = {
    id: "grp_1",
    provider_id: "",
    model_name: "DeepSeek-V41-flash",
    display_name: null,
    alias: null,
    fallback_model_id: null,
    input_price_per_m: 1,
    output_price_per_m: 2,
    cache_enabled: 0,
    cache_ttl: 3600,
    model_public: 0,
    pricing_mode: "priced" as const,
    peak_pricing_enabled: 0,
    enabled: 1,
    config_json: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    is_group: true,
  };

  it("gives a group the reasoning capability beside its ladder", () => {
    const entry = buildModelCatalog([base as any]).models[0];
    expect(entry.supported_reasoning_levels.length).toBeGreaterThan(0);
    expect(entry.capabilities).toContain("reasoning");
  });

  it("does not give it to a group that vetoes reasoning", () => {
    const off = { ...base, config_json: JSON.stringify({ supports_reasoning: false }) };
    const entry = buildModelCatalog([off as any]).models[0];
    expect(entry.supported_reasoning_levels).toEqual([]);
    expect(entry.capabilities).not.toContain("reasoning");
  });
});
