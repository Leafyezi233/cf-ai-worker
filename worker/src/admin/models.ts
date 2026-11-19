import { deleteUnreferencedTargets, updateModelPreservingReferences, ModelRenameReferenceError } from "../db/model_references";
import { Hono } from "hono";
import { videoModelError } from "../gateway/video_config";
import { resolveModelType, type ModelTypeInput } from "../gateway/model_type";
import type { Env } from "../types";
import { exportPrices } from "./price-export";
import { protocolProbesApp } from "./protocol-probes";
import {
  createModel,
  isModelKeyTaken,
  listModels,
  listGroupsForDevice,
  updateModel,
  getProvider,
  batchUpdateModels,
  getModel,
  listPriceWindows,
  replacePriceWindows,
  PEAK_PRICING_DAY_TYPES,
  PEAK_PRICING_GROUPS,
  PEAK_PRICING_WEEKEND_DAYS,
  PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES,
} from "../db/repo";
import { buildModelCatalog } from "../gateway/catalog";
import { resolveReasoningSupport, anthropicThinkingBudget } from "../gateway/reasoning";
import { resolveProviderBase } from "../gateway/endpoints";
import { parseRewriteRules } from "../gateway/rewrite";
import { buildUpstreamHeaders } from "../utils/http";
import { readConnectionSet } from "../gateway/protocol_connections";

import {
  CreateModelSchema,
  UpdateModelSchema,
  BatchCreateModelsSchema,
  BatchUpdateModelsSchema,
  BatchDeleteModelsSchema,
  zValidator,
  PriceWindowsSchema,
  priceWindowMinutes,
} from "./schemas";

type EmbeddingAdminRow = ModelTypeInput & {
  input_price_per_m?: number; output_price_per_m?: number; cache_read_price_per_m?: number; cache_write_price_per_m?: number;
  price_per_call?: number; search_price_per_call?: number; cache_enabled?: boolean | number;
};

function embeddingModelError(row: EmbeddingAdminRow, providerType: string): string | null {
  const videoError = videoModelError({ ...row, provider_type: providerType });
  if (videoError) return videoError;
  if (resolveModelType(row) !== "embedding") return null;
  if ((row.billing_unit ?? "token") !== "token") return "embedding_token_billing_required";
  if (providerType !== "openai") return "embedding_openai_provider_required";
  if ([row.output_price_per_m, row.cache_read_price_per_m, row.cache_write_price_per_m,
    row.price_per_call, row.search_price_per_call].some(price => (price ?? 0) !== 0)) return "embedding_input_only_pricing_required";
  if (row.cache_enabled) return "embedding_response_cache_not_supported";
  return null;
}

export const modelsApp = new Hono<{ Bindings: Env }>();

modelsApp.route("/protocol-probes", protocolProbesApp);

modelsApp.get("/", async (c) => {
  const items = await listModels(c.env, { includeSecrets: false, adminProjection: true });
  return c.json({ items });
});

modelsApp.get("/prices/export", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const payload = await exportPrices(c.env);
    return new Response(JSON.stringify(payload, null, 2), { headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="cpg-prices.json"',
      "Cache-Control": "no-store",
    } });
  } catch {
    return c.json({ error: "price_export_unavailable" }, 503);
  }
});

modelsApp.get("/catalog", async (c) => {
  const [models, groups] = await Promise.all([
    listModels(c.env, { includeSecrets: false }),
    listGroupsForDevice(c.env, null, { includePrivate: true }),
  ]);
  const catalog = buildModelCatalog([...models, ...groups]);
  return c.json(catalog);
});

modelsApp.get("/catalog/export", async (c) => {
  const [models, groups] = await Promise.all([
    listModels(c.env, { includeSecrets: false }),
    listGroupsForDevice(c.env, null, { includePrivate: true }),
  ]);
  const catalog = buildModelCatalog([...models, ...groups]);
  const json = JSON.stringify(catalog, null, 2);
  return new Response(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="model-catalog.json"',
    },
  });
});

