import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issueProtocolAffinity, matchProtocolAffinity, verifyProtocolAffinity,
  type AffinityClaim, type AffinityExpected, type AffinityIssueInput, type AffinityRow,
} from "../src/gateway/protocol_affinity";

const env = { SESSION_SECRET: "affinity-tests-session-secret-only-not-a-provider-key" };
const expected: AffinityExpected = { deviceId: "dev_owner", selection: "auto", modelKey: "visible-model" };
const row: AffinityRow = {
  id: "mod_private_member", provider_id: "prov_private", provider_endpoint: "https://private-upstream.example/v1",
  provider_type: "openai", provider_secret_name: "PRIVATE_PROVIDER_SECRET",
};
const input: AffinityIssueInput = {
  ...expected, serviceGroupId: "sg_actual", row, upstreamKey: "sk-test-resolved-upstream-secret",
};
const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sealPlain(plain: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode("cpg:protocol-affinity:aes-gcm:v1\0" + env.SESSION_SECRET));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM", iv, additionalData: enc.encode("cpg:protocol-affinity:token:v1"), tagLength: 128,
  }, key, typeof plain === "string" ? enc.encode(plain) : plain);
  return "pa1." + b64(iv) + "." + b64(new Uint8Array(ciphertext));
}
async function verified(): Promise<AffinityClaim> {
  const token = await issueProtocolAffinity(env, input);
  expect(token).not.toBeNull();
  const claim = await verifyProtocolAffinity(env, token!, expected);
  expect(claim).not.toBeNull();
  return claim!;
}

afterEach(() => vi.restoreAllMocks());

