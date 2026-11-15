import { isReasoningModel } from "./catalog";
import { asciiLowerCode, indexOfCaseInsensitive } from "./text_scan";
import { reasoningTextFromNode, reasoningFromDetails } from "./thinking_sse";
import { THINK_TAG_NAMES } from "./thinking";
import { outputTokenLimit } from "./token_fields";
import type { TokenUsage } from "../types";
import { UsageAccumulator, type UsageSnapshot } from "./usage_accumulator";

export interface ParsedToolCall {
  callId: string;
  name: string;
  arguments: Record<string, any>;
}


const DSML_WS = /\s/;

function dsmlIsWs(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  if (code < 128) {
    return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
  }
  return DSML_WS.test(text[at]);
}

function dsmlSkipWs(text: string, from: number): number {
  let i = from;
  while (i < text.length && dsmlIsWs(text, i)) i++;
  return i;
}

function dsmlStartsWithCI(text: string, at: number, word: string): boolean {
  if (at + word.length > text.length) return false;
  for (let i = 0; i < word.length; i++) {
    if (asciiLowerCode(text.charCodeAt(at + i)) !== word.charCodeAt(i)) return false;
  }
  return true;
}

function dsmlOpenPrefixEnd(text: string, at: number, keyword: string): number {
  if (text.charCodeAt(at) !== 60) return -1;
  let p = dsmlSkipWs(text, at + 1);
  if (text.charCodeAt(p) !== 124) return -1;
  p = dsmlSkipWs(text, p + 1);
  if (!dsmlStartsWithCI(text, p, "dsml")) return -1;
  p = dsmlSkipWs(text, p + 4);
  if (text.charCodeAt(p) !== 124) return -1;
  p = dsmlSkipWs(text, p + 1);
  if (!dsmlStartsWithCI(text, p, keyword)) return -1;
  return p + keyword.length;
}

function dsmlClosePrefixEnd(text: string, at: number, keyword: string): number {
  if (text.charCodeAt(at) !== 60) return -1;
  let p = dsmlSkipWs(text, at + 1);
  if (text.charCodeAt(p) !== 47) return -1;
  p = dsmlSkipWs(text, p + 1);
  if (text.charCodeAt(p) !== 124) return -1;
  p = dsmlSkipWs(text, p + 1);
  if (!dsmlStartsWithCI(text, p, "dsml")) return -1;
  p = dsmlSkipWs(text, p + 4);
  if (text.charCodeAt(p) !== 124) return -1;
  p = dsmlSkipWs(text, p + 1);
  if (!dsmlStartsWithCI(text, p, keyword)) return -1;
  return p + keyword.length;
}

interface DsmlTagSpan {
  start: number;
  end: number;
}

function dsmlCloseTagAt(text: string, at: number, keyword: string): DsmlTagSpan | null {
  const after = dsmlClosePrefixEnd(text, at, keyword);
  if (after === -1) return null;
  const gt = dsmlSkipWs(text, after);
  if (text.charCodeAt(gt) === 62) return { start: at, end: gt + 1 };
  return null;
}

const MAX_DSML_TAG_PROBE_CHARS = 64;

function probeDsmlCloseTag(
  text: string,
  at: number,
  keyword: string
): DsmlTagSpan | null | "incomplete" {
  const tokens = ["<", "/", "|", "DSML", "|", keyword, ">"];
  const hardEnd = text.length;
  const end = Math.min(hardEnd, at + MAX_DSML_TAG_PROBE_CHARS);
  let p = at;

  for (let t = 0; t < tokens.length; t++) {
    if (t > 0) {
      while (p < end && dsmlIsWs(text, p)) p++;
    }
    const token = tokens[t];
    for (let i = 0; i < token.length; i++) {
      if (p >= end) return p >= hardEnd ? "incomplete" : null;
      if (asciiLowerCode(text.charCodeAt(p)) !== asciiLowerCode(token.charCodeAt(i))) return null;
      p++;
    }
  }

  return { start: at, end: p };
}
function findDsmlCloseTag(text: string, from: number, keyword: string): DsmlTagSpan | null {
  let at = text.indexOf("<", from);
  while (at !== -1) {
    const span = dsmlCloseTagAt(text, at, keyword);
    if (span) return span;
    at = text.indexOf("<", at + 1);
  }
  return null;
}

function dsmlReadAttrValue(text: string, at: number): { value: string; end: number } | null {
  const quote = text.charCodeAt(at);
  if (quote !== 34 && quote !== 39) return null;
  let i = at + 1;
  while (i < text.length) {
    if (text.charCodeAt(i) === quote) return { value: text.slice(at + 1, i), end: i + 1 };
    i++;
  }
  return null;
}

function dsmlSkipAttributes(
  text: string,
  from: number
): { gt: number; stringAttr: string } | null {
  let cursor = from;
  let stringAttr = "";
  for (;;) {
    cursor = dsmlSkipWs(text, cursor);
    if (cursor >= text.length) return null;
    if (text.charCodeAt(cursor) === 62) return { gt: cursor, stringAttr };

    const keyStart = cursor;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code === 61 || code === 62 || dsmlIsWs(text, cursor)) break;
      cursor++;
    }
    if (cursor === keyStart) return null;
    const key = text.slice(keyStart, cursor);

    cursor = dsmlSkipWs(text, cursor);
    if (text.charCodeAt(cursor) !== 61) continue;
    cursor = dsmlSkipWs(text, cursor + 1);

    let value: string;
    const attr = dsmlReadAttrValue(text, cursor);
    if (attr) {
      value = attr.value;
      cursor = attr.end;
    } else {
      const valueStart = cursor;
      while (cursor < text.length) {
        const code = text.charCodeAt(cursor);
        if (code === 62 || dsmlIsWs(text, cursor)) break;
        cursor++;
      }
      if (cursor === valueStart) return null;
      value = text.slice(valueStart, cursor);
    }
    if (key === "string") stringAttr = value;
  }
}

interface DsmlBlockSpan {
  blockStart: number;
  blockEnd: number;
  innerStart: number;
  innerEnd: number;
}

function findDsmlBlock(text: string): DsmlBlockSpan | null {
  let at = text.indexOf("<");
  while (at !== -1) {
    const after = dsmlOpenPrefixEnd(text, at, "tool_calls");
    if (after !== -1) {
      const gt = dsmlSkipWs(text, after);
      if (text.charCodeAt(gt) === 62) {
        const innerStart = gt + 1;
        const close = findDsmlCloseTag(text, innerStart, "tool_calls");
        if (!close) return null;
        return { blockStart: at, blockEnd: close.end, innerStart, innerEnd: close.start };
      }
    }
    at = text.indexOf("<", at + 1);
  }
  return null;
}

interface DsmlInvokeSpan {
  name: string;
  paramsStart: number;
  paramsEnd: number;
  end: number;
}

