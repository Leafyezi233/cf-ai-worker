import { describe, expect, it } from "vitest";
import { initializedSchemaDouble } from "./helpers/initializedSchemaDouble";
import { listModels, listProviders } from "../src/db/repo";
import type { Env } from "../src/types";


const SEALED = "enc:v1:AAAAAAAAAAAAAAAA.ciphertext-placeholder";

function countingEnv(rows: Record<string, unknown>[]) {
  let opened = 0;
  const db = {
    prepare: (sql: string) => {
      let binds: unknown[] = [];
      const self: any = {
        sql,
        bind: (...a: unknown[]) => {
          binds = a;
          return self;
        },
        first: async () => null,
        all: async () => ({ results: rows }),
        run: async () => ({ meta: { changes: 1 } }),
      };
      return self;
    },
    batch: async () => [],
  } as unknown as Env["DB"];

  const env = {
    DB: initializedSchemaDouble(db),
    ASSETS: null,
    ENCRYPTION_KEY: "test-passphrase",
  } as unknown as Env;

  const subtle = (crypto as unknown as { subtle: SubtleCrypto }).subtle;
  const realDecrypt = subtle.decrypt.bind(subtle);
  subtle.decrypt = ((...args: Parameters<typeof realDecrypt>) => {
    opened++;
    return realDecrypt(...args);
  }) as typeof realDecrypt;

  return {
    env,
    get opened() {
      return opened;
    },
    restore() {
      subtle.decrypt = realDecrypt;
    },
  };
}

function modelRow() {
  return {
    id: "model_1",
    provider_id: "prov_1",
    model_name: "gpt-x",
    display_name: "GPT X",
    alias: null,
    fallback_model_id: null,
    input_price_per_m: 1,
    output_price_per_m: 2,
    cache_enabled: 0,
    cache_ttl: 0,
    enabled: 1,
    model_public: 1,
    pricing_mode: "priced",
    peak_pricing_enabled: 0,
    config_json: null,
    created_at: 1,
    updated_at: 1,
    provider_name: "P",
    provider_type: "openai",
    provider_secret_name: null,
    provider_endpoint: null,
    provider_api_key: SEALED,
  };
}

function providerRow() {
  return {
    id: "prov_1",
    name: "P",
    type: "openai",
    endpoint: null,
    api_key: SEALED,
    secret_name: null,
    enabled: 1,
    config_json: null,
    created_at: 1,
    updated_at: 1,
  };
}

describe("listing skips credential decryption when the caller does not need it", () => {
  it("listModels does not decrypt when includeSecrets is false", async () => {
    const h = countingEnv([modelRow(), modelRow(), modelRow()]);
    try {
      const rows = await listModels(h.env, { includeSecrets: false });
      expect(rows.length).toBe(3);
      expect(h.opened).toBe(0);
    } finally {
      h.restore();
    }
  });

  it("listModels still decrypts by default (unchanged behaviour)", async () => {
    const h = countingEnv([modelRow(), modelRow()]);
    try {
      await listModels(h.env);
      expect(h.opened).toBe(2);
    } finally {
      h.restore();
    }
  });

  it("listProviders does not decrypt when includeSecrets is false", async () => {
    const h = countingEnv([providerRow(), providerRow()]);
    try {
      const rows = await listProviders(h.env, { includeSecrets: false });
      expect(rows.length).toBe(2);
      expect(h.opened).toBe(0);
    } finally {
      h.restore();
    }
  });

  it("listProviders still decrypts by default (unchanged behaviour)", async () => {
    const h = countingEnv([providerRow()]);
    try {
      await listProviders(h.env);
      expect(h.opened).toBe(1);
    } finally {
      h.restore();
    }
  });
});
