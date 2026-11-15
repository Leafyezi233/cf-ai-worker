
const PROVIDER_HEADER_NAMES = new Set([
  "server",
  "via",
  "x-request-id",
  "request-id",
  "x-requestid",
  "x-amzn-requestid",
  "x-llm-provider",
  "x-upstream",
  "x-served-by",
  "x-openai-processing-ms",
]);

const PROVIDER_HEADER_PREFIXES = ["openai-", "anthropic-", "x-goog-", "x-llm-", "x-gemini-", "x-ratelimit-"];

export function stripProviderHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (PROVIDER_HEADER_NAMES.has(k)) return;
    if (PROVIDER_HEADER_PREFIXES.some((prefix) => k.startsWith(prefix))) return;
    out.set(key, value);
  });
  return out;
}

const MAX_MODEL_STAMP_DEPTH = 4;

const MAX_MASK_PENDING_CHARS = 256 * 1024;

export function stampModel(node: any, publicModel: string, depth = 0): boolean {
  if (!node || typeof node !== "object" || Array.isArray(node) || depth > MAX_MODEL_STAMP_DEPTH) return false;
  let changed = false;
  if (typeof node.model === "string" && node.model !== publicModel) {
    node.model = publicModel;
    changed = true;
  }
  for (const key of ["message", "response"]) {
    if (node[key] && typeof node[key] === "object" && stampModel(node[key], publicModel, depth + 1)) {
      changed = true;
    }
  }
  return changed;
}

export function maskJsonBody<T>(body: T, publicModel: string): T {
  if (!body || typeof body !== "object") return body;
  stampModel(body, publicModel);
  return body;
}

export function maskJsonText(text: string, publicModel: string): string {
  if (!text.includes(MODEL_KEY_LITERAL)) return text;
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return maskUnparseableModelValues(text, publicModel);
  }
  if (!stampModel(parsed, publicModel)) return text;
  return JSON.stringify(parsed);
}

const SSE_DATA_PREFIX = "data:";

const MODEL_VALUE_RE = /"model"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

const MODEL_KEY_LITERAL = '"model"';

function unescapeJsonString(raw: string): string {
  try {
    return JSON.parse('"' + raw + '"');
  } catch {
    return raw;
  }
}
const MODEL_KEY_SCAN_RE = /"model"/g;
const JSON_WS = new Set([" ", "\t", "\n", "\r"]);

export function maskUnparseableModelValues(text: string, publicModel: string): string {
  if (!text.includes(MODEL_KEY_LITERAL)) return text;
  const replacement = '"' + publicModel + '"';
  const spans: Array<[number, number]> = [];
  let searchFrom = 0;

  for (;;) {
    MODEL_KEY_SCAN_RE.lastIndex = searchFrom;
    const match = MODEL_KEY_SCAN_RE.exec(text);
    if (!match) break;
    const at = match.index;

    let before = at - 1;
    while (before >= 0 && JSON_WS.has(text[before])) before--;
    if (before < 0 || (text[before] !== "{" && text[before] !== ",")) {
      searchFrom = at + MODEL_KEY_LITERAL.length;
      continue;
    }

    let cursor = at + MODEL_KEY_LITERAL.length;
    while (cursor < text.length && JSON_WS.has(text[cursor])) cursor++;
    if (text[cursor] !== ":") {
      searchFrom = at + MODEL_KEY_LITERAL.length;
      continue;
    }
    cursor++;
    while (cursor < text.length && JSON_WS.has(text[cursor])) cursor++;
    if (text[cursor] !== '"') {
      searchFrom = at + MODEL_KEY_LITERAL.length;
      continue;
    }

    const closing = findJsonStringEnd(text, cursor);
    const raw = unescapeJsonString(text.slice(cursor + 1, closing));
    if (raw !== publicModel) spans.push([cursor, closing + 1]);
    searchFrom = closing + 1;
  }

  if (!spans.length) return text;
  let out = "";
  let last = 0;
  for (const [start, end] of spans) {
    out += text.slice(last, start) + replacement;
    last = end;
  }
  return out + text.slice(last);
}

function findJsonStringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"') return i;
  }
  return text.length;
}

type ModelValueScan = "foreign" | "same" | "none";

function scanModelValues(line: string, publicModel: string): ModelValueScan {
  MODEL_VALUE_RE.lastIndex = 0;
  let seen = false;
  let match: RegExpExecArray | null;
  while ((match = MODEL_VALUE_RE.exec(line)) !== null) {
    seen = true;
    if (match[1] !== publicModel) return "foreign";
  }
  return seen ? "same" : "none";
}

