import type { ProviderType } from "../types";


export interface ReasoningLevel {
  effort: string;
  description: string;
}

export const REASONING_LEVELS: ReasoningLevel[] = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
  { effort: "max", description: "Maximum reasoning depth; the slowest and most expensive rung" },
];

export function isReasoningModel(modelName: string): boolean {
  const name = (modelName || "").toLowerCase();
  return (
    name.includes("r1") ||
    name.includes("reason") ||
    name.includes("thinking") ||
    name.includes("thought") ||
    name.includes("qwq") ||
    name.includes("qvq") ||
    name.startsWith("o1") ||
    name.startsWith("o3") ||
    name.startsWith("o4") ||
    name.includes("o1-") ||
    name.includes("o3-") ||
    name.includes("o4-") ||
    name.includes("claude-3-7") ||
    name.includes("claude-3.7") ||
    name.includes("claude-4")
  );
}

export type ReasoningSource =
  | "probe"
  | "config_levels"
  | "config_off"
  | "config_default"
  | "capability"
  | "model_name"
  | "provider"
  | "group_levels"
  | "group_default"
  | "none";

export interface ReasoningSupportInput {
  model_name: string;
  alias?: string | null;
  config_json?: string | null;
  provider_type?: ProviderType | string | null;
}

export interface ReasoningSupport {
  supported: boolean;
  levels: ReasoningLevel[];
  default_level: string | null;
  source: ReasoningSource;
}

function normalizeLevels(raw: unknown): ReasoningLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: ReasoningLevel[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      const effort = item.trim();
      const known = REASONING_LEVELS.find((l) => l.effort === effort);
      out.push({ effort, description: known ? known.description : effort });
    } else if (item && typeof item === "object") {
      const effort = typeof (item as any).effort === "string" ? (item as any).effort.trim() : "";
      if (!effort) continue;
      const description =
        typeof (item as any).description === "string" && (item as any).description.trim()
          ? (item as any).description.trim()
          : effort;
      out.push({ effort, description });
    }
  }
  return out;
}

