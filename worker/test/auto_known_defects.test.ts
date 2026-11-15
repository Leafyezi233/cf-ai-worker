import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import { createServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { sha256Hex } from "../src/utils/crypto";
import type { Env, PricingMode } from "../src/types";
import { CollectingExecutionContext, createRealD1, DEVICE_ID, TOKEN, makeEnv, seedDevice, seedModel, seedProvider, wallet, holdRows, type RealD1 } from "./helpers/realGatewayEnv";

let db: RealD1, env: Env;
beforeEach(async () => {
  resetRateLimitMemory(); db = createRealD1(); env = makeEnv(db);
  await seedDevice(db, { balance_usd: 100 }); seedProvider(db);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
async function offer(id: string, model: string, key: string) {
  const group = await createServiceGroup(env, { name: id, enabled: 1, selectable: 1, public_selectable: 1 });
  await upsertServiceGroupModel(env, group.id, { model_key: key, target_type: "model", target_id: model });
  return group;
}
async function request(path: string, token = TOKEN, body?: unknown) {
  const exec = new CollectingExecutionContext();
  const response = await gatewayApp.request("https://gw.test" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, exec as unknown as ExecutionContext);
  const text = await response.text(); await Promise.all(exec.pending);
  return { response, text };
}

describe("Auto catalogue isolates only conflicting public names", () => {
  it.each(["unit", "type"] as const)("keeps unrelated master/sub catalogues usable for a %s conflict without legacy escape", async conflict => {
    seedModel(db, { id: "first", model_name: "source-first", billing_unit: "call", price_per_call: 1 });
    seedModel(db, { id: "second", model_name: "source-second", billing_unit: conflict === "unit" ? "token" : "call", price_per_call: 1,
      config_json: JSON.stringify({ model_type: "text" }) });
    seedModel(db, { id: "valid", model_name: "valid-source" });
    seedModel(db, { id: "shadow", model_name: "ambiguous", alias: "safe-alias" });
    seedModel(db, { id: "alias-shadow", model_name: "safe-canonical", alias: "ambiguous" });
    seedModel(db, { id: "legacy", model_name: "legacy-safe" });
    await offer("first", "first", "ambiguous"); await offer("second", "second", "ambiguous");
    const valid = await offer("valid", "valid", "valid-model");
    db.sql("UPDATE devices SET service_group_id='auto'");
    db.sql("INSERT INTO device_sub_tokens(id,device_id,name,token_hash,service_group_id,created_at) VALUES(?,?,?,?,?,1)", "sub", DEVICE_ID, "sub", await sha256Hex("sub-token"), "auto");
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const token of [TOKEN, "sub-token"]) {
      const list = await request("/models", token); expect(list.response.status).toBe(200);
      const names = (JSON.parse(list.text).data as { id: string }[]).map(row => row.id);
      expect(names).toContain("valid-model"); expect(names).toContain("legacy-safe"); expect(names).not.toContain("ambiguous");
      expect(names).toContain("safe-alias"); expect(names).toContain("safe-canonical");
      expect((await request("/models/valid-model", token)).response.status).toBe(200);
      expect((await request("/models/ambiguous", token)).response.status).toBe(404);
      for (const path of ["/tags", "/model-catalog.json", "/openapi.json"]) {
        const catalog = await request(path, token); expect(catalog.response.status).toBe(200);
        const parsed = JSON.parse(catalog.text);
        const publishedNames = path === "/tags" ? parsed.models.map((row: { name: string }) => row.name)
          : path === "/model-catalog.json" ? parsed.models.map((row: { slug: string }) => row.slug)
          : ["ChatCompletionRequest", "EmbeddingRequest", "VideoGenerationRequest"].flatMap(name => parsed.components.schemas[name].properties.model.enum || []);
        expect(publishedNames).not.toContain("ambiguous");
      }
      expect((await request("/models/safe-alias", token)).response.status).toBe(200);
      expect((await request("/models/safe-canonical", token)).response.status).toBe(200);
      const direct = await request("/images/generations", token, { model: "ambiguous", prompt: "tree" });
      expect(direct.response.status).toBe(400); expect(direct.text).toContain(conflict === "unit" ? "mixed token and call" : "mixes text and image");
    }
    db.sql("DELETE FROM service_group_models WHERE service_group_id=?", valid.id);
    const list = await request("/models"); expect(list.response.status).toBe(200);
    expect(JSON.parse(list.text).data.map((row: { id: string }) => row.id)).not.toContain("ambiguous");
    expect(fetch).not.toHaveBeenCalled(); expect(holdRows(db)).toEqual([]);
  });
});

describe("Auto projected metadata edge cases", () => {
  it.each(["auto", "fixed"] as const)("does not invent request enum models for an empty %s catalogue", async selection => {
    seedModel(db, { id: "text", model_name: "private-text", config_json: JSON.stringify({ model_type: "text" }) });
    seedModel(db, { id: "image", model_name: "private-image", billing_unit: "call", price_per_call: 1 });
    const group = await offer("text", "text", "gpt-4o");
    await offer("image", "image", "gpt-4o");
    if (selection === "fixed") db.sql("DELETE FROM service_group_models WHERE service_group_id=?", group.id);
    db.sql("UPDATE devices SET service_group_id=?", selection === "fixed" ? group.id : "auto");
    db.sql("UPDATE models SET model_name='gpt-4o'");
    const result = await request("/openapi.json"); expect(result.response.status).toBe(200);
    const schemas = JSON.parse(result.text).components.schemas;
    for (const name of ["ChatCompletionRequest", "EmbeddingRequest"]) {
      expect(schemas[name].properties.model.enum).toBeUndefined();
      expect(schemas[name].properties.model.example).toBeUndefined();
    }
  });
  it("retains sanitized text type for call billing without publishing private configuration", async () => {
    seedModel(db, { id: "text-call", model_name: "private-text-call", billing_unit: "call", price_per_call: 1,
      config_json: JSON.stringify({ model_type: "text", api_key: "hidden-secret", model_rewrite: "private-rewrite" }) });
    await offer("text-call", "text-call", "public-text-call");
    db.sql("UPDATE devices SET service_group_id='auto'");
    const result = await request("/models"); expect(result.response.status).toBe(200);
    const model = JSON.parse(result.text).data.find((row: { id: string }) => row.id === "public-text-call");
    expect(model).toMatchObject({ model_type: "text", billing_unit: "call", chat_endpoint: "/v1/chat/completions" });
    const detail = await request("/models/public-text-call");
    expect(JSON.parse(detail.text)).toMatchObject({ model_type: "text", chat_endpoint: "/v1/chat/completions" });
    const spec = JSON.parse((await request("/openapi.json")).text);
    expect(spec.components.schemas.ChatCompletionRequest.properties.model.enum).toContain("public-text-call");
    expect(result.text + detail.text + JSON.stringify(spec)).not.toMatch(/hidden-secret|private-rewrite/);
  });
});

describe("explicit free image requests keep the existing no-replay and billing contracts", () => {
  it.each(["legacy", "fixed", "auto"] as const)("allows explicit free images with zero or stale positive prices in %s selection", async selection => {
    seedModel(db, { id: "free", model_name: "free-source", pricing_mode: "free", billing_unit: "call", price_per_call: 0 });
    seedModel(db, { id: "paid", model_name: "paid-source", billing_unit: "call", price_per_call: 2 });
    const free = await offer("free", "free", "public-image"); await offer("paid", "paid", "public-image");
    db.sql("UPDATE devices SET service_group_id=?", selection === "fixed" ? free.id : selection);
    const key = selection === "legacy" ? "free-source" : "public-image";
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)).model);
      return Response.json({ created: 1, data: [{ url: "https://cdn.test/image.png" }], model: "private-image" });
    });
    for (const price of [0, 999]) {
      db.sql("UPDATE models SET price_per_call=? WHERE id='free'", price);
      const result = await request("/images/generations", TOKEN, { model: key, prompt: "tree" });
      expect(result.response.status).toBe(200); expect(JSON.parse(result.text).model).toBe(key);
    }
    expect(calls).toEqual(["free-source", "free-source"]);
    const rows = db.rows<{ cost_usd: number; pricing_missing: number; service_group_id: string | null }>("SELECT * FROM usage");
    expect(rows).toHaveLength(2); for (const row of rows) expect(row).toMatchObject({ cost_usd: 0, pricing_missing: 0, service_group_id: selection === "legacy" ? null : free.id });
    expect(wallet(db)?.balance_usd).toBe(100); expect(wallet(db)?.reserved_usd).toBe(0); expect(holdRows(db)).toEqual([]);
    expect((await request("/images/generations", TOKEN, { model: key, prompt: "tree", n: 5 })).response.status).toBe(400);
    expect((await request("/images/generations", TOKEN, { model: key, prompt: "tree", stream: true })).response.status).toBe(400);
    expect(calls).toHaveLength(2);
    vi.mocked(globalThis.fetch).mockImplementation(async () => { calls.push("refused"); return new Response("busy", { status: 503 }); });
    expect((await request("/images/generations", TOKEN, { model: key, prompt: "tree" })).response.status).toBe(502);
    expect(calls).toHaveLength(3); expect(wallet(db)?.balance_usd).toBe(100); expect(holdRows(db)).toEqual([]);
  });
  it.each(["legacy", "fixed", "auto"] as const)("does not reinterpret priced-zero or unset as free in %s selection", async selection => {
    seedModel(db, { id: "image", model_name: "image-source", billing_unit: "call", price_per_call: 0 });
    const group = await offer("image", "image", "public-image");
    db.sql("UPDATE devices SET service_group_id=?", selection === "fixed" ? group.id : selection);
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const mode of ["priced", "unset"] as PricingMode[]) {
      db.sql("UPDATE models SET pricing_mode=? WHERE id='image'", mode);
      const result = await request("/images/generations", TOKEN, { model: selection === "legacy" ? "image-source" : "public-image", prompt: "tree" });
      expect(result.response.status).toBeGreaterThanOrEqual(400);
      if (mode === "priced") expect(JSON.parse(result.text).error).toBe("model_pricing_missing");
    }
    expect(fetch).not.toHaveBeenCalled(); expect(holdRows(db)).toEqual([]); expect(wallet(db)?.balance_usd).toBe(100);
  });
});
