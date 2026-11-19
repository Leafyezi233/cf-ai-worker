import type { AuthedDevice, Env, ServiceGroupRow } from "../types";
import type { ModelProjectionRow } from "../db/repo";
import { listModelsForDevice, listGroupsForDevice, listPriceWindowsForModels, pickPriceSnapshot, PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES } from "../db/repo";
import { ensureSchema } from "../db/schema";
import { projectServiceModelsForGroups } from "../gateway/service_groups";
import { resolveRowPricingMode } from "../gateway/pricing";
import { isRawCatalogVisible } from "../gateway/catalog_visibility";
import { resolveModelMetadata } from "../gateway/model_metadata";
import { resolveModelType } from "../gateway/model_type";
import { preferredModelEndpoint } from "../gateway/catalog";
import { publicVideoLimits, publicVideoPricing } from "../gateway/video_config";
import { resolveProtocolMetadata } from "../gateway/protocol_metadata";

type PriceBands = Awaited<ReturnType<typeof listPriceWindowsForModels>>;

export function serializeConsoleModel(m: ModelProjectionRow, bandsByModel: PriceBands, nowMs: number, tzOffsetMinutes: number, videoService = { multiplier: 1, scalarOverride: false }) {
  const metadata = resolveModelMetadata(m);
  const protocol = resolveProtocolMetadata(m);
  const priced = (m.pricing_mode || "unset") === "priced";
  const peakEnabled = Number(m.peak_pricing_enabled || 0) === 1;
  const bands = peakEnabled && priced ? bandsByModel.get(m.id) || [] : [];
  const snapshot = pickPriceSnapshot(bands, nowMs, tzOffsetMinutes);
  const videoPricing = publicVideoPricing(m, videoService.multiplier, snapshot.multiplier, videoService.scalarOverride);
  let cfgDesc: string | null = null;
  if (m.is_group) {
    const d = typeof m.description === "string" ? m.description.trim() : "";
    cfgDesc = d ? d.slice(0, 200) : null;
  } else {
    try {
      const cfgObj = m.config_json ? JSON.parse(m.config_json) : null;
      const d = cfgObj && typeof cfgObj.description === "string" ? cfgObj.description.trim() : "";
      cfgDesc = d ? d.slice(0, 200) : null;
    } catch {}
}
return {
  id: m.id,
  model_name: m.model_name,
  display_name: m.display_name || null,
  description: cfgDesc,
  alias: m.alias || null,
  input_price_per_m: m.input_price_per_m || 0,
  output_price_per_m: m.output_price_per_m || 0,
  cache_read_price_per_m: m.cache_read_price_per_m || 0,
  cache_write_price_per_m: m.cache_write_price_per_m || 0,
  model_type: resolveModelType(m),
  video: publicVideoLimits(m),
  video_pricing: videoPricing,
  billing_unit: (m as { billing_unit?: string }).billing_unit === "call" ? "call" : "token",
  price_per_call: (m as { price_per_call?: number }).price_per_call || 0,
  search_price_per_call: (m as { search_price_per_call?: number }).search_price_per_call || 0,
  chat_endpoint: videoPricing?.endpoint ?? preferredModelEndpoint(m),
  ...metadata,
  protocol_capabilities: { supported_endpoints: videoPricing ? [videoPricing.endpoint] : [...protocol.supported_endpoints] },
  peak_pricing_enabled: peakEnabled && priced,
  peak_pricing_tz_offset_minutes: tzOffsetMinutes,
  current_price_multiplier: snapshot.multiplier,
  current_price_window_id: snapshot.window_id,
  price_windows: bands.filter((w) => w.enabled !== 0).map((w) => ({
    id: w.id,
    day_type: w.day_type,
    start_minute: w.start_minute,
    end_minute: w.end_minute,
    multiplier: Number(w.multiplier) || 0,
  })),
};
}

