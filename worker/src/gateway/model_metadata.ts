import { resolveGroupReasoningSupport, resolveReasoningSupport } from "./reasoning";
import type { ReasoningLevel, ReasoningSource, ReasoningSupportInput } from "./reasoning";

export type ModelLimitSource = "config" | "inferred" | "fallback" | "members" | "mixed" | "unknown";

export interface ModelMetadata {
  context_window: number;
  max_context_window: number;
  max_output_tokens: number | null;
  context_window_source: ModelLimitSource;
  max_output_tokens_source: ModelLimitSource;
  supports_reasoning: boolean;
  supported_reasoning_levels: ReasoningLevel[];
  default_reasoning_level: string | null;
  reasoning_source: ReasoningSource;
}

export interface ModelMetadataInput extends ReasoningSupportInput {
  is_group?: boolean;
  model_metadata?: ModelMetadata;
}

export function readModelConfig(configJson?: string | null): Record<string, unknown> {
  try {
    const value: unknown = configJson ? JSON.parse(configJson) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function configuredLimit(config: Record<string, unknown>, keys: string[]): number | null {
  const values = keys.map(key => config[key]).filter(positiveInteger);
  return values.length ? Math.min(...values) : null;
}

export function inferContextWindow(modelName: string): number {
  const name = modelName.toLowerCase();
  if (name.includes("gemini-1.5") || name.includes("gemini-2.0") || name.includes("gemini-2.5")) {
    return 1048576;
  }
  if (name.includes("claude-3") || name.includes("claude-2")) {
    return 200000;
  }
  if (name.includes("o1") || name.includes("o3")) {
    return 200000;
  }
  if (name.includes("deepseek") || name.includes("qwen") || name.includes("qwq") || name.includes("llama-3")) {
    return 131072;
  }
  if (name.includes("gpt-4o") || name.includes("gpt-4-turbo") || name.includes("gpt-4")) {
    return 128000;
  }
  if (name.includes("gpt-3.5-turbo-16k")) {
    return 16384;
  }
  if (name.includes("gpt-3.5")) {
    return 4096;
  }
  return 128000;
}


function inferredContextSource(modelName: string): "inferred" | "fallback" {
  return /gemini-(1\.5|2\.0|2\.5)|claude-[23]|o1|o3|deepseek|qwen|qwq|llama-3|gpt-4|gpt-3\.5/i.test(modelName)
    ? "inferred" : "fallback";
}

export function resolveModelMetadata(row: ModelMetadataInput): ModelMetadata {
  const config = readModelConfig(row.config_json);
  const reasoning = row.is_group ? resolveGroupReasoningSupport(row.config_json) : resolveReasoningSupport(row);
  const context = configuredLimit(config, ["context_window", "max_context_window", "contextWindow", "max_input_tokens"]);
  const output = configuredLimit(config, ["max_output_tokens", "maxTokens", "max_completion_tokens"]);
  const projected = row.model_metadata;
  const contextWindow = projected && positiveInteger(projected.context_window)
    ? projected.context_window : context ?? inferContextWindow(row.model_name);
  return {
    context_window: contextWindow,
    max_context_window: contextWindow,
    max_output_tokens: projected ? (positiveInteger(projected.max_output_tokens) ? projected.max_output_tokens : null) : output,
    context_window_source: projected?.context_window_source ?? (context !== null ? "config" : inferredContextSource(row.model_name)),
    max_output_tokens_source: projected?.max_output_tokens_source ?? (output !== null ? "config" : "unknown"),
    supports_reasoning: projected?.supports_reasoning ?? reasoning.supported,
    supported_reasoning_levels: (projected?.supported_reasoning_levels ?? reasoning.levels).map(level => ({ effort: level.effort, description: level.description })),
    default_reasoning_level: projected ? projected.default_reasoning_level : reasoning.default_level,
    reasoning_source: projected?.reasoning_source ?? reasoning.source,
  };
}

export function aggregateModelMetadata(row: ModelMetadataInput, members: readonly ModelMetadataInput[]): ModelMetadata {
  const base = resolveModelMetadata({ ...row, model_metadata: undefined });
  if (!members.length) return { ...base, max_output_tokens: null, max_output_tokens_source: "unknown",
    context_window_source: base.context_window_source === "config" ? "mixed" : base.context_window_source };
  const metadata = members.map(resolveModelMetadata);
  const config = readModelConfig(row.config_json);
  const contextCap = configuredLimit(config, ["context_window", "max_context_window", "contextWindow", "max_input_tokens"]);
  const outputCap = configuredLimit(config, ["max_output_tokens", "maxTokens", "max_completion_tokens"]);
  const context = Math.min(...metadata.map(m => m.context_window), contextCap ?? Infinity);
  const allContextsKnown = metadata.every(m => m.context_window_source === "config" || m.context_window_source === "members");
  const allOutputsKnown = metadata.every(m => m.max_output_tokens !== null
    && (m.max_output_tokens_source === "config" || m.max_output_tokens_source === "members"));
  const output = allOutputsKnown ? Math.min(...metadata.map(m => m.max_output_tokens!), outputCap ?? Infinity) : null;
  return {
    ...base,
    context_window: context,
    max_context_window: context,
    context_window_source: allContextsKnown ? "members" : "mixed",
    max_output_tokens: output,
    max_output_tokens_source: allOutputsKnown ? "members" : metadata.some(m => m.max_output_tokens !== null) ? "mixed" : "unknown",
  };
}
