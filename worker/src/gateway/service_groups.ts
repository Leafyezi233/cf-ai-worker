import { HTTPException } from "hono/http-exception";
import type {
  DeviceRow, Env, ModelGroupRow, ModelWithProvider, ProviderType,
  ServiceGroupModelRow, ServiceGroupRow,
} from "../types";
import { canUseServiceGroup, getServiceGroup, listServiceGroupModels, listSelectableServiceGroups } from "../db/service_groups";
import { getDeviceGroupIds, getDeviceModelIds, groupBillingRow, isModelInScope, listPriceWindowsForModels, pickPriceSnapshot } from "../db/repo";
import type { ModelProjectionRow } from "../db/repo";
import { resolveRowBillingUnit, resolveRowPeakPricing, resolveRowPricingMode } from "./pricing";
import { aggregateModelMetadata } from "./model_metadata";
import { resolveModelType } from "./model_type";
import { embeddingPoolError } from "./embeddings";
import { videoModelError, publicVideoLimits } from "./video_config";
import { aggregateProtocolMetadata } from "./protocol_metadata";
import { tokenScopeAllows } from "../db/token_policies";
import { resolvePublicModelKey, resolvePublicModelKeys } from "../db/public_model_identity";

export interface ServiceRoute {
  group: ServiceGroupRow;
  mapping: ServiceGroupModelRow;
  billingRow: ModelWithProvider;
  members: ModelWithProvider[];
  targetKind: "model" | "group";
  quotaId: string;
  autoPriceSnapshot?: Readonly<{ multiplier: number; window_id: string | null }>;
}

function unavailable(): never {
  throw new HTTPException(503, { message: "Service model is currently unavailable" });
}

async function effectiveGroup(env: Env, device: DeviceRow | null): Promise<ServiceGroupRow | null> {
  const policy = device?.token_routing_policy?.policy;
  const id = policy ? (policy.mode === "fixed" ? policy.group_ids[0] : "legacy") : device?.service_group_id ?? device?.default_service_group_id;
  if (id == null || id === "legacy") return null;
  const group = await getServiceGroup(env, id);
  if (!group || group.enabled !== 1) {
    throw new HTTPException(503, { message: "Selected service group is unavailable" });
  }
  if (!device || !(await canUseServiceGroup(env, device.id, id))) {
    throw new HTTPException(403, { message: "Selected service group is not allowed" });
  }
  return group;
}

function memberIds(mapping: ServiceGroupModelRow): string[] | null {
  if (mapping.member_ids_json == null) return null;
  try {
    const ids: unknown = JSON.parse(mapping.member_ids_json);
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim())) return unavailable();
    return [...new Set(ids as string[])];
  } catch {
    return unavailable();
  }
}

const priceFields = [
  "input_price_per_m", "output_price_per_m", "cache_read_price_per_m",
  "cache_write_price_per_m", "price_per_call",
] as const;

function servicePrice(row: ModelWithProvider, group: ServiceGroupRow, mapping: ServiceGroupModelRow): ModelWithProvider {
  const priced = { ...row };
  if (resolveRowPricingMode(row) !== "priced") return priced;
  if (mapping.pricing_json != null) {
    let overrides: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(mapping.pricing_json);
      if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
      overrides = value as Record<string, unknown>;
    } catch {
      return unavailable();
    }
    for (const key of [...priceFields, "search_price_per_call"] as const) {
      if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
      const price = overrides[key];
      if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return unavailable();
      priced[key] = price;
    }
  } else {
    if (!Number.isFinite(group.multiplier) || group.multiplier < 0) return unavailable();
    for (const key of priceFields) {
      const price = (row[key] ?? 0) * group.multiplier;
      if (!Number.isFinite(price) || price < 0) return unavailable();
      priced[key] = price;
    }
  }
  return priced;
}

function family(type: ProviderType): string {
  return type === "anthropic" ? "anthropic" : "openai";
}

interface RouteData {
  models: Map<string, ModelWithProvider>;
  groups: Map<string, ModelGroupRow>;
  groupMembers: Map<string, ModelWithProvider[]>;
  modelGrants: Set<string>;
  groupGrants: Set<string>;
  identities: Map<string, string>;
  disabledIdentities: Set<string>;
}

