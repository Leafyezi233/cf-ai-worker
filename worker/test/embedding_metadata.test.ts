import { describe, expect, it, vi } from "vitest";
import { initializedSchemaDouble } from "./helpers/initializedSchemaDouble";
import { gatewayApp } from "../src/gateway";
import { protocolProbesApp } from "../src/admin/protocol-probes";
import { createRealD1, makeEnv, seedModel, seedProvider } from "./helpers/realGatewayEnv";
import { resolveModelType } from "../src/gateway/model_type";
import { readProtocolCapabilities, planProtocolRoute } from "../src/gateway/protocol_capabilities";
import { aggregateProtocolMetadata } from "../src/gateway/protocol_metadata";
import { CreateModelSchema, UpdateModelSchema, CreateModelGroupSchema } from "../src/admin/schemas";
import { buildModelCatalog } from "../src/gateway/catalog";
import { serializeConsoleModel } from "../src/console/model_marketplace";
import { generateOpenApiSpec } from "../src/gateway/openapi";
import type { Env } from "../src/types";

const embedding = (provider_type = "openai", model_name = "text-embedding-3-small", config_json = '{"model_type":"embedding"}') => ({
  id: "e1", provider_id: "p1", provider_type, provider_name: provider_type, model_name, alias: null, display_name: model_name,
  enabled: 1, model_public: 1, billing_unit: "token", config_json, input_price_per_m: 1, output_price_per_m: 0,
});

describe("embedding model metadata contract", () => {
  it("resolves explicit embedding while preserving legacy fallback", () => {
    expect(resolveModelType({ config_json: '{"model_type":"embedding"}' })).toBe("embedding");
    expect(resolveModelType({ billing_unit: "call" })).toBe("image");
    expect(resolveModelType({ config_json: '{"model_type":"invalid"}', billing_unit: "token" })).toBe("text");
  });
  it("advertises only embeddings on OpenAI-compatible rows and never routes chat", () => {
    const row = embedding();
    expect(readProtocolCapabilities(row)).toMatchObject({ chat_completions: false, responses: false, supported_endpoints: ["/v1/embeddings"], upstream_endpoints: ["/v1/embeddings"] });
    expect(planProtocolRoute(row, "chat/completions")).toBeNull();
    expect(planProtocolRoute(row, "responses")).toBeNull();
    for (const provider_type of ["gemini", "anthropic"]) expect(readProtocolCapabilities(embedding(provider_type)).supported_endpoints).toEqual([]);
    expect(aggregateProtocolMetadata([row]).supported_endpoints).toEqual(["/v1/embeddings"]);
  });
  it("accepts a strict optional profile and rejects malformed profile fields and non-token creates", () => {
    const valid = { provider_id: "p1", model_name: "embed", config_json: JSON.stringify({ model_type: "embedding", embedding_profile: { compatibility_key: "vendor-v1", dimensions: 1536 } }) };
    expect(CreateModelSchema.safeParse(valid).success).toBe(true);
    for (const profile of [{ compatibility_key: "" }, { compatibility_key: " " }, { compatibility_key: "x".repeat(129) }, { compatibility_key: "ok", dimensions: 0 }, { compatibility_key: "ok", dimensions: 4097 }, { compatibility_key: "ok", dimensions: 1.5 }, { compatibility_key: "ok", extra: true }, { dimensions: 2 }]) {
      expect(CreateModelSchema.safeParse({ ...valid, config_json: JSON.stringify({ model_type: "embedding", embedding_profile: profile }) }).success).toBe(false);
    }
    expect(CreateModelSchema.safeParse({ ...valid, billing_unit: "call" }).success).toBe(false);
    expect(UpdateModelSchema.safeParse({ config_json: JSON.stringify({ model_type: "embedding", embedding_profile: { compatibility_key: "v" } }) }).success).toBe(true);
    expect(CreateModelGroupSchema.safeParse({ name: "g", config_json: JSON.stringify({ model_type: "embedding", embedding_profile: { compatibility_key: "v" } }) }).success).toBe(true);
  });
  it("keeps embeddings out of the chat catalog but shows their endpoint in marketplace metadata", () => {
    expect(buildModelCatalog([embedding() as any]).models).toEqual([]);
    expect(serializeConsoleModel(embedding() as any, new Map(), Date.now(), 0)).toMatchObject({ model_type: "embedding", chat_endpoint: "/v1/embeddings" });
  });
  it("exposes safe public discovery and excludes embeddings from paid protocol probes", async () => {
    const db = createRealD1();
    const env = makeEnv(db);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected paid request"));
    try {
      seedProvider(db);
      seedModel(db, { id: "embed", model_name: "embed", alias: "embed-alias", output_price_per_m: 0, config_json: JSON.stringify({ model_type: "embedding", embedding_profile: { compatibility_key: "private-space", dimensions: 1536 }, api_key: "private-secret" }) });
      const listed = await gatewayApp.request("http://local/models", {}, env);
      expect(listed.status).toBe(200);
      const listing = await listed.json() as any;
      expect(listing.data).toHaveLength(2);
      for (const model of listing.data) {
        expect(model).toMatchObject({ model_type: "embedding", chat_endpoint: "/v1/embeddings" });
        const single = await gatewayApp.request("http://local/models/" + model.id, {}, env);
        expect(single.status).toBe(200);
        expect(await single.json()).toMatchObject({ model_type: "embedding", chat_endpoint: "/v1/embeddings" });
      }
      expect(JSON.stringify(listing)).not.toContain("private-space");
      expect(JSON.stringify(listing)).not.toContain("private-secret");
      const preview = await protocolProbesApp.request("http://local/preview", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, env);
      expect(await preview.json()).toMatchObject({ items: [], request_count: 0, skipped: 1 });
      for (const operation of ["run", "apply"]) {
        const response = await protocolProbesApp.request("http://local/" + operation, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model_id: "embed", fingerprint: "stale", confirm_cost: true }) }, env);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: "probe_target_changed" });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); db.close(); }
  });
  it("documents bounded OpenAI embeddings request and isolates embedding model IDs", async () => {
    const modelRows = [embedding() as any, { ...embedding(), id: "c1", model_name: "chat-model", config_json: "{}" }];
    const env = { DB: { prepare: (sql: string) => ({ bind() { return this; }, all: async () => ({ results: sql.includes("FROM models m LEFT JOIN") ? modelRows : [] }) }) } } as unknown as Env;
    env.DB = initializedSchemaDouble(env.DB);
    const spec = await generateOpenApiSpec(env);
    const paths = spec.paths as any;
    const schemas = (spec.components as any).schemas;
    const request = schemas.EmbeddingRequest;
    expect(schemas.ChatCompletionRequest.properties.model.enum).toContain("chat-model");
    expect(schemas.ChatCompletionRequest.properties.model.enum).not.toContain("text-embedding-3-small");
    expect(request.properties.model.enum).toContain("text-embedding-3-small");
    expect(paths["/v1/embeddings"].post.operationId).toBe("createEmbedding");
    expect(request.required).toEqual(["model", "input"]);
    expect(request.properties.input.oneOf[1].maxItems).toBe(64);
    expect(request.properties.dimensions.maximum).toBe(4096);
    expect(request.properties.encoding_format.enum).toEqual(["float", "base64"]);
    expect(paths["/v1/chat/completions"]).toBeDefined();
  });
});
