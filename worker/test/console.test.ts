import { describe, expect, it } from "vitest";
import { initializedSchemaDouble } from "./helpers/initializedSchemaDouble";
import { consoleApp } from "../src/console";

function makeEnv(deviceId: string, device: Record<string, unknown> | null) {
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  let calls = 0;

  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        binds: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.binds = args;
          return stmt;
        },
        async first() {
          calls++;
          statements.push({ sql, binds: stmt.binds });
          if (sql.includes("FROM devices")) {
            return device;
          }
          if (sql.startsWith("SELECT hour_start FROM usage_rollup_archived_hours")) return null;
          return { total_cost: 0, cost_limit_monthly: 0, current_month_cost: 0 };
        },
        async all() {
          calls++;
          statements.push({ sql, binds: stmt.binds });
          return { results: [] };
        },
        async run() {
          return { success: true, meta: {} };
        },
      };
      return stmt;
    },
  };

  const env = {
    DB: initializedSchemaDouble({ ...db, batch: async () => [] }),
    ASSETS: null,
    RATE_LIMITER: null,
  } as unknown as import("../src/types").Env;

  return { env, statements, calls: () => calls, deviceId };
}

function req(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://gateway.example.com${path}`, { headers });
}

describe("device console API", () => {
  it("rejects requests without a device token", async () => {
    const { env } = makeEnv("dev-1", null);
    const res = await consoleApp.fetch(req("/me"), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("rejects a token that resolves to no enabled device", async () => {
    const { env } = makeEnv("dev-1", null);
    const res = await consoleApp.fetch(
      req("/me", { authorization: "Bearer sk-dshgw-unknown" }),
      env
    );
    expect(res.status).toBe(401);
  });

  it("returns only the caller device profile on /me", async () => {
    const device = {
      id: "dev-1",
      name: "friend laptop",
      enabled: 1,
      rate_limit_rpm: 60,
      cost_limit_monthly: 5,
      last_used_at: null,
      created_at: 1_700_000_000_000,
      revoked_at: null,
    };
    const { env } = makeEnv("dev-1", device);
    const res = await consoleApp.fetch(
      req("/me", { authorization: "Bearer sk-dshgw-good" }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { device: Record<string, unknown> };
    expect(body.device.id).toBe("dev-1");
    expect(body.device.name).toBe("friend laptop");
    expect(body.device.enabled).toBe(true);
    expect(JSON.stringify(body)).not.toContain("token_hash");
  });

  it("scopes every usage query to the authenticated device id", async () => {
    const device = {
      id: "dev-1",
      name: "d",
      enabled: 1,
      rate_limit_rpm: 60,
      cost_limit_monthly: null,
      last_used_at: null,
      created_at: 0,
      revoked_at: null,
    };
    const { env, statements } = makeEnv("dev-1", device);
    const res = await consoleApp.fetch(
      req("/usage?range=7d&limit=10&offset=0", {
        authorization: "Bearer sk-dshgw-good",
        "x-api-key": "sk-dshgw-good",
      }),
      env
    );
    expect(res.status).toBe(200);
    const reports = statements.filter((s) => /\bFROM usage\b/.test(s.sql));
    expect(reports).toHaveLength(4);
    for (const s of reports) {
      expect(s.sql).toContain("WHERE device_id = ?");
      const prefix = s.sql.slice(0, s.sql.indexOf("WHERE device_id = ?"));
      expect(s.binds[(prefix.match(/\?/g) || []).length]).toBe("dev-1");
    }
  });

  it("ignores a device_id supplied as a query parameter", async () => {
    const device = {
      id: "dev-1",
      name: "d",
      enabled: 1,
      rate_limit_rpm: 60,
      cost_limit_monthly: null,
      last_used_at: null,
      created_at: 0,
      revoked_at: null,
    };
    const { env, statements } = makeEnv("dev-1", device);
    const res = await consoleApp.fetch(
      req("/usage?device_id=dev-2&range=24h", { authorization: "Bearer sk-dshgw-good" }),
      env
    );
    expect(res.status).toBe(200);
    const reports = statements.filter((s) => /\bFROM usage\b/.test(s.sql));
    expect(reports).toHaveLength(4);
    for (const s of reports) {
      expect(s.binds).not.toContain("dev-2");
      expect(s.binds).toContain("dev-1");
    }
  });

  it("clamps paging parameters instead of trusting them", async () => {
    const device = {
      id: "dev-1",
      name: "d",
      enabled: 1,
      rate_limit_rpm: 60,
      cost_limit_monthly: null,
      last_used_at: null,
      created_at: 0,
      revoked_at: null,
    };
    const { env } = makeEnv("dev-1", device);
    const res = await consoleApp.fetch(
      req("/usage?limit=999999&offset=-5", { authorization: "Bearer sk-dshgw-good" }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { page: { limit: number; offset: number } };
    expect(body.page.limit).toBeLessThanOrEqual(200);
    expect(body.page.offset).toBe(0);
  });

  it("reports quota without consuming rate-limit quota", async () => {
    const device = {
      id: "dev-1",
      name: "d",
      enabled: 1,
      rate_limit_rpm: 60,
      cost_limit_monthly: 5,
      last_used_at: null,
      created_at: 0,
      revoked_at: null,
    };
    const { env, statements } = makeEnv("dev-1", device);
    const res = await consoleApp.fetch(
      req("/quota", { authorization: "Bearer sk-dshgw-good" }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.rpm.limit).toBe(60);
    expect(body.rpm.remaining).toBeNull();
    expect(statements.some((s) => s.sql.includes("window"))).toBe(false);
  });

  it("reports cache prices and the chat endpoint without leaking the provider kind", async () => {
    const device = {
      id: "dev-1",
      name: "d",
      enabled: 1,
      rate_limit_rpm: 60,
      cost_limit_monthly: null,
      model_scope: "all",
      last_used_at: null,
      created_at: 0,
      revoked_at: null,
    };
    const { env } = makeEnv("dev-1", device);
    (env.DB as any).prepare = (sql: string) => {
      const stmt: any = {
        sql,
        binds: [],
        bind(...args: unknown[]) {
          stmt.binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM devices")) return device;
          return { total_cost: 0, cost_limit_monthly: 0, current_month_cost: 0 };
        },
        async all() {
          if (!sql.includes("FROM models")) return { results: [] };
          return {
            results: [
              {
                id: "m1",
                model_name: "claude-3-7-sonnet",
                display_name: "Claude",
                alias: null,
                input_price_per_m: 3,
                output_price_per_m: 15,
                cache_read_price_per_m: 0.3,
                cache_write_price_per_m: 3.75,
                config_json: null,
                model_public: 0,
                created_at: 0,
                owned_by: "anthropic",
                provider_type: "anthropic",
              },
              {
                id: "m2",
                model_name: "gpt-4o",
                display_name: null,
                alias: null,
                input_price_per_m: 2.5,
                output_price_per_m: 10,
                cache_read_price_per_m: null,
                cache_write_price_per_m: null,
                config_json: null,
                model_public: 0,
                created_at: 0,
                owned_by: "openai",
                provider_type: "openai",
              },
              {
                id: "m3",
                model_name: "codebuddy_gpt-5",
                display_name: "Relay GPT-5",
                alias: null,
                input_price_per_m: 1,
                output_price_per_m: 2,
                cache_read_price_per_m: null,
                cache_write_price_per_m: null,
                config_json: JSON.stringify({ capabilities: ["reasoning", "tool_call"] }),
                model_public: 0,
                created_at: 0,
                owned_by: "relay",
                provider_type: "openai",
              },
            ],
          };
        },
        async run() { return { success: true, meta: {} }; },
      };
      return stmt;
    };

    env.DB = initializedSchemaDouble(env.DB);
    const res = await consoleApp.fetch(req("/models", { authorization: "Bearer sk-dshgw-good" }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    const claude = body.items.find((m: any) => m.model_name === "claude-3-7-sonnet");
    const gpt = body.items.find((m: any) => m.model_name === "gpt-4o");

    expect(claude.cache_read_price_per_m).toBe(0.3);
    expect(claude.cache_write_price_per_m).toBe(3.75);
    expect(claude.chat_endpoint).toBe("/v1/messages");
    expect(claude.supports_reasoning).toBe(true);
    expect(claude.supported_reasoning_levels.map((l: any) => l.effort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(claude.default_reasoning_level).toBe("medium");

    expect(gpt.cache_read_price_per_m).toBe(0);
    expect(gpt.cache_write_price_per_m).toBe(0);
    expect(gpt.chat_endpoint).toBe("/v1/chat/completions");
    expect(gpt.supports_reasoning).toBe(false);
    expect(gpt.supported_reasoning_levels).toEqual([]);

    const relay = body.items.find((m: any) => m.model_name === "codebuddy_gpt-5");
    expect(relay.supports_reasoning).toBe(true);

    expect(JSON.stringify(body)).not.toContain("anthropic");
  });

  it("advertises a reasoning ladder for a group without borrowing a member's provider", async () => {
    const device = {
      id: "dev-1",
      name: "d",
      enabled: 1,
      rate_limit_rpm: 60,
      cost_limit_monthly: null,
      model_scope: "all",
      last_used_at: null,
      created_at: 0,
      revoked_at: null,
    };
    const { env } = makeEnv("dev-1", device);
    const group = {
      id: "grp_1",
      name: "DeepSeek-V41-flash",
      display_name: null,
      input_price_per_m: 1,
      output_price_per_m: 2,
      cache_read_price_per_m: 0,
      cache_write_price_per_m: 0,
      cache_enabled: 0,
      cache_ttl: 3600,
      enabled: 1,
      model_public: 0,
      pricing_mode: "priced",
      peak_pricing_enabled: 0,
      billing_unit: "token",
      price_per_call: 0,
      search_price_per_call: 0,
      config_json: null,
      created_at: 0,
      updated_at: 0,
    };
    (env.DB as any).prepare = (sql: string) => {
      const stmt: any = {
        sql,
        binds: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM devices")) return device;
          return { total_cost: 0, cost_limit_monthly: 0, current_month_cost: 0 };
        },
        async all() {
          if (sql.includes("FROM model_group_members")) {
            return { results: [{ group_id: "grp_1", position: 0, model_id: "m1", provider_type: "anthropic", model_name: "claude-member", alias: null, config_json: null }] };
          }
          if (sql.includes("FROM model_groups")) return { results: [group] };
          if (sql.includes("FROM models")) return { results: [] };
          return { results: [] };
        },
        async run() { return { success: true, meta: {} }; },
      };
      return stmt;
    };

    env.DB = initializedSchemaDouble(env.DB);
    const res = await consoleApp.fetch(req("/models", { authorization: "Bearer sk-dshgw-good" }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    const entry = body.items.find((m: any) => m.model_name === "DeepSeek-V41-flash");
    expect(entry).toBeTruthy();
    expect(entry.supports_reasoning).toBe(true);
    expect(entry.supported_reasoning_levels.map((l: any) => l.effort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(entry.default_reasoning_level).toBe("medium");
    expect(entry.chat_endpoint).toBe("/v1/messages");
  });

  it("refuses a chat turn that names no model", async () => {
    const device = { id: "dev-1", name: "d", enabled: 1, rate_limit_rpm: 60, cost_limit_monthly: null, model_scope: "all", last_used_at: null, created_at: 0, revoked_at: null };
    const { env } = makeEnv("dev-1", device);
    const res = await consoleApp.fetch(
      new Request("https://gateway.example.com/chat", {
        method: "POST",
        headers: { authorization: "Bearer sk-dshgw-good", "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
      env
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("model_required");
  });

  it("hands a chat turn to the gateway instead of reaching an upstream itself", async () => {
    const device = { id: "dev-1", name: "d", enabled: 1, rate_limit_rpm: 60, cost_limit_monthly: null, model_scope: "all", last_used_at: null, created_at: 0, revoked_at: null };
    const { env } = makeEnv("dev-1", device);
    const res = await consoleApp.fetch(
      new Request("https://gateway.example.com/chat", {
        method: "POST",
        headers: { authorization: "Bearer sk-dshgw-good", "content-type": "application/json" },
        body: JSON.stringify({
          model: "no-such-model",
          endpoint: "/v1/admin/devices",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      env
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("model_not_found");
  });

  it("does not expose other console routes", async () => {
    const { env } = makeEnv("dev-1", null);
    const res = await consoleApp.fetch(
      req("/providers", { authorization: "Bearer sk-dshgw-good" }),
      env
    );
    expect(res.status).toBe(404);
  });
});
