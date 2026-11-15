import type { TokenUsage } from "../src/types";

export interface UsageSnapshot {
  usage: TokenUsage | null;
  source: "reported_final" | "reported_partial" | "unknown";
  provenance: Record<string, string>;
  completed: boolean;
  failed: boolean;
  upstreamRequestId: string | null;
}

type Protocol = "messages" | "chat/completions" | "responses";
type UsageField = "input_tokens" | "output_tokens" | "total_tokens" | "cache_read_tokens"
  | "cache_write_tokens" | "reasoning_tokens" | "search_calls";
type Obj = Record<string, unknown>;

const MAX_FRAME_CHARS = 64 * 1024;
const DECODE_SLICE_BYTES = 4096;
const MAX_REQUEST_ID_CHARS = 256;

function object(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export class BaselineUsageAccumulator {
  private readonly decoder = new TextDecoder();
  private mode: "unknown" | "sse" | "json" = "unknown";
  private line = "";
  private json = "";
  private data: string[] = [];
  private eventName = "";
  private frameChars = 0;
  private dropping = false;
  private afterCR = false;
  private finished = false;
  private completed = false;
  private failed = false;
  private upstreamRequestId: string | null = null;
  private readonly fields: Partial<Record<UsageField, number>> = {};
  private readonly provenance: Record<string, string> = {};

  constructor(private readonly protocol: Protocol) {}

  push(chunk: Uint8Array): void {
    if (this.finished) return;
    for (let at = 0; at < chunk.byteLength; at += DECODE_SLICE_BYTES) {
      this.consume(this.decoder.decode(chunk.subarray(at, at + DECODE_SLICE_BYTES), { stream: true }));
    }
  }

  observeJson(obj: unknown): void {
    if (!this.finished) this.observeEnvelope(obj, "");
  }

  finish(): UsageSnapshot {
    if (!this.finished) {
      this.consume(this.decoder.decode());
      if (this.mode === "json") {
        if (!this.dropping && this.json.trim()) this.parseJson(this.json, "");
      } else {
        if (this.line) this.consumeLine();
        this.dispatchEvent();
      }
      this.line = "";
      this.json = "";
      this.data = [];
      this.eventName = "";
      this.finished = true;
    }
    return this.snapshot();
  }

  snapshot(): UsageSnapshot {
    const provenance = { ...this.provenance };
    const hasUsage = Object.keys(this.fields).length > 0;
    let usage: TokenUsage | null = null;
    if (hasUsage) {
      const input = this.fields.input_tokens ?? 0;
      const output = this.fields.output_tokens ?? 0;
      const outside = this.protocol === "messages"
        ? (this.fields.cache_read_tokens ?? 0) + (this.fields.cache_write_tokens ?? 0) : 0;
      usage = {
        input_tokens: input,
        output_tokens: output,
        total_tokens: this.fields.total_tokens ?? input + output + outside,
        cache_read_included_in_input: this.protocol !== "messages",
      };
      if (this.fields.total_tokens === undefined) provenance.total_tokens = "derived:reported_fields";
      provenance.cache_read_included_in_input = `wire:${this.protocol}`;
      for (const key of ["cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "search_calls"] as const) {
        if (this.fields[key] !== undefined) usage[key] = this.fields[key];
      }
    }
    return {
      usage,
      source: !hasUsage ? "unknown" : this.completed && !this.failed
        && this.fields.input_tokens !== undefined && this.fields.output_tokens !== undefined
        ? "reported_final" : "reported_partial",
      provenance,
      completed: this.completed && !this.failed,
      failed: this.failed,
      upstreamRequestId: this.upstreamRequestId,
    };
  }

  private consume(text: string): void {
    if (this.mode === "unknown") {
      const first = text.search(/\S/);
      if (first < 0) return;
      this.mode = text[first] === "{" || text[first] === "[" ? "json" : "sse";
      text = text.slice(first);
    }
    if (this.mode === "json") {
      if (!this.dropping && this.json.length + text.length <= MAX_FRAME_CHARS) this.json += text;
      else { this.json = ""; this.dropping = true; }
      return;
    }
    let from = 0;
    for (let at = 0; at < text.length; at++) {
      const code = text.charCodeAt(at);
      if (this.afterCR) {
        this.afterCR = false;
        if (code === 10) { from = at + 1; continue; }
      }
      if (code !== 10 && code !== 13) continue;
      this.appendLine(text.slice(from, at));
      this.consumeLine();
      this.afterCR = code === 13;
      from = at + 1;
    }
    this.appendLine(text.slice(from));
  }

  private appendLine(part: string): void {
    this.frameChars = Math.min(MAX_FRAME_CHARS + 1, this.frameChars + part.length);
    if (!this.dropping && this.frameChars > MAX_FRAME_CHARS) {
      this.dropping = true;
      this.line = "";
      this.data = [];
      this.eventName = "";
    }
    if (!this.dropping) this.line += part;
    else if (part.length) this.line = "x";
  }

  private consumeLine(): void {
    const line = this.line;
    this.line = "";
    if (!line) { this.dispatchEvent(); return; }
    if (this.dropping) return;
    this.frameChars++;
    const colon = line.indexOf(":");
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "data") this.data.push(value);
    else if (name === "event") this.eventName = value.slice(0, 128);
  }

  private dispatchEvent(): void {
    if (!this.dropping) {
      this.observeTerminal(this.eventName);
      const payload = this.data.join("\n").trim();
      if (payload === "[DONE]") {
        if (!this.failed) this.completed = true;
      } else if (payload) this.parseJson(payload, this.eventName);
      else this.observeTerminal(this.eventName);
    }
    this.data = [];
    this.eventName = "";
    this.frameChars = 0;
    this.dropping = false;
  }

  private parseJson(text: string, eventName: string): void {
    this.observeTerminal(eventName);
    try { this.observeEnvelope(JSON.parse(text), eventName); } catch {   }
  }

  private observeTerminal(type: string): void {
    if (type === "error" || type === "response.error" || type === "response.failed" || type === "response.incomplete") {
      this.failed = true;
      this.completed = false;
    } else if (!this.failed && (this.protocol === "messages" && (type === "message_stop" || type === "messages_stop")
      || this.protocol === "responses" && type === "response.completed")) this.completed = true;
  }

  private observeEnvelope(value: unknown, eventName: string): void {
    const obj = object(value);
    if (!obj) return;
    const type = typeof obj.type === "string" ? obj.type : eventName;
    this.observeTerminal(type);
    const isEnvelope = !type || type === "error" || type === "response.error" || (this.protocol === "messages"
      ? type === "message" || type === "message_start" || type === "message_delta"
        || type === "message_stop" || type === "messages_stop"
      : this.protocol === "responses" ? type === "response" || type === "response.created"
        || type === "response.in_progress" || type === "response.queued"
        || type === "response.completed" || type === "response.failed" || type === "response.incomplete"
        : type === "chat.completion" || type === "chat.completion.chunk");
    if (!isEnvelope) return;
    this.captureRequestId(obj);
    if (obj.error !== undefined && obj.error !== null && obj.error !== false) this.observeTerminal("error");
    if (this.protocol === "messages") {
      if (type === "message_start") {
        const message = object(obj.message);
        if (message) { this.captureRequestId(message); this.observeUsage(object(message.usage), "message.usage"); }
      } else this.observeUsage(object(obj.usage), "usage");
      if (type === "message" && obj.stop_reason != null && !this.failed) this.completed = true;
    } else if (this.protocol === "responses") {
      const response = object(obj.response);
      if (response) {
        this.captureRequestId(response);
        this.observeUsage(object(response.usage), "response.usage");
        this.observeResponseStatus(response);
      } else {
        this.observeUsage(object(obj.usage), "usage");
        this.observeResponseStatus(obj);
      }
    } else {
      this.observeUsage(object(obj.usage), "usage");
      if (obj.object === "chat.completion" && !this.failed) this.completed = true;
    }
  }

  private observeResponseStatus(obj: Obj): void {
    if (obj.status === "failed" || obj.status === "incomplete" || obj.error != null) this.observeTerminal("error");
    else if (obj.status === "completed" && !this.failed) this.completed = true;
  }

  private captureRequestId(obj: Obj): void {
    for (const key of ["request_id", "_request_id", "upstream_request_id"]) {
      const value = obj[key];
      if (typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_CHARS
        && !/[\u0000-\u001f\u007f]/.test(value)) { this.upstreamRequestId = value; return; }
    }
  }

  private observeUsage(usage: Obj | null, path: string): void {
    if (!usage) return;
    const report = (field: UsageField, parent: Obj | null, key: string, prefix = path): boolean => {
      const value = count(parent?.[key]);
      if (value === undefined) return false;
      this.fields[field] = value;
      this.provenance[field] = `${prefix}.${key}`;
      return true;
    };
    if (this.protocol === "chat/completions") {
      if (!report("input_tokens", usage, "prompt_tokens")) report("input_tokens", usage, "input_tokens");
      if (!report("output_tokens", usage, "completion_tokens")) report("output_tokens", usage, "output_tokens");
    } else {
      report("input_tokens", usage, "input_tokens");
      report("output_tokens", usage, "output_tokens");
    }
    report("total_tokens", usage, "total_tokens");
    if (this.protocol === "messages") {
      report("cache_read_tokens", usage, "cache_read_input_tokens");
      if (!report("cache_write_tokens", usage, "cache_creation_input_tokens")) {
        const creation = object(usage.cache_creation);
        const short = count(creation?.ephemeral_5m_input_tokens);
        const long = count(creation?.ephemeral_1h_input_tokens);
        if (short !== undefined || long !== undefined) {
          if (short !== undefined) {
            this.cache5m = short;
            this.provenance.cache_creation_5m = `${path}.cache_creation.ephemeral_5m_input_tokens`;
          }
          if (long !== undefined) {
            this.cache1h = long;
            this.provenance.cache_creation_1h = `${path}.cache_creation.ephemeral_1h_input_tokens`;
          }
          this.fields.cache_write_tokens = this.cache5m + this.cache1h;
          this.provenance.cache_write_tokens = `${path}.cache_creation`;
        }
      }
      report("reasoning_tokens", object(usage.output_tokens_details), "thinking_tokens", `${path}.output_tokens_details`);
      report("search_calls", object(usage.server_tool_use), "web_search_requests", `${path}.server_tool_use`);
    } else {
      const inputKey = this.protocol === "responses" ? "input_tokens_details" : "prompt_tokens_details";
      const outputKey = this.protocol === "responses" ? "output_tokens_details" : "completion_tokens_details";
      if (!report("cache_read_tokens", object(usage[inputKey]), "cached_tokens", `${path}.${inputKey}`)) {
        report("cache_read_tokens", usage, "cached_tokens");
      }
      report("reasoning_tokens", object(usage[outputKey]), "reasoning_tokens", `${path}.${outputKey}`);
    }
  }

  private cache5m = 0;
  private cache1h = 0;
}