const modelJoin = "SELECT m.*, p.name AS provider_name, p.type AS provider_type, " +
  "p.api_key AS provider_api_key, p.secret_name AS provider_secret_name, p.config_json AS provider_config_json, p.endpoint AS provider_endpoint " +
  "FROM models m JOIN providers p ON p.id = m.provider_id ";

async function batchRows<T>(env: Env, ids: string[], sql: (placeholders: string) => string): Promise<T[]> {
  const statements: D1PreparedStatement[] = [];
  const unique = [...new Set(ids)];
  for (let index = 0; index < unique.length; index += 80) {
    const chunk = unique.slice(index, index + 80);
    statements.push(env.DB.prepare(sql(chunk.map(() => "?").join(","))).bind(...chunk));
  }
  if (!statements.length) return [];
  const results = await env.DB.batch<T>(statements);
  return results.flatMap((result) => result.results || []);
}

async function loadRouteData(env: Env, device: DeviceRow, mappings: ServiceGroupModelRow[]): Promise<RouteData> {
  const targetIds = mappings.filter((m) => m.target_type === "model").map((m) => m.target_id);
  const groupIds = mappings.filter((m) => m.target_type === "group").map((m) => m.target_id);
  const explicitIds: string[] = [];
  for (const mapping of mappings) {
    try { explicitIds.push(...(memberIds(mapping) || [])); } catch (error) {
      if (!(error instanceof HTTPException)) throw error;
    }
  }
  const scope = device.model_scope || "all";
  const [models, groups, edges, modelGrants, groupGrants, identities] = await Promise.all([
    batchRows<ModelWithProvider>(env, [...targetIds, ...explicitIds], (p) =>
      modelJoin + `WHERE m.enabled = 1 AND p.enabled = 1 AND m.id IN (${p})`),
    batchRows<ModelGroupRow>(env, groupIds, (p) => `SELECT * FROM model_groups WHERE id IN (${p})`),
    batchRows<ModelWithProvider & { group_id: string }>(env, groupIds, (p) =>
      "SELECT m.*, p.name AS provider_name, p.type AS provider_type, p.api_key AS provider_api_key, " +
      "p.secret_name AS provider_secret_name, p.config_json AS provider_config_json, p.endpoint AS provider_endpoint, gm.group_id " +
      "FROM model_group_members gm JOIN models m ON m.id = gm.model_id JOIN providers p ON p.id = m.provider_id " +
      `WHERE gm.group_id IN (${p}) AND gm.enabled = 1 AND m.enabled = 1 AND p.enabled = 1 ` +
      "ORDER BY gm.group_id, gm.position ASC, m.created_at DESC"),
    scope === "all" ? Promise.resolve([]) : getDeviceModelIds(env, device.id),
    scope === "all" ? Promise.resolve([]) : getDeviceGroupIds(env, device.id),
    batchRows<{ id: string; name: string; enabled: number }>(env, mappings.map(m => m.model_key), p =>
      `SELECT id, name, enabled FROM public_model_identities WHERE name IN (${p})`),
  ]);
  const byId = new Map(models.map((row) => [row.id, row]));
  const groupMembers = new Map<string, ModelWithProvider[]>();
  for (const row of edges) {
    const members = groupMembers.get(row.group_id) || [];
    members.push(row);
    groupMembers.set(row.group_id, members);
  }
  return { models: byId, groups: new Map(groups.map((g) => [g.id, g])), groupMembers,
    modelGrants: new Set(modelGrants), groupGrants: new Set(groupGrants), identities: new Map(identities.filter(r => r.enabled === 1).map(r => [r.name, r.id])),
    disabledIdentities: new Set(identities.filter(r => r.enabled !== 1).map(r => r.name)) };
}

