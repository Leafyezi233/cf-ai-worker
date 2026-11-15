import type { DeviceRow, Env, ModelWithProvider } from "../types";
import { listGroupsForDevice, listPriceWindowsForModels, pickPriceSnapshot } from "../db/repo";
import { ensureSchema } from "../db/schema";
import { listServiceGroups } from "../db/service_groups";
import { projectServiceModelsForGroups } from "../gateway/service_groups";
import { resolveRowBillingUnit, resolveRowPeakPricing, resolveRowPricingMode } from "../gateway/pricing";

export type PriceExportKind = "model" | "model_group" | "service_group";
export interface PriceExportItem {
  source_key: string;
  kind: PriceExportKind;
  model_name: string;
  group_name: string | null;
  billing_unit: "token" | "call";
  pricing_mode: "priced" | "free" | "unset";
  prices: Record<"input" | "output" | "read" | "write" | "call" | "search", string | null>;
  warnings: string[];
}

export function serializePrice(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid export price");
  if (value === 0) return "0";
  const [coefficient, exponent] = String(value).toLowerCase().split("e");
  if (exponent === undefined) return coefficient;
  const [integer, fraction = ""] = coefficient.split(".");
  const digits = integer + fraction;
  const point = integer.length + Number(exponent);
  if (point <= 0) return "0." + "0".repeat(-point) + digits;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return digits.slice(0, point) + "." + digits.slice(point);
}

const priceFields = ["input_price_per_m", "output_price_per_m", "cache_read_price_per_m",
  "cache_write_price_per_m", "price_per_call", "search_price_per_call"] as const;

function validatePrices(row: ModelWithProvider): asserts row is ModelWithProvider & Record<typeof priceFields[number], number> {
  if (resolveRowPricingMode(row) !== "priced") return;
  for (const field of priceFields) {
    const value = row[field];
    if (typeof value !== "number" || !Number.isFinite(value)
      || (value < 0 && field !== "cache_read_price_per_m" && field !== "cache_write_price_per_m")) {
      throw new Error("Invalid export price");
    }
  }
}

export function serializePriceItem(row: ModelWithProvider, kind: PriceExportKind,
  serviceGroup: { id: string; name: string } | null = null, multiplier = 1): PriceExportItem {
  const unit = resolveRowBillingUnit(row);
  const mode = resolveRowPricingMode(row);
  const prices: PriceExportItem["prices"] = { input: null, output: null, read: null, write: null, call: null, search: null };
  const warnings: string[] = [];
  if (mode === "unset") warnings.push("price_not_configured");
  else if (mode === "free") {
    if (unit === "token") prices.input = prices.output = prices.read = prices.write = "0";
    else prices.call = "0";
    prices.search = "0";
  } else {
    validatePrices(row);
    serializePrice(multiplier);
    const scaled = (value: number) => {
      const product = value * multiplier;
      if (value > 0 && multiplier > 0 && product === 0) throw new Error("Export price underflow");
      return serializePrice(product);
    };
    if (unit === "token") {
      prices.input = scaled(row.input_price_per_m);
      prices.output = scaled(row.output_price_per_m);
      prices.read = scaled(row.cache_read_price_per_m > 0 ? row.cache_read_price_per_m : row.input_price_per_m);
      prices.write = scaled(row.cache_write_price_per_m > 0 ? row.cache_write_price_per_m : row.input_price_per_m);
    } else prices.call = scaled(row.price_per_call);
    prices.search = serializePrice(row.search_price_per_call);
  }
  const name = row.alias || row.model_name;
  return { source_key: JSON.stringify([kind, row.id, serviceGroup?.id ?? null, name]), kind,
    model_name: name, group_name: serviceGroup?.name ?? (kind === "model_group" ? name : null),
    billing_unit: unit, pricing_mode: mode, prices, warnings };
}

