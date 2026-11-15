
import type { ModelType } from "../types";

export class ConsoleError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ConsoleError";
  }
}

const TOKEN_KEY = "cpg.console.token";

export function getConsoleToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setConsoleToken(token: string) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
  }
}

const SESSION_KEY = "cpg.console.session";

export function getConsoleSession(): string {
  try {
    return sessionStorage.getItem(SESSION_KEY) || "";
  } catch {
    return "";
  }
}

export function setConsoleSession(value: string) {
  try {
    if (value) sessionStorage.setItem(SESSION_KEY, value);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
  }
}

let onUnauthorized: (() => void) | null = null;

export function setConsoleUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getConsoleToken();
  const session = getConsoleSession();
  const headers: Record<string, string> = {
    "X-Timezone-Offset": String(new Date().getTimezoneOffset()),
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (session) headers["X-Console-Session"] = session;
  if (init?.body) headers["Content-Type"] = "application/json";

  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });

  if (!res.ok) {
    let data: { error?: string; message?: string } | null = null;
    try {
      data = await res.json();
    } catch {
    }
    if (res.status === 401 && data?.error === "unauthorized") onUnauthorized?.();
    const error = new ConsoleError(
      data?.message || data?.error || `HTTP ${res.status}`,
      res.status
    );
    (error as ConsoleError & { code?: string }).code = data?.error;
    throw error;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const consoleApi = {
  get: <T>(path: string) => request<T>(path),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
};

export async function streamConsoleChat(
  body: Record<string, unknown>,
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const token = getConsoleToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Timezone-Offset": String(new Date().getTimezoneOffset()),
  };
  if (token) headers.Authorization = "Bearer " + token;

  const res = await fetch("/console/chat", {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  if (!res.ok) {
    let data: { error?: string; message?: string } | null = null;
    try {
      data = await res.json();
    } catch {
    }
    if (res.status === 401 && data?.error === "unauthorized") onUnauthorized?.();
    const error = new ConsoleError(data?.message || data?.error || "HTTP " + res.status, res.status);
    (error as ConsoleError & { code?: string }).code = data?.error;
    throw error;
  }
  if (!res.body) throw new ConsoleError("no response body", 500);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload);
        const text =
          chunk?.choices?.[0]?.delta?.content ??
          chunk?.delta?.text ??
          chunk?.content_block?.text ??
          "";
        if (typeof text === "string" && text) onDelta(text);
      } catch {
      }
    }
  }
}

export interface ConsoleMe {
  device: {
    id: string;
    name: string;
    enabled: boolean;
    rate_limit_rpm: number;
    cost_limit_monthly: number | null;
    current_month_cost: number;
    balance_usd: number;
    reserved_usd: number;
    available_usd: number;
    low_balance_warning: boolean;
    last_used_at: number | null;
    created_at: number;
    password_setup_required?: boolean;
    calls_enabled?: boolean;
  };
}

export interface ConsoleAnnouncement {
  enabled: boolean;
  level: "info" | "warning" | "danger";
  title: string;
  message: string;
  updated_at: number | null;
}

export interface ConsoleQuota {
  rpm: {
    limit: number;
    remaining: number | null;
    used: number | null;
    reset_ms: number | null;
    window_ms: number | null;
  };
  monthly_cost_usd: number;
  monthly_cost_limit_usd: number;
  monthly_cost_exceeded: boolean;
  balance_usd: number;
  reserved_usd: number;
  available_usd: number;
  low_balance_warning: boolean;
}

export interface ConsoleProtocolCapabilities {
  supported_endpoints: readonly string[];
}

export interface ConsoleModels {
  model_scope: "all" | "list" | "all_and_list";
  model_count: number;
  items: Array<{
    id: string;
    model_name: string;
    display_name: string | null;
    description: string | null;
    alias: string | null;
    input_price_per_m: number;
    output_price_per_m: number;
    cache_read_price_per_m: number;
    cache_write_price_per_m: number;
    model_type?: ModelType;
    video?: {request_format?:"doubao_content"; default_duration?:number; default_ratio?:string; max_total_refs?:number; allow_tail_only?:boolean; content_available?:boolean; sizes:string[]; seconds_min:number; seconds_max:number; reference_images?: {max_images:number}; ratios?:string[]; resolutions?:string[]; default_resolution?:string; min_images?:number; max_images?:number; max_videos?:number; max_audios?:number; support_first_last?:boolean; support_video_urls?:boolean; support_audio_urls?:boolean; support_audio_only?:boolean; max_audio_only?:number};
    video_pricing?: {endpoint:"/v1/videos"|"/v1/video/generations";settlement:"success";quotes:Array<{resolution:string|null;has_reference_video:boolean|null;unit:"call"|"second";price:number}>};
    billing_unit?: "token" | "call";
    price_per_call?: number;
    search_price_per_call?: number;
    chat_endpoint: string;
    protocol_capabilities?: ConsoleProtocolCapabilities;
    context_window?: number;
    max_output_tokens?: number | null;
    context_window_source?: string;
    max_output_tokens_source?: string;
    input_modalities?: string[];
    supports_reasoning: boolean;
    supported_reasoning_levels?: Array<{ effort: string; description: string }>;
    default_reasoning_level?: string | null;
    peak_pricing_enabled?: boolean;
    current_price_multiplier?: number;
    current_price_window_id?: string | null;
    price_windows?: Array<{
      id: string;
      day_type: string;
      start_minute: number;
      end_minute: number;
      multiplier: number;
    }>;
  }>;
  peak_pricing_tz_offset_minutes?: number;
}

