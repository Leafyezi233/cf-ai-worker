import type { ProviderType } from "../types";

export const DEFAULT_ENDPOINTS: Record<ProviderType, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

export function resolveProviderBase(endpoint: string | null | undefined, providerType: ProviderType): string {
  return (endpoint || DEFAULT_ENDPOINTS[providerType] || DEFAULT_ENDPOINTS.openai).replace(/\/+$/, "");
}