function findDsmlInvoke(text: string, from: number): DsmlInvokeSpan | null {
  let at = text.indexOf("<", from);
  while (at !== -1) {
    const after = dsmlOpenPrefixEnd(text, at, "invoke");
    if (after !== -1) {
      const nameAt = dsmlSkipWs(text, after);
      if (nameAt > after && dsmlStartsWithCI(text, nameAt, "name") && text.charCodeAt(nameAt + 4) === 61) {
        const attr = dsmlReadAttrValue(text, nameAt + 5);
        if (attr) {
          const tail = dsmlSkipAttributes(text, attr.end);
          if (tail) {
            const close = findDsmlCloseTag(text, tail.gt + 1, "invoke");
            if (!close) return null;
            return {
              name: attr.value.trim(),
              paramsStart: tail.gt + 1,
              paramsEnd: close.start,
              end: close.end,
            };
          }
        }
      }
    }
    at = text.indexOf("<", at + 1);
  }
  return null;
}

interface DsmlParameterSpan {
  name: string;
  stringAttr: string;
  value: string;
  end: number;
}

function findDsmlParameter(text: string, from: number): DsmlParameterSpan | null {
  let at = text.indexOf("<", from);
  while (at !== -1) {
    const after = dsmlOpenPrefixEnd(text, at, "parameter");
    if (after !== -1) {
      const nameAt = dsmlSkipWs(text, after);
      if (nameAt > after && dsmlStartsWithCI(text, nameAt, "name") && text.charCodeAt(nameAt + 4) === 61) {
        const nameAttr = dsmlReadAttrValue(text, nameAt + 5);
        if (nameAttr) {
          const tail = dsmlSkipAttributes(text, nameAttr.end);
          if (tail) {
            const contentStart = tail.gt + 1;
            const close = findDsmlCloseTag(text, contentStart, "parameter");
            if (!close) return null;
            return {
              name: nameAttr.value.trim(),
              stringAttr: tail.stringAttr,
              value: text.slice(contentStart, close.start),
              end: close.end,
            };
          }
        }
      }
    }
    at = text.indexOf("<", at + 1);
  }
  return null;
}

