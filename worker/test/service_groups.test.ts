import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import * as repo from "../src/db/repo";
import * as cryptoUtils from "../src/utils/crypto";
import { serviceGroupsApp } from "../src/admin/service-groups";
import { accountApp } from "../src/console/account";
import { resolveDevice } from "../src/gateway/auth";
import { projectServiceModels, resolveServiceRoute } from "../src/gateway/service_groups";
import { createServiceGroup, updateServiceGroup, deleteServiceGroup, upsertServiceGroupModel,
  canUseServiceGroup, listSelectableServiceGroups, resolveEffectiveServiceGroup,
  setDeviceServiceGroups, listServiceGroupModels } from "../src/db/service_groups";
import { buildUserSessionCookie, sha256Hex, signUserSession } from "../src/utils/crypto";
import type { AuthedDevice, Env } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, TOKEN, makeEnv, seedDevice, seedDeviceModels, seedDeviceGroups,
  seedProvider, seedModel, seedGroup, seedGroupMembers } from "./helpers/realGatewayEnv";

let d1: RealD1;
let env: Env;
const SECRET = "service-group-test-session-secret";
beforeEach(async () => {
  d1 = createRealD1();
  d1.DB.batch = async (statements: Array<{ sql: string; all: () => Promise<unknown>; run: () => Promise<unknown> }>) => {
    const results = [];
    for (const statement of statements) results.push(await (/^\s*SELECT/i.test(statement.sql) ? statement.all() : statement.run()));
    return results;
  };
  env = { ...makeEnv(d1), SESSION_SECRET: SECRET };
  await seedDevice(d1);
  d1.sql("UPDATE devices SET password_hash = ?, password_updated_at = 1 WHERE id = ?", await cryptoUtils.hashPassword("fixture-password"), DEVICE_ID);
  seedProvider(d1, { api_key: "sealed-upstream-key-do-not-publish" });
  seedModel(d1, { id: "public", model_name: "public-model", model_public: 1, search_price_per_call: 0.7 });
  seedModel(d1, { id: "internal", model_name: "upstream-fast", model_public: 0 });
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });
function device(): AuthedDevice {
  return { ...d1.row<AuthedDevice>("SELECT * FROM devices WHERE id = ?", DEVICE_ID)!, auth_via: "master", sub_token_id: null };
}
async function service(name = "standard", multiplier = 1) {
  return createServiceGroup(env, { name, multiplier, public_selectable: 1 });
}
async function map(groupId: string, extra: Record<string, unknown> = {}) {
  return upsertServiceGroupModel(env, groupId, { model_key: "public-model", target_type: "model", target_id: "public",
    member_ids_json: JSON.stringify(["internal"]), ...extra });
}
function assign(id: string | null, defaultId: string | null = null) {
  d1.sql("UPDATE devices SET service_group_id = ?, default_service_group_id = ? WHERE id = ?", id, defaultId, DEVICE_ID);
}
function admin(path: string, body?: unknown, method = "PUT") {
  return serviceGroupsApp.request("http://test" + path, { method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }, env);
}
async function subToken(id = "sub-one", owner = DEVICE_ID, groupId: string | null = null) {
  const token = "token-" + id;
  d1.sql("INSERT INTO device_sub_tokens (id, device_id, name, token_hash, enabled, created_at, service_group_id) VALUES (?, ?, ?, ?, 1, 1, ?)",
    id, owner, id, await sha256Hex(token), groupId);
  return token;
}
async function account(path: string, body?: unknown, options: { token?: string; session?: boolean; method?: string } = {}) {
  const cookie = options.session === false ? "" : buildUserSessionCookie(await signUserSession(SECRET, DEVICE_ID, 1)).split(";")[0];
  return accountApp.request("http://test" + path, { method: options.method ?? "PUT", headers: {
    authorization: "Bearer " + (options.token ?? TOKEN), cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }, env);
}

describe("service group persistence and availability", () => {
  it("upserts one public key and bumps the revision for changes", async () => {
    const group = await service();
    expect(group.revision).toBe(1);
    const first = await map(group.id);
    await map(group.id, { member_ids_json: null });
    expect(await listServiceGroupModels(env, group.id)).toMatchObject([{ id: first.id, member_ids_json: null }]);
    expect((await updateServiceGroup(env, group.id, { multiplier: 2 }))?.revision).toBe(4);
  });
  it("private grants are deduplicated, withdrawn grants fail closed, and disabled groups are unusable", async () => {
    const group = await createServiceGroup(env, { name: "private" });
    expect(await canUseServiceGroup(env, DEVICE_ID, group.id)).toBe(false);
    await setDeviceServiceGroups(env, DEVICE_ID, [group.id, group.id]);
    expect(await canUseServiceGroup(env, DEVICE_ID, group.id)).toBe(true);
    expect(d1.rows("SELECT * FROM device_service_groups")).toHaveLength(1);
    assign(group.id);
    await setDeviceServiceGroups(env, DEVICE_ID, []);
    await expect(resolveEffectiveServiceGroup(env, device())).rejects.toThrow(/not available/);
    await setDeviceServiceGroups(env, DEVICE_ID, [group.id]);
    await updateServiceGroup(env, group.id, { enabled: 0 });
    expect(await canUseServiceGroup(env, DEVICE_ID, group.id)).toBe(false);
    await expect(resolveEffectiveServiceGroup(env, device())).rejects.toThrow(/not available/);
  });
  it("nonselectable is hidden from new selections but still usable by an assigned credential", async () => {
    const group = await service();
    await updateServiceGroup(env, group.id, { selectable: 0 });
    expect(await listSelectableServiceGroups(env, DEVICE_ID)).toEqual([]);
    assign(group.id);
    expect((await resolveEffectiveServiceGroup(env, device()))?.id).toBe(group.id);
  });
  it.each(["default", "master", "sub"])("does not delete a group bound by %s", async (binding) => {
    const group = await service();
    await map(group.id);
    if (binding === "sub") await subToken("bound", DEVICE_ID, group.id);
    else assign(binding === "master" ? group.id : null, binding === "default" ? group.id : null);
    await expect(deleteServiceGroup(env, group.id)).rejects.toThrow(/assigned/);
    expect(await listServiceGroupModels(env, group.id)).toHaveLength(1);
  });
  it("deletes an unbound group and its mappings/grants", async () => {
    const group = await service(); await map(group.id);
    await setDeviceServiceGroups(env, DEVICE_ID, [group.id]);
    expect(await deleteServiceGroup(env, group.id)).toBe(true);
    expect(await listServiceGroupModels(env, group.id)).toEqual([]);
    expect(d1.rows("SELECT * FROM device_service_groups")).toEqual([]);
  });
});

describe("service routing intersects original model authorization with mappings", () => {
  it("grants on internal members cannot authorize an ungranted original public target", async () => {
    const group = await service(); await map(group.id); assign(group.id);
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID);
    seedDeviceModels(d1, ["internal"]);
    await expect(resolveServiceRoute(env, device(), "public-model")).rejects.toMatchObject({ status: 403 });
    expect(await projectServiceModels(env, device(), [])).toEqual([]);
    seedDeviceModels(d1, ["public"]);
    const route = await resolveServiceRoute(env, device(), "public-model");
    expect(route?.quotaId).toBe("public");
    expect(route?.members.map((m) => m.id)).toEqual(["internal"]);
  });
  it("group targets need only the original group grant, not grants on internal members", async () => {
    seedGroup(d1, { id: "original-group", name: "public-model" });
    seedGroupMembers(d1, "original-group", ["internal"]);
    const group = await service();
    await map(group.id, { target_type: "group", target_id: "original-group", member_ids_json: null }); assign(group.id);
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID);
    await expect(resolveServiceRoute(env, device(), "public-model")).rejects.toMatchObject({ status: 403 });
    seedDeviceGroups(d1, ["original-group"]);
    expect((await resolveServiceRoute(env, device(), "public-model"))?.members.map((m) => m.id)).toEqual(["internal"]);
  });
  it("authorized but unmapped models do not fall through to legacy routing", async () => {
    const group = await service(); assign(group.id);
    await expect(resolveServiceRoute(env, device(), "public-model")).rejects.toMatchObject({ status: 404 });
    assign(null);
    expect(await resolveServiceRoute(env, device(), "public-model")).toBeNull();
  });
  it("null model members bind only the configured target, not other same-name providers", async () => {
    seedModel(d1, { id: "outside-same-name", model_name: "public-model", model_public: 0 });
    const group = await service();
    await map(group.id, { member_ids_json: null }); assign(group.id);
    const route = await resolveServiceRoute(env, device(), "public-model");
    expect(route?.members.map(member => member.id)).toEqual(["public"]);
  });
  it("same public model uses independent ordered upstreams and prices per service group", async () => {
    seedModel(d1, { id: "internal-two", model_name: "upstream-premium", model_public: 0 });
    const cheap = await service("cheap", 0.5), premium = await service("premium", 20);
    await map(cheap.id);
    await map(premium.id, { member_ids_json: JSON.stringify(["internal-two", "internal"]), pricing_json: JSON.stringify({
      input_price_per_m: 8, output_price_per_m: 12, cache_read_price_per_m: 1, cache_write_price_per_m: 2, price_per_call: 0, search_price_per_call: 0.9 }) });
    assign(cheap.id);
    const a = await resolveServiceRoute(env, device(), "public-model");
    assign(premium.id);
    const b = await resolveServiceRoute(env, device(), "public-model");
    expect(a?.billingRow).toMatchObject({ model_name: "public-model", input_price_per_m: 1.5, output_price_per_m: 7.5, search_price_per_call: 0.7 });
    expect(b?.billingRow).toMatchObject({ model_name: "public-model", input_price_per_m: 8, output_price_per_m: 12, search_price_per_call: 0.9 });
    expect(a?.members.map((m) => m.id)).toEqual(["internal"]);
    expect(b?.members.map((m) => m.id)).toEqual(["internal-two", "internal"]);
    expect(JSON.parse(b!.members[0].config_json!)).toMatchObject({ model_rewrite: "upstream-premium" });
    expect(d1.row("SELECT input_price_per_m FROM models WHERE id = 'public'")).toEqual({ input_price_per_m: 3 });
  });
  it.each(["missing", "disabled", "withdrawn"])("%s assigned group rejects both requests and catalog without legacy fallback", async (mode) => {
    const group = await service(); await map(group.id); assign(group.id);
    if (mode === "missing") d1.sql("DELETE FROM service_groups WHERE id = ?", group.id);
    if (mode === "disabled") await updateServiceGroup(env, group.id, { enabled: 0 });
    if (mode === "withdrawn") await updateServiceGroup(env, group.id, { public_selectable: 0 });
    const status = mode === "withdrawn" ? 403 : 503;
    await expect(resolveServiceRoute(env, device(), "public-model")).rejects.toMatchObject({ status });
    await expect(projectServiceModels(env, device(), [])).rejects.toMatchObject({ status });
  });
  it("catalog exposes mapped prices, never opens keys or publishes provider secrets/endpoints", async () => {
    const group = await service(); await map(group.id); assign(group.id);
    d1.sql("UPDATE providers SET secret_name = 'PRIVATE_BINDING', endpoint = 'https://private-upstream.invalid/v1'");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("catalog must not fetch"));
    const openModel = vi.spyOn(repo, "openModelKey");
    const openMember = vi.spyOn(repo, "openGroupMemberKey");
    const openSecret = vi.spyOn(cryptoUtils, "openSecret");
    const catalog = await projectServiceModels(env, device(), []);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ model_name: "public-model", provider_api_key: null, provider_secret_name: null, provider_endpoint: null });
    const serialized = JSON.stringify(catalog);
    for (const secret of ["sealed-upstream-key-do-not-publish", "PRIVATE_BINDING", "private-upstream.invalid"]) expect(serialized).not.toContain(secret);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openModel).not.toHaveBeenCalled();
    expect(openMember).not.toHaveBeenCalled();
    expect(openSecret).not.toHaveBeenCalled();
  });
});