export async function exportPrices(env: Env, nowMs = Date.now()) {
  await ensureSchema(env);
  const device: DeviceRow = { id: "price-export", name: "", token_hash: "", enabled: 1,
    rate_limit_rpm: 0, cost_limit_monthly: null, last_used_at: null, created_at: 0,
    revoked_at: null, model_scope: "all" };
  const [modelsResult, groups, services, rawGroups] = await Promise.all([
    env.DB.prepare("SELECT m.*, p.type AS provider_type FROM models m JOIN providers p ON p.id = m.provider_id " +
      "WHERE m.enabled = 1 AND p.enabled = 1 ORDER BY m.id").all<ModelWithProvider>(),
    listGroupsForDevice(env, device, { includePrivate: true }),
    listServiceGroups(env),
    env.DB.prepare("SELECT * FROM model_groups WHERE enabled = 1").all<ModelWithProvider>(),
  ]);
  for (const row of [...(modelsResult.results || []), ...(rawGroups.results || [])]) validatePrices(row);
  const enabledServices = services.filter((group) => group.enabled === 1);
  const rawModels = new Map((modelsResult.results || []).map((row) => [row.id, row]));
  const rawGroupMap = new Map((rawGroups.results || []).map((row) => [row.id, row]));
  const serviceMap = new Map(enabledServices.map((group) => [group.id, group]));
  const mappings = await env.DB.prepare("SELECT sm.service_group_id, sm.target_type, sm.target_id, sm.pricing_json " +
    "FROM service_group_models sm JOIN service_groups sg ON sg.id = sm.service_group_id WHERE sg.enabled = 1")
    .all<{ service_group_id: string; target_type: string; target_id: string; pricing_json: string | null }>();
  for (const mapping of mappings.results || []) {
    const target = (mapping.target_type === "model" ? rawModels : rawGroupMap).get(mapping.target_id);
    if (!target || resolveRowPricingMode(target) !== "priced") continue;
    if (mapping.pricing_json !== null) {
      const overrides: unknown = JSON.parse(mapping.pricing_json);
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("Invalid export price");
      for (const [key, value] of Object.entries(overrides)) {
        if ((priceFields as readonly string[]).includes(key)) serializePrice(value as number);
      }
    } else {
      const multiplier = serviceMap.get(mapping.service_group_id)!.multiplier;
      serializePrice(multiplier);
      for (const field of priceFields) {
        if (field === "search_price_per_call") continue;
        const value = target[field]!;
        if (value >= 0) serializePrice(value * multiplier);
        if (value > 0 && multiplier > 0 && value * multiplier === 0) throw new Error("Export price underflow");
      }
    }
  }
  const projected = await projectServiceModelsForGroups(env, device, enabledServices);
  const sources = [
    ...(modelsResult.results || []).map((row) => ({ row, kind: "model" as const, service: null })),
    ...groups.map((row) => ({ row, kind: "model_group" as const, service: null })),
    ...projected.flatMap(({ group, models }) => models.map((row) => ({ row, kind: "service_group" as const, service: group }))),
  ];
  const windows = await listPriceWindowsForModels(env, [...new Set(sources
    .filter(({ row }) => resolveRowPricingMode(row) === "priced" && resolveRowPeakPricing(row))
    .map(({ row }) => row.id))]);
  const items = sources.map(({ row, kind, service }) => {
    const bands = windows.get(row.id) || [];
    for (const band of bands) serializePrice(band.multiplier);
    const multiplier = resolveRowPeakPricing(row) && resolveRowPricingMode(row) === "priced"
      ? pickPriceSnapshot(bands, nowMs).multiplier : 1;
    return serializePriceItem(row, kind, service, multiplier);
  }).sort((a, b) => a.source_key < b.source_key ? -1 : a.source_key > b.source_key ? 1 : 0);
  return { format: "cpg-price-export" as const, version: 1 as const, exported_at: new Date(nowMs).toISOString(),
    currency: "CNY" as const, price_basis: "gateway_charge" as const, items };
}
