import { afterEach } from "vitest";
import { sha256Hex } from "../../src/utils/crypto";
import type { DeviceRow, ModelWithProvider, PriceWindowRow } from "../../src/types";
import { createRealD1, seedDevice, seedModel, seedProvider, seedDeviceModels, makeEnv, makeKv, wallet, holdRows, ledgerRows, type RealD1 } from "./realGatewayEnv";

const opened: RealD1[] = [];
afterEach(() => { for (const d1 of opened.splice(0)) d1.close(); });

export async function durableBillingFixture(models: ModelWithProvider[], options: {
  token: string;
  hash?: string;
  balanceUsd?: number;
  device?: Partial<DeviceRow> | null;
  whitelisted?: string[];
  rpmByModel?: Record<string, number>;
  windows?: PriceWindowRow[];
  cache?: boolean;
}) {
  const d1 = createRealD1();
  opened.push(d1);
  const providers = new Map<string, string>();
  for (const model of models) {
    const key = JSON.stringify([model.provider_id, model.provider_endpoint, model.provider_type, model.provider_api_key]);
    let providerId = providers.get(key);
    if (!providerId) {
      providerId = [...providers.values()].includes(model.provider_id) ? model.provider_id + "_" + model.id : model.provider_id;
      providers.set(key, providerId);
      seedProvider(d1, { id: providerId, name: model.provider_name, type: model.provider_type,
        endpoint: model.provider_endpoint ?? undefined, api_key: model.provider_api_key });
    }
    seedModel(d1, { ...model, provider_id: providerId, fallback_model_id: null });
  }
  for (const model of models) if (model.fallback_model_id) {
    d1.sql("UPDATE models SET fallback_model_id = ? WHERE id = ?", model.fallback_model_id, model.id);
  }
  const deviceId = options.device?.id ?? "dev_1";
  if (options.device !== null) {
    await seedDevice(d1, { ...options.device, id: deviceId,
      token_hash: options.hash ?? await sha256Hex(options.token), balance_usd: options.balanceUsd ?? 50,
      cost_limit_monthly: options.device?.cost_limit_monthly ?? 0 });
    seedDeviceModels(d1, [...new Set([...(options.whitelisted ?? []), ...Object.keys(options.rpmByModel ?? {})])], options.rpmByModel, deviceId);
  }
  for (const w of options.windows ?? []) {
    d1.sql("INSERT INTO price_windows (id, model_id, day_type, start_minute, end_minute, multiplier, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      w.id, w.model_id, w.day_type, w.start_minute, w.end_minute, w.multiplier, w.enabled, w.created_at, w.updated_at);
  }
  const kv = makeKv();
  const env = makeEnv(d1, options.cache ? kv : undefined);
  const queries: string[] = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql: string) => { queries.push(sql); return prepare(sql); };
  return { d1, env, queries, kvWrites: kv.writes,
    wallet: () => wallet(d1, deviceId)!,
    holds: () => holdRows(d1),
    ledger: () => ledgerRows(d1, deviceId),
    usages: () => d1.rows<any>("SELECT * FROM usage ORDER BY id"),
    billing: () => d1.rows<any>("SELECT * FROM billing_requests ORDER BY created_at, request_id"),
  };
}