describe("master/sub inheritance uses the account default, never the other token override", () => {
  it("authenticates master override, default-inheriting sub and explicit sub independently", async () => {
    const fallback = await service("default"), master = await service("master"), sub = await service("sub");
    assign(master.id, fallback.id);
    const inheritToken = await subToken("inherit");
    const overrideToken = await subToken("override", DEVICE_ID, sub.id);
    const app = new Hono<{ Bindings: Env }>();
    app.get("/", async (c) => { const authed = await resolveDevice(c); return c.json({ auth: authed?.auth_via,
      group: authed ? (await resolveEffectiveServiceGroup(env, authed))?.id : null }); });
    const resolve = async (token: string) => (await app.request("http://test/", { headers: { authorization: "Bearer " + token } }, env)).json();
    expect(await resolve(TOKEN)).toEqual({ auth: "master", group: master.id });
    expect(await resolve(inheritToken)).toEqual({ auth: "sub", group: fallback.id });
    expect(await resolve(overrideToken)).toEqual({ auth: "sub", group: sub.id });
    assign(null, fallback.id);
    expect(await resolve(TOKEN)).toEqual({ auth: "master", group: fallback.id });
  });
});

describe("admin replacement validation and assignment guards", () => {
  it("accepts one public name for three original groups and dynamically inherits each target without widening scope", async () => {
    const targets = ["standard-original", "egg-original", "low-original"];
    const services = [];
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      seedGroup(d1, { id: target, name: target, input_price_per_m: index + 1, output_price_per_m: index + 4 });
      seedGroupMembers(d1, target, [index === 1 ? "public" : "internal"]);
      const group = await service("service-" + index); services.push(group);
      const response = await admin("/" + group.id + "/models", { models: [
        { model_key: "unified-call", target_type: "group", target_id: target, member_ids_json: null, pricing_json: null }] });
      expect(response.status, await response.text()).toBe(200);
      assign(group.id);
      const route = await resolveServiceRoute(env, device(), "unified-call");
      expect(route?.billingRow).toMatchObject({ model_name: "unified-call", input_price_per_m: index + 1, output_price_per_m: index + 4 });
      expect(route?.quotaId).toBe(target);
      expect(route?.members.map(m => m.id)).toEqual([index === 1 ? "public" : "internal"]);
      expect((await projectServiceModels(env, device(), []))[0].model_name).toBe("unified-call");
    }
    assign(services[1].id);
    const frozen = await resolveServiceRoute(env, device(), "unified-call");
    d1.sql("UPDATE model_groups SET input_price_per_m = 9 WHERE id = ?", targets[1]);
    d1.sql("DELETE FROM model_group_members WHERE group_id = ?", targets[1]);
    seedGroupMembers(d1, targets[1], ["internal", "public"]);
    const updated = await resolveServiceRoute(env, device(), "unified-call");
    expect(updated?.billingRow.input_price_per_m).toBe(9);
    expect(updated?.members.map(m => m.id)).toEqual(["internal", "public"]);
    expect(frozen?.billingRow.input_price_per_m).toBe(2);
    expect(frozen?.members.map(m => m.id)).toEqual(["public"]);
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID);
    seedDeviceGroups(d1, [targets[0]]);
    await expect(resolveServiceRoute(env, device(), "unified-call")).rejects.toMatchObject({ status: 403 });
    seedDeviceGroups(d1, [targets[1]]);
    expect((await resolveServiceRoute(env, device(), "unified-call"))?.quotaId).toBe(targets[1]);
    d1.sql("UPDATE model_groups SET enabled = 0 WHERE id = ?", targets[1]);
    await expect(resolveServiceRoute(env, device(), "unified-call")).rejects.toMatchObject({ status: 503 });
  });
  it("still rejects duplicate public names and missing or empty group targets", async () => {
    const group = await service(); await map(group.id);
    seedGroup(d1, { id: "empty", name: "different-empty" });
    for (const target of ["missing", "empty"]) {
      expect((await admin("/" + group.id + "/models", { models: [
        { model_key: "unified-call", target_type: "group", target_id: target }] })).status).toBe(400);
    }
    expect((await admin("/" + group.id + "/models", { models: [
      { model_key: "public-model", target_type: "model", target_id: "public" },
      { model_key: "public-model", target_type: "model", target_id: "public" }] })).status).toBe(400);
    expect(await listServiceGroupModels(env, group.id)).toHaveLength(1);
  });
  it.each([{ multiplier: -1 }, { multiplier: "2" }, { name: "" }, { unknown: 1 }])("rejects invalid update %j without mutation", async (body) => {
    const group = await service();
    expect((await admin("/" + group.id, body)).status).toBe(400);
    expect(d1.row("SELECT revision FROM service_groups WHERE id = ?", group.id)).toEqual({ revision: 1 });
  });
  it("validates the full model replacement before deleting old mappings", async () => {
    const group = await service(); await map(group.id);
    const response = await admin("/" + group.id + "/models", { models: [
      { model_key: "public-model", target_type: "model", target_id: "public", member_ids_json: ["internal"] },
      { model_key: "bad-model", target_type: "model", target_id: "does-not-exist" }] });
    expect(response.status).toBe(400);
    expect(await listServiceGroupModels(env, group.id)).toHaveLength(1);
  });
  it("accepts an internal alternate member without granting it to the account", async () => {
    const group = await service();
    const response = await admin("/" + group.id + "/models", { models: [
      { model_key: "public-model", target_type: "model", target_id: "public", member_ids_json: ["internal"] }] });
    expect(response.status).toBe(200);
    expect(await listServiceGroupModels(env, group.id)).toMatchObject([{ member_ids_json: '["internal"]' }]);
    expect(d1.rows("SELECT * FROM device_models")).toEqual([]);
  });
  it("rejects unknown account grants before replacing existing grants", async () => {
    const group = await service(); await setDeviceServiceGroups(env, DEVICE_ID, [group.id]);
    expect((await admin("/" + group.id + "/accounts", { device_ids: ["missing-account"] })).status).toBe(400);
    expect(d1.rows("SELECT * FROM device_service_groups")).toEqual([{ device_id: DEVICE_ID, service_group_id: group.id }]);
  });
  it("admin deletion rejects a sub-token binding without removing its mapping", async () => {
    const group = await service(); await map(group.id); await subToken("bound", DEVICE_ID, group.id);
    expect((await admin("/" + group.id, undefined, "DELETE")).status).toBe(400);
    expect(await listServiceGroupModels(env, group.id)).toHaveLength(1);
  });
});

