import { describe, expect, it } from "vitest";
import { adminApp } from "../src/admin";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { seedProvider } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";


const SECRET = "session-signing-secret";

function makeEnv(d1: RealD1): Env {
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

function cacheFlag(d1: RealD1, table: "models" | "model_groups", id: string): number {
  return d1.row<{ cache_enabled: number }>(`SELECT cache_enabled FROM ${table} WHERE id = ?`, id)!
    .cache_enabled;
}

describe("a new model is created with caching off", () => {
  it("POST /models defaults cache_enabled to 0", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedProvider(d1);

    const res = await admin(env, "/models", {
      method: "POST",
      body: { provider_id: "prov_a", model_name: "gw-primary", input_price_per_m: 3, output_price_per_m: 15 },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { id: string; cache_enabled: number } };
    expect(body.item.cache_enabled).toBe(0);
    expect(cacheFlag(d1, "models", body.item.id)).toBe(0);
    d1.close();
  });

  it("POST /models still honours an explicit cache_enabled: true", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedProvider(d1);

    const res = await admin(env, "/models", {
      method: "POST",
      body: { provider_id: "prov_a", model_name: "gw-primary", cache_enabled: true },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { id: string } };
    expect(cacheFlag(d1, "models", body.item.id)).toBe(1);
    d1.close();
  });

  it("POST /models/batch creates every row with caching off", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedProvider(d1);

    const res = await admin(env, "/models/batch", {
      method: "POST",
      body: { provider_id: "prov_a", models: ["gw-primary", "gw-backup"] },
    });

    expect(res.status).toBe(201);
    const rows = d1.rows<{ cache_enabled: number }>("SELECT cache_enabled FROM models");
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.cache_enabled === 0)).toBe(true);
    d1.close();
  });

  it("POST /model-groups defaults cache_enabled to 0", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedProvider(d1);

    const res = await admin(env, "/model-groups", {
      method: "POST",
      body: { name: "gw-group", input_price_per_m: 3, output_price_per_m: 15 },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { id: string } };
    expect(cacheFlag(d1, "model_groups", body.item.id)).toBe(0);
    d1.close();
  });
});