modelsApp.post("/", zValidator("json", CreateModelSchema), async (c) => {
  const data = c.req.valid("json");
  const provider = await getProvider(c.env, data.provider_id);
  if (!provider) return c.json({ error: "provider_not_found" }, 400);
  const embeddingError = embeddingModelError(data, provider.type);
  if (embeddingError) return c.json({ error: embeddingError }, 400);
  const alias = data.alias ? data.alias.trim() : "";
  for (const candidate of [data.model_name.trim(), alias]) {
    if (!candidate) continue;
    const taken = await isModelKeyTaken(c.env, candidate);
    if (taken === "group") return c.json({ error: "name_conflicts_with_group", name: candidate }, 400);
  }
  const row = await createModel(c.env, {
    provider_id: data.provider_id,
    model_name: data.model_name.trim(),
    display_name: data.display_name ? data.display_name.trim() : undefined,
    alias: data.alias ? data.alias.trim() : undefined,
    fallback_model_id: data.fallback_model_id ? data.fallback_model_id.trim() : undefined,
    input_price_per_m: data.input_price_per_m,
    output_price_per_m: data.output_price_per_m,
    cache_read_price_per_m: data.cache_read_price_per_m,
    cache_write_price_per_m: data.cache_write_price_per_m,
    pricing_mode: data.pricing_mode,
    peak_pricing_enabled: data.peak_pricing_enabled,
    billing_unit: data.billing_unit,
    price_per_call: data.price_per_call,
    search_price_per_call: data.search_price_per_call,
    cache_enabled: data.cache_enabled,
    cache_ttl: data.cache_ttl,
    enabled: data.enabled,
    model_public: data.model_public,
    config_json: data.config_json ? data.config_json.trim() : undefined,
  });
  return c.json({ item: row }, 201);
});

modelsApp.post("/batch", zValidator("json", BatchCreateModelsSchema), async (c) => {
  const data = c.req.valid("json");
  const provider = await getProvider(c.env, data.provider_id);
  if (!provider) return c.json({ error: "provider_not_found" }, 400);

  for (const m of data.models) {
    const candidates =
      typeof m === "string" ? [m] : [m.model_name, m.alias ?? ""];
    for (const raw of candidates) {
      const candidate = raw.trim();
      if (!candidate) continue;
      const taken = await isModelKeyTaken(c.env, candidate);
      if (taken === "group") {
        return c.json({ error: "name_conflicts_with_group", name: candidate }, 400);
      }
    }
  }

  const created = [];
  for (const m of data.models) {
    const name = typeof m === "string" ? m : m.model_name;
    if (!name || typeof name !== "string") continue;
    const row = await createModel(c.env, {
      provider_id: data.provider_id,
      model_name: name.trim(),
      display_name: typeof m === "object" && m.display_name ? m.display_name.trim() : undefined,
      alias: typeof m === "object" && m.alias ? m.alias.trim() : undefined,
      cache_enabled: false,
      cache_ttl: 3600,
      enabled: true,
    });
    created.push(row);
  }
  return c.json({ created: created.length, items: created }, 201);
});

modelsApp.post("/batch-update", zValidator("json", BatchUpdateModelsSchema), async (c) => {
  const data = c.req.valid("json");
  const models = await listModels(c.env, { includeSecrets: false });
  const ids = new Set(data.ids);
  for (const model of models) {
    if (!ids.has(model.id)) continue;
    const effective = { ...model, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) };
    const error = embeddingModelError(effective, model.provider_type);
    if (error) return c.json({ error }, 400);
  }
  const count = await batchUpdateModels(c.env, data.ids, {
    enabled: data.enabled,
    cache_enabled: data.cache_enabled,
    cache_ttl: data.cache_ttl,
    model_public: data.model_public,
    pricing_mode: data.pricing_mode,
    peak_pricing_enabled: data.peak_pricing_enabled,
  });
  return c.json({ updated: count });
});

modelsApp.post("/batch-delete", zValidator("json", BatchDeleteModelsSchema), async (c) => {
  const data = c.req.valid("json");
  const result = await deleteUnreferencedTargets(c.env, "model", data.ids);
  if (result.references.length) return c.json({ error: "model_in_use", references: result.references, actions: ["migrate_references", "disable", "cancel"] }, 409);
  return c.json({ deleted: result.deleted });
});

