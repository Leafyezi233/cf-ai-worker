import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { findModelCandidateMetadata, findModelCandidates, getModelWithProviderById } from "../src/db/repo";
import { sealSecret } from "../src/utils/crypto";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import type { Env } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { ensureSchema } from "../src/db/schema";
import { CollectingExecutionContext, DEVICE_ID, chatBody, makeEnv, makeKv, openAiAnswer, postJson,
  seedDevice, seedModel, seedProvider } from "./helpers/realGatewayEnv";

let d1: RealD1;
let env: Env;
let decrypt: MockInstance<typeof crypto.subtle.decrypt>;
beforeEach(async () => {
  resetRateLimitMemory();
  clearMemoryCacheForTest();
  d1 = createRealD1();
  env = makeEnv(d1, makeKv());
  await ensureSchema(env);
  env.ENCRYPTION_KEY = "synthetic-legacy-lazy-key-test-only";
  await seedDevice(d1, { balance_usd: 100 });
  for (const id of ["a", "b", "c"]) {
    seedProvider(d1, { id: "p-" + id, endpoint: "https://" + id + ".example/v1",
      api_key: await sealSecret("sk-test-" + id, env.ENCRYPTION_KEY) });
    seedModel(d1, { id, provider_id: "p-" + id, model_name: "shared" });
  }
  decrypt = vi.spyOn(crypto.subtle, "decrypt");
});
afterEach(() => { vi.restoreAllMocks(); d1.close(); });

function upstream(failures = 0) {
  const headers: string[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    headers.push(new Headers(init?.headers).get("authorization") || "");
    return headers.length <= failures ? new Response("busy", { status: 503 }) : openAiAnswer();
  });
  return { headers, fetch };
}
async function request(path = "/chat/completions") {
  const exec = new CollectingExecutionContext();
  const response = await postJson(env, path, chatBody("shared"), exec);
  const text = await response.text();
  await Promise.all(exec.pending);
  return { response, text };
}

describe("legacy candidate keys are request-local and opened only for attempts", () => {
  it("keeps metadata sealed and preserves existing eager repository caller contracts", async () => {
    const metadata = await findModelCandidateMetadata(env, "shared");
    expect(decrypt).not.toHaveBeenCalled();
    expect(metadata).toHaveLength(3);
    expect(metadata.every((row) => row.provider_api_key !== "sk-test-" + row.id)).toBe(true);
    const opened = await findModelCandidates(env, "shared");
    expect(decrypt).toHaveBeenCalledTimes(3);
    expect(opened.map((row) => row.provider_api_key).sort()).toEqual(["sk-test-a", "sk-test-b", "sk-test-c"]);
    expect((await getModelWithProviderById(env, "a"))?.provider_api_key).toBe("sk-test-a");
    expect(decrypt).toHaveBeenCalledTimes(4);
  });

  it("opens only the successful primary and does not retain plaintext between requests", async () => {
    const calls = upstream();
    expect((await request()).response.status).toBe(200);
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(calls.headers).toEqual(["Bearer sk-test-a"]);
    expect((await request()).response.status).toBe(200);
    expect(decrypt).toHaveBeenCalledTimes(2);
  });

  it("does not open any credential when scope rejects the request", async () => {
    d1.sql("UPDATE devices SET model_scope = 'list' WHERE id = ?", DEVICE_ID);
    const calls = upstream();
    const { response, text } = await request();
    expect(response.status, text).toBe(403);
    expect(decrypt).not.toHaveBeenCalled();
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it("does not open any credential when protocol rejects the request", async () => {
    const calls = upstream();
    const { response, text } = await request("/messages");
    expect(response.status, text).toBe(400);
    expect(decrypt).not.toHaveBeenCalled();
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it("does not open any credential when pricing rejects the request", async () => {
    d1.sql("UPDATE models SET pricing_mode = 'unset'");
    const calls = upstream();
    expect((await request()).response.status).toBe(400);
    expect(decrypt).not.toHaveBeenCalled();
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it("does not open any credential on a legacy response cache hit", async () => {
    d1.sql("UPDATE models SET cache_enabled = 1");
    const calls = upstream();
    expect((await request()).response.status).toBe(200);
    expect(decrypt).toHaveBeenCalledTimes(1);
    decrypt.mockClear();
    const { response, text } = await request();
    expect(response.status, text).toBe(200);
    expect(response.headers.get("x-cache")).toBe("HIT");
    expect(decrypt).not.toHaveBeenCalled();
    expect(calls.fetch).toHaveBeenCalledTimes(1);
  });

  it("opens only candidates actually reached by failover", async () => {
    const calls = upstream(1);
    const { response, text } = await request();
    expect(response.status, text).toBe(200);
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(calls.headers).toEqual(["Bearer sk-test-a", "Bearer sk-test-b"]);
    expect(response.headers.get("x-gateway-attempts")).toBe("2");
  });

  it("opens an explicit fallback only when it is attempted", async () => {
    d1.sql("UPDATE models SET model_name = 'emergency' WHERE id = 'c'");
    d1.sql("UPDATE models SET enabled = 0 WHERE id = 'b'");
    d1.sql("UPDATE models SET fallback_model_id = 'c' WHERE id = 'a'");
    const calls = upstream(1);
    const { response, text } = await request();
    expect(response.status, text).toBe(200);
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(calls.headers).toEqual(["Bearer sk-test-a", "Bearer sk-test-c"]);
  });

  it("deduplicates opening a credential reused by the explicit fallback without changing retries", async () => {
    d1.sql("UPDATE models SET enabled = 0 WHERE id != 'a'");
    d1.sql("UPDATE models SET fallback_model_id = 'a' WHERE id = 'a'");
    const calls = upstream(1);
    const { response, text } = await request();
    expect(response.status, text).toBe(200);
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(calls.headers).toEqual(["Bearer sk-test-a", "Bearer sk-test-a"]);
    expect(response.headers.get("x-gateway-attempts")).toBe("2");
  });

  it("does not open an incompatible explicit fallback", async () => {
    d1.sql("UPDATE models SET enabled = 0 WHERE id = 'b'");
    d1.sql("UPDATE models SET model_name = 'emergency' WHERE id = 'c'");
    d1.sql("UPDATE providers SET type = 'anthropic' WHERE id = 'p-c'");
    d1.sql("UPDATE models SET fallback_model_id = 'c' WHERE id = 'a'");
    const calls = upstream(1);
    expect((await request()).response.status).toBe(502);
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(calls.headers).toEqual(["Bearer sk-test-a"]);
  });
});
