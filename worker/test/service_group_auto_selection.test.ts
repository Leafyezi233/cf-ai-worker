import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { accountApp } from "../src/console/account";
import * as repo from "../src/db/repo";
import { createServiceGroup } from "../src/db/service_groups";
import { resolveDevice } from "../src/gateway/auth";
import { buildUserSessionCookie, hashPassword, sha256Hex, signUserSession } from "../src/utils/crypto";
import type { AuthedDevice, Env } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, TOKEN, makeEnv, seedDevice } from "./helpers/realGatewayEnv";

let d1: RealD1;
let env: Env;
const SECRET = "auto-selection-session-secret";
beforeEach(async () => {
  d1 = createRealD1();
  env = { ...makeEnv(d1), SESSION_SECRET: SECRET };
  await seedDevice(d1);
  d1.sql("UPDATE devices SET password_hash = ?, password_updated_at = 1 WHERE id = ?", await hashPassword("fixture-password"), DEVICE_ID);
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });
async function request(path: string, body?: unknown, options: { method?: string; token?: string; session?: boolean } = {}) {
  const cookie = options.session === false ? "" : buildUserSessionCookie(await signUserSession(SECRET, DEVICE_ID, 1)).split(";")[0];
  return accountApp.request("http://test" + path, { method: options.method ?? "PUT", headers: {
    authorization: "Bearer " + (options.token ?? TOKEN), cookie, "content-type": "application/json",
  }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
}
function selections() {
  return d1.row<{ service_group_id: string | null; default_service_group_id: string | null }>(
    "SELECT service_group_id, default_service_group_id FROM devices WHERE id = ?", DEVICE_ID);
}
async function sub(id = "sub", owner = DEVICE_ID, selection: string | null = null) {
  const token = "credential-" + id;
  d1.sql("INSERT INTO device_sub_tokens (id, device_id, name, token_hash, enabled, created_at, service_group_id) VALUES (?, ?, ?, ?, 1, 1, ?)",
    id, owner, id, await sha256Hex(token), selection);
  return token;
}
async function authed(token: string): Promise<AuthedDevice> {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/", async c => c.json(await resolveDevice(c)));
  return (await app.request("http://test/", { headers: { authorization: "Bearer " + token } }, env)).json() as Promise<AuthedDevice>;
}

describe("console automatic service group selections", () => {
  it("stores legacy overrides for master and sub and previews without writes", async () => {
    await sub();
    expect((await request("/service-group", { default_service_group_id: "auto", service_group_id: "legacy" })).status).toBe(200);
    expect((await request("/tokens/sub/service-group", { service_group_id: "legacy" })).status).toBe(200);
    expect(await authed(TOKEN)).toMatchObject({ service_group_id: "legacy", default_service_group_id: "auto" });
    expect(await authed("credential-sub")).toMatchObject({ service_group_id: "legacy", default_service_group_id: "auto" });
    const projection = vi.spyOn(repo, "listModelProjectionsForDevice").mockResolvedValue([]);
    expect((await request("/service-groups/legacy/models", undefined, { method: "GET" })).status).toBe(200);
    expect(projection).toHaveBeenCalledWith(env, expect.objectContaining({ service_group_id: "legacy" }));
    expect(selections()).toEqual({ default_service_group_id: "auto", service_group_id: "legacy" });
    expect((await request("/service-group", { default_service_group_id: "legacy" })).status).toBe(200);
  });
  it("stores exact auto independently in account default and master columns", async () => {
    expect((await request("/service-group", { default_service_group_id: "auto", service_group_id: "auto" })).status).toBe(200);
    expect(selections()).toEqual({ default_service_group_id: "auto", service_group_id: "auto" });
    expect((await request("/service-group", { service_group_id: null })).status).toBe(200);
    expect(selections()).toEqual({ default_service_group_id: "auto", service_group_id: null });
    expect((await request("/service-group", { default_service_group_id: null })).status).toBe(200);
    expect(selections()).toEqual({ default_service_group_id: null, service_group_id: null });
  });

  it("keeps explicit auto distinct from null inheritance with a fixed account default", async () => {
    const group = await createServiceGroup(env, { name: "fixed", public_selectable: 1 });
    await sub();
    expect((await request("/service-group", { default_service_group_id: group.id, service_group_id: "auto" })).status).toBe(200);
    expect((await request("/tokens/sub/service-group", { service_group_id: "auto" })).status).toBe(200);
    expect(await authed(TOKEN)).toMatchObject({ service_group_id: "auto", default_service_group_id: group.id });
    expect(await authed("credential-sub")).toMatchObject({ service_group_id: "auto", default_service_group_id: group.id });
    await request("/tokens/sub/service-group", { service_group_id: null });
    expect(await authed("credential-sub")).toMatchObject({ service_group_id: null, default_service_group_id: group.id });
    expect(selections()).toEqual({ service_group_id: "auto", default_service_group_id: group.id });
    await request("/service-group", { service_group_id: null });
    expect(await authed(TOKEN)).toMatchObject({ service_group_id: null, default_service_group_id: group.id });
  });

  it("creates sub-tokens with explicit auto or null without changing the account", async () => {
    for (const service_group_id of ["auto", null]) {
      const response = await request("/tokens", { name: "new", service_group_id }, { method: "POST" });
      expect(response.status).toBe(201);
      const body = await response.json() as { item: { id: string; service_group_id: string | null } };
      expect(body.item.service_group_id).toBe(service_group_id);
      expect(d1.row("SELECT service_group_id FROM device_sub_tokens WHERE id = ?", body.item.id)).toEqual({ service_group_id });
    }
    expect(selections()).toEqual({ service_group_id: null, default_service_group_id: null });
  });

  it("lists real groups only while returning saved auto and null selections unchanged", async () => {
    const group = await createServiceGroup(env, { name: "real", public_selectable: 1 });
    await sub("sub", DEVICE_ID, "auto");
    await request("/service-group", { default_service_group_id: "auto" });
    const response = await request("/service-groups", undefined, { method: "GET", session: false });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ id: string }> };
    expect(body.items.map(item => item.id)).toEqual([group.id]);
    expect(body).toMatchObject({ service_group_id: null,
      default_service_group_id: "auto", sub_tokens: [{ id: "sub", service_group_id: "auto" }] });
  });

  it.each(["AUTO", " auto", "auto ", "missing"])("does not treat %j as the sentinel, and validates the entire account patch", async value => {
    expect((await request("/service-group", { default_service_group_id: "auto", service_group_id: value })).status).toBe(403);
    expect(selections()).toEqual({ default_service_group_id: null, service_group_id: null });
    await sub();
    expect((await request("/tokens/sub/service-group", { service_group_id: value })).status).toBe(403);
    expect(d1.row("SELECT service_group_id FROM device_sub_tokens WHERE id = 'sub'")).toEqual({ service_group_id: null });
  });

  it("previews virtual auto via the real projection entry point without mutating selections or leaking internals", async () => {
    d1.sql("UPDATE devices SET default_service_group_id = 'fixed', service_group_id = 'master-fixed' WHERE id = ?", DEVICE_ID);
    await sub("sub", DEVICE_ID, "sub-fixed");
    const projection = vi.spyOn(repo, "listModelProjectionsForDevice").mockResolvedValue([{
      id: "preview", model_name: "visible", input_price_per_m: 2, output_price_per_m: 5,
      provider_api_key: "secret-key", provider_endpoint: "https://private.invalid", config_json: "secret-config",
    } as unknown as repo.ModelProjectionRow]);
    const response = await request("/service-groups/auto/models", undefined, { method: "GET", session: false });
    expect(response.status).toBe(200);
    expect(projection).toHaveBeenCalledWith(env, expect.objectContaining({ service_group_id: "auto", default_service_group_id: "fixed" }));
    const body = await response.json();
    expect(body).toMatchObject({ service_group_id: "auto", model_count: 1, items: [{ model_name: "visible", input_price_per_m: 2 }] });
    for (const secret of ["secret-key", "private.invalid", "secret-config", "provider_api_key", "config_json"]) {
      expect(JSON.stringify(body)).not.toContain(secret);
    }
    expect(selections()).toEqual({ service_group_id: "master-fixed", default_service_group_id: "fixed" });
    expect(d1.row("SELECT service_group_id FROM device_sub_tokens WHERE id = 'sub'")).toEqual({ service_group_id: "sub-fixed" });
  });

  it.each(["auto", "legacy"])("requires password session and master token for all %s writes and master token for preview", async selection => {
    const token = await sub();
    for (const [path, body, method] of [
      ["/service-group", { default_service_group_id: selection, service_group_id: selection }, "PUT"],
      ["/tokens/sub/service-group", { service_group_id: selection }, "PUT"],
      ["/tokens", { name: "new", service_group_id: selection }, "POST"],
    ] as const) {
      expect((await request(path, body, { session: false, method })).status).toBe(401);
      expect((await request(path, body, { token, method })).status).toBe(403);
    }
    expect((await request("/service-groups/auto/models", undefined, { token, method: "GET" })).status).toBe(403);
    expect((await request("/service-groups", undefined, { token, method: "GET" })).status).toBe(403);
    expect(selections()).toEqual({ default_service_group_id: null, service_group_id: null });
  });

  it("cannot use auto to update another owner's or revoked sub-token", async () => {
    await seedDevice(d1, { id: "other", token_hash: await sha256Hex("other-token") });
    await sub("foreign", "other");
    await sub("revoked");
    d1.sql("UPDATE device_sub_tokens SET revoked_at = 1 WHERE id = 'revoked'");
    expect((await request("/tokens/foreign/service-group", { service_group_id: "auto" })).status).toBe(404);
    expect((await request("/tokens/revoked/service-group", { service_group_id: "auto" })).status).toBe(409);
    expect(d1.rows("SELECT service_group_id FROM device_sub_tokens")).toEqual([{ service_group_id: null }, { service_group_id: null }]);
  });
});
