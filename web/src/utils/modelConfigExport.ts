export interface ModelConfigMetadata {
  slug?: string;
  alias?: string | null;
  model_name?: string;
  display_name?: string | null;
  context_window?: unknown;
  max_output_tokens?: unknown;
  context_window_source?: string;
  max_output_tokens_source?: string;
  supports_reasoning?: boolean;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  input_modalities?: string[];
  model_type?: "text" | "image" | "embedding" | "video";
  billing_unit?: string;
  chat_endpoint?: string;
}

const DSH_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type DshLevel = typeof DSH_LEVELS[number];
type Input = "text" | "image";
interface SafeModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: Input[];
  levels: DshLevel[];
  reasoning: boolean;
}
export interface ExportDiagnostics {
  warnings: string[];
  skipped: Array<{ id: string; reason: string }>;
}
export interface DshProfileModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: Input[];
  reasoningEfforts: false | Partial<Record<DshLevel, DshLevel>>;
}
export interface DshProfileProvider {
  displayName: string;
  api: "openai-completions";
  baseURL: string;
  apiKeyEnv: string;
  models: DshProfileModel[];
}

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function normalizeModels(items: readonly ModelConfigMetadata[]): ExportDiagnostics & { models: SafeModel[] } {
  const warnings = new Set<string>();
  const skipped = new Map<string, string>();
  const byId = new Map<string, SafeModel>();
  for (const item of items) {
    const id = item.slug || item.alias || item.model_name || "";
    if (!id.trim()) {
      skipped.set("（无公开模型名）", "缺少公开模型 ID");
      continue;
    }
    let reason = "";
    if (item.model_type === "embedding" || item.chat_endpoint === "/v1/embeddings") reason = "向量模型不属于 OpenAI 文本 profile";
    else if (item.model_type === "video" || item.chat_endpoint === "/v1/video/generations") reason = "视频模型不属于 OpenAI 文本 profile";
    else if (item.model_type === "image" || (item.model_type !== "text" && item.billing_unit === "call")) reason = "按次计费图片模型不属于 OpenAI 文本 profile";
    else if (item.chat_endpoint && item.chat_endpoint !== "/v1/chat/completions")
      reason = "非 /v1/chat/completions 模型不属于 OpenAI 文本 profile";
    else if (!positiveInteger(item.context_window)) reason = "context_window 必须为正整数";
    else if (!positiveInteger(item.max_output_tokens)) reason = "max_output_tokens 未知或非法；请先配置真实输出上限";
    else if (item.max_output_tokens > item.context_window) reason = "max_output_tokens 不能大于 context_window";
    const input: Input[] = item.input_modalities
      ? (["text", "image"] as Input[]).filter((kind) => item.input_modalities!.includes(kind))
      : ["text"];
    if (!reason && !input.includes("text")) reason = "未声明文本输入能力，不属于 OpenAI 文本 profile";
    if (reason) {
      skipped.set(id, reason);
      byId.delete(id);
      continue;
    }
    if (skipped.has(id)) continue;
    for (const [field, source] of [["context_window", item.context_window_source], ["max_output_tokens", item.max_output_tokens_source]]) {
      if (!source || /infer|fallback|model_name|default|unknown|mixed/i.test(source))
        warnings.add(id + "：" + field + " 来源为推断/回退或未标明，不是真实已验证能力，请核实后使用。");
    }
    if (!item.input_modalities) warnings.add(id + "：未声明 input_modalities，仅保守导出 text。");
    const declared = item.supported_reasoning_levels ?? [];
    const unknown = declared.filter(({ effort }) => effort !== "off" && !DSH_LEVELS.includes(effort as DshLevel));
    if (unknown.length) warnings.add(id + "：存在 DSH 不支持的推理等级，已忽略且不会强制映射。");
    const levels = item.supports_reasoning === true
      ? DSH_LEVELS.filter((level) => declared.some(({ effort }) => effort === level))
      : [];
    if (item.supports_reasoning && !levels.length)
      warnings.add(id + "：没有 CPG 与 DSH 共同支持的抽象推理等级，reasoningEfforts 已关闭。");
    const previous = byId.get(id);
    if (previous) {
      previous.contextWindow = Math.min(previous.contextWindow, item.context_window as number);
      previous.maxTokens = Math.min(previous.maxTokens, item.max_output_tokens as number);
      previous.input = previous.input.filter((kind) => input.includes(kind));
      previous.levels = previous.levels.filter((level) => levels.includes(level));
      previous.reasoning = previous.reasoning && item.supports_reasoning === true;
      warnings.add(id + "：重复公开 ID 已保守合并：上下文/输出取最小值，输入/推理能力取交集（任一不支持即关闭）。");
    } else {
      byId.set(id, {
        id, name: item.display_name || id,
        contextWindow: item.context_window as number,
        maxTokens: item.max_output_tokens as number,
        input, levels, reasoning: item.supports_reasoning === true,
      });
    }
  }
  if (!byId.size) warnings.add("没有能力完整的可导出模型；请先配置真实上下文与输出上限，不会伪造默认输出上限。");
  return { models: [...byId.values()], warnings: [...warnings], skipped: [...skipped].map(([id, reason]) => ({ id, reason })) };
}

export function buildDshProfile(items: readonly ModelConfigMetadata[], baseURL: string) {
  const { models, ...diagnostics } = normalizeModels(items);
  const providers: Record<string, DshProfileProvider> = {};
  if (models.length) providers["cpg-gateway"] = {
    displayName: "CPG Gateway", api: "openai-completions",
    baseURL, apiKeyEnv: "CPG_API_KEY",
    models: models.map(({ levels, reasoning: _reasoning, ...model }) => ({
      ...model,
      reasoningEfforts: levels.length ? Object.fromEntries(levels.map((level) => [level, level])) : false,
    })),
  };
  return { config: { providers }, ...diagnostics };
}

export function buildPiModelsConfig(items: readonly ModelConfigMetadata[], baseUrl: string) {
  const { models, ...diagnostics } = normalizeModels(items);
  return {
    config: { providers: models.length ? {
      "personal-ai-gateway": {
        name: "Personal AI Gateway", baseUrl, api: "openai-completions",
        apiKey: "YOUR_DEVICE_TOKEN", discoverModels: true,
        models: models.map(({ levels: _levels, ...model }) => model),
      },
    } : {} },
    ...diagnostics,
  };
}

export const DSH_PROFILE_HELP = "DSH 0.2.0-rc.2 专用 profile（不是普通 Pi models.json）：将本片段合并到 llm-pi-ai 的 providers 配置，并在环境变量 CPG_API_KEY 中配置你的 Token。DSH 网络发现只读取 contextWindow/maxTokens，不读取 reasoning/input；使用发现时需选中模型并保存这些能力，或合并本片段。本片段不是 GUI 一键导入文件；不会设置默认推理等级。";