modelsApp.put("/:id", zValidator("json", UpdateModelSchema), async (c) => {
  const id = c.req.param("id");
  const data = c.req.valid("json");
  const current = await getModel(c.env, id);
  if (!current) return c.json({ error: "not_found" }, 404);
  const effective = { ...current, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) };
  if (data.provider_id || ["embedding", "video"].includes(resolveModelType(effective))) {
    const provider = await getProvider(c.env, data.provider_id ?? current.provider_id);
    if (!provider) return c.json({ error: "provider_not_found" }, 400);
    const error = embeddingModelError(effective, provider.type);
    if (error) return c.json({ error }, 400);
  }
  if (data.model_name !== undefined || data.alias !== undefined) {
    const names = [data.model_name?.trim() ?? "", data.alias?.trim() ?? ""].filter(Boolean);
    for (const candidate of names) {
      const taken = await isModelKeyTaken(c.env, candidate, { modelId: id });
      if (taken === "group") return c.json({ error: "name_conflicts_with_group", name: candidate }, 400);
    }
  }
  let row;
  try {
    row = await updateModelPreservingReferences(c.env, id, {
      provider_id: data.provider_id,
      model_name: data.model_name !== undefined ? data.model_name.trim() : undefined,
      display_name: data.display_name !== undefined ? (data.display_name ? data.display_name.trim() : null) : undefined,
      alias: data.alias !== undefined ? (data.alias ? data.alias.trim() : null) : undefined,
      fallback_model_id: data.fallback_model_id !== undefined ? (data.fallback_model_id ? data.fallback_model_id.trim() : null) : undefined,
      input_price_per_m: data.input_price_per_m,
      output_price_per_m: data.output_price_per_m,
      cache_read_price_per_m: data.cache_read_price_per_m,
      cache_write_price_per_m: data.cache_write_price_per_m,
      pricing_mode: data.pricing_mode,
      peak_pricing_enabled: data.peak_pricing_enabled,
      billing_unit: data.billing_unit,
      price_per_call: data.price_per_call,
      search_price_per_call: data.search_price_per_call,
      cache_enabled: data.cache_enabled,
      cache_ttl: data.cache_ttl,
      enabled: data.enabled,
      model_public: data.model_public,
      config_json: data.config_json !== undefined ? (data.config_json ? data.config_json.trim() : null) : undefined,
    });
  } catch (error) {
    if (error instanceof ModelRenameReferenceError) return c.json({
      error: "model_rename_breaks_service_mapping", references: error.references,
      message: "保留映射使用的原名称或 alias，或先将服务映射迁移到按稳定 ID 绑定的模型组目标后再改名。",
      actions: ["keep_name_or_alias", "migrate_to_group_target", "cancel"],
    }, 409);
    throw error;
  }
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ item: row });
});

modelsApp.delete("/:id", async (c) => {
  const result = await deleteUnreferencedTargets(c.env, "model", [c.req.param("id")]);
  if (result.references.length) return c.json({ error: "model_in_use", references: result.references, actions: ["migrate_references", "disable", "cancel"] }, 409);
  if (!result.deleted) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});



modelsApp.get("/:id/price-windows", async (c) => {
  const id = c.req.param("id");
  const model = await getModel(c.env, id);
  if (!model) return c.json({ error: "not_found" }, 404);
  const items = await listPriceWindows(c.env, id);
  return c.json({
    peak_pricing_enabled: model.peak_pricing_enabled === 1,
    day_types: PEAK_PRICING_DAY_TYPES,
    groups: PEAK_PRICING_GROUPS,
    weekend_days: PEAK_PRICING_WEEKEND_DAYS,
    tz_offset_minutes: PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES,
    items,
  });
});

modelsApp.put("/:id/price-windows", zValidator("json", PriceWindowsSchema), async (c) => {
  const id = c.req.param("id");
  const data = c.req.valid("json");
  const model = await getModel(c.env, id);
  if (!model) return c.json({ error: "not_found" }, 404);
  const windows = data.windows.map((w) => {
    const minutes = priceWindowMinutes(w);
    return {
      day_type: w.day_type,
      start_minute: minutes.start_minute,
      end_minute: minutes.end_minute,
      multiplier: w.multiplier,
      enabled: w.enabled,
    };
  });
  const items = await replacePriceWindows(c.env, id, windows);
  return c.json({ items });
});


const PROBE_DEFAULT_MAX_TOKENS = 2048;
const PROBE_MAX_TOKENS_CEILING = 8192;

const ANTHROPIC_VERSION_DEFAULT = "2023-06-01";

