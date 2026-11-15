import { describe, expect, it } from "vitest";
import { adminApp } from "../src/admin";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { seedProvider } from "./helpers/realGatewayEnv";
import { publicProvider } from "../src/admin/providers";
import { isReservedSecretName, readEnvSecret, secretNamePolicyError } from "../src/utils/env-secret";
import type { Env } from "../src/types";


const SECRET = "session-signing-secret";

function makeEnv(d1: RealD1): Env {
  return {
    DB: d1.DB,
    ASSETS: { fetch: async () => new Response("assets") } as any,
    ADMIN_SECRET: "admin-password",
    SESSION_SECRET: SECRET,
    ENCRYPTION_KEY: "encryption-key",
    CF_TEST_SECRET: "sk-env-secret-val",
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

describe("the secret_name policy refuses the gateway\u2019s own bindings", () => {
  it("names the reserved set and keeps ordinary names out of it", () => {
    for (const name of ["ADMIN_SECRET", "SESSION_SECRET", "ENCRYPTION_KEY", "DB", "CACHE_KV"]) {
      expect(isReservedSecretName(name)).toBe(true);
      expect(secretNamePolicyError(name)).toContain("不能把网关自身的变量");
    }
    expect(isReservedSecretName("admin_secret")).toBe(true);
    expect(isReservedSecretName("CF_ACCESS_CLIENT_SECRET")).toBe(true);
    expect(secretNamePolicyError("CF_TEST_SECRET")).toBeNull();
    expect(secretNamePolicyError("OPENAI_API_KEY")).toBeNull();
    expect(secretNamePolicyError(null)).toBeNull();
    expect(secretNamePolicyError(undefined)).toBeNull();
  });

  it("rejects a malformed name on shape alone", () => {
    expect(secretNamePolicyError("1LEADING_DIGIT")).toContain("不能以数字开头");
    expect(secretNamePolicyError("has-dash")).toContain("只能包含字母、数字和下划线");
    expect(secretNamePolicyError("A".repeat(101))).toContain("不能超过 100 个字符");
  });

  it("refuses to READ a reserved name even when the variable is set", async () => {
    const env = { ADMIN_SECRET: "admin-password", CF_TEST_SECRET: "sk-env-secret-val" };
    expect(readEnvSecret(env, "ADMIN_SECRET")).toBeUndefined();
    expect(readEnvSecret(env, " admin_secret ")).toBeUndefined();
    expect(readEnvSecret(env, "CF_TEST_SECRET")).toBe("sk-env-secret-val");
    expect(readEnvSecret(env, "MISSING_VAR")).toBeUndefined();
    expect(readEnvSecret(undefined, "CF_TEST_SECRET")).toBeUndefined();
  });

  it("reports api_key_configured=false for a row that names a reserved variable", () => {
    const env = makeEnv(createRealD1());
    const row = { id: "prov_1", name: "Alpha", type: "openai", api_key: null, secret_name: "ADMIN_SECRET" };
    expect(publicProvider(row as any, env).api_key_configured).toBe(false);
    expect(publicProvider({ ...row, secret_name: "CF_TEST_SECRET" } as any, env).api_key_configured).toBe(true);
  });
});

describe("the write paths refuse a reserved secret_name", () => {
  it("rejects it on create, naming the field", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const res = await admin(env, "/providers", {
      method: "POST",
      body: { name: "Sneaky", type: "openai", secret_name: "ENCRYPTION_KEY" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("validation_error");
    expect(body.message.startsWith("secret_name: ")).toBe(true);
    expect(d1.rows("SELECT id FROM providers")).toHaveLength(0);
  });

  it("rejects it on update too", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A" });
    const env = makeEnv(d1);
    const res = await admin(env, "/providers/prov_a", {
      method: "PUT",
      body: { secret_name: "SESSION_SECRET" },
    });
    expect(res.status).toBe(400);
    expect(d1.row<{ secret_name: string | null }>("SELECT secret_name FROM providers WHERE id = ?", "prov_a")!.secret_name).toBeNull();
  });

  it("rejects it on rotate-key, which does not go through the validator", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A" });
    const env = makeEnv(d1);
    const res = await admin(env, "/providers/prov_a/rotate-key", {
      method: "POST",
      body: { api_key: "sk-new", secret_name: "ADMIN_SECRET" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("validation_error");
    expect(body.message).toContain("secret_name");
    const after = d1.row<{ api_key: string | null; secret_name: string | null }>(
      "SELECT api_key, secret_name FROM providers WHERE id = ?",
      "prov_a"
    )!;
    expect(after.secret_name).toBeNull();
    expect(after.api_key).toBe("sk-a");
  });

  it("still accepts an ordinary name and reports it as configured", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const res = await admin(env, "/providers", {
      method: "POST",
      body: { name: "Env keyed", type: "openai", secret_name: "CF_TEST_SECRET" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { api_key_configured: boolean; secret_name: string } };
    expect(body.item.secret_name).toBe("CF_TEST_SECRET");
    expect(body.item.api_key_configured).toBe(true);
  });
});
