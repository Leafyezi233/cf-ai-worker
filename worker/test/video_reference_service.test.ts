import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AuthedDevice, Env } from "../src/types";
import { bindServiceImageIds, deleteServiceReferenceImage, referenceServiceOwner, uploadServiceReferenceImage, validateServiceImageIds } from "../src/gateway/video_reference_service";
import { sha256Hex } from "../src/utils/crypto";
import { makeWalletFixture } from "./helpers/walletFixture";

const ID = "a".repeat(32);
const OTHER_ID = "b".repeat(32);
const MAX = 5 * 1024 * 1024;
const ORIGIN = "https://references.example.com";
const master = { id: "dev-1", auth_via: "master", sub_token_id: null } as AuthedDevice;
const sub = { ...master, auth_via: "sub", sub_token_id: "sub-1" } as AuthedDevice;
const sibling = { ...sub, sub_token_id: "sub-2" } as AuthedDevice;
const foreign = { ...master, id: "other" } as AuthedDevice;
const metadata = (patch: Record<string, unknown> = {}) => ({ id: ID, bytes: 4, content_type: "image/png", expires_at: Math.floor(Date.now() / 1000) + 3600, ...patch });

let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  network = vi.fn(() => { throw new Error("Public network is forbidden in reference service tests"); });
  vi.stubGlobal("fetch", network);
});
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup() {
  const f = await makeWalletFixture({ deviceIds: ["dev-1", "other"] });
  for (const [id, token] of [["dev-1", "master"], ["other", "other-master"]]) {
    f.d1.sql("UPDATE devices SET token_hash = ? WHERE id = ?", await sha256Hex(token), id);
  }
  for (const [id, token] of [["sub-1", "sub"], ["sub-2", "sibling"]]) {
    f.d1.sql("INSERT INTO device_sub_tokens(id,device_id,name,token_hash,created_at) VALUES (?, 'dev-1', ?, ?, 1)", id, id, await sha256Hex(token));
  }
  const serviceFetch = vi.fn(async (_req: Request) => Response.json(metadata()));
  f.env.VIDEO_REFERENCE_IMAGES = { fetch: serviceFetch } as unknown as Fetcher;
  f.env.VIDEO_REFERENCE_IMAGE_ORIGIN = ORIGIN;
  const app = new Hono<{ Bindings: Env }>();
  app.post("/video/reference-images", uploadServiceReferenceImage);
  app.delete("/video/reference-images/:id", deleteServiceReferenceImage);
  const upload = (body = new Uint8Array([1, 2, 3, 4]), headers: Record<string, string> = {}, token = "master") => app.request(
    "https://gateway.test/video/reference-images",
    { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "image/png", "content-length": String(body.length), ...headers }, body }, f.env);
  const remove = (token = "master", id = ID, headers: Record<string, string> = {}) => app.request(
    "https://gateway.test/video/reference-images/" + id,
    { method: "DELETE", headers: { authorization: "Bearer " + token, ...headers } }, f.env);
  return { ...f, app, upload, remove, serviceFetch };
}

async function expectFailure(work: Promise<unknown>, status: number, message: string) {
  await expect(work).rejects.toMatchObject({ status, message });
}

async function bindReply(req: Request, patch: Record<string, unknown> = {}) {
  const body = await req.clone().json() as { expires_at: number };
  return Response.json({ id: ID, url: ORIGIN + "/assets/" + ID + "?signature=opaque", expires_at: body.expires_at, ...patch });
}

