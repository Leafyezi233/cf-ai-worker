import type { TokenUsage } from "../types";
import type { ProxyContext } from "./proxy_context";
import { waitUntil, completeBilling } from "./proxy_context";
import { record } from "./usage_record";
import { parseUsageBlocks } from "./usage";
import { cleanResponseHeaders } from "../utils/http";
import { redactUpstreamIdentity } from "./caller_identity";
import { upstreamIdentityTerms } from "./stream_relay";

export const MAX_NATIVE_EVENT_CHARS = 1024 * 1024;
export const MAX_NATIVE_JSON_BYTES = 2 * 1024 * 1024;

export class ResponsesEventFramer {
  private fragments: string[] = [];
  private lines: string[] = [];
  private size = 0;

  feed(text: string, emit: (lines: string[]) => void | boolean) {
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf("\n", start);
      const part = text.slice(start, end < 0 ? text.length : end);
      this.size += part.length + (end < 0 ? 0 : 1);
      if (this.size > MAX_NATIVE_EVENT_CHARS) throw new Error("responses_event_too_large");
      if (part) this.fragments.push(part);
      if (end < 0) return;
      let line = this.fragments.join("");
      this.fragments = [];
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        const lines = this.lines;
        this.lines = [];
        this.size = 0;
        if (lines.length && emit(lines) === false) return;
      } else {
        this.lines.push(line);
      }
      start = end + 1;
    }
  }

  get pending(): boolean { return this.size > 0; }
}

function responseUsage(ctx: ProxyContext, obj: any): TokenUsage | null {
  const usage = obj?.response?.usage ?? obj?.usage;
  if (!usage || typeof usage !== "object") return null;
  const parsed = parseUsageBlocks("openai", [usage]);
  if (parsed) return parsed;
  if (usage.input_tokens === 0 && usage.output_tokens === 0) {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_read_included_in_input: true };
  }
  return null;
}

function maskEnvelope(ctx: ProxyContext, obj: any): boolean {
  let changed = false;
  for (const envelope of [obj, obj?.response]) {
    if (!envelope || typeof envelope !== "object") continue;
    if (typeof envelope.model === "string" && envelope.model !== ctx.visibleModel) {
      envelope.model = ctx.visibleModel;
      changed = true;
    }
    if (envelope.error && typeof envelope.error === "object") {
      redactErrorStrings(ctx, envelope.error);
      changed = true;
    }
    if (envelope.type === "error") {
      redactErrorStrings(ctx, envelope);
      changed = true;
    }
  }
  return changed;
}

function redactErrorStrings(ctx: ProxyContext, obj: Record<string, any>) {
  const terms = upstreamIdentityTerms(ctx);
  const pending = [obj];
  while (pending.length) {
    const node = pending.pop()!;
    for (const key of Object.keys(node)) {
      if (typeof node[key] === "string") node[key] = redactUpstreamIdentity(node[key], terms);
      else if (node[key] && typeof node[key] === "object") pending.push(node[key]);
    }
  }
}

