import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverBillingRequests } from "../src/db/request_billing";
import { Hono } from "hono";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, TOKEN, makeEnv, seedDevice, seedModel, seedProvider, seedGroup, seedGroupMembers, chatBody,
  openAiAnswer, postJson, CollectingExecutionContext, wallet, sseAnswer, openAiStreamFrames } from "./helpers/realGatewayEnv";
import { ensureSchema } from "../src/db/schema";
import { DEFAULT_ROUTING_POLICY, ensureTokenPoliciesSchema, parseTokenRoutingPolicy, putTokenRoutingPolicy,
  getTokenRoutingPolicy, resolveTokenRoutingPolicy, tokenScopeAllows, withTokenRoutingPolicy } from "../src/db/token_policies";
import { resolveAutoServiceRoutes, resolveServiceRoute, projectServiceModels, planServiceRoutes } from "../src/gateway/service_groups";
import { accountApp } from "../src/console/account";
import { resolveDevice } from "../src/gateway/auth";
import { generateOpenApiSpec } from "../src/gateway/openapi";
import { buildUserSessionCookie, hashPassword, sha256Hex, signUserSession } from "../src/utils/crypto";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import type { AuthedDevice, DeviceRow, Env, TokenRoutingPolicy } from "../src/types";
import type { ModelProjectionRow } from "../src/db/repo";

