import { describe, it, expect } from "vitest";
import { initializedSchemaDouble } from "./helpers/initializedSchemaDouble";
import { createConfigSnapshot } from "../src/db/repo";
import { redactCcSwitchSecrets, parseCcSwitchJson } from "../src/admin/ccswitch";
import { extractClientIp, isIpAllowed } from "../src/middleware/adminAuth";
import type { Env } from "../src/types";

const PROVIDER = {
  id: "prov_1",
  name: "Alpha",
  type: "openai",
  endpoint: "https://api.example/v1",
  api_key: "sk-live-PLAINTEXT-abcdef",
  secret_name: null,
  enabled: 1,
  config_json: null,
  created_at: 1,
};

const MODEL = {
  id: "model_1",
  provider_id: "prov_1",
  model_name: "gpt-x",
  display_name: null,
  alias: null,
  fallback_model_id: null,
  input_price_per_m: 3,
  output_price_per_m: 15,
  cache_enabled: 0,
  cache_ttl: 0,
  enabled: 1,
  config_json: null,
  created_at: 1,
  provider_name: "Alpha",
  provider_type: "openai",
  provider_api_key: "sk-live-PLAINTEXT-abcdef",
  provider_secret_name: null,
  provider_endpoint: "https://api.example/v1",
};

function makeEnv(envExtras: Record<string, unknown>) {
  const captured: { name?: string; json?: string } = {};
  const stmt = (sql: string, args: unknown[] = []) => {
    const self: any = {
      bind: (...a: unknown[]) => stmt(sql, a),
      run: async () => {
        if (sql.includes("INSERT INTO config_snapshots")) {
          captured.name = String(args[1]);
          captured.json = String(args[3]);
        }
        return { meta: { changes: 1 }, success: true };
      },
      first: async () => null,
      all: async () => {
        if (sql.includes("FROM providers ORDER BY")) return { results: [PROVIDER] };
        if (sql.includes("FROM models m LEFT JOIN providers")) return { results: [MODEL] };
        return { results: [] };
      },
    };
    return self;
  };
  const db = { prepare: (sql: string) => stmt(sql), batch: async (statements: { all: () => Promise<unknown> }[]) => Promise.all(statements.map(statement => statement.all())) };
  return { env: { DB: initializedSchemaDouble(db), ...envExtras } as unknown as Env, captured };
}

describe("P0-A: config snapshots must not store plaintext provider keys", () => {
  it("seals providers[].api_key and models[].provider_api_key before the INSERT", async () => {
    const { env, captured } = makeEnv({ ENCRYPTION_KEY: "operator-chosen-passphrase" });
    await createConfigSnapshot(env, "snap", "desc");

    expect(captured.json).toBeTruthy();
    expect(captured.json).not.toContain("sk-live-PLAINTEXT-abcdef");
    const parsed = JSON.parse(captured.json!);
    expect(parsed.providers[0].api_key.startsWith("enc:v1:")).toBe(true);
    expect(parsed.models[0].provider_api_key.startsWith("enc:v1:")).toBe(true);
  });

  it("refuses to write a snapshot at all when no encryption key is configured", async () => {
    const { env, captured } = makeEnv({});
    await expect(createConfigSnapshot(env, "snap", "desc")).rejects.toThrow(/ENCRYPTION_KEY is not configured/);
    expect(captured.json).toBeUndefined();
  });
});

describe("P1: ccswitch raw_config must not carry a second copy of the key", () => {
  it("blanks credential-shaped fields but keeps the rest", () => {
    const out = redactCcSwitchSecrets({
      name: "Alpha",
      api_key: "sk-live-1",
      apiKey: "sk-live-2",
      token: "t-1",
      password: "p-1",
      secret_name: null,
      endpoint: "https://api.example/v1",
      nested: { accessKey: "ak-1", keep: "value" },
      list: [{ authorization: "Bearer x", model: "m" }],
    });

    expect(out.api_key).not.toBe("sk-live-1");
    expect(out.apiKey).not.toBe("sk-live-2");
    expect(out.token).not.toBe("t-1");
    expect(out.password).not.toBe("p-1");
    expect(out.nested.accessKey).not.toBe("ak-1");
    expect(out.list[0].authorization).not.toBe("Bearer x");

    expect(out.name).toBe("Alpha");
    expect(out.endpoint).toBe("https://api.example/v1");
    expect(out.secret_name).toBeNull();
    expect(out.nested.keep).toBe("value");
    expect(out.list[0].model).toBe("m");
  });

  it("leaves an already-redacted placeholder in place and passes non-objects through", () => {
    const out = redactCcSwitchSecrets({ api_key: "••••••••", n: 5, s: "text", b: true, nil: null });
    expect(out.api_key).toBe("••••••••");
    expect(out.n).toBe(5);
    expect(out.s).toBe("text");
    expect(out.b).toBe(true);
    expect(out.nil).toBeNull();
    expect(redactCcSwitchSecrets(null)).toBeNull();
    expect(redactCcSwitchSecrets(undefined)).toBeUndefined();
  });

  it("keeps the real key on api_key while raw_config is redacted (parser output)", () => {
    const parsed = parseCcSwitchJson(JSON.stringify({
      name: "Alpha",
      app_type: "openai",
      api_key: "sk-live-from-export",
      endpoint: "https://api.example/v1",
    }));

    expect(parsed.length).toBe(1);
    expect(parsed[0].api_key).toBe("sk-live-from-export");
    expect(JSON.stringify(parsed[0].raw_config)).not.toContain("sk-live-from-export");
  });
});

describe("P2: the admin IP whitelist must not trust client-supplied forward headers", () => {
  const headerBag = (bag: Record<string, string>) => ({
    req: { header: (k: string) => bag[k] },
  });

  it("prefers cf-connecting-ip, which Cloudflare overwrites", () => {
    const c = headerBag({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9" });
    expect(extractClientIp(c as any)).toBe("203.0.113.7");
    expect(extractClientIp(c as any, { TRUST_FORWARD_HEADERS: "true" })).toBe("203.0.113.7");
  });

  it("ignores x-forwarded-for unless the operator opted in", () => {
    const c = headerBag({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" });
    expect(extractClientIp(c as any)).toBe("unknown");
    expect(extractClientIp(c as any, {})).toBe("unknown");
    expect(extractClientIp(c as any, { TRUST_FORWARD_HEADERS: "false" })).toBe("unknown");
  });

  it("keeps a header-less request out of a localhost whitelist", () => {
    const bare = headerBag({});
    expect(isIpAllowed(extractClientIp(bare as any), ["localhost"])).toBe(false);
  });

  it("honours the forward headers behind the explicit opt-in", () => {
    const xff = headerBag({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" });
    expect(extractClientIp(xff as any, { TRUST_FORWARD_HEADERS: "true" })).toBe("198.51.100.9");
    expect(extractClientIp(xff as any, { TRUST_FORWARD_HEADERS: "1" })).toBe("198.51.100.9");
    const real = headerBag({ "x-real-ip": "198.51.100.4" });
    expect(extractClientIp(real as any, { TRUST_FORWARD_HEADERS: "true" })).toBe("198.51.100.4");
  });
});
