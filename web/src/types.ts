export type ModelType = "text" | "image" | "embedding" | "video";
export interface EmbeddingProfile { compatibility_key: string; dimensions?: number }

export interface Provider {
  id: string;
  name: string;
  type: "anthropic" | "openai" | "gemini";
  endpoint: string | null;
  api_key?: string | null;
  api_key_masked?: string | null;
  api_key_configured?: boolean;
  secret_name: string | null;
  enabled: number;
  config_json: string | null;
  secret_configured?: boolean;
  health_status?: "healthy" | "degraded" | "unhealthy" | "unknown";
  health_latency_ms?: number;
  last_ping_at?: number;
  health_message?: string;
}

export interface ModelItem {
  id: string;
  provider_id: string;
  model_name: string;
  display_name: string | null;
  alias: string | null;
  fallback_model_id: string | null;
  input_price_per_m: number;
  output_price_per_m: number;
  cache_read_price_per_m?: number;
  cache_write_price_per_m?: number;
  cache_enabled?: number;
  cache_ttl?: number;
  model_public?: number;
  pricing_mode?: "unset" | "free" | "priced";
  peak_pricing_enabled?: number;
  billing_unit?: "token" | "call";
  price_per_call?: number;
  search_price_per_call?: number;
  enabled: number;
  config_json: string | null;
  model_type?: ModelType;
  provider_name?: string;
  provider_type?: string;
  capabilities?: string[];
  routing_strategy?: "priority" | "lowest_latency" | "weighted";
  weight?: number;
}

export interface PriceWindowItem {
  id: string;
  model_id: string;
  day_type: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" | "weekday" | "weekend";
  start_minute: number;
  end_minute: number;
  multiplier: number;
  enabled: number;
}

export interface PriceWindowsResponse {
  peak_pricing_enabled: boolean;
  day_types: string[];
  groups: string[];
  weekend_days: string[];
  tz_offset_minutes: number;
  items: PriceWindowItem[];
}

export type ModelScope = "all" | "list" | "all_and_list";

export interface DeviceItem {
  id: string;
  name: string;
  enabled: number;
  rate_limit_rpm: number;
  cost_limit_monthly?: number | null;
  current_month_cost?: number;
  balance_usd?: number;
  reserved_usd?: number;
  model_scope?: ModelScope;
  calls_enabled?: number | boolean;
  password_set?: number | boolean;
  last_used_at: number | null;
  created_at: number;
  revoked_at: number | null;
}

export interface DeviceModelScopeResponse {
  item: {
    device_id: string;
    model_scope: ModelScope;
    model_ids: string[];
    model_count: number;
    rpm_limits?: Record<string, number>;
    group_ids?: string[];
    group_rpms?: Record<string, number>;
  };
  models: Array<{ id: string; model_name: string; display_name: string | null }>;
  groups?: Array<{ id: string; name: string; display_name: string | null; enabled: number }>;
}

export interface DeviceTemplateItem {
  id: string;
  name: string;
  description: string | null;
  model_scope: ModelScope;
  created_at: number | null;
  updated_at: number | null;
  models: DeviceTemplateModelGrant[];
  groups: DeviceTemplateGroupGrant[];
  device_count?: number;
}

export interface DeviceTemplateModelGrant {
  model_id: string;
  model_name: string | null;
  display_name: string | null;
  provider_name: string | null;
  provider_type: string | null;
  rpm: number;
  enabled: number;
}

export interface DeviceTemplateGroupGrant {
  group_id: string;
  name: string | null;
  display_name: string | null;
  enabled: number;
  rpm: number;
}

export interface DeviceTemplatePreview {
  item: {
    template_id: string;
    template_name: string;
    mode: "replace" | "merge";
    device_count: number;
    scope_change_count: number;
    model_grants: number;
    group_grants: number;
    statements: number;
    statement_limit: number;
    items: Array<{
      device_id: string;
      name: string;
      from_scope: ModelScope;
      to_scope: ModelScope;
      revoked: boolean;
    }>;
  };
}

export interface ModelGroupMemberItem {
  model_id: string;
  model_name: string | null;
  display_name: string | null;
  provider_type: string | null;
  provider_name: string | null;
  position: number;
  enabled: number;
}

export interface GroupReasoning {
  supported: boolean;
  levels: Array<{ effort: string; description: string }>;
  default_level: string | null;
  source: string;
}

export interface ModelGroupItem {
  model_type?: ModelType;
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  enabled: number;
  model_public: number;
  pricing_mode: "unset" | "free" | "priced";
  input_price_per_m: number;
  output_price_per_m: number;
  cache_read_price_per_m: number;
  cache_write_price_per_m: number;
  cache_enabled: number;
  cache_ttl: number;
  peak_pricing_enabled: number;
  billing_unit?: "token" | "call";
  price_per_call?: number;
  search_price_per_call?: number;
  config_json: string | null;
  reasoning?: GroupReasoning;
  created_at: number | null;
  updated_at: number | null;
  members: ModelGroupMemberItem[];
}