describe("account sub-token service group selection", () => {
  it("requires owner password session and refuses sub-token management", async () => {
    const group = await service(); const token = await subToken();
    expect((await account("/tokens/sub-one/service-group", { service_group_id: group.id }, { session: false })).status).toBe(401);
    expect((await account("/tokens/sub-one/service-group", { service_group_id: group.id }, { token })).status).toBe(403);
  });
  it("sets an allowed override, then null restores inheritance without modifying master/default", async () => {
    const group = await service(); await subToken(); assign(null, group.id);
    expect((await account("/tokens/sub-one/service-group", { service_group_id: group.id })).status).toBe(200);
    expect(d1.row("SELECT service_group_id FROM device_sub_tokens WHERE id = 'sub-one'")).toEqual({ service_group_id: group.id });
    expect((await account("/tokens/sub-one/service-group", { service_group_id: null })).status).toBe(200);
    expect(d1.row("SELECT service_group_id FROM device_sub_tokens WHERE id = 'sub-one'")).toEqual({ service_group_id: null });
    expect(device()).toMatchObject({ service_group_id: null, default_service_group_id: group.id });
  });
  it.each(["disabled", "not-selectable", "private"])("rejects %s selection without changing sub-token", async (mode) => {
    const group = await service(); await subToken();
    await updateServiceGroup(env, group.id, mode === "disabled" ? { enabled: 0 } : mode === "not-selectable" ? { selectable: 0 } : { public_selectable: 0 });
    expect((await account("/tokens/sub-one/service-group", { service_group_id: group.id })).status).toBe(403);
    expect(d1.row("SELECT service_group_id FROM device_sub_tokens WHERE id = 'sub-one'")).toEqual({ service_group_id: null });
  });
  it.each([{}, [], { service_group_id: 1 }, { service_group_id: "" }, { service_group_id: null, enabled: 1 }])("rejects malformed selection %j", async (body) => {
    await subToken();
    expect((await account("/tokens/sub-one/service-group", body)).status).toBe(400);
  });
  it("rejects other-owner and revoked sub-tokens", async () => {
    await seedDevice(d1, { id: "other", token_hash: await sha256Hex("other-token") });
    await subToken("foreign", "other"); await subToken("revoked");
    d1.sql("UPDATE device_sub_tokens SET revoked_at = 2 WHERE id = 'revoked'");
    expect((await account("/tokens/foreign/service-group", { service_group_id: null })).status).toBe(404);
    expect((await account("/tokens/revoked/service-group", { service_group_id: null })).status).toBe(409);
  });
});