function maskSseLine(line: string, publicModel: string): string {
  if (!line.includes(MODEL_KEY_LITERAL)) return line;

  const isData = line.startsWith(SSE_DATA_PREFIX);
  const payload = isData ? line.slice(SSE_DATA_PREFIX.length).trim() : line;

  if (isData) {
    if (scanModelValues(payload, publicModel) === "same") return line;
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return applyFallbackMask(line, payload, publicModel, isData);
    }
    if (!stampModel(parsed, publicModel)) return line;
    return SSE_DATA_PREFIX + " " + JSON.stringify(parsed);
  }

  return applyFallbackMask(line, payload, publicModel, isData);
}

export function applyFallbackMask(line: string, payload: string, publicModel: string, isData: boolean): string {
  const masked = maskUnparseableModelValues(payload, publicModel);
  if (masked === payload) return line;
  return isData ? SSE_DATA_PREFIX + " " + masked : masked;
}

export function modelMaskingTransform(publicModel: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const buffered = pending.length;
      pending += text;
      const newlineInChunk = text.lastIndexOf("\n");
      const cut = newlineInChunk < 0 ? -1 : buffered + newlineInChunk;
      if (cut < 0) {
        if (pending.length > MAX_MASK_PENDING_CHARS) {
          controller.enqueue(encoder.encode(maskSseLine(pending, publicModel)));
          pending = "";
        }
        return;
      }
      const block = pending.slice(0, cut + 1);
      pending = pending.slice(cut + 1);
      let out = "";
      let from = 0;
      for (;;) {
        const nl = block.indexOf("\n", from);
        if (nl < 0) break;
        out += maskSseLine(block.slice(from, nl), publicModel) + "\n";
        from = nl + 1;
      }
      controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(maskSseLine(pending, publicModel)));
    },
  });
}
const REDACTED_PROVIDER = "upstream";

const IDENTITY_EDGE_CLASS = "[A-Za-z0-9_./-]";

export interface UpstreamIdentityTerms {
  providerName?: string | null;
  providerId?: string | null;
  upstreamModel?: string | null;
  publicModel: string;
}

interface RedactionNeedle {
  pattern: RegExp;
  replacement: string;
  length: number;
  lower: string;
}

const REGEX_SPECIALS = [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"].join("");

function escapeRegExp(text: string): string {
  let out = "";
  for (const ch of text) {
    if (REGEX_SPECIALS.includes(ch)) out += "\\";
    out += ch;
  }
  return out;
}

function redactionNeedles(terms: UpstreamIdentityTerms): RedactionNeedle[] {
  const pairs: Array<[string | null | undefined, string]> = [
    [terms.providerName, REDACTED_PROVIDER],
    [terms.providerId, REDACTED_PROVIDER],
    [terms.upstreamModel, terms.publicModel],
  ];
  const out: RedactionNeedle[] = [];
  const seen = new Set<string>();
  for (const [raw, replacement] of pairs) {
    const needle = typeof raw === "string" ? raw.trim() : "";
    if (needle.length < 2 || needle === replacement) continue;
    const key = needle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      pattern: new RegExp(
        "(?<!" + IDENTITY_EDGE_CLASS + ")" + escapeRegExp(needle) + "(?!" + IDENTITY_EDGE_CLASS + ")",
        "gi"
      ),
      replacement,
      length: needle.length,
      lower: key,
    });
  }
  return out;
}

function applyRedaction(text: string, needles: RedactionNeedle[]): string {
  if (!needles.length || !text) return text;
  let out = text;
  for (const { pattern, replacement } of needles) {
    out = out.replace(pattern, () => replacement);
  }
  return out;
}

export function redactUpstreamIdentity(text: string, terms: UpstreamIdentityTerms): string {
  return applyRedaction(text, redactionNeedles(terms));
}

function safeEmitCut(pending: string, needles: RedactionNeedle[], maxLength: number): number {
  const hold = Math.max(0, maxLength - 1) + 1;
  let cut = pending.length - hold;
  if (cut <= 0) return 0;
  const lowest = Math.max(0, cut - (maxLength - 1));
  for (let at = cut - 1; at >= lowest; at--) {
    const fragment = pending.slice(at, cut).toLowerCase();
    if (needles.some((needle) => needle.lower.startsWith(fragment))) cut = at;
  }
  return Math.max(0, cut);
}

export function identityRedactionTransform(
  terms: UpstreamIdentityTerms
): TransformStream<Uint8Array, Uint8Array> {
  const needles = redactionNeedles(terms);
  const maxLength = needles.reduce((max, needle) => Math.max(max, needle.length), 0);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      if (!needles.length) {
        controller.enqueue(encoder.encode(pending));
        pending = "";
        return;
      }
      const cut = safeEmitCut(pending, needles, maxLength);
      if (cut <= 0) return;
      const emit = pending.slice(0, cut);
      pending = pending.slice(cut);
      controller.enqueue(encoder.encode(applyRedaction(emit, needles)));
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(applyRedaction(pending, needles)));
    },
  });
}
