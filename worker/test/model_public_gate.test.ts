import { describe, expect, it } from "vitest";
import { initializedSchemaDouble } from "./helpers/initializedSchemaDouble";

interface Stmt {
  bind: (...args: any[]) => Stmt;
  all: () => Promise<{ results: any[] }>;
  first: () => Promise<any>;
  run: () => Promise<{ meta: { changes: number } }>;
}

const makeCtx = (opts: { token?: string; models?: any[]; modelScope?: string; whitelisted?: string[] }) => {
  const rows = opts.models ?? [];
  const deviceRow = {
    id: "d1",
    name: "Dev",
    enabled: 1,
    model_scope: opts.modelScope || "all",
  };

  const stmt = (sql: string): Stmt => {
    if (sql.includes("FROM service_groups") || sql.includes("token_routing_") || sql.includes("public_model_identities") || sql.includes("service_model_aliases")) {
      return { bind: () => stmt(sql), all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: { changes: 0 } }) };
    }
    if (sql.includes("FROM devices")) {
      return {
        bind: () => stmt(sql),
        all: async () => ({ results: [] }),
        first: async () => (opts.token ? deviceRow : null),
        run: async () => ({ meta: { changes: 0 } }),
      };
    }
    if (sql.includes("device_models")) {
      return {
        bind: () => stmt(sql),
        all: async () => ({ results: (opts.whitelisted || []).map((model_id) => ({ model_id })) }),
        first: async () => null,
        run: async () => ({ meta: { changes: 0 } }),
      };
    }
    return {
      bind: () => stmt(sql),
      all: async () => ({ results: rows }),
      first: async () => rows[0] ?? null,
      run: async () => ({ meta: { changes: 0 } }),
    };
  };

  return {
    req: {
      param: (p: string) => (p === "model" ? (rows[0]?.model_name ?? "gpt-4o") : undefined),
      header: (k: string) =>
        opts.token && k.toLowerCase() === "authorization" ? "Bearer " + opts.token : undefined,
    },
    env: { DB: initializedSchemaDouble({ prepare: (sql: string) => stmt(sql), batch: async (statements: Stmt[]) => Promise.all(statements.map(s => s.all())) }) },
    json: (data: any, status?: number) => ({ data, status: status || 200 }),
  } as any;
};

const base = (over: Partial<Record<string, any>> = {}) => ({
  id: "m1",
  model_name: "gpt-4o",
  display_name: "GPT-4o",
  alias: null,
  fallback_model_id: null,
  input_price_per_m: 2.5,
  output_price_per_m: 10,
  config_json: null,
  created_at: 1700000000000,
  enabled: 1,
  provider_enabled: 1,
  owned_by: "openai",
  model_public: 0,
  ...over,
});

const PUBLIC = base({ id: "pub", model_name: "shared-model", alias: "shared", model_public: 1 });
const PRIVATE = base({ id: "priv", model_name: "secret-model", alias: "secret", model_public: 0 });

describe("model discovery is gated on model_public", () => {
  it("lists only public models for an anonymous caller", async () => {
    const { listModelsHandler } = await import("../src/gateway/proxy");
    const res: any = await listModelsHandler(makeCtx({ models: [PUBLIC, PRIVATE] }));
    const ids = res.data.data.map((x: any) => x.id);
    expect(ids).toContain("shared-model");
    expect(ids).toContain("shared");
    expect(ids).not.toContain("secret-model");
    expect(ids).not.toContain("secret");
  });

  it("lists every model for a caller with a valid device token", async () => {
    const { listModelsHandler } = await import("../src/gateway/proxy");
    const res: any = await listModelsHandler(makeCtx({ token: "dkey_valid", models: [PUBLIC, PRIVATE] }));
    const ids = res.data.data.map((x: any) => x.id);
    expect(ids).toEqual(expect.arrayContaining(["shared-model", "shared", "secret-model", "secret"]));
  });

  it("does not expose fallback chains of private models to anonymous callers", async () => {
    const { listModelsHandler } = await import("../src/gateway/proxy");
    const chained = base({ id: "c1", model_name: "primary", model_public: 0, fallback_model_id: "c2" });
    const res: any = await listModelsHandler(makeCtx({ models: [chained] }));
    expect(res.data.data).toHaveLength(0);
  });

  it("404s a private model for an anonymous caller", async () => {
    const { getModelHandler } = await import("../src/gateway/proxy");
    const res: any = await getModelHandler(makeCtx({ models: [PRIVATE] }));
    expect(res.status).toBe(404);
  });

  it("serves a private model to a caller with a valid device token", async () => {
    const { getModelHandler } = await import("../src/gateway/proxy");
    const res: any = await getModelHandler(makeCtx({ token: "dkey_valid", models: [PRIVATE] }));
    expect(res.status).toBe(200);
  });

  it("still 404s when the model does not exist at all", async () => {
    const { getModelHandler } = await import("../src/gateway/proxy");
    const res: any = await getModelHandler(makeCtx({ models: [] }));
    expect(res.status).toBe(404);
  });

  it("does not leak pricing of private models to anonymous callers", async () => {
    const { listModelsHandler } = await import("../src/gateway/proxy");
    const res: any = await listModelsHandler(makeCtx({ models: [PRIVATE] }));
    expect(res.data.data).toHaveLength(0);
  });
});