describe("video reference Service binding: real SQLite authentication and no public fetch", () => {
  it.each(["", "wrong"])("requires real authentication (%s)", async token => {
    const f = await setup();
    expect((await f.upload(undefined, {}, token)).status).toBe(401);
    expect((await f.remove(token)).status).toBe(401);
    expect(f.serviceFetch).not.toHaveBeenCalled();
  });

  it("fails closed without the binding even if an explicit public origin exists", async () => {
    const f = await setup(); delete f.env.VIDEO_REFERENCE_IMAGES;
    expect((await f.upload()).status).toBe(503);
    expect((await f.remove()).status).toBe(503);
    await expectFailure(validateServiceImageIds(f.env, master, [ID]), 503, "reference_service_unavailable");
    await expectFailure(bindServiceImageIds(f.env, master, [ID], "vid_" + crypto.randomUUID()), 503, "reference_service_unavailable");
  });

  it.each(["image/png", "image/jpeg", "image/webp"])("forwards authenticated binary %s and returns metadata only", async type => {
    const f = await setup();
    const expected = metadata({ content_type: type });
    f.serviceFetch.mockImplementation(async () => Response.json({ ...expected, url: "https://secret.example/image", owner: "private-owner", internal: "secret" }));
    const response = await f.upload(undefined, { "content-type": type, "x-cpg-owner": "attacker" });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(expected);
    const req = f.serviceFetch.mock.calls[0][0];
    expect(req.url).toBe("https://reference-images.internal/v1/assets");
    expect(req.redirect).toBe("manual");
    expect(req.headers.get("x-cpg-owner")).toBe(JSON.stringify(["dev-1", null]));
    expect(req.headers.get("authorization")).toBeNull();
    expect(req.headers.get("content-type")).toBe(type);
    expect(req.headers.get("content-length")).toBe("4");
    expect(new Uint8Array(await req.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it.each(["application/json", "multipart/form-data; boundary=x", "image/gif", "image/svg+xml", "text/plain", ""])("rejects unsupported upload type %s before calling service", async type => {
    const f = await setup(); expect((await f.upload(undefined, { "content-type": type })).status).toBe(415);
    expect(f.serviceFetch).not.toHaveBeenCalled();
  });

  it("requires Content-Length on public binary uploads", async () => {
    const f = await setup();
    const response = await f.app.request("https://gateway.test/video/reference-images", { method: "POST", headers: { authorization: "Bearer master", "content-type": "image/png" }, body: new Uint8Array([1]) }, f.env);
    expect(response.status).toBe(411); expect(f.serviceFetch).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5", "1e2", "nope", "9007199254740992", String(MAX + 1)])("rejects invalid or excessive declared length %s", async length => {
    const f = await setup(); expect((await f.upload(undefined, { "content-length": length })).status).toBe(413);
    expect(f.serviceFetch).not.toHaveBeenCalled();
  });

  it("accepts exactly 5 MiB but rejects overflow and mismatched actual bytes", async () => {
    const f = await setup(); f.serviceFetch.mockImplementation(async () => Response.json(metadata({ bytes: MAX })));
    expect((await f.upload(new Uint8Array(MAX))).status).toBe(201);
    expect((await f.upload(new Uint8Array(MAX + 1))).status).toBe(413);
    expect((await f.upload(undefined, { "content-length": "3" })).status).toBe(413);
    expect((await f.upload(undefined, { "content-length": "5" })).status).toBe(400);
    expect(f.serviceFetch).toHaveBeenCalledTimes(1);
  });

  it.each([[404, "video_reference_not_found"], [409, "video_reference_bound"], [429, "reference_service_quota_exceeded"], [500, "reference_service_unavailable"], [302, "reference_service_unavailable"]] as const)("never exposes service error bodies (%s)", async (status, code) => {
    const f = await setup(); f.serviceFetch.mockImplementation(async () => new Response("PRIVATE_SERVICE_ERROR token=secret", { status, headers: { location: "https://attacker.example" } }));
    const response = await f.upload(); expect(response.status).toBe(status === 500 || status === 302 ? 503 : status);
    expect(await response.text()).toBe(code);
  });

  it.each(["malformed-json", "oversized", "throw"])("bounds and sanitizes service response %s", async kind => {
    const f = await setup(); f.serviceFetch.mockImplementation(async () => {
      if (kind === "throw") throw new Error("PRIVATE_SERVICE_SECRET");
      return new Response(kind === "oversized" ? "x".repeat(8193) : "PRIVATE_SERVICE_SECRET");
    });
    const response = await f.upload(); expect(response.status).toBe(503); expect(await response.text()).not.toContain("PRIVATE_SERVICE_SECRET");
  });

  it("derives exact independent master, sibling sub-token and other-device principals for every operation", async () => {
    const f = await setup();
    const owners = new Map([["master", master], ["sub", sub], ["sibling", sibling], ["other-master", foreign]]);
    for (const [token, device] of owners) {
      const owner = JSON.stringify([device.id, device.auth_via === "sub" ? device.sub_token_id : null]);
      expect(referenceServiceOwner(device)).toBe(owner);
      f.serviceFetch.mockImplementation(async () => Response.json(metadata()));
      expect((await f.upload(undefined, { "x-cpg-owner": "forged" }, token)).status).toBe(201);
      expect(f.serviceFetch.mock.lastCall![0].headers.get("x-cpg-owner")).toBe(owner);
      expect(f.serviceFetch.mock.lastCall![0].headers.get("x-cpg-account")).toBe(device.id);
      await validateServiceImageIds(f.env, device, [ID]);
      expect(new URL(f.serviceFetch.mock.lastCall![0].url).searchParams.get("owner")).toBe(owner);
      f.serviceFetch.mockImplementation(req => bindReply(req));
      await bindServiceImageIds(f.env, device, [ID], "vid_" + crypto.randomUUID());
      expect(await f.serviceFetch.mock.lastCall![0].json()).toMatchObject({ owner });
      f.serviceFetch.mockImplementation(async () => Response.json({ deleted: true, secret: "private" }));
      const deleted = await f.remove(token, ID, { "x-cpg-owner": "forged" });
      expect(deleted.status).toBe(200); expect(deleted.headers.get("cache-control")).toBe("no-store");
      expect(await deleted.json()).toEqual({ deleted: true });
      const req = f.serviceFetch.mock.lastCall![0]; expect(req.method).toBe("DELETE"); expect(await req.json()).toEqual({ owner });
    }
    expect(new Set([...owners.values()].map(referenceServiceOwner)).size).toBe(4);
    expect(referenceServiceOwner({ ...master, id: "a:b" })).not.toBe(referenceServiceOwner({ ...sub, id: "a", sub_token_id: "b" }));
  });

  it("keeps a sub-token asset inaccessible to master, sibling and other-device principals", async () => {
    const f = await setup();
    const assetOwner = JSON.stringify(["dev-1", "sub-1"]);
    f.serviceFetch.mockImplementation(async req => {
      const url = new URL(req.url);
      const owner = req.method === "GET" ? url.searchParams.get("owner") : (await req.clone().json() as { owner: string }).owner;
      if (owner !== assetOwner) return new Response("PRIVATE_OWNER_INFORMATION", { status: 404 });
      if (req.method === "DELETE") return Response.json({ deleted: true });
      if (req.method === "POST") return bindReply(req);
      return Response.json(metadata());
    });
    for (const device of [master, sibling, foreign]) {
      await expectFailure(validateServiceImageIds(f.env, device, [ID]), 404, "video_reference_not_found");
      await expectFailure(bindServiceImageIds(f.env, device, [ID], "vid_" + crypto.randomUUID()), 404, "video_reference_not_found");
    }
    for (const token of ["master", "sibling", "other-master"]) {
      const response = await f.remove(token, ID, { "x-cpg-owner": assetOwner });
      expect(response.status).toBe(404); expect(await response.text()).toBe("video_reference_not_found");
    }
    await validateServiceImageIds(f.env, sub, [ID]);
    expect(await bindServiceImageIds(f.env, sub, [ID], "vid_" + crypto.randomUUID())).toHaveLength(1);
    expect((await f.remove("sub", ID, { "x-cpg-owner": "forged" })).status).toBe(200);
  });

  it.each([{}, { deleted: false }, { deleted: 1 }, { ok: true }, null])("requires the explicit deleted:true service contract (%j)", async result => {
    const f = await setup(); f.serviceFetch.mockImplementation(async () => Response.json(result));
    expect((await f.remove()).status).toBe(503);
  });

  it("rejects malformed delete IDs before calling the service", async () => {
    const f = await setup(); expect((await f.remove("master", "not-an-id")).status).toBe(400); expect(f.serviceFetch).not.toHaveBeenCalled();
  });
});

describe("reference validation and trusted provider URLs", () => {
  it.each([[ID, ID], Array.from({ length: 10 }, (_, i) => i.toString(16).padStart(32, "0")), ["A".repeat(32)], ["a".repeat(31)], ["../assets/" + ID], ["https://attacker.example/image"], [null], "not-an-array"].map(ids => [ids]))("rejects invalid, duplicated or unbounded ID collections %j", async ids => {
    const f = await setup();
    await expectFailure(validateServiceImageIds(f.env, master, ids as string[]), 400, "invalid_video_references");
    await expectFailure(bindServiceImageIds(f.env, master, ids as string[], "vid_" + crypto.randomUUID()), 400, "invalid_video_references");
    expect(f.serviceFetch).not.toHaveBeenCalled();
  });

  it("permits no-reference requests without a configured image service or origin", async () => {
    const f = await setup(); delete f.env.VIDEO_REFERENCE_IMAGES; delete f.env.VIDEO_REFERENCE_IMAGE_ORIGIN;
    await validateServiceImageIds(f.env, master, []);
    expect(await bindServiceImageIds(f.env, master, [], "vid_" + crypto.randomUUID())).toEqual([]);
    expect(f.serviceFetch).not.toHaveBeenCalled();
  });

  it("validates up to nine distinct assets with exact requested IDs", async () => {
    const f = await setup(); const ids = Array.from({ length: 9 }, (_, i) => i.toString(16).padStart(32, "0"));
    f.serviceFetch.mockImplementation(async req => Response.json(metadata({ id: new URL(req.url).pathname.split("/").at(-1) })));
    await validateServiceImageIds(f.env, master, ids);
    expect(f.serviceFetch).toHaveBeenCalledTimes(9);
    expect(f.serviceFetch.mock.calls.map(([req]) => new URL(req.url).pathname)).toEqual(ids.map(id => "/v1/assets/" + id));
  });

  it.each([null, { id: OTHER_ID }, { bytes: 0 }, { bytes: MAX + 1 }, { bytes: 1.5 }, { bytes: "4" }, { content_type: "image/svg+xml" }, { expires_at: 0 }, { expires_at: "9999999999" }, { expires_at: 1.5 }])("rejects malformed metadata %j", async patch => {
    const f = await setup(); f.serviceFetch.mockImplementation(async () => Response.json(patch === null ? null : metadata(patch)));
    await expectFailure(validateServiceImageIds(f.env, master, [ID]), 503, "invalid_reference_service_result");
    expect((await f.upload()).status).toBe(patch && "id" in patch ? 201 : 503);
  });

  it.each([undefined, "http://references.example.com", "https://user:pass@references.example.com", "https://references.example.com/base", "https://references.example.com/?x=y", "https://references.example.com/#x", "https://references.example.com:444", "https://127.0.0.1", "https://localhost", "https://foo.internal", "https://foo.local", "https://foo.lan"])("requires an explicit trusted HTTPS origin %s", async origin => {
    const f = await setup(); f.env.VIDEO_REFERENCE_IMAGE_ORIGIN = origin;
    await expectFailure(bindServiceImageIds(f.env, master, [ID], "vid_" + crypto.randomUUID()), 503, "reference_origin_unavailable"); expect(f.serviceFetch).not.toHaveBeenCalled();
  });

  it("binds the actual local vid_UUID format for exactly 24 hours and preserves ID order", async () => {
    const f = await setup(); const taskId = "vid_" + crypto.randomUUID(); const before = Math.floor(Date.now() / 1000);
    f.serviceFetch.mockImplementation(async req => {
      const body = await req.clone().json() as { expires_at: number; task_id: string; owner: string };
      expect(body.task_id).toBe(taskId); expect(body.owner).toBe(JSON.stringify(["dev-1", null]));
      expect(body.expires_at).toBeGreaterThanOrEqual(before + 86400); expect(body.expires_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 86400);
      const id = new URL(req.url).pathname.split("/")[3];
      return Response.json({ id, expires_at: body.expires_at, url: ORIGIN + "/assets/" + id + "?sig=opaque" });
    });
    expect(await bindServiceImageIds(f.env, master, [OTHER_ID, ID], taskId)).toEqual([OTHER_ID, ID].map(id => ORIGIN + "/assets/" + id + "?sig=opaque"));
    expect(f.serviceFetch.mock.calls.every(([req]) => req.method === "POST" && req.redirect === "manual")).toBe(true);
  });

  it.each(["", crypto.randomUUID(), "vid_short", "vid_../../secret", "vid_" + "a".repeat(161)])("rejects non-local or unsafe task ID %s", async taskId => {
    const f = await setup(); await expectFailure(bindServiceImageIds(f.env, master, [ID], taskId), 400, "invalid_video_task"); expect(f.serviceFetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://references.example.com/assets/" + ID,
    "https://attacker.example/assets/" + ID,
    "https://references.example.com.attacker.example/assets/" + ID,
    "https://user:pass@references.example.com/assets/" + ID,
    ORIGIN + "/assets/" + OTHER_ID,
    ORIGIN + "/assets/%" + "61".repeat(32),
    ORIGIN + "/assets/" + ID + "/extra",
    ORIGIN + "/assets/" + ID + "#fragment",
    ORIGIN + "/assets/" + ID + "?" + "x".repeat(2048),
    "javascript:alert(1)", "//attacker.example/image", "/assets/" + ID,
  ])("rejects injected or mismatched bound URL %s", async url => {
    const f = await setup(); f.serviceFetch.mockImplementation(req => bindReply(req, { url }));
    await expectFailure(bindServiceImageIds(f.env, master, [ID], "vid_" + crypto.randomUUID()), 503, "invalid_reference_service_result");
  });

  it.each([{ id: OTHER_ID }, { expires_at: 0 }, { expires_at: "9999999999" }, { url: null }, { url: {} }])("rejects malformed bind result fields %j", async patch => {
    const f = await setup(); f.serviceFetch.mockImplementation(req => bindReply(req, patch));
    await expectFailure(bindServiceImageIds(f.env, master, [ID], "vid_" + crypto.randomUUID()), 503, "invalid_reference_service_result");
  });
});
