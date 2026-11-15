import { describe, expect, it } from "vitest";
import { initializedSchemaDouble } from "./helpers/initializedSchemaDouble";
import { consoleApp } from "../src/console";
import { devicesApp } from "../src/admin/devices";
import type { DeviceRow, Env, ModelScope } from "../src/types";


interface ModelRow {
  id: string;
  model_name: string;
  display_name: string | null;
  alias?: string | null;
  model_public?: number;
  enabled?: number;
  input_price_per_m?: number;
  output_price_per_m?: number;
  provider_name?: string;
}

function makeEnv(opts: {
  device?: Partial<DeviceRow> | null;
  models?: ModelRow[];
  whitelisted?: string[];
} = {}) {
  const device: DeviceRow = {
    id: "dev-1",
    name: "friend laptop",
    enabled: 1,
    rate_limit_rpm: 60,
    cost_limit_monthly: null,
    current_month_cost: 0,
    model_scope: "all",
    last_used_at: null,
    created_at: 1_700_000_000_000,
    revoked_at: null,
    ...(opts.device || {}),
  } as DeviceRow;
  const models = opts.models || [];
  let whitelist = [...(opts.whitelisted || [])];
  const updates: Array<{ sql: string; binds: unknown[] }> = [];

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
          if (sql.includes("FROM devices")) {
            return opts.device === null ? null : device;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM device_models")) {
            return { results: whitelist.map((model_id) => ({ model_id })) };
          }
          if (sql.includes("FROM models")) {
            return { results: models };
          }
          return { results: [] };
        },
        async run() {
          updates.push({ sql, binds: stmt.binds });
          if (sql.includes("DELETE FROM device_models")) {
            whitelist = [];
            return { success: true, changes: 1, meta: {} };
          }
          if (sql.includes("INSERT OR IGNORE INTO device_models")) {
            whitelist.push(String(stmt.binds[1]));
            return { success: true, changes: 1, meta: {} };
          }
          if (sql.includes("UPDATE devices")) {
            if (stmt.binds.length >= 5) device.model_scope = stmt.binds[4] as ModelScope;
            return { success: true, changes: 1, meta: {} };
          }
          return { success: true, changes: 1, meta: {} };
        },
      };
      return stmt;
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const out: unknown[] = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };

  const env = { DB: initializedSchemaDouble(db), ASSETS: null, RATE_LIMITER: null } as unknown as Env;
  return { env, device, models, updates, whitelist: () => [...whitelist] };
}

const TOKEN = "sk-dshgw-good";

