import type {
  DailyStatsRow,
  DeviceRow,
  Env,
  ModelWithProvider,
  ProviderRow,
  ProviderType,
  TokenUsage,
  UsageRow,
  MonthlyReport,
  MonthlyReportBreakdownItem,
  MonthlyReportDailyTrend,
  CostAnalytics,
  CostAnomalyAlert,
  ModelSpendRankItem,
  AuditLogRow,
  ConfigSnapshotRow,
  IpWhitelistConfig,
  KeyRotationItem,
  KeyRotationReport,
  PricingMode,
  BillingUnit,
  WalletRow,
  WalletLedgerRow,
  LedgerReason,
  PriceWindowRow,
  ModelScope,
  ModelGroupRow,
  ModelGroupMemberRow,
  ModelGroupEdgeRow,
  ResolvedModelTarget,
  DeviceTemplateRow,
  DeviceTemplateModelRow,
  DeviceTemplateGroupRow,
  DeviceTemplateWithGrants,
  SubTokenRow,
} from "../types";
import { newId, randomUUID, openSecret, sealSecret } from "../utils/crypto";
import { ensureSchema } from "./schema";
import { invalidateMonthlyDeviceStatsStatement } from "./monthly_device_stats";
import { usageReportSource, usageCostExpression, validateUsageRange } from "./usage_rollups";
import { usageGroupedReportSource } from "./usage_rollup_read_modes";
import { projectServiceModels } from "../gateway/service_groups";
import { isRawCatalogVisible } from "../gateway/catalog_visibility";
import { aggregateModelMetadata } from "../gateway/model_metadata";
import type { ModelMetadata, ModelMetadataInput } from "../gateway/model_metadata";
import { aggregateProtocolMetadata } from "../gateway/protocol_metadata";
import type { ProtocolMetadata, ProtocolMetadataInput } from "../gateway/protocol_metadata";
import { snapshotServiceGroups, restoreServiceGroupsSnapshot, validateServiceGroupsSnapshot } from "./service_group_snapshot";
import { exportModelCategories, validateModelCategoriesBackup, restoreModelCategoriesStatements, ensureModelCategoriesSchema } from "./model_categories";

const now = () => Date.now();

function normalizeProviderType(type: string): ProviderType {
  if (type === "openai" || type === "gemini") return type;
  return "anthropic";
}


export async function listProviders(env: Env, opts: { includeSecrets?: boolean } = {}): Promise<ProviderRow[]> {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    "SELECT * FROM providers ORDER BY created_at DESC"
  ).all<ProviderRow>();
  const rows = (res.results as unknown as ProviderRow[]) || [];
  if (opts.includeSecrets === false) return rows;
  return Promise.all(rows.map((p) => withOpenedKey(env, p)));
}

export async function withOpenedKey(env: Env, row: ProviderRow): Promise<ProviderRow> {
  if (!row.api_key) return row;
  const opened = await openSecret(row.api_key, env.ENCRYPTION_KEY);
  return { ...row, api_key: opened };
}

export async function getProvider(env: Env, id: string): Promise<ProviderRow | null> {
  const row = (await env.DB.prepare("SELECT * FROM providers WHERE id = ?").bind(id).first()) as ProviderRow | null;
  return row ? withOpenedKey(env, row) : null;
}

export async function createProvider(
  env: Env,
  data: { name: string; type: string; endpoint?: string | null; api_key?: string | null; secret_name?: string | null; enabled?: boolean; config_json?: string | null }
): Promise<ProviderRow> {
  const id = newId("prov");
  const t = now();
  const row: ProviderRow = {
    id,
    name: data.name,
    type: normalizeProviderType(data.type),
    endpoint: data.endpoint || null,
    api_key: (await sealSecret(data.api_key || "", env.ENCRYPTION_KEY)) || null,
    secret_name: data.secret_name || null,
    enabled: data.enabled === false ? 0 : 1,
    config_json: data.config_json || null,
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    "INSERT INTO providers (id, name, type, endpoint, api_key, secret_name, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(row.id, row.name, row.type, row.endpoint, row.api_key, row.secret_name, row.enabled, row.config_json, row.created_at, row.updated_at)
    .run();
  return row;
}

export async function updateProvider(
  env: Env,
  id: string,
  data: { name?: string; type?: string; endpoint?: string | null; api_key?: string | null; secret_name?: string | null; enabled?: boolean; config_json?: string | null }
): Promise<ProviderRow | null> {
  const existing = await getProvider(env, id);
  if (!existing) return null;
  const next: ProviderRow = {
    ...existing,
    name: data.name ?? existing.name,
    type: data.type ? normalizeProviderType(data.type) : existing.type,
    endpoint: data.endpoint !== undefined ? data.endpoint : existing.endpoint,
    api_key: data.api_key !== undefined
      ? (await sealSecret(data.api_key || "", env.ENCRYPTION_KEY)) || null
      : existing.api_key,
    secret_name: data.secret_name !== undefined ? data.secret_name : existing.secret_name,
    enabled: data.enabled !== undefined ? (data.enabled ? 1 : 0) : existing.enabled,
    config_json: data.config_json !== undefined ? data.config_json : existing.config_json,
    updated_at: now(),
  };
  await env.DB.prepare(
    "UPDATE providers SET name = ?, type = ?, endpoint = ?, api_key = ?, secret_name = ?, enabled = ?, config_json = ?, updated_at = ? WHERE id = ?"
  )
    .bind(next.name, next.type, next.endpoint, next.api_key, next.secret_name, next.enabled, next.config_json, next.updated_at, id)
    .run();
  return next;
}

export async function deleteProvider(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM models WHERE provider_id = ?"
  ).bind(id).first<{ count: number }>();
  if (res && res.count > 0) return false;
  await env.DB.prepare("DELETE FROM providers WHERE id = ?").bind(id).run();
  return true;
}

export async function batchUpdateProviders(env: Env, ids: string[], data: { enabled?: boolean }): Promise<number> {
  if (!ids.length) return 0;
  await ensureSchema(env);
  const sets: string[] = ["updated_at = ?"];
  const binds: any[] = [now()];

  if (data.enabled !== undefined) {
    sets.push("enabled = ?");
    binds.push(data.enabled ? 1 : 0);
  }

  const placeholders = ids.map(() => "?").join(",");
  const sql = `UPDATE providers SET ${sets.join(", ")} WHERE id IN (${placeholders})`;
  const res = await env.DB.prepare(sql).bind(...binds, ...ids).run();
  return res.meta.changes;
}

export async function batchDeleteProviders(env: Env, ids: string[]): Promise<{ deleted: number; skipped: number }> {
  if (!ids.length) return { deleted: 0, skipped: 0 };
  await ensureSchema(env);

  const placeholders = ids.map(() => "?").join(", ");
  const usedRes = await env.DB.prepare(
    `SELECT DISTINCT provider_id FROM models WHERE provider_id IN (${placeholders})`
  ).bind(...ids).all<{ provider_id: string }>();

  const usedSet = new Set((usedRes.results || []).map((r) => r.provider_id));
  const deletableIds = ids.filter((id) => !usedSet.has(id));
  const skipped = ids.length - deletableIds.length;

  if (deletableIds.length === 0) {
    return { deleted: 0, skipped };
  }

  const deletePlaceholders = deletableIds.map(() => "?").join(", ");
  const delRes = await env.DB.prepare(
    `DELETE FROM providers WHERE id IN (${deletePlaceholders})`
  ).bind(...deletableIds).run();

  return { deleted: delRes.meta.changes, skipped };
}

export function resolvePricingMode(
  mode: PricingMode | undefined,
  inputPrice: number | undefined,
  outputPrice: number | undefined,
  fallback?: PricingMode
): PricingMode {
  if (mode) return mode;
  if ((inputPrice ?? 0) > 0 || (outputPrice ?? 0) > 0) return "priced";
  return fallback ?? "unset";
}

export function resolveRowPricingModeForWrite(
  mode: PricingMode | undefined,
  billingUnit: BillingUnit | undefined,
  pricePerCall: number | undefined,
  inputPrice: number | undefined,
  outputPrice: number | undefined,
  fallback?: PricingMode
): PricingMode {
  const resolved = resolvePricingMode(mode, inputPrice, outputPrice, fallback);
  if (mode) return mode;
  if (billingUnit === "call" && (pricePerCall ?? 0) > 0 && resolved === "unset") return "priced";
  return resolved;
}


function modelReferenceWriteStatements(
  env: Env,
  statements: D1PreparedStatement[],
  modelIds: string[] = [],
  groupIds: string[] = []
): D1PreparedStatement[] {
  if (!modelIds.length && !groupIds.length) return statements;
  const guardId = newId("model_ref_guard");
  return [
    env.DB.prepare(
      "INSERT INTO public_model_write_guards (id, valid) SELECT ?, CASE WHEN " +
        "NOT EXISTS (SELECT 1 FROM json_each(?) requested WHERE NOT EXISTS (SELECT 1 FROM models m WHERE m.id = requested.value)) " +
        "AND NOT EXISTS (SELECT 1 FROM json_each(?) requested WHERE NOT EXISTS (SELECT 1 FROM model_groups g WHERE g.id = requested.value)) " +
        "THEN 1 ELSE 0 END"
    ).bind(guardId, JSON.stringify(modelIds), JSON.stringify(groupIds)),
    ...statements,
    env.DB.prepare("DELETE FROM public_model_write_guards WHERE id = ?").bind(guardId),
  ];
}

export async function listModels(env: Env, opts: { includeSecrets?: boolean; adminProjection?: boolean } = {}) {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    (opts.adminProjection
      ? "SELECT m.*, p.name as provider_name, p.type as provider_type "
      : "SELECT m.*, p.name as provider_name, p.type as provider_type, p.api_key as provider_api_key, p.secret_name as provider_secret_name, p.config_json as provider_config_json, p.endpoint as provider_endpoint ") +
      "FROM models m LEFT JOIN providers p ON p.id = m.provider_id ORDER BY m.created_at DESC"
  ).all<ModelWithProvider>();
  const rows = (res.results as unknown as ModelWithProvider[]) || [];
  if (opts.includeSecrets === false) return rows;
  return Promise.all(rows.map((m) => openModelKey(env, m)));
}

export async function getModel(env: Env, id: string) {
  return (await env.DB.prepare("SELECT * FROM models WHERE id = ?").bind(id).first()) as ModelWithProvider | null;
}

export async function getModelWithProviderById(env: Env, id: string, opts: { includeSecrets?: boolean } = {}): Promise<ModelWithProvider | null> {
  const row = (await env.DB.prepare(
    "SELECT m.*, p.name as provider_name, p.type as provider_type, p.api_key as provider_api_key, p.secret_name as provider_secret_name, p.config_json as provider_config_json, p.endpoint as provider_endpoint " +
      "FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ? AND m.enabled = 1 AND p.enabled = 1"
  ).bind(id).first()) as ModelWithProvider | null;
  return row && opts.includeSecrets !== false ? openModelKey(env, row) : row;
}

export async function openModelKey(env: Env, row: ModelWithProvider): Promise<ModelWithProvider> {
  if (!row.provider_api_key) return row;
  const opened = await openSecret(row.provider_api_key, env.ENCRYPTION_KEY);
  return { ...row, provider_api_key: opened };
}

export async function createModel(
  env: Env,
  data: {
    provider_id: string;
    model_name: string;
    display_name?: string;
    alias?: string;
    fallback_model_id?: string | null;
    input_price_per_m?: number;
    output_price_per_m?: number;
    cache_read_price_per_m?: number;
    cache_write_price_per_m?: number;
    cache_enabled?: boolean;
    cache_ttl?: number;
    enabled?: boolean;
    model_public?: boolean;
    pricing_mode?: PricingMode;
    peak_pricing_enabled?: boolean;
    billing_unit?: BillingUnit;
    price_per_call?: number;
    search_price_per_call?: number;
    config_json?: string;
  }
) {
  const id = newId("model");
  const t = now();
  const row = {
    id,
    provider_id: data.provider_id,
    model_name: data.model_name,
    display_name: data.display_name || null,
    alias: data.alias || null,
    fallback_model_id: data.fallback_model_id || null,
    input_price_per_m: typeof data.input_price_per_m === "number" ? data.input_price_per_m : 0,
    output_price_per_m: typeof data.output_price_per_m === "number" ? data.output_price_per_m : 0,
    cache_read_price_per_m: typeof data.cache_read_price_per_m === "number" ? data.cache_read_price_per_m : 0,
    cache_write_price_per_m: typeof data.cache_write_price_per_m === "number" ? data.cache_write_price_per_m : 0,
    cache_enabled: data.cache_enabled ? 1 : 0,
    cache_ttl: typeof data.cache_ttl === "number" && data.cache_ttl >= 60 ? data.cache_ttl : 3600,
    enabled: data.enabled === false ? 0 : 1,
    model_public: data.model_public ? 1 : 0,
    pricing_mode: resolveRowPricingModeForWrite(
      data.pricing_mode,
      data.billing_unit,
      data.price_per_call,
      data.input_price_per_m,
      data.output_price_per_m
    ),
    peak_pricing_enabled: data.peak_pricing_enabled ? 1 : 0,
    billing_unit: data.billing_unit === "call" ? "call" : "token",
    price_per_call: typeof data.price_per_call === "number" && data.price_per_call > 0 ? data.price_per_call : 0,
    search_price_per_call:
      typeof data.search_price_per_call === "number" && data.search_price_per_call > 0 ? data.search_price_per_call : 0,
    config_json: data.config_json || null,
    created_at: t,
    updated_at: t,
  };
  const statement = env.DB.prepare(
    "INSERT INTO models (id, provider_id, model_name, display_name, alias, fallback_model_id, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, cache_enabled, cache_ttl, enabled, model_public, pricing_mode, peak_pricing_enabled, billing_unit, price_per_call, search_price_per_call, config_json, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      row.id,
      row.provider_id,
      row.model_name,
      row.display_name,
      row.alias,
      row.fallback_model_id,
      row.input_price_per_m,
      row.output_price_per_m,
      row.cache_read_price_per_m,
      row.cache_write_price_per_m,
      row.cache_enabled,
      row.cache_ttl,
      row.enabled,
      row.model_public,
      row.pricing_mode,
      row.peak_pricing_enabled,
      row.billing_unit,
      row.price_per_call,
      row.search_price_per_call,
      row.config_json,
      row.created_at,
      row.updated_at
    );
  if (row.fallback_model_id) {
    await env.DB.batch(modelReferenceWriteStatements(env, [statement], [row.fallback_model_id]));
  } else {
    await statement.run();
  }
  return row;
}

export async function updateModel(
  env: Env,
  id: string,
  data: {
    provider_id?: string;
    model_name?: string;
    display_name?: string | null;
    alias?: string | null;
    fallback_model_id?: string | null;
    input_price_per_m?: number;
    output_price_per_m?: number;
    cache_read_price_per_m?: number;
    cache_write_price_per_m?: number;
    cache_enabled?: boolean;
    cache_ttl?: number;
    enabled?: boolean;
    model_public?: boolean;
    pricing_mode?: PricingMode;
    peak_pricing_enabled?: boolean;
    billing_unit?: BillingUnit;
    price_per_call?: number;
    search_price_per_call?: number;
    config_json?: string | null;
  }
) {
  const existing = await getModel(env, id);
  if (!existing) return null;
  const nextInPrice = typeof data.input_price_per_m === "number" ? data.input_price_per_m : (existing.input_price_per_m || 0);
  const nextOutPrice = typeof data.output_price_per_m === "number" ? data.output_price_per_m : (existing.output_price_per_m || 0);
  const next = {
    ...existing,
    provider_id: data.provider_id ?? existing.provider_id,
    model_name: data.model_name ?? existing.model_name,
    display_name: data.display_name !== undefined ? data.display_name : existing.display_name,
    alias: data.alias !== undefined ? data.alias : existing.alias,
    fallback_model_id: data.fallback_model_id !== undefined ? data.fallback_model_id : (existing.fallback_model_id || null),
    input_price_per_m: nextInPrice,
    output_price_per_m: nextOutPrice,
    cache_read_price_per_m: typeof data.cache_read_price_per_m === "number" ? data.cache_read_price_per_m : (existing.cache_read_price_per_m || 0),
    cache_write_price_per_m: typeof data.cache_write_price_per_m === "number" ? data.cache_write_price_per_m : (existing.cache_write_price_per_m || 0),
    cache_enabled: data.cache_enabled !== undefined ? (data.cache_enabled ? 1 : 0) : (existing.cache_enabled || 0),
    cache_ttl: typeof data.cache_ttl === "number" && data.cache_ttl >= 60 ? data.cache_ttl : (existing.cache_ttl || 3600),
    enabled: data.enabled !== undefined ? (data.enabled ? 1 : 0) : existing.enabled,
    model_public: data.model_public !== undefined ? (data.model_public ? 1 : 0) : (existing.model_public || 0),
    pricing_mode: resolveRowPricingModeForWrite(
      data.pricing_mode,
      data.billing_unit !== undefined ? data.billing_unit : existing.billing_unit,
      typeof data.price_per_call === "number" ? data.price_per_call : existing.price_per_call,
      nextInPrice,
      nextOutPrice,
      existing.pricing_mode
    ),
    peak_pricing_enabled: data.peak_pricing_enabled !== undefined ? (data.peak_pricing_enabled ? 1 : 0) : (existing.peak_pricing_enabled || 0),
    billing_unit:
      data.billing_unit !== undefined
        ? data.billing_unit === "call"
          ? "call"
          : "token"
        : existing.billing_unit === "call"
          ? "call"
          : "token",
    price_per_call:
      typeof data.price_per_call === "number"
        ? data.price_per_call > 0
          ? data.price_per_call
          : 0
        : existing.price_per_call || 0,
    search_price_per_call:
      typeof data.search_price_per_call === "number"
        ? data.search_price_per_call > 0
          ? data.search_price_per_call
          : 0
        : existing.search_price_per_call || 0,
    config_json: data.config_json !== undefined ? data.config_json : existing.config_json,
    updated_at: now(),
  };
  const statement = env.DB.prepare(
    "UPDATE models SET provider_id = ?, model_name = ?, display_name = ?, alias = ?, fallback_model_id = ?, input_price_per_m = ?, output_price_per_m = ?, cache_read_price_per_m = ?, cache_write_price_per_m = ?, cache_enabled = ?, cache_ttl = ?, enabled = ?, model_public = ?, pricing_mode = ?, peak_pricing_enabled = ?, billing_unit = ?, price_per_call = ?, search_price_per_call = ?, config_json = ?, updated_at = ? WHERE id = ?"
  )
    .bind(
      next.provider_id,
      next.model_name,
      next.display_name,
      next.alias,
      next.fallback_model_id,
      next.input_price_per_m,
      next.output_price_per_m,
      next.cache_read_price_per_m,
      next.cache_write_price_per_m,
      next.cache_enabled,
      next.cache_ttl,
      next.enabled,
      next.model_public,
      next.pricing_mode,
      next.peak_pricing_enabled,
      next.billing_unit,
      next.price_per_call,
      next.search_price_per_call,
      next.config_json,
      next.updated_at,
      id
    );
  if (next.fallback_model_id) {
    await env.DB.batch(modelReferenceWriteStatements(env, [statement], [next.fallback_model_id]));
  } else {
    await statement.run();
  }
  resetModelCatalogCache();
  return next;
}

