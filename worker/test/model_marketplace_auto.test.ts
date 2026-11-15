import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consoleApp } from "../src/console";
import * as repo from "../src/db/repo";
import { createServiceGroup, setDeviceServiceGroups, upsertServiceGroupModel } from "../src/db/service_groups";
import type { ServiceGroupInput, ServiceGroupModelInput } from "../src/db/service_groups";
import type { Env } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, TOKEN, makeEnv, seedDevice, seedDeviceModels, seedGroup, seedGroupMembers, seedModel, seedProvider } from "./helpers/realGatewayEnv";

let d1: RealD1;
let env: Env;
const canonical = "DeepSeek-V41-flash";
beforeEach(async () => {
  d1 = createRealD1(); env = makeEnv(d1);
  await seedDevice(d1); seedProvider(d1);
  seedModel(d1, { id: "egg-id", model_name: "egg" });
  seedModel(d1, { id: "flash-id", model_name: "flash-l" });
  seedModel(d1, { id: "claude-id", model_name: "Claude" });
  seedModel(d1, { id: "gemini-id", model_name: "Gemini" });
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });
const group = (name: string, extra: Partial<ServiceGroupInput> = {}) =>
  createServiceGroup(env, { name, public_selectable: 1, ...extra });
const mapping = (groupId: string, targetId = "egg-id", extra: Partial<ServiceGroupModelInput> = {}) =>
  upsertServiceGroupModel(env, groupId, { model_key: canonical, target_type: "model", target_id: targetId, ...extra });
function select(selected: string | null, fallback: string | null = null) {
  d1.sql("UPDATE devices SET service_group_id = ?, default_service_group_id = ? WHERE id = ?", selected, fallback, DEVICE_ID);
}
async function market() {
  const res = await consoleApp.request("https://gw.test/model-marketplace", { headers: { authorization: "Bearer " + TOKEN } }, env);
  expect(res.status).toBe(200);
  return await res.json() as { model_count: number; items: Array<{ id: string; model_name: string; service_group_id: string | null; is_current: boolean; input_price_per_m: number }> };
}
function state() {
  return ["devices", "device_sub_tokens", "device_models", "device_model_groups", "device_service_groups"]
    .map(table => d1.rows("SELECT * FROM " + table));
}

describe("marketplace auto quote comparison", () => {
  it.each([null, "auto"])("replaces only mapped target cards in %s mode, preserving every quote and unrelated legacy", async selected => {
    const cheap = await group("cheap", { multiplier: 0.5 });
    const premium = await group("premium", { multiplier: 2 });
    await mapping(cheap.id); await mapping(premium.id, "flash-id");
    select(selected);
    const before = state();
    const runtime = vi.spyOn(repo, "listModelProjectionsForDevice").mockRejectedValue(new Error("not a raw catalogue"));
    const body = await market();
    expect(body.model_count).toBe(body.items.length);
    expect([...new Set(body.items.map(item => item.model_name))].sort()).toEqual(["Claude", "Gemini", canonical].sort());
    expect(body.items.filter(item => item.model_name === canonical)).toEqual(expect.arrayContaining([
      expect.objectContaining({ service_group_id: cheap.id, input_price_per_m: 1.5, is_current: false }),
      expect.objectContaining({ service_group_id: premium.id, input_price_per_m: 6, is_current: false }),
    ]));
    expect(body.items.filter(item => item.service_group_id !== null).every(item => !item.is_current)).toBe(true);
    expect(runtime).not.toHaveBeenCalled(); expect(state()).toEqual(before);
  });

  it("retains an original canonical legacy quote and unmapped legacy even when names contain the canonical key", async () => {
    seedModel(d1, { id: "canonical-id", model_name: canonical });
    seedModel(d1, { id: "similar-id", model_name: canonical + "-unmapped" });
    const available = await group("available"); await mapping(available.id);
    const { items } = await market();
    expect(items.filter(item => item.service_group_id === null).map(item => item.id).sort())
      .toEqual(["canonical-id", "similar-id", "flash-id", "claude-id", "gemini-id"].sort());
    expect(items.filter(item => item.model_name === canonical)).toHaveLength(2);
  });

  it.each(["private", "disabled", "nonselectable", "empty-members", "bad-price", "bad-config"])("does not hide legacy for an unavailable %s mapping", async mode => {
    const available = await group("unavailable", {
      public_selectable: mode === "private" ? 0 : 1,
      enabled: mode === "disabled" ? 0 : 1,
      selectable: mode === "nonselectable" ? 0 : 1,
    });
    await mapping(available.id, "egg-id", {
      ...(mode === "empty-members" ? { member_ids_json: "[]" } : {}),
      ...(mode === "bad-price" ? { pricing_json: '{"input_price_per_m":-1}' } : {}),
    });
    if (mode === "bad-config") d1.sql("UPDATE models SET config_json = '{broken' WHERE id = 'egg-id'");
    const { items } = await market();
    expect(items.some(item => item.id === "egg-id" && item.service_group_id === null)).toBe(true);
    expect(items.some(item => item.model_name === canonical)).toBe(false);
  });

  it("applies grant revocation immediately, retaining raw legacy when the replacement disappears", async () => {
    const granted = await group("granted", { public_selectable: 0 }); await mapping(granted.id);
    await setDeviceServiceGroups(env, DEVICE_ID, [granted.id]);
    expect((await market()).items.some(item => item.model_name === "egg")).toBe(false);
    await setDeviceServiceGroups(env, DEVICE_ID, []);
    expect((await market()).items.some(item => item.model_name === "egg")).toBe(true);
  });

  it("requires original-target scope and cannot hide a same-name different-ID legacy row", async () => {
    seedModel(d1, { id: "other-egg", model_name: "egg" });
    const available = await group("available"); await mapping(available.id);
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID);
    seedDeviceModels(d1, ["other-egg"]);
    expect((await market()).items).toMatchObject([{ id: "other-egg", model_name: "egg", service_group_id: null }]);
    seedDeviceModels(d1, ["other-egg", "egg-id"]);
    const { items } = await market();
    expect(items.some(item => item.id === "other-egg" && item.service_group_id === null)).toBe(true);
    expect(items.some(item => item.id === "egg-id" && item.service_group_id === null)).toBe(false);
    expect(items.some(item => item.model_name === canonical)).toBe(true);
  });

  it("also replaces original model-group targets by ID without hiding their member model", async () => {
    seedGroup(d1, { id: "egg-id", name: "arbitrary-original" });
    seedGroupMembers(d1, "egg-id", ["egg-id"]);
    const available = await group("available");
    await mapping(available.id, "egg-id", { target_type: "group", model_key: "arbitrary-canonical" });
    const { items } = await market();
    expect(items.some(item => item.model_name === "arbitrary-original")).toBe(false);
    expect(items.some(item => item.model_name === "arbitrary-canonical")).toBe(true);
    expect(items.some(item => item.model_name === "egg" && item.service_group_id === null)).toBe(true);
  });

  it("explicit auto ignores a fixed account default while fixed selection keeps current marking", async () => {
    const first = await group("first"), second = await group("second");
    await mapping(first.id); await mapping(second.id, "flash-id");
    select("auto", first.id);
    expect((await market()).items.filter(item => item.service_group_id !== null).every(item => !item.is_current)).toBe(true);
    select(second.id, first.id);
    const { items } = await market();
    expect(items.every(item => item.service_group_id !== null)).toBe(true);
    expect(items.filter(item => item.is_current).map(item => item.service_group_id)).toEqual([second.id]);
  });
});