let d: RealD1, env: Env;
const secret = "token-policy-test-session";
const device = () => d.row<DeviceRow>("SELECT * FROM devices WHERE id=?", DEVICE_ID)!;
const policy = (patch: Partial<TokenRoutingPolicy> = {}): TokenRoutingPolicy => ({ ...structuredClone(DEFAULT_ROUTING_POLICY), ...patch });
async function authed(id = "master"): Promise<AuthedDevice> {
  return withTokenRoutingPolicy(env, { ...device(), auth_via: id === "master" ? "master" : "sub", sub_token_id: id === "master" ? null : id,
    ...(id === "master" ? {} : { service_group_id: d.row<{ service_group_id: string | null }>("SELECT service_group_id FROM device_sub_tokens WHERE id=?", id)?.service_group_id ?? null }) });
}
function offer(id: string, target: string, key = "public-model", options: { target_type?: "model" | "group"; pricing_json?: string; enabled?: number } = {}) {
  d.sql("INSERT INTO service_groups(id,name,enabled,selectable,public_selectable,multiplier,revision) VALUES(?,?,?,1,1,1,1)", id, id, options.enabled ?? 1);
  d.sql("INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id,pricing_json) VALUES(?,?,?,?,?,?)", "map-" + id, id, key, options.target_type ?? "model", target, options.pricing_json ?? null);
  d.sql("INSERT OR IGNORE INTO public_model_identities(id,name,enabled) VALUES(?,?,1)", "identity-" + key, key);
}
async function sub(id = "sub", owner = DEVICE_ID, old: string | null = null) {
  const token = "credential-" + id;
  d.sql("INSERT INTO device_sub_tokens(id,device_id,name,token_hash,enabled,created_at,service_group_id) VALUES(?,?,?,?,1,1,?)", id, owner, id, await sha256Hex(token), old);
  return token;
}
async function account(path: string, body?: unknown, options: { token?: string; session?: boolean; method?: string } = {}) {
  const cookie = options.session === false ? "" : buildUserSessionCookie(await signUserSession(secret, DEVICE_ID, 1)).split(";")[0];
  return accountApp.request("http://test" + path, { method: options.method ?? (body === undefined ? "GET" : "PUT"), headers: {
    authorization: "Bearer " + (options.token ?? TOKEN), cookie, "content-type": "application/json",
  }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
}
async function proxy(body: unknown = chatBody("public-model"), path = "/chat/completions") {
  const exec = new CollectingExecutionContext();
  const response = await postJson(env, path, body, exec); const text = await response.text(); await Promise.all(exec.pending);
  return { response, text };
}
beforeEach(async () => {
  resetRateLimitMemory(); clearMemoryCacheForTest(); d = createRealD1(); env = { ...makeEnv(d), SESSION_SECRET: secret };
  await seedDevice(d, { balance_usd: 100 }); await ensureSchema(env); await ensureTokenPoliciesSchema(env);
  d.sql("UPDATE devices SET password_hash = ?, password_updated_at = 1 WHERE id = ?", await hashPassword("fixture-password"), DEVICE_ID);
  seedProvider(d); seedModel(d, { id: "a", model_name: "upstream-a", input_price_per_m: 10, output_price_per_m: 20 });
  seedModel(d, { id: "b", model_name: "upstream-b", input_price_per_m: 30, output_price_per_m: 60 });
});
afterEach(() => { vi.restoreAllMocks(); d.close(); });

describe("atomic whole routing policy inheritance and validation (real SQLite)", () => {
  it("defaults independent failure fallback off, distinguishes null and empty scope, rejects malformed policies", () => {
    expect(parseTokenRoutingPolicy({ mode: "auto", group_ids: [] })).toMatchObject({ failure_fallback: false, selection: "ordered", model_scope: null });
    expect(parseTokenRoutingPolicy(null)).toBeNull();
    expect(parseTokenRoutingPolicy(policy({ model_scope: [] }))?.model_scope).toEqual([]);
    for (const value of [ {}, { mode: "fixed", group_ids: [] }, { mode: "multi", group_ids: ["x", "x"] },
      policy({ selection: "bad" as "ordered" }), policy({ failure_fallback: "yes" as unknown as boolean }),
      policy({ model_scope: ["category:text"] }), policy({ model_overrides: { "model:a": "not-selected" } }), { ...policy(), unknown: true } ]) {
      expect(() => parseTokenRoutingPolicy(value)).toThrow();
    }
  });
  it("stores ordered relational references, increments revision, and rolls back both tables atomically", async () => {
    const first = policy({ mode: "multi", group_ids: ["b", "a"] }); await putTokenRoutingPolicy(env, DEVICE_ID, "master", first);
    expect(d.rows("SELECT service_group_id, position FROM token_routing_policy_groups ORDER BY position")).toEqual([{ service_group_id: "b", position: 0 }, { service_group_id: "a", position: 1 }]);
    d.sql("CREATE TRIGGER deny_reference BEFORE INSERT ON token_routing_policy_groups WHEN NEW.service_group_id='bad' BEGIN SELECT RAISE(ABORT,'blocked reference'); END");
    await expect(putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "fixed", group_ids: ["bad"] }))).rejects.toThrow("blocked reference");
    expect(JSON.parse((await getTokenRoutingPolicy(env, DEVICE_ID, "master"))!.policy_json!)).toEqual(first);
    expect((await getTokenRoutingPolicy(env, DEVICE_ID, "master"))!.revision).toBe(1);
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", null);
    expect((await getTokenRoutingPolicy(env, DEVICE_ID, "master"))!.revision).toBe(2);
    expect(d.rows("SELECT * FROM token_routing_policy_groups")).toEqual([]);
  });
  it("children inherit account whole policy, never master overrides; null clears old single-group override", async () => {
    await sub("sub", DEVICE_ID, "old-group");
    const accountPolicy = policy({ mode: "multi", group_ids: ["second", "first"], selection: "input_price", model_scope: ["model:a"] });
    await putTokenRoutingPolicy(env, DEVICE_ID, "account", accountPolicy);
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "legacy", failure_fallback: true }));
    expect((await authed()).token_routing_policy?.policy.mode).toBe("legacy");
    await putTokenRoutingPolicy(env, DEVICE_ID, "sub", null);
    const child = (await authed("sub")).token_routing_policy!;
    expect(child.policy).toEqual(accountPolicy); expect(child.source).toBe("account");
    expect(child.version).toBe("account:1/sub:1");
    expect((await resolveTokenRoutingPolicy(env, device(), "account")).source).toBe("account");
    await putTokenRoutingPolicy(env, DEVICE_ID, "sub", policy({ mode: "fixed", group_ids: ["different"], model_scope: ["model:b"] }));
    const explicit = await authed("sub");
    expect(explicit.token_routing_policy?.policy.selection).toBe("ordered");
    expect(tokenScopeAllows(explicit, ["model:a"])).toBe(false); expect(tokenScopeAllows(explicit, ["model:b"])).toBe(true);
    await putTokenRoutingPolicy(env, DEVICE_ID, "sub", policy({ model_scope: [] }));
    expect(tokenScopeAllows(await authed("sub"), ["model:a", "model:b"])).toBe(false);
  });
  it("account default edits affect followers only, while administrator authorization stays the ceiling", async () => {
    await sub(); await sub("independent-sub"); offer("selected", "b");
    await putTokenRoutingPolicy(env, DEVICE_ID, "sub", null);
    const independent = policy({ mode: "multi", group_ids: ["selected"], model_scope: ["public:identity-public-model"] });
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", independent);
    await putTokenRoutingPolicy(env, DEVICE_ID, "independent-sub", independent);
    for (const model_scope of [["model:a"], [], null]) {
      await putTokenRoutingPolicy(env, DEVICE_ID, "account", policy({ mode: "legacy", model_scope }));
      for (const id of ["master", "independent-sub"]) {
        const credential = await authed(id);
        expect(credential.token_routing_policy?.policy).toEqual(independent);
        expect(credential.token_routing_policy?.scope_layers).toEqual([["public:identity-public-model"]]);
        expect((await planServiceRoutes(env, credential, "public-model"))[0].quotaId).toBe("b");
      }
      expect((await authed("sub")).token_routing_policy?.policy.model_scope).toEqual(model_scope);
    }
    await putTokenRoutingPolicy(env, DEVICE_ID, "account", policy({ model_scope: [] }));
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "multi", group_ids: ["selected"], model_scope: null }));
    expect((await authed()).token_routing_policy?.scope_layers).toEqual([]);
    expect(await planServiceRoutes(env, await authed(), "public-model")).toHaveLength(1);
    d.sql("UPDATE devices SET model_scope='list'"); d.sql("UPDATE models SET model_public=0 WHERE id='b'");
    await expect(planServiceRoutes(env, await authed(), "public-model")).rejects.toMatchObject({ status: 503 });
  });

  it("gateway authentication attaches policy independently to master and sub", async () => {
    const token = await sub(); await putTokenRoutingPolicy(env, DEVICE_ID, "account", policy({ mode: "legacy" }));
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ model_scope: [] }));
    const app = new Hono<{ Bindings: Env }>(); app.get("/", async c => c.json(await resolveDevice(c)));
    const read = async (t: string) => (await app.request("http://test/", { headers: { authorization: "Bearer " + t } }, env)).json() as Promise<AuthedDevice>;
    expect((await read(TOKEN)).token_routing_policy?.policy.mode).toBe("auto");
    expect((await read(token)).token_routing_policy?.policy.mode).toBe("legacy");
  });
});