export async function deleteModel(env: Env, id: string): Promise<boolean> {
  const [, , , res] = await env.DB.batch([
    env.DB.prepare("DELETE FROM model_group_members WHERE model_id = ?").bind(id),
    env.DB.prepare("DELETE FROM device_models WHERE model_id = ?").bind(id),
    env.DB.prepare("DELETE FROM device_template_models WHERE model_id = ?").bind(id),
    env.DB.prepare("DELETE FROM models WHERE id = ?").bind(id),
  ]);
  return Number(res.meta?.changes || 0) > 0;
}

export async function batchUpdateModels(
  env: Env,
  ids: string[],
  data: { enabled?: boolean; cache_enabled?: boolean; cache_ttl?: number; model_public?: boolean; pricing_mode?: PricingMode; peak_pricing_enabled?: boolean }
): Promise<number> {
  if (!ids.length) return 0;
  await ensureSchema(env);
  const sets: string[] = ["updated_at = ?"];
  const binds: any[] = [now()];

  if (data.enabled !== undefined) {
    sets.push("enabled = ?");
    binds.push(data.enabled ? 1 : 0);
  }
  if (data.cache_enabled !== undefined) {
    sets.push("cache_enabled = ?");
    binds.push(data.cache_enabled ? 1 : 0);
  }
  if (data.cache_ttl !== undefined) {
    sets.push("cache_ttl = ?");
    binds.push(data.cache_ttl);
  }
  if (data.model_public !== undefined) {
    sets.push("model_public = ?");
    binds.push(data.model_public ? 1 : 0);
  }
  if (data.pricing_mode !== undefined) {
    sets.push("pricing_mode = ?");
    binds.push(data.pricing_mode);
  }
  if (data.peak_pricing_enabled !== undefined) {
    sets.push("peak_pricing_enabled = ?");
    binds.push(data.peak_pricing_enabled ? 1 : 0);
  }

  const placeholders = ids.map(() => "?").join(",");
  const sql = `UPDATE models SET ${sets.join(", ")} WHERE id IN (${placeholders})`;
  const res = await env.DB.prepare(sql).bind(...binds, ...ids).run();
  return res.meta.changes;
}

export async function batchDeleteModels(env: Env, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  await ensureSchema(env);
  const placeholders = ids.map(() => "?").join(",");
  const [, , , res] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM model_group_members WHERE model_id IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM device_models WHERE model_id IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM device_template_models WHERE model_id IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM models WHERE id IN (${placeholders})`).bind(...ids),
  ]);
  return res.meta.changes;
}

export async function findModelAndProvider(env: Env, modelKey: string): Promise<ModelWithProvider | null> {
  const candidates = await findModelCandidates(env, modelKey);
  return candidates[0] || null;
}

export async function findModelCandidates(env: Env, modelKey: string): Promise<ModelWithProvider[]> {
  const rows = await findModelCandidateMetadata(env, modelKey);
  return Promise.all(rows.map((m) => openModelKey(env, m)));
}

export async function findModelCandidateMetadata(env: Env, modelKey: string): Promise<ModelWithProvider[]> {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    "SELECT m.*, p.name as provider_name, p.type as provider_type, p.api_key as provider_api_key, p.secret_name as provider_secret_name, p.config_json as provider_config_json, p.endpoint as provider_endpoint " +
      "FROM models m JOIN providers p ON p.id = m.provider_id " +
      "WHERE m.enabled = 1 AND p.enabled = 1 AND (m.model_name = ? OR m.alias = ?) " +
      "ORDER BY (CASE WHEN m.model_name = ? THEN 0 ELSE 1 END), m.created_at DESC"
  ).bind(modelKey, modelKey, modelKey).all<ModelWithProvider>();
  return (res.results || []) as unknown as ModelWithProvider[];
}

export async function getRecentProviderAvgLatencies(env: Env, sinceMs = 3600_000): Promise<Record<string, number>> {
  await ensureSchema(env);
  const since = Date.now() - sinceMs;
  const res = await env.DB.prepare(`
    SELECT provider_id, COALESCE(AVG(latency_ms), 0) as avg_latency
    FROM usage INDEXED BY idx_usage_created_at
    WHERE created_at >= ? AND latency_ms > 0 AND (status_code IS NULL OR status_code < 400)
    GROUP BY provider_id
  `).bind(since).all<{ provider_id: string; avg_latency: number }>();

  const map: Record<string, number> = {};
  for (const r of (res.results || [])) {
    if (r.provider_id) map[r.provider_id] = Math.round(Number(r.avg_latency));
  }
  return map;
}

export async function getRecentProviderFailureStats(
  env: Env,
  sinceMs = 300_000
): Promise<Record<string, { failureRate: number; samples: number }>> {
  await ensureSchema(env);
  const since = Date.now() - sinceMs;
  const res = await env.DB.prepare(`
    SELECT provider_id,
           COUNT(*) as attempts,
           SUM(CASE WHEN status_code >= 400 AND status_code <> 0 THEN 1 ELSE 0 END) as failures
    FROM usage INDEXED BY idx_usage_created_at
    WHERE created_at >= ? AND provider_id IS NOT NULL
    GROUP BY provider_id
  `).bind(since).all<{ provider_id: string; attempts: number; failures: number }>();

  const map: Record<string, { failureRate: number; samples: number }> = {};
  for (const r of (res.results || [])) {
    const attempts = Number(r.attempts) || 0;
    if (!r.provider_id || attempts <= 0) continue;
    const failures = Number(r.failures) || 0;
    map[r.provider_id] = { failureRate: failures / attempts, samples: attempts };
  }
  return map;
}


export async function openGroupMemberKey(env: Env, row: ModelWithProvider): Promise<ModelWithProvider> {
  if (!row.provider_api_key) return row;
  return { ...row, provider_api_key: await openSecret(row.provider_api_key, env.ENCRYPTION_KEY) };
}

export async function resolveModelKey(env: Env, modelKey: string, opts: { includeSecrets?: boolean } = {}): Promise<ResolvedModelTarget> {
  const candidates = await (opts.includeSecrets === false ? findModelCandidateMetadata : findModelCandidates)(env, modelKey);
  if (candidates.length) return { kind: "model", candidates };

  const group = await getModelGroupByName(env, modelKey);
  if (!group || !group.enabled) return { kind: "none" };
  const members = await listModelGroupMembers(env, group.id);
  return { kind: "group", group, members };
}

export async function listModelGroups(env: Env): Promise<ModelGroupRow[]> {
  await ensureSchema(env);
  const res = await env.DB.prepare("SELECT * FROM model_groups ORDER BY created_at DESC").all<ModelGroupRow>();
  return (res.results || []) as unknown as ModelGroupRow[];
}

export async function getModelGroup(env: Env, id: string): Promise<ModelGroupRow | null> {
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT * FROM model_groups WHERE id = ?").bind(id).first<ModelGroupRow>();
  return (row || null) as ModelGroupRow | null;
}

export async function getModelGroupByName(env: Env, name: string): Promise<ModelGroupRow | null> {
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT * FROM model_groups WHERE name = ?").bind(name).first<ModelGroupRow>();
  return (row || null) as ModelGroupRow | null;
}

export async function createModelGroup(
  env: Env,
  data: {
    name: string;
    display_name?: string | null;
    description?: string | null;
    enabled?: boolean;
    model_public?: boolean;
    pricing_mode?: PricingMode;
    input_price_per_m?: number;
    output_price_per_m?: number;
    cache_read_price_per_m?: number;
    cache_write_price_per_m?: number;
    cache_enabled?: boolean;
    cache_ttl?: number;
    peak_pricing_enabled?: boolean;
    billing_unit?: BillingUnit;
    price_per_call?: number;
    search_price_per_call?: number;
    config_json?: string | null;
  }
): Promise<ModelGroupRow> {
  const id = newId("grp");
  const t = now();
  const row: ModelGroupRow = {
    id,
    name: data.name,
    display_name: data.display_name || null,
    description: data.description || null,
    enabled: data.enabled === false ? 0 : 1,
    model_public: data.model_public ? 1 : 0,
    pricing_mode: resolveRowPricingModeForWrite(
      data.pricing_mode,
      data.billing_unit,
      data.price_per_call,
      data.input_price_per_m,
      data.output_price_per_m
    ),
    input_price_per_m: typeof data.input_price_per_m === "number" ? data.input_price_per_m : 0,
    output_price_per_m: typeof data.output_price_per_m === "number" ? data.output_price_per_m : 0,
    cache_read_price_per_m: typeof data.cache_read_price_per_m === "number" ? data.cache_read_price_per_m : 0,
    cache_write_price_per_m: typeof data.cache_write_price_per_m === "number" ? data.cache_write_price_per_m : 0,
    cache_enabled: data.cache_enabled ? 1 : 0,
    cache_ttl: typeof data.cache_ttl === "number" && data.cache_ttl >= 60 ? data.cache_ttl : 3600,
    peak_pricing_enabled: data.peak_pricing_enabled ? 1 : 0,
    billing_unit: data.billing_unit === "call" ? "call" : "token",
    price_per_call: typeof data.price_per_call === "number" && data.price_per_call > 0 ? data.price_per_call : 0,
    search_price_per_call:
      typeof data.search_price_per_call === "number" && data.search_price_per_call > 0 ? data.search_price_per_call : 0,
    config_json: data.config_json || null,
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    "INSERT INTO model_groups (id, name, display_name, description, enabled, model_public, pricing_mode, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, cache_enabled, cache_ttl, peak_pricing_enabled, billing_unit, price_per_call, search_price_per_call, config_json, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      row.id,
      row.name,
      row.display_name,
      row.description,
      row.enabled,
      row.model_public,
      row.pricing_mode,
      row.input_price_per_m,
      row.output_price_per_m,
      row.cache_read_price_per_m,
      row.cache_write_price_per_m,
      row.cache_enabled,
      row.cache_ttl,
      row.peak_pricing_enabled,
      row.billing_unit,
      row.price_per_call,
      row.search_price_per_call,
      row.config_json,
      row.created_at,
      row.updated_at
    )
    .run();
  return row;
}

export async function updateModelGroup(
  env: Env,
  id: string,
  data: {
    name?: string;
    display_name?: string | null;
    description?: string | null;
    enabled?: boolean;
    model_public?: boolean;
    pricing_mode?: PricingMode;
    input_price_per_m?: number;
    output_price_per_m?: number;
    cache_read_price_per_m?: number;
    cache_write_price_per_m?: number;
    cache_enabled?: boolean;
    cache_ttl?: number;
    peak_pricing_enabled?: boolean;
    billing_unit?: BillingUnit;
    price_per_call?: number;
    search_price_per_call?: number;
    config_json?: string | null;
  }
): Promise<ModelGroupRow | null> {
  const existing = await getModelGroup(env, id);
  if (!existing) return null;
  const nextInPrice = typeof data.input_price_per_m === "number" ? data.input_price_per_m : (existing.input_price_per_m || 0);
  const nextOutPrice = typeof data.output_price_per_m === "number" ? data.output_price_per_m : (existing.output_price_per_m || 0);
  const next: ModelGroupRow = {
    ...existing,
    name: data.name !== undefined ? data.name : existing.name,
    display_name: data.display_name !== undefined ? data.display_name : existing.display_name,
    description: data.description !== undefined ? data.description : existing.description,
    enabled: data.enabled !== undefined ? (data.enabled ? 1 : 0) : existing.enabled,
    model_public: data.model_public !== undefined ? (data.model_public ? 1 : 0) : existing.model_public,
    pricing_mode: resolveRowPricingModeForWrite(
      data.pricing_mode,
      data.billing_unit !== undefined ? data.billing_unit : existing.billing_unit,
      typeof data.price_per_call === "number" ? data.price_per_call : existing.price_per_call,
      nextInPrice,
      nextOutPrice,
      existing.pricing_mode
    ),
    input_price_per_m: nextInPrice,
    output_price_per_m: nextOutPrice,
    cache_read_price_per_m:
      typeof data.cache_read_price_per_m === "number" ? data.cache_read_price_per_m : (existing.cache_read_price_per_m || 0),
    cache_write_price_per_m:
      typeof data.cache_write_price_per_m === "number" ? data.cache_write_price_per_m : (existing.cache_write_price_per_m || 0),
    cache_enabled: data.cache_enabled !== undefined ? (data.cache_enabled ? 1 : 0) : existing.cache_enabled,
    cache_ttl: typeof data.cache_ttl === "number" && data.cache_ttl >= 60 ? data.cache_ttl : (existing.cache_ttl || 3600),
    peak_pricing_enabled:
      data.peak_pricing_enabled !== undefined ? (data.peak_pricing_enabled ? 1 : 0) : existing.peak_pricing_enabled,
    billing_unit:
      data.billing_unit !== undefined
        ? data.billing_unit === "call"
          ? "call"
          : "token"
        : existing.billing_unit === "call"
          ? "call"
          : "token",
    price_per_call:
      typeof data.price_per_call === "number"
        ? data.price_per_call > 0
          ? data.price_per_call
          : 0
        : existing.price_per_call || 0,
    search_price_per_call:
      typeof data.search_price_per_call === "number"
        ? data.search_price_per_call > 0
          ? data.search_price_per_call
          : 0
        : existing.search_price_per_call || 0,
    config_json: data.config_json !== undefined ? data.config_json : existing.config_json,
    updated_at: now(),
  };
  await env.DB.prepare(
    "UPDATE model_groups SET name = ?, display_name = ?, description = ?, enabled = ?, model_public = ?, pricing_mode = ?, input_price_per_m = ?, output_price_per_m = ?, cache_read_price_per_m = ?, cache_write_price_per_m = ?, cache_enabled = ?, cache_ttl = ?, peak_pricing_enabled = ?, billing_unit = ?, price_per_call = ?, search_price_per_call = ?, config_json = ?, updated_at = ? WHERE id = ?"
  )
    .bind(
      next.name,
      next.display_name,
      next.description,
      next.enabled,
      next.model_public,
      next.pricing_mode,
      next.input_price_per_m,
      next.output_price_per_m,
      next.cache_read_price_per_m,
      next.cache_write_price_per_m,
      next.cache_enabled,
      next.cache_ttl,
      next.peak_pricing_enabled,
      next.billing_unit,
      next.price_per_call,
      next.search_price_per_call,
      next.config_json,
      next.updated_at,
      id
    )
    .run();
  resetModelCatalogCache();
  return next;
}

export async function deleteModelGroup(env: Env, id: string): Promise<boolean> {
  await ensureSchema(env);
  const [, , , res] = await env.DB.batch([
    env.DB.prepare("DELETE FROM model_group_members WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM device_model_groups WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM device_template_groups WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM model_groups WHERE id = ?").bind(id),
  ]);
  return Number(res.meta?.changes || 0) > 0;
}

export async function listModelGroupMembers(env: Env, groupId: string): Promise<ModelGroupMemberRow[]> {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    "SELECT mo.*, p.name as provider_name, p.type as provider_type, p.api_key as provider_api_key, p.secret_name as provider_secret_name, p.config_json as provider_config_json, p.endpoint as provider_endpoint, gm.position as position " +
      "FROM model_group_members gm " +
      "JOIN models mo ON mo.id = gm.model_id " +
      "JOIN providers p ON p.id = mo.provider_id " +
      "WHERE gm.group_id = ? AND gm.enabled = 1 AND mo.enabled = 1 AND p.enabled = 1 " +
      "ORDER BY gm.position ASC, mo.created_at DESC"
  )
    .bind(groupId)
    .all<ModelGroupMemberRow>();
  return (res.results || []) as unknown as ModelGroupMemberRow[];
}

export async function replaceModelGroupMembers(
  env: Env,
  groupId: string,
  members: Array<{ model_id: string; position?: number; enabled?: boolean }>
): Promise<ModelGroupMemberRow[]> {
  await ensureSchema(env);
  const seen = new Set<string>();
  const normalised: Array<{ model_id: string; position: number; enabled: number }> = [];
  members.forEach((m, index) => {
    const id = String(m?.model_id ?? "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    normalised.push({
      model_id: id,
      position: typeof m.position === "number" && Number.isFinite(m.position) ? Math.floor(m.position) : index,
      enabled: m.enabled === false ? 0 : 1,
    });
  });
  const statements = [env.DB.prepare("DELETE FROM model_group_members WHERE group_id = ?").bind(groupId)];
  for (const m of normalised) {
    statements.push(env.DB.prepare(
      "INSERT OR IGNORE INTO model_group_members (group_id, model_id, position, enabled) VALUES (?, ?, ?, ?)"
    ).bind(groupId, m.model_id, m.position, m.enabled));
  }
  await env.DB.batch(modelReferenceWriteStatements(env, statements, normalised.map(m => m.model_id), [groupId]));
  return listModelGroupMembers(env, groupId);
}

export async function listAllModelGroupMembers(env: Env): Promise<ModelGroupEdgeRow[]> {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    "SELECT gm.group_id as group_id, gm.model_id as model_id, gm.position as position, gm.enabled as enabled, " +
      "mo.model_name as model_name, mo.display_name as display_name, p.name as provider_name, p.type as provider_type, p.config_json as provider_config_json " +
      "FROM model_group_members gm " +
      "LEFT JOIN models mo ON mo.id = gm.model_id " +
      "LEFT JOIN providers p ON p.id = mo.provider_id " +
      "ORDER BY gm.group_id ASC, gm.position ASC"
  ).all<ModelGroupEdgeRow>();
  return (res.results || []) as unknown as ModelGroupEdgeRow[];
}

export async function listModelProviderTypes(env: Env, modelIds: string[]): Promise<Map<string, string>> {
  await ensureSchema(env);
  const out = new Map<string, string>();
  if (!modelIds.length) return out;
  const placeholders = modelIds.map(() => "?").join(", ");
  const res = await env.DB.prepare(
    `SELECT m.id as id, p.type as provider_type FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id IN (${placeholders})`
  )
    .bind(...modelIds)
    .all<{ id: string; provider_type: string }>();
  for (const r of res.results || []) out.set(r.id, r.provider_type);
  return out;
}

export async function getDeviceGroupIds(env: Env, deviceId: string): Promise<string[]> {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    "SELECT group_id FROM device_model_groups WHERE device_id = ? ORDER BY group_id"
  )
    .bind(deviceId)
    .all<{ group_id: string }>();
  return (res.results || []).map((r) => r.group_id);
}

export async function getDeviceGroupRateLimits(env: Env, deviceId: string): Promise<Map<string, number>> {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    "SELECT group_id, rpm FROM device_model_groups WHERE device_id = ? AND rpm > 0"
  )
    .bind(deviceId)
    .all<{ group_id: string; rpm: number }>();
  const limits = new Map<string, number>();
  for (const r of res.results || []) {
    const rpm = Number(r.rpm);
    if (Number.isFinite(rpm) && rpm > 0) limits.set(r.group_id, rpm);
  }
  return limits;
}

export async function replaceDeviceModelGroups(
  env: Env,
  deviceId: string,
  groups: Array<string | { group_id: string; rpm?: number | null }>
): Promise<string[]> {
  await ensureSchema(env);
  const byId = new Map<string, number>();
  for (const entry of groups) {
    const id = String(typeof entry === "string" ? entry : entry?.group_id ?? "").trim();
    if (!id) continue;
    const raw = typeof entry === "string" ? 0 : entry?.rpm;
    const rpm = Number(raw);
    const normalised = Number.isFinite(rpm) && rpm > 0 ? Math.floor(rpm) : 0;
    byId.set(id, Math.max(byId.get(id) ?? 0, normalised));
  }
  const statements = [env.DB.prepare("DELETE FROM device_model_groups WHERE device_id = ?").bind(deviceId)];
  for (const [groupId, rpm] of byId) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO device_model_groups (device_id, group_id, rpm) VALUES (?, ?, ?)").bind(
        deviceId,
        groupId,
        rpm
      )
    );
  }
  await env.DB.batch(modelReferenceWriteStatements(env, statements, [], [...byId.keys()]));
  return getDeviceGroupIds(env, deviceId);
}

export interface ModelProjectionRow extends ModelWithProvider {
  model_metadata?: ModelMetadata;
  protocol_metadata?: ProtocolMetadata;
  member_count?: number;
  is_group?: boolean;
  description?: string | null;
}

export async function listGroupsForDevice(
  env: Env,
  device: DeviceRow | null,
  opts: { includePrivate?: boolean } = {}
): Promise<ModelProjectionRow[]> {
  await ensureSchema(env);
  const scope: ModelScope = device ? device.model_scope || "all" : "list";
  const [groupsRes, membersRes, granted] = await Promise.all([
    env.DB.prepare("SELECT * FROM model_groups WHERE enabled = 1 ORDER BY created_at DESC").all<ModelGroupRow>(),
    env.DB.prepare(
      "SELECT gm.group_id as group_id, gm.position as position, mo.id as model_id, mo.model_name, mo.alias, mo.config_json, mo.billing_unit, p.type as provider_type, p.config_json as provider_config_json " +
        "FROM model_group_members gm " +
        "JOIN models mo ON mo.id = gm.model_id " +
        "JOIN providers p ON p.id = mo.provider_id " +
        "WHERE gm.enabled = 1 AND mo.enabled = 1 AND p.enabled = 1 " +
        "ORDER BY gm.group_id ASC, gm.position ASC, mo.created_at DESC"
    ).all<ModelMetadataInput & ProtocolMetadataInput & { group_id: string; position: number; model_id: string; provider_type: ProviderType }>(),
    device && scope !== "all" ? getDeviceGroupIds(env, device.id).then((ids) => new Set(ids)) : Promise.resolve(new Set<string>()),
  ]);

  const groups = (groupsRes.results || []) as unknown as ModelGroupRow[];
  const firstType = new Map<string, ProviderType>();
  const memberCount = new Map<string, number>();
  const metadataMembers = new Map<string, Array<ModelMetadataInput & ProtocolMetadataInput>>();
  for (const r of membersRes.results || []) {
    const members = metadataMembers.get(r.group_id) || [];
    members.push(r);
    metadataMembers.set(r.group_id, members);
    if (!firstType.has(r.group_id)) firstType.set(r.group_id, r.provider_type);
    memberCount.set(r.group_id, (memberCount.get(r.group_id) || 0) + 1);
  }

  const visible = device
    ? groups.filter((g) => isModelInScope(scope, g.id, granted, Boolean(g.model_public)))
    : groups.filter((g) => opts.includePrivate || Boolean(g.model_public));

  return visible
    .filter((g) => (memberCount.get(g.id) || 0) > 0)
    .map((g) => projectGroup(g, firstType.get(g.id) || "openai", memberCount.get(g.id) || 0, metadataMembers.get(g.id) || []));
}

export function projectGroup(group: ModelGroupRow, providerType: ProviderType, memberCount = 0, members: readonly (ModelMetadataInput & ProtocolMetadataInput)[] = []): ModelProjectionRow {
  return {
    id: group.id,
    provider_id: "",
    model_name: group.name,
    display_name: group.display_name || group.name,
    alias: null,
    fallback_model_id: null,
    input_price_per_m: group.input_price_per_m || 0,
    output_price_per_m: group.output_price_per_m || 0,
    cache_read_price_per_m: group.cache_read_price_per_m || 0,
    cache_write_price_per_m: group.cache_write_price_per_m || 0,
    cache_enabled: group.cache_enabled,
    cache_ttl: group.cache_ttl,
    enabled: group.enabled,
    model_public: group.model_public,
    pricing_mode: group.pricing_mode,
    peak_pricing_enabled: group.peak_pricing_enabled,
    billing_unit: group.billing_unit === "call" ? "call" : "token",
    price_per_call: group.price_per_call || 0,
    search_price_per_call: group.search_price_per_call || 0,
    config_json: group.config_json,
    description: group.description || null,
    created_at: group.created_at || 0,
    updated_at: group.updated_at || 0,
    provider_name: "",
    provider_type: providerType,
    provider_api_key: null,
    provider_secret_name: null,
    provider_endpoint: null,
    is_group: true,
    member_count: memberCount,
    model_metadata: aggregateModelMetadata({ model_name: group.name, config_json: group.config_json, is_group: true }, members),
    protocol_metadata: aggregateProtocolMetadata(members),
  };
}

export function groupBillingRow(group: ModelGroupRow, providerType: ProviderType): ModelWithProvider {
  return projectGroup(group, providerType, 0) as ModelWithProvider;
}

const MODEL_CATALOG_CACHE_TTL_MS = 60000;
const modelCatalogCache = new WeakMap<
  object,
  Map<string, { value: ModelProjectionRow[]; expires: number }>
>();

export function resetModelCatalogCache(): void {
  modelCatalogCacheRef.current = new WeakMap();
}
const modelCatalogCacheRef = { current: modelCatalogCache };

export async function listModelProjectionsForDevice(
  env: Env,
  device: DeviceRow | null,
  opts: { includePrivate?: boolean; includeHidden?: boolean } = {},
): Promise<ModelProjectionRow[]> {
  if (device === null && env?.DB && typeof env.DB === "object") {
    const cache = modelCatalogCacheRef.current;
    const key = (opts.includePrivate ? "private" : "public") + (opts.includeHidden ? ":all-names" : ":listed-names");
    const bucket = cache.get(env.DB as unknown as object);
    const hit = bucket?.get(key);
    if (hit && hit.expires > Date.now()) {
      return [...hit.value];
    }
    const rows = await loadModelProjections(env, device, opts);
    let target = bucket;
    if (!target) {
      target = new Map();
      cache.set(env.DB as unknown as object, target);
    }
    target.set(key, { value: rows, expires: Date.now() + MODEL_CATALOG_CACHE_TTL_MS });
    return [...rows];
  }
  return projectServiceModels(env, device, () => loadModelProjections(env, device, opts));
}

async function loadModelProjections(
  env: Env,
  device: DeviceRow | null,
  opts: { includePrivate?: boolean; includeHidden?: boolean },
): Promise<ModelProjectionRow[]> {
  const [models, groups] = await Promise.all([
    listModelsForDevice(env, device),
    listGroupsForDevice(env, device, opts),
  ]);
  const raw = [...(models as unknown as ModelProjectionRow[]), ...groups];
  return opts.includeHidden ? raw : raw.filter(isRawCatalogVisible);
}

export async function isModelKeyTaken(
  env: Env,
  name: string,
  except: { modelId?: string; groupId?: string } = {},
): Promise<"model" | "group" | null> {
  await ensureSchema(env);
  const trimmed = name.trim();
  if (!trimmed) return null;
  const [modelHit, groupHit] = await Promise.all([
    env.DB.prepare(
      "SELECT id FROM models WHERE (model_name = ? OR alias = ?) AND id != ? LIMIT 1"
    )
      .bind(trimmed, trimmed, except.modelId || "")
      .first<{ id: string }>(),
    env.DB.prepare("SELECT id FROM model_groups WHERE name = ? AND id != ? LIMIT 1")
      .bind(trimmed, except.groupId || "")
      .first<{ id: string }>(),
  ]);
  if (modelHit) return "model";
  if (groupHit) return "group";
  return null;
}

export interface ProviderHealthInfo {
  status: "healthy" | "degraded" | "unhealthy";
  latency_ms: number;
  last_ping_at: number;
  status_code?: number;
  message?: string;
}

const PROVIDER_HEALTH_PREFIX = "provider_health:";
const LEGACY_PROVIDER_HEALTH_KEY = "provider_health_map";

export async function getProviderHealthMap(env: Env): Promise<Record<string, ProviderHealthInfo>> {
  if (!env?.DB) return {};
  await ensureSchema(env);
  const out: Record<string, ProviderHealthInfo> = {};
  const legacy = await getSetting<Record<string, ProviderHealthInfo>>(env, LEGACY_PROVIDER_HEALTH_KEY);
  if (legacy && typeof legacy === "object") {
    for (const [id, info] of Object.entries(legacy)) {
      if (info) out[id] = info;
    }
  }
  const res = await env.DB.prepare(
    "SELECT key, value_json FROM settings WHERE key >= ? AND key < ?"
  )
    .bind(PROVIDER_HEALTH_PREFIX, PROVIDER_HEALTH_PREFIX.slice(0, -1) + ";")
    .all<{ key: string; value_json: string }>();
  for (const row of (res.results || []) as Array<{ key: string; value_json: string }>) {
    const id = row.key.slice(PROVIDER_HEALTH_PREFIX.length);
    if (!id) continue;
    try {
      out[id] = JSON.parse(row.value_json) as ProviderHealthInfo;
    } catch {
    }
  }
  return out;
}

export async function recordProviderHealth(
  env: Env,
  providerId: string,
  info: ProviderHealthInfo
): Promise<void> {
  await setSetting(env, PROVIDER_HEALTH_PREFIX + providerId, info);
}

export async function listPublicModels(env: Env, includePrivate = false) {
  const res = await env.DB.prepare(
    "SELECT m.model_name as id, m.display_name, m.alias, p.name as owned_by, m.created_at, m.config_json " +
      "FROM models m JOIN providers p ON p.id = m.provider_id " +
      "WHERE m.enabled = 1 AND p.enabled = 1 AND (m.model_public = 1 OR ? = 1) ORDER BY p.name, m.model_name"
  )
    .bind(includePrivate ? 1 : 0)
    .all();
  return res.results as Array<Record<string, unknown>>;
}



export const DEFAULT_TZ_OFFSET_MINUTES = -480;

export function sqlTzModifierToOffsetMinutes(modifier?: string): number {
  const m = /([+-]?\d+)\s*minutes/.exec(modifier || "");
  if (!m) return DEFAULT_TZ_OFFSET_MINUTES;
  const shift = parseInt(m[1], 10);
  if (!Number.isFinite(shift)) return DEFAULT_TZ_OFFSET_MINUTES;
  return -shift;
}

export function monthStartMs(tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES, nowMs = Date.now()): number {
  const shift = tzOffsetMinutes * 60_000;
  const shifted = new Date(nowMs - shift);
  const localMonthStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1, 0, 0, 0);
  return localMonthStart + shift;
}

export function monthRangeMs(
  year: number,
  month: number,
  tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES
): { startMs: number; endMs: number; prevStartMs: number; prevEndMs: number } {
  const shift = tzOffsetMinutes * 60_000;
  const startMs = Date.UTC(year, month - 1, 1, 0, 0, 0) + shift;
  const nextMonthYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endMs = Date.UTC(nextMonthYear, nextMonth - 1, 1, 0, 0, 0) + shift - 1;
  const prevMonthYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevStartMs = Date.UTC(prevMonthYear, prevMonth - 1, 1, 0, 0, 0) + shift;
  const prevEndMs = startMs - 1;
  return { startMs, endMs, prevStartMs, prevEndMs };
}

export interface ListDevicesOptions {
  includeRevoked?: boolean;
}

export async function listDevices(env: Env, opts: ListDevicesOptions = {}): Promise<DeviceRow[]> {
  await ensureSchema(env);
  const monthlyCost = usageCostExpression(String(monthStartMs()), "d.id");
  const revokedClause = opts.includeRevoked ? "" : "WHERE d.revoked_at IS NULL";

  const res = await env.DB.prepare(`
    SELECT d.id, d.name, d.enabled, d.rate_limit_rpm, COALESCE(d.cost_limit_monthly, 0) as cost_limit_monthly,
           d.last_used_at, d.created_at, d.revoked_at, d.model_scope,
           COALESCE(d.calls_enabled, 1) as calls_enabled,
           CASE WHEN d.password_hash IS NULL THEN 0 ELSE 1 END as password_set,
           ${monthlyCost} as current_month_cost,
           COALESCE(w.balance_usd, 0) as balance_usd, COALESCE(w.reserved_usd, 0) as reserved_usd
    FROM devices d
    LEFT JOIN device_wallets w ON w.device_id = d.id
    ${revokedClause}
    ORDER BY d.created_at DESC
  `).all();
  return (res.results || []) as unknown as DeviceRow[];
}


export async function getDeviceById(env: Env, id: string): Promise<DeviceRow | null> {
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first<DeviceRow>();
  return row ?? null;
}

export async function getDeviceByHash(env: Env, tokenHash: string) {
  return (await env.DB.prepare("SELECT * FROM devices WHERE token_hash = ?").bind(tokenHash).first<DeviceRow>()) as DeviceRow | null;
}

export async function getDeviceMonthlyCost(env: Env, deviceId: string, startOfMonthMs?: number): Promise<number> {
  await ensureSchema(env);
  const startMs = startOfMonthMs ?? monthStartMs();
  let row: { total_cost: number } | null;
  if (monthStartMs(DEFAULT_TZ_OFFSET_MINUTES, startMs) === startMs) {
    const cost = usageCostExpression(String(startMs), "requested.device_id");
    row = await env.DB.prepare(`SELECT ${cost} AS total_cost FROM (SELECT ? AS device_id) requested`)
      .bind(deviceId).first<{ total_cost: number }>();
  } else {
    const source = await reportSource(env, startMs);
    row = await env.DB.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total_cost FROM ${source.sql} WHERE device_id = ?`)
      .bind(...source.binds, deviceId).first<{ total_cost: number }>().then(source.checked);
  }
  return Number((row?.total_cost || 0).toFixed(4));
}

