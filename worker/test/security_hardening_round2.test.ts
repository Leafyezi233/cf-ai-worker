import { describe, expect, it } from "vitest";
import {
  CcSwitchImportItemSchema,
  CreateProviderSchema,
  UpdateProviderSchema,
} from "../src/admin/schemas";
import { addGatewayCorsHeaders } from "../src/utils/http";
import {
  LOGIN_MAX_ATTEMPTS,
  bumpSessionEpoch,
  clearLoginAttempt,
  getLoginAttempt,
  getSessionEpoch,
  pruneLoginAttempts,
  recordLoginFailure,
} from "../src/db/repo";
import { createRealD1 } from "./helpers/realD1";
import type { Env } from "../src/types";


const makeEnv = (d1: ReturnType<typeof createRealD1>) =>
  ({ DB: d1.DB, ASSETS: {} as any, ADMIN_SECRET: "admin-secret" }) as unknown as Env;

describe("provider endpoint validation", () => {
  it("accepts http(s) URLs on every schema that writes an endpoint", () => {
    for (const schema of [CreateProviderSchema, UpdateProviderSchema, CcSwitchImportItemSchema]) {
      const payload: any = { name: "P", type: "openai", endpoint: "https://api.example.com/v1" };
      expect(schema.safeParse(payload).success).toBe(true);
    }
  });

  it("rejects a non-URL, a non-http scheme and a bare host on update", () => {
    for (const endpoint of ["not a url", "file:///etc/passwd", "ftp://example.com", "api.example.com"]) {
      const res = UpdateProviderSchema.safeParse({ endpoint });
      expect(res.success, endpoint).toBe(false);
    }
  });

  it("rejects the same values on the ccswitch import path", () => {
    for (const endpoint of ["not a url", "file:///etc/passwd", "ftp://example.com"]) {
      const res = CcSwitchImportItemSchema.safeParse({ name: "P", type: "openai", endpoint });
      expect(res.success, endpoint).toBe(false);
    }
  });

  it("still allows null and an absent endpoint (use the built-in default)", () => {
    expect(UpdateProviderSchema.safeParse({ endpoint: null }).success).toBe(true);
    expect(UpdateProviderSchema.safeParse({}).success).toBe(true);
  });
});

describe("gateway CORS", () => {
  it("never reflects the caller's origin when no allowlist is configured", () => {
    const headers = new Headers();
    addGatewayCorsHeaders(headers, "https://evil.example", undefined);
    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Vary")).toBeNull();
  });

  it("reflects a configured origin and marks the answer as origin-dependent", () => {
    const headers = new Headers();
    addGatewayCorsHeaders(headers, "https://app.example", "https://app.example,https://other.example");
    expect(headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
    expect(headers.get("Vary")).toBe("Origin");
  });

  it("falls back to the wildcard for an origin outside the allowlist", () => {
    const headers = new Headers();
    addGatewayCorsHeaders(headers, "https://evil.example", "https://app.example");
    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("never authorises credentials", () => {
    const headers = new Headers();
    addGatewayCorsHeaders(headers, "https://app.example", "https://app.example");
    expect(headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});

describe("persisted admin login throttle", () => {
  it("locks at the configured threshold and reports the row", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);

    let row = await recordLoginFailure(env, "1.1.1.1");
    expect(row.count).toBe(1);
    expect(row.locked_until).toBe(0);

    for (let i = 1; i < LOGIN_MAX_ATTEMPTS; i++) row = await recordLoginFailure(env, "1.1.1.1");
    expect(row.count).toBe(LOGIN_MAX_ATTEMPTS);
    expect(row.locked_until).toBeGreaterThan(Date.now());

    expect((await getLoginAttempt(env, "1.1.1.1"))?.count).toBe(LOGIN_MAX_ATTEMPTS);
    d1.close();
  });

  it("starts the counter over once the window has passed", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);

    for (let i = 0; i < 4; i++) await recordLoginFailure(env, "2.2.2.2");
    expect((await getLoginAttempt(env, "2.2.2.2"))?.count).toBe(4);

    d1.sql("UPDATE login_attempts SET updated_at = ? WHERE ip = ?", Date.now() - 60 * 60 * 1000, "2.2.2.2");
    const row = await recordLoginFailure(env, "2.2.2.2");
    expect(row.count).toBe(1);
    expect(row.locked_until).toBe(0);
    d1.close();
  });

  it("keeps a successful login from inheriting a stale counter", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await recordLoginFailure(env, "3.3.3.3");
    await clearLoginAttempt(env, "3.3.3.3");
    expect(await getLoginAttempt(env, "3.3.3.3")).toBeNull();
    d1.close();
  });

  it("prunes rows that have not been touched for a day", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await recordLoginFailure(env, "old");
    await recordLoginFailure(env, "new");
    d1.sql("UPDATE login_attempts SET updated_at = ? WHERE ip = ?", Date.now() - 48 * 60 * 60 * 1000, "old");

    expect(await pruneLoginAttempts(env)).toBe(1);
    expect(await getLoginAttempt(env, "old")).toBeNull();
    expect(await getLoginAttempt(env, "new")).not.toBeNull();
    d1.close();
  });
});

describe("session revocation epoch", () => {
  it("starts at zero and increments on every bump", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    expect(await getSessionEpoch(env)).toBe(0);
    expect(await bumpSessionEpoch(env)).toBe(1);
    expect(await bumpSessionEpoch(env)).toBe(2);
    expect(await getSessionEpoch(env)).toBe(2);
    d1.close();
  });
});
