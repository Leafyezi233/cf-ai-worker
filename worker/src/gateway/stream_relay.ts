
import { usageProviderType } from "./protocol_connections";
import { resolveRowBillingUnit } from "./pricing";
import { isImageModel } from "./model_type";
import { CallCompletionTracker } from "./call_completion";
import type { TokenUsage } from "../types";
import { waitUntil, GatewayKind, ProxyContext } from "./proxy_context";
import { record, buildBillingSnapshot } from "./usage_record";
import { parseUsage } from "./usage";
import { cleanResponseHeaders } from "../utils/http";
import { setCachedEntry } from "./cache";
import { identityRedactionTransform, modelMaskingTransform, type UpstreamIdentityTerms } from "./caller_identity";
import { chatReasoningTransform, createChatReasoningState, splitFencesFromText } from "./thinking_sse";

const DELTA_KEY = '"delta"';

function deltaObjectSpan(line: string, from: number): [number, number] | null {
  let i = from;
  while (i < line.length && line[i] !== "{") {
    const c = line[i];
    if (c !== " " && c !== "\t" && c !== ":") return null;
    i++;
  }
  if (i >= line.length) return null;
  const start = i;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return [start, i + 1];
    }
  }
  return null;
}

export function extractTextFromSse(kind: "messages" | "chat/completions", fullStreamText: string): string {
  let extractedText = "";
  const wantsText = kind === "messages";
  for (const line of fullStreamText.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    if (wantsText && !line.includes("content_block_delta")) continue;
    const at = line.indexOf(DELTA_KEY);
    if (at < 0) continue;
    const span = deltaObjectSpan(line, at + DELTA_KEY.length);
    if (!span) continue;
    try {
      const delta = JSON.parse(line.slice(span[0], span[1]));
      const text = wantsText ? delta?.text : delta?.content;
      if (typeof text === "string" && text) extractedText += text;
    } catch {
    }
  }
  return extractedText;
}

export const UPSTREAM_FIRST_CHUNK_TIMEOUT_MS = 200 * 1000;

export const UPSTREAM_STREAM_STALL_TIMEOUT_MS = 360 * 1000;

const MAX_TAIL_BYTES = 32 * 1024;  
const MAX_CACHE_STREAM_BYTES = 512 * 1024;  
const MAX_USAGE_CHUNKS_BYTES = 32 * 1024;

export function appendCapped(buffer: string, chunk: string): string {
  const combined = buffer + chunk;
  return combined.length > MAX_USAGE_CHUNKS_BYTES ? combined.slice(-MAX_USAGE_CHUNKS_BYTES) : combined;
}

function estimateStreamUsage(ctx: ProxyContext, streamText: string): TokenUsage {
  const receivedText = extractTextFromSse(ctx.kind as "messages" | "chat/completions", streamText);
  const inputTokens = Math.max(0, ctx.estimatedInputTokens ?? 0);
  const outputTokens = Math.max(1, Math.ceil(receivedText.length / 4));
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cache_read_included_in_input: true,
  };
}

export function upstreamIdentityTerms(ctx: ProxyContext): UpstreamIdentityTerms {
  return {
    providerName: ctx.row.provider_name,
    providerId: ctx.row.provider_id,
    upstreamModel: ctx.sentModel,
    publicModel: ctx.visibleModel,
  };
}

const LN_SEP = String.fromCharCode(10);

function streamFailureFrame(kind: GatewayKind, endsWithNewline: boolean): string {
  const lead = endsWithNewline ? "" : LN_SEP;
  if (kind === "messages") {
    return `${lead}event: error${LN_SEP}data: ${JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message: "The upstream stopped sending data before the answer finished.",
      },
    })}${LN_SEP}${LN_SEP}`;
  }
  const message = "The upstream stopped sending data before the answer finished.";
  return `${lead}data: ${JSON.stringify({
    error: { message, type: "upstream_error", code: "upstream_stream_stalled" },
  })}${LN_SEP}${LN_SEP}data: [DONE]${LN_SEP}${LN_SEP}`;
}

