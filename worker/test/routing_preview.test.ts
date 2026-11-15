import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, TOKEN, makeEnv, seedDevice, seedModel, seedProvider, seedGroup, seedGroupMembers,
  seedDeviceModels, seedDeviceGroups, wallet, holdRows, ledgerRows, usageRows, makeKv } from "./helpers/realGatewayEnv";
import { ensureSchema } from "../src/db/schema";
import { DEFAULT_ROUTING_POLICY, putTokenRoutingPolicy } from "../src/db/token_policies";
import { previewTokenRouting } from "../src/console/routing_preview";
import { accountApp } from "../src/console/account";
import { buildUserSessionCookie, hashPassword, sha256Hex, signUserSession } from "../src/utils/crypto";
import type { DeviceRow, Env, TokenRoutingPolicy } from "../src/types";

let d: RealD1, env: Env;
const device = () => d.row<DeviceRow>("SELECT * FROM devices WHERE id=?", DEVICE_ID)!;
const policy = (patch: Partial<TokenRoutingPolicy> = {}): TokenRoutingPolicy => ({ ...structuredClone(DEFAULT_ROUTING_POLICY), ...patch });
function offer(id: string, target: string, options: { key?: string; price?: string; enabled?: number } = {}) {
  const key = options.key ?? "public-model";
  d.sql("INSERT INTO service_groups(id,name,enabled,selectable,public_selectable,multiplier,revision) VALUES(?,?,?,1,1,1,1)", id, "公开组 " + id, options.enabled ?? 1);
  d.sql("INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id,pricing_json) VALUES(?,?,?,'model',?,?)", "map-" + id, id, key, target, options.price ?? null);
  d.sql("INSERT OR IGNORE INTO public_model_identities(id,name,enabled) VALUES(?,?,1)", "identity-" + key, key);
}
beforeEach(async () => {
  d = createRealD1(); env = makeEnv(d);
  await seedDevice(d); await ensureSchema(env);
  seedProvider(d, { name: "INTERNAL_PROVIDER", endpoint: "https://private-provider.invalid/private", api_key: "sealed:DO_NOT_EXPOSE" });
  seedModel(d, { id: "m1", model_name: "upstream-internal", input_price_per_m: 3, output_price_per_m: 15, search_price_per_call: 0.1 });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); d.close(); });

