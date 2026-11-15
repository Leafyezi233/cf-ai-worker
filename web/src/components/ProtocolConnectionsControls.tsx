import { Input, Select } from "./ui";

export const CONNECTION_PROTOCOLS = [
  { key: "chat_completions", label: "Chat Completions", path: "/chat/completions" },
  { key: "responses", label: "Responses", path: "/responses" },
  { key: "messages", label: "Messages", path: "/messages" },
] as const;
export type ConnectionProtocol = typeof CONNECTION_PROTOCOLS[number]["key"];
type JsonObject = Record<string, unknown>;
export const LEGACY_PROVIDER_BASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

export function isProtocolObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function readProtocolConfig(json: string): JsonObject {
  const value: unknown = JSON.parse(json.trim() || "{}");
  if (!isProtocolObject(value)) throw new Error("高级配置必须是 JSON 对象");
  return value;
}
function objectField(config: JsonObject, key: string): JsonObject {
  const value = config[key];
  if (value === undefined) return {};
  if (!isProtocolObject(value)) throw new Error(key + " 必须是 JSON 对象");
  return value;
}

export function setExplicitConnections(json: string, explicit: boolean): string {
  const config = readProtocolConfig(json);
  if (explicit) {
    if (config.protocol_connections === undefined) config.protocol_connections = {};
    else objectField(config, "protocol_connections");
  } else delete config.protocol_connections;
  return JSON.stringify(config, null, 2);
}
export function updateProtocolConnection(json: string, key: ConnectionProtocol, field: string, value: unknown): string {
  const config = readProtocolConfig(json);
  if (config.protocol_connections === undefined) throw new Error("请先启用显式连接模式");
  const connections = { ...objectField(config, "protocol_connections") };
  const connection = { ...objectField(connections, key) };
  if (field === "anthropic-beta" || field === "anthropic-version") {
    const headers = { ...objectField(connection, "headers") };
    if (value === "") delete headers[field]; else headers[field] = value;
    if (Object.keys(headers).length) connection.headers = headers; else delete connection.headers;
  } else if (value === "") delete connection[field];
  else connection[field] = value;
  connections[key] = connection;
  config.protocol_connections = connections;
  return JSON.stringify(config, null, 2);
}

function validHeaderValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && Array.from(value).every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
}
function validBase(value: string): boolean {
  try { const url = new URL(value); return value.length <= 4096 && !url.username && !url.password && !url.search && !url.hash && /^https?:\/\//i.test(value) && ["http:", "https:"].includes(url.protocol); }
  catch { return false; }
}
function validPath(value: string): boolean {
  if (value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || /[?#\\\s]/.test(value)) return false;
  try {
    const decoded = decodeURIComponent(value);
    return !Array.from(decoded).some(c => c.charCodeAt(0) <= 32) && !/[?#\\]/.test(decoded) && !decoded.split("/").some(segment => segment === "." || segment === "..");
  } catch { return false; }
}
const RESERVED_CONNECTION_SECRETS = new Set(["ADMIN_SECRET", "SESSION_SECRET", "ENCRYPTION_KEY", "DB", "ASSETS", "CACHE_KV", "RATE_LIMITER", "GATEWAY_BASE_URL", "APP_NAME", "TRUST_FORWARD_HEADERS", "CORS_ALLOWED_ORIGINS"]);
function validSecretName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !RESERVED_CONNECTION_SECRETS.has(value.toUpperCase()) && !value.toUpperCase().startsWith("CF_ACCESS_");
}
export function validateProviderProtocolConnections(json: string): void {
  const config = readProtocolConfig(json);
  if (config.protocol_connections === undefined) return;
  const connections = objectField(config, "protocol_connections");
  for (const [key, raw] of Object.entries(connections)) {
    if (!CONNECTION_PROTOCOLS.some(protocol => protocol.key === key)) throw new Error("未知协议连接：" + key);
    if (!isProtocolObject(raw)) throw new Error(key + " 连接必须是 JSON 对象");
    const allowed = ["enabled", "base_url", "path", "auth", "secret_name", "version", "headers"];
    if (Object.keys(raw).some(field => !allowed.includes(field))) throw new Error(key + " 含不支持的连接字段；不得在 JSON 中填写原始密钥");
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error(key + ".enabled 必须是布尔值");
    if (raw.base_url !== undefined && (typeof raw.base_url !== "string" || !validBase(raw.base_url))) throw new Error(key + ".base_url 必须是绝对 http(s) URL");
    if (raw.path !== undefined && (typeof raw.path !== "string" || !validPath(raw.path))) throw new Error(key + ".path 必须以 / 开头，不能含查询、片段或目录穿越");
    if (raw.auth !== undefined && (typeof raw.auth !== "string" || !["bearer", "x-api-key", "x-goog-api-key"].includes(raw.auth))) throw new Error(key + ".auth 无效");
    if (raw.secret_name !== undefined && !validSecretName(raw.secret_name)) throw new Error(key + ".secret_name 必须是有效的 Worker 环境变量名（不是密钥值）");
    if (raw.version !== undefined && !validHeaderValue(raw.version)) throw new Error(key + ".version 必须是 1–1024 字符且不含控制字符的字符串");
    if (raw.headers !== undefined) {
      const headers = objectField(raw, "headers");
      for (const [name, value] of Object.entries(headers)) {
        if (!["anthropic-beta", "anthropic-version"].includes(name) || !validHeaderValue(value)) throw new Error(key + ".headers 仅允许安全的 anthropic-beta / anthropic-version 字符串");
      }
    }
  }
}
export function connectionUrlPreview(providerType: string, endpoint: string, key: ConnectionProtocol, connection: JsonObject): string {
  const base = typeof connection.base_url === "string" ? connection.base_url : endpoint.trim() || LEGACY_PROVIDER_BASES[providerType] || LEGACY_PROVIDER_BASES.openai;
  const path = typeof connection.path === "string" ? connection.path : CONNECTION_PROTOCOLS.find(protocol => protocol.key === key)!.path;
  if (!validBase(base) || !validPath(path)) return "URL / 路径无效，请修正后保存";
  return base.replace(/\/+$/, "") + path;
}
export function providerConnectionState(json: string, key: ConnectionProtocol): "legacy" | "enabled" | "disabled" | "invalid" {
  try {
    const config = readProtocolConfig(json);
    if (config.protocol_connections === undefined) return "legacy";
    validateProviderProtocolConnections(json);
    const connections = objectField(config, "protocol_connections");
    const connection = connections[key];
    return isProtocolObject(connection) && connection.enabled !== false ? "enabled" : "disabled";
  } catch { return "invalid"; }
}

export function updateModelProtocolValue(json: string, namespace: "protocol_capabilities" | "protocol_models", key: string, value: string): string {
  const config = readProtocolConfig(json);
  const fields = { ...objectField(config, namespace) };
  if (!value) delete fields[key];
  else fields[key] = namespace === "protocol_capabilities" && ["true", "false"].includes(value) ? value === "true" : value;
  if (Object.keys(fields).length) config[namespace] = fields; else delete config[namespace];
  return JSON.stringify(config, null, 2);
}
export function validateModelProtocolDeclarations(json: string): void {
  const config = readProtocolConfig(json);
  const capabilities = objectField(config, "protocol_capabilities");
  for (const protocol of CONNECTION_PROTOCOLS) {
    if (capabilities[protocol.key] !== undefined && typeof capabilities[protocol.key] !== "boolean") throw new Error("protocol_capabilities." + protocol.key + " 必须是布尔值");
  }
  const models = objectField(config, "protocol_models");
  for (const [key, value] of Object.entries(models)) {
    if (!CONNECTION_PROTOCOLS.some(protocol => protocol.key === key) || typeof value !== "string" || !value.trim() || value.length > 150) throw new Error("protocol_models 仅允许三种协议的非空上游模型 ID 字符串");
  }
}

export function ProtocolConnectionsControls({ configJson, providerType, endpoint, onChange, onError }: {
  configJson: string; providerType: string; endpoint: string; onChange: (json: string) => void; onError: (message: string) => void;
}) {
  let config: JsonObject = {}, connections: JsonObject = {}, parseError = "", validationError = "";
  try { config = readProtocolConfig(configJson); connections = objectField(config, "protocol_connections"); }
  catch (error) { parseError = error instanceof Error ? error.message : "连接配置无效"; }
  if (!parseError) {
    try { validateProviderProtocolConnections(configJson); }
    catch (error) { validationError = error instanceof Error ? error.message : "连接配置无效"; }
  }
  const explicit = config.protocol_connections !== undefined;
  function change(action: () => string) {
    try { onChange(action()); } catch (error) { onError(error instanceof Error ? error.message : "请先修正高级 JSON 配置"); }
  }
  return <fieldset className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-3">
    <legend className="px-1 text-xs font-semibold">协议连接（可选）</legend>
    <label className="flex items-center gap-2 text-xs font-semibold">
      <input type="checkbox" aria-label="启用显式协议连接" checked={explicit} disabled={Boolean(parseError) && !explicit}
        onChange={event => change(() => setExplicitConnections(configJson, event.target.checked))} />启用显式协议连接
    </label>
    <p className="text-xs text-slate-500 dark:text-slate-400">未启用时完全沿用旧默认值。启用后此列表是权威允许列表：未勾选 / 缺失的连接禁用；初次启用时全部关闭。取消显式模式将移除 protocol_connections 并恢复旧默认值。Provider 类型只决定旧默认值，不限制显式连接格式。</p>
    {explicit ? <p className="text-xs text-amber-600">显式连接请使用协议探测或网关客户端测试；旧版管理 Playground / 单模型推理探测暂不支持选择协议，不会猜测并调用上游。</p> : null}
    {parseError || validationError ? <p role="alert" className="text-xs text-rose-600">{parseError || validationError}</p> : null}
    {explicit && !parseError ? CONNECTION_PROTOCOLS.map(protocol => {
      const raw = connections[protocol.key];
      const connection = isProtocolObject(raw) ? raw : {};
      const enabled = isProtocolObject(raw) && connection.enabled !== false;
      const headers = isProtocolObject(connection.headers) ? connection.headers : {};
      const text = (field: string) => typeof connection[field] === "string" ? connection[field] as string : "";
      const update = (field: string, value: unknown) => change(() => updateProtocolConnection(configJson, protocol.key, field, value));
      return <div key={protocol.key} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-3">
        <label className="flex items-center gap-2 text-xs font-semibold"><input type="checkbox" checked={enabled} aria-label={"启用 " + protocol.label}
          onChange={event => update("enabled", event.target.checked)} />{protocol.label}
          <span className="font-normal text-slate-500">{enabled ? "已启用" : raw === undefined ? "未配置 · 禁用" : "已禁用"}</span>
        </label>
        {raw !== undefined && !isProtocolObject(raw) ? <p role="alert" className="text-xs text-rose-600">连接不是 JSON 对象，请在高级配置中修正。</p> : null}
        {isProtocolObject(raw) ? <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs space-y-1"><span>Base URL（可选）</span><Input aria-label={protocol.label + " Base URL"} value={text("base_url")}
              placeholder={endpoint.trim() || LEGACY_PROVIDER_BASES[providerType]} onChange={event => update("base_url", event.target.value)} /></label>
            <label className="block text-xs space-y-1"><span>路径（追加到 Base 前缀）</span><Input aria-label={protocol.label + " 路径"} value={text("path")} placeholder={protocol.path}
              onChange={event => update("path", event.target.value)} /></label>
            <label className="block text-xs space-y-1"><span>认证格式</span><Select aria-label={protocol.label + " 认证格式"} value={text("auth")} onChange={event => update("auth", event.target.value)}>
              <option value="">默认（{protocol.key === "messages" ? "x-api-key" : "bearer"}）</option>
              {text("auth") && !["bearer", "x-api-key", "x-goog-api-key"].includes(text("auth")) ? <option value={text("auth")}>当前无效值：{text("auth")}</option> : null}
              <option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="x-goog-api-key">x-goog-api-key</option>
            </Select></label>
            <label className="block text-xs space-y-1"><span>Secret 环境变量名（可选，非密钥）</span><Input aria-label={protocol.label + " Secret 环境变量名"} value={text("secret_name")}
              placeholder="留空使用共享 Provider API Key" onChange={event => update("secret_name", event.target.value)} autoComplete="off" /></label>
            <label className="block text-xs space-y-1"><span>协议版本 version（可选）</span><Input aria-label={protocol.label + " version"} value={text("version")}
              placeholder={protocol.key === "messages" ? "2023-06-01" : "未设置"} onChange={event => update("version", event.target.value)} /></label>
            {(["anthropic-beta", "anthropic-version"] as const).map(name => <label key={name} className="block text-xs space-y-1"><span>受控 Header：{name}</span>
              <Input aria-label={protocol.label + " " + name} value={typeof headers[name] === "string" ? headers[name] as string : ""} placeholder="未设置"
                onChange={event => update(name, event.target.value)} /></label>)}
          </div>
          <p className="text-xs break-all text-slate-500 dark:text-slate-400">URL 预览{enabled ? "" : "（连接禁用）"}：<code>{connectionUrlPreview(providerType, endpoint, protocol.key, connection)}</code></p>
        </> : null}
      </div>;
    }) : null}
    <p className="text-xs text-slate-500 dark:text-slate-400">密钥只使用共享的已加密 Provider API Key 或每连接 Worker Secret 引用；不能把原始密钥或任意认证 Header 写进 JSON。仅允许 anthropic-beta / anthropic-version Header。保存不会发起探测请求。</p>
  </fieldset>;
}