export function passthroughStream(
  ctx: ProxyContext,
  upstreamRes: Response,
  stallGuard?: () => void,
  stalled?: () => boolean
): Response {
  if (!upstreamRes.body) {
    if (resolveRowBillingUnit(ctx.billingRow ?? ctx.row) === "call" && !isImageModel(ctx.billingRow ?? ctx.row)) ctx.billableCall = false;
    const res = new Response(null, { status: upstreamRes.status, headers: cleanResponseHeaders(upstreamRes.headers) });
    waitUntil(ctx.c, record(ctx, null, upstreamRes.status));
    return res;
  }

  const billingRow = ctx.billingRow ?? ctx.row;
  const shouldCache = upstreamRes.ok && Boolean(billingRow.cache_enabled) && Boolean(ctx.cacheKey);
  const callCompletion = resolveRowBillingUnit(billingRow) === "call" && !isImageModel(billingRow) && (ctx.kind === "messages" || ctx.kind === "chat/completions") ? new CallCompletionTracker(ctx.kind) : null;
  let streamText = "";
  let headBuffer = "";
  let usageChunks = "";
  let cacheDisabledDueToSize = false;
  let resolveDone: () => void = () => {};
  const donePromise = new Promise<void>((resolve) => { resolveDone = resolve; });
  let decoder: TextDecoder | undefined;
  const encoder = new TextEncoder();
  const needsLegacyUsage = () => !ctx.billingAttempt?.meter.hasUsage || shouldCache;

  let settled = false;
  let clientCancelled = false;

  const reasoningState = ctx.kind === "chat/completions" ? createChatReasoningState() : null;

  let endsWithNewline = false;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const legacyUsage = needsLegacyUsage();
      const needsText = legacyUsage || !!callCompletion;
      const decoded = needsText ? (decoder ??= new TextDecoder()).decode(chunk, { stream: true }) : "";
      if (!needsText) decoder = undefined;
      callCompletion?.feed(decoded);
      if (chunk.byteLength > 0) endsWithNewline = chunk[chunk.byteLength - 1] === 10;

      if (legacyUsage) {
        if (headBuffer.length < MAX_TAIL_BYTES) {
          headBuffer += decoded;
        }

        if (decoded.includes("usage") || decoded.includes("tokens")) {
          usageChunks = appendCapped(usageChunks, decoded);
        }

        streamText += decoded;

        if (shouldCache && !cacheDisabledDueToSize) {
          if (streamText.length > MAX_CACHE_STREAM_BYTES) {
            cacheDisabledDueToSize = true;
            streamText = streamText.slice(-MAX_TAIL_BYTES);
          }
        } else {
          if (streamText.length > MAX_TAIL_BYTES * 2) {
            streamText = streamText.slice(-MAX_TAIL_BYTES);
          }
        }

      } else {
        headBuffer = ""; usageChunks = ""; streamText = "";
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      const finalChunk = decoder?.decode() ?? "";
      callCompletion?.feed(finalChunk);
      if (finalChunk && needsLegacyUsage()) {
        streamText += finalChunk;
        if (headBuffer.length < MAX_TAIL_BYTES) headBuffer += finalChunk;
        if (finalChunk.includes("usage") || finalChunk.includes("tokens")) {
          usageChunks = appendCapped(usageChunks, finalChunk);
        }
      }
      stallGuard?.();
      if (stalled?.()) controller.enqueue(encoder.encode(streamFailureFrame(ctx.kind, endsWithNewline)));
      resolveDone();
    },
    cancel() {
      clientCancelled = true;
      stallGuard?.();
      resolveDone();
    },
  });

  let readable = upstreamRes.body.pipeThrough(transform);
  if (reasoningState) readable = readable.pipeThrough(chatReasoningTransform(reasoningState));
  readable = readable.pipeThrough(modelMaskingTransform(ctx.visibleModel));
  if (!upstreamRes.ok) readable = readable.pipeThrough(identityRedactionTransform(upstreamIdentityTerms(ctx)));
  const headers = cleanResponseHeaders(upstreamRes.headers);
  const res = new Response(readable, { status: upstreamRes.status, headers });

  waitUntil(
    ctx.c,
    donePromise.then(async () => {
      if (settled) return;
      settled = true;

      const managedUsage = !needsLegacyUsage() ? ctx.billingAttempt?.meter.snapshot().usage : null;
      const combinedUsageText = managedUsage ? "" : `${headBuffer}\n${usageChunks}\n${streamText}`;
      const parsedUsage = managedUsage ?? parseUsage(usageProviderType(ctx.upstreamKind ?? ctx.kind), combinedUsageText);
      const usage = parsedUsage ?? (clientCancelled ? estimateStreamUsage(ctx, combinedUsageText) : null);
      if (resolveRowBillingUnit(billingRow) === "call" && !isImageModel(billingRow)) {
        ctx.billableCall = !clientCancelled && !stalled?.() && !!callCompletion?.billable;
      }
      if (ctx.billingAttempt) {
        if (clientCancelled) ctx.billingAttempt.mark("cancelled");
        else if (stalled?.()) ctx.billingAttempt.mark("timeout");
      }
      const { costUsd } = await record(ctx, usage, clientCancelled ? 499 : stalled?.() ? 504 : upstreamRes.status);

      if (shouldCache && !cacheDisabledDueToSize && ctx.cacheKey && !clientCancelled && !stalled?.()) {
        try {
          const normalised =
            reasoningState && reasoningState.rewrote && !reasoningState.overflowed ? reasoningState : null;
          let extractedText: string;
          let extractedReasoning: string | undefined;
          if (normalised && normalised.contentComplete) {
            extractedText = normalised.content;
            extractedReasoning = normalised.reasoning || undefined;
          } else {
            const rawText = extractTextFromSse(ctx.kind as "messages" | "chat/completions", streamText);
            if (!normalised) {
              extractedText = rawText;
            } else {
              const split = splitFencesFromText(rawText);
              extractedText = split.content;
              extractedReasoning = split.reasoning || undefined;
            }
          }
          if (ctx.kind === "chat/completions") {
            const jsonBody = {
              id: `chatcmpl-${ctx.requestId}`,
              object: "chat.completion",
              created: Math.floor(ctx.createdAt / 1000),
              model: ctx.visibleModel,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: extractedText },
                  finish_reason: "stop",
                },
              ],
              usage: usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
            };
            await setCachedEntry(
              ctx.c.env,
              ctx.cacheKey,
              {
                kind: ctx.kind,
                model: ctx.visibleModel,
                jsonBody,
                usage: usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
                reasoning: extractedReasoning,
                createdAt: ctx.createdAt,
                billing: buildBillingSnapshot(ctx.billingRow ?? ctx.row, costUsd, ctx),
              },
              billingRow.cache_ttl
            );
          } else if (ctx.kind === "messages") {
            const jsonBody = {
              id: `msg_${ctx.requestId}`,
              type: "message",
              role: "assistant",
              model: ctx.visibleModel,
              content: [{ type: "text", text: extractedText }],
              stop_reason: "end_turn",
              usage: usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
            };
            await setCachedEntry(
              ctx.c.env,
              ctx.cacheKey,
              {
                kind: ctx.kind,
                model: ctx.visibleModel,
                jsonBody,
                usage: usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
                createdAt: ctx.createdAt,
                billing: buildBillingSnapshot(ctx.billingRow ?? ctx.row, costUsd, ctx),
              },
              billingRow.cache_ttl
            );
          }
        } catch {}
      }
    })
  );
  return res;
}

