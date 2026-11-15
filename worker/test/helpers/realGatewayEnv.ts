import { createRealD1, type RealD1 } from "./realD1";
import { gatewayApp } from "../../src/gateway/index";
import { sha256Hex } from "../../src/utils/crypto";
import type { Env } from "../../src/types";


export const TOKEN = "ccs_real_sql_token";
export const DEVICE_ID = "dev_1";

export interface SeedProvider {
  id?: string;
  name?: string;
  type?: string;
  endpoint?: string;
  api_key?: string | null;
}

export interface SeedModel {
  id?: string;
  provider_id?: string;
  model_name?: string;
  alias?: string | null;
  fallback_model_id?: string | null;
  input_price_per_m?: number;
  output_price_per_m?: number;
  cache_read_price_per_m?: number;
  cache_write_price_per_m?: number;
  cache_enabled?: number;
  cache_ttl?: number;
  enabled?: number;
  model_public?: number;
  pricing_mode?: string;
  peak_pricing_enabled?: number;
  billing_unit?: string;
  price_per_call?: number;
  search_price_per_call?: number;
  config_json?: string | null;
}

export interface SeedDevice {
  id?: string;
  token_hash?: string;
  enabled?: number;
  rate_limit_rpm?: number;
  cost_limit_monthly?: number;
  model_scope?: string;
  balance_usd?: number;
}

export function seedProvider(d1: RealD1, over: SeedProvider = {}): string {
  const id = over.id ?? "prov_a";
  d1.sql(
    "INSERT OR REPLACE INTO providers (id, name, type, endpoint, api_key, secret_name, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 1, NULL, ?, ?)",
    id,
    over.name ?? "Provider A",
    over.type ?? "openai",
    over.endpoint ?? "https://a.example/v1",
    over.api_key === undefined ? "sk-a" : over.api_key,
    1,
    1
  );
  return id;
}

export function seedModel(d1: RealD1, over: SeedModel = {}): string {
  const id = over.id ?? "model_a";
  d1.sql(
    "INSERT OR REPLACE INTO models (id, provider_id, model_name, display_name, alias, fallback_model_id, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, cache_enabled, cache_ttl, enabled, model_public, pricing_mode, peak_pricing_enabled, billing_unit, price_per_call, search_price_per_call, config_json, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    over.provider_id ?? "prov_a",
    over.model_name ?? "gw-primary",
    over.model_name ?? "gw-primary",
    over.alias ?? null,
    over.fallback_model_id ?? null,
    over.input_price_per_m ?? 3,
    over.output_price_per_m ?? 15,
    over.cache_read_price_per_m ?? 0,
    over.cache_write_price_per_m ?? 0,
    over.cache_enabled ?? 0,
    over.cache_ttl ?? 3600,
    over.enabled ?? 1,
    over.model_public ?? 1,
    over.pricing_mode ?? "priced",
    over.peak_pricing_enabled ?? 0,
    over.billing_unit ?? "token",
    over.price_per_call ?? 0,
    over.search_price_per_call ?? 0,
    over.config_json ?? null,
    1,
    1
  );
  return id;
}

export async function seedDevice(d1: RealD1, over: SeedDevice = {}): Promise<string> {
  const id = over.id ?? DEVICE_ID;
  d1.sql(
    "INSERT OR REPLACE INTO devices (id, name, token_hash, enabled, rate_limit_rpm, cost_limit_monthly, last_used_at, created_at, revoked_at, model_scope) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)",
    id,
    "Laptop",
    over.token_hash ?? (await sha256Hex(TOKEN)),
    over.enabled ?? 1,
    over.rate_limit_rpm ?? 0,
    over.cost_limit_monthly ?? 0,
    1,
    over.model_scope ?? "all"
  );
  d1.sql(
    "INSERT OR REPLACE INTO device_wallets (device_id, balance_usd, reserved_usd, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
    id,
    over.balance_usd ?? 1,
    1,
    1
  );
  return id;
}

export interface SeedGroup {
  id?: string;
  name?: string;
  display_name?: string | null;
  enabled?: number;
  model_public?: number;
  pricing_mode?: string;
  input_price_per_m?: number;
  output_price_per_m?: number;
  cache_read_price_per_m?: number;
  cache_write_price_per_m?: number;
  cache_enabled?: number;
  cache_ttl?: number;
  peak_pricing_enabled?: number;
  billing_unit?: string;
  price_per_call?: number;
  search_price_per_call?: number;
  config_json?: string | null;
}

export function seedGroup(d1: RealD1, over: SeedGroup = {}): string {
  const id = over.id ?? "grp_a";
  d1.sql(
    "INSERT OR REPLACE INTO model_groups (id, name, display_name, description, enabled, model_public, pricing_mode, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, cache_enabled, cache_ttl, peak_pricing_enabled, billing_unit, price_per_call, search_price_per_call, config_json, created_at, updated_at) " +
      "VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    over.name ?? "gw-group",
    over.display_name ?? over.name ?? "gw-group",
    over.enabled ?? 1,
    over.model_public ?? 1,
    over.pricing_mode ?? "priced",
    over.input_price_per_m ?? 9,
    over.output_price_per_m ?? 45,
    over.cache_read_price_per_m ?? 0,
    over.cache_write_price_per_m ?? 0,
    over.cache_enabled ?? 0,
    over.cache_ttl ?? 3600,
    over.peak_pricing_enabled ?? 0,
    over.billing_unit ?? "token",
    over.price_per_call ?? 0,
    over.search_price_per_call ?? 0,
    over.config_json ?? null,
    1,
    2
  );
  return id;
}