export function extractDsmlToolCalls(text: string): { cleanContent: string; toolCalls: ParsedToolCall[] } | null {
  const block = findDsmlBlock(text);
  if (!block) return null;

  const innerBlock = text.slice(block.innerStart, block.innerEnd);
  const toolCalls: ParsedToolCall[] = [];

  let invokeCursor = 0;
  for (;;) {
    const invoke = findDsmlInvoke(innerBlock, invokeCursor);
    if (!invoke) break;
    invokeCursor = invoke.end;

    const args: Record<string, any> = {};
    const paramsBlock = innerBlock.slice(invoke.paramsStart, invoke.paramsEnd);
    let paramCursor = 0;
    for (;;) {
      const param = findDsmlParameter(paramsBlock, paramCursor);
      if (!param) break;
      paramCursor = param.end;

      const isString = param.stringAttr.toLowerCase() === "true";
      const isNotString = param.stringAttr.toLowerCase() === "false";
      let paramValue: any = param.value.trim();

      if (isNotString) {
        try {
          paramValue = JSON.parse(paramValue);
        } catch {
        }
      } else if (!isString) {
        if (/^(\[|\{|\d+|true|false|null)/.test(paramValue)) {
          try {
            paramValue = JSON.parse(paramValue);
          } catch {
          }
        }
      }

      args[param.name] = paramValue;
    }

    toolCalls.push({
      callId: "call_" + Math.random().toString(36).slice(2, 11),
      name: invoke.name,
      arguments: args,
    });
  }

  if (toolCalls.length === 0) return null;

  const cleanContent = (text.slice(0, block.blockStart) + text.slice(block.blockEnd)).trim();
  return { cleanContent, toolCalls };
}

export function unsupportedResponsesFields(body: any): string[] {
  const fields: string[] = [];
  if (!body || typeof body !== "object") return fields;
  const present = (key: string) => {
    const value = body[key];
    return value !== undefined && value !== null && value !== "";
  };
  if (present("previous_response_id")) fields.push("previous_response_id");
  if (present("conversation")) fields.push("conversation");
  if (present("context_management")) fields.push("context_management");
  if (body.prompt && typeof body.prompt === "object") fields.push("prompt");
  return fields;
}

const MAX_COMPLETION_TOKENS_MODEL = /(?:^|[\/_.:-])(o[1-9](?:[\/_.:-]|$)|gpt-5(?:[\/_.:-]|$))/i;

export function prefersMaxCompletionTokens(modelName: unknown): boolean {
  return typeof modelName === "string" && MAX_COMPLETION_TOKENS_MODEL.test(modelName);
}

function responsesTextToResponseFormat(text: any): any | null {
  if (!text || typeof text !== "object") return null;
  const format = (text as any).format;
  if (!format || typeof format !== "object") return null;
  const type = typeof format.type === "string" ? format.type : "";
  if (type === "json_object") return { type: "json_object" };
  if (type === "json_schema") {
    const schema: Record<string, any> = { ...format };
    delete schema.type;
    return { type: "json_schema", json_schema: schema };
  }
  return null;
}

function responsesImagePartToChatPart(part: any): any | null {
  const raw = part.image_url ?? part.url;
  const image: Record<string, any> = {};
  if (typeof raw === "string" && raw) image.url = raw;
  else if (raw && typeof raw === "object") {
    if (typeof raw.url === "string" && raw.url) image.url = raw.url;
    if (typeof raw.file_id === "string" && raw.file_id) image.file_id = raw.file_id;
  }
  if (!image.url && typeof part.file_id === "string" && part.file_id) image.file_id = part.file_id;
  if (!image.url && !image.file_id) return null;
  const detail = part.detail ?? (raw && typeof raw === "object" ? raw.detail : undefined);
  if (detail === "auto" || detail === "low" || detail === "high") image.detail = detail;
  return { type: "image_url", image_url: image };
}

function responsesFilePartToChatPart(part: any): any | null {
  const data = typeof part.file_data === "string" ? part.file_data : typeof part.file_url === "string" ? part.file_url : "";
  if (!data) return null;
  return /^data:image\//i.test(data) ? { type: "image_url", image_url: { url: data } } : null;
}

function responsesContentPartsToChat(parts: any[]): string | any[] {
  const textParts: string[] = [];
  let richParts: any[] | null = null;
  const addText = (text: string) => {
    textParts.push(text);
    if (richParts) richParts.push({ type: "text", text });
  };
  const addRich = (part: any) => {
    if (!richParts) richParts = textParts.map((text) => ({ type: "text", text }));
    richParts.push(part);
  };

  for (const part of parts) {
    if (typeof part === "string") {
      addText(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (part.type === "input_image") {
      const image = responsesImagePartToChatPart(part);
      if (image) addRich(image);
      else addText("[image]");
      continue;
    }
    if (part.type === "input_file") {
      const file = responsesFilePartToChatPart(part);
      if (file) addRich(file);
      else addText("[file]");
      continue;
    }
    if (typeof part.text === "string") {
      addText(part.text);
      continue;
    }
    if (typeof part.output_text === "string") {
      addText(part.output_text);
      continue;
    }
    if (typeof part.input_text === "string") {
      addText(part.input_text);
      continue;
    }
    addRich(part);
  }

  return richParts ?? textParts.join("\n");
}

function splitToolOutput(output: any): { text: string; media: any[] } {
  if (typeof output === "string") return { text: output, media: [] };
  if (output === null || output === undefined) return { text: "", media: [] };
  if (!Array.isArray(output)) return { text: JSON.stringify(output), media: [] };

  const texts: string[] = [];
  const labels: string[] = [];
  const media: any[] = [];
  for (const part of output) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") {
      texts.push(part.text);
      continue;
    }
    if (part.type === "input_image") {
      const image = responsesImagePartToChatPart(part);
      if (image) media.push(image);
      labels.push("[image]");
      continue;
    }
    if (part.type === "input_file") {
      const file = responsesFilePartToChatPart(part);
      if (file) media.push(file);
      labels.push("[file]");
      continue;
    }
    texts.push(JSON.stringify(part));
  }
  return { text: texts.join("\n") || labels.join(" "), media };
}

interface ChatMessage {
  role: string;
  content: any;
  tool_calls?: any[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning_details?: unknown[];
}

function appendToolCall(messages: ChatMessage[], callId: string, name: string, args: string): void {
  const last = messages[messages.length - 1];
  const call = { id: callId, type: "function", function: { name, arguments: args } };
  if (last && last.role === "assistant") {
    if (!Array.isArray(last.tool_calls)) last.tool_calls = [];
    last.tool_calls.push(call);
    return;
  }
  messages.push({ role: "assistant", content: null, tool_calls: [call] });
}

function reasoningItemText(item: any): string {
  const fromParts = (value: any): string => {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) {
      if (value && typeof value === "object" && typeof value.text === "string") return value.text;
      return "";
    }
    const parts: string[] = [];
    for (const part of value) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part === "object" && typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("");
  };
  const content = fromParts(item.content);
  if (content.trim()) return content;
  const summary = fromParts(item.summary);
  if (summary.trim()) return summary;
  if (typeof item.text === "string" && item.text.trim()) return item.text;
  return "";
}

function reasoningItemDetails(item: any): unknown[] | undefined {
  const raw = Array.isArray(item?.reasoning_details)
    ? item.reasoning_details
    : Array.isArray(item?.details)
      ? item.details
      : undefined;
  return raw && raw.length > 0 ? raw : undefined;
}

const MAX_REASONING_DETAIL_BLOCKS = 64;
const MAX_REASONING_DETAIL_CHARS = 512 * 1024;

function mergeDetailBlock(blocks: any[], raw: any): void {
  const text = typeof raw.text === "string" ? raw.text : typeof raw.thinking === "string" ? raw.thinking : "";
  const id = typeof raw.id === "string" ? raw.id : "";
  const existing = id ? blocks.find((b: any) => b.id === id) : undefined;
  if (existing) {
    const prev = typeof existing.text === "string" ? existing.text : "";
    if (text && text !== prev) {
      if (text.startsWith(prev) && text.length > prev.length) existing.text = text;
      else existing.text = prev + text;
    }
    if (typeof raw.signature === "string" && raw.signature && !existing.signature) existing.signature = raw.signature;
    if (typeof raw.format === "string" && raw.format && !existing.format) existing.format = raw.format;
    for (const key of Object.keys(raw)) {
      if (!(key in existing)) existing[key] = raw[key];
    }
  } else {
    blocks.push({ ...raw, ...(text && typeof raw.text !== "string" ? { text } : {}) });
  }
}

export function createReasoningDetailsCollector() {
  const blocks: any[] = [];
  let chars = 0;
  let overflowed = false;
  return {
    add(incoming: unknown): void {
      if (overflowed || !Array.isArray(incoming)) return;
      for (const raw of incoming) {
        if (!raw || typeof raw !== "object") continue;
        mergeDetailBlock(blocks, raw);
        const block = raw as any;
        const text = typeof block.text === "string" ? block.text : "";
        chars += text.length;
        if (blocks.length > MAX_REASONING_DETAIL_BLOCKS || chars > MAX_REASONING_DETAIL_CHARS) {
          overflowed = true;
          return;
        }
      }
    },
    result(): unknown[] | undefined {
      return overflowed || blocks.length === 0 ? undefined : blocks;
    },
  };
}

export function convertResponsesRequest(body: any, customConfig?: Record<string, any>): any {
  const messages: ChatMessage[] = [];
  let pendingMedia: any[] = [];
  const flushPendingMedia = () => {
    if (pendingMedia.length === 0) return;
    messages.push({ role: "user", content: pendingMedia });
    pendingMedia = [];
  };
  let pendingReasoning = "";
  let pendingReasoningDetails: unknown[] | undefined = undefined;
  const takeReasoning = (): string | undefined => {
    const text = pendingReasoning;
    pendingReasoning = "";
    return text.trim() ? text : undefined;
  };
  const takeReasoningDetails = (): unknown[] | undefined => {
    const details = pendingReasoningDetails;
    pendingReasoningDetails = undefined;
    return details;
  };
  const attachReasoning = (target: ChatMessage): void => {
    const text = takeReasoning();
    if (text) target.reasoning_content = target.reasoning_content ? target.reasoning_content + "\n" + text : text;
    const details = takeReasoningDetails();
    if (details) target.reasoning_details = details;
  };
  const flushReasoning = (): void => {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant") {
      attachReasoning(last);
      return;
    }
    const text = takeReasoning();
    const details = takeReasoningDetails();
    if (text || details) {
      messages.push({
        role: "assistant",
        content: null,
        ...(text ? { reasoning_content: text } : {}),
        ...(details ? { reasoning_details: details } : {}),
      });
    }
  };

  if (body.instructions && typeof body.instructions === "string") {
    messages.push({ role: "system", content: body.instructions });
  }

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    for (const m of body.messages) {
      if (m && typeof m === "object") {
        messages.push({
          role: m.role || "user",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          tool_calls: m.tool_calls,
          tool_call_id: m.tool_call_id,
          reasoning_content: m.reasoning_content,
          reasoning_details: m.reasoning_details,
        });
      }
    }
  } else if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (typeof item === "string") {
        flushPendingMedia();
        messages.push({ role: "user", content: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;

      if (item.type === "reasoning") {
        const text = reasoningItemText(item);
        if (text) pendingReasoning = pendingReasoning ? pendingReasoning + "\n" + text : text;
        const itemDetails = reasoningItemDetails(item);
        if (itemDetails) {
          pendingReasoningDetails = pendingReasoningDetails ? [...pendingReasoningDetails, ...itemDetails] : itemDetails;
        }
        continue;
      }

      if (item.type === "function_call" || item.type === "custom_tool_call") {
        flushPendingMedia();
        const callId = item.call_id || item.id || "call_" + Math.random().toString(36).slice(2, 9);
        const args =
          item.type === "custom_tool_call"
            ? JSON.stringify({ input: typeof item.input === "string" ? item.input : item.input ?? "" })
            : typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {});
        appendToolCall(messages, callId, item.name || "", args);
        attachReasoning(messages[messages.length - 1]);
        continue;
      }

      if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        const split = splitToolOutput(item.output);
        messages.push({ role: "tool", tool_call_id: item.call_id || item.id, content: split.text });
        if (split.media.length > 0) pendingMedia.push(...split.media);
        continue;
      }

      flushPendingMedia();

      let role = "user";
      if (typeof item.role === "string" && item.role) {
        role = item.role === "developer" ? "system" : item.role;
      } else if (
        item.type === "output_item" ||
        item.type === "assistant" ||
        item.type === "response.output_item" ||
        (typeof item.type === "string" && item.type.includes("output"))
      ) {
        role = "assistant";
      } else if (item.type === "message" && item.role) {
        role = item.role;
      }

      let content: any = item.content ?? item.text ?? "";
      if (Array.isArray(content)) {
        if (!item.role && content.some((c: any) => c && typeof c === "object" && c.type === "output_text")) {
          role = "assistant";
        }
        content = responsesContentPartsToChat(content);
      } else if (typeof content === "object" && content !== null) {
        content = (content as any).text || JSON.stringify(content);
      }
      if (role === "assistant") {
        messages.push({ role, content });
        attachReasoning(messages[messages.length - 1]);
      } else {
        flushReasoning();
        messages.push({ role, content });
      }
    }
  } else if (typeof body.prompt === "string") {
    messages.push({ role: "user", content: body.prompt });
  }

  flushReasoning();
  flushPendingMedia();

  if (messages.length === 0) {
    messages.push({ role: "user", content: "Hello" });
  }

  const cleanBody: Record<string, any> = {
    model: body.model,
    messages,
    stream: body.stream === true,
  };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const normalizedTools: any[] = [];
    for (const t of body.tools) {
      if (!t || typeof t !== "object") continue;

      if (t.type === "function" && t.function && typeof t.function === "object") {
        normalizedTools.push({
          type: "function",
          function: {
            name: t.function.name,
            ...(t.function.description ? { description: t.function.description } : {}),
            ...(t.function.parameters ? { parameters: t.function.parameters } : {}),
            ...(t.function.strict !== undefined ? { strict: t.function.strict } : {}),
          },
        });
        continue;
      }

      const name = t.name || t.function?.name || t.custom?.name;
      if (!name && typeof t.type === "string") {
        normalizedTools.push(t);
        continue;
      }
      if (name && typeof name === "string") {
        const description = t.description || t.function?.description || t.custom?.description;
        const parameters = t.parameters || t.function?.parameters || t.custom?.parameters || { type: "object", properties: {} };
        normalizedTools.push({
          type: "function",
          function: {
            name,
            ...(description ? { description } : {}),
            parameters,
            ...(t.strict !== undefined ? { strict: t.strict } : {}),
          },
        });
      }
    }

    if (normalizedTools.length > 0) {
      cleanBody.tools = normalizedTools;
    }
  }

  if (body.tool_choice) {
    if (typeof body.tool_choice === "string") {
      cleanBody.tool_choice = body.tool_choice;
    } else if (typeof body.tool_choice === "object") {
      const name = body.tool_choice.name || body.tool_choice.function?.name || body.tool_choice.custom?.name;
      if (name) {
        cleanBody.tool_choice = {
          type: "function",
          function: { name },
        };
      } else if (body.tool_choice.type === "function") {
        cleanBody.tool_choice = body.tool_choice;
      }
    }
  }
  const temp = typeof body.temperature === "number" ? body.temperature : customConfig?.temperature;
  if (typeof temp === "number") cleanBody.temperature = temp;

  const topP = typeof body.top_p === "number" ? body.top_p : customConfig?.top_p;
  if (typeof topP === "number") cleanBody.top_p = topP;

  const presencePenalty = typeof body.presence_penalty === "number"
    ? body.presence_penalty
    : customConfig?.presence_penalty;
  if (typeof presencePenalty === "number") cleanBody.presence_penalty = presencePenalty;

  const freqPenalty = typeof body.frequency_penalty === "number"
    ? body.frequency_penalty
    : customConfig?.frequency_penalty;
  if (typeof freqPenalty === "number") cleanBody.frequency_penalty = freqPenalty;

  if (body.stop) cleanBody.stop = body.stop;

  const textFormat = responsesTextToResponseFormat(body.text);
  if (body.response_format) cleanBody.response_format = body.response_format;
  else if (textFormat) cleanBody.response_format = textFormat;

  if (body.seed !== undefined) cleanBody.seed = body.seed;

  if (typeof body.parallel_tool_calls === "boolean") {
    cleanBody.parallel_tool_calls = body.parallel_tool_calls;
  }

  const maxTokens = outputTokenLimit(body);
  if (typeof maxTokens === "number") {
    if (prefersMaxCompletionTokens(body.model)) {
      cleanBody.max_completion_tokens = maxTokens;
    } else {
      cleanBody.max_tokens = maxTokens;
    }
  }

  const effort = body.reasoning?.effort;
  if (typeof effort === "string" && effort.trim()) {
    cleanBody.reasoning_effort = effort.trim();
  }

  return cleanBody;
}