export async function createDevice(
  env: Env,
  name: string,
  tokenHash: string,
  rate_limit_rpm: number = 0,
  cost_limit_monthly: number = 0,
  balance_usd?: number
) {
  const id = newId("dev");
  const t = now();
  await env.DB.prepare(
    "INSERT INTO devices (id, name, token_hash, enabled, rate_limit_rpm, cost_limit_monthly, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)"
  ).bind(id, name, tokenHash, rate_limit_rpm, cost_limit_monthly, t).run();
  const initialBalance = typeof balance_usd === "number" ? Math.max(0, balance_usd) : Math.max(0, cost_limit_monthly);
  await ensureWallet(env, id, initialBalance);
  if (initialBalance > 0) {
    await insertLedgerEntry(env, {
      device_id: id,
      delta_usd: initialBalance,
      reason: "topup",
      request_id: null,
      balance_after: initialBalance,
      note: "initial balance from device creation",
    });
  }
  return { id, name, rate_limit_rpm, cost_limit_monthly, balance_usd: initialBalance, created_at: t };
}

export async function updateDevice(
  env: Env,
  id: string,
  data: {
    name?: string;
    enabled?: boolean;
    rate_limit_rpm?: number;
    cost_limit_monthly?: number;
    model_scope?: ModelScope;
    calls_enabled?: boolean;
  }
) {
  const existing = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!existing) return null;
  const next: Record<string, any> = {
    ...existing,
    name: data.name ?? existing.name,
    enabled: data.enabled !== undefined ? (data.enabled ? 1 : 0) : existing.enabled,
    rate_limit_rpm: data.rate_limit_rpm !== undefined ? data.rate_limit_rpm : (existing.rate_limit_rpm || 0),
    cost_limit_monthly: data.cost_limit_monthly !== undefined ? data.cost_limit_monthly : (existing.cost_limit_monthly || 0),
    model_scope: data.model_scope ?? (existing.model_scope || "all"),
    calls_enabled:
      data.calls_enabled !== undefined
        ? (data.calls_enabled ? 1 : 0)
        : (existing.calls_enabled === undefined || existing.calls_enabled === null ? 1 : existing.calls_enabled),
  };
  await env.DB.prepare(
    "UPDATE devices SET name = ?, enabled = ?, rate_limit_rpm = ?, cost_limit_monthly = ?, model_scope = ?, calls_enabled = ? WHERE id = ?"
  )
    .bind(next.name, next.enabled, next.rate_limit_rpm, next.cost_limit_monthly, next.model_scope, next.calls_enabled, id)
    .run();
  return next;
}

export async function revokeDevice(env: Env, id: string) {
  const existing = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!existing) return null;
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE devices SET enabled = 0, revoked_at = ? WHERE id = ?").bind(t, id),
    env.DB.prepare(
      "UPDATE device_sub_tokens SET enabled = 0, revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL"
    ).bind(t, id),
  ]);
  return { ...existing, enabled: 0, revoked_at: t };
}

function touchDeviceStatement(env: Env, id: string) {
  return env.DB.prepare("UPDATE devices SET last_used_at = ? WHERE id = ?").bind(now(), id);
}

export async function touchDevice(env: Env, id: string) {
  await touchDeviceStatement(env, id).run();
}


export const SUB_TOKEN_LIMIT = 5;

export async function getSubTokenByHash(env: Env, tokenHash: string): Promise<SubTokenRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM device_sub_tokens WHERE token_hash = ? AND enabled = 1 AND revoked_at IS NULL"
  )
    .bind(tokenHash)
    .first<SubTokenRow>();
  return row ?? null;
}

export async function listSubTokens(
  env: Env,
  deviceId: string,
  opts: ListDevicesOptions = {}
): Promise<SubTokenRow[]> {
  await ensureSchema(env);
  const sql = opts.includeRevoked
    ? "SELECT * FROM device_sub_tokens WHERE device_id = ? ORDER BY created_at DESC"
    : "SELECT * FROM device_sub_tokens WHERE device_id = ? AND revoked_at IS NULL ORDER BY created_at DESC";
  const res = await env.DB.prepare(sql).bind(deviceId).all<SubTokenRow>();
  return (res.results || []) as unknown as SubTokenRow[];
}

