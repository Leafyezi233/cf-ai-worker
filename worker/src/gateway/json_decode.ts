export type JsonDecodeResult = { ok: true; value: any } | { ok: false };
export function decodeJson(text: string): JsonDecodeResult {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}
