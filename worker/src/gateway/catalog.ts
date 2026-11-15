import type { ModelRow } from "../types";
import { catalogTemplate } from "./catalog_template";
import { isReasoningModel } from "./reasoning";
import { inferContextWindow, readModelConfig, resolveModelMetadata } from "./model_metadata";
import type { ModelMetadata, ModelMetadataInput } from "./model_metadata";
import { resolveModelType } from "./model_type";
import { resolveProtocolMetadata } from "./protocol_metadata";
import type { ProtocolMetadata, ProtocolMetadataInput } from "./protocol_metadata";
export { inferContextWindow } from "./model_metadata";

export { isReasoningModel };

export interface ModelCatalogEntry extends ModelMetadata {
  protocol_capabilities?: ProtocolMetadata;
  additional_speed_tiers: any[];
  apply_patch_tool_type: string;
  availability_nux: any;
  base_instructions: string;
  context_window: number;
  default_reasoning_level: string | null;
  default_reasoning_summary: string;
  default_verbosity: string;
  description: string;
  display_name: string;
  effective_context_window_percent: number;
  experimental_supported_tools: any[];
  input_modalities: string[];
  max_context_window: number;
  model_messages: {
    instructions_template: string;
    instructions_variables: {
      personality_default: string;
      personality_friendly: string;
      personality_pragmatic: string;
    };
  };
  priority: number;
  service_tiers: any[];
  shell_type: string;
  slug: string;
  support_verbosity: boolean;
  supported_in_api: boolean;
  supported_reasoning_levels: Array<{ description: string; effort: string }>;
  supports_image_detail_original: boolean;
  supports_parallel_tool_calls: boolean;
  supports_reasoning_summaries: boolean;
  supports_reasoning_summary_parameter: boolean;
  supports_search_tool: boolean;
  truncation_policy: { limit: number; mode: string };
  upgrade: any;
  visibility: string;
  web_search_tool_type: string;
  [key: string]: any;
}

export interface ModelCatalog {
  models: ModelCatalogEntry[];
}

export function inferInputModalities(modelName: string): string[] {
  const name = modelName.toLowerCase();
  if (
    name.includes("4o") ||
    name.includes("vision") ||
    name.includes("vl") ||
    name.includes("gemini") ||
    name.includes("claude-3") ||
    name.includes("pixtral") ||
    name.includes("omni") ||
    name.includes("kimi")
  ) {
    return ["text", "image"];
  }
  return ["text"];
}

export function inferModelCapabilities(modelName: string): string[] {
  const name = modelName.toLowerCase();
  const caps: string[] = [];

  if (
    name.includes("4o") ||
    name.includes("vision") ||
    name.includes("vl") ||
    name.includes("gemini") ||
    name.includes("claude-3") ||
    name.includes("pixtral") ||
    name.includes("omni")
  ) {
    caps.push("vision");
  }

  if (
    name.includes("gpt-4") ||
    name.includes("gpt-3.5") ||
    name.includes("claude-3") ||
    name.includes("gemini") ||
    name.includes("deepseek-chat") ||
    name.includes("qwen") ||
    name.includes("mistral") ||
    name.includes("llama-3")
  ) {
    caps.push("tool_call");
  }

  if (isReasoningModel(modelName)) {
    caps.push("reasoning");
  }

  if (inferContextWindow(modelName) >= 128000) {
    caps.push("long_context");
  }

  if (name.includes("audio") || name.includes("realtime") || name.includes("voice") || name.includes("tts") || name.includes("whisper")) {
    caps.push("audio");
  }

  if (name.includes("code") || name.includes("coder") || name.includes("starcoder") || name.includes("codestral")) {
    caps.push("code");
  }

  return caps;
}

export function preferredModelEndpoint(row: ProtocolMetadataInput): string | null {
  const protocol = resolveProtocolMetadata(row);
  return protocol.supported_endpoints.find(endpoint => protocol.upstream_endpoints.includes(endpoint))
    ?? protocol.supported_endpoints[0] ?? null;
}

export function buildModelCatalog(models: Array<ModelRow & ModelMetadataInput & ProtocolMetadataInput>): ModelCatalog {
  const catalogEntries: ModelCatalogEntry[] = [];
  let priorityCounter = 1000;

  for (const m of models) {
    if (!m.enabled || ["embedding", "video"].includes(resolveModelType(m))) continue;

    const slug = m.alias || m.model_name;
    const displayName = m.display_name || m.alias || m.model_name;

    const customConfig: Record<string, any> = readModelConfig(m.config_json);
    const metadata = resolveModelMetadata(m);
    const reasoningSupport = { supported: metadata.supports_reasoning, levels: metadata.supported_reasoning_levels, default_level: metadata.default_reasoning_level, source: metadata.reasoning_source };
    const contextWindow = metadata.context_window;

    const capabilities: string[] =
      Array.isArray(customConfig.capabilities) && customConfig.capabilities.length
        ? customConfig.capabilities.filter((cap): cap is string => typeof cap === "string")
        : inferModelCapabilities(m.model_name);
    if (m.is_group && reasoningSupport.supported && !capabilities.includes("reasoning")) {
      capabilities.push("reasoning");
    }

    const description =
      typeof customConfig.description === "string"
        ? customConfig.description
        : displayName;

    const entry: ModelCatalogEntry = {
      ...metadata,
      additional_speed_tiers: [],
      apply_patch_tool_type: customConfig.apply_patch_tool_type || "freeform",
      availability_nux: null,
      base_instructions: customConfig.base_instructions || catalogTemplate.base_instructions,
      context_window: contextWindow,
      default_reasoning_level: reasoningSupport.default_level,
      default_reasoning_summary: "none",
      default_verbosity: "low",
      description,
      display_name: displayName,
      effective_context_window_percent: customConfig.effective_context_window_percent ?? 95,
      experimental_supported_tools: [],
      input_modalities: customConfig.input_modalities || inferInputModalities(m.model_name),
      max_context_window: contextWindow,
      model_messages: customConfig.model_messages || catalogTemplate.model_messages,
      priority: customConfig.priority ?? priorityCounter++,
      service_tiers: [],
      shell_type: "shell_command",
      slug,
      support_verbosity: true,
      supported_in_api: true,
      supported_reasoning_levels: reasoningSupport.levels,
      supports_image_detail_original: false,
      supports_parallel_tool_calls: false,
      supports_reasoning_summaries: false,
      supports_reasoning_summary_parameter: false,
      supports_search_tool: false,
      truncation_policy: customConfig.truncation_policy || { limit: 10000, mode: "bytes" },
      upgrade: null,
      visibility: "list",
      web_search_tool_type: "none",
      capabilities,
      reasoning_source: reasoningSupport.source,
    };

    for (const key of Object.keys(entry)) {
      if (Object.prototype.hasOwnProperty.call(customConfig, key)) entry[key] = customConfig[key];
    }
    if (typeof customConfig.custom_tag === "string") entry.custom_tag = customConfig.custom_tag;
    Object.assign(entry, metadata, {
      capabilities,
      protocol_capabilities: resolveProtocolMetadata(m),
      model_type: resolveModelType(m),
      billing_unit: m.billing_unit === "call" ? "call" : "token",
      chat_endpoint: preferredModelEndpoint(m),
    });
    catalogEntries.push(entry);
  }

  return {
    models: catalogEntries,
  };
}