export async function getSubTokenById(env: Env, deviceId: string, id: string): Promise<SubTokenRow | null> {
  const row = await env.DB.prepare("SELECT * FROM device_sub_tokens WHERE id = ? AND device_id = ?")
    .bind(id, deviceId)
    .first<SubTokenRow>();
  return row ?? null;
}

export async function createSubToken(
  env: Env,
  deviceId: string,
  name: string,
  tokenHash: string
): Promise<{ ok: true; row: SubTokenRow } | { ok: false; reason: "limit" | "device_missing" }> {
  await ensureSchema(env);
  const device = await env.DB.prepare("SELECT id, revoked_at FROM devices WHERE id = ?")
    .bind(deviceId)
    .first<{ id: string; revoked_at: number | null }>();
  if (!device || device.revoked_at) return { ok: false, reason: "device_missing" };
  const id = newId("sub");
  const t = now();
  const res = await env.DB.prepare(
    `INSERT INTO device_sub_tokens (id, device_id, name, token_hash, enabled, created_at)
     SELECT ?, ?, ?, ?, 1, ?
     WHERE (SELECT COUNT(*) FROM device_sub_tokens WHERE device_id = ? AND revoked_at IS NULL) < ?`
  )
    .bind(id, deviceId, name, tokenHash, t, deviceId, SUB_TOKEN_LIMIT)
    .run();
  const changes = Number((res.meta as { changes?: number } | undefined)?.changes ?? 0);
  if (changes === 0) return { ok: false, reason: "limit" };
  return {
    ok: true,
    row: {
      id,
      device_id: deviceId,
      name,
      token_hash: tokenHash,
      enabled: 1,
      last_used_at: null,
      created_at: t,
      revoked_at: null,
    },
  };
}

export async function setSubTokenEnabled(
  env: Env,
  deviceId: string,
  id: string,
  enabled: boolean
): Promise<SubTokenRow | null> {
  const existing = await getSubTokenById(env, deviceId, id);
  if (!existing) return null;
  if (existing.revoked_at) return existing;
  const value = enabled ? 1 : 0;
  await env.DB.prepare("UPDATE device_sub_tokens SET enabled = ? WHERE id = ? AND device_id = ?")
    .bind(value, id, deviceId)
    .run();
  return { ...existing, enabled: value };
}

export async function revokeSubToken(env: Env, deviceId: string, id: string): Promise<SubTokenRow | null> {
  const existing = await getSubTokenById(env, deviceId, id);
  if (!existing) return null;
  if (existing.revoked_at) return existing;
  const t = now();
  await env.DB.prepare(
    "UPDATE device_sub_tokens SET enabled = 0, revoked_at = ? WHERE id = ? AND device_id = ?"
  )
    .bind(t, id, deviceId)
    .run();
  return { ...existing, enabled: 0, revoked_at: t };
}

export function touchSubTokenStatement(env: Env, id: string) {
  return env.DB.prepare("UPDATE device_sub_tokens SET last_used_at = ? WHERE id = ?").bind(now(), id);
}

export async function touchSubToken(env: Env, id: string) {
  await touchSubTokenStatement(env, id).run();
}


export type DevicePasswordSetupResult =
  | { status: "set"; password_updated_at: number }
  | { status: "conflict" }
  | { status: "not_found" };

export async function setDevicePassword(
  env: Env,
  deviceId: string,
  passwordHash: string,
  expectedPasswordUpdatedAt: number | null
): Promise<DevicePasswordSetupResult> {
  const updated = await env.DB.prepare(
    "UPDATE devices SET password_hash = ?, password_updated_at = MAX(?, COALESCE(password_updated_at, 0) + 1) " +
    "WHERE id = ? AND (password_hash IS NULL OR password_hash = '') AND password_updated_at IS ? " +
    "RETURNING password_updated_at"
  ).bind(passwordHash, now(), deviceId, expectedPasswordUpdatedAt).first<{ password_updated_at: number }>();
  if (updated) return { status: "set", password_updated_at: updated.password_updated_at };
  const existing = await env.DB.prepare("SELECT id FROM devices WHERE id = ?").bind(deviceId).first<{ id: string }>();
  return { status: existing ? "conflict" : "not_found" };
}

export async function resetDevicePassword(env: Env, deviceId: string): Promise<number | null> {
  const existing = await env.DB.prepare("SELECT id FROM devices WHERE id = ?").bind(deviceId).first<{ id: string }>();
  if (!existing) return null;
  const t = now();
  await env.DB.prepare("UPDATE devices SET password_hash = NULL, password_updated_at = ? WHERE id = ?")
    .bind(t, deviceId)
    .run();
  return t;
}



export async function getDeviceModelIds(env: Env, deviceId: string): Promise<string[]> {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    "SELECT model_id FROM device_models WHERE device_id = ? ORDER BY model_id"
  )
    .bind(deviceId)
    .all<{ model_id: string }>();
  return (res.results || []).map((r) => r.model_id);
}

export async function getDeviceModelRateLimits(
  env: Env,
  deviceId: string
): Promise<Map<string, number>> {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    "SELECT model_id, rpm FROM device_models WHERE device_id = ? AND rpm > 0"
  )
    .bind(deviceId)
    .all<{ model_id: string; rpm: number }>();
  const limits = new Map<string, number>();
  for (const r of res.results || []) {
    const rpm = Number(r.rpm);
    if (Number.isFinite(rpm) && rpm > 0) limits.set(r.model_id, rpm);
  }
  return limits;
}

export async function replaceDeviceModels(
  env: Env,
  deviceId: string,
  modelIds: Array<string | { model_id: string; rpm?: number | null }>
): Promise<string[]> {
  await ensureSchema(env);
  const byId = new Map<string, number>();
  for (const entry of modelIds) {
    const id = String(typeof entry === "string" ? entry : entry?.model_id ?? "").trim();
    if (!id) continue;
    const raw = typeof entry === "string" ? 0 : entry?.rpm;
    const rpm = Number(raw);
    const normalised = Number.isFinite(rpm) && rpm > 0 ? Math.floor(rpm) : 0;
    byId.set(id, Math.max(byId.get(id) ?? 0, normalised));
  }
  const statements = [env.DB.prepare("DELETE FROM device_models WHERE device_id = ?").bind(deviceId)];
  for (const [modelId, rpm] of byId) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO device_models (device_id, model_id, rpm) VALUES (?, ?, ?)").bind(
        deviceId,
        modelId,
        rpm
      )
    );
  }
  await env.DB.batch(modelReferenceWriteStatements(env, statements, [...byId.keys()]));
  return getDeviceModelIds(env, deviceId);
}


type GrantEntry = string | { id: string; rpm?: number | null };

function normaliseGrants(entries: GrantEntry[], idKey: "model_id" | "group_id"): Map<string, number> {
  const byId = new Map<string, number>();
  for (const entry of entries) {
    const rawId = typeof entry === "string" ? entry : (entry as any)?.[idKey] ?? "";
    const id = String(rawId).trim();
    if (!id) continue;
    const raw = typeof entry === "string" ? 0 : entry?.rpm;
    const rpm = Number(raw);
    const normalised = Number.isFinite(rpm) && rpm > 0 ? Math.floor(rpm) : 0;
    byId.set(id, Math.max(byId.get(id) ?? 0, normalised));
  }
  return byId;
}

export async function listDeviceTemplates(env: Env): Promise<DeviceTemplateWithGrants[]> {
  await ensureSchema(env);
  const [templates, models, groups, bindings] = await Promise.all([
    env.DB.prepare("SELECT * FROM device_templates ORDER BY created_at DESC").all<DeviceTemplateRow>(),
    env.DB.prepare(
      "SELECT tm.template_id as template_id, tm.model_id as model_id, tm.rpm as rpm, " +
        "mo.model_name as model_name, mo.display_name as display_name, mo.enabled as enabled, " +
        "p.name as provider_name, p.type as provider_type, p.config_json as provider_config_json " +
        "FROM device_template_models tm " +
        "LEFT JOIN models mo ON mo.id = tm.model_id " +
        "LEFT JOIN providers p ON p.id = mo.provider_id " +
        "ORDER BY tm.template_id ASC, mo.model_name ASC"
    ).all<any>(),
    env.DB.prepare(
      "SELECT tg.template_id as template_id, tg.group_id as group_id, tg.rpm as rpm, " +
        "g.name as name, g.display_name as display_name, g.enabled as enabled " +
        "FROM device_template_groups tg " +
        "LEFT JOIN model_groups g ON g.id = tg.group_id " +
        "ORDER BY tg.template_id ASC, g.name ASC"
    ).all<any>(),
    env.DB.prepare(
      "SELECT template_id, COUNT(*) as n FROM device_template_bindings GROUP BY template_id"
    ).all<{ template_id: string; n: number }>(),
  ]);

  const modelMap = new Map<string, DeviceTemplateModelRow[]>();
  for (const r of models.results || []) {
    const list = modelMap.get(r.template_id) || [];
    list.push({
      model_id: r.model_id,
      model_name: r.model_name ?? null,
      display_name: r.display_name ?? null,
      provider_name: r.provider_name ?? null,
      provider_type: r.provider_type ?? null,
      rpm: Number(r.rpm) || 0,
      enabled: Number(r.enabled ?? 1) ? 1 : 0,
    });
    modelMap.set(r.template_id, list);
  }

  const groupMap = new Map<string, DeviceTemplateGroupRow[]>();
  for (const r of groups.results || []) {
    const list = groupMap.get(r.template_id) || [];
    list.push({
      group_id: r.group_id,
      name: r.name ?? null,
      display_name: r.display_name ?? null,
      enabled: Number(r.enabled ?? 1) ? 1 : 0,
      rpm: Number(r.rpm) || 0,
    });
    groupMap.set(r.template_id, list);
  }

  const countMap = new Map<string, number>();
  for (const r of bindings.results || []) countMap.set(r.template_id, Number(r.n) || 0);

  return ((templates.results || []) as unknown as DeviceTemplateRow[]).map((t) => ({
    ...t,
    model_scope: (t.model_scope || "list") as ModelScope,
    models: modelMap.get(t.id) || [],
    groups: groupMap.get(t.id) || [],
    device_count: countMap.get(t.id) || 0,
  }));
}

export async function getDeviceTemplate(env: Env, id: string): Promise<DeviceTemplateWithGrants | null> {
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT * FROM device_templates WHERE id = ?")
    .bind(id)
    .first<DeviceTemplateRow>();
  if (!row) return null;
  const [models, groups, bindings] = await Promise.all([
    env.DB.prepare(
      "SELECT tm.model_id as model_id, tm.rpm as rpm, mo.model_name as model_name, mo.display_name as display_name, " +
        "mo.enabled as enabled, p.name as provider_name, p.type as provider_type, p.config_json as provider_config_json " +
        "FROM device_template_models tm " +
        "LEFT JOIN models mo ON mo.id = tm.model_id " +
        "LEFT JOIN providers p ON p.id = mo.provider_id " +
        "WHERE tm.template_id = ? ORDER BY mo.model_name ASC"
    )
      .bind(id)
      .all<any>(),
    env.DB.prepare(
      "SELECT tg.group_id as group_id, tg.rpm as rpm, g.name as name, g.display_name as display_name, g.enabled as enabled " +
        "FROM device_template_groups tg " +
        "LEFT JOIN model_groups g ON g.id = tg.group_id " +
        "WHERE tg.template_id = ? ORDER BY g.name ASC"
    )
      .bind(id)
      .all<any>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM device_template_bindings WHERE template_id = ?")
      .bind(id)
      .first<{ n: number }>(),
  ]);
  return {
    ...row,
    model_scope: (row.model_scope || "list") as ModelScope,
    models: (models.results || []).map((r) => ({
      model_id: r.model_id,
      model_name: r.model_name ?? null,
      display_name: r.display_name ?? null,
      provider_name: r.provider_name ?? null,
      provider_type: r.provider_type ?? null,
      rpm: Number(r.rpm) || 0,
      enabled: Number(r.enabled ?? 1) ? 1 : 0,
    })),
    groups: (groups.results || []).map((r) => ({
      group_id: r.group_id,
      name: r.name ?? null,
      display_name: r.display_name ?? null,
      enabled: Number(r.enabled ?? 1) ? 1 : 0,
      rpm: Number(r.rpm) || 0,
    })),
    device_count: Number(bindings?.n) || 0,
  };
}

export async function getDeviceTemplateByName(env: Env, name: string): Promise<DeviceTemplateRow | null> {
  await ensureSchema(env);
  return await env.DB.prepare("SELECT * FROM device_templates WHERE name = ?")
    .bind(name)
    .first<DeviceTemplateRow>();
}

export async function getDeviceTemplateBinding(
  env: Env,
  deviceId: string
): Promise<{ device_id: string; template_id: string; applied_at: number } | null> {
  await ensureSchema(env);
  return await env.DB.prepare("SELECT device_id, template_id, applied_at FROM device_template_bindings WHERE device_id = ?")
    .bind(deviceId)
    .first<{ device_id: string; template_id: string; applied_at: number }>();
}

export async function listDeviceTemplateBindings(
  env: Env
): Promise<Array<{ device_id: string; template_id: string; applied_at: number }>> {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    "SELECT device_id, template_id, applied_at FROM device_template_bindings ORDER BY applied_at DESC"
  ).all<{ device_id: string; template_id: string; applied_at: number }>();
  return res.results || [];
}

function modelGrantStatements(
  env: Env,
  templateId: string,
  entries: Array<string | { model_id: string; rpm?: number | null }>
): any[] {
  const byId = normaliseGrants(entries as GrantEntry[], "model_id");
  const statements: any[] = [
    env.DB.prepare("DELETE FROM device_template_models WHERE template_id = ?").bind(templateId),
  ];
  for (const [modelId, rpm] of byId) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO device_template_models (template_id, model_id, rpm) VALUES (?, ?, ?)"
      ).bind(templateId, modelId, rpm)
    );
  }
  return modelReferenceWriteStatements(env, statements, [...byId.keys()]);
}

function groupGrantStatements(
  env: Env,
  templateId: string,
  entries: Array<string | { group_id: string; rpm?: number | null }>
): any[] {
  const byId = normaliseGrants(entries as GrantEntry[], "group_id");
  const statements: any[] = [
    env.DB.prepare("DELETE FROM device_template_groups WHERE template_id = ?").bind(templateId),
  ];
  for (const [groupId, rpm] of byId) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO device_template_groups (template_id, group_id, rpm) VALUES (?, ?, ?)"
      ).bind(templateId, groupId, rpm)
    );
  }
  return modelReferenceWriteStatements(env, statements, [], [...byId.keys()]);
}

export async function replaceDeviceTemplateModels(
  env: Env,
  templateId: string,
  entries: Array<string | { model_id: string; rpm?: number | null }>
): Promise<void> {
  await ensureSchema(env);
  await env.DB.batch(modelGrantStatements(env, templateId, entries));
}

export async function replaceDeviceTemplateGroups(
  env: Env,
  templateId: string,
  entries: Array<string | { group_id: string; rpm?: number | null }>
): Promise<void> {
  await ensureSchema(env);
  await env.DB.batch(groupGrantStatements(env, templateId, entries));
}

export async function createDeviceTemplate(
  env: Env,
  data: {
    name: string;
    description?: string | null;
    model_scope: ModelScope;
    models?: Array<string | { model_id: string; rpm?: number | null }>;
    groups?: Array<string | { group_id: string; rpm?: number | null }>;
  }
): Promise<DeviceTemplateWithGrants> {
  await ensureSchema(env);
  const id = newId("tpl");
  const ts = now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO device_templates (id, name, description, model_scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, data.name.trim(), data.description ?? null, data.model_scope, ts, ts),
    ...modelGrantStatements(env, id, data.models || []),
    ...groupGrantStatements(env, id, data.groups || []),
  ]);
  return (await getDeviceTemplate(env, id))!;
}

export async function updateDeviceTemplate(
  env: Env,
  id: string,
  data: {
    name?: string;
    description?: string | null;
    model_scope?: ModelScope;
    models?: Array<string | { model_id: string; rpm?: number | null }>;
    groups?: Array<string | { group_id: string; rpm?: number | null }>;
  }
): Promise<DeviceTemplateWithGrants | null> {
  await ensureSchema(env);
  const existing = await env.DB.prepare("SELECT * FROM device_templates WHERE id = ?")
    .bind(id)
    .first<DeviceTemplateRow>();
  if (!existing) return null;
  const sets: string[] = [];
  const binds: any[] = [];
  if (data.name !== undefined) {
    sets.push("name = ?");
    binds.push(data.name.trim());
  }
  if (data.description !== undefined) {
    sets.push("description = ?");
    binds.push(data.description ?? null);
  }
  if (data.model_scope !== undefined) {
    sets.push("model_scope = ?");
    binds.push(data.model_scope);
  }
  const statements: any[] = [];
  if (sets.length) {
    sets.push("updated_at = ?");
    binds.push(now(), id);
    statements.push(env.DB.prepare(`UPDATE device_templates SET ${sets.join(", ")} WHERE id = ?`).bind(...binds));
  }
  if (data.models !== undefined) statements.push(...modelGrantStatements(env, id, data.models));
  if (data.groups !== undefined) statements.push(...groupGrantStatements(env, id, data.groups));
  if (statements.length) await env.DB.batch(statements);
  return await getDeviceTemplate(env, id);
}

export async function deleteDeviceTemplate(env: Env, id: string): Promise<boolean> {
  await ensureSchema(env);
  const [, , , res] = await env.DB.batch([
    env.DB.prepare("DELETE FROM device_template_models WHERE template_id = ?").bind(id),
    env.DB.prepare("DELETE FROM device_template_groups WHERE template_id = ?").bind(id),
    env.DB.prepare("DELETE FROM device_template_bindings WHERE template_id = ?").bind(id),
    env.DB.prepare("DELETE FROM device_templates WHERE id = ?").bind(id),
  ]);
  return Number(res.meta?.changes || 0) > 0;
}

export function mergeTemplateScope(deviceScope: ModelScope | null | undefined, templateScope: ModelScope): ModelScope {
  if (templateScope === "list") return "list";
  return (deviceScope || "all") as ModelScope;
}

export function templateApplyStatementCount(deviceCount: number, grantCount: number, mode: "replace" | "merge"): number {
  const perDevice = grantCount + 2 + (mode === "replace" ? 2 : 0);
  return Math.max(0, deviceCount) * perDevice;
}

export const MAX_TEMPLATE_APPLY_STATEMENTS = 20000;