describe("previewTokenRouting with real SQLite (no upstream execution)", () => {
  it("uses policy order, stable identity and safe complete prices without serializing sealed rows", async () => {
    offer("expensive", "m1", { price: JSON.stringify({ input_price_per_m: 10, output_price_per_m: 30, cache_read_price_per_m: 2, cache_write_price_per_m: 4 }) });
    offer("cheap", "m1");
    await putTokenRoutingPolicy(env, DEVICE_ID, "account", policy({ mode: "multi", group_ids: ["expensive", "cheap"] }));
    const result = await previewTokenRouting(env, device(), "master", "public-model");
    expect(result.available).toBe(true);
    expect(result.source).toBe("account"); expect(result.version).toBe("account:1/master:0");
    expect(result.effective_policy?.group_ids).toEqual(["expensive", "cheap"]);
    expect(result.routes.map(r => r.service_group?.id)).toEqual(["expensive", "cheap"]);
    expect(result.identity).toBe("public:identity-public-model");
    expect(result.routes[0].price).toEqual({ pricing_mode: "priced", billing_unit: "token", input_price_per_m: 10, output_price_per_m: 30,
      cache_read_price_per_m: 2, cache_write_price_per_m: 4, price_per_call: 0, search_price_per_call: 0.1, multiplier: 1 });
    const serialized = JSON.stringify(result);
    for (const forbidden of ["sealed:", "DO_NOT_EXPOSE", "private-provider", "INTERNAL_PROVIDER", "upstream-internal", "provider_api_key", "provider_endpoint", "members", "config_json"]) expect(serialized).not.toContain(forbidden);
    expect(Object.keys(result.routes[0]).sort()).toEqual(["identity", "order", "price", "public_name", "service_group"]);
  });
  it("uses the shared input-price planner, not the stored group order", async () => {
    offer("expensive", "m1", { price: '{"input_price_per_m":20}' }); offer("cheap", "m1");
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "multi", group_ids: ["expensive", "cheap"], selection: "input_price" }));
    const result = await previewTokenRouting(env, device(), "master", "public-model");
    expect(result.available).toBe(true); expect(result.source).toBe("token");
    expect(result.routes.map(r => r.service_group?.id)).toEqual(["cheap", "expensive"]);
    expect(result.explanation).toContain("不保证总费用最低");
  });
  it("resolves a compatible alias to the same public identity", async () => {
    offer("g", "m1");
    d.sql("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES('g','old-name','map-g',1)");
    await putTokenRoutingPolicy(env, DEVICE_ID, "account", policy({ mode: "fixed", group_ids: ["g"] }));
    const result = await previewTokenRouting(env, device(), "account", "old-name");
    expect(result.available).toBe(true); expect(result.public_name).toBe("public-model");
    expect(result.identity).toBe("public:identity-public-model"); expect(result.explanation).toContain("兼容名");
  });
  it("cannot use a public directory name to bypass underlying account grants", async () => {
    offer("g", "m1"); d.sql("UPDATE devices SET model_scope='list' WHERE id=?", DEVICE_ID);
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "fixed", group_ids: ["g"] }));
    const denied = await previewTokenRouting(env, device(), "master", "public-model");
    expect(denied.available).toBe(false); expect(denied.routes).toEqual([]);
    seedDeviceModels(d, ["m1"]);
    expect((await previewTokenRouting(env, device(), "master", "public-model")).available).toBe(true);
  });
  it("replaces inherited policy as a whole while retaining device permissions and explicit token scope gates", async () => {
    offer("g", "m1");
    await putTokenRoutingPolicy(env, DEVICE_ID, "account", policy({ mode: "fixed", group_ids: ["g"], model_scope: [] }));
    await putTokenRoutingPolicy(env, DEVICE_ID, "child", policy({ mode: "fixed", group_ids: ["g"], model_scope: ["public:identity-public-model"] }));
    const scopedPreview = await previewTokenRouting(env, device(), "child", "public-model");
    expect(scopedPreview.available).toBe(true); expect(scopedPreview.source).toBe("token");
    d.sql("UPDATE devices SET model_scope='list' WHERE id=?", DEVICE_ID);
    expect((await previewTokenRouting(env, device(), "child", "public-model")).available).toBe(false);
    seedDeviceModels(d, ["m1"]);
    expect((await previewTokenRouting(env, device(), "child", "public-model")).available).toBe(true);
    await putTokenRoutingPolicy(env, DEVICE_ID, "child", policy({ mode: "fixed", group_ids: ["g"], model_scope: [] }));
    expect((await previewTokenRouting(env, device(), "child", "public-model")).available).toBe(false);
  });
  it.each(['{"input_price_per_m":-1}', '{"input_price_per_m":"2"}', '{invalid'])
    ("does not turn invalid configured quote %s into legacy success", async price => {
      seedModel(d, { id: "legacy", model_name: "public-model" }); offer("g", "m1", { price });
      await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy());
      const result = await previewTokenRouting(env, device(), "master", "public-model");
      expect(result.available).toBe(false); expect(result.legacy_fallback).toBe(false);
      expect(result.error).toBe("routing_unavailable"); expect(result.routes).toEqual([]);
      expect(result.explanation).toContain("不会把异常");
    });
  it("rejects an explicitly selected disabled service route rather than falling through", async () => {
    seedModel(d, { id: "legacy", model_name: "public-model" }); offer("g", "m1", { enabled: 0 });
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "fixed", group_ids: ["g"] }));
    const result = await previewTokenRouting(env, device(), "master", "public-model");
    expect(result.available).toBe(false); expect(result.legacy_fallback).toBe(false);
  });
  it("does not let an unrelated disabled group shadow actual authorized Auto legacy resolution", async () => {
    seedModel(d, { id: "legacy", model_name: "public-model" }); offer("g", "m1", { enabled: 0 });
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy());
    const result = await previewTokenRouting(env, device(), "master", "public-model");
    expect(result.available).toBe(true); expect(result.legacy_fallback).toBe(true);
    expect(result.identity).toBe("model:legacy");
  });
  it("actually resolves and authorizes Auto's legacy fallback including token scope", async () => {
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy());
    const good = await previewTokenRouting(env, device(), "master", "upstream-internal");
    expect(good.available).toBe(true); expect(good.legacy_fallback).toBe(true); expect(good.identity).toBe("model:m1");
    expect(good.routes[0].service_group).toBeNull();
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ model_scope: [] }));
    const scoped = await previewTokenRouting(env, device(), "master", "upstream-internal");
    expect(scoped.available).toBe(false); expect(scoped.error).toBe("model_not_in_scope");
    const missing = await previewTokenRouting(env, device(), "master", "only-in-imagination");
    expect(missing.available).toBe(false); expect(missing.error).toBe("model_not_found");
  });
  it("does not expose the number of same-name backend alternatives in legacy previews", async () => {
    seedModel(d, { id: "backend-second", model_name: "upstream-internal", input_price_per_m: 6 });
    seedModel(d, { id: "backend-third", model_name: "upstream-internal", input_price_per_m: 9 });
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "legacy" }));
    const result = await previewTokenRouting(env, device(), "master", "upstream-internal");
    expect(result.available).toBe(true); expect(result.routes).toHaveLength(1);
    expect(result.routes[0].service_group).toBeNull();
    expect(result.explanation).toContain("参考报价");
    expect(result.explanation).not.toContain("同名候选");
    expect(d.rows("SELECT id FROM models WHERE model_name = ?", "upstream-internal")).toHaveLength(3);
  });

  it("enforces legacy model grants and legacy group grants separately", async () => {
    d.sql("UPDATE devices SET model_scope='list' WHERE id=?", DEVICE_ID);
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "legacy" }));
    expect((await previewTokenRouting(env, device(), "master", "upstream-internal")).available).toBe(false);
    seedDeviceModels(d, ["m1"]);
    expect((await previewTokenRouting(env, device(), "master", "upstream-internal")).available).toBe(true);
    seedGroup(d, { id: "pool", name: "legacy-pool" }); seedGroupMembers(d, "pool", ["m1"]);
    expect((await previewTokenRouting(env, device(), "master", "legacy-pool")).available).toBe(false);
    seedDeviceGroups(d, ["pool"]);
    const result = await previewTokenRouting(env, device(), "master", "legacy-pool");
    expect(result.available).toBe(true); expect(result.identity).toBe("group:pool"); expect(result.legacy_fallback).toBe(false);
  });
  it("returns explicit unavailable for unpriced legacy targets and empty groups", async () => {
    seedModel(d, { id: "unpriced", model_name: "unpriced", pricing_mode: "unset" });
    seedGroup(d, { id: "empty", name: "empty" });
    for (const name of ["unpriced", "empty"]) {
      const result = await previewTokenRouting(env, device(), "master", name);
      expect(result.available).toBe(false); expect(result.error).toBe("routing_unavailable"); expect(result.routes).toEqual([]);
    }
  });
  it("reports call billing and current peak multiplier without multiplying search add-on", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-09T04:00:00Z"));
    seedModel(d, { id: "call", model_name: "call", billing_unit: "call", price_per_call: 0.5, peak_pricing_enabled: 1, search_price_per_call: 0.1 });
    d.sql("INSERT INTO price_windows(id,model_id,day_type,start_minute,end_minute,multiplier,enabled) VALUES('w','call','mon',0,1440,2,1)");
    offer("g", "call"); await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "fixed", group_ids: ["g"] }));
    const result = await previewTokenRouting(env, device(), "master", "public-model");
    expect(result.available).toBe(true); expect(result.routes[0].price).toMatchObject({ billing_unit: "call", price_per_call: 1, search_price_per_call: 0.1, multiplier: 2 });
  });
  it("keeps preview behind owner master authentication, a console session and owned live target checks", async () => {
    const secret = "routing-preview-owner-session"; env = { ...env, SESSION_SECRET: secret };
    offer("g", "m1");
    await putTokenRoutingPolicy(env, DEVICE_ID, "account", policy());
    for (const [id, owner, revoked] of [["owned", DEVICE_ID, null], ["foreign", "another-account", null], ["revoked", DEVICE_ID, 1]] as const) {
      d.sql("INSERT INTO device_sub_tokens(id,device_id,name,token_hash,enabled,created_at,revoked_at) VALUES(?,?,?,?,1,1,?)",
        id, owner, id, await sha256Hex("credential-" + id), revoked);
    }
    d.sql("UPDATE devices SET password_hash = ?, password_updated_at = 1 WHERE id = ?", await hashPassword("fixture-password"), DEVICE_ID);
    const cookie = buildUserSessionCookie(await signUserSession(secret, DEVICE_ID, 1)).split(";")[0];
    const request = (tokenId: string, opts: { cookie?: string; token?: string } = {}) => accountApp.request("http://test/routing-preview", {
      method: "POST", headers: { authorization: "Bearer " + (opts.token ?? TOKEN), cookie: opts.cookie ?? cookie, "content-type": "application/json" },
      body: JSON.stringify({ token_id: tokenId, model: "public-model" }),
    }, env);
    const fetcher = vi.fn(() => { throw new Error("owner preview must not fetch"); }); vi.stubGlobal("fetch", fetcher);
    expect((await request("account", { cookie: "" })).status).toBe(401);
    expect((await request("owned", { token: "credential-owned" })).status).toBe(403);
    expect((await request("foreign")).status).toBe(404);
    expect((await request("revoked")).status).toBe(409);
    for (const id of ["account", "master", "owned"]) {
      const response = await request(id); expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ available: true, public_name: "public-model" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never fetches, touches KV/RPM or changes wallet/holds/usage/ledger/policy state", async () => {
    const kv = makeKv(); env = makeEnv(d, kv);
    await ensureSchema(env); offer("g", "m1");
    await putTokenRoutingPolicy(env, DEVICE_ID, "master", policy({ mode: "fixed", group_ids: ["g"] }));
    const before = { wallet: wallet(d), holds: holdRows(d), usage: usageRows(d), ledger: ledgerRows(d),
      policies: d.rows("SELECT * FROM token_routing_policies ORDER BY token_id"), devices: d.rows("SELECT * FROM devices") };
    const fetcher = vi.fn(() => { throw new Error("preview must not fetch"); }); vi.stubGlobal("fetch", fetcher);
    expect((await previewTokenRouting(env, device(), "master", "public-model")).available).toBe(true);
    expect(fetcher).not.toHaveBeenCalled(); expect(kv.writes).toEqual([]);
    expect({ wallet: wallet(d), holds: holdRows(d), usage: usageRows(d), ledger: ledgerRows(d),
      policies: d.rows("SELECT * FROM token_routing_policies ORDER BY token_id"), devices: d.rows("SELECT * FROM devices") }).toEqual(before);
  });
});