export function seedGroupMembers(d1: RealD1, groupId: string, modelIds: string[], enabled = 1): void {
  d1.sql("DELETE FROM model_group_members WHERE group_id = ?", groupId);
  modelIds.forEach((modelId, index) => {
    d1.sql(
      "INSERT INTO model_group_members (group_id, model_id, position, enabled) VALUES (?, ?, ?, ?)",
      groupId,
      modelId,
      index,
      enabled
    );
  });
}

export function seedDeviceGroups(
  d1: RealD1,
  groupIds: string[],
  rpms: Record<string, number> = {},
  deviceId = DEVICE_ID
): void {
  d1.sql("DELETE FROM device_model_groups WHERE device_id = ?", deviceId);
  for (const groupId of groupIds) {
    d1.sql(
      "INSERT INTO device_model_groups (device_id, group_id, rpm) VALUES (?, ?, ?)",
      deviceId,
      groupId,
      rpms[groupId] ?? 0
    );
  }
}

export function seedDeviceModels(
  d1: RealD1,
  modelIds: string[],
  rpms: Record<string, number> = {},
  deviceId = DEVICE_ID
): void {
  d1.sql("DELETE FROM device_models WHERE device_id = ?", deviceId);
  for (const modelId of modelIds) {
    d1.sql(
      "INSERT INTO device_models (device_id, model_id, rpm) VALUES (?, ?, ?)",
      deviceId,
      modelId,
      rpms[modelId] ?? 0
    );
  }
}

export function usageAttribution(d1: RealD1) {
  return d1.rows<{
    model: string;
    provider_id: string | null;
    provider_name: string | null;
    cost_usd: number;
    cache_hit: number;
  }>("SELECT model, provider_id, provider_name, cost_usd, cache_hit FROM usage ORDER BY id ASC");
}

export class CollectingExecutionContext {
  readonly pending: Promise<unknown>[] = [];
  waitUntil(p: Promise<unknown>) {
    this.pending.push(p.catch(() => undefined));
  }
  passThroughOnException() {}
  readonly props: unknown = undefined;
  readonly tracing: unknown = undefined;
  readonly access: unknown = undefined;
}

export interface KvDouble {
  KV: KVNamespace;
  store: Map<string, string>;
  writes: { key: string; value: string }[];
}

export function makeKv(): KvDouble {
  const store = new Map<string, string>();
  const writes: { key: string; value: string }[] = [];
  const KV = {
    get: async (key: string) => {
      const raw = store.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    put: async (key: string, value: string) => {
      writes.push({ key, value });
      store.set(key, value);
    },
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }),
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { KV, store, writes };
}

export function makeEnv(d1: RealD1, kv?: KvDouble): Env {
  const env: Record<string, unknown> = { DB: d1.DB, ASSETS: null };
  if (kv) env.CACHE_KV = kv.KV;
  return env as unknown as Env;
}

export function wallet(d1: RealD1, deviceId = DEVICE_ID) {
  return d1.row<{ balance_usd: number; reserved_usd: number }>(
    "SELECT balance_usd, reserved_usd FROM device_wallets WHERE device_id = ?",
    deviceId
  );
}

export function ledgerRows(d1: RealD1, deviceId = DEVICE_ID) {
  return d1.rows<{
    delta_usd: number;
    balance_after: number;
    reason: string;
    request_id: string | null;
    note: string | null;
  }>("SELECT delta_usd, balance_after, reason, request_id, note FROM wallet_ledger WHERE device_id = ? ORDER BY id ASC", deviceId);
}

export function holdRows(d1: RealD1) {
  return d1.rows<{ request_id: string; device_id: string; amount_usd: number }>(
    "SELECT request_id, device_id, amount_usd FROM reserve_holds ORDER BY request_id ASC"
  );
}

export function usageRows(d1: RealD1) {
  return d1.rows<{
    model: string;
    cost_usd: number;
    cache_hit: number;
    price_multiplier: number;
    price_window_id: string | null;
    status_code: number | null;
    input_tokens: number;
    output_tokens: number;
  }>(
    "SELECT model, cost_usd, cache_hit, price_multiplier, price_window_id, status_code, input_tokens, output_tokens FROM usage ORDER BY id ASC"
  );
}

export async function postJson(
  env: Env,
  path: string,
  body: unknown,
  exec: CollectingExecutionContext,
  token = TOKEN
) {
  return gatewayApp.request(
    "http://gw.test" + path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
    exec as never
  );
}

export function chatBody(model = "gw-primary", extra: Record<string, unknown> = {}) {
  return { model, messages: [{ role: "user", content: "hi" }], max_tokens: 8, ...extra };
}

export function openAiAnswer(usage = { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 }) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "gw-primary",
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      usage,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

export function sseAnswer(chunks: string[]) {
  return new Response(chunks.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

export function openAiStreamFrames(text = "pong") {
  return [
    `data: ${JSON.stringify({
      id: "chatcmpl-s",
      object: "chat.completion.chunk",
      model: "gw-primary",
      choices: [{ index: 0, delta: { role: "assistant", content: text } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-s",
      object: "chat.completion.chunk",
      model: "gw-primary",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

export { createRealD1, type RealD1 };
