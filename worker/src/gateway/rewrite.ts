import { outputTokenField, setOutputTokenLimit } from "./token_fields";

export interface RewriteRules {
  system_prompt?: string;
  system_prompt_mode?: "prepend" | "override" | "append";
  temperature?: number;
  temperature_max?: number;
  max_tokens?: number;
  max_tokens_limit?: number;
  top_p?: number;
  model_rewrite?: string;
  routing_strategy?: "priority" | "lowest_latency" | "weighted";
  weight?: number;
  capabilities?: string[];
}

export function parseRewriteRules(configJson?: string | null): RewriteRules {
  if (!configJson) return {};
  try {
    const parsed = JSON.parse(configJson);
    return {
      system_prompt: typeof parsed.system_prompt === "string" ? parsed.system_prompt : undefined,
      system_prompt_mode: ["prepend", "override", "append"].includes(parsed.system_prompt_mode) ? parsed.system_prompt_mode : "prepend",
      temperature: typeof parsed.temperature === "number" ? parsed.temperature : undefined,
      temperature_max: typeof parsed.temperature_max === "number" ? parsed.temperature_max : undefined,
      max_tokens: typeof parsed.max_tokens === "number" ? parsed.max_tokens : undefined,
      max_tokens_limit: typeof parsed.max_tokens_limit === "number" ? parsed.max_tokens_limit : undefined,
      top_p: typeof parsed.top_p === "number" ? parsed.top_p : undefined,
      model_rewrite: typeof parsed.model_rewrite === "string" && parsed.model_rewrite.trim() ? parsed.model_rewrite.trim() : undefined,
      routing_strategy: ["priority", "lowest_latency", "weighted"].includes(parsed.routing_strategy) ? parsed.routing_strategy : undefined,
      weight: typeof parsed.weight === "number" ? Math.max(1, parsed.weight) : undefined,
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : undefined,
    };
  } catch {
    return {};
  }
}

export function applyRequestRewriteRules(
  reqBody: Record<string, any>,
  rules: RewriteRules,
  kind: "messages" | "chat/completions" | "responses" | "openai" | "anthropic" | "gemini" | string
): Record<string, any> {
  const body = { ...reqBody };
  const isAnthropic = kind === "messages" || kind === "anthropic";

  if (rules.model_rewrite) {
    body.model = rules.model_rewrite;
  }

  if (kind === "embeddings") return body;

  if (rules.temperature !== undefined) {
    body.temperature = rules.temperature;
  } else if (rules.temperature_max !== undefined && typeof body.temperature === "number") {
    body.temperature = Math.min(body.temperature, rules.temperature_max);
  }

  if (rules.max_tokens !== undefined) {
    setOutputTokenLimit(body, rules.max_tokens, kind === "responses" ? "max_output_tokens" : "max_tokens");
  } else if (rules.max_tokens_limit !== undefined) {
    const field = outputTokenField(body);
    if (field && typeof body[field] === "number") {
      body[field] = Math.min(body[field], rules.max_tokens_limit);
    }
  }

  if (rules.top_p !== undefined) {
    body.top_p = rules.top_p;
  }

  if (rules.system_prompt && rules.system_prompt.trim()) {
    const injectedPrompt = rules.system_prompt.trim();
    const mode = rules.system_prompt_mode || "prepend";

    if (isAnthropic) {
      const existingSystem = body.system;
      if (mode === "override") {
        body.system = injectedPrompt;
      } else if (Array.isArray(existingSystem)) {
        const injectedBlock = { type: "text", text: injectedPrompt };
        body.system = mode === "append"
          ? [...existingSystem, injectedBlock]
          : [injectedBlock, ...existingSystem];
      } else if (typeof existingSystem !== "string" || !existingSystem) {
        body.system = injectedPrompt;
      } else if (mode === "append") {
        body.system = `${existingSystem}\n\n${injectedPrompt}`;
      } else {
        body.system = `${injectedPrompt}\n\n${existingSystem}`;
      }
    } else if (kind === "responses") {
      const existing = typeof body.instructions === "string" ? body.instructions : "";
      body.instructions = mode === "override" || !existing ? injectedPrompt
        : mode === "append" ? `${existing}\n\n${injectedPrompt}` : `${injectedPrompt}\n\n${existing}`;
    } else {
      const messages = Array.isArray(body.messages) ? [...body.messages] : [];
      const systemIndex = messages.findIndex((m: any) => m?.role === "system");

      if (systemIndex === -1) {
        messages.unshift({ role: "system", content: injectedPrompt });
      } else {
        const existingContent = typeof messages[systemIndex]?.content === "string" ? messages[systemIndex].content : "";
        if (mode === "override") {
          messages[systemIndex] = { ...messages[systemIndex], content: injectedPrompt };
        } else if (mode === "append") {
          messages[systemIndex] = { ...messages[systemIndex], content: `${existingContent}\n\n${injectedPrompt}` };
        } else {
          messages[systemIndex] = { ...messages[systemIndex], content: `${injectedPrompt}\n\n${existingContent}` };
        }
      }
      body.messages = messages;
    }
  }

  return body;
}
