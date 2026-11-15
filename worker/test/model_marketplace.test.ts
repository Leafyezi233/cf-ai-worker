import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consoleApp } from "../src/console";
import * as repo from "../src/db/repo";
import * as cryptoUtils from "../src/utils/crypto";
import {
  createServiceGroup,
  setDeviceServiceGroups,
  updateServiceGroup,
  upsertServiceGroupModel,
} from "../src/db/service_groups";
import type { ServiceGroupInput, ServiceGroupModelInput } from "../src/db/service_groups";
import type { Env } from "../src/types";
import { sha256Hex } from "../src/utils/crypto";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import {
  DEVICE_ID, TOKEN, makeEnv, seedDevice, seedDeviceGroups, seedDeviceModels,
  seedGroup, seedGroupMembers, seedModel, seedProvider,
} from "./helpers/realGatewayEnv";

interface Offer {
  id: string;
  model_name: string;
  service_group_id: string | null;
  service_group_name: string;
  is_current: boolean;
  pricing_mode: "free" | "priced" | "unset";
  input_price_per_m: number;
  output_price_per_m: number;
  [key: string]: unknown;
}

let d1: RealD1;
let env: Env;

beforeEach(async () => {
  d1 = createRealD1();
  env = makeEnv(d1);
  await seedDevice(d1);
  seedProvider(d1);
  seedModel(d1, { id: "original", model_name: "shared-model", search_price_per_call: 0.7 });
  seedModel(d1, { id: "internal", model_name: "private-upstream-model", model_public: 0 });
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });

function group(name: string, extra: Partial<ServiceGroupInput> = {}) {
  return createServiceGroup(env, { name, public_selectable: 1, ...extra });
}
function map(groupId: string, extra: Partial<ServiceGroupModelInput> = {}) {
  return upsertServiceGroupModel(env, groupId, {
    model_key: "shared-model", target_type: "model", target_id: "original",
    member_ids_json: JSON.stringify(["internal"]), ...extra,
  });
}
function assign(selected: string | null, fallback: string | null = null) {
  d1.sql("UPDATE devices SET service_group_id = ?, default_service_group_id = ? WHERE id = ?",
    selected, fallback, DEVICE_ID);
}
async function subToken(id: string, selected: string | null = null) {
  const token = "marketplace-token-" + id;
  d1.sql("INSERT INTO device_sub_tokens (id, device_id, name, token_hash, enabled, created_at, service_group_id) VALUES (?, ?, ?, ?, 1, 1, ?)",
    id, DEVICE_ID, id, await sha256Hex(token), selected);
  return token;
}
function request(path = "/model-marketplace", token: string | null = TOKEN, headers: Record<string, string> = {}) {
  return consoleApp.request("https://gw.test" + path, {
    headers: { ...(token === null ? {} : { authorization: "Bearer " + token }), ...headers },
  }, env);
}
async function offers(token = TOKEN): Promise<Offer[]> {
  const res = await request("/model-marketplace", token);
  expect(res.status).toBe(200);
  const body = await res.json() as { items: Offer[] };
  expect(Array.isArray(body.items)).toBe(true);
  for (const item of body.items) {
    expect(item.service_group_id === null || typeof item.service_group_id === "string").toBe(true);
    expect(typeof item.service_group_name).toBe("string");
    expect(typeof item.is_current).toBe("boolean");
    expect(["free", "priced", "unset"]).toContain(item.pricing_mode);
    expect(item).not.toHaveProperty("items");
  }
  return body.items;
}
function groupIds(items: Offer[]) {
  return [...new Set(items.map(item => item.service_group_id))];
}
function credentials() {
  return {
    devices: d1.rows("SELECT * FROM devices ORDER BY id"),
    subTokens: d1.rows("SELECT * FROM device_sub_tokens ORDER BY id"),
    modelGrants: d1.rows("SELECT * FROM device_models ORDER BY device_id, model_id"),
    groupGrants: d1.rows("SELECT * FROM device_model_groups ORDER BY device_id, group_id"),
    serviceGrants: d1.rows("SELECT * FROM device_service_groups ORDER BY device_id, service_group_id"),
  };
}