describe("planning and scope use the same authorized frozen candidate set", () => {
  it("preserves selected order, can independently price-sort, and honors a one-model fixed exception", async () => {
    offer("z-expensive", "b"); offer("a-cheap", "a");
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "multi", group_ids: ["z-expensive", "a-cheap"] }));
    expect((await planServiceRoutes(env, await authed(), "public-model")).map(r => r.group.id)).toEqual(["z-expensive", "a-cheap"]);
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "multi", group_ids: ["z-expensive", "a-cheap"], selection: "input_price" }));
    expect((await planServiceRoutes(env, await authed(), "public-model")).map(r => r.group.id)).toEqual(["a-cheap", "z-expensive"]);
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "multi", group_ids: ["z-expensive", "a-cheap"], selection: "input_price", model_overrides: { "public:identity-public-model": "z-expensive" } }));
    expect((await planServiceRoutes(env, await authed(), "public-model")).map(r => r.group.id)).toEqual(["z-expensive"]);
  });
  it("fixed sets with missing, disabled, revoked or absent mappings never silently use legacy or Auto", async () => {
    offer("fixed", "a"); seedModel(d, { id: "collision", model_name: "missing-key" });
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "multi", group_ids: ["fixed"] }));
    await expect(resolveAutoServiceRoutes(env, await authed(), "missing-key")).rejects.toMatchObject({ status: 503 });
    d.sql("UPDATE service_groups SET enabled=0 WHERE id='fixed'");
    await expect(resolveAutoServiceRoutes(env, await authed(), "public-model")).rejects.toMatchObject({ status: 503 });
    d.sql("UPDATE service_groups SET enabled=1,public_selectable=0 WHERE id='fixed'");
    await expect(resolveAutoServiceRoutes(env, await authed(), "public-model")).rejects.toMatchObject({ status: 403 });
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "fixed", group_ids: ["gone"] }));
    await expect(resolveServiceRoute(env, await authed(), "public-model")).rejects.toMatchObject({ status: 503 });
  });
  it("broken Auto price and disabled aliases remain reserved and shadow same-name legacy catalog entries", async () => {
    offer("bad", "a", "public-model", { pricing_json: "not-json" });
    d.sql("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES('bad','retired','map-bad',0)");
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy());
    await expect(resolveAutoServiceRoutes(env, await authed(), "public-model")).rejects.toMatchObject({ status: 503 });
    await expect(resolveAutoServiceRoutes(env, await authed(), "retired")).rejects.toMatchObject({ status: 503 });
    const legacy = [{ id: "collision", model_name: "public-model", alias: "retired" }, { id: "safe", model_name: "safe", alias: null }] as ModelProjectionRow[];
    expect((await projectServiceModels(env, await authed(), legacy)).map(r => r.model_name)).toEqual(["safe"]);
    expect(await resolveAutoServiceRoutes(env, await authed(), "safe")).toEqual([]);
  });
  it.each(["price", "members", "deleted", "disabled", "denied"])("visible %s mapping cannot hide behind its same-name good quote; other names survive", async kind => {
    offer("bad", "b"); offer("good", "a"); offer("safe", "a", "safe-model");
    for (const group of ["bad", "good"]) d.sql("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES(?,?,?,1)", group, "shared-alias", "map-" + group);
    if (kind === "price") d.sql("UPDATE service_group_models SET pricing_json='not-json' WHERE id='map-bad'");
    if (kind === "members") d.sql("UPDATE service_group_models SET member_ids_json='not-json' WHERE id='map-bad'");
    if (kind === "deleted") d.sql("DELETE FROM models WHERE id='b'");
    if (kind === "disabled") d.sql("UPDATE models SET enabled=0 WHERE id='b'");
    if (kind === "denied") {
      d.sql("UPDATE devices SET model_scope='list'"); d.sql("UPDATE models SET model_public=0 WHERE id='b'");
      d.sql("INSERT INTO device_models(device_id,model_id) VALUES(?,'a')", DEVICE_ID);
    }
    const legacy = [{ id: "collision", model_name: "public-model", alias: "shared-alias" }, { id: "legacy", model_name: "legacy-safe" }] as ModelProjectionRow[];
    for (const mode of ["auto", "multi"] as const) {
      await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode, group_ids: mode === "multi" ? ["bad", "good", "safe"] : [] }));
      const credential = await authed();
      for (const key of ["public-model", "shared-alias"]) await expect(planServiceRoutes(env, credential, key)).rejects.toMatchObject({ status: 503 });
      expect((await planServiceRoutes(env, credential, "safe-model"))).toHaveLength(1);
      expect((await projectServiceModels(env, credential, legacy)).map(row => row.model_name)).toEqual(mode === "auto" ? ["safe-model", "legacy-safe"] : ["safe-model"]);
    }
  });

  it.each(["private", "unselectable", "disabled"])("unrelated %s group names and aliases do not reserve authorized legacy names", async kind => {
    offer("unrelated", "a", "legacy-name", { pricing_json: "broken" });
    d.sql("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES('unrelated','legacy-alias','gone',0)");
    if (kind === "private") d.sql("UPDATE service_groups SET public_selectable=0");
    if (kind === "unselectable") d.sql("UPDATE service_groups SET selectable=0");
    if (kind === "disabled") d.sql("UPDATE service_groups SET enabled=0");
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy());
    const credential = await authed();
    for (const key of ["legacy-name", "legacy-alias"]) expect(await planServiceRoutes(env, credential, key)).toEqual([]);
    const legacy = [{ id: "legacy", model_name: "legacy-name", alias: "legacy-alias" }] as ModelProjectionRow[];
    expect(await projectServiceModels(env, credential, legacy)).toEqual(legacy);
    d.sql("UPDATE public_model_identities SET enabled=0 WHERE name='legacy-name'");
    await expect(planServiceRoutes(env, credential, "legacy-name")).rejects.toMatchObject({ status: 503 });
    expect((await projectServiceModels(env, credential, legacy)).map(row => row.model_name)).toEqual(["legacy-alias"]);
  });

  it.each(["unset", "alias-disabled", "alias-dangling"])("eligible %s configuration remains reserved instead of using legacy", async kind => {
    offer("visible", "a"); let key = "public-model";
    if (kind === "unset") d.sql("UPDATE models SET pricing_mode='unset' WHERE id='a'");
    else {
      key = "retired";
      d.sql("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES('visible','retired',?,?)", kind === "alias-dangling" ? "gone" : "map-visible", kind === "alias-disabled" ? 0 : 1);
    }
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy());
    const credential = await authed();
    await expect(planServiceRoutes(env, credential, key)).rejects.toMatchObject({ status: 503 });
    expect((await projectServiceModels(env, credential, [{ id: "legacy", model_name: key }] as ModelProjectionRow[])).some(row => row.model_name === key)).toBe(false);
  });

  it("batches a growing Auto catalogue without per-name SQL or global group-name scans", async () => {
    offer("visible", "a", "first");
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy());
    const credential = await authed(); const prepare = vi.spyOn(env.DB, "prepare");
    expect(await projectServiceModels(env, credential, [])).toHaveLength(1);
    const baseline = prepare.mock.calls.length; prepare.mockClear();
    for (let i = 0; i < 60; i++) {
      d.sql("INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id) VALUES(?,'visible',?,'model','a')", "extra-" + i, "extra-" + i);
      d.sql("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES('visible',?,?,1)", "alias-" + i, "extra-" + i);
    }
    expect(await projectServiceModels(env, credential, [])).toHaveLength(61);
    expect(prepare.mock.calls.length).toBe(baseline);
    expect(prepare.mock.calls.filter(([sql]) => String(sql).includes("FROM models m JOIN providers p"))).toHaveLength(1);
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes("UNION"))).toBe(false);
  });

  it("scope stable identity follows aliases while administrator grants remain the authorization ceiling", async () => {
    offer("service", "a"); d.sql("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES('service','alias-name','map-service',1)");
    await putTokenRoutingPolicy(env, DEVICE_ID, "account", policy({ model_scope: ["public:identity-public-model"] }));
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ model_scope: ["public:identity-public-model"] }));
    expect((await planServiceRoutes(env, await authed(), "alias-name"))[0].mapping.model_key).toBe("public-model");
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ model_scope: [] }));
    await expect(planServiceRoutes(env, await authed(), "alias-name")).rejects.toMatchObject({ status: 503 });
    expect(await projectServiceModels(env, await authed(), [])).toEqual([]);
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ model_scope: ["public:identity-public-model"] }));
    d.sql("UPDATE devices SET model_scope='list'"); d.sql("UPDATE models SET model_public=0 WHERE id='a'");
    await expect(planServiceRoutes(env, await authed(), "alias-name")).rejects.toMatchObject({ status: 503 });
  });
  it("legacy typed scope never implicitly grants a migrated public product sharing its target", async () => {
    offer("service", "a");
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ model_scope: ["model:a"] }));
    await expect(planServiceRoutes(env, await authed(), "public-model")).rejects.toMatchObject({ status: 503 });
    const legacy = [{ id: "a", model_name: "legacy-a" }] as ModelProjectionRow[];
    expect((await projectServiceModels(env, await authed(), legacy)).map(r => r.model_name)).toEqual(["legacy-a"]);
    d.sql("DELETE FROM public_model_identities WHERE name='public-model'");
    expect((await planServiceRoutes(env, await authed(), "public-model"))).toHaveLength(1);
  });
  it("disabled public identities are reserved and never advertised or dispatched as legacy", async () => {
    offer("fixed", "a"); await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy());
    d.sql("UPDATE public_model_identities SET enabled=0 WHERE name='public-model'");
    await expect(planServiceRoutes(env, await authed(), "public-model")).rejects.toMatchObject({ status: 503 });
    expect(await projectServiceModels(env, await authed(), [{ id: "collision", model_name: "public-model" }] as ModelProjectionRow[])).toEqual([]);
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "fixed", group_ids: ["fixed"] }));
    await expect(planServiceRoutes(env, await authed(), "public-model")).rejects.toMatchObject({ status: 404 });
  });
  it("selected multi groups authorize once in a bounded batch while preserving assigned unselectable groups", async () => {
    for (let i = 0; i < 12; i++) offer("g" + i, "a");
    d.sql("UPDATE service_groups SET selectable=0 WHERE id='g0'");
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "multi", group_ids: Array.from({ length: 12 }, (_, i) => "g" + i) }));
    const credential = await authed(); const prepare = vi.spyOn(env.DB, "prepare");
    expect(await planServiceRoutes(env, credential, "public-model")).toHaveLength(12);
    expect(prepare.mock.calls.filter(([sql]) => String(sql).includes("AS policy_allowed"))).toHaveLength(1);
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes("SELECT g.id FROM service_groups"))).toBe(false);
  });
  it("applies group rewrite before member rewrite and actual names", async () => {
    seedGroup(d, { id: "target", config_json: JSON.stringify({ model_rewrite: "group-upstream" }) }); seedGroupMembers(d, "target", ["a", "b"]);
    d.sql("UPDATE models SET config_json=? WHERE id='a'", JSON.stringify({ model_rewrite: "member-upstream" }));
    offer("fixed", "target", "public-model", { target_type: "group" });
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "fixed", group_ids: ["fixed"] }));
    expect((await resolveServiceRoute(env, await authed(), "public-model"))!.members.map(m => JSON.parse(m.config_json!).model_rewrite)).toEqual(["group-upstream", "group-upstream"]);
    d.sql("UPDATE model_groups SET config_json=NULL WHERE id='target'");
    expect((await resolveServiceRoute(env, await authed(), "public-model"))!.members.map(m => JSON.parse(m.config_json!).model_rewrite)).toEqual(["member-upstream", "upstream-b"]);
  });
});

