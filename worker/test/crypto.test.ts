import { describe, expect, it } from "vitest";
import {
  buildSessionCookie,
  clearSessionCookies,
  generateDeviceToken,
  hashToken,
  safeEqual,
  signSession,
  verifySession,
} from "../src/utils/crypto";

describe("crypto helpers", () => {
  it("generates ccs_ prefixed tokens and hashes them", async () => {
    const token = generateDeviceToken();
    expect(token.startsWith("ccs_")).toBe(true);
    expect(token.length).toBeGreaterThan(10);
    const hash = await hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken(token)).toBe(hash);
  });

  it("signs and verifies a session with the correct secret", async () => {
    const value = await signSession("secret");
    const ok = await verifySession("secret", `__Host-session=${value}`);
    expect(ok).not.toBeNull();
    expect(ok?.admin).toBe(true);
  });

  it("still accepts the pre-rename cookie name for one deploy cycle", async () => {
    const value = await signSession("secret");
    const ok = await verifySession("secret", `session=${value}`);
    expect(ok).not.toBeNull();
  });

  it("prefers the __Host- cookie when both are present", async () => {
    const good = await signSession("secret");
    const bogus = await signSession("other-secret");
    const ok = await verifySession("secret", `session=${bogus}; __Host-session=${good}`);
    expect(ok).not.toBeNull();
  });

  it("rejects sessions signed with the wrong secret", async () => {
    const value = await signSession("a");
    const ok = await verifySession("b", `__Host-session=${value}`);
    expect(ok).toBeNull();
  });

  it("carries the revocation epoch in the payload", async () => {
    const value = await signSession("secret", 7);
    const ok = await verifySession("secret", `__Host-session=${value}`);
    expect(ok?.epoch).toBe(7);
  });

  it("emits a __Host- prefixed cookie and clears both cookie names", async () => {
    const cookie = buildSessionCookie("abc.def");
    expect(cookie.startsWith("__Host-session=abc.def;")).toBe(true);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("Domain=");

    const cleared = clearSessionCookies();
    expect(cleared).toHaveLength(2);
    expect(cleared[0]).toContain("__Host-session=");
    expect(cleared[1]).toContain("session=");
    for (const c of cleared) expect(c).toContain("Max-Age=0");
  });

  it("safeEqual compares equal-length and different-length inputs", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("ab", "abc")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("", "a")).toBe(false);
    expect(safeEqual("secret", "secretx")).toBe(false);
  });
});