function deviceReq(path: string, init: RequestInit = {}) {
  return new Request(`https://gw.example.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-api-key": TOKEN,
      ...(init.headers || {}),
    },
  } as RequestInit);
}

const MODELS: ModelRow[] = [
  { id: "model_a", model_name: "alpha", display_name: "Alpha", model_public: 1 },
  { id: "model_b", model_name: "beta", display_name: null, model_public: 0 },
  { id: "model_c", model_name: "gamma", display_name: "Gamma", model_public: 0 },
];

describe("admin model-scope endpoints", () => {
  it("404s an unknown device instead of creating a whitelist for nobody", async () => {
    const { env } = makeEnv({ device: null, models: MODELS });
    const res = await devicesApp.request("/dev-1/model-scope", {}, env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  it("returns the whitelist together with the models the editor can pick", async () => {
    const { env } = makeEnv({
      device: { model_scope: "list" },
      models: MODELS,
      whitelisted: ["model_b"],
    });
    const res = await devicesApp.request("/dev-1/model-scope", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      item: { device_id: string; model_scope: string; model_ids: string[]; model_count: number };
      models: Array<{ id: string; model_name: string }>;
    };
    expect(body.item.device_id).toBe("dev-1");
    expect(body.item.model_scope).toBe("list");
    expect(body.item.model_ids).toEqual(["model_b"]);
    expect(body.item.model_count).toBe(1);
    expect(body.models.map((m) => m.id)).toEqual(["model_a", "model_b", "model_c"]);
  });

  it("rejects a scoped device with an empty whitelist and changes nothing", async () => {
    const { env, device, updates } = makeEnv({ models: MODELS, whitelisted: ["model_b"] });
    const res = await devicesApp.request(
      "/dev-1/model-scope",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model_scope: "list", model_ids: [] }),
      },
      env
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("empty_whitelist");
    expect(device.model_scope).toBe("all");
    expect(updates.some((u) => u.sql.includes("UPDATE devices"))).toBe(false);
  });

  it("reports unknown model ids rather than storing dangling whitelist rows", async () => {
    const { env, updates, whitelist } = makeEnv({ models: MODELS });
    const res = await devicesApp.request(
      "/dev-1/model-scope",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model_scope: "list", model_ids: ["model_b", "model_ghost"] }),
      },
      env
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; model_ids: string[] };
    expect(body.error).toBe("unknown_model_ids");
    expect(body.model_ids).toEqual(["model_ghost"]);
    expect(updates.some((u) => u.sql.includes("DELETE FROM device_models"))).toBe(false);
    expect(whitelist()).toEqual([]);
  });

  it("stores the whitelist and flips the scope in one call", async () => {
    const { env, device, whitelist } = makeEnv({ models: MODELS });
    const res = await devicesApp.request(
      "/dev-1/model-scope",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model_scope: "list", model_ids: ["model_b", "model_b", "model_c"] }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(whitelist().sort()).toEqual(["model_b", "model_c"]);
    expect(device.model_scope).toBe("list");
  });

  it("clears the stored rows when the scope goes back to all", async () => {
    const { env, device, whitelist, updates } = makeEnv({
      device: { model_scope: "list" },
      models: MODELS,
      whitelisted: ["model_b", "model_c"],
    });
    const res = await devicesApp.request(
      "/dev-1/model-scope",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model_scope: "all" }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(device.model_scope).toBe("all");
    expect(whitelist()).toEqual([]);
    expect(updates.some((u) => u.sql.includes("DELETE FROM device_models"))).toBe(true);
  });

  it("accepts all_and_list without narrowing anything", async () => {
    const { env, device, whitelist } = makeEnv({ models: MODELS });
    const res = await devicesApp.request(
      "/dev-1/model-scope",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model_scope: "all_and_list", model_ids: ["model_a"] }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(device.model_scope).toBe("all_and_list");
    expect(whitelist()).toEqual(["model_a"]);
  });
});

describe("console GET /models", () => {
  it("rejects an anonymous caller", async () => {
    const { env } = makeEnv({ models: MODELS });
    const res = await consoleApp.fetch(new Request("https://gw.example.com/models"), env);
    expect(res.status).toBe(401);
  });

  it("shows an unscoped device every enabled model", async () => {
    const { env } = makeEnv({ device: { model_scope: "all" }, models: MODELS });
    const res = await consoleApp.fetch(deviceReq("/models"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model_scope: string; model_count: number; items: Array<{ model_name: string }> };
    expect(body.model_scope).toBe("all");
    expect(body.model_count).toBe(3);
    expect(body.items.map((i) => i.model_name)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("shows a whitelisted device only its own models, never a price it may not pay", async () => {
    const { env } = makeEnv({
      device: { model_scope: "list" },
      models: MODELS,
      whitelisted: ["model_b"],
    });
    const res = await consoleApp.fetch(deviceReq("/models"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model_scope: string; model_count: number; items: Array<{ id: string; model_name: string }> };
    expect(body.model_scope).toBe("list");
    expect(body.model_count).toBe(1);
    expect(body.items.map((i) => i.id)).toEqual(["model_b"]);
  });

  it("reports zero models for an empty whitelist instead of quietly falling back to all", async () => {
    const { env } = makeEnv({ device: { model_scope: "list" }, models: MODELS, whitelisted: [] });
    const res = await consoleApp.fetch(deviceReq("/models"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model_count: number; items: unknown[] };
    expect(body.model_count).toBe(0);
    expect(body.items).toEqual([]);
  });

  it("keeps published models reachable for all_and_list even when unlisted", async () => {
    const { env } = makeEnv({
      device: { model_scope: "all_and_list" },
      models: MODELS,
      whitelisted: ["model_b"],
    });
    const res = await consoleApp.fetch(deviceReq("/models"), env);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id).sort()).toEqual(["model_a", "model_b"]);
  });

  it("exposes no endpoint a device could use to widen its own scope", async () => {
    const { env } = makeEnv({ device: { model_scope: "list" }, models: MODELS, whitelisted: ["model_b"] });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await consoleApp.fetch(
        deviceReq("/models", { method, headers: { "content-type": "application/json" }, body: "{}" }),
        env
      );
      expect(res.status).toBe(404);
    }
  });
});