export function watchForStall(
  upstreamRes: Response,
  controller: AbortController,
  onStall: () => void
): { response: Response; stop: () => void } {
  if (!upstreamRes.body) return { response: upstreamRes, stop: () => {} };
  const reader = upstreamRes.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let ctrlRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const closeQuietly = () => {
    try {
      ctrlRef?.close();
    } catch {
    }
  };
  let deadline = 0;
  let timerDeadline = 0;
  const schedule = (ms: number) => {
    timerDeadline = deadline;
    timer = setTimeout(function onWatchdogTimeout() {
      timer = undefined;
      if (stopped) return;
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        schedule(remaining);
        return;
      }
      stopped = true;
      onStall();
      controller.abort();
      void reader.cancel().catch(() => {});
      closeQuietly();
    }, ms);
  };
  const arm = (ms: number) => {
    if (stopped) return;
    deadline = performance.now() + ms;
    if (timer !== undefined && deadline >= timerDeadline) return;
    if (timer !== undefined) clearTimeout(timer);
    schedule(ms);
  };
  const monitored = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrlRef = ctrl;
    },
    async pull(ctrl) {
      ctrlRef = ctrl;
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (err) {
        stop();
        try { ctrl.error(err); } catch {}
        return;
      }
      if (read.done) {
        stop();
        try { ctrl.close(); } catch {}
        return;
      }
      arm(UPSTREAM_STREAM_STALL_TIMEOUT_MS);
      try { ctrl.enqueue(read.value as Uint8Array); } catch {}
    },
    cancel(reason) {
      stop();
      void reader.cancel(reason).catch(() => {});
    },
  });
  const response = new Response(monitored, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: upstreamRes.headers,
  });
  arm(UPSTREAM_FIRST_CHUNK_TIMEOUT_MS);
  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  return { response, stop };
}

export function joinChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

