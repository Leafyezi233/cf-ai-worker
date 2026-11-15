import { afterEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";
import { app } from "../src/index";
import { makeWalletFixture } from "./helpers/walletFixture";
import { sha256Hex } from "../src/utils/crypto";

afterEach(() => vi.restoreAllMocks());

describe("mounted Worker preserves explicit HTTP errors without leaking runtime details", () => {
  it("returns missing private reference binding as JSON 503, not 500", async () => {
    const f = await makeWalletFixture();
    const r = await app.request("https://gateway.test/v1/video/reference-images", {method:"POST"}, f.env);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({error:"video_references_unavailable"});
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("preserves unauthenticated 401 through the real parent mount", async () => {
    const f = await makeWalletFixture();
    f.env.VIDEO_REFERENCES = {} as R2Bucket;
    const r = await app.request("https://gateway.test/v1/video/reference-images", {method:"POST",body:"x"}, f.env);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({error:"unauthorized"});
  });

  it("preserves unsupported content 415 and length-required 411 without storage writes", async () => {
    const f = await makeWalletFixture();
    f.env.VIDEO_REFERENCES = {} as R2Bucket;
    f.d1.sql("UPDATE devices SET token_hash=? WHERE id=?",await sha256Hex("test-http-errors"),"dev-1");
    for (const [type,status,code] of [["text/plain",415,"unsupported_reference_content_type"],["image/png",411,"reference_content_length_required"]] as const) {
      const r=await app.request("https://gateway.test/v1/video/reference-images",{method:"POST",headers:{authorization:"Bearer test-http-errors","content-type":type},body:"x"},f.env);
      expect(r.status).toBe(status);
      expect(await r.json()).toEqual({error:code});
    }
    expect(f.d1.row<{n:number}>("SELECT COUNT(*) AS n FROM video_reference_assets")!.n).toBe(0);
  });

  it("serializes only the intentional error, not its private cause or attached response", async () => {
    const f=await makeWalletFixture();
    Object.defineProperty(f.env,"VIDEO_REFERENCES",{get(){throw new HTTPException(429,{message:"reference_upload_busy",cause:new Error("private-d1-cause"),res:new Response("private-body",{status:429,headers:{"x-secret":"private-header"}})});}});
    const r=await app.request("https://gateway.test/v1/video/reference-images",{method:"POST"},f.env);
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({error:"reference_upload_busy"});
    expect(r.headers.has("x-secret")).toBe(false);
  });

  it.each(["D1_ERROR: no such table private_table", "R2 private object key and credentials"])("keeps unknown runtime errors opaque: %s", async (message) => {
    const f=await makeWalletFixture();
    vi.spyOn(console,"error").mockImplementation(()=>{});
    Object.defineProperty(f.env,"VIDEO_REFERENCES",{get(){throw Object.assign(new Error(message),{status:429});}});
    const r=await app.request("https://gateway.test/v1/video/reference-images",{method:"POST"},f.env);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({error:"internal_server_error"});
  });
});