export async function applyDeviceTemplate(
  env: Env,
  template: DeviceTemplateWithGrants,
  devices: DeviceRow[],
  mode: "replace" | "merge"
): Promise<void> {
  await ensureSchema(env);
  const ts = now();
  const statements: any[] = [];
  const grantModels = template.model_scope === "all" ? [] : template.models;
  const grantGroups = template.model_scope === "all" ? [] : template.groups;

  for (const device of devices) {
    if (mode === "replace") {
      statements.push(env.DB.prepare("DELETE FROM device_models WHERE device_id = ?").bind(device.id));
      statements.push(env.DB.prepare("DELETE FROM device_model_groups WHERE device_id = ?").bind(device.id));
    }
    for (const m of grantModels) {
      statements.push(
        mode === "replace"
          ? env.DB.prepare("INSERT OR IGNORE INTO device_models (device_id, model_id, rpm) VALUES (?, ?, ?)").bind(
              device.id,
              m.model_id,
              m.rpm
            )
          :  
            env.DB.prepare(
              "INSERT INTO device_models (device_id, model_id, rpm) VALUES (?, ?, ?) " +
                "ON CONFLICT(device_id, model_id) DO UPDATE SET rpm = MAX(rpm, excluded.rpm)"
            ).bind(device.id, m.model_id, m.rpm)
      );
    }
    for (const g of grantGroups) {
      statements.push(
        mode === "replace"
          ? env.DB.prepare("INSERT OR IGNORE INTO device_model_groups (device_id, group_id, rpm) VALUES (?, ?, ?)").bind(
              device.id,
              g.group_id,
              g.rpm
            )
          : env.DB.prepare(
              "INSERT INTO device_model_groups (device_id, group_id, rpm) VALUES (?, ?, ?) " +
                "ON CONFLICT(device_id, group_id) DO UPDATE SET rpm = MAX(rpm, excluded.rpm)"
            ).bind(device.id, g.group_id, g.rpm)
      );
    }
    const scope =
      mode === "replace" ? template.model_scope : mergeTemplateScope(device.model_scope, template.model_scope);
    statements.push(
      env.DB.prepare("UPDATE devices SET model_scope = ? WHERE id = ?").bind(scope, device.id)
    );
    statements.push(
      env.DB.prepare(
        "INSERT INTO device_template_bindings (device_id, template_id, applied_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(device_id) DO UPDATE SET template_id = excluded.template_id, applied_at = excluded.applied_at"
      ).bind(device.id, template.id, ts)
    );
  }
  if (!statements.length) return;
  if (statements.length > MAX_TEMPLATE_APPLY_STATEMENTS) {
    throw new Error(`template_apply_too_large: ${statements.length} > ${MAX_TEMPLATE_APPLY_STATEMENTS}`);
  }
  await env.DB.batch(modelReferenceWriteStatements(
    env, statements, grantModels.map(m => m.model_id), grantGroups.map(g => g.group_id)
  ));
}

export function isModelInScope(
  scope: ModelScope | null | undefined,
  modelId: string,
  whitelisted: Set<string>,
  modelPublic = false,
): boolean {
  const s = scope || "all";
  if (s === "all") return true;
  if (s === "list") return whitelisted.has(modelId);
  return whitelisted.has(modelId) || modelPublic;
}

export async function listModelsForDevice(
  env: Env,
  device: DeviceRow | null,
): Promise<ModelWithProvider[]> {
  await ensureSchema(env);
  const scope: ModelScope = device ? device.model_scope || "all" : "list";
  const [modelsRes, whitelisted] = await Promise.all([
    env.DB.prepare(
      "SELECT m.id, m.model_name, m.display_name, m.alias, m.fallback_model_id, m.input_price_per_m, m.output_price_per_m, m.cache_read_price_per_m, m.cache_write_price_per_m, m.pricing_mode, m.peak_pricing_enabled, m.config_json, m.model_public, m.enabled, m.billing_unit, m.price_per_call, m.search_price_per_call, m.created_at, p.name as owned_by, p.type as provider_type, p.config_json as provider_config_json " +
      "FROM models m JOIN providers p ON p.id = m.provider_id " +
      "WHERE m.enabled = 1 AND p.enabled = 1"
    ).all<ModelWithProvider>(),
    device && scope !== "all" ? getDeviceModelIds(env, device.id).then((ids) => new Set(ids)) : Promise.resolve(new Set<string>()),
  ]);
  const rows = (modelsRes.results || []) as unknown as ModelWithProvider[];
  return device
    ? rows.filter((m) => isModelInScope(scope, m.id, whitelisted, Boolean(m.model_public)))
    : rows.filter((m) => Boolean(m.model_public));
}

export async function filterCandidatesForDevice(
  env: Env,
  device: DeviceRow,
  candidates: ModelWithProvider[],
): Promise<ModelWithProvider[]> {
  const scope = device.model_scope || "all";
  if (scope === "all") return candidates;
  const whitelisted = new Set(await getDeviceModelIds(env, device.id));
  return candidates.filter((c) => isModelInScope(scope, c.id, whitelisted, Boolean(c.model_public)));
}
export async function checkDeviceRateLimit(env: Env, deviceId: string, rpm: number): Promise<boolean> {
  const { checkAndRecordRateLimit } = await import("../gateway/ratelimit");
  return checkAndRecordRateLimit(env, deviceId, rpm);
}



export const PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES = DEFAULT_TZ_OFFSET_MINUTES;

export const PEAK_PRICING_DAY_TYPES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const PEAK_PRICING_GROUPS = ["weekday", "weekend"] as const;
export const PEAK_PRICING_WEEKEND_DAYS = ["sat", "sun"] as const;

export function peakPricingDayKey(tzOffsetMinutes: number, nowMs: number): {
  day: string;
  minute: number;
} {
  const local = new Date(nowMs - tzOffsetMinutes * 60_000);
  const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][local.getUTCDay()];
  return { day, minute: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

export function peakWindowCovers(start: number, end: number, minute: number): boolean {
  if (end === start) return false;
  if (end > start) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

export async function listPriceWindows(env: Env, modelId: string): Promise<PriceWindowRow[]> {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    "SELECT * FROM price_windows WHERE model_id = ? ORDER BY day_type, start_minute"
  )
    .bind(modelId)
    .all<PriceWindowRow>();
  return res.results ?? [];
}

export async function replacePriceWindows(
  env: Env,
  modelId: string,
  windows: { day_type: string; start_minute: number; end_minute: number; multiplier: number; enabled?: boolean }[]
): Promise<PriceWindowRow[]> {
  await ensureSchema(env);
  const t = now();
  await env.DB.prepare("DELETE FROM price_windows WHERE model_id = ?").bind(modelId).run();
  for (const w of windows) {
    await env.DB.prepare(
      "INSERT INTO price_windows (id, model_id, day_type, start_minute, end_minute, multiplier, enabled, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(newId("pw"), modelId, w.day_type, w.start_minute, w.end_minute, w.multiplier, w.enabled === false ? 0 : 1, t, t)
      .run();
  }
  return listPriceWindows(env, modelId);
}

export function selectPriceWindow(
  windows: PriceWindowRow[],
  day: string,
  minute: number
): PriceWindowRow | null {
  const isWeekend = PEAK_PRICING_WEEKEND_DAYS.includes(day as (typeof PEAK_PRICING_WEEKEND_DAYS)[number]);
  const specificity = (w: PriceWindowRow): number => {
    if (PEAK_PRICING_DAY_TYPES.includes(w.day_type as (typeof PEAK_PRICING_DAY_TYPES)[number])) {
      return w.day_type === day ? 2 : 0;
    }
    if (w.day_type === (isWeekend ? "weekend" : "weekday")) return 1;
    return 0;
  };
  let best: PriceWindowRow | null = null;
  for (const w of windows) {
    if (!w.enabled) continue;
    const rank = specificity(w);
    if (rank === 0) continue;
    if (!peakWindowCovers(w.start_minute, w.end_minute, minute)) continue;
    if (
      !best ||
      rank > specificity(best) ||
      (rank === specificity(best) && w.start_minute > best.start_minute)
    ) {
      best = w;
    }
  }
  return best;
}


export function pickPriceSnapshot(
  windows: PriceWindowRow[],
  nowMs: number,
  tzOffsetMinutes: number = PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES
): { multiplier: number; window_id: string | null } {
  if (!windows.length) return { multiplier: 1, window_id: null };
  const { day, minute } = peakPricingDayKey(tzOffsetMinutes, nowMs);
  const hit = selectPriceWindow(windows, day, minute);
  if (!hit) return { multiplier: 1, window_id: null };
  return { multiplier: Number(hit.multiplier) || 0, window_id: hit.id };
}

export async function resolvePriceSnapshot(
  env: Env,
  modelId: string,
  peakEnabled: boolean,
  nowMs: number = Date.now(),
  tzOffsetMinutes: number = PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES
): Promise<{ multiplier: number; window_id: string | null }> {
  if (!peakEnabled) return { multiplier: 1, window_id: null };
  return pickPriceSnapshot(await listPriceWindows(env, modelId), nowMs, tzOffsetMinutes);
}

export async function listPriceWindowsForModels(
  env: Env,
  modelIds: string[]
): Promise<Map<string, PriceWindowRow[]>> {
  const out = new Map<string, PriceWindowRow[]>();
  if (!modelIds.length) return out;
  await ensureSchema(env);
  const CHUNK = 90;
  for (let i = 0; i < modelIds.length; i += CHUNK) {
    const chunk = modelIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const res = await env.DB.prepare(
      "SELECT * FROM price_windows WHERE model_id IN (" + placeholders + ") ORDER BY model_id, day_type, start_minute"
    )
      .bind(...chunk)
      .all<PriceWindowRow>();
    for (const row of res.results ?? []) {
      const list = out.get(row.model_id);
      if (list) list.push(row);
      else out.set(row.model_id, [row]);
    }
  }
  return out;
}


export async function getWallet(env: Env, deviceId: string): Promise<WalletRow> {
  await ensureSchema(env);
  const row = (await env.DB.prepare(
    "SELECT device_id, balance_usd, reserved_usd, created_at, updated_at FROM device_wallets WHERE device_id = ?"
  )
    .bind(deviceId)
    .first<WalletRow>()) as WalletRow | null;
  if (!row) {
    return { device_id: deviceId, balance_usd: 0, reserved_usd: 0, created_at: null, updated_at: null };
  }
  return {
    ...row,
    balance_usd: Number(row.balance_usd || 0),
    reserved_usd: Number(row.reserved_usd || 0),
  };
}

export async function ensureWallet(env: Env, deviceId: string, initialBalanceUsd = 0): Promise<WalletRow> {
  const existing = await getWallet(env, deviceId);
  if (existing.created_at !== null) return existing;
  const t = now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO device_wallets (device_id, balance_usd, reserved_usd, created_at, updated_at) VALUES (?, ?, 0, ?, ?)"
  )
    .bind(deviceId, initialBalanceUsd, t, t)
    .run();
  return { device_id: deviceId, balance_usd: initialBalanceUsd, reserved_usd: 0, created_at: t, updated_at: t };
}

async function runStatements(env: Env, statements: any[]): Promise<any[]> {
  try {
    const out = await env.DB.batch(statements);
    if (
      Array.isArray(out) &&
      out.length === statements.length &&
      out.every((r) => r && typeof r === "object" && (r as any).meta)
    ) {
      return out;
    }
  } catch (err) {
    throw err;
  }
  const out: any[] = [];
  for (const statement of statements) out.push(await statement.run());
  return out;
}

function readReturnedBalance(res: any): number | null {
  const row = Array.isArray(res?.results) ? res.results[0] : undefined;
  if (!row || typeof row !== "object") return null;
  const n = Number((row as any).balance_usd);
  return Number.isFinite(n) ? n : null;
}

async function runWalletTransaction(env: Env, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  const results = await env.DB.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length ||
      results.some(result => !result || !result.meta || ("success" in result && !result.success))) {
    throw new Error("Wallet transaction returned an invalid result; not replayed");
  }
  return results;
}

export async function reserveBalance(
  env: Env,
  deviceId: string,
  estimateUsd: number,
  requestId?: string
): Promise<boolean> {
  await ensureSchema(env);
  if (!Number.isFinite(estimateUsd)) throw new Error("Invalid reservation amount");
  if (!(estimateUsd > 0)) return true;
  const t = now();
  const wallet = env.DB.prepare(
    "INSERT OR IGNORE INTO device_wallets (device_id, balance_usd, reserved_usd, created_at, updated_at) VALUES (?, 0, 0, ?, ?)"
  ).bind(deviceId, t, t);
  if (!requestId) {
    const results = await runWalletTransaction(env, [wallet, env.DB.prepare(
      "UPDATE device_wallets SET reserved_usd = reserved_usd + ?, updated_at = ? " +
      "WHERE device_id = ? AND balance_usd - reserved_usd >= ?"
    ).bind(estimateUsd, t, deviceId, estimateUsd)]);
    return Number(results[1].meta.changes ?? 0) > 0;
  }
  const results = await runWalletTransaction(env, [
    wallet,
    env.DB.prepare(
      "INSERT INTO reserve_holds (request_id, device_id, amount_usd, created_at) " +
      "SELECT ?, ?, ?, ? FROM device_wallets WHERE device_id = ? AND balance_usd - reserved_usd >= ? " +
      "AND NOT EXISTS (SELECT 1 FROM wallet_ledger WHERE device_id = ? AND reason = 'usage' AND request_id = ?) " +
      "ON CONFLICT(request_id) DO NOTHING"
    ).bind(requestId, deviceId, estimateUsd, t, deviceId, estimateUsd, deviceId, requestId),
    env.DB.prepare(
      "UPDATE device_wallets SET reserved_usd = reserved_usd + ?, updated_at = ? WHERE device_id = ? AND changes() = 1"
    ).bind(estimateUsd, t, deviceId),
  ]);
  if (Number(results[1].meta.changes ?? 0) > 0) return true;
  const existing = await env.DB.prepare(
    "SELECT amount_usd FROM reserve_holds WHERE request_id = ? AND device_id = ?"
  ).bind(requestId, deviceId).first<{ amount_usd: number }>();
  return existing !== null && Number(existing.amount_usd) >= estimateUsd;
}

export async function settleBalance(
  env: Env,
  deviceId: string,
  reservedUsd: number,
  actualUsd: number,
  requestId: string,
): Promise<number | null> {
  await ensureSchema(env);
  if (!Number.isFinite(actualUsd) || !Number.isFinite(reservedUsd)) throw new Error("Invalid settlement amount");
  const charge = Math.max(0, actualUsd);
  const release = Math.max(0, reservedUsd);
  const t = now();
  const claim = "settlement:" + crypto.randomUUID();
  const ownedClaim = "EXISTS (SELECT 1 FROM wallet_ledger WHERE device_id = ? AND reason = 'usage' AND request_id = ? AND note = ?)";
  await runWalletTransaction(env, [
    env.DB.prepare(
      "INSERT INTO wallet_ledger (device_id, delta_usd, balance_after, reason, request_id, note, created_at) " +
      "SELECT ?, ?, balance_usd - ?, 'usage', ?, ?, ? FROM device_wallets WHERE device_id = ? " +
      "AND NOT EXISTS (SELECT 1 FROM reserve_holds WHERE request_id = ? AND device_id <> ?) " +
      "ON CONFLICT(device_id, reason, request_id) WHERE request_id IS NOT NULL DO NOTHING"
    ).bind(deviceId, -charge, charge, requestId, claim, t, deviceId, requestId, deviceId),
    env.DB.prepare(
      "UPDATE device_wallets SET reserved_usd = MAX(0, reserved_usd - COALESCE(" +
      "(SELECT MAX(0, amount_usd) FROM reserve_holds WHERE request_id = ? AND device_id = ?), " +
      "MIN(?, MAX(0, reserved_usd - COALESCE((SELECT SUM(amount_usd) FROM reserve_holds WHERE device_id = ?), 0))))), " +
      "balance_usd = balance_usd - ?, updated_at = ? WHERE device_id = ? AND " + ownedClaim
    ).bind(requestId, deviceId, release, deviceId, charge, t, deviceId, deviceId, requestId, claim),
    env.DB.prepare(
      "DELETE FROM reserve_holds WHERE request_id = ? AND device_id = ? AND " + ownedClaim
    ).bind(requestId, deviceId, deviceId, requestId, claim),
    env.DB.prepare(
      "UPDATE wallet_ledger SET note = ? WHERE device_id = ? AND reason = 'usage' AND request_id = ? AND note = ?"
    ).bind(release > charge ? "settled (partial refund of reserve)" : "settled", deviceId, requestId, claim),
  ]);
  const ledger = await env.DB.prepare(
    "SELECT balance_after AS balance_usd FROM wallet_ledger WHERE device_id = ? AND reason = 'usage' AND request_id = ?"
  ).bind(deviceId, requestId).first<{ balance_usd: number }>();
  return ledger ? Number(ledger.balance_usd) : null;
}

export async function chargeBalanceIfAffordable(
  env: Env,
  deviceId: string,
  costUsd: number,
  requestId: string,
): Promise<boolean> {
  await ensureSchema(env);
  const charge = Number.isFinite(costUsd) ? Math.max(0, costUsd) : 0;
  if (charge === 0) return true;

  const t = now();
  const res = await env.DB.prepare(
    "UPDATE device_wallets SET balance_usd = balance_usd - ?, updated_at = ? " +
      "WHERE device_id = ? AND balance_usd - reserved_usd >= ? RETURNING balance_usd"
  )
    .bind(charge, t, deviceId, charge)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return false;

  const balanceAfter = readReturnedBalance(res) ?? (await getBalance(env, deviceId));
  if (balanceAfter === null) return true;

  await insertLedgerEntry(env, {
    device_id: deviceId,
    delta_usd: -charge,
    reason: "usage",
    request_id: requestId,
    balance_after: balanceAfter,
    note: "cache hit (billed at first-time price)",
  });
  return true;
}

export async function releaseReserve(env: Env, deviceId: string, requestId: string): Promise<boolean> {
  await ensureSchema(env);
  const results = await runWalletTransaction(env, [
    env.DB.prepare(
      "UPDATE device_wallets SET reserved_usd = MAX(0, reserved_usd - " +
      "(SELECT MAX(0, amount_usd) FROM reserve_holds WHERE request_id = ? AND device_id = ?)), updated_at = ? " +
      "WHERE device_id = ? AND EXISTS (SELECT 1 FROM reserve_holds WHERE request_id = ? AND device_id = ?)"
    ).bind(requestId, deviceId, now(), deviceId, requestId, deviceId),
    env.DB.prepare("DELETE FROM reserve_holds WHERE request_id = ? AND device_id = ?").bind(requestId, deviceId),
  ]);
  return Number(results[1].meta.changes ?? 0) > 0;
}

