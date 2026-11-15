
import type { Context } from "hono";
import type { DeviceRow, Env } from "../types";
import { optionalDeviceAuth } from "./auth";
import { isModelInScope, getDeviceModelIds, resolveModelKey, getDeviceGroupIds, listModelProjectionsForDevice, projectGroup } from "../db/repo";
import { inferModelCapabilities, preferredModelEndpoint } from "./catalog";
import { readModelConfig, resolveModelMetadata } from "./model_metadata";
import { resolveModelType } from "./model_type";
import { publicVideoLimits } from "./video_config";
import { resolveProtocolMetadata } from "./protocol_metadata";
import { planServiceRoutes } from "./service_groups";
import { HTTPException } from "hono/http-exception";

async function deviceWhitelist(env: Env, device: DeviceRow): Promise<Set<string>> {
  if ((device.model_scope || "all") === "all") return new Set<string>();
  return new Set(await getDeviceModelIds(env, device.id));
}

export async function listModelsHandler(c: Context<{ Bindings: Env }>) {
  const device = await optionalDeviceAuth(c);
  const rows = await listModelProjectionsForDevice(c.env, device);

  const data: any[] = [];
  const seenIds = new Set<string>();

  for (const r of rows as any[]) {
    const created = r.created_at ? Math.floor(r.created_at / 1000) : 0;
    const customConfig = readModelConfig(r.config_json);
    const metadata = resolveModelMetadata(r);
    const capabilities: string[] =
      Array.isArray(customConfig.capabilities) && customConfig.capabilities.length
        ? customConfig.capabilities.filter((cap): cap is string => typeof cap === "string")
        : inferModelCapabilities(r.model_name);
    if (r.is_group && metadata.supports_reasoning && !capabilities.includes("reasoning")) {
      capabilities.push("reasoning");
    }

    const makeEntry = (id: string) => ({
      id,
      object: "model",
      created,
      owned_by: resolveModelType(r) === "video" ? "system" : r.owned_by || "system",
      permission: [
        {
          id: `modelperm-${id}`,
          object: "model_permission",
          created,
          allow_create_engine: false,
          allow_sampling: true,
          allow_logprobs: true,
          allow_search_indices: false,
          allow_view: true,
          allow_fine_tuning: false,
          organization: "*",
          group: null,
          is_blocking: false,
        },
      ],
      root: id,
      parent: null,
      display_name: r.display_name || null,
      alias: r.alias || null,
      fallback_model_id: resolveModelType(r) === "video" ? null : r.fallback_model_id || null,
      input_price_per_m: r.input_price_per_m || 0,
      output_price_per_m: r.output_price_per_m || 0,
      capabilities,
      ...metadata,
      model_type: resolveModelType(r),
      video: publicVideoLimits(r),
      chat_endpoint: preferredModelEndpoint(r),
      billing_unit: r.billing_unit === "call" ? "call" : "token",
      price_per_call: r.price_per_call || 0,
      protocol_capabilities: resolveProtocolMetadata(r),
      contextWindow: metadata.context_window,
      maxTokens: metadata.max_output_tokens,
    });

    if (r.model_name && !seenIds.has(r.model_name)) {
      seenIds.add(r.model_name);
      data.push(makeEntry(r.model_name));
    }
    if (r.alias && !seenIds.has(r.alias)) {
      seenIds.add(r.alias);
      data.push(makeEntry(r.alias));
    }
  }

  return c.json({ object: "list", data });
}