const THINK_OPEN_TAGS = THINK_TAG_NAMES.map((name) => "<" + name + ">");
const THINK_CLOSE_TAGS = THINK_TAG_NAMES.map((name) => "</" + name + ">");

const THINK_TAGS = [...THINK_OPEN_TAGS, ...THINK_CLOSE_TAGS];

function findFirstThinkTag(text: string, closing: boolean): { start: number; end: number } | null {
  const tags = closing ? THINK_CLOSE_TAGS : THINK_OPEN_TAGS;
  let best = -1;
  let bestLength = 0;
  for (const tag of tags) {
    const at = indexOfCaseInsensitive(text, tag, 0);
    if (at === -1) continue;
    if (best === -1 || at < best) {
      best = at;
      bestLength = tag.length;
    }
  }
  return best === -1 ? null : { start: best, end: best + bestLength };
}

function stripThinkTags(text: string): string {
  if (text.indexOf("<") === -1) return text;
  const next: number[] = THINK_TAGS.map((tag) => indexOfCaseInsensitive(text, tag, 0));
  let out = "";
  let cursor = 0;
  for (;;) {
    let best = -1;
    let bestLen = 0;
    for (let k = 0; k < THINK_TAGS.length; k++) {
      const at = next[k];
      if (at !== -1 && (best === -1 || at < best)) {
        best = at;
        bestLen = THINK_TAGS[k].length;
      }
    }
    if (best === -1) break;
    out += text.slice(cursor, best);
    cursor = best + bestLen;
    for (let k = 0; k < THINK_TAGS.length; k++) {
      if (next[k] !== -1 && next[k] < cursor) next[k] = indexOfCaseInsensitive(text, THINK_TAGS[k], cursor);
    }
  }
  return out + text.slice(cursor);
}