export async function releaseStaleReserves(env: Env, olderThanMs = 60 * 60 * 1000): Promise<number> {
  await ensureSchema(env);
  const cutoff = now() - Math.max(0, olderThanMs);
  const stale = (await env.DB.prepare(
    "SELECT request_id, device_id, amount_usd, created_at FROM reserve_holds WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM video_tasks WHERE video_tasks.id = reserve_holds.request_id) AND NOT EXISTS (SELECT 1 FROM billing_requests WHERE billing_requests.request_id = reserve_holds.request_id) LIMIT 200"
  )
    .bind(cutoff)
    .all<{ request_id: string; device_id: string; amount_usd: number; created_at: number }>()) as {
    results?: { request_id: string; device_id: string; amount_usd: number; created_at: number }[];
  };

  let released = 0;
  const t = now();
  for (const row of stale.results ?? []) {
    try {
      const day = localDateString(t);
      const results = await runWalletTransaction(env, [
        env.DB.prepare(
          "INSERT INTO daily_stats (date, device_id, provider_id, provider_name, model, request_count, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit_count, cache_read_tokens, cache_write_tokens, cost_saved_usd, pricing_missing_count, avg_latency_ms, error_count) " +
            "SELECT ?, ?, '', '', '', 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 " +
            "WHERE NOT EXISTS (SELECT 1 FROM usage WHERE request_id = ?) AND EXISTS (SELECT 1 FROM reserve_holds WHERE request_id = ? AND device_id = ? AND created_at < ? AND NOT EXISTS (SELECT 1 FROM billing_requests b WHERE b.request_id = reserve_holds.request_id) AND NOT EXISTS (SELECT 1 FROM video_tasks v WHERE v.id = reserve_holds.request_id)) " +
            "ON CONFLICT(date, device_id, provider_id, model) DO UPDATE SET request_count = daily_stats.request_count + 1"
        ).bind(day, row.device_id, row.request_id, row.request_id, row.device_id, cutoff),
        env.DB.prepare(
          "INSERT INTO usage (device_id, provider_id, provider_name, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit, cache_read_tokens, cache_write_tokens, pricing_missing, price_multiplier, price_window_id, status_code, latency_ms, request_id, created_at) SELECT ?, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, 0, 0, 1, NULL, 0, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM usage WHERE request_id = ?) AND EXISTS (SELECT 1 FROM reserve_holds WHERE request_id = ? AND device_id = ? AND created_at < ? AND NOT EXISTS (SELECT 1 FROM billing_requests b WHERE b.request_id = reserve_holds.request_id) AND NOT EXISTS (SELECT 1 FROM video_tasks v WHERE v.id = reserve_holds.request_id))"
        ).bind(row.device_id, row.request_id, t, row.request_id, row.request_id, row.device_id, cutoff),
        env.DB.prepare(
          "UPDATE device_wallets SET reserved_usd = MAX(0, reserved_usd - " +
          "(SELECT MAX(0, amount_usd) FROM reserve_holds WHERE request_id = ? AND device_id = ? AND created_at < ? AND NOT EXISTS (SELECT 1 FROM billing_requests b WHERE b.request_id = reserve_holds.request_id) AND NOT EXISTS (SELECT 1 FROM video_tasks v WHERE v.id = reserve_holds.request_id))), updated_at = ? " +
          "WHERE device_id = ? AND EXISTS (SELECT 1 FROM reserve_holds WHERE request_id = ? AND device_id = ? AND created_at < ? AND NOT EXISTS (SELECT 1 FROM billing_requests b WHERE b.request_id = reserve_holds.request_id) AND NOT EXISTS (SELECT 1 FROM video_tasks v WHERE v.id = reserve_holds.request_id))"
        ).bind(row.request_id, row.device_id, cutoff, t, row.device_id, row.request_id, row.device_id, cutoff),
        env.DB.prepare("DELETE FROM reserve_holds WHERE request_id = ? AND device_id = ? AND created_at < ? AND NOT EXISTS (SELECT 1 FROM billing_requests b WHERE b.request_id = reserve_holds.request_id) AND NOT EXISTS (SELECT 1 FROM video_tasks v WHERE v.id = reserve_holds.request_id)").bind(row.request_id, row.device_id, cutoff),
      ]);
      const deleted = Number((results?.[3] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
      if (deleted > 0) released++;
    } catch {
      console.error("[wallet] stale reserve transaction failed", { request_id: row.request_id });
    }
  }
  return released;
}

export async function getBalance(env: Env, deviceId: string): Promise<number | null> {
  await ensureSchema(env);
  const row = (await env.DB.prepare("SELECT balance_usd FROM device_wallets WHERE device_id = ?")
    .bind(deviceId)
    .first<{ balance_usd: number }>()) as { balance_usd: number } | null;
  return row ? Number(row.balance_usd || 0) : null;
}

export async function adjustBalance(
  env: Env,
  deviceId: string,
  deltaUsd: number,
  opts: { reason?: LedgerReason; requestId?: string | null; note?: string | null } = {},
): Promise<{ balance_usd: number; changed: boolean } | null> {
  await ensureSchema(env);
  const device = await env.DB.prepare("SELECT id FROM devices WHERE id = ?").bind(deviceId).first<{ id: string }>();
  if (!device) return null;
  const t = now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO device_wallets (device_id, balance_usd, reserved_usd, created_at, updated_at) VALUES (?, 0, 0, ?, ?)"
  )
    .bind(deviceId, t, t)
    .run();
  const res = await env.DB.prepare(
    "UPDATE device_wallets SET balance_usd = balance_usd + ?, updated_at = ? WHERE device_id = ?"
  )
    .bind(deltaUsd, t, deviceId)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return null;
  const balanceAfter = Number(await getBalance(env, deviceId));
  await insertLedgerEntry(env, {
    device_id: deviceId,
    delta_usd: deltaUsd,
    reason: opts.reason || "topup",
    request_id: opts.requestId ?? null,
    balance_after: balanceAfter,
    note: opts.note ?? null,
  });
  return { balance_usd: balanceAfter, changed: true };
}

export async function insertLedgerEntry(
  env: Env,
  entry: {
    device_id: string;
    delta_usd: number;
    reason: LedgerReason;
    request_id?: string | null;
    balance_after: number;
    note?: string | null;
  },
): Promise<boolean> {
  await ensureSchema(env);
  const t = now();
  try {
    await env.DB.prepare(
      "INSERT INTO wallet_ledger (device_id, delta_usd, balance_after, reason, request_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        entry.device_id,
        entry.delta_usd,
        entry.balance_after,
        entry.reason,
        entry.request_id ?? null,
        entry.note ?? null,
        t
      )
      .run();
    return true;
  } catch {
    return false;
  }
}

export async function listLedger(env: Env, deviceId: string, limit = 100, offset = 0): Promise<WalletLedgerRow[]> {
  await ensureSchema(env);
  const res = await env.DB.prepare(
    "SELECT * FROM wallet_ledger WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
  )
    .bind(deviceId, Math.max(1, Math.min(200, limit)), Math.max(0, offset))
    .all<WalletLedgerRow>();
  return (res.results || []) as unknown as WalletLedgerRow[];
}


export type UsageInsertData = {
  device_id: string | null;
  provider_id: string | null;
  provider_name: string | null;
  model: string | null;
  usage: TokenUsage | null;
  cost_usd?: number;
  cache_hit?: number;
  pricing_missing?: boolean;
  price_multiplier?: number;
  price_window_id?: string | null;
  status_code: number | null;
  latency_ms: number | null;
  request_id: string;
  created_at: number;
  image_count?: number;
  search_calls?: number;
  sub_token_id?: string | null;
  service_group_id?: string | null;
  service_group_revision?: number | null;
  pricing_snapshot_json?: string | null;
};

export type UsageWriteClaim = { request_id: string; nonce: string };
const usageClaimSql = "EXISTS (SELECT 1 FROM billing_requests WHERE request_id = ? AND settlement_nonce = ? AND settled_at IS NULL)";

export function usageInsertStatement(env: Env, data: UsageInsertData, claim?: UsageWriteClaim) {
  const { input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens } = data.usage ?? {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
  const cost = typeof data.cost_usd === "number" ? data.cost_usd : 0;
  const cacheHit = data.cache_hit ? 1 : 0;
  const pricingMissing = data.pricing_missing ? 1 : 0;
  return env.DB.prepare(
    "INSERT INTO usage (device_id, provider_id, provider_name, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cache_hit, pricing_missing, price_multiplier, price_window_id, status_code, latency_ms, request_id, created_at, image_count, search_calls, sub_token_id, service_group_id, service_group_revision, pricing_snapshot_json) " +
      (claim
        ? "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE " + usageClaimSql
        : "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
  )
    .bind(
      data.device_id,
      data.provider_id,
      data.provider_name,
      data.model,
      input_tokens,
      output_tokens,
      total_tokens,
      cache_read_tokens || 0,
      cache_write_tokens || 0,
      cost,
      cacheHit,
      pricingMissing,
      typeof data.price_multiplier === "number" ? data.price_multiplier : 1,
      data.price_window_id ?? null,
      data.status_code,
      data.latency_ms,
      data.request_id,
      data.created_at,
      typeof data.image_count === "number" && data.image_count > 0 ? data.image_count : 0,
      typeof data.search_calls === "number" && data.search_calls > 0 ? Math.floor(data.search_calls) : 0,
      data.sub_token_id ?? null,
      data.service_group_id ?? null,
      data.service_group_revision ?? null,
      data.pricing_snapshot_json ?? null,
      ...(claim ? [claim.request_id, claim.nonce] : [])
    );
}

export function dailyStatsUpsertStatement(env: Env, data: UsageInsertData, claim?: UsageWriteClaim) {
  const { input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens } = data.usage ?? {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
  const cost = typeof data.cost_usd === "number" ? data.cost_usd : 0;
  const cacheHit = data.cache_hit ? 1 : 0;
  const pricingMissing = data.pricing_missing ? 1 : 0;
  const errorCount = (data.status_code ?? 0) >= 400 ? 1 : 0;
  const latency = typeof data.latency_ms === "number" ? data.latency_ms : 0;
  const searchCalls = typeof data.search_calls === "number" && data.search_calls > 0 ? Math.floor(data.search_calls) : 0;
  const costSaved = cacheHit ? cost : 0;
  return env.DB.prepare(
    "INSERT INTO daily_stats (date, device_id, provider_id, model, provider_name, request_count, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit_count, cache_read_tokens, cache_write_tokens, cost_saved_usd, avg_latency_ms, error_count, pricing_missing_count, search_calls) " +
      (claim
        ? "SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE " + usageClaimSql + " "
        : "VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ") +
      "ON CONFLICT(date, device_id, provider_id, model) DO UPDATE SET " +
      "provider_name = CASE WHEN daily_stats.provider_name = '' THEN excluded.provider_name ELSE daily_stats.provider_name END, " +
      "request_count = daily_stats.request_count + 1, " +
      "input_tokens = daily_stats.input_tokens + excluded.input_tokens, " +
      "output_tokens = daily_stats.output_tokens + excluded.output_tokens, " +
      "total_tokens = daily_stats.total_tokens + excluded.total_tokens, " +
      "cost_usd = daily_stats.cost_usd + excluded.cost_usd, " +
      "cache_hit_count = daily_stats.cache_hit_count + excluded.cache_hit_count, " +
      "cache_read_tokens = daily_stats.cache_read_tokens + excluded.cache_read_tokens, " +
      "cache_write_tokens = daily_stats.cache_write_tokens + excluded.cache_write_tokens, " +
      "cost_saved_usd = daily_stats.cost_saved_usd + excluded.cost_saved_usd, " +
      "avg_latency_ms = (daily_stats.avg_latency_ms * daily_stats.request_count + excluded.avg_latency_ms) / (daily_stats.request_count + 1), " +
      "error_count = daily_stats.error_count + excluded.error_count, " +
      "pricing_missing_count = daily_stats.pricing_missing_count + excluded.pricing_missing_count, " +
      "search_calls = daily_stats.search_calls + excluded.search_calls"
  ).bind(
    localDateString(data.created_at),
    data.device_id ?? "",
    data.provider_id ?? "",
    data.model ?? "",
    data.provider_name ?? "",
    input_tokens,
    output_tokens,
    total_tokens,
    cost,
    cacheHit,
    cache_read_tokens || 0,
    cache_write_tokens || 0,
    costSaved,
    latency,
    errorCount,
    pricingMissing,
    searchCalls,
    ...(claim ? [claim.request_id, claim.nonce] : [])
  );
}

export async function insertUsage(env: Env, data: UsageInsertData) {
  await env.DB.batch([invalidateMonthlyDeviceStatsStatement(env), usageInsertStatement(env, data)]);
}

export async function listUsage(
  env: Env,
  opts: {
    from?: number;
    to?: number;
    provider_id?: string;
    model?: string;
    device_id?: string;
    sub_token_id?: string;
    service_group_id?: string;
    request_id?: string;
    status?: "success" | "error" | number;
    cursor?: { created_at: number; id: number };
    limit: number;
    offset: number;
  }
) {
  await ensureSchema(env);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.from !== undefined) { where.push("created_at >= ?"); binds.push(opts.from); }
  const upper = opts.cursor ? Math.min(opts.to ?? opts.cursor.created_at, opts.cursor.created_at) : opts.to;
  if (upper !== undefined) { where.push("created_at <= ?"); binds.push(upper); }
  if (opts.provider_id) { where.push("provider_id = ?"); binds.push(opts.provider_id); }
  if (opts.model) { where.push("model = ?"); binds.push(opts.model); }
  if (opts.device_id) { where.push("device_id = ?"); binds.push(opts.device_id); }
  if (opts.sub_token_id) { where.push("sub_token_id = ?"); binds.push(opts.sub_token_id); }
  if (opts.service_group_id) { where.push("service_group_id = ?"); binds.push(opts.service_group_id); }
  if (opts.request_id) { where.push("request_id = ?"); binds.push(opts.request_id); }
  if (opts.status === "error") where.push("status_code >= 400");
  else if (opts.status === "success") where.push("status_code < 400");
  else if (typeof opts.status === "number") { where.push("status_code = ?"); binds.push(opts.status); }
  if (opts.cursor) { where.push("(created_at, id) < (?, ?)"); binds.push(opts.cursor.created_at, opts.cursor.id); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  binds.push(opts.limit, opts.cursor ? 0 : opts.offset);
  const rows = await env.DB.prepare(
    `SELECT * FROM usage ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(...binds).all<UsageRow>();
  return rows.results as unknown as UsageRow[];
}


async function reportSource(env: Env, from: number, toExclusive?: number, tzOffsetMinutes?: number) {
  await ensureSchema(env);
  const validate = async () => {
    if (tzOffsetMinutes !== undefined && tzOffsetMinutes % 60 !== 0) await usageGroupedReportSource(env, from, toExclusive, tzOffsetMinutes);
    else await validateUsageRange(env, from, toExclusive);
  };
  await validate();
  const relation = tzOffsetMinutes === undefined ? usageReportSource(from, toExclusive) : await usageGroupedReportSource(env, from, toExclusive, tzOffsetMinutes);
  return { ...relation, checked: async <T>(value: T): Promise<T> => { await validate(); return value; } };
}

export async function statsSummary(env: Env, since: number, tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES) {
  const source = await reportSource(env, since);
  return env.DB.prepare(`
    SELECT COALESCE(SUM(request_count), 0) as request_count,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd,
      COALESCE(SUM(cache_hit_count), 0) as cache_hit_count,
      COALESCE(SUM(cache_read_tokens), 0) as upstream_cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) as upstream_cache_write_tokens,
      COALESCE(1.0 * SUM(latency_sum) / NULLIF(SUM(latency_count), 0), 0) as avg_latency_ms,
      COALESCE(SUM(pricing_missing_count), 0) as pricing_missing_count,
      COALESCE(SUM(search_calls), 0) as search_calls,
      COALESCE(SUM(error_count), 0) as error_count
    FROM ${source.sql}
  `).bind(...source.binds).first<Record<string, number>>().then(source.checked);
}

export const GROUPED_SCAN_MIN_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
export function preferGroupedScan(since: number, nowMs = Date.now()): boolean {
  return nowMs - since >= GROUPED_SCAN_MIN_WINDOW_MS;
}

export async function statsByProvider(env: Env, since: number, tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES) {
  const source = await reportSource(env, since);
  const res = await env.DB.prepare(`
    SELECT COALESCE(NULLIF(u.pname, ''), p.name, u.pid, 'unknown') as name,
      u.requests, u.tokens, u.cost_usd, u.avg_latency_ms, u.errors
    FROM (
      SELECT provider_id as pid, MAX(provider_name) as pname,
        COALESCE(SUM(request_count), 0) as requests, COALESCE(SUM(total_tokens), 0) as tokens,
        COALESCE(SUM(cost_usd), 0) as cost_usd,
        COALESCE(1.0 * SUM(latency_sum) / NULLIF(SUM(latency_count), 0), 0) as avg_latency_ms,
        COALESCE(SUM(error_count), 0) as errors
      FROM ${source.sql} GROUP BY provider_id
    ) u LEFT JOIN providers p ON p.id = u.pid ORDER BY u.requests DESC
  `).bind(...source.binds).all().then(source.checked);
  return res.results;
}

export async function statsByModel(env: Env, since: number, tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES) {
  const source = await reportSource(env, since);
  const res = await env.DB.prepare(`
    SELECT COALESCE(model, 'unknown') as name, COALESCE(SUM(request_count), 0) as requests,
      COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0) as cost_usd,
      COALESCE(1.0 * SUM(latency_sum) / NULLIF(SUM(latency_count), 0), 0) as avg_latency_ms,
      COALESCE(SUM(error_count), 0) as errors
    FROM ${source.sql} GROUP BY model ORDER BY requests DESC
  `).bind(...source.binds).all().then(source.checked);
  return res.results;
}

export async function statsTrend(
  env: Env,
  since: number,
  tzModifier = "+480 minutes",
  tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES
) {
  const source = await reportSource(env, since, undefined, sqlTzModifierToOffsetMinutes(tzModifier));
  const res = await env.DB.prepare(`
    SELECT strftime('%Y-%m-%d', datetime(created_at / 1000, 'unixepoch', ?)) as date,
      COALESCE(SUM(request_count), 0) as requests, COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM ${source.sql} GROUP BY date ORDER BY date ASC
  `).bind(tzModifier, ...source.binds).all().then(source.checked);
  return res.results;
}

export async function recordUsageSafe(env: Env, data: UsageInsertData) {
  try {
    const statements = [usageInsertStatement(env, data), dailyStatsUpsertStatement(env, data)];
    if (data.device_id) statements.push(touchDeviceStatement(env, data.device_id));
    if (data.sub_token_id) statements.push(touchSubTokenStatement(env, data.sub_token_id));
    await runStatements(env, statements);
  } catch {
  }
}

export function localDayStartMs(date: string, tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const shift = tzOffsetMinutes * 60_000;
  const ms = Date.UTC(y, mo - 1, d) + shift;
  if (new Date(ms - shift).toISOString().slice(0, 10) !== date) return null;
  return ms;
}

export function recentLocalDates(count: number, tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES, nowMs = Date.now()): string[] {
  const shift = tzOffsetMinutes * 60_000;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(new Date(nowMs - shift - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }
  return out;
}

export const DAILY_STATS_REBUILD_DAYS = 2;

export async function aggregateDailyStats(
  env: Env,
  targetDate?: string,
  tzModifier = "+480 minutes"
): Promise<{ aggregated: number }> {
  await ensureSchema(env);
  const tzOffsetMinutes = sqlTzModifierToOffsetMinutes(tzModifier);
  if (tzOffsetMinutes !== DEFAULT_TZ_OFFSET_MINUTES) throw new Error("usage_daily_timezone_unsupported");
  const dates = targetDate ? [targetDate] : recentLocalDates(DAILY_STATS_REBUILD_DAYS, tzOffsetMinutes);
  const rebuilds: D1PreparedStatement[] = [];
  for (const date of dates) {
    const startMs = localDayStartMs(date, tzOffsetMinutes);
    if (startMs === null) continue;
    const source = await reportSource(env, startMs, startMs + 24 * 60 * 60 * 1000);
    rebuilds.push(env.DB.prepare("DELETE FROM daily_stats WHERE date = ?").bind(date));
    rebuilds.push(env.DB.prepare(`
      INSERT INTO daily_stats (date, device_id, provider_id, provider_name, model, request_count,
        input_tokens, output_tokens, total_tokens, cost_usd, cache_hit_count, cache_read_tokens,
        cache_write_tokens, cost_saved_usd, pricing_missing_count, search_calls, avg_latency_ms, error_count)
      SELECT ?, COALESCE(device_id, ''), COALESCE(provider_id, ''), COALESCE(MAX(provider_name), ''), COALESCE(model, ''),
        COALESCE(SUM(request_count), 0), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
        COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_usd), 0), COALESCE(SUM(cache_hit_count), 0),
        COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0), COALESCE(SUM(cost_saved_usd), 0),
        COALESCE(SUM(pricing_missing_count), 0), COALESCE(SUM(search_calls), 0),
        COALESCE(1.0 * SUM(latency_sum) / NULLIF(SUM(latency_count), 0), 0), COALESCE(SUM(error_count), 0)
      FROM ${source.sql}
      GROUP BY COALESCE(device_id, ''), COALESCE(provider_id, ''), COALESCE(model, '')
    `).bind(date, ...source.binds));
  }
  if (!rebuilds.length) return { aggregated: 0 };
  const results = await env.DB.batch([invalidateMonthlyDeviceStatsStatement(env), ...rebuilds]);
  return { aggregated: results.slice(1).reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0) };
}


export const RETENTION_DAYS_CHOICES = [15, 30, 60, 90] as const;
export type RetentionDays = (typeof RETENTION_DAYS_CHOICES)[number];

export interface RetentionConfig {
  enabled: boolean;
  retention_days: number;
  keep_daily_stats: boolean;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  enabled: false,
  retention_days: 30,
  keep_daily_stats: true,
};

export interface RetentionCleanupResult {
  ok: boolean;
  ran: boolean;
  cutoff_ms: number | null;
  retention_days: number;
  usage_deleted: number;
  audit_deleted: number;
  daily_stats_deleted: number;
}

export const RETENTION_DELETE_CHUNK = 5000;

export function localDateString(ms: number, tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES): string {
  return new Date(ms - tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export async function cleanupOldUsage(
  env: Env,
  opts: { retentionDays?: number; cutoffMs?: number; keepDailyStats?: boolean } = {}
): Promise<RetentionCleanupResult> {
  throw new Error("usage_retention_requires_verified_preview");
}


const SETTINGS_CACHE_TTL_MS = 60000;
const SETTINGS_CACHE_DENY = new Set<string>([
  "session_epoch",
  "webhook_config",
  "ip_whitelist_config",
  "provider_health_map",
]);
const settingsCacheRef = {
  current: new WeakMap<object, Map<string, { value: unknown; expires: number }>>(),
};

function settingsCacheBucket(env: Env): Map<string, { value: unknown; expires: number }> | null {
  if (!env?.DB || typeof env.DB !== "object") return null;
  const db = env.DB as unknown as object;
  let bucket = settingsCacheRef.current.get(db);
  if (!bucket) {
    bucket = new Map();
    settingsCacheRef.current.set(db, bucket);
  }
  return bucket;
}

function settingsCacheable(env: Env, key: string): boolean {
  if (!env?.DB || typeof env.DB !== "object") return false;
  if (SETTINGS_CACHE_DENY.has(key)) return false;
  if (key.startsWith(PROVIDER_HEALTH_PREFIX)) return false;
  return true;
}

export function resetSettingsCacheForTest(): void {
  settingsCacheRef.current = new WeakMap();
}

export async function getSetting<T = any>(env: Env, key: string): Promise<T | null> {
  if (!env?.DB) return null;
  const cacheable = settingsCacheable(env, key);
  if (cacheable) {
    const hit = settingsCacheBucket(env)?.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T | null;
  }
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT value_json FROM settings WHERE key = ?").bind(key).first<{ value_json: string }>();
  let value: T | null;
  if (!row?.value_json) {
    value = null;
  } else {
    try {
      value = JSON.parse(row.value_json) as T;
    } catch {
      value = row.value_json as unknown as T;
    }
  }
  if (cacheable) {
    settingsCacheBucket(env)?.set(key, { value, expires: Date.now() + SETTINGS_CACHE_TTL_MS });
  }
  return value;
}

export async function setSetting(env: Env, key: string, val: any): Promise<void> {
  if (!env?.DB) return;
  await ensureSchema(env);
  const json = typeof val === "string" ? val : JSON.stringify(val);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)"
  ).bind(key, json, Date.now()).run();
  settingsCacheBucket(env)?.delete(key);
}


export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCK_MS = 5 * 60 * 1000;
export const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export interface LoginAttemptRow {
  ip: string;
  count: number;
  locked_until: number;
  updated_at: number;
}

function hasDb(env: Env): boolean {
  return Boolean(env?.DB) && typeof (env.DB as any).prepare === "function";
}

export async function getLoginAttempt(env: Env, ip: string): Promise<LoginAttemptRow | null> {
  if (!hasDb(env)) return null;
  await ensureSchema(env);
  const row = await env.DB.prepare(
    "SELECT ip, count, locked_until, updated_at FROM login_attempts WHERE ip = ?"
  ).bind(ip).first<LoginAttemptRow>();
  return row || null;
}

export async function recordLoginFailure(
  env: Env,
  ip: string,
  opts: { maxAttempts?: number; lockMs?: number; windowMs?: number } = {}
): Promise<LoginAttemptRow> {
  const maxAttempts = opts.maxAttempts ?? LOGIN_MAX_ATTEMPTS;
  const lockMs = opts.lockMs ?? LOGIN_LOCK_MS;
  const windowMs = opts.windowMs ?? LOGIN_ATTEMPT_WINDOW_MS;
  const now = Date.now();
  const existing = await getLoginAttempt(env, ip);

  let count = 0;
  if (existing && now - existing.updated_at < windowMs) {
    count = existing.count;
  }
  count += 1;
  const lockedUntil = count >= maxAttempts ? now + lockMs : 0;
  const row: LoginAttemptRow = { ip, count, locked_until: lockedUntil, updated_at: now };

  if (!hasDb(env)) return row;
  await ensureSchema(env);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO login_attempts (ip, count, locked_until, updated_at) VALUES (?, ?, ?, ?)"
  ).bind(ip, count, lockedUntil, now).run();
  return row;
}

export async function clearLoginAttempt(env: Env, ip: string): Promise<void> {
  if (!hasDb(env)) return;
  await ensureSchema(env);
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
}

export async function pruneLoginAttempts(env: Env, olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  if (!hasDb(env)) return 0;
  await ensureSchema(env);
  const cutoff = Date.now() - Math.max(0, olderThanMs);
  const res = await env.DB.prepare("DELETE FROM login_attempts WHERE updated_at < ?").bind(cutoff).run();
  return res.meta?.changes ?? 0;
}

export async function getSessionEpoch(env: Env): Promise<number> {
  const raw = await getSetting<number | string>(env, "session_epoch");
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export async function bumpSessionEpoch(env: Env): Promise<number> {
  const next = (await getSessionEpoch(env)) + 1;
  await setSetting(env, "session_epoch", next);
  return next;
}


export async function getLatestUsage(env: Env, afterId?: number, limit = 20): Promise<UsageRow[]> {
  await ensureSchema(env);
  const maxLimit = Math.min(Math.max(1, limit), 50);
  if (afterId && afterId > 0) {
    const res = await env.DB.prepare(
      "SELECT * FROM usage WHERE id > ? ORDER BY id DESC LIMIT ?"
    ).bind(afterId, maxLimit).all<UsageRow>();
    return (res.results || []) as unknown as UsageRow[];
  }
  const res = await env.DB.prepare(
    "SELECT * FROM usage ORDER BY id DESC LIMIT ?"
  ).bind(maxLimit).all<UsageRow>();
  return (res.results || []) as unknown as UsageRow[];
}

export async function statsCacheAnalytics(env: Env, since: number) {
  const source = await reportSource(env, since);
  const res = await env.DB.prepare(`
    SELECT COALESCE(SUM(request_count), 0) as total_requests,
      COALESCE(SUM(cache_hit_count), 0) as cache_hits,
      COALESCE(SUM(cache_saved_tokens), 0) as tokens_saved,
      COALESCE(SUM(cost_saved_usd), 0) as cost_saved_usd,
      COALESCE(1.0 * SUM(cached_latency_sum) / NULLIF(SUM(cached_latency_count), 0), 0) as avg_cached_latency_ms,
      COALESCE(1.0 * SUM(direct_latency_sum) / NULLIF(SUM(direct_latency_count), 0), 0) as avg_direct_latency_ms
    FROM ${source.sql}
  `).bind(...source.binds).first<Record<string, number>>().then(source.checked);

  const total = res?.total_requests || 0;
  const hits = res?.cache_hits || 0;
  const hitRate = total > 0 ? (hits / total) * 100 : 0;
  const cachedLatency = Math.round(res?.avg_cached_latency_ms || 0);
  const directLatency = Math.round(res?.avg_direct_latency_ms || 0);
  const accelerationRatio = cachedLatency > 0 && directLatency > cachedLatency
    ? Number((directLatency / cachedLatency).toFixed(1))
    : directLatency > 0 ? Number((directLatency / Math.max(1, cachedLatency)).toFixed(1)) : 1;

  return {
    total_requests: total,
    cache_hits: hits,
    cache_hit_rate: Number(hitRate.toFixed(1)),
    tokens_saved: res?.tokens_saved || 0,
    cost_saved_usd: Number((res?.cost_saved_usd || 0).toFixed(4)),
    avg_cached_latency_ms: cachedLatency,
    avg_direct_latency_ms: directLatency,
    acceleration_ratio: accelerationRatio,
  };
}

export async function statsModelLatency(env: Env, since: number) {
  const source = await reportSource(env, since);
  const res = await env.DB.prepare(`
    SELECT COALESCE(model, 'unknown') as model,
      COALESCE(MAX(provider_name), 'unknown') as provider_name,
      COALESCE(SUM(positive_latency_count), 0) as requests,
      COALESCE(1.0 * SUM(positive_latency_sum) / NULLIF(SUM(positive_latency_count), 0), 0) as avg_latency_ms,
      COALESCE(MIN(NULLIF(positive_latency_min, 0)), 0) as min_latency_ms,
      COALESCE(MAX(positive_latency_max), 0) as max_latency_ms,
      COALESCE(SUM(positive_latency_error_count), 0) as error_count
    FROM ${source.sql}
    GROUP BY model HAVING SUM(positive_latency_count) > 0
    ORDER BY requests DESC, avg_latency_ms ASC LIMIT 15
  `).bind(...source.binds).all<Record<string, any>>().then(source.checked);

  return (res.results || []).map((r) => ({
    model: r.model,
    provider_name: r.provider_name,
    requests: Number(r.requests),
    avg_latency_ms: Math.round(Number(r.avg_latency_ms)),
    min_latency_ms: Math.round(Number(r.min_latency_ms)),
    max_latency_ms: Math.round(Number(r.max_latency_ms)),
    p90_latency_ms: Math.round(Number(r.avg_latency_ms) * 1.35 > Number(r.max_latency_ms) ? Number(r.max_latency_ms) : Number(r.avg_latency_ms) * 1.35),
    error_count: Number(r.error_count),
    error_rate: Number(r.requests) > 0 ? Number(((Number(r.error_count) / Number(r.requests)) * 100).toFixed(1)) : 0,
  }));
}

export async function getCurrentMonthSpend(env: Env, tzModifier = "+480 minutes"): Promise<number> {
  await ensureSchema(env);
  const offset = sqlTzModifierToOffsetMinutes(tzModifier);
  const start = monthStartMs(offset);
  let row: { total_cost: number } | null;
  if (offset === DEFAULT_TZ_OFFSET_MINUTES) {
    row = await env.DB.prepare(`SELECT ${usageCostExpression(String(start))} as total_cost`)
      .first<{ total_cost: number }>();
  } else {
    const source = await reportSource(env, start);
    row = await env.DB.prepare(`SELECT COALESCE(SUM(cost_usd), 0) as total_cost FROM ${source.sql}`)
      .bind(...source.binds).first<{ total_cost: number }>().then(source.checked);
  }
  return Number((row?.total_cost || 0).toFixed(4));
}

export async function generateMonthlyReport(
  env: Env,
  targetMonth?: string,
  tzModifier = "+480 minutes"
): Promise<MonthlyReport> {
  await ensureSchema(env);
  const safeTz = tzModifier.replace(/[^a-zA-Z0-9+\- ]/g, "");

  const tzOffsetMinutes = sqlTzModifierToOffsetMinutes(tzModifier);
  const localNow = new Date(Date.now() - tzOffsetMinutes * 60_000);
  let year = localNow.getUTCFullYear();
  let month = localNow.getUTCMonth() + 1;  

  if (targetMonth && /^\d{4}-\d{2}$/.test(targetMonth)) {
    const parts = targetMonth.split("-");
    year = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
  }

  const monthStr = `${year}-${String(month).padStart(2, "0")}`;
  const { startMs: startTime, endMs: endTime, prevStartMs: prevStartTime, prevEndMs: prevEndTime } = monthRangeMs(
    year,
    month,
    tzOffsetMinutes
  );

  const prevMonthYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevMonthStr = `${prevMonthYear}-${String(prevMonth).padStart(2, "0")}`;

  const source = await reportSource(env, startTime, endTime + 1, tzOffsetMinutes);
  const previousSource = await reportSource(env, prevStartTime, prevEndTime + 1, tzOffsetMinutes);

  const summaryRow = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(request_count), 0) as total_requests,
      COALESCE(SUM(cost_usd), 0) as total_cost_usd,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(cache_hit_count), 0) as cache_hit_count,
      COALESCE(SUM(cache_saved_tokens), 0) as cache_saved_tokens,
      COALESCE(SUM(cost_saved_usd), 0) as cache_saved_cost_usd
    FROM ${source.sql}
  `).bind(...source.binds).first<Record<string, any>>().then(source.checked);

  const totalCost = Number((summaryRow?.total_cost_usd || 0).toFixed(4));
  const totalReqs = Number(summaryRow?.total_requests || 0);

  const prevRow = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(request_count), 0) as prev_requests,
      COALESCE(SUM(cost_usd), 0) as prev_cost_usd
    FROM ${previousSource.sql}
  `).bind(...previousSource.binds).first<Record<string, any>>().then(previousSource.checked);

  const prevCost = Number((prevRow?.prev_cost_usd || 0).toFixed(4));
  const prevReqs = Number(prevRow?.prev_requests || 0);

  const costGrowthPercent = prevCost > 0
    ? Number((((totalCost - prevCost) / prevCost) * 100).toFixed(1))
    : 0;
  const reqGrowthPercent = prevReqs > 0
    ? Number((((totalReqs - prevReqs) / prevReqs) * 100).toFixed(1))
    : 0;

  const providerRows = await env.DB.prepare(`
    SELECT
      COALESCE(provider_id, 'unknown') as key,
      COALESCE(MAX(provider_name), provider_id, 'Unknown Provider') as name,
      COALESCE(SUM(request_count), 0) as request_count,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM ${source.sql}
    GROUP BY key
    ORDER BY cost_usd DESC
  `).bind(...source.binds).all<Record<string, any>>().then(source.checked);

  const byProvider: MonthlyReportBreakdownItem[] = (providerRows.results || []).map((r) => {
    const c = Number(Number(r.cost_usd || 0).toFixed(4));
    return {
      key: String(r.key),
      name: String(r.name),
      request_count: Number(r.request_count),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      total_tokens: Number(r.total_tokens),
      cost_usd: c,
      share_percent: totalCost > 0 ? Number(((c / totalCost) * 100).toFixed(1)) : 0,
    };
  });

  const modelRows = await env.DB.prepare(`
    SELECT
      COALESCE(model, 'unknown') as key,
      COALESCE(model, 'Unknown Model') as name,
      COALESCE(SUM(request_count), 0) as request_count,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM ${source.sql}
    GROUP BY key
    ORDER BY cost_usd DESC
  `).bind(...source.binds).all<Record<string, any>>().then(source.checked);

  const byModel: MonthlyReportBreakdownItem[] = (modelRows.results || []).map((r) => {
    const c = Number(Number(r.cost_usd || 0).toFixed(4));
    return {
      key: String(r.key),
      name: String(r.name),
      request_count: Number(r.request_count),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      total_tokens: Number(r.total_tokens),
      cost_usd: c,
      share_percent: totalCost > 0 ? Number(((c / totalCost) * 100).toFixed(1)) : 0,
    };
  });

  const deviceRows = await env.DB.prepare(`
    SELECT
      COALESCE(u.device_id, 'direct') as key,
      COALESCE(d.name, u.device_id, 'Direct / Anonymous') as name,
      COALESCE(SUM(u.request_count), 0) as request_count,
      COALESCE(SUM(u.input_tokens), 0) as input_tokens,
      COALESCE(SUM(u.output_tokens), 0) as output_tokens,
      COALESCE(SUM(u.total_tokens), 0) as total_tokens,
      COALESCE(SUM(u.cost_usd), 0) as cost_usd
    FROM ${source.sql} u
    LEFT JOIN devices d ON d.id = u.device_id
    GROUP BY key
    ORDER BY cost_usd DESC
  `).bind(...source.binds).all<Record<string, any>>().then(source.checked);

  const byDevice: MonthlyReportBreakdownItem[] = (deviceRows.results || []).map((r) => {
    const c = Number(Number(r.cost_usd || 0).toFixed(4));
    return {
      key: String(r.key),
      name: String(r.name),
      request_count: Number(r.request_count),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      total_tokens: Number(r.total_tokens),
      cost_usd: c,
      share_percent: totalCost > 0 ? Number(((c / totalCost) * 100).toFixed(1)) : 0,
    };
  });

  const trendRows = await env.DB.prepare(`
    SELECT
      strftime('%Y-%m-%d', datetime(created_at / 1000, 'unixepoch', ?)) as date,
      COALESCE(SUM(request_count), 0) as request_count,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM ${source.sql}
    GROUP BY date
    ORDER BY date ASC
  `).bind(safeTz, ...source.binds).all<Record<string, any>>().then(source.checked);

  const dailyTrend: MonthlyReportDailyTrend[] = (trendRows.results || []).map((r) => ({
    date: String(r.date),
    request_count: Number(r.request_count),
    total_tokens: Number(r.total_tokens),
    cost_usd: Number(Number(r.cost_usd || 0).toFixed(4)),
  }));

  return {
    month: monthStr,
    start_time: startTime,
    end_time: endTime,
    total_cost_usd: totalCost,
    total_requests: totalReqs,
    total_input_tokens: Number(summaryRow?.total_input_tokens || 0),
    total_output_tokens: Number(summaryRow?.total_output_tokens || 0),
    total_tokens: Number(summaryRow?.total_tokens || 0),
    cache_hit_count: Number(summaryRow?.cache_hit_count || 0),
    cache_saved_tokens: Number(summaryRow?.cache_saved_tokens || 0),
    cache_saved_cost_usd: Number(Number(summaryRow?.cache_saved_cost_usd || 0).toFixed(4)),
    by_provider: byProvider,
    by_model: byModel,
    by_device: byDevice,
    daily_trend: dailyTrend,
    mom_growth: {
      previous_month: prevMonthStr,
      previous_cost_usd: prevCost,
      previous_requests: prevReqs,
      cost_growth_percent: costGrowthPercent,
      request_growth_percent: reqGrowthPercent,
    },
  };
}

export async function statsCostAnalytics(
  env: Env,
  since: number,
  tzModifier = "+480 minutes",
  range = "30d"
): Promise<CostAnalytics> {
  await ensureSchema(env);
  const safeTz = tzModifier.replace(/[^a-zA-Z0-9+\- ]/g, "");
  const tzOffsetMinutes = sqlTzModifierToOffsetMinutes(tzModifier);

  const source = await reportSource(env, since, undefined, tzOffsetMinutes);

  const totalRow = await env.DB.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total_cost
    FROM ${source.sql}
  `).bind(...source.binds).first<{ total_cost: number }>().then(source.checked);
  const totalCostUsd = Number((totalRow?.total_cost || 0).toFixed(4));

  const modelRows = await env.DB.prepare(`
    SELECT
      COALESCE(m.model, 'unknown') as model,
      COALESCE(SUM(request_count), 0) as request_count,
      COALESCE(SUM(m.input_tokens), 0) as input_tokens,
      COALESCE(SUM(m.output_tokens), 0) as output_tokens,
      COALESCE(SUM(m.total_tokens), 0) as total_tokens,
      COALESCE(SUM(m.cost_usd), 0) as cost_usd
    FROM ${source.sql} m
    GROUP BY m.model
    ORDER BY cost_usd DESC
  `).bind(...source.binds).all<Record<string, any>>().then(source.checked);

  const modelRanking: ModelSpendRankItem[] = (modelRows.results || []).map((r) => {
    const cost = Number(Number(r.cost_usd || 0).toFixed(4));
    const reqs = Number(r.request_count || 0);
    return {
      model: String(r.model),
      request_count: reqs,
      input_tokens: Number(r.input_tokens || 0),
      output_tokens: Number(r.output_tokens || 0),
      total_tokens: Number(r.total_tokens || 0),
      cost_usd: cost,
      share_percent: totalCostUsd > 0 ? Number(((cost / totalCostUsd) * 100).toFixed(1)) : 0,
      avg_cost_per_request: reqs > 0 ? Number((cost / reqs).toFixed(6)) : 0,
    };
  });

  const dailySpendRows = await env.DB.prepare(`
    SELECT
      strftime('%Y-%m-%d', datetime(created_at / 1000, 'unixepoch', ?)) as date,
      COALESCE(SUM(request_count), 0) as request_count,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM ${source.sql}
    GROUP BY date
    ORDER BY date ASC
  `).bind(safeTz, ...source.binds).all<Record<string, any>>().then(source.checked);

  const dailySpends = (dailySpendRows.results || []).map((r) => ({
    date: String(r.date),
    cost: Number(r.cost_usd || 0),
    reqs: Number(r.request_count || 0),
  }));

  let anomalyAlert: CostAnomalyAlert = { is_anomaly: false };

  if (dailySpends.length >= 2) {
    const totalDailySpend = dailySpends.reduce((acc, d) => acc + d.cost, 0);
    const avgDailySpend = totalDailySpend / dailySpends.length;

    for (let i = dailySpends.length - 1; i >= Math.max(0, dailySpends.length - 3); i--) {
      const day = dailySpends[i];
      if (day.cost > 0.10 && avgDailySpend > 0 && day.cost >= avgDailySpend * 2.2) {
        const ratio = Number((day.cost / avgDailySpend).toFixed(1));

        const dayStartMs = localDayStartMs(day.date, tzOffsetMinutes) ?? 0;
        const daySource = await reportSource(env, Math.max(since, dayStartMs), dayStartMs + 24 * 60 * 60 * 1000);
        const topModelRow = await env.DB.prepare(`
          SELECT model, COALESCE(SUM(cost_usd), 0) as model_cost
          FROM ${daySource.sql}
          GROUP BY model
          ORDER BY model_cost DESC
          LIMIT 1
        `).bind(...daySource.binds).first<Record<string, any>>().then(daySource.checked);

        anomalyAlert = {
          is_anomaly: true,
          spike_date: day.date,
          spike_cost_usd: Number(day.cost.toFixed(4)),
          baseline_avg_usd: Number(avgDailySpend.toFixed(4)),
          spike_ratio: ratio,
          top_contributor_model: topModelRow?.model ? String(topModelRow.model) : undefined,
          message: `${day.date} 消费异常突增 (${ratio}x 均值: ¥${day.cost.toFixed(2)})，主要由「${topModelRow?.model || "未知模型"}」产生`,
        };
        break;
      }
    }
  }

  return {
    range,
    total_cost_usd: totalCostUsd,
    anomaly_alert: anomalyAlert,
    model_ranking: modelRanking,
  };
}

