import { describe, expect, it } from "vitest";
import { initializedSchemaDouble } from "./helpers/initializedSchemaDouble";
import {
  buildModelCatalog,
  inferContextWindow,
  isReasoningModel,
  inferInputModalities,
} from "../src/gateway/catalog";
import type { ModelRow } from "../src/types";

describe("Model Catalog Builder (model-catalog.json)", () => {
  it("infers context window correctly for different model families", () => {
    expect(inferContextWindow("gemini-2.0-flash")).toBe(1048576);
    expect(inferContextWindow("claude-3-5-sonnet-20241022")).toBe(200000);
    expect(inferContextWindow("deepseek-chat")).toBe(131072);
    expect(inferContextWindow("gpt-4o")).toBe(128000);
    expect(inferContextWindow("custom-model")).toBe(128000);
  });

  it("detects reasoning models correctly", () => {
    expect(isReasoningModel("deepseek-r1")).toBe(true);
    expect(isReasoningModel("gemini-2.0-flash-thinking-exp-01-21")).toBe(true);
    expect(isReasoningModel("qwq-32b")).toBe(true);
    expect(isReasoningModel("o1")).toBe(true);
    expect(isReasoningModel("o3-mini")).toBe(true);
    expect(isReasoningModel("claude-3-7-sonnet")).toBe(true);
    expect(isReasoningModel("gpt-4o")).toBe(false);
    expect(isReasoningModel("claude-3-5-sonnet")).toBe(false);
  });

  it("infers multimodal input modalities", () => {
    expect(inferInputModalities("gpt-4o")).toEqual(["text", "image"]);
    expect(inferInputModalities("claude-3-5-sonnet-20241022")).toEqual(["text", "image"]);
    expect(inferInputModalities("gemini-2.0-flash")).toEqual(["text", "image"]);
    expect(inferInputModalities("deepseek-chat")).toEqual(["text"]);
  });

  it("builds a valid model catalog from active model rows", () => {
    const mockModels: ModelRow[] = [
      {
        id: "m1",
        provider_id: "prov_openai",
        model_name: "gpt-4o",
        display_name: "GPT-4o Flagship",
        alias: "gpt-4o-latest",
        fallback_model_id: null,
        input_price_per_m: 2.5,
        output_price_per_m: 10,
        cache_enabled: 0,
        cache_ttl: 3600,
        model_public: 0,
        pricing_mode: "priced",
        peak_pricing_enabled: 0,
        enabled: 1,
        config_json: JSON.stringify({ custom_tag: "fast" }),
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      {
        id: "m2",
        provider_id: "prov_deepseek",
        model_name: "deepseek-reasoner",
        display_name: "DeepSeek R1",
        alias: "deepseek-r1",
        fallback_model_id: null,
        input_price_per_m: 0.55,
        output_price_per_m: 2.19,
        cache_enabled: 0,
        cache_ttl: 3600,
        model_public: 0,
        pricing_mode: "priced",
        peak_pricing_enabled: 0,
        enabled: 1,
        config_json: JSON.stringify({ apply_patch_tool_type: "function" }),
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      {
        id: "m3",
        provider_id: "prov_disabled",
        model_name: "disabled-model",
        display_name: "Disabled",
        alias: null,
        fallback_model_id: null,
        input_price_per_m: 0,
        output_price_per_m: 0,
        cache_enabled: 0,
        cache_ttl: 3600,
        model_public: 0,
        pricing_mode: "unset",
        peak_pricing_enabled: 0,
        enabled: 0,  
        config_json: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ];

    const catalog = buildModelCatalog(mockModels);

    expect(catalog.models.length).toBe(2);

    const m1 = catalog.models.find((x) => x.slug === "gpt-4o-latest");
    expect(m1).toBeDefined();
    expect(m1?.display_name).toBe("GPT-4o Flagship");
    expect(m1?.context_window).toBe(128000);
    expect(m1?.max_context_window).toBe(128000);
    expect(m1?.effective_context_window_percent).toBe(95);
    expect(m1?.shell_type).toBe("shell_command");
    expect(m1?.supports_image_detail_original).toBe(false);
    expect(m1?.supports_parallel_tool_calls).toBe(false);
    expect(m1?.supports_reasoning_summaries).toBe(false);
    expect(m1?.supports_reasoning_summary_parameter).toBe(false);
    expect(m1?.truncation_policy).toEqual({ limit: 10000, mode: "bytes" });
    expect(m1?.apply_patch_tool_type).toBe("freeform");
    expect(m1?.supports_search_tool).toBe(false);
    expect(m1?.web_search_tool_type).toBe("none");
    expect(m1?.base_instructions).toContain("You are Codex");
    expect(m1?.model_messages?.instructions_template).toContain("You are Codex");
    expect(m1?.model_messages?.instructions_variables?.personality_friendly).toBeDefined();
    expect(m1?.input_modalities).toEqual(["text", "image"]);
    expect((m1 as any)?.custom_tag).toBe("fast");

    const m2 = catalog.models.find((x) => x.slug === "deepseek-r1");
    expect(m2).toBeDefined();
    expect(m2?.display_name).toBe("DeepSeek R1");
    expect(m2?.apply_patch_tool_type).toBe("function");
    expect(m2?.supported_reasoning_levels?.length).toBeGreaterThan(0);
    expect(m2?.default_reasoning_level).toBe("medium");
    expect(m2?.priority).toBe(1001);

    expect(m1?.default_reasoning_level).toBeNull();
    expect(m1?.supported_reasoning_levels).toEqual([]);
  });

  it("lets a model opt back into search and reasoning defaults through config_json", () => {
    const base: ModelRow = {
      id: "m4",
      provider_id: "prov_openai",
      model_name: "gpt-4o-search-preview",
      display_name: "GPT-4o Search",
      alias: null,
      fallback_model_id: null,
      input_price_per_m: 2.5,
      output_price_per_m: 10,
      cache_enabled: 0,
      cache_ttl: 3600,
      model_public: 0,
      pricing_mode: "priced",
      peak_pricing_enabled: 0,
      enabled: 1,
      config_json: JSON.stringify({
        supports_search_tool: true,
        web_search_tool_type: "text_and_image",
        default_reasoning_level: "high",
      }),
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const catalog = buildModelCatalog([base]);
    const entry = catalog.models[0];

    expect(entry.supports_search_tool).toBe(true);
    expect(entry.web_search_tool_type).toBe("text_and_image");
    expect(entry.default_reasoning_level).toBe("high");
    expect(entry.supported_reasoning_levels.length).toBeGreaterThan(0);
    expect(entry.reasoning_source).toBe("config_default");
  });

  it("lets a model opt back into the capabilities that are off by default", () => {
    const base: ModelRow = {
      id: "m6",
      provider_id: "prov_openai",
      model_name: "gpt-4o",
      display_name: "GPT-4o",
      alias: null,
      fallback_model_id: null,
      input_price_per_m: 2.5,
      output_price_per_m: 10,
      cache_enabled: 0,
      cache_ttl: 3600,
      model_public: 0,
      pricing_mode: "priced",
      peak_pricing_enabled: 0,
      enabled: 1,
      config_json: JSON.stringify({
        supports_image_detail_original: true,
        supports_parallel_tool_calls: true,
        supports_reasoning_summaries: true,
        supports_reasoning_summary_parameter: true,
        truncation_policy: { limit: 50000, mode: "tokens" },
      }),
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const entry = buildModelCatalog([base]).models[0];
    expect(entry.supports_image_detail_original).toBe(true);
    expect(entry.supports_parallel_tool_calls).toBe(true);
    expect(entry.supports_reasoning_summaries).toBe(true);
    expect(entry.supports_reasoning_summary_parameter).toBe(true);
    expect(entry.truncation_policy).toEqual({ limit: 50000, mode: "tokens" });
  });

  it("honours a config_json reasoning ladder and an explicit opt-out", () => {
    const base: ModelRow = {
      id: "m5",
      provider_id: "prov_relay",
      model_name: "codebuddy_gpt-5",
      display_name: "Relay GPT-5",
      alias: null,
      fallback_model_id: null,
      input_price_per_m: 1,
      output_price_per_m: 2,
      cache_enabled: 0,
      cache_ttl: 3600,
      model_public: 0,
      pricing_mode: "priced",
      peak_pricing_enabled: 0,
      enabled: 1,
      config_json: JSON.stringify({
        capabilities: ["reasoning"],
        supported_reasoning_levels: [{ effort: "low", description: "fast" }, { effort: "high", description: "deep" }],
        default_reasoning_level: "low",
      }),
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const entry = buildModelCatalog([base]).models[0];
    expect(entry.supported_reasoning_levels.map((l: any) => l.effort)).toEqual(["low", "high"]);
    expect(entry.default_reasoning_level).toBe("low");
    expect(entry.reasoning_source).toBe("config_levels");

    const off = { ...base, config_json: JSON.stringify({ supports_reasoning: false, capabilities: ["reasoning"] }) };
    const offEntry = buildModelCatalog([off]).models[0];
    expect(offEntry.supported_reasoning_levels).toEqual([]);
    expect(offEntry.default_reasoning_level).toBeNull();
  });

  it("always advertises a reasoning ladder for a group, whatever its members look like", () => {
    const group = {
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

    const entry = buildModelCatalog([group as any]).models[0];
    expect(entry.supported_reasoning_levels.map((l: any) => l.effort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(entry.default_reasoning_level).toBe("medium");
    expect(entry.reasoning_source).toBe("group_default");

    const off = { ...group, config_json: JSON.stringify({ supports_reasoning: false }) };
    const offEntry = buildModelCatalog([off as any]).models[0];
    expect(offEntry.supported_reasoning_levels).toEqual([]);
    expect(offEntry.default_reasoning_level).toBeNull();
    expect(offEntry.reasoning_source).toBe("config_off");
  });

  it("handles listModelsHandler returning models and aliases", async () => {
    const { listModelsHandler } = await import("../src/gateway/proxy");
    const mockDb = {
      prepare: () => ({
        all: async () => ({
          results: [
            {
              id: "m1",
              model_name: "gpt-4o",
              display_name: "GPT-4o",
              alias: "gpt-4o-latest",
              fallback_model_id: null,
              input_price_per_m: 2.5,
              output_price_per_m: 10,
              created_at: 1700000000000,
              owned_by: "openai",
            },
          ],
        }),
      }),
    };

    const mockContext: any = {
      req: {
        header: (k: string) => (k.toLowerCase() === "authorization" ? "Bearer dkey_valid" : undefined),
      },
      env: {
        DB: {
          batch: async () => [],
          prepare: (sql: string) => ({
            bind: (...args: any[]) => ({
              first: async () => ({ id: "d1", name: "Dev Laptop", enabled: 1 }),
              all: sql.includes("FROM service_groups") ? async () => ({ results: [] }) : mockDb.prepare().all,
            }),
            all: sql.includes("FROM service_groups") ? async () => ({ results: [] }) : mockDb.prepare().all,
          }),
        },
      },
      json: (data: any, status?: number) => ({ data, status: status || 200 }),
    };

    mockContext.env.DB = initializedSchemaDouble(mockContext.env.DB);
    const res: any = await listModelsHandler(mockContext);
    expect(res.data.object).toBe("list");
    expect(res.data.data.length).toBe(2);
    expect(res.data.data.map((x: any) => x.id)).toEqual(["gpt-4o", "gpt-4o-latest"]);
  });

  it("handles getModelHandler for specific model", async () => {
    const { getModelHandler } = await import("../src/gateway/proxy");
    const mockContext: any = {
      req: {
        param: (p: string) => (p === "model" ? "gpt-4o" : undefined),
        header: (k: string) => (k.toLowerCase() === "authorization" ? "Bearer dkey_valid" : undefined),
      },
      env: {
        DB: {
          batch: async () => [],
          prepare: (sql: string) => ({
            all: async () => sql.includes("FROM models") ? ({ results: [{ id: "m1", model_name: "gpt-4o", display_name: "GPT-4o", alias: "gpt-4o-latest", provider_id: "prov_openai", provider_name: "OpenAI", provider_type: "openai", enabled: 1, provider_enabled: 1, created_at: 1700000000000 }] }) : ({ results: [] }),
            run: async () => ({ success: true, meta: {} }),
            bind: (...args: any[]) => ({
              first: async () => sql.includes("devices") ? ({ id: "d1", name: "Dev Laptop", enabled: 1, service_group_id: "legacy", default_service_group_id: "legacy", token_routing_policy: null }) : ({ id: "m1", model_name: "gpt-4o", display_name: "GPT-4o", alias: "gpt-4o-latest", provider_id: "prov_openai", provider_name: "OpenAI", provider_type: "openai", enabled: 1, provider_enabled: 1, created_at: 1700000000000 }),
              all: async () => {
                if (sql.includes("token_routing_policies") || sql.includes("service_groups")) return { results: [] };
                return {
                  results: [
                    {
                      id: "m1",
                      model_name: "gpt-4o",
                      display_name: "GPT-4o",
                      alias: "gpt-4o-latest",
                      provider_id: "prov_openai",
                      provider_name: "OpenAI",
                      provider_type: "openai",
                      enabled: 1,
                      provider_enabled: 1,
                      created_at: 1700000000000,
                    },
                  ],
                };
              },
            }),
          }),
        },
      },
      json: (data: any, status?: number) => ({ data, status: status || 200 }),
    };

    mockContext.env.DB = initializedSchemaDouble(mockContext.env.DB);
    const res: any = await getModelHandler(mockContext);
    expect(res.data.id).toBe("gpt-4o");
    expect(res.data.object).toBe("model");
    expect(res.data.owned_by).toBe("OpenAI");
  });
});