describe("owner-only whole-policy API and independent model directory", () => {
  it("requires password session and owner master, rejects foreign/revoked token targets", async () => {
    const token = await sub();
    expect((await account("/routing-policy", undefined, { session: false })).status).toBe(401);
    expect((await account("/routing-policy", { policy: policy() }, { token })).status).toBe(403);
    expect((await account("/tokens/foreign/routing-policy", { policy: null })).status).toBe(404);
    d.sql("UPDATE device_sub_tokens SET revoked_at=1 WHERE id='sub'");
    expect((await account("/tokens/sub/routing-policy", { policy: null })).status).toBe(409);
  });
  it("legacy single-group APIs update the effective whole policy atomically and preserve narrow scope", async () => {
    offer("service", "a"); await sub();
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "multi", group_ids: ["service"], model_scope: [] }));
    expect((await account("/service-group", { service_group_id: "legacy" })).status).toBe(200);
    expect((await authed()).token_routing_policy?.policy).toMatchObject({ mode: "legacy", model_scope: [], failure_fallback: false });
    expect((await account("/service-group", { default_service_group_id: "auto" })).status).toBe(200);
    await putTokenRoutingPolicy(env, DEVICE_ID, "sub", policy({ mode: "legacy", model_scope: ["model:a"] }));
    expect((await account("/tokens/sub/service-group", { service_group_id: "service" })).status).toBe(200);
    expect((await authed("sub")).token_routing_policy?.policy).toMatchObject({ mode: "fixed", group_ids: ["service"], model_scope: ["model:a"] });
    expect((await account("/tokens/sub/service-group", { service_group_id: null })).status).toBe(200);
    expect((await authed("sub")).token_routing_policy?.policy.mode).toBe("auto");
  });
  it("returns stable scope keys without classification or internal routing secrets and counts whole-policy followers", async () => {
    offer("service", "a"); await sub(); await sub("explicit");
    await putTokenRoutingPolicy(env, DEVICE_ID, "explicit", policy({ mode: "legacy" }));
    const saved = await account("/routing-policy", { policy: policy({ mode: "multi", group_ids: ["service"], model_scope: ["public:identity-public-model"] }) });
    expect(saved.status).toBe(200); const body = await saved.json() as Record<string, unknown>;
    expect(body.following_token_count).toBe(2); expect(body.source).toBe("account");
    expect(body.models).toEqual(expect.arrayContaining([expect.objectContaining({ scope_key: "public:identity-public-model", group_ids: ["service"] })]));
    expect(JSON.stringify(body)).not.toMatch(/sk-a|provider_api_key|endpoint|config_json|category_id/);
    const child = await account("/tokens/sub/routing-policy", { policy: null });
    expect(await child.json()).toMatchObject({ policy: null, effective_policy: { mode: "multi", group_ids: ["service"] }, source: "account" });
    expect((await account("/tokens/master/routing-policy", { policy: policy({ model_scope: [] }) })).status).toBe(200);
    expect((await account("/tokens/master/routing-policy", { policy: policy({ model_scope: ["model:unauthorized"] }) })).status).toBe(403);
    expect((await account("/routing-policy", { policy: policy({ mode: "fixed", group_ids: ["unauthorized"] }) })).status).toBe(403);
  });
});