describe("account default/master selection and service catalogs", () => {
  it("lists only enabled selectable public-or-granted groups and preserves current selections", async () => {
    const publicGroup = await service("public-option"), granted = await createServiceGroup(env, { name: "private-option" });
    const hidden = await service("not-selectable"), disabled = await service("disabled");
    await createServiceGroup(env, { name: "ungranted" });
    await updateServiceGroup(env, hidden.id, { selectable: 0 });
    await updateServiceGroup(env, disabled.id, { enabled: 0 });
    await setDeviceServiceGroups(env, DEVICE_ID, [granted.id]);
    assign(hidden.id, disabled.id); await subToken("selected-sub", DEVICE_ID, granted.id);
    const response = await account("/service-groups", undefined, { method: "GET" });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.items.map((item: any) => item.id).sort()).toEqual([publicGroup.id, granted.id].sort());
    expect(body).toMatchObject({ service_group_id: hidden.id, default_service_group_id: disabled.id,
      sub_tokens: [{ id: "selected-sub", service_group_id: granted.id }] });
  });
  it("patches default and master independently, and validates a multi-field patch before either write", async () => {
    const first = await service("first"), second = await service("second");
    assign(first.id, first.id); await subToken("untouched", DEVICE_ID, first.id);
    expect((await account("/service-group", { default_service_group_id: second.id })).status).toBe(200);
    expect(device()).toMatchObject({ service_group_id: first.id, default_service_group_id: second.id });
    expect((await account("/service-group", { service_group_id: second.id, default_service_group_id: "missing" })).status).toBe(403);
    expect(device()).toMatchObject({ service_group_id: first.id, default_service_group_id: second.id });
    expect((await account("/service-group", { service_group_id: second.id })).status).toBe(200);
    expect(device()).toMatchObject({ service_group_id: second.id, default_service_group_id: second.id });
    expect(d1.row("SELECT service_group_id FROM device_sub_tokens WHERE id = 'untouched'")).toEqual({ service_group_id: first.id });
  });
  it("clears stale withdrawn selections to legacy/inheritance without a current grant", async () => {
    const group = await service(); assign(group.id, group.id); await subToken("stale", DEVICE_ID, group.id);
    await updateServiceGroup(env, group.id, { public_selectable: 0, enabled: 0 });
    expect((await account("/service-group", { service_group_id: null, default_service_group_id: null })).status).toBe(200);
    expect((await account("/tokens/stale/service-group", { service_group_id: null })).status).toBe(200);
    expect(device()).toMatchObject({ service_group_id: null, default_service_group_id: null });
    expect(await resolveServiceRoute(env, device(), "public-model")).toBeNull();
  });
  it.each([{}, [], { default_service_group_id: 1 }, { service_group_id: "" }, { default_service_group_id: null, model_scope: "all" }])(
    "rejects malformed default/master patch %j without changing selections", async (body) => {
      const group = await service(); assign(group.id, group.id);
      expect((await account("/service-group", body)).status).toBe(400);
      expect(device()).toMatchObject({ service_group_id: group.id, default_service_group_id: group.id });
    });
  it("requires owner session for mutation and disallows sub-token catalog or selection management", async () => {
    const group = await service(), token = await subToken();
    expect((await account("/service-group", { service_group_id: group.id }, { session: false })).status).toBe(401);
    expect((await account("/service-group", { service_group_id: group.id }, { token })).status).toBe(403);
    expect((await account("/service-groups", undefined, { method: "GET", token })).status).toBe(403);
    expect((await account("/service-groups/" + group.id + "/models", undefined, { method: "GET", token })).status).toBe(403);
  });
  it("previews another group's mapped price without opening keys or changing any selection", async () => {
    const selected = await service("selected"), preview = await service("preview", 2);
    await map(preview.id); assign(selected.id, selected.id); await subToken("same", DEVICE_ID, selected.id);
    const open = vi.spyOn(cryptoUtils, "openSecret");
    const response = await account("/service-groups/" + preview.id + "/models", undefined, { method: "GET" });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({ service_group_id: preview.id, model_count: 1,
      items: [{ model_name: "public-model", input_price_per_m: 6, output_price_per_m: 30 }] });
    for (const key of ["provider_api_key", "provider_secret_name", "provider_endpoint", "config_json", "member_ids_json"]) {
      expect(body.items[0]).not.toHaveProperty(key);
    }
    expect(JSON.stringify(body)).not.toContain("sealed-upstream-key-do-not-publish");
    expect(JSON.stringify(body)).not.toContain("upstream-fast");
    expect(open).not.toHaveBeenCalled();
    expect(device()).toMatchObject({ service_group_id: selected.id, default_service_group_id: selected.id });
    expect(d1.row("SELECT service_group_id FROM device_sub_tokens WHERE id = 'same'")).toEqual({ service_group_id: selected.id });
  });
  it("preview intersects original model authorization, and rejects withdrawn group preview", async () => {
    const group = await service(); await map(group.id);
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID); seedDeviceModels(d1, ["internal"]);
    const url = "/service-groups/" + group.id + "/models";
    expect(await (await account(url, undefined, { method: "GET" })).json()).toMatchObject({ model_count: 0, items: [] });
    seedDeviceModels(d1, ["public"]);
    expect(await (await account(url, undefined, { method: "GET" })).json()).toMatchObject({ model_count: 1 });
    await updateServiceGroup(env, group.id, { public_selectable: 0 });
    expect((await account(url, undefined, { method: "GET" })).status).toBe(403);
  });
});
