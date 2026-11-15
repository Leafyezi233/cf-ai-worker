import { describe, expect, it, vi } from "vitest";
import { initializedSchemaDouble } from "./helpers/initializedSchemaDouble";

vi.mock("../src/db/repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/repo")>();
  return {
    ...actual,
    listModelProjectionsForDevice: vi.fn(async () => [
      {
        id: "m1",
        model_name: "gpt-x",
        display_name: "X 模型",
        alias: null,
        input_price_per_m: 1,
        output_price_per_m: 2,
        cache_read_price_per_m: 0,
        cache_write_price_per_m: 0,
        billing_unit: "token",
        price_per_call: 0,
        search_price_per_call: 0,
        pricing_mode: "priced",
        peak_pricing_enabled: 0,
        provider_type: "openai",
        config_json: JSON.stringify({ description: "  高性价比通用模型，支持 128K 上下文  " }),
      },
      {
        id: "m2",
        model_name: "no-desc",
        display_name: null,
        alias: null,
        input_price_per_m: 1,
        output_price_per_m: 1,
        cache_read_price_per_m: 0,
        cache_write_price_per_m: 0,
        billing_unit: "token",
        price_per_call: 0,
        search_price_per_call: 0,
        pricing_mode: "priced",
        peak_pricing_enabled: 0,
        provider_type: "openai",
        config_json: "{not json",
      },
      {
        id: "m3",
        model_name: "blank-desc",
        display_name: null,
        alias: null,
        input_price_per_m: 1,
        output_price_per_m: 1,
        cache_read_price_per_m: 0,
        cache_write_price_per_m: 0,
        billing_unit: "token",
        price_per_call: 0,
        search_price_per_call: 0,
        pricing_mode: "priced",
        peak_pricing_enabled: 0,
        provider_type: "openai",
        config_json: JSON.stringify({ description: "   " }),
      },
      {
        id: "grp1",
        model_name: "smart-group",
        display_name: "智能分组",
        alias: null,
        input_price_per_m: 1,
        output_price_per_m: 1,
        cache_read_price_per_m: 0,
        cache_write_price_per_m: 0,
        billing_unit: "token",
        price_per_call: 0,
        search_price_per_call: 0,
        pricing_mode: "priced",
        peak_pricing_enabled: 0,
        provider_type: "openai",
        is_group: true,
        member_count: 2,
        description: "  多模型故障转移分组  ",
        config_json: JSON.stringify({ member_retries: 2 }),
      },
    ]),
    listPriceWindowsForModels: vi.fn(async () => []),
  };
});

import { consoleApp } from "../src/console";
import type { Env } from "../src/types";

function makeEnv(device: Record<string, unknown>) {
  const db = {
    async batch(statements: Array<{ sql: string; all: () => Promise<unknown>; run: () => Promise<unknown> }>) {
      return Promise.all(statements.map(s => s.sql.trimStart().startsWith("SELECT") ? s.all() : s.run()));
    },
    prepare(sql: string) {
      const stmt = {
        sql,
        bind() {
          return stmt;
        },
        async first() {
          if (sql.includes("FROM devices")) return device;
          return { total_cost: 0, cost_limit_monthly: 0, current_month_cost: 0 };
        },
        async all() {
          return { results: [] };
        },
        async run() {},
      };
      return stmt;
    },
  };
  return { DB: initializedSchemaDouble(db), ASSETS: null, RATE_LIMITER: null } as unknown as Env;
}

describe("console /models exposes config_json.description as 简介", () => {
  it("trims and passes the admin-written description through", async () => {
    const device = {
      id: "dev-1",
      name: "laptop",
      enabled: 1,
      calls_enabled: 1,
      revoked_at: null,
      password_hash: null,
      model_scope: "all",
      rate_limit_rpm: 60,
      cost_limit_monthly: 0,
      token_hash: "hash-1",
    };
    const res = await consoleApp.fetch(
      new Request("https://gw.example.com/models", { headers: { authorization: "Bearer tok" } }),
      makeEnv(device),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; description: string | null }> };
    const byId = new Map(body.items.map((m) => [m.id, m]));
    expect(byId.get("m1")?.description).toBe("高性价比通用模型，支持 128K 上下文");
    expect(byId.get("m2")?.description).toBeNull();
    expect(byId.get("m3")?.description).toBeNull();
    expect(byId.get("grp1")?.description).toBe("多模型故障转移分组");
  });
});