export async function modelMarketplace(env: Env, device: AuthedDevice) {
  await ensureSchema(env);
  const selectedId = device.service_group_id ?? device.default_service_group_id ?? null;
  const policy = device.token_routing_policy?.policy;
  const inferredMode = selectedId === "auto" ? "auto" : selectedId === "legacy" || selectedId === null ? "legacy" : "fixed";
  const routingMode = policy?.mode ?? inferredMode;
  const currentId = routingMode === "fixed" ? policy?.group_ids[0] ?? selectedId : null;
  const result = await env.DB.prepare(
    "SELECT g.* FROM service_groups g WHERE g.enabled = 1 AND (g.selectable = 1 OR g.id = ?) " +
    "AND (g.public_selectable = 1 OR EXISTS (SELECT 1 FROM device_service_groups d " +
    "WHERE d.device_id = ? AND d.service_group_id = g.id)) ORDER BY g.name, g.id"
  ).bind(currentId, device.id).all<ServiceGroupRow>();
  const [catalogues, legacy] = await Promise.all([
    projectServiceModelsForGroups(env, device, result.results || []),
    selectedId === null || selectedId === "auto" || selectedId === "legacy"
      ? Promise.all([listModelsForDevice(env, device), listGroupsForDevice(env, device)])
        .then(([models, groups]): ModelProjectionRow[] => [...models, ...groups])
      : Promise.resolve([]),
  ]);
  const targetKey = (model: ModelProjectionRow) => JSON.stringify([Boolean(model.is_group), model.id]);
  const projectedNames = new Map<string, Set<string>>();
  for (const { models } of catalogues) {
    for (const model of models) {
      const key = targetKey(model);
      const names = projectedNames.get(key) || new Set<string>();
      names.add(model.model_name);
      projectedNames.set(key, names);
    }
  }
  const visibleLegacy = legacy.filter(isRawCatalogVisible).filter((model) => {
    const names = projectedNames.get(targetKey(model));
    return !names || ![...names].some((name) => name !== model.model_name);
  });
  const offers = [
    ...visibleLegacy.map((model) => ({ model, service_group_id: null as string | null, service_group_name: "旧版默认", is_current: routingMode === "legacy" })),
    ...catalogues.flatMap(({ group, models }) => models.map((model) => ({
      model, service_group_id: group.id, service_group_name: group.name, is_current: group.id === currentId,
    }))),
  ];
  const bandsByModel = await listPriceWindowsForModels(env, [...new Set(offers
    .filter(({ model }) => Number(model.peak_pricing_enabled || 0) === 1).map(({ model }) => model.id))]);
  const videoServices = new Map<string, {multiplier:number;scalarOverride:boolean}>();
  const videoGroups = new Map(catalogues.filter(({models}) => models.some(m => publicVideoPricing(m)?.endpoint === "/v1/videos")).map(({group}) => [group.id, group]));
  if (videoGroups.size) {
    const rows = await env.DB.prepare("SELECT service_group_id, model_key, pricing_json FROM service_group_models WHERE service_group_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify([...videoGroups.keys()])).all<{service_group_id:string;model_key:string;pricing_json:string|null}>();
    for (const mapping of rows.results || []) videoServices.set(JSON.stringify([mapping.service_group_id,mapping.model_key]), {
      multiplier:videoGroups.get(mapping.service_group_id)!.multiplier,scalarOverride:mapping.pricing_json != null,
    });
  }
  const nowMs = Date.now();
  const tzOffsetMinutes = PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES;
  return {
    model_scope: device.model_scope || "all",
    routing: {
      mode: routingMode,
      selection: routingMode === "auto" || routingMode === "multi" ? policy?.selection ?? null : null,
      failure_fallback: routingMode === "auto" || routingMode === "multi" ? policy?.failure_fallback ?? false : false,
      fixed_group_id: routingMode === "fixed" ? currentId : null,
      fixed_group_name: routingMode === "fixed" ? (result.results || []).find(group => group.id === currentId)?.name ?? null : null,
    },
    model_count: offers.length,
    peak_pricing_tz_offset_minutes: tzOffsetMinutes,
    items: offers.map(({ model, ...offer }) => ({
      ...serializeConsoleModel(model, bandsByModel, nowMs, tzOffsetMinutes, videoServices.get(JSON.stringify([offer.service_group_id,model.model_name]))),
      ...offer,
      pricing_mode: resolveRowPricingMode(model),
    })),
  };
}
