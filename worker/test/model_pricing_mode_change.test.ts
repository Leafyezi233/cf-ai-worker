import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { adminApp } from "../src/admin";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { seedModel, seedProvider } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";


const require = createRequire(import.meta.url);
const { readFileSync } = require("node:fs");
const { fileURLToPath } = require("node:url");

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

async function admin(
  env: Env,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<Response> {
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

function mode(d1: RealD1, id: string): string {
  return d1.row<{ pricing_mode: string }>("SELECT pricing_mode FROM models WHERE id = ?", id)!
    .pricing_mode;
}

const UNPRICED = { input_price_per_m: 0, output_price_per_m: 0, pricing_mode: "unset" };

describe("a model can be switched to free through the admin API", () => {
  it("batch-update sets pricing_mode=free and reports one changed row", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedProvider(d1);
    seedModel(d1, { id: "m1", ...UNPRICED });

    const res = await admin(env, "/models/batch-update", {
      method: "POST",
      body: { ids: ["m1"], pricing_mode: "free" },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ updated: 1 });
    expect(mode(d1, "m1")).toBe("free");
    d1.close();
  });

  it("PUT /models/:id sets pricing_mode=free without zeroing stored prices", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedProvider(d1);
    seedModel(d1, { id: "m1", input_price_per_m: 3, output_price_per_m: 15, pricing_mode: "priced" });

    const res = await admin(env, "/models/m1", {
      method: "PUT",
      body: { pricing_mode: "free" },
    });

    expect(res.status).toBe(200);
    const stored = d1.row<{ pricing_mode: string; input_price_per_m: number; output_price_per_m: number }>(
      "SELECT pricing_mode, input_price_per_m, output_price_per_m FROM models WHERE id = ?",
      "m1"
    )!;
    expect(stored.pricing_mode).toBe("free");
    expect(stored.input_price_per_m).toBe(3);
    expect(stored.output_price_per_m).toBe(15);
    d1.close();
  });

  it("POST /models creates a free model with zero prices", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const provId = seedProvider(d1);

    const res = await admin(env, "/models", {
      method: "POST",
      body: { provider_id: provId, model_name: "gw-free", pricing_mode: "free" },
    });

    expect(res.status).toBe(201);
    const id = ((await res.json()) as any).item.id as string;
    expect(mode(d1, id)).toBe("free");
    d1.close();
  });

  it("batch-update can pin priced even when every price is zero", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedProvider(d1);
    seedModel(d1, { id: "m1", ...UNPRICED });

    const res = await admin(env, "/models/batch-update", {
      method: "POST",
      body: { ids: ["m1"], pricing_mode: "priced" },
    });

    expect(res.status).toBe(200);
    expect(mode(d1, "m1")).toBe("priced");
    d1.close();
  });

  it("leaves other rows untouched when only one id is selected", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    seedProvider(d1);
    seedModel(d1, { id: "m1", ...UNPRICED });
    seedModel(d1, { id: "m2", ...UNPRICED });

    await admin(env, "/models/batch-update", {
      method: "POST",
      body: { ids: ["m1"], pricing_mode: "free" },
    });

    expect(mode(d1, "m1")).toBe("free");
    expect(mode(d1, "m2")).toBe("unset");
    d1.close();
  });
});

describe("the model form still sends pricing_mode", () => {
  it("serialize() puts pricing_mode in the payload", () => {
    const path = fileURLToPath(new URL("../../web/src/pages/ModelsPage.tsx", import.meta.url));
    const source = readFileSync(path, "utf8");
    const body = source.slice(source.indexOf("function serialize("));
    expect(body.slice(0, body.indexOf("\n}"))).toMatch(/pricing_mode:\s*f\.pricing_mode/);
  });
});
