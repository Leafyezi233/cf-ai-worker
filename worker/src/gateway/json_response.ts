import type { ProviderType } from "../types";
import { decodeJson, type JsonDecodeResult } from "./json_decode";
import { stampModel, maskUnparseableModelValues } from "./caller_identity";
import { parseJsonUsage, parseSseUsage } from "./usage";
import { createChatReasoningState, mayNeedChatNormalisation, normalizeChatCompletion } from "./thinking_sse";

export function prepareJsonResponse(text: string, provider: ProviderType, visibleModel: string,
  normalizeChat: boolean, observe?: (value: unknown) => void, decoded?: JsonDecodeResult) {
  const result = decoded && /^[ \t\r\n]*[{\[]/.test(text) ? decoded : decodeJson(text);
  if (!result.ok) return { decoded: result, usage: parseSseUsage(provider, text),
    text: maskUnparseableModelValues(text, visibleModel), reasoning: undefined };
  observe?.(result.value);
  const usage = parseJsonUsage(provider, result.value);
  const masked = text.includes('"model"') && stampModel(result.value, visibleModel);
  if (normalizeChat && (masked || mayNeedChatNormalisation(text)) && Array.isArray(result.value?.choices)) {
    const candidate = { ...result.value, choices: result.value.choices.map((choice: any) =>
      choice && typeof choice === "object" && !Array.isArray(choice)
        ? { ...choice, ...(choice.message && typeof choice.message === "object" && !Array.isArray(choice.message)
          ? { message: { ...choice.message } } : {}) } : choice) };
    try {
      const state = createChatReasoningState();
      if (normalizeChatCompletion(candidate, state)) {
        const normalized = JSON.stringify(candidate);
        return { decoded: { ok: true as const, value: candidate }, usage, text: normalized, reasoning: state.reasoning || undefined };
      }
    } catch {   }
  }
  return { decoded: result, usage, text: masked ? JSON.stringify(result.value) : text, reasoning: undefined };
}
