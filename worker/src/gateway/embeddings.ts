import type { ModelTypeInput } from "./model_type";
import { resolveModelType } from "./model_type";

export const MAX_EMBEDDING_REQUEST_BYTES = 256 * 1024;
export const MAX_EMBEDDING_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_EMBEDDING_BATCH = 64;
export const MAX_EMBEDDING_DIMENSIONS = 4096;
export const EMBEDDING_BODY_TIMEOUT_MS = 30_000;
export type EmbeddingProfile = { compatibility_key: string; dimensions?: number };
type EmbeddingRow = ModelTypeInput & { provider_type?: string; id?: string };

export function readEmbeddingProfile(row: ModelTypeInput): EmbeddingProfile | null {
  try {
    const p = JSON.parse(row.config_json || "{}").embedding_profile;
    if (!p || typeof p.compatibility_key !== "string" || !p.compatibility_key.trim() || p.compatibility_key.length > 128) return null;
    if (p.dimensions !== undefined && (!Number.isInteger(p.dimensions) || p.dimensions < 1 || p.dimensions > MAX_EMBEDDING_DIMENSIONS)) return null;
    return { compatibility_key: p.compatibility_key, ...(p.dimensions === undefined ? {} : { dimensions: p.dimensions }) };
  } catch { return null; }
}
export function embeddingProviderCompatible(row: EmbeddingRow): boolean {
  return resolveModelType(row) === "embedding" && row.provider_type === "openai" && (row.billing_unit ?? "token") === "token";
}
export function compatibleEmbeddingSpace(a: ModelTypeInput, b: ModelTypeInput): boolean {
  const x = readEmbeddingProfile(a), y = readEmbeddingProfile(b);
  return !!x && !!y && x.dimensions !== undefined && y.dimensions !== undefined && x.compatibility_key === y.compatibility_key && x.dimensions === y.dimensions;
}
export function embeddingPoolError(billing: EmbeddingRow, members: readonly EmbeddingRow[], auto = false): string | null {
  if (resolveModelType(billing) !== "embedding" || (billing.billing_unit ?? "token") !== "token" || members.some(m => !embeddingProviderCompatible(m))) return "embedding_model_required";
  if ((auto || members.length > 1) && members.some(m => !compatibleEmbeddingSpace(billing, m))) return "embedding_compatibility_required";
  const declared = readEmbeddingProfile(billing);
  if (declared && members.some(m => {
    const profile = readEmbeddingProfile(m);
    return !profile || profile.compatibility_key !== declared.compatibility_key || (declared.dimensions !== undefined && profile.dimensions !== declared.dimensions);
  })) return "embedding_compatibility_required";
  return null;
}
export function validateEmbeddingRequest(body: any): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "invalid_embedding_request";
  if (Object.keys(body).some(k => !["model", "input", "encoding_format", "dimensions", "user", "stream"].includes(k))) return "unsupported_embedding_field";
  if (body.stream !== undefined && body.stream !== false) return "embeddings_do_not_stream";
  const inputs = typeof body.input === "string" ? [body.input] : body.input;
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > MAX_EMBEDDING_BATCH || inputs.some(s => typeof s !== "string" || !s.trim())) return "invalid_embedding_input";
  if (body.encoding_format !== undefined && body.encoding_format !== "float" && body.encoding_format !== "base64") return "invalid_embedding_encoding";
  if (body.dimensions !== undefined && (!Number.isInteger(body.dimensions) || body.dimensions < 1 || body.dimensions > MAX_EMBEDDING_DIMENSIONS)) return "invalid_embedding_dimensions";
  if (body.user !== undefined && (typeof body.user !== "string" || body.user.length > 256)) return "invalid_embedding_user";
  return null;
}
export function embeddingDimensionsError(body: any, rows: readonly ModelTypeInput[]): boolean {
  return body.dimensions !== undefined && rows.some(row => {
    const dimensions = readEmbeddingProfile(row)?.dimensions;
    return dimensions !== undefined && dimensions !== body.dimensions;
  });
}

export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!body) throw Error("empty_body");
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const cancel = () => { stopped = true; void reader.cancel().catch(() => {}); };
  timer = setTimeout(cancel, EMBEDDING_BODY_TIMEOUT_MS);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) throw Error("aborted");
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const parts: string[] = [];
    let size = 0;
    for (;;) {
      const item = await reader.read();
      if (stopped || signal?.aborted) throw Error("aborted");
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) throw Error("body_too_large");
      parts.push(decoder.decode(item.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