async function expectUnknownUntilRecovery() {
  const holds = d.rows<{ amount_usd: number }>("SELECT * FROM reserve_holds");
  expect(holds).toHaveLength(1); expect(holds[0].amount_usd).toBeGreaterThan(0);
  expect(wallet(d)?.reserved_usd).toBeCloseTo(holds[0].amount_usd, 8);
  expect(d.rows("SELECT * FROM usage")).toEqual([]);
  expect(d.rows("SELECT * FROM wallet_ledger")).toEqual([]);
  const billing = d.row<{ lease_until: number }>("SELECT * FROM billing_requests")!;
  expect(billing).toMatchObject({ billing_state: "needs_reconciliation", known_cost_usd: null });
  expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 0 });
  expect(d.rows("SELECT * FROM reserve_holds")).toEqual(holds);
  const clock = vi.spyOn(Date, "now").mockReturnValue(billing.lease_until + 1);
  try { expect(await recoverBillingRequests(env)).toEqual({ settled: 0, expired: 1 }); }
  finally { clock.mockRestore(); }
  expect(wallet(d)?.reserved_usd).toBe(0);
  expect(d.rows("SELECT * FROM reserve_holds")).toEqual([]);
  expect(d.rows("SELECT * FROM usage")).toEqual([]);
  expect(d.rows("SELECT * FROM wallet_ledger")).toEqual([]);
}