function estimatedUsage(ctx: ProxyContext, outputChars: number, received: boolean): TokenUsage | null {
  if (!received) return null;
  const input = ctx.estimatedInputTokens ?? 1;
  const output = Math.ceil(outputChars / 4);
  console.warn(`[responses] estimated usage for request ${ctx.requestId}; upstream usage unavailable`);
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

function outputCharacterCount(obj: any): number {
  let chars = 0;
  if (!Array.isArray(obj?.output)) return chars;
  for (const item of obj.output) {
    if (typeof item?.arguments === "string") chars += item.arguments.length;
    if (typeof item?.input === "string") chars += item.input.length;
    for (const parts of [item?.content, item?.summary]) {
      if (Array.isArray(parts)) for (const part of parts) if (typeof part?.text === "string") chars += part.text.length;
    }
  }
  return chars;
}

async function readBounded(res: Response, onBytes: (bytes: number) => void): Promise<{ text: string; bytes: number }> {
  if (!res.body) throw new Error("responses_empty_body");
  const declared = Number(res.headers.get("content-length"));
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const parts: string[] = [];
  let bytes = 0;
  try {
    if (declared > MAX_NATIVE_JSON_BYTES) throw new Error("responses_body_too_large");
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      bytes += read.value.byteLength;
      onBytes(bytes);
      if (bytes > MAX_NATIVE_JSON_BYTES) throw new Error("responses_body_too_large");
      parts.push(decoder.decode(read.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return { text: parts.join(""), bytes };
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}

export async function relayNativeResponsesJson(
  ctx: ProxyContext,
  upstream: Response,
  stop: () => void,
  expectedStream = false,
  validateOutput?: (obj: any) => void
): Promise<Response> {
  let receivedBytes = 0;
  let measuredUsage: TokenUsage | null = null;
  try {
    const { text } = await readBounded(upstream, (bytes) => { receivedBytes = bytes; });
    let obj: any;
    try { obj = JSON.parse(text); } catch {
      if (upstream.ok) throw new Error("invalid_responses_body");
    }
    if (!upstream.ok) {
      ctx.latencyMs = Date.now() - ctx.startedAt;
      await completeBilling(ctx.c, record(ctx, null, upstream.status));
      const headers = cleanResponseHeaders(upstream.headers);
      let masked: string;
      if (obj && typeof obj === "object") {
        maskEnvelope(ctx, obj);
        redactErrorStrings(ctx, obj);
        masked = JSON.stringify(obj);
      } else masked = redactUpstreamIdentity(text, upstreamIdentityTerms(ctx));
      return new Response(masked, { status: upstream.status, headers });
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj) ||
        (upstream.ok && (obj.object !== "response" || !["completed", "incomplete", "failed"].includes(obj.status)))) {
      throw new Error("invalid_responses_body");
    }
    ctx.billingAttempt?.observeJson(obj);
    const reportedUsage = responseUsage(ctx, obj);
    const outputChars = reportedUsage ? 0 : outputCharacterCount(obj);
    const usage = reportedUsage ?? estimatedUsage(ctx, outputChars, obj.status !== "failed" || outputChars > 0);
    measuredUsage = usage;
    if (obj.status !== "failed") validateOutput?.(obj);
    const changed = maskEnvelope(ctx, obj);
    ctx.latencyMs = Date.now() - ctx.startedAt;
    const status = expectedStream || obj.status === "failed" ? 502 : upstream.status;
    await completeBilling(ctx.c, record(ctx, usage, status));
    if (expectedStream) return ctx.c.json({ error: "invalid_upstream_response", message: "Expected a Responses SSE stream, but upstream returned JSON." }, 502);
    const headers = cleanResponseHeaders(upstream.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    if (!reportedUsage) headers.set("x-gateway-usage-estimated", "true");
    return new Response(changed ? JSON.stringify(obj) : text, { status, headers });
  } catch {
    ctx.latencyMs = Date.now() - ctx.startedAt;
    ctx.billingAttempt?.mark("upstream_error");
    await completeBilling(ctx.c, record(ctx, measuredUsage ?? (upstream.ok ? estimatedUsage(ctx, receivedBytes, receivedBytes > 0) : null), 502));
    return ctx.c.json({ error: "invalid_upstream_response", message: "Upstream returned an invalid or oversized Responses body." }, 502);
  } finally {
    stop();
  }
}

export function relayNativeResponsesStream(ctx: ProxyContext, upstream: Response, stop: () => void, validateEvent?: (obj: any) => void): Response {
  if (!upstream.body) {
    stop();
    waitUntil(ctx.c, record(ctx, null, 502));
    return ctx.c.json({ error: "invalid_upstream_response" }, 502);
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const encoder = new TextEncoder();
  const framer = new ResponsesEventFramer();
  let usage: TokenUsage | null = null;
  let outputChars = 0;
  let received = false;
  let terminal = false;
  let closed = false;
  let responseId = `resp_${ctx.requestId}`;
  let sequence = -1;
  let status = upstream.status;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const finalization = done.then(async () => {
    ctx.latencyMs = Date.now() - ctx.startedAt;
    await record(ctx, usage ?? estimatedUsage(ctx, outputChars, received), status);
  });
  waitUntil(ctx.c, finalization);

  async function finish() {
    if (!closed) { closed = true; stop(); resolveDone(); }
    await finalization;
  }

  function emit(lines: string[], ctrl: ReadableStreamDefaultController<Uint8Array>) {
    const data: string[] = [];
    let event = "";
    for (const line of lines) {
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:")) event = line.slice(6).trim();
    }
    if (!data.length) {
      ctrl.enqueue(encoder.encode(lines.join("\n") + "\n\n"));
      return;
    }
    const payload = data.join("\n");
    if (payload === "[DONE]") {
      if (!terminal) throw new Error("responses_missing_terminal");
      return;
    }
    const obj = JSON.parse(payload);
    if (!obj || typeof obj !== "object" || typeof obj.type !== "string") throw new Error("invalid_responses_event");
    if (terminal) return;
    if (event && event !== obj.type) throw new Error("responses_event_type_mismatch");
    if (["response.completed", "response.incomplete", "response.failed"].includes(obj.type) &&
        (obj.response?.object !== "response" || obj.response.status !== obj.type.slice("response.".length))) {
      throw new Error("invalid_responses_terminal");
    }
    if (Number.isSafeInteger(obj.sequence_number)) sequence = Math.max(sequence, obj.sequence_number);
    if (typeof obj.response?.id === "string") responseId = obj.response.id;
    const parsed = responseUsage(ctx, obj);
    if (parsed) {
      if (!usage) usage = parsed;
      else {
        for (const key of ["input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"] as const) {
          usage[key] = Math.max(usage[key] ?? 0, parsed[key] ?? 0);
        }
      }
    }
    validateEvent?.(obj);
    if (typeof obj.delta === "string" && obj.delta.length) {
      outputChars += obj.delta.length;
      received = true;
    }
    if (["response.completed", "response.incomplete", "response.failed", "error"].includes(obj.type)) {
      if (outputChars === 0) outputChars = outputCharacterCount(obj.response);
      received ||= obj.type === "response.completed" || obj.type === "response.incomplete" || outputChars > 0;
      terminal = true;
      if (obj.type === "response.failed" || obj.type === "error") status = 502;
    }
    const changed = maskEnvelope(ctx, obj);
    ctrl.enqueue(encoder.encode(changed
      ? lines.filter((line) => !line.startsWith("data:")).join("\n") + "\ndata: " + JSON.stringify(obj) + "\n\n"
      : lines.join("\n") + "\n\n"));
    if (terminal) return false;
  }

  function fail(ctrl: ReadableStreamDefaultController<Uint8Array>) {
    status = 502;
    if (terminal) return;
    terminal = true;
    const obj = {
      type: "response.failed", sequence_number: sequence + 1,
      response: {
        id: responseId, object: "response", created_at: Math.floor(ctx.createdAt / 1000),
        status: "failed", model: ctx.visibleModel, output: [], usage: null,
        error: { code: "upstream_stream_error", message: "The upstream Responses stream ended before a valid terminal event." },
      },
    };
    ctrl.enqueue(encoder.encode(`event: response.failed\ndata: ${JSON.stringify(obj)}\n\n`));
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (closed) return;
      try {
        while (!closed) {
          const read = await reader.read();
          if (closed) return;
          let emitted = false;
          if (!read.done) framer.feed(decoder.decode(read.value, { stream: true }), (lines) => {
            emitted = true;
            return emit(lines, ctrl);
          });
          if (read.done) {
            framer.feed(decoder.decode(), (lines) => emit(lines, ctrl));
            if (!terminal || framer.pending) fail(ctrl);
          }
          if (read.done || terminal) {
            await finish();
            ctrl.close();
            void reader.cancel().catch(() => {});
            return;
          }
          if (emitted) return;
        }
      } catch {
        if (closed) return;
        fail(ctrl);
        await finish();
        ctrl.close();
        void reader.cancel().catch(() => {});
      }
    },
    async cancel(reason) {
      if (!terminal) status = 499;
      await finish();
      return reader.cancel(reason).catch(() => {});
    },
  });
  const headers = cleanResponseHeaders(upstream.headers);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");
  return new Response(body, { status: upstream.status, headers });
}
