import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  normalizeTeamDomain,
  resetCfAccessCacheForTest,
  verifyCfAccessJwt,
} from "../src/utils/cfAccess";
import { adminAuth } from "../src/middleware/adminAuth";


const TEAM = "myteam.cloudflareaccess.com";
const KID = "test-key-1";

function b64url(bytes: Uint8Array | string): string {
  const buf = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
}

async function publicJwk(pair: CryptoKeyPair): Promise<any> {
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { ...jwk, kid: KID, alg: "RS256", use: "sig" };
}

async function signJwt(pair: CryptoKeyPair, payload: Record<string, unknown>): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const body = b64url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(`${header}.${body}`)
  );
  return `${header}.${body}.${b64url(new Uint8Array(signature))}`;
}

function stubJwks(jwk: any) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const future = () => Math.floor(Date.now() / 1000) + 300;

describe("Cloudflare Access JWT verification", () => {
  let pair: CryptoKeyPair;
  let jwk: any;

  beforeEach(async () => {
    resetCfAccessCacheForTest();
    pair = await makeKeyPair();
    jwk = await publicJwk(pair);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCfAccessCacheForTest();
  });

  it("accepts a token signed by the published team key", async () => {
    stubJwks(jwk);
    const token = await signJwt(pair, { email: "admin@mycompany.com", exp: future(), sub: "u1" });
    const identity = await verifyCfAccessJwt(token, { CF_ACCESS_TEAM_DOMAIN: TEAM });
    expect(identity?.email).toBe("admin@mycompany.com");
    expect(identity?.sub).toBe("u1");
  });

  it("rejects a token signed by a different key", async () => {
    stubJwks(jwk);
    const attacker = await makeKeyPair();
    const token = await signJwt(attacker, { email: "admin@mycompany.com", exp: future() });
    expect(await verifyCfAccessJwt(token, { CF_ACCESS_TEAM_DOMAIN: TEAM })).toBeNull();
  });

  it("rejects a token whose payload was edited after signing", async () => {
    stubJwks(jwk);
    const token = await signJwt(pair, { email: "someone@else.com", exp: future() });
    const [header, , signature] = token.split(".");
    const forged = b64url(JSON.stringify({ email: "admin@mycompany.com", exp: future() }));
    expect(await verifyCfAccessJwt(`${header}.${forged}.${signature}`, { CF_ACCESS_TEAM_DOMAIN: TEAM })).toBeNull();
  });

  it("rejects an expired token", async () => {
    stubJwks(jwk);
    const token = await signJwt(pair, { email: "admin@mycompany.com", exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await verifyCfAccessJwt(token, { CF_ACCESS_TEAM_DOMAIN: TEAM })).toBeNull();
  });

  it("rejects a token minted for a different Access application when CF_ACCESS_AUD is set", async () => {
    stubJwks(jwk);
    const token = await signJwt(pair, { email: "admin@mycompany.com", exp: future(), aud: ["other-app"] });
    expect(
      await verifyCfAccessJwt(token, { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: "this-app" })
    ).toBeNull();
    expect(
      (await verifyCfAccessJwt(token, { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: "other-app" }))?.email
    ).toBe("admin@mycompany.com");
  });

  it("rejects everything when no team domain is configured", async () => {
    stubJwks(jwk);
    const token = await signJwt(pair, { email: "admin@mycompany.com", exp: future() });
    expect(await verifyCfAccessJwt(token, {})).toBeNull();
    expect(await verifyCfAccessJwt(token, undefined)).toBeNull();
  });

  it("rejects a token with an unsigned alg instead of trusting the header", async () => {
    stubJwks(jwk);
    const header = b64url(JSON.stringify({ alg: "none", typ: "JWT", kid: KID }));
    const body = b64url(JSON.stringify({ email: "admin@mycompany.com", exp: future() }));
    expect(await verifyCfAccessJwt(`${header}.${body}.`, { CF_ACCESS_TEAM_DOMAIN: TEAM })).toBeNull();
  });

  it("normalises both team-domain spellings", () => {
    expect(normalizeTeamDomain("myteam.cloudflareaccess.com")).toBe(`https://${TEAM}`);
    expect(normalizeTeamDomain(`https://${TEAM}/`)).toBe(`https://${TEAM}`);
    expect(normalizeTeamDomain("")).toBeNull();
    expect(normalizeTeamDomain(undefined)).toBeNull();
  });

  it("lets adminAuth through when the JWT verifies and the email is whitelisted", async () => {
    stubJwks(jwk);
    const token = await signJwt(pair, { email: "admin@mycompany.com", exp: future() });
    let nextCalled = false;
    const c: any = {
      req: {
        raw: new Request("https://admin.test/"),
        header: (k: string) =>
          k.toLowerCase() === "cf-access-jwt-assertion" ? token : undefined,
      },
      env: {
        ADMIN_SECRET: "admin123",
        CF_ACCESS_ALLOWED_EMAILS: "admin@mycompany.com",
        CF_ACCESS_TEAM_DOMAIN: TEAM,
      },
      json: (data: any, status?: number) => ({ data, status }),
    };
    await adminAuth(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("does not let a verified JWT for an unlisted email through", async () => {
    stubJwks(jwk);
    const token = await signJwt(pair, { email: "intruder@mycompany.com", exp: future() });
    let nextCalled = false;
    const c: any = {
      req: {
        raw: new Request("https://admin.test/"),
        header: (k: string) => (k.toLowerCase() === "cf-access-jwt-assertion" ? token : undefined),
      },
      env: {
        ADMIN_SECRET: "admin123",
        CF_ACCESS_ALLOWED_EMAILS: "admin@mycompany.com",
        CF_ACCESS_TEAM_DOMAIN: TEAM,
      },
      json: (data: any, status?: number) => ({ data, status }),
    };
    const res: any = await adminAuth(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.status).toBe(401);
  });
});
