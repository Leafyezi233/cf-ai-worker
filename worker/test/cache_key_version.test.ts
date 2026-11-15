import { beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_KEY_PREFIX,
  computeCacheKey,
  getCachedEntry,
  setCachedEntry,
  purgeCache,
  clearMemoryCacheForTest,
  type CachePayload,
} from "../src/gateway/cache";
import type { Env } from "../src/types";


function payload(model: string): CachePayload {
  return {
    kind: "messages",
    model,
    jsonBody: { content: [{ type: "text", text: "cached" }] },
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    createdAt: 1,
  };
}

function kvEnv() {
  const store = new Map<string, string>();
  const deleted: string[] = [];
  const kv = {
    get: async (k: string) => {
      const raw = store.get(k);
      return raw ? JSON.parse(raw) : null;
    },
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      return { keys: Array.from(store.keys()).filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
    delete: async (k: string) => {
      deleted.push(k);
      store.delete(k);
    },
  };
  return { env: { CACHE_KV: kv } as unknown as Env, store, deleted };
}

describe("cache key versioning", () => {
  beforeEach(() => {
    clearMemoryCacheForTest();
  });

  it("stamps the version segment on every generated key", async () => {
    const key = await computeCacheKey("chat/completions", "gpt-4o", { messages: [{ role: "user", content: "hi" }] }, "dev_1");
    expect(key?.startsWith("aigw:cache:v3:")).toBe(true);
    expect(key?.startsWith(CACHE_KEY_PREFIX)).toBe(true);
    expect(key).toContain(":chat/completions:gpt-4o:");
  });

  it("purges the older-version entries still sitting in KV, not just the current ones", async () => {
    const { env, store, deleted } = kvEnv();
    const legacy = "aigw:cache:messages:claude-3-5-sonnet-20241022:legacyhash";
    const v2 = "aigw:cache:v2:messages:claude-3-5-sonnet-20241022:v2hash";
    const current = "aigw:cache:v3:messages:claude-3-5-sonnet-20241022:currenthash";
    for (const k of [legacy, v2, current]) store.set(k, JSON.stringify(payload("claude-3-5-sonnet-20241022")));

    const res = await purgeCache(env, { model: "claude-3-5-sonnet-20241022" });

    expect(res.ok).toBe(true);
    expect(store.has(legacy)).toBe(false);
    expect(store.has(v2)).toBe(false);
    expect(store.has(current)).toBe(false);
    expect(deleted).toContain(legacy);
  });

  it("leaves another model's entries alone when purging by model", async () => {
    const { env, store } = kvEnv();
    const mine = "aigw:cache:v3:messages:model-a:hash1";
    const legacyMine = "aigw:cache:messages:model-a:hash0";
    const theirs = "aigw:cache:v3:messages:model-b:hash2";
    store.set(mine, JSON.stringify(payload("model-a")));
    store.set(legacyMine, JSON.stringify(payload("model-a")));
    store.set(theirs, JSON.stringify(payload("model-b")));

    await purgeCache(env, { model: "model-a" });

    expect(store.has(mine)).toBe(false);
    expect(store.has(legacyMine)).toBe(false);
    expect(store.has(theirs)).toBe(true);
  });

  it("clears both tiers when purging everything", async () => {
    const { env, store } = kvEnv();
    store.set("aigw:cache:v3:chat/completions:m1:h1", JSON.stringify(payload("m1")));
    store.set("aigw:cache:chat/completions:m2:h2", JSON.stringify(payload("m2")));
    await setCachedEntry(env, "aigw:cache:v3:chat/completions:m1:h1", payload("m1"), 300);

    const res = await purgeCache(env);

    expect(res.ok).toBe(true);
    expect(store.size).toBe(0);
    expect(await getCachedEntry(env, "aigw:cache:v3:chat/completions:m1:h1")).toBeNull();
  });
});