export function cleanReasoningAndContent(
  rawContent: string,
  rawReasoning: string
): { content: string; reasoning: string } {
  let content = rawContent || "";
  let reasoning = rawReasoning || "";

  if (!reasoning && typeof content === "string") {
    let openIndex = -1;
    let openLength = 0;
    let closeIndex = -1;
    let closeLength = 0;
    for (let k = 0; k < THINK_OPEN_TAGS.length; k++) {
      const openTag = THINK_OPEN_TAGS[k];
      const closeTag = THINK_CLOSE_TAGS[k];
      const at = indexOfCaseInsensitive(content, openTag, 0);
      if (at === -1) continue;
      const closeAt = indexOfCaseInsensitive(content, closeTag, at + openTag.length);
      if (closeAt === -1) continue;
      if (openIndex === -1 || at < openIndex) {
        openIndex = at;
        openLength = openTag.length;
        closeIndex = closeAt;
        closeLength = closeTag.length;
      }
    }

    if (openIndex !== -1) {
      reasoning = content.slice(openIndex + openLength, closeIndex).trim();
      content = (content.slice(0, openIndex) + content.slice(closeIndex + closeLength)).trim();
    } else {
      let firstClose = -1;
      let firstCloseLength = 0;
      for (const closeTag of THINK_CLOSE_TAGS) {
        const at = indexOfCaseInsensitive(content, closeTag, 0);
        if (at !== -1 && (firstClose === -1 || at < firstClose)) {
          firstClose = at;
          firstCloseLength = closeTag.length;
        }
      }
      if (firstClose !== -1) {
        reasoning = content.slice(0, firstClose).trim();
        content = content.slice(firstClose + firstCloseLength).trim();
      }
    }
  }

  if (typeof content === "string") {
    content = stripThinkTags(content).trim();
  }
  if (typeof reasoning === "string") {
    reasoning = stripThinkTags(reasoning).trim();
  }

  return { content, reasoning };
}

