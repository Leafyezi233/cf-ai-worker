import { afterEach, describe, expect, it } from "vitest";
import { modelsApp } from "../src/admin/models";
import { buildDshProfile } from "../../web/src/utils/modelConfigExport";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedGroup, seedGroupMembers, seedModel, seedProvider } from "./helpers/realGatewayEnv";

const databases: RealD1[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("admin capability catalog", () => {
  it("keeps protocol and billing filters authoritative through actual catalog-to-DSH export", async () => {
    const db = createRealD1(); databases.push(db);
    seedProvider(db); seedProvider(db, { id: "anthropic", type: "anthropic" });
    const config_json = JSON.stringify({ context_window: 64000, max_output_tokens: 8000, chat_endpoint: "/v1/chat/completions", billing_unit: "token" });
    seedModel(db, { id: "chat", model_name: "chat", config_json });
    seedModel(db, { id: "messages", provider_id: "anthropic", model_name: "messages", config_json });
    seedModel(db, { id: "images", model_name: "images", billing_unit: "call", config_json });
    const response = await modelsApp.request("http://admin.test/catalog", {}, makeEnv(db));
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.models.find((m: any) => m.slug === "messages").chat_endpoint).toBe("/v1/messages");
    expect(body.models.find((m: any) => m.slug === "images")).toMatchObject({ billing_unit: "call", chat_endpoint: "/v1/images/generations" });
    const result = buildDshProfile(body.models, "https://gateway.test/v1");
    expect(result.config.providers["cpg-gateway"].models.map(m => m.id)).toEqual(["chat"]);
    expect(result.skipped.map(m => m.id).sort()).toEqual(["images", "messages"]);
  });
  it.each(["/catalog", "/catalog/export"])("includes private models and servable private groups on %s without credentials", async (path) => {
    const db = createRealD1(); databases.push(db);
    seedProvider(db, { api_key: "private-provider-secret" });
    seedModel(db, { model_name: "private-model", model_public: 0, config_json: JSON.stringify({ context_window: 64000, max_output_tokens: 8000, api_key: "private-config-secret" }) });
    seedGroup(db, { name: "private-group", model_public: 0 });
    seedGroupMembers(db, "grp_a", ["model_a"]);
    seedGroup(db, { id: "empty", name: "empty-group", model_public: 0 });
    const response = await modelsApp.request("http://admin.test" + path, {}, makeEnv(db));
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text);
    const model = body.models.find((item: any) => item.slug === "private-model");
    const group = body.models.find((item: any) => item.slug === "private-group");
    expect(model.context_window).toBe(64000);
    expect(model.max_output_tokens).toBe(8000);
    expect(group.context_window).toBe(64000);
    expect(group.max_output_tokens).toBe(8000);
    expect(body.models.some((item: any) => item.slug === "empty-group")).toBe(false);
    expect(text).not.toContain("private-provider-secret");
    expect(text).not.toContain("private-config-secret");
    if (path.endsWith("export")) expect(response.headers.get("Content-Disposition")).toContain("model-catalog.json");
  });
});
