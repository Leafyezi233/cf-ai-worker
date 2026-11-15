import type { TokenUsage } from "../types";
import type { ProxyContext } from "./proxy_context";
import { waitUntil } from "./proxy_context";
import { record } from "./usage_record";
import { cleanResponseHeaders } from "../utils/http";
import { MAX_EMBEDDING_DIMENSIONS, MAX_EMBEDDING_RESPONSE_BYTES, readBoundedBody, readEmbeddingProfile } from "./embeddings";

export async function relayEmbeddingAnswer(ctx: ProxyContext, upstream: Response, request: any): Promise<Response> {
  const fail = (status: number, error: string) => {
    ctx.latencyMs = Date.now() - ctx.startedAt;
    waitUntil(ctx.c, record(ctx, null, status));
    return Response.json({ error }, { status });
  };
  try {
    const declared = Number(upstream.headers.get("content-length") || 0);
    if (declared > MAX_EMBEDDING_RESPONSE_BYTES) {
      void upstream.body?.cancel().catch(() => {});
      return fail(502, "embedding_response_too_large");
    }
    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => {});
      return fail(upstream.status >= 400 ? upstream.status : 502, "embedding_upstream_error");
    }
    if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
      void upstream.body?.cancel().catch(() => {});
      return fail(502, "invalid_embedding_response");
    }
    const text = await readBoundedBody(upstream.body, MAX_EMBEDDING_RESPONSE_BYTES, ctx.c.req.raw.signal);
    const obj = JSON.parse(text);
    const count = Array.isArray(request.input) ? request.input.length : 1;
    if (obj?.error || obj?.object !== "list" || !Array.isArray(obj.data) || obj.data.length !== count) return fail(502, "invalid_embedding_response");
    const expected = request.dimensions ?? readEmbeddingProfile(ctx.row)?.dimensions ?? readEmbeddingProfile(ctx.billingRow)?.dimensions;
    let dimension: number | undefined;
    const seen = new Set<number>();
    const data: { object: string; index: number; embedding: number[] | string }[] = [];
    for (const item of obj.data) {
      if (item?.object !== "embedding" || !Number.isInteger(item.index) || item.index < 0 || item.index >= count || seen.has(item.index)) return fail(502, "invalid_embedding_response");
      seen.add(item.index);
      let size: number;
      if ((request.encoding_format ?? "float") === "base64") {
        const value = item.embedding;
        if (typeof value !== "string" || !value.length || value.length > Math.ceil(MAX_EMBEDDING_DIMENSIONS * 4 / 3) * 4 || value.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return fail(502, "invalid_embedding_response");
        const bytes = value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
        if (bytes % 4) return fail(502, "invalid_embedding_response");
        size = bytes / 4;
      } else {
        if (!Array.isArray(item.embedding) || item.embedding.some((v: unknown) => typeof v !== "number" || !Number.isFinite(v))) return fail(502, "invalid_embedding_response");
        size = item.embedding.length;
      }
      if (!size || size > MAX_EMBEDDING_DIMENSIONS || expected !== undefined && size !== expected || dimension !== undefined && size !== dimension) return fail(502, "invalid_embedding_response");
      dimension = size;
      data.push({ object: "embedding", index: item.index, embedding: item.embedding });
    }
    const prompt = obj.usage?.prompt_tokens, total = obj.usage?.total_tokens;
    if (!Number.isSafeInteger(prompt) || prompt <= 0 || !Number.isSafeInteger(total) || total !== prompt) return fail(502, "invalid_embedding_usage");
    const usage: TokenUsage = { input_tokens: prompt, output_tokens: 0, total_tokens: prompt, cache_read_tokens: 0, cache_write_tokens: 0 };
    const headers = cleanResponseHeaders(upstream.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json");
    headers.set("cache-control", "no-store");
    ctx.latencyMs = Date.now() - ctx.startedAt;
    const response = new Response(JSON.stringify({ object: "list", data, model: ctx.visibleModel, usage: { prompt_tokens: prompt, total_tokens: prompt } }), { status: 200, headers });
    waitUntil(ctx.c, record(ctx, usage, 200));
    return response;
  } catch {
    return fail(502, "invalid_embedding_response");
  }
}
