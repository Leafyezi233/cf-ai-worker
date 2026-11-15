import { afterEach, describe, expect, it } from "vitest";
import { __resetDerivedKeyCache, isEncryptedSecret, openSecret, sealSecret } from "../src/utils/crypto";


const KEY = "operator-passphrase-for-tests";

function countingDigest() {
  const subtle = (crypto as unknown as { subtle: SubtleCrypto }).subtle;
  const real = subtle.digest.bind(subtle);
  let calls = 0;
  subtle.digest = ((...args: Parameters<typeof real>) => {
    calls++;
    return real(...args);
  }) as typeof real;
  return {
    get calls() {
      return calls;
    },
    restore() {
      subtle.digest = real;
    },
  };
}

describe("derived AES key is memoised per passphrase", () => {
  afterEach(() => {
    __resetDerivedKeyCache();
  });

  it("derives once for many opens of the same key", async () => {
    const sealed = await sealSecret("sk-live-abcdef", KEY);
    __resetDerivedKeyCache();

    const counter = countingDigest();
    try {
      for (let i = 0; i < 50; i++) {
        expect(await openSecret(sealed, KEY)).toBe("sk-live-abcdef");
      }
    } finally {
      counter.restore();
    }

    expect(counter.calls).toBe(1);
  });

  it("still opens every value correctly after memoisation", async () => {
    const a = await sealSecret("sk-first", KEY);
    const b = await sealSecret("sk-second", KEY);
    __resetDerivedKeyCache();
    expect(await openSecret(a, KEY)).toBe("sk-first");
    expect(await openSecret(b, KEY)).toBe("sk-second");
  });

  it("keeps a wrong passphrase failing even when the right one was cached", async () => {
    const sealed = await sealSecret("sk-secret", KEY);
    __resetDerivedKeyCache();
    expect(await openSecret(sealed, KEY)).toBe("sk-secret");
    expect(await openSecret(sealed, "a-completely-different-passphrase!!")).toBeNull();
  });

  it("does not cache a rejected derive", async () => {
    const sealed = await sealSecret("sk-secret", KEY);
    __resetDerivedKeyCache();
    expect(await openSecret(sealed, undefined)).toBeNull();
    expect(await openSecret(sealed, KEY)).toBe("sk-secret");
  });

  it("keeps seal/open round-tripping and stays idempotent on already-sealed values", async () => {
    const sealed = await sealSecret("sk-roundtrip", KEY);
    expect(isEncryptedSecret(sealed)).toBe(true);
    expect(await sealSecret(sealed, KEY)).toBe(sealed);
    expect(await openSecret(sealed, KEY)).toBe("sk-roundtrip");
  });
});