describe("stateless authenticated encrypted protocol affinity", () => {
  it("round-trips only bounded routing metadata and no provider credentials or request data", async () => {
    const requestData = { prompt: "secret prompt", payload: { reasoning: "opaque reasoning" }, history: ["secret history"] };
    const extraRow = { ...row, provider_api_key: "sealed-or-raw-db-key", provider_name: "Private Provider" };
    const token = await issueProtocolAffinity(env, { ...input, ...requestData, row: extraRow });
    expect(token).toMatch(/^pa1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(token!.length).toBeLessThanOrEqual(5600);
    const claim = await verifyProtocolAffinity(env, token!, expected);
    expect(claim).toEqual({
      version: 1, issuedAt: expect.any(Number), expiresAt: expect.any(Number), ...expected,
      serviceGroupId: "sg_actual", modelId: row.id, providerId: row.provider_id,
      credentialFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(claim!.expiresAt - claim!.issuedAt).toBe(3600);
    expect(Object.isFrozen(claim)).toBe(true);
    expect(await matchProtocolAffinity(claim!, input)).toBe(true);
    const wireBytes = Array.from(unb64(token!.split(".")[2]), (n) => String.fromCharCode(n)).join("");
    for (const secret of [row.id, row.provider_id, row.provider_endpoint!, row.provider_secret_name!,
      input.upstreamKey, "sealed-or-raw-db-key", "Private Provider", requestData.prompt, "opaque reasoning", "secret history"]) {
      expect(token).not.toContain(secret);
      expect(wireBytes).not.toContain(secret);
    }
    const metadata = JSON.stringify(claim);
    for (const secret of [input.upstreamKey, row.provider_endpoint!, row.provider_secret_name!, "sealed-or-raw-db-key",
      requestData.prompt, "opaque reasoning", "secret history"]) expect(metadata).not.toContain(secret);
  });

  it("issues a fresh 12-byte random nonce for every identical claim", async () => {
    const tokens = await Promise.all(Array.from({ length: 12 }, () => issueProtocolAffinity(env, input)));
    expect(tokens.every((token) => token !== null)).toBe(true);
    const nonces = tokens.map((token) => token!.split(".")[1]);
    expect(new Set(nonces).size).toBe(tokens.length);
    for (const nonce of nonces) expect(unb64(nonce).byteLength).toBe(12);
  });

  it.each([undefined, "", " ", "\t\n"])("fails closed with missing/blank SESSION_SECRET %j", async (SESSION_SECRET) => {
    const token = await issueProtocolAffinity(env, input);
    expect(await issueProtocolAffinity({ SESSION_SECRET }, input)).toBeNull();
    expect(await verifyProtocolAffinity({ SESSION_SECRET }, token!, expected)).toBeNull();
  });

  it("uses SESSION_SECRET exclusively and never accesses D1, KV or history", async () => {
    const storageFreeEnv = new Proxy(env, {
      get(target, property) {
        if (property !== "SESSION_SECRET") throw new Error("Unexpected storage/config access: " + String(property));
        return target.SESSION_SECRET;
      },
    });
    const token = await issueProtocolAffinity(storageFreeEnv, input);
    const claim = await verifyProtocolAffinity(storageFreeEnv, token!, expected);
    expect(await matchProtocolAffinity(claim!, input)).toBe(true);
  });

  it("rejects changes to the nonce, ciphertext, authentication tag and version prefix", async () => {
    const token = (await issueProtocolAffinity(env, input))!;
    const parts = token.split(".");
    const change = (value: string, index: number) => value.slice(0, index) + (value[index] === "A" ? "B" : "A") + value.slice(index + 1);
    const nonce = unb64(parts[1]);
    nonce[0] ^= 1;
    const cipher = unb64(parts[2]);
    const tag = cipher.slice();
    tag[tag.length - 1] ^= 1;
    for (const bad of ["pa2." + parts.slice(1).join("."), "pa1." + b64(nonce) + "." + parts[2],
      parts.slice(0, 2).join(".") + "." + change(parts[2], 0), parts.slice(0, 2).join(".") + "." + b64(tag)]) {
      expect(await verifyProtocolAffinity(env, bad, expected)).toBeNull();
    }
  });

  it("strictly rejects malformed, padded, noncanonical, truncated and oversized tokens before decryption", async () => {
    const token = (await issueProtocolAffinity(env, input))!;
    const [prefix, nonce, ciphertext] = token.split(".");
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    const bad = ["", "x", "a".repeat(5601), token + ".extra", " " + token, token + "\n", token + "=",
      prefix + "." + nonce.slice(1) + "." + ciphertext, prefix + "." + nonce + ".A",
      prefix + "." + nonce + "." + "A".repeat(22), prefix + "." + nonce + "." + "A".repeat(5486),
      prefix + "." + nonce + "." + ciphertext + "+", prefix + "." + nonce + "." + ciphertext + "/"];
    bad.push(prefix + "." + nonce + "." + "A".repeat(44) + "AB");
    for (const value of bad) expect(await verifyProtocolAffinity(env, value, expected)).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it.each([
    { deviceId: "dev_other" }, { modelKey: "other-model" }, { modelKey: "Visible-model" },
    { selection: "legacy" }, { selection: "default" }, { selection: "master" }, { selection: "sg_fixed" },
  ])("rejects a cross-device, model or effective-selection replay: %j", async (patch) => {
    const token = (await issueProtocolAffinity(env, input))!;
    expect(await verifyProtocolAffinity(env, token, { ...expected, ...patch })).toBeNull();
  });

  it.each(["default", "master", "auto", "legacy", "sg_explicit"])("binds effective selection %s exactly", async (selection) => {
    const token = await issueProtocolAffinity(env, { ...input, selection });
    expect(await verifyProtocolAffinity(env, token!, { ...expected, selection })).not.toBeNull();
    expect(await verifyProtocolAffinity(env, token!, { ...expected, selection: selection + "-changed" })).toBeNull();
  });

  it("expires at exactly 60 minutes, rejects future-issued claims and rechecks expiry when matching", async () => {
    const now = 1800000000000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const token = (await issueProtocolAffinity(env, input))!;
    const claim = (await verifyProtocolAffinity(env, token, expected))!;
    clock.mockReturnValue(now + 3599999);
    expect(await verifyProtocolAffinity(env, token, expected)).not.toBeNull();
    clock.mockReturnValue(now + 3600000);
    expect(await verifyProtocolAffinity(env, token, expected)).toBeNull();
    expect(await matchProtocolAffinity(claim, input)).toBe(false);
    clock.mockReturnValue(now - 1000);
    expect(await verifyProtocolAffinity(env, token, expected)).toBeNull();
  });

  it("binds actual service-group id (including legacy null), row id and provider id", async () => {
    const claim = await verified();
    expect(await matchProtocolAffinity(claim, { ...input, serviceGroupId: "sg_changed" })).toBe(false);
    expect(await matchProtocolAffinity(claim, { ...input, serviceGroupId: null })).toBe(false);
    expect(await matchProtocolAffinity(claim, { ...input, row: { ...row, id: "mod_changed" } })).toBe(false);
    expect(await matchProtocolAffinity(claim, { ...input, row: { ...row, provider_id: "prov_changed" } })).toBe(false);
    const legacyInput = { ...input, selection: "legacy", serviceGroupId: null };
    const token = await issueProtocolAffinity(env, legacyInput);
    const legacyClaim = await verifyProtocolAffinity(env, token!, { ...expected, selection: "legacy" });
    expect(legacyClaim!.serviceGroupId).toBeNull();
    expect(await matchProtocolAffinity(legacyClaim!, legacyInput)).toBe(true);
    expect(await matchProtocolAffinity(legacyClaim!, input)).toBe(false);
  });

  it("binds the resolved credential, endpoint, provider type and secret name, not a DB provider key", async () => {
    const claim = await verified();
    expect(await matchProtocolAffinity(claim, { ...input, upstreamKey: "sk-rotated" })).toBe(false);
    for (const patch of [{ provider_endpoint: "https://other.example/v1" }, { provider_endpoint: null },
      { provider_type: "anthropic" as const }, { provider_secret_name: "NEW_SECRET" }, { provider_secret_name: null }]) {
      expect(await matchProtocolAffinity(claim, { ...input, row: { ...row, ...patch } })).toBe(false);
    }
    const rowWithUnusedKey = { ...row, provider_api_key: "different-unused-db-value" };
    expect(await matchProtocolAffinity(claim, { ...input, row: rowWithUnusedKey })).toBe(true);
    const tupleA = { ...input, upstreamKey: "a|b", row: { ...row, provider_endpoint: "c" } };
    const tupleB = { ...input, upstreamKey: "a", row: { ...row, provider_endpoint: "b|c" } };
    const token = await issueProtocolAffinity(env, tupleA);
    const tupleClaim = await verifyProtocolAffinity(env, token!, expected);
    expect(await matchProtocolAffinity(tupleClaim!, tupleB)).toBe(false);
  });

  it("accepts nullable provider endpoint and secret name as distinct fingerprint fields", async () => {
    const target = { ...input, row: { ...row, provider_endpoint: null, provider_secret_name: null } };
    const token = await issueProtocolAffinity(env, target);
    const claim = await verifyProtocolAffinity(env, token!, expected);
    expect(await matchProtocolAffinity(claim!, target)).toBe(true);
    expect(await matchProtocolAffinity(claim!, { ...target, row: { ...target.row, provider_endpoint: "" } })).toBe(false);
    expect(await matchProtocolAffinity(claim!, { ...target, row: { ...target.row, provider_secret_name: "" } })).toBe(false);
  });

  it("rejects invalid or excessive expected identifiers rather than truncating, trimming or normalizing", async () => {
    const token = (await issueProtocolAffinity(env, input))!;
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    for (const patch of [{ deviceId: "" }, { deviceId: "x".repeat(257) }, { selection: "x".repeat(257) },
      { modelKey: "x".repeat(513) }, { deviceId: "dev_owner\0ignored" }, { selection: " auto" },
      { modelKey: "visible-model\n" }, { modelKey: "模型" }, { deviceId: "dev_оwner" }]) {
      expect(await issueProtocolAffinity(env, { ...input, ...patch })).toBeNull();
      expect(await verifyProtocolAffinity(env, token, { ...expected, ...patch })).toBeNull();
    }
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("allows bounded maximum identifiers and rejects missing/oversized target fields", async () => {
    const maximum: AffinityIssueInput = { ...input, deviceId: "d".repeat(256), selection: "s".repeat(256),
      modelKey: "m".repeat(512), serviceGroupId: "g".repeat(256), row: { ...row, id: "r".repeat(256), provider_id: "p".repeat(256) } };
    const token = await issueProtocolAffinity(env, maximum);
    expect(token).not.toBeNull();
    expect(await verifyProtocolAffinity(env, token!, maximum)).not.toBeNull();
    const claim = await verified();
    for (const target of [{ ...input, upstreamKey: "" }, { ...input, upstreamKey: "x".repeat(16385) },
      { ...input, serviceGroupId: "g".repeat(257) }, { ...input, row: { ...row, id: "" } },
      { ...input, row: { ...row, provider_endpoint: "x".repeat(4097) } },
      { ...input, row: { ...row, provider_secret_name: "x".repeat(513) } }]) {
      expect(await issueProtocolAffinity(env, target)).toBeNull();
      expect(await matchProtocolAffinity(claim, target)).toBe(false);
    }
  });

  it("rejects authenticated but invalid payload versions, schema, timestamps, UTF-8 and size", async () => {
    const claim = await verified();
    const missing = { ...claim } as Partial<AffinityClaim>;
    delete missing.providerId;
    const invalid = [null, [], {}, missing, { ...claim, version: 2 }, { ...claim, prompt: "never allowed" },
      { ...claim, expiresAt: claim.issuedAt + 3601 }, { ...claim, expiresAt: claim.issuedAt },
      { ...claim, issuedAt: claim.issuedAt + 0.5 }, { ...claim, expiresAt: Number.MAX_SAFE_INTEGER },
      { ...claim, credentialFingerprint: "a".repeat(63) }, { ...claim, providerId: "" },
      { ...claim, modelKey: "x".repeat(513) }];
    for (const value of invalid) {
      expect(await verifyProtocolAffinity(env, await sealPlain(JSON.stringify(value)), expected)).toBeNull();
    }
    for (const plain of ["{", " ".repeat(4097), new Uint8Array([0xff, 0xfe])]) {
      expect(await verifyProtocolAffinity(env, await sealPlain(plain), expected)).toBeNull();
    }
  });

  it("isolates current-secret verification from cached previous-secret keys", async () => {
    const rotatedEnv = { SESSION_SECRET: env.SESSION_SECRET + "-rotated" };
    const token = (await issueProtocolAffinity(env, input))!;
    const rotated = (await issueProtocolAffinity(rotatedEnv, input))!;
    expect(await verifyProtocolAffinity(rotatedEnv, token, expected)).toBeNull();
    expect(await verifyProtocolAffinity(env, rotated, expected)).toBeNull();
    expect(await verifyProtocolAffinity(rotatedEnv, rotated, expected)).not.toBeNull();
    expect(await verifyProtocolAffinity(env, token, expected)).not.toBeNull();
  });

  it("shares one in-flight AES derivation and retains only the two most-recent secret keys", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const a = { SESSION_SECRET: "cache-bound-test-a" }, b = { SESSION_SECRET: "cache-bound-test-b" }, c = { SESSION_SECRET: "cache-bound-test-c" };
    const tokens = await Promise.all(Array.from({ length: 8 }, () => issueProtocolAffinity(a, input)));
    expect(tokens.every((token) => token !== null)).toBe(true);
    expect(importKey).toHaveBeenCalledTimes(1);
    expect(await verifyProtocolAffinity(a, tokens[0]!, expected)).not.toBeNull();
    expect(importKey).toHaveBeenCalledTimes(1);
    await issueProtocolAffinity(b, input);
    await issueProtocolAffinity(c, input);  
    expect(importKey).toHaveBeenCalledTimes(3);
    await issueProtocolAffinity(b, input);  
    expect(importKey).toHaveBeenCalledTimes(3);
    expect(await verifyProtocolAffinity(a, tokens[0]!, expected)).not.toBeNull();
    expect(importKey).toHaveBeenCalledTimes(4);
  });

  it("does not pin a rejected key derivation or fall back to plaintext on crypto failure", async () => {
    const transient = { SESSION_SECRET: "cache-rejected-derive-test" };
    const importKey = vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(new Error("transient crypto failure"));
    expect(await issueProtocolAffinity(transient, input)).toBeNull();
    expect(await issueProtocolAffinity(transient, input)).not.toBeNull();
    expect(importKey).toHaveBeenCalledTimes(2);
    vi.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(new Error("encrypt failure"));
    expect(await issueProtocolAffinity(transient, input)).toBeNull();
  });
});
