import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, makeEnv, seedDevice, seedModel, seedProvider } from "./helpers/realGatewayEnv";
import { isAutoServiceSelection, projectServiceModels, resolveAutoServiceRoutes, resolveServiceRoute } from "../src/gateway/service_groups";
import { ensureSchema } from "../src/db/schema";
import type { ModelProjectionRow } from "../src/db/repo";
import type { DeviceRow, Env } from "../src/types";

vi.mock("../src/gateway/index", () => ({ gatewayApp: {} }));

let d: RealD1, env: Env;
const device = () => d.row<DeviceRow>("SELECT * FROM devices WHERE id = ?", DEVICE_ID)!;
function offer(id: string, model: string, key = "canonical", options: { selectable?: number; enabled?: number; public?: number; multiplier?: number; members?: string[] } = {}) {
  d.sql("INSERT INTO service_groups(id,name,enabled,selectable,public_selectable,multiplier,revision) VALUES(?,?,?,?,?,?,1)",
    id, id, options.enabled ?? 1, options.selectable ?? 1, options.public ?? 1, options.multiplier ?? 1);
  d.sql("INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id,member_ids_json) VALUES(?,?,?,'model',?,?)",
    "map-" + id, id, key, model, options.members ? JSON.stringify(options.members) : null);
}
beforeEach(async () => {
  d = createRealD1(); env = makeEnv(d); await seedDevice(d); await ensureSchema(env); d.sql("UPDATE devices SET service_group_id='auto'"); seedProvider(d);
  seedModel(d, { id: "base", model_name: "legacy-name", input_price_per_m: 3, output_price_per_m: 9 });
});
afterEach(() => { vi.restoreAllMocks(); d.close(); });