export function convertChatToResponsesJson(
  chatJson: any,
  responseId: string,
  publicModel?: string
): any {
  const choice = chatJson.choices?.[0];
  const message = choice?.message;
  const rawContent = message?.content || choice?.text || "";
  const rawReasoning = reasoningTextFromNode(message);

  const cleaned = cleanReasoningAndContent(
    typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent),
    typeof rawReasoning === "string" ? rawReasoning : JSON.stringify(rawReasoning)
  );
  let content = cleaned.content;
  let reasoning = cleaned.reasoning;

  const output: any[] = [];
  if (reasoning) {
    output.push({
      id: `reasoning_${responseId}`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoning }],
      content: [{ type: "reasoning_text", text: reasoning }],
      ...(Array.isArray(message?.reasoning_details) && message.reasoning_details.length
        ? { details: message.reasoning_details }
        : {}),
    });
  }

  const standardToolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

  let dsmlToolCalls: ParsedToolCall[] = [];
  if (typeof content === "string") {
    const dsml = extractDsmlToolCalls(content);
    if (dsml) {
      content = dsml.cleanContent;
      dsmlToolCalls = dsml.toolCalls;
    }
  }

  if (content) {
    output.push({
      id: `item_${responseId}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: content,
        },
      ],
    });
  }

  for (const tc of standardToolCalls) {
    if (tc.type === "function") {
      output.push({
        id: `call_${tc.id || responseId}`,
        type: "function_call",
        status: "completed",
        call_id: tc.id || `call_${responseId}`,
        name: tc.function?.name || "",
        arguments: tc.function?.arguments || "{}",
      });
    }
  }

  for (const tc of dsmlToolCalls) {
    output.push({
      id: `call_${tc.callId}`,
      type: "function_call",
      status: "completed",
      call_id: tc.callId,
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
    });
  }

  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: publicModel ?? (chatJson.model || "openai"),
    output,
    usage: chatJson.usage,
  };
}

const LOOP_GUARD_TAIL_CHARS = 2048;

const MAX_SSE_PENDING_CHARS = 256 * 1024;

export function detectRepetitionLoop(text: string): { isLoop: boolean; loopPattern?: string } {
  if (text.length < 36) return { isLoop: false };
  const n = text.length;
  const tailStart = Math.max(0, n - 600);
  const tailLength = n - tailStart;
  const maxL = Math.min(200, Math.floor(tailLength / 3));

  const distinct = new Set<number>();
  for (let i = tailStart; i < n && distinct.size < 4; i++) distinct.add(text.charCodeAt(i));
  if (distinct.size < 4) return { isLoop: false };

  for (let l = 12; l <= maxL; l++) {
    const last = n - l;
    const middle = n - 2 * l;
    const first = n - 3 * l;

    let repeated = true;
    for (let i = 0; i < l; i++) {
      const c = text[last + i];
      if (c !== text[middle + i] || c !== text[first + i]) {
        repeated = false;
        break;
      }
    }
    if (!repeated) continue;

    const pattern = text.slice(last);
    const trimmed = pattern.trim();
    if (trimmed.length < 12) continue;

    if (new Set(trimmed).size < 4) continue;

    return { isLoop: true, loopPattern: pattern };
  }

  return { isLoop: false };
}

export interface ChatToResponsesFinishMetadata {
  reasoning?: string;
  outputItems?: any[];
  billableCall?: boolean;
  usage?: TokenUsage | null;
  usage_source?: UsageSnapshot["source"];
  usage_provenance?: Record<string, string>;
}

export function createChatToResponsesTransform(
  responseId: string,
  modelName: string,
  onFinish?: (fullText: string, metadata?: ChatToResponsesFinishMetadata) => void,
  inputTokens?: number,
  streamFailed?: () => boolean,
  originalUsageSnapshot?: () => UsageSnapshot
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const usageAccumulator = new UsageAccumulator("chat/completions");
  let buffer = "";
  let fullContent = "";
  let fullReasoning = "";
  const reasoningDetails = createReasoningDetailsCollector();
  let contentTail = "";
  let reasoningTail = "";
  let createdSent = false;
  let reasoningStarted = false;
  let reasoningDone = false;
  let messageStarted = false;
  let messageDone = false;

  let insideThinkTag = false;
  let tagPendingBuffer = "";
  let reasoningTagPendingBuffer = "";
  let insideDsmlTag = false;
  let dsmlParts: string[] = [];
  let dsmlPartChars = 0;
  let dsmlCarry = "";
  let contentLoopDetected = false;
  let reasoningLoopDetected = false;
  let upstreamFinishReason = "";

  let outputIndexCounter = 0;
  const emittedOutputItems: any[] = [];
  const activeToolCalls = new Map<number, { id: string; callId: string; name: string; arguments: string; outputIndex: number }>();

  function sendEvent(controller: TransformStreamDefaultController<Uint8Array>, event: string, data: any) {
    const payload = { type: event, ...data };
    const s = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    controller.enqueue(encoder.encode(s));
  }

  function ensureCreated(controller: TransformStreamDefaultController<Uint8Array>) {
    if (!createdSent) {
      createdSent = true;
      sendEvent(controller, "response.created", {
        response: {
          id: responseId,
          object: "response",
          status: "in_progress",
          model: modelName,
        },
      });
    }
  }

  function startReasoning(controller: TransformStreamDefaultController<Uint8Array>) {
    if (!reasoningStarted) {
      reasoningStarted = true;
      const reasoningIndex = outputIndexCounter++;
      sendEvent(controller, "response.output_item.added", {
        response_id: responseId,
        output_index: reasoningIndex,
        item: {
          id: `reasoning_${responseId}`,
          type: "reasoning",
          status: "in_progress",
          summary: [],
        },
      });
    }
  }

  function emitReasoningDelta(controller: TransformStreamDefaultController<Uint8Array>, delta: string) {
    if (reasoningLoopDetected || !delta) return;
    ensureCreated(controller);
    startReasoning(controller);

    reasoningTail =
      reasoningTail.length + delta.length > LOOP_GUARD_TAIL_CHARS
        ? (reasoningTail + delta).slice(-LOOP_GUARD_TAIL_CHARS)
        : reasoningTail + delta;
    const loopCheck = detectRepetitionLoop(reasoningTail);
    if (loopCheck.isLoop) {
      reasoningLoopDetected = true;
      finishReasoning(controller);
      return;
    }

    fullReasoning += delta;
    sendEvent(controller, "response.reasoning_text.delta", {
      response_id: responseId,
      item_id: `reasoning_${responseId}`,
      output_index: 0,
      content_index: 0,
      delta,
    });
    sendEvent(controller, "response.reasoning.delta", {
      response_id: responseId,
      item_id: `reasoning_${responseId}`,
      output_index: 0,
      delta,
    });
  }

  function finishReasoning(controller: TransformStreamDefaultController<Uint8Array>) {
    if (reasoningStarted && !reasoningDone) {
      reasoningDone = true;
      sendEvent(controller, "response.output_item.done", {
        response_id: responseId,
        output_index: 0,
        item: {
          id: `reasoning_${responseId}`,
          type: "reasoning",
          status: "completed",
          summary: fullReasoning ? [{ type: "summary_text", text: fullReasoning }] : [],
          ...(fullReasoning ? { content: [{ type: "reasoning_text", text: fullReasoning }] } : {}),
          ...(reasoningDetails.result() ? { details: reasoningDetails.result() } : {}),
        },
      });
    }
  }

  let messageOutputIndex = 0;

  function startMessage(controller: TransformStreamDefaultController<Uint8Array>) {
    finishReasoning(controller);
    if (!messageStarted) {
      messageStarted = true;
      messageOutputIndex = outputIndexCounter++;
      sendEvent(controller, "response.output_item.added", {
        response_id: responseId,
        output_index: messageOutputIndex,
        item: {
          id: `item_${responseId}`,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      });
      sendEvent(controller, "response.content_part.added", {
        response_id: responseId,
        item_id: `item_${responseId}`,
        output_index: messageOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "" },
      });
    }
  }

  function emitContentDelta(controller: TransformStreamDefaultController<Uint8Array>, delta: string) {
    if (contentLoopDetected || !delta) return;
    ensureCreated(controller);
    startMessage(controller);

    contentTail =
      contentTail.length + delta.length > LOOP_GUARD_TAIL_CHARS
        ? (contentTail + delta).slice(-LOOP_GUARD_TAIL_CHARS)
        : contentTail + delta;
    const loopCheck = detectRepetitionLoop(contentTail);
    if (loopCheck.isLoop) {
      contentLoopDetected = true;
      finishMessage(controller);
      return;
    }

    fullContent += delta;
    sendEvent(controller, "response.output_text.delta", {
      response_id: responseId,
      item_id: `item_${responseId}`,
      output_index: messageOutputIndex,
      content_index: 0,
      delta,
    });
  }

  function finishMessage(controller: TransformStreamDefaultController<Uint8Array>) {
    if (messageStarted && !messageDone) {
      messageDone = true;
      sendEvent(controller, "response.output_text.done", {
        response_id: responseId,
        item_id: `item_${responseId}`,
        output_index: messageOutputIndex,
        content_index: 0,
        text: fullContent,
      });

      sendEvent(controller, "response.content_part.done", {
        response_id: responseId,
        item_id: `item_${responseId}`,
        output_index: messageOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: fullContent },
      });

      const messageOutputItem = {
        id: `item_${responseId}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: fullContent }],
      };

      sendEvent(controller, "response.output_item.done", {
        response_id: responseId,
        output_index: messageOutputIndex,
        item: messageOutputItem,
      });

      emittedOutputItems.push(messageOutputItem);
    }
  }

  function emitFunctionCall(
    controller: TransformStreamDefaultController<Uint8Array>,
    name: string,
    argumentsObjOrString: any,
    explicitCallId?: string
  ) {
    ensureCreated(controller);
    finishReasoning(controller);
    finishMessage(controller);

    const callId = explicitCallId || `call_${Math.random().toString(36).slice(2, 11)}`;
    const argsStr = typeof argumentsObjOrString === "string" ? argumentsObjOrString : JSON.stringify(argumentsObjOrString);
    const itemIndex = outputIndexCounter++;
    const itemId = `call_${callId}`;

    const funcItem = {
      id: itemId,
      type: "function_call",
      status: "in_progress",
      call_id: callId,
      name,
      arguments: "",
    };

    sendEvent(controller, "response.output_item.added", {
      response_id: responseId,
      output_index: itemIndex,
      item: funcItem,
    });

    sendEvent(controller, "response.function_call_arguments.delta", {
      response_id: responseId,
      item_id: itemId,
      output_index: itemIndex,
      call_id: callId,
      delta: argsStr,
    });

    sendEvent(controller, "response.function_call_arguments.done", {
      response_id: responseId,
      item_id: itemId,
      output_index: itemIndex,
      call_id: callId,
      arguments: argsStr,
    });

    const completedFuncItem = {
      id: itemId,
      type: "function_call",
      status: "completed",
      call_id: callId,
      name,
      arguments: argsStr,
    };

    sendEvent(controller, "response.output_item.done", {
      response_id: responseId,
      output_index: itemIndex,
      item: completedFuncItem,
    });

    emittedOutputItems.push(completedFuncItem);
  }

  const MAX_DSML_BLOCK_CHARS = 256 * 1024;

  function resetDsmlBlock() {
    dsmlParts = [];
    dsmlPartChars = 0;
    dsmlCarry = "";
    insideDsmlTag = false;
  }

  function drainDsmlBuffer(
    controller: TransformStreamDefaultController<Uint8Array>,
    chunk: string
  ): string | null {
    let work = dsmlCarry + chunk;
    let at = work.indexOf("<");
    while (at !== -1) {
      const probe = probeDsmlCloseTag(work, at, "tool_calls");
      if (probe === "incomplete") {
        dsmlParts.push(work.slice(0, at));
        dsmlPartChars += at;
        dsmlCarry = work.slice(at);
        return null;
      }
      if (probe) return completeDsmlBlock(controller, work, probe);
      at = work.indexOf("<", at + 1);
    }
    dsmlParts.push(work);
    dsmlPartChars += work.length;
    dsmlCarry = "";
    return null;
  }

  function completeDsmlBlock(
    controller: TransformStreamDefaultController<Uint8Array>,
    work: string,
    close: DsmlTagSpan
  ): string {
    const fullDsml = dsmlParts.join("") + work.slice(0, close.end);
    const afterDsml = work.slice(close.end);
    resetDsmlBlock();

    const parsed = extractDsmlToolCalls(fullDsml);
    if (parsed) {
      for (const tc of parsed.toolCalls) {
        emitFunctionCall(controller, tc.name, tc.arguments, tc.callId);
      }
    }

    return afterDsml;
  }

  function handleReasoningChunk(controller: TransformStreamDefaultController<Uint8Array>, text: string) {
    let remaining = reasoningTagPendingBuffer + text;
    reasoningTagPendingBuffer = "";

    const closeTag = findFirstThinkTag(remaining, true);
    if (closeTag) {
      const thinkPart = remaining.slice(0, closeTag.start);
      const afterPart = remaining.slice(closeTag.end);
      const cleanThink = stripThinkTags(thinkPart);
      if (cleanThink) {
        emitReasoningDelta(controller, cleanThink);
      }
      finishReasoning(controller);
      insideThinkTag = false;
      if (afterPart) {
        handleContentChunk(controller, afterPart);
      }
      return;
    }

    const trailing = remaining.match(/<[^>]{0,40}$/);
    if (trailing) {
      const safeText = remaining.slice(0, remaining.length - trailing[0].length);
      reasoningTagPendingBuffer = trailing[0];
      const cleanSafe = stripThinkTags(safeText);
      if (cleanSafe) {
        emitReasoningDelta(controller, cleanSafe);
      }
    } else {
      const cleanAll = stripThinkTags(remaining);
      if (cleanAll) {
        emitReasoningDelta(controller, cleanAll);
      }
    }
  }

  function handleContentChunk(controller: TransformStreamDefaultController<Uint8Array>, text: string) {
    let remaining = tagPendingBuffer + text;
    tagPendingBuffer = "";

    while (remaining.length > 0) {
      if (insideThinkTag) {
        const closeTag = findFirstThinkTag(remaining, true);
        if (closeTag) {
          const thinkContent = remaining.slice(0, closeTag.start);
          const cleanThink = stripThinkTags(thinkContent);
          if (cleanThink) {
            emitReasoningDelta(controller, cleanThink);
          }
          finishReasoning(controller);
          insideThinkTag = false;
          remaining = remaining.slice(closeTag.end);
        } else {
          const trailing = remaining.match(/<[^>]{0,40}$/);
          if (trailing) {
            const safeText = remaining.slice(0, remaining.length - trailing[0].length);
            tagPendingBuffer = trailing[0];
            const cleanSafe = stripThinkTags(safeText);
            if (cleanSafe) {
              emitReasoningDelta(controller, cleanSafe);
            }
            remaining = "";
          } else {
            const cleanAll = stripThinkTags(remaining);
            if (cleanAll) {
              emitReasoningDelta(controller, cleanAll);
            }
            remaining = "";
          }
        }
      } else if (insideDsmlTag) {
        const afterDsml = drainDsmlBuffer(controller, remaining);
        if (afterDsml !== null) {
          remaining = afterDsml;
          continue;
        }
        remaining = "";
        if (dsmlPartChars + dsmlCarry.length > MAX_DSML_BLOCK_CHARS) {
          resetDsmlBlock();
        }
      } else {
        const openThinkTag = findFirstThinkTag(remaining, false);
        const closeThinkTag = findFirstThinkTag(remaining, true);
        const openDsmlMatch = remaining.match(/<\s*\|\s*DSML\s*\|\s*tool_calls\s*>/i);

        let firstMatch: { type: "open_think" | "close_think" | "open_dsml"; index: number; length: number } | null = null;
        if (openThinkTag) {
          firstMatch = { type: "open_think", index: openThinkTag.start, length: openThinkTag.end - openThinkTag.start };
        }
        if (closeThinkTag) {
          if (!firstMatch || closeThinkTag.start < firstMatch.index) {
            firstMatch = { type: "close_think", index: closeThinkTag.start, length: closeThinkTag.end - closeThinkTag.start };
          }
        }
        if (openDsmlMatch && openDsmlMatch.index !== undefined) {
          if (!firstMatch || openDsmlMatch.index < firstMatch.index) {
            firstMatch = { type: "open_dsml", index: openDsmlMatch.index, length: openDsmlMatch[0].length };
          }
        }

        if (firstMatch) {
          const preContent = remaining.slice(0, firstMatch.index);
          if (firstMatch.type === "open_think") {
            if (preContent) {
              emitContentDelta(controller, preContent);
            }
            insideThinkTag = true;
            remaining = remaining.slice(firstMatch.index + firstMatch.length);
          } else if (firstMatch.type === "close_think") {
            if (!reasoningDone && !messageStarted) {
              if (preContent) {
                emitReasoningDelta(controller, preContent);
              }
            } else {
              if (preContent) {
                emitContentDelta(controller, preContent);
              }
            }
            finishReasoning(controller);
            insideThinkTag = false;
            remaining = remaining.slice(firstMatch.index + firstMatch.length);
          } else {
            if (preContent) {
              emitContentDelta(controller, preContent);
            }
            insideDsmlTag = true;
            const openTag = remaining.slice(firstMatch.index, firstMatch.index + firstMatch.length);
            dsmlParts = [openTag];
            dsmlPartChars = openTag.length;
            dsmlCarry = "";
            const afterDsml = drainDsmlBuffer(controller, remaining.slice(firstMatch.index + firstMatch.length));
            if (afterDsml !== null) {
              remaining = afterDsml;
              continue;
            }
            remaining = "";
          }
        } else {
          const trailing = remaining.match(/<[^>]{0,40}$/);
          if (trailing) {
            const safeText = remaining.slice(0, remaining.length - trailing[0].length);
            tagPendingBuffer = trailing[0];
            if (safeText) {
              emitContentDelta(controller, safeText);
            }
            remaining = "";
          } else {
            emitContentDelta(controller, remaining);
            remaining = "";
          }
        }
      }
    }
  }

  function processLine(controller: TransformStreamDefaultController<Uint8Array>, line: string) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;

    try {
      const parsed = JSON.parse(payload);
      ensureCreated(controller);

      const choice = parsed.choices?.[0];
      const delta = choice?.delta;
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
        upstreamFinishReason = choice.finish_reason;
      }

      const reasoningDelta = Array.isArray(delta?.reasoning_details) ? undefined : reasoningTextFromNode(delta);
      if (reasoningDelta && typeof reasoningDelta === "string") {
        handleReasoningChunk(controller, reasoningDelta);
      }
      if (Array.isArray(delta?.reasoning_details)) {
        reasoningDetails.add(delta.reasoning_details);
        ensureCreated(controller);
        startReasoning(controller);
        const fromDetails = reasoningFromDetails(delta);
        if (fromDetails && !fullReasoning.startsWith(fromDetails)) {
          handleReasoningChunk(
            controller,
            fromDetails.startsWith(fullReasoning) ? fromDetails.slice(fullReasoning.length) : fromDetails
          );
        }
      }

      if (Array.isArray(delta?.tool_calls)) {
        finishReasoning(controller);
        finishMessage(controller);

        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === "number" ? tc.index : 0;
          let entry = activeToolCalls.get(index);

          if (!entry && tc.function?.name) {
            const callId = tc.id || `call_${Math.random().toString(36).slice(2, 11)}`;
            const itemIndex = outputIndexCounter++;
            const itemId = `call_${callId}`;

            entry = {
              id: itemId,
              callId,
              name: tc.function.name,
              arguments: "",
              outputIndex: itemIndex,
            };
            activeToolCalls.set(index, entry);

            sendEvent(controller, "response.output_item.added", {
              response_id: responseId,
              output_index: itemIndex,
              item: {
                id: itemId,
                type: "function_call",
                status: "in_progress",
                call_id: callId,
                name: entry.name,
                arguments: "",
              },
            });
          }

          const argChunk = tc.function?.arguments;
          if (entry && argChunk && typeof argChunk === "string") {
            entry.arguments += argChunk;
            sendEvent(controller, "response.function_call_arguments.delta", {
              response_id: responseId,
              item_id: entry.id,
              output_index: entry.outputIndex,
              call_id: entry.callId,
              delta: argChunk,
            });
          }
        }
      }

      const contentDelta = delta?.content ?? choice?.text ?? "";
      if (contentDelta && typeof contentDelta === "string") {
        handleContentChunk(controller, contentDelta);
      }
    } catch {
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      usageAccumulator.push(chunk);
      const text = decoder.decode(chunk, { stream: true });
      const buffered = buffer.length;
      buffer += text;
      const newlineInChunk = text.lastIndexOf("\n");
      const cut = newlineInChunk < 0 ? -1 : buffered + newlineInChunk;
      if (cut < 0) {
        if (buffer.length > MAX_SSE_PENDING_CHARS) {
          processLine(controller, buffer);
          buffer = "";
        }
        return;
      }
      const block = buffer.slice(0, cut + 1);
      buffer = buffer.slice(cut + 1);
      let from = 0;
      for (;;) {
        const nl = block.indexOf("\n", from);
        if (nl < 0) break;
        processLine(controller, block.slice(from, nl));
        from = nl + 1;
      }
    },
    flush(controller) {
      const localUsage = usageAccumulator.finish();
      const observedUsage = originalUsageSnapshot?.() ?? localUsage;
      if (buffer.trim()) {
        processLine(controller, buffer);
      }

      if (reasoningTagPendingBuffer) {
        const clean = stripThinkTags(reasoningTagPendingBuffer);
        if (clean) emitReasoningDelta(controller, clean);
        reasoningTagPendingBuffer = "";
      }

      if (tagPendingBuffer) {
        const clean = stripThinkTags(tagPendingBuffer);
        if (clean) {
          if (insideThinkTag) {
            emitReasoningDelta(controller, clean);
          } else {
            emitContentDelta(controller, clean);
          }
        }
        tagPendingBuffer = "";
      }

      if (insideDsmlTag && (dsmlPartChars > 0 || dsmlCarry.length > 0)) {
        const parsed = extractDsmlToolCalls(dsmlParts.join("") + dsmlCarry);
        if (parsed) {
          for (const tc of parsed.toolCalls) {
            emitFunctionCall(controller, tc.name, tc.arguments, tc.callId);
          }
        }
        resetDsmlBlock();
      }

      ensureCreated(controller);
      finishReasoning(controller);

      for (const [, tc] of activeToolCalls) {
        sendEvent(controller, "response.function_call_arguments.done", {
          response_id: responseId,
          item_id: tc.id,
          output_index: tc.outputIndex,
          call_id: tc.callId,
          arguments: tc.arguments,
        });

        const completedItem = {
          id: tc.id,
          type: "function_call",
          status: "completed",
          call_id: tc.callId,
          name: tc.name,
          arguments: tc.arguments,
        };

        sendEvent(controller, "response.output_item.done", {
          response_id: responseId,
          output_index: tc.outputIndex,
          item: completedItem,
        });

        emittedOutputItems.push(completedItem);
      }

      if (messageStarted) {
        finishMessage(controller);
      } else if (emittedOutputItems.length === 0) {
        startMessage(controller);
        finishMessage(controller);
      }

      const finalOutputList: any[] = [];
      if (reasoningStarted) {
        finalOutputList.push({
          id: `reasoning_${responseId}`,
          type: "reasoning",
          status: "completed",
          summary: fullReasoning ? [{ type: "summary_text", text: fullReasoning }] : [],
          ...(fullReasoning ? { content: [{ type: "reasoning_text", text: fullReasoning }] } : {}),
          ...(reasoningDetails.result() ? { details: reasoningDetails.result() } : {}),
        });
      }
      finalOutputList.push(...emittedOutputItems);

      const truncated = upstreamFinishReason === "length" || upstreamFinishReason === "content_filter";
      const stalled = streamFailed?.() === true;
      const failed = stalled || observedUsage.failed;
      const responseStatus = failed ? "failed" : truncated ? "incomplete" : "completed";
      const reported = observedUsage.usage;
      const provenance = observedUsage.provenance;
      const outputTokens = reported && provenance.output_tokens
        ? reported.output_tokens : Math.max(1, Math.ceil((fullContent.length + fullReasoning.length) / 4));
      const inputTokensFinal = reported && provenance.input_tokens
        ? reported.input_tokens : Math.max(0, Math.floor(inputTokens ?? 0));
      const finalUsage = {
        input_tokens: inputTokensFinal,
        output_tokens: outputTokens,
        total_tokens: reported && provenance.total_tokens && !provenance.total_tokens.startsWith("derived:")
          ? reported.total_tokens : inputTokensFinal + outputTokens
            + (reported?.cache_read_included_in_input === false
              ? (reported.cache_read_tokens ?? 0) + (reported.cache_write_tokens ?? 0) : 0),
        ...(reported?.cache_read_tokens !== undefined
          ? { input_tokens_details: { cached_tokens: reported.cache_read_tokens } } : {}),
        ...(reported?.reasoning_tokens !== undefined
          ? { output_tokens_details: { reasoning_tokens: reported.reasoning_tokens } } : {}),
      };

      sendEvent(
        controller,
        failed ? "response.failed" : truncated ? "response.incomplete" : "response.completed",
        failed
          ? {
              response: {
                id: responseId,
                object: "response",
                status: "failed",
                model: modelName,
                output: finalOutputList,
                error: {
                  code: stalled ? "upstream_stream_stalled" : "upstream_stream_error",
                  message: stalled ? "The upstream stopped sending data before the answer finished."
                    : "The upstream reported an error before the answer finished.",
                },
                usage: finalUsage,
              },
            }
          : {
              response: {
                id: responseId,
                object: "response",
                status: responseStatus,
                model: modelName,
                output: finalOutputList,
                ...(truncated
                  ? {
                      incomplete_details: {
                        reason: upstreamFinishReason === "content_filter" ? "content_filter" : "max_output_tokens",
                      },
                    }
                  : {}),
                usage: finalUsage,
              },
            }
      );

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      if (onFinish) onFinish(fullContent, {
        reasoning: fullReasoning, outputItems: finalOutputList, billableCall: !failed && !!upstreamFinishReason,
        usage: observedUsage.usage, usage_source: observedUsage.source, usage_provenance: observedUsage.provenance,
      });
    },
    cancel() {
      const localUsage = usageAccumulator.finish();
      const observedUsage = originalUsageSnapshot?.() ?? localUsage;
      if (onFinish) onFinish(fullContent, {
        reasoning: fullReasoning, outputItems: emittedOutputItems, billableCall: false,
        usage: observedUsage.usage, usage_source: observedUsage.source, usage_provenance: observedUsage.provenance,
      });
    },
  });
}