export async function getModelHandler(c: Context<{ Bindings: Env }>) {
  const modelId = c.req.param("model");
  if (!modelId) return c.json({ error: "model_not_found" }, 404);

  const device = await optionalDeviceAuth(c);
  const selectedServiceId = device?.service_group_id ?? device?.default_service_group_id;
  const serviceSelected = !!device?.token_routing_policy || (selectedServiceId != null && selectedServiceId !== "legacy");
  const target = serviceSelected ? { kind: "none" as const } : await resolveModelKey(c.env, modelId);
  let serviceRow = null;
  if (serviceSelected) {
    const catalogue = await listModelProjectionsForDevice(c.env, device, { includeHidden: true });
    serviceRow = catalogue.find(row => row.model_name === modelId || row.alias === modelId) ?? null;
    if (!serviceRow) {
      try {
        const route = (await planServiceRoutes(c.env, device, modelId))[0];
        serviceRow = catalogue.find(row => row.model_name === route?.mapping.model_key) ?? null;
      } catch (error) { if (!(error instanceof HTTPException)) throw error; }
    }
  }
  const row = serviceSelected ? serviceRow :
    target.kind === "group"
      ? projectGroup(target.group, target.members[0]?.provider_type || "openai", target.members.length, target.members)
      : target.kind === "model"
        ? target.candidates[0]
        : null;
  if (
    !row ||
    (!row.model_public && !device) ||
    (device && !serviceSelected &&
      !isModelInScope(
        device.model_scope,
        row.id,
        target.kind === "group" ? new Set(await getDeviceGroupIds(c.env, device.id)) : await deviceWhitelist(c.env, device),
        Boolean(row.model_public)
      ))
  ) {
    return c.json(
      {
        error: {
          message: `The model '${modelId}' does not exist`,
          type: "invalid_request_error",
          param: "model",
          code: "model_not_found",
        },
      },
      404
    );
  }

  const metadata = resolveModelMetadata(row);
  const customConfig = readModelConfig(row.config_json);
  const capabilities: string[] =
    Array.isArray(customConfig.capabilities) && customConfig.capabilities.length
      ? customConfig.capabilities.filter((cap): cap is string => typeof cap === "string")
      : inferModelCapabilities(row.model_name);

  if (("is_group" in row && row.is_group) && metadata.supports_reasoning && !capabilities.includes("reasoning")) {
    capabilities.push("reasoning");
  }

  const created = row.created_at ? Math.floor(row.created_at / 1000) : 0;
  return c.json({
    id: modelId,
    object: "model",
    created,
    owned_by: resolveModelType(row) === "video" || ("is_group" in row && row.is_group) ? "system" : row.provider_name || row.provider_type || "system",
    permission: [
      {
        id: `modelperm-${modelId}`,
        object: "model_permission",
        created,
        allow_create_engine: false,
        allow_sampling: true,
        allow_logprobs: true,
        allow_search_indices: false,
        allow_view: true,
        allow_fine_tuning: false,
        organization: "*",
        group: null,
        is_blocking: false,
      },
    ],
    root: modelId,
    parent: null,
    display_name: row.display_name || null,
    alias: row.alias || null,
    fallback_model_id: resolveModelType(row) === "video" ? null : row.fallback_model_id || null,
    input_price_per_m: row.input_price_per_m || 0,
    output_price_per_m: row.output_price_per_m || 0,
    capabilities,
    ...metadata,
    model_type: resolveModelType(row),
    video: publicVideoLimits(row),
    chat_endpoint: preferredModelEndpoint(row),
    billing_unit: row.billing_unit === "call" ? "call" : "token",
    price_per_call: row.price_per_call || 0,
    protocol_capabilities: resolveProtocolMetadata(row),
    contextWindow: metadata.context_window,
    maxTokens: metadata.max_output_tokens,
  });
}

export async function listOllamaTagsHandler(c: Context<{ Bindings: Env }>) {
  const device = await optionalDeviceAuth(c);
  const res = { results: await listModelProjectionsForDevice(c.env, device) };

  const models: any[] = [];
  const seen = new Set<string>();

  for (const r of (res.results || []) as any[]) {
    const names = [r.alias, r.model_name].filter(Boolean);
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      models.push({
        name,
        model: name,
        modified_at: new Date(r.created_at || Date.now()).toISOString(),
        size: 0,
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        details: {
          format: "custom",
          family: resolveModelType(r) === "video" ? "ai" : r.owned_by || "ai",
          families: [resolveModelType(r) === "video" ? "ai" : r.owned_by || "ai"],
          parameter_size: "unknown",
          quantization_level: "none",
        },
      });
    }
  }

  return c.json({ models });
}