describe("Auto service selection", () => {
  it("uses nullish inheritance, explicit auto overrides fixed, and anonymous stays legacy", async () => {
    expect(isAutoServiceSelection(device())).toBe(true);
    expect(isAutoServiceSelection({ ...device(), service_group_id: null, default_service_group_id: null })).toBe(false);
    expect(isAutoServiceSelection({ ...device(), service_group_id: "legacy", default_service_group_id: "auto" })).toBe(false);
    expect(isAutoServiceSelection({ ...device(), service_group_id: null, default_service_group_id: "fixed" })).toBe(false);
    expect(isAutoServiceSelection({ ...device(), service_group_id: "auto", default_service_group_id: "fixed" })).toBe(true);
    expect(isAutoServiceSelection(null)).toBe(false);
    expect(await resolveAutoServiceRoutes(env, null, "canonical")).toEqual([]);
    expect(await resolveServiceRoute(env, null, "canonical")).toBeNull();
    const legacy = [] as ModelProjectionRow[];
    expect(await projectServiceModels(env, null, legacy)).toBe(legacy);
  });

  it("orders token offers by effective input then output and treats free as zero, excluding unset", async () => {
    seedModel(d, { id: "cheap", input_price_per_m: 2, output_price_per_m: 8 });
    seedModel(d, { id: "tie", input_price_per_m: 2, output_price_per_m: 5 });
    seedModel(d, { id: "free", pricing_mode: "free", input_price_per_m: 999 });
    seedModel(d, { id: "unset", pricing_mode: "unset" });
    offer("base", "base"); offer("cheap", "cheap"); offer("tie", "tie"); offer("free", "free"); offer("unset", "unset");
    expect((await resolveAutoServiceRoutes(env, device(), "canonical")).map(r => r.group.id)).toEqual(["free", "tie", "cheap", "base"]);
    expect((await resolveServiceRoute(env, device(), "canonical"))?.group.id).toBe("free");
    expect(await resolveServiceRoute(env, device(), "other-legacy-model")).toBeNull();
  });

  it("uses canUse authorization and selectable/enabled plus target scope and buildRoute checks", async () => {
    offer("valid", "base"); offer("hidden", "base", "canonical", { selectable: 0 });
    offer("disabled", "base", "canonical", { enabled: 0 }); offer("private", "base", "canonical", { public: 0 });
    seedModel(d, { id: "denied", model_public: 0 }); offer("denied", "denied");
    seedModel(d, { id: "incompatible", billing_unit: "call" });
    offer("bad-members", "base", "canonical", { members: ["incompatible"] });
    d.sql("UPDATE devices SET model_scope='list' WHERE id=?", DEVICE_ID);
    d.sql("INSERT INTO device_models(device_id,model_id) VALUES(?,'base')", DEVICE_ID);
    await expect(resolveAutoServiceRoutes(env, device(), "canonical")).rejects.toMatchObject({ status: 503 });
    d.sql("INSERT INTO device_service_groups(device_id,service_group_id) VALUES(?,'private')", DEVICE_ID);
    await expect(resolveAutoServiceRoutes(env, device(), "canonical")).rejects.toMatchObject({ status: 503 });
  });

  it("freezes peak windows at one common instant and leaves base invoice prices unscaled", async () => {
    seedModel(d, { id: "peak", input_price_per_m: 1, output_price_per_m: 1, peak_pricing_enabled: 1 });
    seedModel(d, { id: "peak2", input_price_per_m: 1, output_price_per_m: 2, peak_pricing_enabled: 1 });
    offer("peak", "peak"); offer("peak2", "peak2"); offer("normal", "base");
    d.sql("INSERT INTO price_windows(id,model_id,day_type,start_minute,end_minute,multiplier,enabled) VALUES('w','peak','mon',0,1440,5,1)");
    d.sql("INSERT INTO price_windows(id,model_id,day_type,start_minute,end_minute,multiplier,enabled) VALUES('w2','peak2','mon',0,1440,4,1)");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 2, 4));
    const routes = await resolveAutoServiceRoutes(env, device(), "canonical");
    expect(routes.map(r => r.group.id)).toEqual(["normal", "peak2", "peak"]);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(routes[2].autoPriceSnapshot).toEqual({ multiplier: 5, window_id: "w" });
    expect(Object.isFrozen(routes[2].autoPriceSnapshot)).toBe(true);
    expect(routes[2].billingRow.input_price_per_m).toBe(1);
  });

  it("ranks per-call offers independently and rejects mixed units with HTTP400", async () => {
    seedModel(d, { id: "call1", billing_unit: "call", price_per_call: 0.5 });
    seedModel(d, { id: "call2", billing_unit: "call", price_per_call: 0.1 });
    offer("call1", "call1"); offer("call2", "call2");
    expect((await resolveAutoServiceRoutes(env, device(), "canonical")).map(r => r.group.id)).toEqual(["call2", "call1"]);
    offer("token", "base");
    await expect(resolveAutoServiceRoutes(env, device(), "canonical")).rejects.toMatchObject({ status: 400, message: expect.stringContaining("mixed token and call billing units") });
  });

  it("projects cheapest canonical offers while preserving differently named legacy target IDs without credential leakage", async () => {
    offer("expensive", "base", "canonical", { multiplier: 2 }); offer("cheap", "base");
    d.sql("UPDATE models SET config_json=? WHERE id='base'", JSON.stringify({ api_key: "hidden-credential", model_rewrite: "private-name" }));
    const legacy = [{ id: "base", model_name: "legacy-name", alias: null }, { id: "shadow", model_name: "canonical", alias: null }] as ModelProjectionRow[];
    const load = vi.fn(async () => legacy);
    const rows = await projectServiceModels(env, device(), load);
    expect(rows.map(row => row.model_name)).toEqual(["canonical", "legacy-name"]);
    expect(rows[0].input_price_per_m).toBe(3);
    expect(rows[0]).toMatchObject({ provider_api_key: null, provider_secret_name: null, provider_endpoint: null, config_json: null });
    expect(JSON.stringify(rows)).not.toMatch(/sk-a|hidden-credential|private-name/);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shares one route data load for offers and queries only the exact requested model key", async () => {
    for (let i = 0; i < 12; i++) offer("group" + i, "base");
    const prepare = vi.spyOn(env.DB, "prepare");
    expect(await resolveAutoServiceRoutes(env, device(), "canonical")).toHaveLength(12);
    const sql = prepare.mock.calls.map(([query]) => String(query));
    expect(sql.filter(query => query.includes("FROM service_group_models"))).toHaveLength(1);
    expect(sql.find(query => query.includes("FROM service_group_models"))).toMatch(/model_key\s*=/);
    expect(sql.find(query => query.includes("FROM service_group_models"))).toContain("service_group_id IN");
    expect(sql.filter(query => query.includes("FROM models m JOIN providers p"))).toHaveLength(1);
  });

  it("keeps fixed selection confined and fails closed, never loading legacy", async () => {
    offer("fixed", "base");
    const selected = { ...device(), service_group_id: "fixed" };
    expect(await resolveAutoServiceRoutes(env, selected, "canonical")).toEqual([]);
    expect((await resolveServiceRoute(env, selected, "canonical"))?.autoPriceSnapshot).toBeUndefined();
    await expect(resolveServiceRoute(env, selected, "absent")).rejects.toMatchObject({ status: 404 });
    const legacy = vi.fn(async () => []);
    expect(await projectServiceModels(env, selected, legacy)).toHaveLength(1);
    expect(legacy).not.toHaveBeenCalled();
  });
});