function readConfig(configJson?: string | null): Record<string, any> {
  if (!configJson) return {};
  try {
    const parsed = JSON.parse(configJson);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function resolveReasoningSupport(input: ReasoningSupportInput): ReasoningSupport {
  const config = readConfig(input.config_json);

  const configuredLevels = normalizeLevels(config.supported_reasoning_levels);
  const configuredDefault =
    typeof config.default_reasoning_level === "string" && config.default_reasoning_level.trim()
      ? config.default_reasoning_level.trim()
      : null;
  const caps = Array.isArray(config.capabilities)
    ? config.capabilities.filter((c: unknown): c is string => typeof c === "string")
    : [];
  const probe = config.probe && typeof config.probe === "object" ? (config.probe as Record<string, any>) : null;

  const probeApplies =
    probe &&
    typeof probe.reasoning_supported === "boolean" &&
    (!probe.provider_type || !input.provider_type || probe.provider_type === input.provider_type);

  if (probeApplies && probe) {
    if (!probe.reasoning_supported) {
      return { supported: false, levels: [], default_level: null, source: "probe" };
    }
    const levels = configuredLevels.length ? configuredLevels : REASONING_LEVELS;
    return { supported: true, levels, default_level: configuredDefault || "medium", source: "probe" };
  }

  if (configuredLevels.length) {
    return {
      supported: true,
      levels: configuredLevels,
      default_level: configuredDefault || configuredLevels[0].effort,
      source: "config_levels",
    };
  }

  if (config.supports_reasoning === false) {
    return { supported: false, levels: [], default_level: null, source: "config_off" };
  }

  if (configuredDefault) {
    return { supported: true, levels: REASONING_LEVELS, default_level: configuredDefault, source: "config_default" };
  }

  if (caps.includes("reasoning")) {
    return { supported: true, levels: REASONING_LEVELS, default_level: "medium", source: "capability" };
  }

  if (isReasoningModel(input.model_name) || (input.alias ? isReasoningModel(input.alias) : false)) {
    return { supported: true, levels: REASONING_LEVELS, default_level: "medium", source: "model_name" };
  }

  if (input.provider_type === "anthropic") {
    return { supported: true, levels: REASONING_LEVELS, default_level: "medium", source: "provider" };
  }

  return { supported: false, levels: [], default_level: null, source: "none" };
}


const EFFORT_ORDER: Record<string, number> = {
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

export function resolveGroupReasoningSupport(config_json?: string | null): ReasoningSupport {
  const config = readConfig(config_json);
  if (config.supports_reasoning === false) {
    return { supported: false, levels: [], default_level: null, source: "config_off" };
  }
  const configuredLevels = normalizeLevels(config.supported_reasoning_levels);
  const configuredDefault =
    typeof config.default_reasoning_level === "string" && config.default_reasoning_level.trim()
      ? config.default_reasoning_level.trim()
      : null;
  if (configuredLevels.length) {
    return {
      supported: true,
      levels: configuredLevels,
      default_level: configuredDefault || configuredLevels[0].effort,
      source: "group_levels",
    };
  }
  return {
    supported: true,
    levels: REASONING_LEVELS,
    default_level: configuredDefault || "medium",
    source: "group_default",
  };
}

function secondHighestLevel(levels: ReasoningLevel[]): string | null {
  if (!levels.length) return null;
  const ranked = [...levels].sort((a, b) => (EFFORT_ORDER[a.effort] || 0) - (EFFORT_ORDER[b.effort] || 0));
  return ranked.length > 1 ? ranked[ranked.length - 2].effort : ranked[0].effort;
}

function readEffort(reqBody: Record<string, any>): string | null {
  const direct = reqBody.reasoning_effort;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const key of ["reasoning", "output_config"] as const) {
    const holder = reqBody[key];
    if (holder && typeof holder === "object" && typeof holder.effort === "string" && holder.effort.trim()) {
      return holder.effort.trim();
    }
  }
  return null;
}

function rewriteEffort(reqBody: Record<string, any>, level: string): boolean {
  let changed = false;
  if (typeof reqBody.reasoning_effort === "string" && reqBody.reasoning_effort.trim() !== level) {
    reqBody.reasoning_effort = level;
    changed = true;
  }
  for (const key of ["reasoning", "output_config"] as const) {
    const holder = reqBody[key];
    if (holder && typeof holder === "object" && typeof holder.effort === "string" && holder.effort.trim() !== level) {
      holder.effort = level;
      changed = true;
    }
  }
  return changed;
}

export interface GroupEffortOutcome {
  changed: boolean;
  level: string | null;
  reason: "no_effort" | "group_off" | "member_off" | "kept" | "rewritten";
}

export function degradeGroupReasoningEffort(
  reqBody: Record<string, any>,
  group: ReasoningSupport,
  member: ReasoningSupportInput
): GroupEffortOutcome {
  if (!group.supported) {
    return { changed: dropReasoningEffort(reqBody), level: null, reason: "group_off" };
  }
  const requested = readEffort(reqBody);
  if (!requested) return { changed: false, level: null, reason: "no_effort" };

  const memberSupport = resolveReasoningSupport(member);
  if (!memberSupport.supported) {
    return { changed: dropReasoningEffort(reqBody), level: null, reason: "member_off" };
  }

  const inGroupLadder = group.levels.some((l) => l.effort === requested);
  const inMemberLadder = memberSupport.levels.some((l) => l.effort === requested);
  if (inGroupLadder && inMemberLadder) {
    return { changed: false, level: requested, reason: "kept" };
  }

  const target = secondHighestLevel(memberSupport.levels) || secondHighestLevel(group.levels) || "medium";
  return { changed: rewriteEffort(reqBody, target), level: target, reason: "rewritten" };
}


export const ANTHROPIC_MIN_THINKING_BUDGET = 1024;
export const ANTHROPIC_MAX_THINKING_BUDGET = 128000;

const EFFORT_RATIOS: Record<string, number> = {
  minimal: 0.1,
  low: 0.2,
  medium: 0.5,
  high: 0.8,
  xhigh: 0.95,
  max: 0.95,
};

export function anthropicThinkingBudget(effort: string, maxTokens: number): number | null {
  const ratio = EFFORT_RATIOS[String(effort || "").toLowerCase()];
  if (typeof ratio !== "number") return null;
  if (!Number.isFinite(maxTokens)) return null;
  const ceiling = Math.floor(maxTokens) - 1;
  if (ceiling < ANTHROPIC_MIN_THINKING_BUDGET) return null;
  const scaled = Math.floor(maxTokens * ratio);
  return Math.min(Math.max(scaled, ANTHROPIC_MIN_THINKING_BUDGET), ANTHROPIC_MAX_THINKING_BUDGET, ceiling);
}

export interface EffortRewrite {
  applied: boolean;
  budget?: number;
  dropped?: boolean;
  reason?: string;
  raisedMaxTokens?: number;
}

export function applyReasoningEffort(
  reqBody: Record<string, any>,
  providerType: ProviderType | string | null | undefined,
  kind: string
): EffortRewrite {
  if (providerType !== "anthropic") return { applied: false, reason: "not_anthropic" };
  if (kind !== "messages") return { applied: false, reason: "not_messages_endpoint" };

  const raw = reqBody.reasoning_effort ?? reqBody.reasoning?.effort;
  if (typeof raw !== "string" || !raw.trim()) return { applied: false, reason: "no_effort" };

  const effort = raw.trim();
  delete reqBody.reasoning_effort;

  if (reqBody.reasoning && typeof reqBody.reasoning === "object" && "effort" in reqBody.reasoning) {
    const reasoning = { ...reqBody.reasoning };
    delete reasoning.effort;
    if (Object.keys(reasoning).length) reqBody.reasoning = reasoning;
    else delete reqBody.reasoning;
  }

  const existing = reqBody.thinking;
  if ("thinking" in reqBody) {
    return {
      applied: existing?.type === "enabled" || existing?.type === "adaptive",
      ...(existing?.type === "enabled" ? { budget: Number(existing.budget_tokens) || undefined } : {}),
      reason: "client_thinking",
    };
  }

  if (typeof EFFORT_RATIOS[effort.toLowerCase()] !== "number") {
    return { applied: false, dropped: true, reason: "unknown_effort" };
  }

  if (!Number.isFinite(Number(reqBody.max_tokens))) {
    return { applied: false, dropped: true, reason: "missing_max_tokens" };
  }

  let maxTokens = Number(reqBody.max_tokens);
  let raisedMaxTokens: number | undefined;
  if (Math.floor(maxTokens) - 1 < ANTHROPIC_MIN_THINKING_BUDGET) {
    const raised = ANTHROPIC_MIN_THINKING_BUDGET + 1;
    maxTokens = raised;
    raisedMaxTokens = raised;
    reqBody.max_tokens = raised;
  }

  const budget = anthropicThinkingBudget(effort, maxTokens);
  if (budget === null) {
    return { applied: false, dropped: true, reason: "no_budget" };
  }

  reqBody.thinking = { type: "enabled", budget_tokens: budget };
  if ("temperature" in reqBody) delete reqBody.temperature;
  return { applied: true, budget, ...(raisedMaxTokens ? { raisedMaxTokens } : {}) };
}


export function dropReasoningEffort(reqBody: Record<string, any>): boolean {
  let dropped = false;

  if ("reasoning_effort" in reqBody) {
    delete reqBody.reasoning_effort;
    dropped = true;
  }

  for (const key of ["reasoning", "output_config"] as const) {
    const holder = reqBody[key];
    if (holder && typeof holder === "object" && "effort" in holder) {
      delete holder.effort;
      dropped = true;
      if (!Object.keys(holder).length) delete reqBody[key];
    }
  }

  if ("thinking" in reqBody) {
    delete reqBody.thinking;
    dropped = true;
  }

  return dropped;
}

export function dropUnsupportedReasoningEffort(
  reqBody: Record<string, any>,
  target: ReasoningSupportInput
): boolean {
  if (resolveReasoningSupport(target).supported) return false;
  return dropReasoningEffort(reqBody);
}