modelsApp.post("/:id/probe-reasoning", async (c) => {
  const model = await getModel(c.env, c.req.param("id"));
  if (!model) return c.json({ error: "not_found" }, 404);
  if (resolveModelType(model) === "video") return c.json({ error: "video_reasoning_probe_not_supported" }, 400);
  if (resolveModelType(model) === "embedding") return c.json({ error: "embedding_reasoning_probe_not_supported" }, 400);

  const provider = model.provider_id ? await getProvider(c.env, model.provider_id) : null;
  if (readConnectionSet({ provider_config_json: provider?.config_json }).explicit) {
    return c.json({ error: "multi_protocol_test_requires_gateway", message: "显式多协议连接请使用协议探测或网关客户端测试；旧版单模型推理探测尚不支持选择协议" }, 409);
  }
  const providerType = provider?.type || "openai";
  const providerEndpoint = provider?.endpoint || null;
  const apiKey = provider?.api_key || "";
  if (!apiKey) {
    return c.json({ error: "no_api_key", message: "该模型的服务商没有配置可用的 API Key，无法探测" }, 400);
  }

  const rawBody = (await c.req.json().catch(() => ({}))) as {
    effort?: string;
    max_tokens?: number;
    config_json?: string | null;
  };
  const effort = typeof rawBody.effort === "string" && rawBody.effort.trim() ? rawBody.effort.trim() : "low";
  const maxTokens = Math.min(
    Math.max(Math.floor(Number(rawBody.max_tokens) || PROBE_DEFAULT_MAX_TOKENS), 1024),
    PROBE_MAX_TOKENS_CEILING
  );

  const parseConfig = (raw: string | null | undefined): Record<string, any> | null => {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return null;
    }
  };
  const storedConfig = parseConfig(model.config_json);
  if (storedConfig === null) {
    return c.json({ error: "invalid_config_json", message: "该模型的 config_json 不是合法 JSON，请先在编辑页修正" }, 400);
  }
  const suppliedRaw =
    typeof rawBody.config_json === "string"
      ? rawBody.config_json.trim()
      : (model.config_json || "").trim();
  if (resolveModelType({ config_json: suppliedRaw }) === "video") return c.json({ error: "video_reasoning_probe_not_supported" }, 400);
  if (resolveModelType({ config_json: suppliedRaw }) === "embedding") return c.json({ error: "embedding_reasoning_probe_not_supported" }, 400);
  const formConfig = parseConfig(suppliedRaw);
  if (formConfig === null) {
    return c.json({ error: "invalid_config_json", message: "表单里的 config_json 不是合法 JSON，请先修正再探测" }, 400);
  }

  const base = resolveProviderBase(providerEndpoint, providerType);
  const target = providerType === "anthropic" ? base + "/messages" : base + "/chat/completions";

  const rewriteRules = parseRewriteRules(model.config_json);
  const payload: Record<string, any> = {
    model: rewriteRules.model_rewrite || model.model_name,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    max_tokens: maxTokens,
    stream: false,
  };
  if (providerType === "anthropic") {
    const budget = anthropicThinkingBudget(effort, maxTokens);
    if (budget === null) {
      return c.json({ error: "max_tokens_too_small", message: "max_tokens 太小，装不下最小思考预算" }, 400);
    }
    payload.thinking = { type: "enabled", budget_tokens: budget };
  } else {
    payload.reasoning_effort = effort;
  }

  const headers = new Headers({ "content-type": "application/json" });
  buildUpstreamHeaders(new Headers(), providerType, apiKey).forEach((value, key) => headers.set(key, value));
  if (providerType === "anthropic" && !headers.has("anthropic-version")) {
    headers.set("anthropic-version", ANTHROPIC_VERSION_DEFAULT);
  }

  const startedAt = Date.now();
  let ok = false;
  let status = 0;
  let errorText = "";
  try {
    const res = await fetch(target, { method: "POST", headers, body: JSON.stringify(payload), redirect: "follow" });
    ok = res.ok;
    status = res.status;
    const text = await res.text().catch(() => "");
    if (!ok) errorText = text.slice(0, 400);
  } catch (err: any) {
    return c.json({ error: "upstream_fetch_error", message: err?.message || "请求上游失败" }, 502);
  }
  const latencyMs = Date.now() - startedAt;
  const probedAt = Date.now();

  const REJECTS_EFFORT = new Set([400, 422]);
  const reasoningSupported: boolean | null = ok ? true : REJECTS_EFFORT.has(status) ? false : null;
  const conclusive = reasoningSupported !== null;

  const verdict = {
    reasoning_supported: reasoningSupported,
    effort,
    provider_type: providerType,
    status,
    latency_ms: latencyMs,
    at: probedAt,
    ...(ok ? {} : { error: errorText }),
  };
  let persistedConfig = model.config_json || "";
  if (conclusive) {
    persistedConfig = JSON.stringify({ ...storedConfig, probe: verdict }, null, 2);
    await updateModel(c.env, model.id, { config_json: persistedConfig });
  }

  const formConfigJson = conclusive
    ? JSON.stringify({ ...formConfig, probe: verdict }, null, 2)
    : JSON.stringify(formConfig, null, 2);

  return c.json({
    ok: true,
    reasoning_supported: reasoningSupported,
    conclusive,
    persisted: conclusive,
    effort,
    provider_type: providerType,
    status,
    latency_ms: latencyMs,
    probed_at: probedAt,
    resolved: resolveReasoningSupport({
      model_name: model.model_name,
      alias: model.alias,
      config_json: persistedConfig,
      provider_type: providerType,
    }),
    config_json: formConfigJson,
    error: ok ? null : errorText,
  });
});