describe("policy proxy safety and one-success frozen settlement (real SQLite)", () => {
  async function setup(fallback = false) {
    offer("first", "a"); offer("second", "b");
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "multi", group_ids: ["first", "second"], failure_fallback: fallback }));
  }
  it("does not cross groups unless independently enabled", async () => {
    await setup(); const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("busy", { status: 503 }));
    expect((await proxy()).response.status).toBe(502); expect(fetch).toHaveBeenCalledTimes(1);
    expect(wallet(d)?.reserved_usd).toBe(0);
  });
  it("freezes max hold, candidate prices and policy version before first dispatch and settles successful group once", async () => {
    await setup(true); const holds: number[] = []; const models: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      models.push(JSON.parse(String(init?.body)).model); holds.push(wallet(d)!.reserved_usd);
      if (models.length === 1) {
        d.sql("UPDATE models SET input_price_per_m=999 WHERE id='b'");
        await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "legacy" }));
        return new Response("busy", { status: 503 });
      }
      return openAiAnswer();
    });
    expect((await proxy()).response.status).toBe(200); expect(models).toEqual(["upstream-a", "upstream-b"]);
    expect(holds[0]).toBeGreaterThan(0); expect(holds[1]).toBe(holds[0]);
    const usage = d.rows<{ service_group_id: string; cost_usd: number; pricing_snapshot_json: string }>("SELECT * FROM usage");
    expect(usage).toHaveLength(1); expect(usage[0].service_group_id).toBe("second"); expect(usage[0].cost_usd).toBeCloseTo(0.09);
    expect(JSON.parse(usage[0].pricing_snapshot_json)).toMatchObject({ policy_version: "account:0/master:1", candidate_groups: [{ id: "first" }, { id: "second" }] });
    expect(wallet(d)?.reserved_usd).toBe(0);
  });
  it("never retries an unknown transport outcome even when cross-group fallback is enabled", async () => {
    await setup(true); const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket ended after write"));
    expect((await proxy()).response.status).toBe(502); expect(fetch).toHaveBeenCalledTimes(1);
    await expectUnknownUntilRecovery();
  });
  it("fixed pools never replay unknown transport outcomes even with member retries", async () => {
    seedGroup(d, { id: "target", config_json: JSON.stringify({ member_retries: 2 }) }); seedGroupMembers(d, "target", ["a", "b"]);
    offer("fixed", "target", "public-model", { target_type: "group" });
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "fixed", group_ids: ["fixed"] }));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unknown upstream acceptance"));
    expect((await proxy()).response.status).toBe(502); expect(fetch).toHaveBeenCalledTimes(1);
    await expectUnknownUntilRecovery();
  });
  it("retains a fixed-route hold for recovery if an actual body read fails before settlement", async () => {
    offer("fixed", "a"); await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "fixed", group_ids: ["fixed"] }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      expect(wallet(d)!.reserved_usd).toBeGreaterThan(0);
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new Error("broken body before settlement")); },
      }), { headers: { "content-type": "application/json" } });
    });
    expect((await proxy()).response.status).toBe(500); await expectUnknownUntilRecovery();
  });
  it("point compatibility aliases reuse the same scoped public model identity", async () => {
    offer("service", "a"); d.sql("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES('service','alias-name','map-service',1)");
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ model_scope: ["public:identity-public-model"] }));
    const gateway = await import("../src/gateway/index");
    const point = await gateway.gatewayApp.request("http://test/models/alias-name", { headers: { authorization: "Bearer " + TOKEN } }, env);
    expect(point.status).toBe(200); expect(await point.json()).toMatchObject({ id: "alias-name" });
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ model_scope: [] }));
    expect((await gateway.gatewayApp.request("http://test/models/alias-name", { headers: { authorization: "Bearer " + TOKEN } }, env)).status).toBe(404);
  });
  it("never retries a per-call purchase or a stream handed to the caller", async () => {
    await setup(true); d.sql("UPDATE models SET billing_unit='call',price_per_call=0.1");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("busy", { status: 503 }));
    expect((await proxy({ model: "public-model", prompt: "tree" }, "/images/generations")).response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1); fetch.mockReset(); d.sql("UPDATE models SET billing_unit='token'");
    fetch.mockImplementation(async () => sseAnswer(openAiStreamFrames()));
    expect((await proxy(chatBody("public-model", { stream: true }))).response.status).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
    expect(wallet(d)?.reserved_usd).toBe(0);
  });
  it("empty scope denies legacy proxy, list, point model and OpenAPI without fetching", async () => {
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "legacy", model_scope: [] }));
    const fetch = vi.spyOn(globalThis, "fetch"); const result = await proxy(chatBody("upstream-a"));
    expect(result.response.status).toBe(403); expect(fetch).not.toHaveBeenCalled();
    const spec = JSON.stringify(await generateOpenApiSpec(env, undefined, { includePrivateModels: true, device: await authed() }));
    expect(spec).not.toContain('"upstream-a"'); expect(spec).not.toContain('"upstream-b"');
    const gateway = await import("../src/gateway/index");
    const point = await gateway.gatewayApp.request("http://test/models/upstream-a", { headers: { authorization: "Bearer " + TOKEN } }, env);
    expect(point.status).toBe(404);
    const list = await gateway.gatewayApp.request("http://test/models", { headers: { authorization: "Bearer " + TOKEN } }, env);
    expect(await list.json()).toMatchObject({ data: [] });
  });
});
