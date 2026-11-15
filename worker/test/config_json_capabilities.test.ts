import { describe, expect, it } from "vitest";
import { adminApp } from "../src/admin";
import { CreateModelGroupSchema, CreateModelSchema, UpdateModelGroupSchema, UpdateModelSchema } from "../src/admin/schemas";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { createRealD1 } from "./helpers/realD1";
import { seedProvider } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";


const SECRET = "session-signing-secret";

function makeEnv(d1: ReturnType<typeof createRealD1>): Env {
  return {
    DB: d1.DB,
    ASSETS: { fetch: async () => new Response("assets") } as any,
    ADMIN_SECRET: "admin-password",
    SESSION_SECRET: SECRET,
    ENCRYPTION_KEY: "encryption-key",
  } as unknown as Env;
}

async function admin(env: Env, path: string, init: { method?: string; body?: unknown } = {}) {
  const token = await signSession(SECRET, 0);
  return adminApp.fetch(
    new Request("http://localhost" + path, {
      method: init.method ?? "GET",
      headers: {
        cookie: buildSessionCookie(token).split(";")[0],
        "cf-connecting-ip": "203.0.113.9",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
    env
  );
}

describe("the capability vocabulary is enforced on a model's config_json", () => {
  it("accepts every word the catalog produces", () => {
    const res = CreateModelSchema.safeParse({
      provider_id: "prov_a",
      model_name: "gw-primary",
      config_json: JSON.stringify({ capabilities: ["vision", "tool_call", "reasoning", "long_context", "audio", "code"] }),
    });
    expect(res.success).toBe(true);
  });

  it("refuses a word nobody will ever match on", () => {
    const res = CreateModelSchema.safeParse({
      provider_id: "prov_a",
      model_name: "gw-primary",
      config_json: JSON.stringify({ capabilities: ["vision", "vison"] }),
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].message).toContain("vison");
      expect(res.error.issues[0].message).toContain("vision");
    }
  });

  it("refuses a non-string member, which no consumer can read either", () => {
    const res = CreateModelSchema.safeParse({
      provider_id: "prov_a",
      model_name: "gw-primary",
      config_json: JSON.stringify({ capabilities: ["vision", 3] }),
    });
    expect(res.success).toBe(false);
  });

  it("rejects malformed JSON drafts before they can silently change protocol routing", () => {
    for (const draft of ['{"capabilities": ["vis', "{", "not json at all", ""]) {
      const res = CreateModelSchema.safeParse({
        provider_id: "prov_a",
        model_name: "gw-primary",
        config_json: draft,
      });
      expect(res.success).toBe(draft === "");
    }
  });

  it("still saves a legacy row whose capabilities is not an array", () => {
    for (const legacy of ['{"capabilities": "vision"}', '{"capabilities": null}', '{"system_prompt": "hi"}', "[1,2,3]"]) {
      const res = CreateModelSchema.safeParse({
        provider_id: "prov_a",
        model_name: "gw-primary",
        config_json: legacy,
      });
      expect(res.success).toBe(true);
    }
  });

  it("applies to an update as well, since that is the path an edit actually takes", () => {
    expect(UpdateModelSchema.safeParse({ config_json: JSON.stringify({ capabilities: ["vision"] }) }).success).toBe(true);
    expect(UpdateModelSchema.safeParse({ config_json: JSON.stringify({ capabilities: ["visoin"] }) }).success).toBe(false);
  });
});

describe("the capability vocabulary is enforced on a group's config_json", () => {
  it("accepts the six words and refuses anything else", () => {
    expect(CreateModelGroupSchema.safeParse({ name: "g", config_json: JSON.stringify({ capabilities: ["reasoning"] }) }).success).toBe(true);
    expect(CreateModelGroupSchema.safeParse({ name: "g", config_json: JSON.stringify({ capabilities: ["think"] }) }).success).toBe(false);
    expect(UpdateModelGroupSchema.safeParse({ config_json: JSON.stringify({ capabilities: ["think"] }) }).success).toBe(false);
  });

  it("leaves a group's supports_reasoning veto alone", () => {
    const res = CreateModelGroupSchema.safeParse({
      name: "g",
      config_json: JSON.stringify({ supports_reasoning: false, capabilities: ["vision"] }),
    });
    expect(res.success).toBe(true);
  });
});

describe("the refusal reaches the caller as a 400 the form can display", () => {
  it("answers validation_error naming the bad capability", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai" });
    const env = makeEnv(d1);

    const res = await admin(env, "/model-groups", {
      method: "POST",
      body: { name: "gw-group", config_json: JSON.stringify({ capabilities: ["tool_call", "超级能力"] }) },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("validation_error");
    expect(body.message).toContain("超级能力");
    expect(d1.rows("SELECT id FROM model_groups")).toHaveLength(0);
    d1.close();
  });

  it("accepts a group whose capabilities are all real", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai" });
    const env = makeEnv(d1);

    const res = await admin(env, "/model-groups", {
      method: "POST",
      body: { name: "gw-group", config_json: JSON.stringify({ capabilities: ["tool_call", "reasoning"] }) },
    });

    expect(res.status).toBe(201);
    d1.close();
  });
});
