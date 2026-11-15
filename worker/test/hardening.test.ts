import { describe, expect, it, beforeEach } from "vitest";
import { isEncryptedSecret, openSecret, sealSecret } from "../src/utils/crypto";
import { RateLimiterDO } from "../src/gateway/rate-limiter-do";
import { DEFAULT_TZ_OFFSET_MINUTES, monthRangeMs, monthStartMs, sqlTzModifierToOffsetMinutes } from "../src/db/repo";

const KEY = "unit-test-encryption-key-32-bytes!!";

describe("secret sealing (provider key at rest)", () => {
  it("round-trips a value through seal/open", async () => {
    const sealed = await sealSecret("sk-live-abcdef", KEY);
    expect(isEncryptedSecret(sealed)).toBe(true);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(sealed).not.toContain("sk-live-abcdef");
    expect(await openSecret(sealed, KEY)).toBe("sk-live-abcdef");
  });

  it("never produces the same ciphertext twice for the same input", async () => {
    const a = await sealSecret("sk-same", KEY);
    const b = await sealSecret("sk-same", KEY);
    expect(a).not.toBe(b);
    expect(await openSecret(a, KEY)).toBe(await openSecret(b, KEY));
  });

  it("refuses to store a credential in plaintext when no key is configured", async () => {
    await expect(sealSecret("sk-plain", undefined)).rejects.toThrow(/ENCRYPTION_KEY is not configured/);
    await expect(sealSecret("sk-plain", "")).rejects.toThrow(/ENCRYPTION_KEY is not configured/);
  });

  it("still round-trips an empty value without a key (nothing to protect)", async () => {
    expect(await sealSecret("", undefined)).toBe("");
  });

  it("is idempotent: re-sealing an already sealed value is a no-op", async () => {
    const sealed = await sealSecret("sk-once", KEY);
    expect(await sealSecret(sealed, KEY)).toBe(sealed);
  });

  it("returns legacy plaintext rows untouched when opening", async () => {
    expect(await openSecret("sk-legacy", KEY)).toBe("sk-legacy");
  });

  it("refuses to open with the wrong key instead of throwing", async () => {
    const sealed = await sealSecret("sk-secret", KEY);
    expect(await openSecret(sealed, "another-key-entirely-different!!")).toBeNull();
  });

  it("treats a sealed value with no configured key as unreadable, not as plaintext", async () => {
    const sealed = await sealSecret("sk-secret", KEY);
    expect(await openSecret(sealed, undefined)).toBeNull();
    expect(await openSecret(null, KEY)).toBeNull();
  });
});

describe("month window timezone helpers", () => {
  it("treats the default offset as UTC+8", () => {
    expect(DEFAULT_TZ_OFFSET_MINUTES).toBe(-480);
    expect(sqlTzModifierToOffsetMinutes("+480 minutes")).toBe(-480);
    expect(sqlTzModifierToOffsetMinutes("-300 minutes")).toBe(300);
    expect(sqlTzModifierToOffsetMinutes(undefined)).toBe(DEFAULT_TZ_OFFSET_MINUTES);
  });

  it("puts the local month start 8 hours before the UTC month start", () => {
    const start = monthStartMs(-480, Date.UTC(2026, 9, 12, 3, 0, 0));
    expect(start).toBe(Date.UTC(2026, 8, 30, 16, 0, 0));
  });

  it("keeps the window start and end inside the same local month", () => {
    const r = monthRangeMs(2026, 10, -480);
    const localStart = new Date(r.startMs - -480 * 60_000);
    const localEnd = new Date(r.endMs - -480 * 60_000);
    expect(localStart.getUTCMonth()).toBe(9);
    expect(localEnd.getUTCMonth()).toBe(9);
    expect(localEnd.getTime()).toBe(Date.UTC(2026, 10, 1, 0, 0, 0) - 1);
    expect(localStart.getTime()).toBe(Date.UTC(2026, 9, 1, 0, 0, 0));
  });

  it("chunks the previous month exactly up to the day before the current month", () => {
    const r = monthRangeMs(2026, 10, -480);
    expect(r.prevEndMs).toBe(r.startMs - 1);
    const prevLocal = new Date(r.prevStartMs + 480 * 60_000);
    expect(prevLocal.getUTCMonth()).toBe(8);
  });

  it("rolls the year over correctly in December and January", () => {
    const dec = monthRangeMs(2026, 12, -480);
    expect(new Date(dec.endMs + 480 * 60_000).getUTCDate()).toBe(31);
    const jan = monthRangeMs(2027, 1, -480);
    expect(new Date(jan.startMs + 480 * 60_000).getUTCDate()).toBe(1);
    expect(new Date(jan.startMs + 480 * 60_000).getUTCMonth()).toBe(0);
  });
});

describe("RateLimiterDO sliding window", () => {
  const makeState = () => {
    const store = new Map<string, unknown>();
    return {
      storage: {
        get: async (k: string) => store.get(k),
        put: async (k: string, v: unknown) => { store.set(k, v); },
      },
    } as unknown as DurableObjectState;
  };

  type DoReply = { allowed: boolean; remaining: number | null; reset_ms: number };

  const consume = async (do_: RateLimiterDO, rpm: number): Promise<DoReply> => {
    const res = await do_.fetch(new Request(`https://do/consume?rpm=${rpm}`, { method: "POST" }));
    return (await res.json()) as DoReply;
  };

  it("allows requests up to the limit and rejects the next one", async () => {
    const do_ = new RateLimiterDO(makeState());
    for (let i = 0; i < 3; i++) {
      expect((await consume(do_, 3)).allowed).toBe(true);
    }
    const blocked = await consume(do_, 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.reset_ms).toBeGreaterThan(0);
  });

  it("does not record rejected requests, so the window cannot be pushed forward", async () => {
    const do_ = new RateLimiterDO(makeState());
    for (let i = 0; i < 3; i++) await consume(do_, 3);
    for (let i = 0; i < 5; i++) await consume(do_, 3);
    expect((await consume(do_, 3)).allowed).toBe(false);
  });

  it("treats rpm 0 and a missing rpm as unlimited", async () => {
    const do_ = new RateLimiterDO(makeState());
    for (let i = 0; i < 25; i++) {
      expect((await consume(do_, 0)).allowed).toBe(true);
    }
    const res = await do_.fetch(new Request("https://do/consume", { method: "POST" }));
    expect(((await res.json()) as DoReply).allowed).toBe(true);
  });

  it("rejects non-POST methods", async () => {
    const do_ = new RateLimiterDO(makeState());
    const res = await do_.fetch(new Request("https://do/consume?rpm=5", { method: "GET" }));
    expect(res.status).toBe(405);
  });

  it("keeps separate windows per storage namespace (one DO per device)", async () => {
    const a = new RateLimiterDO(makeState());
    const b = new RateLimiterDO(makeState());
    for (let i = 0; i < 2; i++) await consume(a, 2);
    expect((await consume(a, 2)).allowed).toBe(false);
    expect((await consume(b, 2)).allowed).toBe(true);
  });
});