export type ConsoleModelMarketplaceItem = ConsoleModels["items"][number] & {
  service_group_id: string | null;
  service_group_name: string;
  is_current: boolean;
  pricing_mode: "free" | "priced" | "unset";
};

export interface ConsoleModelMarketplace {
  items: ConsoleModelMarketplaceItem[];
  peak_pricing_tz_offset_minutes?: number;
}

export interface ConsoleUsage {
  range: { label: string; from: number; to: number };
  summary: {
    request_count?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cost_usd?: number;
    cache_hit_count?: number;
    pricing_missing_count?: number;
    avg_latency_ms?: number;
    error_count?: number;
  };
  by_model: Array<{
    model: string;
    request_count: number;
    total_tokens: number;
    cost_usd: number;
    pricing_missing_count: number;
  }>;
  daily: Array<{
    date: string;
    request_count: number;
    total_tokens: number;
    cost_usd: number;
  }>;
  items: Array<{
    id: number;
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
    cache_hit: number;
    pricing_missing: boolean;
    status_code: number | null;
    latency_ms: number | null;
    created_at: number;
    sub_token_id?: string | null;
  }>;
  page: { limit: number; offset: number };
  sub_token_id?: string | null;
}


export interface ConsoleAccountSession {
  password_setup_required: boolean;
  authenticated: boolean;
  device_id: string;
  device_name: string;
}

export type ConsoleServiceGroupSelection = string | null;

export interface ConsoleSubToken {
  service_group_id: ConsoleServiceGroupSelection;
  id: string;
  name: string;
  enabled: boolean;
  revoked: boolean;
  last_used_at: number | null;
  created_at: number;
}

export interface ConsoleServiceGroup {
  id: string;
  name: string;
  description: string | null;
  multiplier: number;
}

export interface ConsoleServiceGroupsState {
  items: ConsoleServiceGroup[];
  default_service_group_id: ConsoleServiceGroupSelection;
  service_group_id: ConsoleServiceGroupSelection;
  sub_tokens: Array<{ id: string; service_group_id: ConsoleServiceGroupSelection }>;
}

export interface ConsoleServiceGroupPreview {
  service_group_id: string;
  model_scope: string;
  model_count: number;
  items: Array<{
    id: string; model_name: string; display_name: string | null; alias: string | null;
    pricing_mode: string; billing_unit: "call" | "token"; model_type?: ModelType;
    input_price_per_m: number; output_price_per_m: number;
    cache_read_price_per_m: number; cache_write_price_per_m: number;
    price_per_call: number; search_price_per_call: number;
  }>;
}

export interface ConsoleSubTokenList {
  items: ConsoleSubToken[];
  limit: number;
  remaining: number;
}

export const consoleAccountApi = {
  serviceGroups: () => request<ConsoleServiceGroupsState>("/console/service-groups"),
  setServiceGroups: (selection: { default_service_group_id?: ConsoleServiceGroupSelection; service_group_id?: ConsoleServiceGroupSelection }) =>
    request<{ ok: boolean; default_service_group_id: string | null; service_group_id: string | null }>("/console/service-group", {
      method: "PUT", body: JSON.stringify(selection),
    }),
  previewServiceGroup: (id: string) => request<ConsoleServiceGroupPreview>("/console/service-groups/" + encodeURIComponent(id) + "/models"),
  session: () => request<ConsoleAccountSession>("/console/auth/session"),
  setupPassword: async (password: string) => {
    const res = await request<{
      ok: boolean;
      password_updated_at: number;
      session?: string;
    }>("/console/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    if (res.session) setConsoleSession(res.session);
    return res;
  },
  login: async (password: string) => {
    const res = await request<{ ok: boolean; session?: string }>("/console/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    if (res.session) setConsoleSession(res.session);
    return res;
  },
  logout: async () => {
    setConsoleSession("");
    return request<{ ok: boolean }>("/console/auth/logout", { method: "POST" });
  },
  tokens: (includeRevoked?: boolean) =>
    request<ConsoleSubTokenList>("/console/tokens" + (includeRevoked ? "?include_revoked=1" : "")),
  createToken: (name: string) =>
    request<{ item: ConsoleSubToken; token: string }>("/console/tokens", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  setTokenServiceGroup: (id: string, service_group_id: ConsoleServiceGroupSelection) =>
    request<{ item: { id: string; service_group_id: string | null } }>(
      "/console/tokens/" + encodeURIComponent(id) + "/service-group",
      { method: "PUT", body: JSON.stringify({ service_group_id }) }
    ),
  setTokenEnabled: (id: string, enabled: boolean) =>
    request<{ item: ConsoleSubToken }>(
      "/console/tokens/" + encodeURIComponent(id) + "/enable",
      { method: "POST", body: JSON.stringify({ enabled }) }
    ),
  revokeToken: (id: string) =>
    request<{ item: ConsoleSubToken }>(
      "/console/tokens/" + encodeURIComponent(id) + "/revoke",
      { method: "POST" }
    ),
  calls: () => request<{ calls_enabled: boolean }>("/console/calls"),
  setCalls: (enabled: boolean) =>
    request<{ calls_enabled: boolean }>("/console/calls", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
};