function buildRoute(group: ServiceGroupRow, mapping: ServiceGroupModelRow, device: DeviceRow, data: RouteData): ServiceRoute {
  if (data.disabledIdentities.has(mapping.model_key)) return unavailable();
  const original = mapping.target_type === "model" ? data.models.get(mapping.target_id)
    : mapping.target_type === "group" ? data.groups.get(mapping.target_id) : undefined;
  if (!original || original.enabled !== 1) return unavailable();
  const grants = mapping.target_type === "model" ? data.modelGrants : data.groupGrants;
  if (!isModelInScope(device.model_scope, original.id, grants, Boolean(original.model_public))) {
    throw new HTTPException(403, { message: "This device is not allowed to use that model" });
  }
  const identity = data.identities.get(mapping.model_key);
  const scopeKeys = identity ? ["public:" + identity] : [mapping.target_type + ":" + original.id];
  if (!tokenScopeAllows(device, scopeKeys)) throw new HTTPException(403, { message: "Token model scope does not allow that model" });
  const override = scopeKeys.map(key => device.token_routing_policy?.policy.model_overrides[key]).find(Boolean);
  if (override && override !== group.id) return unavailable();
  const defaults = mapping.target_type === "model"
    ? [original as ModelWithProvider]  
    : data.groupMembers.get(original.id) || [];
  const originalType = mapping.target_type === "model" ? (original as ModelWithProvider).provider_type : defaults[0]?.provider_type;
  if (!originalType) return unavailable();
  const billing = mapping.target_type === "group" ? groupBillingRow(original as ModelGroupRow, originalType)
    : { ...(original as ModelWithProvider) };
  const ids = memberIds(mapping);
  const selected = ids === null ? defaults : ids.map((id) => data.models.get(id)).filter((m): m is ModelWithProvider => m !== undefined);
  if (!selected.length) return unavailable();
  if (selected.some((member) => resolveRowBillingUnit(member) !== resolveRowBillingUnit(billing)
    || resolveModelType(member) !== resolveModelType(billing)
    )) return unavailable();
  if (resolveModelType(billing) === "embedding" && embeddingPoolError(billing, selected)) return unavailable();
  if (resolveModelType(billing) === "video" && (videoModelError(billing) || selected.some(member => videoModelError(member)))) return unavailable();
  const members = selected.map((member) => {
    let config: Record<string, unknown> = {};
    if (member.config_json) {
      try {
        const parsed: unknown = JSON.parse(member.config_json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
      } catch { return unavailable(); }
    }
    let groupRewrite: unknown;
    if (mapping.target_type === "group") {
      try { groupRewrite = JSON.parse(original.config_json || "{}").model_rewrite; } catch { return unavailable(); }
    }
    if (typeof groupRewrite === "string" && groupRewrite.trim()) config = { ...config, model_rewrite: groupRewrite };
    if (!(typeof config.model_rewrite === "string" && config.model_rewrite.trim())) {
      config = { ...config, model_rewrite: member.model_name };
    }
    return { ...member, config_json: JSON.stringify(config) };
  });
  return { group, mapping, billingRow: { ...servicePrice(billing, group, mapping), model_name: mapping.model_key, alias: null },
    members, targetKind: mapping.target_type, quotaId: original.id };
}

export function isAutoServiceSelection(device: DeviceRow | null): boolean {
  if (!device) return false;
  const policy = device.token_routing_policy?.policy;
  if (policy) return policy.mode === "auto" || policy.mode === "multi";
  const selected = device.service_group_id ?? device.default_service_group_id;
  return selected === "auto";
}

interface AutoRouteLoad {
  routes: ServiceRoute[];
  reservedKeys: Set<string>;
  blockedKeys: Set<string>;
}

async function loadAutoRoutes(env: Env, device: DeviceRow, modelKey?: string): Promise<AutoRouteLoad> {
  const policy = device.token_routing_policy?.policy;
  let groups: ServiceGroupRow[];
  if (policy?.mode === "multi") {
    const rows = await env.DB.prepare("SELECT g.*, (g.public_selectable = 1 OR EXISTS (SELECT 1 FROM device_service_groups d WHERE d.device_id = ? AND d.service_group_id = g.id)) AS policy_allowed FROM service_groups g WHERE g.id IN (" + policy.group_ids.map(() => "?").join(",") + ")")
      .bind(device.id, ...policy.group_ids).all<ServiceGroupRow & { policy_allowed: number }>();
    const byId = new Map((rows.results || []).map(g => [g.id, g]));
    groups = policy.group_ids.map(id => {
      const group = byId.get(id);
      if (!group || group.enabled !== 1) throw new HTTPException(503, { message: "Selected service group is unavailable" });
      if (!group.policy_allowed) throw new HTTPException(403, { message: "Selected service group is not allowed" });
      return group;
    });
  } else groups = await listSelectableServiceGroups(env, device.id);
  const reservedKeys = new Set<string>();
  const blockedKeys = new Set<string>();
  const groupIds = groups.map(group => group.id);
  const tombstones = await env.DB.prepare("SELECT name FROM public_model_identities WHERE enabled = 0" + (modelKey === undefined ? "" : " AND name = ?"))
    .bind(...(modelKey === undefined ? [] : [modelKey])).all<{ name: string }>();
  for (const row of tombstones.results || []) { reservedKeys.add(row.name); blockedKeys.add(row.name); }
  const resolved = modelKey === undefined ? [] : await resolvePublicModelKeys(env, groupIds, modelKey);
  for (const result of resolved) {
    if (result.reserved) reservedKeys.add(modelKey!);
    if (result.reserved && !result.mapping) blockedKeys.add(modelKey!);
  }
  const [mappings, aliases] = await Promise.all([
    modelKey === undefined
      ? batchRows<ServiceGroupModelRow>(env, groupIds, p => `SELECT * FROM service_group_models WHERE service_group_id IN (${p}) ORDER BY model_key, id`)
      : Promise.resolve(resolved.flatMap(result => result.mapping ? [result.mapping] : [])),
    modelKey === undefined
      ? batchRows<{ name: string; mapping_id: string; service_group_id: string; enabled: number }>(env, groupIds, p =>
        `SELECT name, mapping_id, service_group_id, enabled FROM service_model_aliases WHERE service_group_id IN (${p})`)
      : Promise.resolve([]),
  ]);
  const mappingById = new Map(mappings.map(mapping => [mapping.id, mapping]));
  const aliasesByMapping = new Map<string, string[]>();
  for (const mapping of mappings) reservedKeys.add(mapping.model_key);
  for (const alias of aliases) {
    reservedKeys.add(alias.name);
    const mapping = mappingById.get(alias.mapping_id);
    if (alias.enabled !== 1 || !mapping || mapping.service_group_id !== alias.service_group_id) blockedKeys.add(alias.name);
    if (mapping?.service_group_id === alias.service_group_id) {
      const names = aliasesByMapping.get(mapping.id) ?? [];
      names.push(alias.name); aliasesByMapping.set(mapping.id, names);
    }
  }
  if (!mappings.length) return { routes: [], reservedKeys, blockedKeys };
  const data = await loadRouteData(env, device, mappings);
  const byId = new Map(groups.map((group) => [group.id, group]));
  const routes: ServiceRoute[] = [];
  for (const mapping of mappings) {
    const identity = data.identities.get(mapping.model_key);
    const scopeKeys = identity ? ["public:" + identity] : [mapping.target_type + ":" + mapping.target_id];
    const override = scopeKeys.map(key => policy?.model_overrides[key]).find(Boolean);
    if (override && override !== mapping.service_group_id) continue;
    try {
      const route = buildRoute(byId.get(mapping.service_group_id)!, mapping, device, data);
      if (resolveRowPricingMode(route.billingRow) !== "unset") routes.push(route);
    } catch (error) {
      if (!(error instanceof HTTPException) || ![403, 404, 503].includes(error.status)) throw error;
      blockedKeys.add(modelKey ?? mapping.model_key);
      for (const name of aliasesByMapping.get(mapping.id) ?? []) blockedKeys.add(name);
    }
  }
  const nowMs = Date.now();
  const windows = await listPriceWindowsForModels(env, [...new Set(routes
    .filter((route) => resolveRowPricingMode(route.billingRow) === "priced" && resolveRowPeakPricing(route.billingRow))
    .map((route) => route.billingRow.id))]);
  for (const route of routes) {
    const row = route.billingRow;
    route.autoPriceSnapshot = Object.freeze(pickPriceSnapshot(
      resolveRowPricingMode(row) === "priced" && resolveRowPeakPricing(row) ? windows.get(row.id) || [] : [], nowMs));
  }
  if (policy?.selection === "ordered") {
    const position = new Map(groups.map((group, index) => [group.id, index]));
    routes.sort((a, b) => position.get(a.group.id)! - position.get(b.group.id)! || a.mapping.id.localeCompare(b.mapping.id));
  }
  return { routes: routes.filter(route => !blockedKeys.has(route.mapping.model_key)), reservedKeys, blockedKeys };
}

function autoRouteConflict(routes: ServiceRoute[], modelKey: string): string | null {
  if (new Set(routes.map((route) => resolveRowBillingUnit(route.billingRow))).size > 1) {
    return "Auto service selection is ambiguous for model " + modelKey + ": mixed token and call billing units; select a service group explicitly";
  }
  if (new Set(routes.map((route) => resolveModelType(route.billingRow))).size > 1) {
    return "Auto service selection mixes text and image models; select a service group explicitly";
  }
  return null;
}

function orderedAutoRoutes(routes: ServiceRoute[], modelKey: string, device?: DeviceRow): ServiceRoute[] {
  const conflict = autoRouteConflict(routes, modelKey);
  if (conflict) throw new HTTPException(400, { message: conflict });
  if (device?.token_routing_policy?.policy.selection === "ordered") return routes;
  const price = (route: ServiceRoute, key: "input_price_per_m" | "output_price_per_m" | "price_per_call") =>
    resolveRowPricingMode(route.billingRow) === "free" ? 0 : (route.billingRow[key] || 0) * (route.autoPriceSnapshot?.multiplier ?? 1);
  return routes.sort((a, b) =>
    (resolveRowBillingUnit(a.billingRow) === "call" ? price(a, "price_per_call") - price(b, "price_per_call")
      : price(a, "input_price_per_m") - price(b, "input_price_per_m") || price(a, "output_price_per_m") - price(b, "output_price_per_m"))
    || a.group.id.localeCompare(b.group.id) || a.mapping.id.localeCompare(b.mapping.id));
}

export async function resolveAutoServiceRoutes(env: Env, device: DeviceRow | null, modelKey: string): Promise<ServiceRoute[]> {
  if (!device || !isAutoServiceSelection(device)) return [];
  const loaded = await loadAutoRoutes(env, device, modelKey);
  if (loaded.blockedKeys.has(modelKey)) return unavailable();
  const routes = orderedAutoRoutes(loaded.routes, modelKey, device);
  if (!routes.length && (device.token_routing_policy?.policy.mode === "multi" || loaded.reservedKeys.has(modelKey))) return unavailable();
  return routes;
}

export async function resolveServiceRoute(env: Env, device: DeviceRow | null, modelKey: string): Promise<ServiceRoute | null> {
  if (isAutoServiceSelection(device)) return (await resolveAutoServiceRoutes(env, device, modelKey))[0] ?? null;
  const group = await effectiveGroup(env, device);
  if (!group) return null;
  const mapping = (await resolvePublicModelKey(env, group.id, modelKey)).mapping;
  if (!mapping) throw new HTTPException(404, { message: "Model not found in selected service group" });
  if (!device) throw new HTTPException(403, { message: "Selected service group is not allowed" });
  return buildRoute(group, mapping, device, await loadRouteData(env, device, [mapping]));
}

export async function projectServiceModels(env: Env, device: DeviceRow | null, legacyRows: ModelProjectionRow[] | (() => Promise<ModelProjectionRow[]>)): Promise<ModelProjectionRow[]> {
  if (device && isAutoServiceSelection(device)) {
    const [loaded, legacy] = await Promise.all([
      loadAutoRoutes(env, device), typeof legacyRows === "function" ? legacyRows() : Promise.resolve(legacyRows),
    ]);
    const fixedSet = device.token_routing_policy?.policy.mode === "multi";
    const configuredKeys = loaded.reservedKeys;
    const byKey = new Map<string, ServiceRoute[]>();
    for (const route of loaded.routes) {
      const offers = byKey.get(route.mapping.model_key) || [];
      offers.push(route);
      byKey.set(route.mapping.model_key, offers);
    }
    const offers = [...byKey].flatMap(([key, rows]) => {
      if (autoRouteConflict(rows, key)) return [];
      const projected = rows.map(route => projectRoute(route));
      const winner = projectRoute(orderedAutoRoutes(rows, key, device)[0], true);
      winner.model_metadata = aggregateModelMetadata({ ...winner, config_json: null }, projected);
      winner.protocol_metadata = aggregateProtocolMetadata(projected);
      return [winner];
    });
    const unshadowedLegacy = (fixedSet ? [] : filterLegacyTokenScope(device, legacy)).flatMap((row) => {
      const canonicalShadowed = configuredKeys.has(row.model_name);
      const alias = row.alias && !configuredKeys.has(row.alias) ? row.alias : null;
      if (canonicalShadowed) {
        return alias ? [{ ...row, model_name: alias, alias: null }] : [];
      }
      return [{ ...row, alias }];
    });
    return [...offers, ...unshadowedLegacy];
  }
  const group = await effectiveGroup(env, device);
  if (!group) return filterLegacyTokenScope(device, typeof legacyRows === "function" ? await legacyRows() : legacyRows);
  if (!device) throw new HTTPException(403, { message: "Selected service group is not allowed" });
  const mappings = await listServiceGroupModels(env, group.id);
  const data = await loadRouteData(env, device, mappings);
  return projectMappings(group, mappings, device, data);
}

function filterLegacyTokenScope(device: DeviceRow | null, rows: ModelProjectionRow[]): ModelProjectionRow[] {
  if (!device?.token_routing_policy?.scope_layers.length) return rows;
  return rows.filter(row => tokenScopeAllows(device, [(row.is_group ? "group:" : "model:") + row.id]));
}
export function assertLegacyTokenScope(device: DeviceRow | null, id: string, isGroup = false): void {
  if (!tokenScopeAllows(device, [(isGroup ? "group:" : "model:") + id])) {
    throw new HTTPException(403, { message: "Token model scope does not allow that model" });
  }
}
export async function planServiceRoutes(env: Env, device: DeviceRow | null, modelKey: string): Promise<ServiceRoute[]> {
  if (isAutoServiceSelection(device)) return resolveAutoServiceRoutes(env, device, modelKey);
  const route = await resolveServiceRoute(env, device, modelKey);
  return route ? [route] : [];
}

export async function projectServiceModelsForGroups(
  env: Env, device: DeviceRow, groups: ServiceGroupRow[]
): Promise<Array<{ group: ServiceGroupRow; models: ModelProjectionRow[] }>> {
  if (!groups.length) return [];
  const mappings = await batchRows<ServiceGroupModelRow>(env, groups.map((g) => g.id), (p) =>
    `SELECT * FROM service_group_models WHERE service_group_id IN (${p}) ORDER BY model_key, id`);
  const data = await loadRouteData(env, device, mappings);
  const byGroup = new Map<string, ServiceGroupModelRow[]>();
  for (const mapping of mappings) {
    const rows = byGroup.get(mapping.service_group_id) || [];
    rows.push(mapping);
    byGroup.set(mapping.service_group_id, rows);
  }
  return groups.map((group) => ({ group, models: projectMappings(group, byGroup.get(group.id) || [], device, data) }));
}

function projectRoute(route: ServiceRoute, auto = false): ModelProjectionRow {
  const modelType = resolveModelType(route.billingRow);
  const publicConfig = modelType === "text" && resolveRowBillingUnit(route.billingRow) === "token" ? null
    : JSON.stringify({ model_type: modelType, ...(modelType === "video" ? { video: publicVideoLimits(route.billingRow) } : {}) });
  return { ...route.billingRow, display_name: route.mapping.model_key, provider_id: "", provider_name: "",
    provider_api_key: null, provider_secret_name: null, provider_endpoint: null, provider_config_json: null, fallback_model_id: null,
    config_json: auto ? publicConfig : route.billingRow.config_json, is_group: route.targetKind === "group", member_count: route.members.length,
    model_metadata: aggregateModelMetadata({ ...route.billingRow, is_group: route.targetKind === "group" }, route.members),
    protocol_metadata: aggregateProtocolMetadata(route.members) };
}

function projectMappings(group: ServiceGroupRow, mappings: ServiceGroupModelRow[], device: DeviceRow, data: RouteData): ModelProjectionRow[] {
  const projected: ModelProjectionRow[] = [];
  for (const mapping of mappings) {
    try {
      const route = buildRoute(group, mapping, device, data);
      projected.push(projectRoute(route));
    } catch (error) {
      if (!(error instanceof HTTPException) || ![403, 404, 503].includes(error.status)) throw error;
    }
  }
  return projected;
}