describe("GET /console/model-marketplace", () => {
  it.each([null, "not-a-valid-token"])("requires a valid token (%s)", async token => {
    expect((await request("/model-marketplace", token)).status).toBe(401);
  });

  it.each(["disabled", "revoked"])("rejects a %s account", async mode => {
    d1.sql(mode === "disabled" ? "UPDATE devices SET enabled = 0" : "UPDATE devices SET revoked_at = 1");
    expect((await request()).status).toBe(401);
  });

  it("accepts x-api-key authentication without exposing anonymous offers", async () => {
    const selected = await group("selected"); await map(selected.id); assign(selected.id);
    const res = await request("/model-marketplace", null, { "x-api-key": TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [{ service_group_id: selected.id, is_current: true }] });
  });

  it("keeps same-name offers separate by group and price while /models remains token-selected", async () => {
    const cheap = await group("cheap", { multiplier: 0.5 });
    const premium = await group("premium", { multiplier: 20 });
    await map(cheap.id);
    await map(premium.id, { pricing_json: JSON.stringify({ input_price_per_m: 8, output_price_per_m: 12 }) });
    assign(cheap.id);

    const items = await offers();
    expect(items).toHaveLength(2);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ model_name: "shared-model", service_group_id: cheap.id, service_group_name: "cheap",
        input_price_per_m: 1.5, output_price_per_m: 7.5, search_price_per_call: 0.7, pricing_mode: "priced", is_current: true }),
      expect.objectContaining({ model_name: "shared-model", service_group_id: premium.id, service_group_name: "premium",
        input_price_per_m: 8, output_price_per_m: 12, pricing_mode: "priced", is_current: false }),
    ]));
    const res = await request("/models");
    expect(res.status).toBe(200);
    const selected = await res.json() as { items: Record<string, unknown>[] };
    expect(selected.items).toHaveLength(1);
    expect(selected.items[0]).toMatchObject({ model_name: "shared-model", input_price_per_m: 1.5 });
    for (const [key, value] of Object.entries(selected.items[0])) {
      expect(items.find(item => item.service_group_id === cheap.id)?.[key]).toEqual(value);
    }
  });

  it("includes public and granted groups, but not private, disabled or noncurrent nonselectable groups", async () => {
    const publicGroup = await group("public");
    const granted = await group("granted", { public_selectable: 0 });
    const privateGroup = await group("private", { public_selectable: 0 });
    const disabled = await group("disabled", { enabled: 0 });
    const hidden = await group("hidden", { selectable: 0 });
    for (const row of [publicGroup, granted, privateGroup, disabled, hidden]) await map(row.id);
    await setDeviceServiceGroups(env, DEVICE_ID, [granted.id, disabled.id]);
    assign(publicGroup.id);
    expect(groupIds(await offers()).sort()).toEqual([publicGroup.id, granted.id].sort());
  });

  it("keeps an authorized current nonselectable group visible, but does not mark other groups current", async () => {
    const current = await group("retired", { public_selectable: 0, selectable: 0 });
    const available = await group("available");
    await map(current.id); await map(available.id);
    await setDeviceServiceGroups(env, DEVICE_ID, [current.id]); assign(current.id);
    const items = await offers();
    expect(items).toHaveLength(2);
    expect(items.filter(item => item.is_current).map(item => item.service_group_id)).toEqual([current.id]);
  });

  it("withdraws private offers immediately after grant removal even when the group is selected", async () => {
    const privateGroup = await group("private", { public_selectable: 0 });
    const publicGroup = await group("public");
    await map(privateGroup.id); await map(publicGroup.id);
    await setDeviceServiceGroups(env, DEVICE_ID, [privateGroup.id]); assign(privateGroup.id);
    expect(groupIds(await offers()).sort()).toEqual([privateGroup.id, publicGroup.id].sort());
    await setDeviceServiceGroups(env, DEVICE_ID, []);
    const items = await offers();
    expect(groupIds(items)).toEqual([publicGroup.id]);
    expect(items.every(item => !item.is_current)).toBe(true);
  });

  it.each(["missing", "disabled", "unauthorized"])("allows browsing valid groups with a %s selected group", async mode => {
    const valid = await group("valid"); await map(valid.id);
    const invalid = await group("invalid", { public_selectable: mode === "unauthorized" ? 0 : 1 });
    await map(invalid.id); assign(invalid.id);
    if (mode === "missing") d1.sql("DELETE FROM service_groups WHERE id = ?", invalid.id);
    if (mode === "disabled") await updateServiceGroup(env, invalid.id, { enabled: 0 });
    const items = await offers();
    expect(groupIds(items)).toEqual([valid.id]);
    expect(items.every(item => !item.is_current)).toBe(true);
  });

  it("marks the master override and preserves Console rejection of inherited or explicit subtokens", async () => {
    const fallback = await group("default"), master = await group("master"), explicit = await group("sub");
    for (const row of [fallback, master, explicit]) await map(row.id);
    assign(master.id, fallback.id);
    const inheritedToken = await subToken("inherit");
    const explicitToken = await subToken("explicit", explicit.id);
    const items = await offers();
    expect(items).toHaveLength(3);
    expect(items.filter(item => item.is_current).map(item => item.service_group_id)).toEqual([master.id]);
    for (const token of [inheritedToken, explicitToken]) {
      expect((await request("/model-marketplace", token)).status).toBe(403);
    }
  });

  it("includes legacy null-group offers only when no effective group is assigned", async () => {
    const available = await group("available"); await map(available.id);
    const items = await offers();
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ model_name: "shared-model", service_group_id: null, is_current: true }),
      expect.objectContaining({ model_name: "shared-model", service_group_id: available.id, is_current: false }),
    ]));
    expect(items.filter(item => item.service_group_id === null).length).toBeGreaterThan(0);
    assign(available.id);
    expect((await offers()).every(item => item.service_group_id !== null)).toBe(true);
  });

  it("intersects original model scope rather than authorizing a target through its internal member", async () => {
    const available = await group("available"); await map(available.id); assign(available.id);
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID);
    seedDeviceModels(d1, ["internal"]);
    expect(await offers()).toEqual([]);
    seedDeviceModels(d1, ["original"]);
    expect(await offers()).toMatchObject([{ model_name: "shared-model", service_group_id: available.id }]);
  });

  it("requires the original model-group grant, not internal model grants, for group targets", async () => {
    seedGroup(d1, { id: "original-group", name: "group-model", model_public: 0 });
    seedGroupMembers(d1, "original-group", ["internal"]);
    const available = await group("available");
    await map(available.id, { model_key: "group-model", target_type: "group", target_id: "original-group", member_ids_json: null });
    assign(available.id);
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID);
    seedDeviceModels(d1, ["internal"]);
    expect(await offers()).toEqual([]);
    seedDeviceGroups(d1, ["original-group"]);
    expect(await offers()).toMatchObject([{ model_name: "group-model", service_group_id: available.id }]);
  });

  it("preserves explicit free and unset pricing modes without treating numeric zero as free", async () => {
    const available = await group("available", { multiplier: 0 }); assign(available.id);
    for (const mode of ["free", "unset", "priced"] as const) {
      seedModel(d1, { id: mode, model_name: mode + "-model", pricing_mode: mode });
      await map(available.id, { model_key: mode + "-model", target_id: mode, member_ids_json: null });
    }
    const items = await offers();
    expect(items).toHaveLength(3);
    for (const mode of ["free", "unset", "priced"] as const) {
      expect(items.find(item => item.model_name === mode + "-model")).toMatchObject({ pricing_mode: mode });
    }
    expect(items.find(item => item.pricing_mode === "priced")).toMatchObject({ input_price_per_m: 0, output_price_per_m: 0 });
  });

  it("omits unavailable mappings without suppressing the valid offer in the same group", async () => {
    const available = await group("available"); assign(available.id); await map(available.id);
    seedModel(d1, { id: "disabled-target", enabled: 0 });
    seedProvider(d1, { id: "disabled-provider" });
    d1.sql("UPDATE providers SET enabled = 0 WHERE id = 'disabled-provider'");
    seedModel(d1, { id: "disabled-provider-target", provider_id: "disabled-provider" });
    const corrupt = (id: string, modelKey: string, targetId: string, members: string | null = JSON.stringify(["internal"]), pricing: string | null = null) =>
      d1.sql("INSERT INTO service_group_models (id, service_group_id, model_key, target_type, target_id, pricing_json, member_ids_json) VALUES (?, ?, ?, 'model', ?, ?, ?)",
        id, available.id, modelKey, targetId, pricing, members);
    corrupt("bad-missing", "missing-target", "missing");
    corrupt("bad-disabled", "disabled-target", "disabled-target");
    corrupt("bad-provider", "disabled-provider-target", "disabled-provider-target");
    corrupt("bad-empty-members", "empty-members", "original", "[]");
    corrupt("bad-missing-members", "missing-members", "original", JSON.stringify(["missing"]));
    corrupt("bad-members", "bad-members", "original", "{broken");
    corrupt("bad-price", "bad-price", "original", JSON.stringify(["internal"]), JSON.stringify({ input_price_per_m: -1 }));
    expect(await offers()).toMatchObject([{ model_name: "shared-model" }]);
  });

  it("rejects new mappings with missing targets or empty/unknown members", async () => {
    const missingTarget = await group("missing-target");
    await expect(upsertServiceGroupModel(env, missingTarget.id, {
      model_key: "missing-target", target_type: "model", target_id: "does-not-exist",
      member_ids_json: JSON.stringify(["internal"]),
    })).rejects.toThrow();

    const emptyMember = await group("empty-member");
    await expect(upsertServiceGroupModel(env, emptyMember.id, {
      model_key: "empty-member", target_type: "model", target_id: "original",
      member_ids_json: JSON.stringify([""]),
    })).rejects.toThrow();

    const unknownMember = await group("unknown-member");
    await expect(upsertServiceGroupModel(env, unknownMember.id, {
      model_key: "unknown-member", target_type: "model", target_id: "original",
      member_ids_json: JSON.stringify(["does-not-exist"]),
    })).rejects.toThrow();
  });

  it("publishes only safe console fields, never opens keys or fetches upstreams, and does not mutate credentials", async () => {
    const available = await group("available"); await map(available.id); assign(available.id);
    const token = await subToken("reader");
    d1.sql("UPDATE providers SET api_key = 'SEALED_PROVIDER_KEY', secret_name = 'PRIVATE_BINDING', endpoint = 'https://private-upstream.invalid/v1', config_json = ?",
      JSON.stringify({ authorization: "provider-config-secret" }));
    d1.sql("UPDATE models SET config_json = ? WHERE id = 'original'",
      JSON.stringify({ description: "Safe model introduction", headers: { Authorization: "model-config-secret" } }));
    const before = credentials();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("marketplace must not fetch"));
    const openModel = vi.spyOn(repo, "openModelKey");
    const openMember = vi.spyOn(repo, "openGroupMemberKey");
    const openSecret = vi.spyOn(cryptoUtils, "openSecret");
    const items = await offers();
    expect((await request("/model-marketplace", token)).status).toBe(403);
    expect(items[0]).toMatchObject({ description: "Safe model introduction" });
    const serialized = JSON.stringify(items);
    for (const secret of ["SEALED_PROVIDER_KEY", "PRIVATE_BINDING", "private-upstream.invalid", "provider-config-secret", "model-config-secret", "private-upstream-model", TOKEN, token]) {
      expect(serialized).not.toContain(secret);
    }
    for (const field of ["provider_id", "provider_name", "provider_type", "provider_endpoint", "provider_api_key", "provider_secret_name", "api_key", "secret_name", "endpoint", "config_json", "member_ids_json", "pricing_json", "token_hash"]) {
      expect(items[0]).not.toHaveProperty(field);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openModel).not.toHaveBeenCalled();
    expect(openMember).not.toHaveBeenCalled();
    expect(openSecret).not.toHaveBeenCalled();
    expect(credentials()).toEqual(before);
  });
});