export function randomRequestId(): string {
  return randomUUID();
}


export async function recordAuditLog(
  env: Env,
  params: {
    actor_type?: string;
    ip?: string | null;
    action: string;
    target_type: string;
    target_id?: string | null;
    summary: string;
    details?: Record<string, unknown> | null;
  }
): Promise<void> {
  await ensureSchema(env);
  const t = now();
  const actorType = params.actor_type || "admin";
  const ip = params.ip || null;
  const targetId = params.target_id || null;
  const detailsJson = params.details ? JSON.stringify(params.details) : null;

  try {
    await env.DB.prepare(`
      INSERT INTO audit_logs (actor_type, ip, action, target_type, target_id, summary, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(actorType, ip, params.action, params.target_type, targetId, params.summary, detailsJson, t).run();
  } catch (err) {
    console.error("Failed to record audit log:", err);
  }
}

export async function listAuditLogs(
  env: Env,
  options: {
    limit?: number;
    offset?: number;
    action?: string;
    target_type?: string;
    actor_type?: string;
  } = {}
): Promise<{ items: AuditLogRow[]; total: number }> {
  await ensureSchema(env);
  const limit = Math.min(Math.max(1, options.limit || 50), 200);
  const offset = Math.max(0, options.offset || 0);

  let whereSql = "WHERE 1=1";
  const binds: unknown[] = [];

  if (options.action) {
    whereSql += " AND action = ?";
    binds.push(options.action);
  }
  if (options.target_type) {
    whereSql += " AND target_type = ?";
    binds.push(options.target_type);
  }
  if (options.actor_type) {
    whereSql += " AND actor_type = ?";
    binds.push(options.actor_type);
  }

  const countRow = await env.DB.prepare(`SELECT COUNT(*) as total FROM audit_logs ${whereSql}`).bind(...binds).first<{ total: number }>();
  const total = Number(countRow?.total || 0);

  const res = await env.DB.prepare(`
    SELECT * FROM audit_logs ${whereSql}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...binds, limit, offset).all<AuditLogRow>();

  return {
    items: (res.results || []) as unknown as AuditLogRow[],
    total,
  };
}


export async function createConfigSnapshot(
  env: Env,
  name: string,
  description?: string
): Promise<ConfigSnapshotRow> {
  await ensureSchema(env);
  const id = newId("snap");
  const t = now();

  const [providers, models, budgetCfg, webhookCfg, ipWhitelistCfg] = await Promise.all([
    listProviders(env),
    listModels(env),
    getSetting(env, "budget_config"),
    getSetting(env, "webhook_config"),
    getSetting(env, "ip_whitelist_config"),
  ]);

  const sealedProviders = await Promise.all(
    providers.map(async (p) => ({
      ...p,
      api_key: p.api_key ? await sealSecret(p.api_key, env.ENCRYPTION_KEY) : p.api_key,
    }))
  );
  const sealedModels = await Promise.all(
    models.map(async (m) => ({
      ...m,
      provider_api_key: m.provider_api_key
        ? await sealSecret(m.provider_api_key, env.ENCRYPTION_KEY)
        : m.provider_api_key,
    }))
  );

  const sealedWebhookCfg =
    webhookCfg && typeof webhookCfg === "object" && (webhookCfg as any).secret
      ? { ...(webhookCfg as any), secret: await sealSecret((webhookCfg as any).secret, env.ENCRYPTION_KEY) }
      : webhookCfg;

  const payload = {
    exported_at: t,
    service_groups_snapshot: await snapshotServiceGroups(env),
    ...await exportModelCategories(env),
    providers: sealedProviders,
    models: sealedModels,
    settings: {
      budget_config: budgetCfg,
      webhook_config: sealedWebhookCfg,
      ip_whitelist_config: ipWhitelistCfg,
    },
  };

  const jsonStr = JSON.stringify(payload);
  const desc = description || `包含 ${providers.length} 个 Providers, ${models.length} 个 Models`;

  await env.DB.prepare(`
    INSERT INTO config_snapshots (id, name, description, snapshot_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, name.trim(), desc, jsonStr, t).run();

  return {
    id,
    name: name.trim(),
    description: desc,
    snapshot_json: jsonStr,
    created_at: t,
  };
}

export async function listConfigSnapshots(
  env: Env
): Promise<Array<Omit<ConfigSnapshotRow, "snapshot_json"> & { size_bytes: number }>> {
  await ensureSchema(env);
  const res = await env.DB.prepare(`
    SELECT id, name, description, LENGTH(snapshot_json) as size_bytes, created_at
    FROM config_snapshots
    ORDER BY created_at DESC
  `).all<any>();
  return (res.results || []) as any;
}

export async function getConfigSnapshot(env: Env, id: string): Promise<ConfigSnapshotRow | null> {
  await ensureSchema(env);
  return (await env.DB.prepare("SELECT * FROM config_snapshots WHERE id = ?").bind(id).first<ConfigSnapshotRow>()) || null;
}

export async function deleteConfigSnapshot(env: Env, id: string): Promise<boolean> {
  await ensureSchema(env);
  const res = await env.DB.prepare("DELETE FROM config_snapshots WHERE id = ?").bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function restoreConfigSnapshot(env: Env, snapshotId: string): Promise<{ success: boolean; message: string }> {
  await ensureSchema(env);
  const snap = await getConfigSnapshot(env, snapshotId);
  if (!snap) return { success: false, message: "未找到指定的配置快照" };

  try {
    const data = JSON.parse(snap.snapshot_json);
    if (data.service_groups_snapshot !== undefined) validateServiceGroupsSnapshot(data.service_groups_snapshot);
    validateModelCategoriesBackup(data);
    const providerIdMap = new Map<string, string>();
    const modelIdMap = new Map<string, string>();
    await createConfigSnapshot(env, `回滚前自动备份 (${new Date().toISOString().slice(0, 19)})`, `在恢复快照「${snap.name}」前自动创建的安全快照`);

    if (Array.isArray(data.providers)) {
      for (const p of data.providers) {
        const existing = await getProvider(env, p.id);
        if (existing) {
          providerIdMap.set(p.id, p.id);
          await updateProvider(env, p.id, {
            name: p.name,
            type: p.type,
            endpoint: p.endpoint,
            api_key: p.api_key,
            secret_name: p.secret_name,
            enabled: Boolean(p.enabled),
            config_json: p.config_json,
          });
        } else {
          const created = await createProvider(env, {
            name: p.name,
            type: p.type,
            endpoint: p.endpoint,
            api_key: p.api_key,
            secret_name: p.secret_name,
            enabled: Boolean(p.enabled),
            config_json: p.config_json,
          });
          providerIdMap.set(p.id, created.id);
        }
      }
    }

    if (Array.isArray(data.models)) {
      for (const m of data.models) {
        const existing = await getModel(env, m.id);
        if (existing) {
          modelIdMap.set(m.id, m.id);
          await updateModel(env, m.id, {
            provider_id: providerIdMap.get(m.provider_id) ?? m.provider_id,
            model_name: m.model_name,
            display_name: m.display_name,
            alias: m.alias,
            fallback_model_id: null,  
            input_price_per_m: m.input_price_per_m,
            output_price_per_m: m.output_price_per_m,
            cache_read_price_per_m: m.cache_read_price_per_m,
            cache_write_price_per_m: m.cache_write_price_per_m,
            search_price_per_call: m.search_price_per_call,
            price_per_call: m.price_per_call,
            billing_unit: m.billing_unit,
            pricing_mode: m.pricing_mode,
            model_public: Boolean(m.model_public),
            peak_pricing_enabled: Boolean(m.peak_pricing_enabled),
            cache_enabled: m.cache_enabled,
            cache_ttl: m.cache_ttl,
            enabled: Boolean(m.enabled),
            config_json: m.config_json,
          });
        } else {
          const created = await createModel(env, {
            provider_id: providerIdMap.get(m.provider_id) ?? m.provider_id,
            model_name: m.model_name,
            display_name: m.display_name,
            alias: m.alias,
            fallback_model_id: null,  
            input_price_per_m: m.input_price_per_m,
            output_price_per_m: m.output_price_per_m,
            cache_read_price_per_m: m.cache_read_price_per_m,
            cache_write_price_per_m: m.cache_write_price_per_m,
            search_price_per_call: m.search_price_per_call,
            price_per_call: m.price_per_call,
            billing_unit: m.billing_unit,
            pricing_mode: m.pricing_mode,
            model_public: Boolean(m.model_public),
            peak_pricing_enabled: Boolean(m.peak_pricing_enabled),
            cache_enabled: m.cache_enabled,
            cache_ttl: m.cache_ttl,
            enabled: Boolean(m.enabled),
            config_json: m.config_json,
          });
          modelIdMap.set(m.id, created.id);
        }
      }
      for (const m of data.models) {
        await updateModel(env, modelIdMap.get(m.id) ?? m.id, { fallback_model_id: m.fallback_model_id ? modelIdMap.get(m.fallback_model_id) ?? m.fallback_model_id : null });
      }
    }
    if (data.service_groups_snapshot !== undefined) {
      await ensureModelCategoriesSchema(env);
      await restoreServiceGroupsSnapshot(env, data.service_groups_snapshot, modelIdMap, restoreModelCategoriesStatements(env,data));
    } else if (validateModelCategoriesBackup(data) !== undefined) {
      await ensureModelCategoriesSchema(env);
      await env.DB.batch(restoreModelCategoriesStatements(env,data));
    }

    if (data.settings) {
      if (data.settings.budget_config) await setSetting(env, "budget_config", data.settings.budget_config);
      if (data.settings.webhook_config) {
        const cfg = data.settings.webhook_config as Record<string, any>;
        const secret = cfg && typeof cfg === "object" && cfg.secret ? await openSecret(cfg.secret, env.ENCRYPTION_KEY) : null;
        await setSetting(env, "webhook_config", cfg && typeof cfg === "object" && secret ? { ...cfg, secret } : cfg);
      }
      if (data.settings.ip_whitelist_config) await setSetting(env, "ip_whitelist_config", data.settings.ip_whitelist_config);
    }

    return { success: true, message: `已成功回滚至快照「${snap.name}」` };
  } catch (err: any) {
    return { success: false, message: `快照解析或恢复失败: ${err.message}` };
  }
}


export async function getKeyRotationReport(env: Env, recommendedDays = 90): Promise<KeyRotationReport> {
  await ensureSchema(env);
  const [providers, devices] = await Promise.all([
    listProviders(env),
    listDevices(env),
  ]);

  const nowMs = Date.now();
  const DAY_MS = 86400000;
  const items: KeyRotationItem[] = [];

  for (const p of providers) {
    const keyRefTime = p.updated_at || p.created_at || nowMs;
    const ageDays = Math.max(0, Math.floor((nowMs - keyRefTime) / DAY_MS));
    const status: "fresh" | "expiring_soon" | "expired" =
      ageDays >= recommendedDays ? "expired" : ageDays >= recommendedDays - 30 ? "expiring_soon" : "fresh";
    const keyHint = p.api_key ? `sk-...${p.api_key.slice(-4)}` : p.secret_name ? `Env: ${p.secret_name}` : "未配置";

    items.push({
      id: p.id,
      name: `[Provider] ${p.name}`,
      type: "provider",
      key_hint: keyHint,
      created_at: p.created_at,
      updated_at: p.updated_at,
      age_days: ageDays,
      status,
      recommendation:
        status === "expired"
          ? `已使用 ${ageDays} 天，超过推荐的 ${recommendedDays} 天轮转周期，建议立即更换！`
          : status === "expiring_soon"
          ? `已使用 ${ageDays} 天，接近 ${recommendedDays} 天轮转周期，建议计划轮换。`
          : `密钥状态良好（已使用 ${ageDays} 天）。`,
    });
  }

  for (const d of devices) {
    if (d.revoked_at) continue;
    const refTime = d.created_at || nowMs;
    const ageDays = Math.max(0, Math.floor((nowMs - refTime) / DAY_MS));
    const status: "fresh" | "expiring_soon" | "expired" =
      ageDays >= recommendedDays ? "expired" : ageDays >= recommendedDays - 30 ? "expiring_soon" : "fresh";

    items.push({
      id: d.id,
      name: `[Device Token] ${d.name}`,
      type: "device",
      key_hint: `token_hash_${d.id.slice(0, 8)}`,
      created_at: d.created_at,
      age_days: ageDays,
      status,
      recommendation:
        status === "expired"
          ? `Token 已签发 ${ageDays} 天，建议重新签发并撤销旧 Token。`
          : status === "expiring_soon"
          ? `Token 已签发 ${ageDays} 天，建议在近期计划轮转。`
          : `Token 状态良好（已使用 ${ageDays} 天）。`,
    });
  }

  items.sort((a, b) => b.age_days - a.age_days);

  return {
    recommended_rotation_days: recommendedDays,
    fresh_count: items.filter((i) => i.status === "fresh").length,
    expiring_soon_count: items.filter((i) => i.status === "expiring_soon").length,
    expired_count: items.filter((i) => i.status === "expired").length,
    items,
  };
}

