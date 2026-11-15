import { describe, expect, it } from "vitest";
import { CreateModelSchema, UpdateModelSchema, CreateModelGroupSchema, UpdateModelGroupSchema } from "../src/admin/schemas";

const cases = [
  { name: "create model", schema: CreateModelSchema, required: { provider_id: "provider", model_name: "reasoner" } },
  { name: "update model", schema: UpdateModelSchema, required: {} },
  { name: "create group", schema: CreateModelGroupSchema, required: { name: "reasoners" } },
  { name: "update group", schema: UpdateModelGroupSchema, required: {} },
];

describe.each(cases)("text/call config: $name", ({ schema, required }) => {
  it.each(["text", "image"])("accepts explicit %s type without changing unrelated config", (model_type) => {
    const config_json = JSON.stringify({ model_type, supports_reasoning: true, custom: { nested: [1, "keep"] }, responses_mode: "native" });
    const result = schema.parse({ ...required, billing_unit: "call", price_per_call: 0.03, config_json });
    expect(result.config_json).toBe(config_json);
    expect(result.billing_unit).toBe("call");
    expect(result.price_per_call).toBe(0.03);
  });

  it("accepts explicit embedding type without changing unrelated config", () => {
    const config_json = JSON.stringify({ model_type: "embedding", embedding_profile: { compatibility_key: "space-v1", dimensions: 256 }, custom: "keep" });
    const result = schema.parse({ ...required, billing_unit: "token", config_json });
    expect(result.config_json).toBe(config_json);
    expect(result.billing_unit).toBe("token");
  });

  it("accepts token-billed text", () => {
    const result = schema.parse({ ...required, billing_unit: "token", config_json: '{"model_type":"text"}' });
    expect(result.billing_unit).toBe("token");
    expect(result.config_json).toBe('{"model_type":"text"}');
  });

  it.each(["audio", "TEXT", "", null, 1, true, {}, []])("rejects invalid explicit model_type %j", (model_type) => {
    const result = schema.safeParse({ ...required, config_json: JSON.stringify({ model_type, custom: "keep" }) });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["config_json"], message: "model_type must be text, image, embedding or video" })]));
  });

  it.each(["token", "call"])("preserves legacy %s config without injecting a type", (billing_unit) => {
    for (const config_json of [undefined, null, "", '{"custom":"legacy"}']) {
      const result = schema.parse({ ...required, billing_unit, config_json });
      expect(result.config_json).toBe(config_json);
      expect(result.billing_unit).toBe(billing_unit);
    }
  });
});