export interface UsageItem {
  id: number;
  device_id: string | null;
  provider_id: string | null;
  provider_name: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  cache_hit?: number;
  image_count?: number;
  status_code: number | null;
  latency_ms: number | null;
  request_id: string | null;
  created_at: number;
}

export interface MetaRow {
  name: string;
  requests: number;
  tokens: number;
  cost_usd?: number;
  avg_latency_ms: number;
  errors: number;
}

export interface StatsResponse {
  range: string;
  since: number;
  summary: {
    request_count: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd?: number;
    cache_hit_count?: number;
    pricing_missing_count?: number;
    avg_latency_ms: number;
    error_count: number;
  };
  byProvider: MetaRow[];
  byModel: MetaRow[];
  trend: { date: string; requests: number; tokens: number; cost_usd?: number }[];
}

export interface CacheAnalyticsResponse {
  total_requests: number;
  cache_hits: number;
  cache_hit_rate: number;
  tokens_saved: number;
  cost_saved_usd: number;
  avg_cached_latency_ms: number;
  avg_direct_latency_ms: number;
  acceleration_ratio: number;
}

export interface ModelLatencyBenchmarkItem {
  model: string;
  provider_name: string;
  requests: number;
  avg_latency_ms: number;
  min_latency_ms: number;
  max_latency_ms: number;
  p90_latency_ms: number;
  error_count: number;
  error_rate: number;
}

export type ModelLatencyItem = ModelLatencyBenchmarkItem;

export interface MonthlyReportBreakdownItem {
  key: string;
  name: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  share_percent: number;
}

export interface MonthlyReportDailyTrend {
  date: string;
  request_count: number;
  total_tokens: number;
  cost_usd: number;
}

export interface MonthlyReport {
  month: string;
  start_time: number;
  end_time: number;
  total_cost_usd: number;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  cache_hit_count: number;
  cache_saved_tokens: number;
  cache_saved_cost_usd: number;
  by_provider: MonthlyReportBreakdownItem[];
  by_model: MonthlyReportBreakdownItem[];
  by_device: MonthlyReportBreakdownItem[];
  daily_trend: MonthlyReportDailyTrend[];
  mom_growth: {
    previous_month: string;
    previous_cost_usd: number;
    previous_requests: number;
    cost_growth_percent: number;
    request_growth_percent: number;
  };
}

export interface CostAnomalyAlert {
  is_anomaly: boolean;
  spike_date?: string;
  spike_cost_usd?: number;
  baseline_avg_usd?: number;
  spike_ratio?: number;
  message?: string;
  top_contributor_model?: string;
  top_contributor_device?: string;
}

export interface ModelSpendRankItem {
  model: string;
  display_name?: string;
  request_count: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  share_percent: number;
  avg_cost_per_request: number;
}

export interface CostAnalytics {
  range: string;
  total_cost_usd: number;
  anomaly_alert: CostAnomalyAlert;
  model_ranking: ModelSpendRankItem[];
}

export interface BudgetConfigResponse {
  monthly_budget_usd: number;
  budget_action: "warn" | "block";
  alert_threshold_pct: number;
  spent_this_month_usd: number;
}

export interface AnnouncementConfig {
  enabled: boolean;
  level: "info" | "warning" | "danger";
  title: string;
  message: string;
  updated_at: number | null;
}

export interface WebhookConfigResponse {
  url: string;
  events: string[];
  secret_configured: boolean;
}

export interface AuditLogItem {
  id: number;
  actor_type: string;
  ip: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  summary: string;
  details_json: string | null;
  created_at: number;
}

export interface ConfigSnapshotItem {
  id: string;
  name: string;
  description: string | null;
  size_bytes?: number;
  created_at: number;
}

export interface IpWhitelistConfig {
  enabled: boolean;
  allowed_ips: string[];
  client_ip?: string;
}

export interface KeyRotationItem {
  id: string;
  name: string;
  type: "provider" | "device";
  key_hint: string;
  created_at: number;
  updated_at?: number;
  age_days: number;
  status: "fresh" | "expiring_soon" | "expired";
  recommendation: string;
}

export interface RetentionConfig {
  enabled: boolean;
  retention_days: number;
  keep_daily_stats: boolean;
  allowed_days?: number[];
  estimated_cutoff_ms?: number;
}

export interface KeyRotationReport {
  recommended_rotation_days: number;
  fresh_count: number;
  expiring_soon_count: number;
  expired_count: number;
  items: KeyRotationItem[];
}

export interface PlaygroundMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
  latency_ms?: number;
  tokens?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}



