import { isImageModel, resolveModelType } from "./model_type";
import { isOpaqueProtocolPart } from "./protocol_state_reset";
import { readConnectionSet, resolveProtocolConnection } from "./protocol_connections";
import type { ConnectionInput, WireProtocol } from "./protocol_connections";
export type ProtocolKind = WireProtocol;
export type ProtocolInput = ConnectionInput & { config_json?: string | null; provider_type?: string; billing_unit?: string };
export interface ProtocolCapabilities {
  chat_completions: boolean; responses: boolean; messages: boolean;
  chat_route: "auto" | "native" | "responses";
  responses_route: "auto" | "native" | "chat";
  loss_policy: "allow" | "safe" | "strict";
  supported_endpoints: readonly string[]; upstream_endpoints: readonly string[];
  source: "legacy" | "configured" | "invalid";
}
const LIMIT = 512, BUDGET = 2 * 1024 * 1024;
const cache = new Map<string, { value: ProtocolCapabilities; bytes: number }>();
let bytes = 0;
let rows = new WeakMap<object, { config: string; providerConfig: string; type: string; unit: string; value: ProtocolCapabilities }>();
let hits = 0, misses = 0;
function freeze(value: ProtocolCapabilities): ProtocolCapabilities {
  Object.freeze(value.supported_endpoints); Object.freeze(value.upstream_endpoints); return Object.freeze(value);
}
function path(cap: Pick<ProtocolCapabilities,"chat_completions"|"responses"|"messages"|"chat_route"|"responses_route"|"loss_policy">, kind: ProtocolKind, nativeRequired = false): ProtocolKind | null {
  if (kind === "messages") return cap.messages ? "messages" : null;
  const strict = cap.loss_policy === "strict" || nativeRequired;
  if (kind === "chat/completions") {
    if (cap.chat_route === "responses") return !strict && cap.responses ? "responses" : null;
    if (cap.chat_route === "native") return cap.chat_completions ? kind : null;
    return cap.chat_completions ? kind : !strict && cap.responses ? "responses" : null;
  }
  if (cap.responses_route === "chat") return !strict && cap.chat_completions ? "chat/completions" : null;
  if (cap.responses_route === "native") return cap.responses ? kind : null;
  return cap.responses ? kind : !strict && cap.chat_completions ? "chat/completions" : null;
}
function parse(row: ProtocolInput): ProtocolCapabilities {
  let cfg: any; try { cfg = JSON.parse(row.config_json || "{}"); } catch { cfg = {}; }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
  const connections = readConnectionSet(row);
  const explicit = Object.prototype.hasOwnProperty.call(cfg, "protocol_capabilities");
  const pc = cfg.protocol_capabilities;
  const mode = cfg.responses_mode === undefined || cfg.responses_mode === "chat_adapter" ? "chat_adapter" : cfg.responses_mode === "native" ? "native" : "disabled";
  const multi = connections.explicit;
  const cap: ProtocolCapabilities = {
    chat_completions: !!resolveProtocolConnection(row, "chat/completions"),
    responses: !!resolveProtocolConnection(row, "responses") && (multi || row.provider_type !== "gemini" && mode === "native"),
    messages: !!resolveProtocolConnection(row, "messages"),
    chat_route: "auto", responses_route: multi ? "auto" : mode === "native" ? "native" : "chat",
    loss_policy: multi ? "safe" : "allow", supported_endpoints: [], upstream_endpoints: [],
    source: connections.valid ? explicit || multi ? "configured" : "legacy" : "invalid",
  };
  if (multi && cfg.responses_mode !== undefined) {
    cap.responses_route = mode === "chat_adapter" ? "chat" : "native";
    if (mode === "disabled") cap.responses = false;
  }
  if (explicit) {
    const valid = pc && typeof pc === "object" && !Array.isArray(pc)
      && Object.keys(pc).every(k => ["chat_completions","responses","messages","chat_route","responses_route","loss_policy"].includes(k))
      && ["chat_completions","responses","messages"].every(k => pc[k] === undefined || typeof pc[k] === "boolean")
      && (pc.chat_route === undefined || ["auto","native","responses"].includes(pc.chat_route))
      && (pc.responses_route === undefined || ["auto","native","chat"].includes(pc.responses_route))
      && (pc.loss_policy === undefined || ["allow","safe","strict"].includes(pc.loss_policy));
    if (!valid) { cap.chat_completions = false; cap.responses = false; cap.messages = false; cap.source = "invalid"; }
    else {
      cap.chat_completions = (pc.chat_completions ?? cap.chat_completions) && !!resolveProtocolConnection(row, "chat/completions");
      cap.responses = (pc.responses ?? cap.responses) && !!resolveProtocolConnection(row, "responses") && (multi || row.provider_type !== "gemini");
      cap.messages = (pc.messages ?? cap.messages) && !!resolveProtocolConnection(row, "messages");
      cap.chat_route = pc.chat_route ?? "auto";
      cap.responses_route = pc.responses_route ?? (cfg.responses_mode !== undefined ? cap.responses_route : "auto");
      cap.loss_policy = pc.loss_policy ?? "safe";
    }
  }
  const modelType = resolveModelType(row);
  if (modelType !== "text") {
    cap.chat_completions = false; cap.responses = false; cap.messages = false;
    cap.supported_endpoints = modelType === "video" ? (row.provider_type || "openai") === "openai" ? ["/v1/video/generations"] : []
      : modelType === "embedding" ? (row.provider_type || "openai") === "openai" ? ["/v1/embeddings"] : []
      : ["/v1/images/generations"];
    cap.upstream_endpoints = [...cap.supported_endpoints]; return freeze(cap);
  }
  if (!explicit && !multi && mode === "disabled") cap.responses_route = "native";
  cap.upstream_endpoints = [...(cap.chat_completions ? ["/v1/chat/completions"] : []), ...(cap.responses ? ["/v1/responses"] : []), ...(cap.messages ? ["/v1/messages"] : [])];
  cap.supported_endpoints = (["chat/completions","responses","messages"] as const).filter(k => path(cap,k)).map(k => "/v1/" + k);
  return freeze(cap);
}
export function readProtocolCapabilities(row: ProtocolInput): ProtocolCapabilities {
  const config = row.config_json || "", type = row.provider_type || "openai", unit = row.billing_unit || "token", providerConfig = row.provider_config_json || "";
  const previous = rows.get(row);
  if (previous && previous.config === config && previous.providerConfig === providerConfig && previous.type === type && previous.unit === unit) { hits++; return previous.value; }
  const cacheable = config.length + providerConfig.length <= 16384 && !/(?:secret|api.?key|password|credential|access_token|auth_token)/i.test(config + providerConfig);
  const key = JSON.stringify([type, unit, config, providerConfig]);
  const cached = cacheable ? cache.get(key) : undefined;
  let value: ProtocolCapabilities;
  if (cached) { hits++; cache.delete(key); cache.set(key,cached); value = cached.value; }
  else {
    misses++; value = parse(row);
    if (cacheable) { const size = key.length * 2 + 512; cache.set(key,{value,bytes:size}); bytes += size;
      while (cache.size > LIMIT || bytes > BUDGET) { const first = cache.keys().next().value!; bytes -= cache.get(first)!.bytes; cache.delete(first); }
    }
  }
  rows.set(row,{config,providerConfig,type,unit,value}); return value;
}
export function planProtocolRoute(row: ProtocolInput, kind: ProtocolKind, nativeRequired = false): ProtocolKind | null {
  if (isImageModel(row) || ["embedding", "video"].includes(resolveModelType(row))) return null;
  const cap = readProtocolCapabilities(row); return path(cap,kind,nativeRequired);
}
export function protocolCapabilityCacheStats() { return { entries:cache.size,bytes,hits,misses }; }
export function resetProtocolCapabilityCache() { cache.clear(); rows = new WeakMap(); bytes = 0; hits = 0; misses = 0; }
export function hasOpaqueProtocolState(body: any, kind: ProtocolKind): boolean {
  const opaque = isOpaqueProtocolPart;
  const items = kind === "responses" ? body?.input : body?.messages;
  if (!Array.isArray(items)) return false;
  return items.some((item: any) => opaque(item) ||
    Array.isArray(item?.reasoning_details) && item.reasoning_details.some(opaque) ||
    Array.isArray(item?.content) && item.content.some(opaque));
}
