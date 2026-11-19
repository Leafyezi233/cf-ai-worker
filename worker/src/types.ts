export type ProviderType = "anthropic" | "openai" | "gemini";

export type PricingMode = "unset" | "free" | "priced";

export type BillingUnit = "token" | "call";

export type ModelScope = "all" | "list" | "all_and_list";

export interface WalletRow {
  device_id: string;
  balance_usd: number;
  reserved_usd: number;
  created_at: number | null;
  updated_at: number | null;
}

export type LedgerReason = "topup" | "usage" | "refund" | "adjust";

export interface WalletLedgerRow {
  id: number;
  device_id: string;
  delta_usd: number;
  balance_after: number;
  reason: LedgerReason;
  request_id: string | null;
  note: string | null;
  created_at: number;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  CACHE_KV?: KVNamespace;
  VIDEO_REFERENCES?: R2Bucket;
  VIDEO_REFERENCE_IMAGES?: Fetcher;
  VIDEO_REFERENCE_IMAGE_ORIGIN?: string;
  RATE_LIMITER?: DurableObjectNamespace;
  ADMIN_PATH_PREFIX?: string;
  ADMIN_SECRET?: string;
  SESSION_SECRET?: string;
  ENCRYPTION_KEY?: string;
  GATEWAY_BASE_URL?: string;
  APP_NAME?: string;
  CF_ACCESS_ALLOWED_EMAILS?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  TRUST_FORWARD_HEADERS?: string;
  IP_RATE_LIMIT_RPM?: string;
  CORS_ALLOWED_ORIGINS?: string;
  [key: string]: any;
}

export interface PriceWindowRow {
  id: string;
  model_id: string;
  day_type: string;
  start_minute: number;
  end_minute: number;
  multiplier: number;
  enabled: number;
  created_at: number | null;
  updated_at: number | null;
}

export interface ProviderRow {
  id: string;
  name: string;
  type: ProviderType;
  endpoint: string | null;
  api_key: string | null;
  secret_name: string | null;
  enabled: number;
  config_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface ModelRow {
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
  cache_enabled: number;
  cache_ttl: number;
  enabled: number;
  model_public: number;
  pricing_mode: PricingMode;
  peak_pricing_enabled: number;
  billing_unit?: BillingUnit;
  price_per_call?: number;
  search_price_per_call?: number;
  config_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface ServiceGroupRow {
  id: string;
  name: string;
  description: string | null;
  public_selectable: number;
  selectable: number;
  enabled: number;
  multiplier: number;
  revision: number;
}

export type ServiceGroupTargetType = "model" | "group";

export interface ServiceGroupModelRow {
  id: string;
  service_group_id: string;
  model_key: string;
  target_type: ServiceGroupTargetType;
  target_id: string;
  pricing_json: string | null;
  member_ids_json: string | null;
}

export interface DeviceServiceGroupRow {
  device_id: string;
  service_group_id: string;
}

export interface TokenRoutingPolicy {
  mode: "auto" | "legacy" | "fixed" | "multi";
  group_ids: string[];
  selection: "ordered" | "input_price";
  failure_fallback: boolean;
  model_overrides: Record<string, string>;
  model_scope: string[] | null;
}

export interface EffectiveTokenRoutingPolicy {
  policy: TokenRoutingPolicy;
  version: string;
  source: "token" | "account" | "compatibility";
  scope_layers: string[][];
}

export interface DeviceRow {
  id: string;
  name: string;
  token_hash: string;
  enabled: number;
  rate_limit_rpm: number;
  cost_limit_monthly: number | null;
  last_used_at: number | null;
  created_at: number;
  revoked_at: number | null;
  model_scope: ModelScope;
  password_hash?: string | null;
  password_updated_at?: number | null;
  calls_enabled?: number;
  default_service_group_id?: string | null;
  service_group_id?: string | null;
  token_routing_policy?: EffectiveTokenRoutingPolicy;
  current_month_cost?: number;
  balance_usd?: number;
  reserved_usd?: number;
}

export interface AuthedDevice extends DeviceRow {
  auth_via?: "master" | "sub";
  sub_token_id?: string | null;
}

export interface SubTokenRow {
  id: string;
  device_id: string;
  name: string;
  token_hash: string;
  enabled: number;
  last_used_at: number | null;
  created_at: number;
  revoked_at: number | null;
  service_group_id?: string | null;
}

export interface UsageRow {
  id: number;
  device_id: string | null;
  sub_token_id?: string | null;
  service_group_id?: string | null;
  service_group_revision?: number | null;
  pricing_snapshot_json?: string | null;
  provider_id: string | null;
  provider_name: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  cache_hit: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  pricing_missing: number;
  price_multiplier: number;
  price_window_id: string | null;
  status_code: number | null;
  latency_ms: number | null;
  request_id: string | null;
  created_at: number;
  image_count?: number;
  search_calls?: number;
}

export interface DailyStatsRow {
  date: string;
  device_id: string | null;
  provider_id: string | null;
  model: string | null;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  cache_hit_count: number;
  cost_saved_usd: number;
  avg_latency_ms: number;
  error_count: number;
}

export interface ModelWithProvider extends ModelRow {
  provider_name: string;
  provider_type: ProviderType;
  provider_api_key: string | null;
  provider_secret_name: string | null;
  provider_endpoint: string | null;
  provider_config_json?: string | null;
}

export interface ModelGroupRow {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  enabled: number;
  model_public: number;
  pricing_mode: PricingMode;
  input_price_per_m: number;
  output_price_per_m: number;
  cache_read_price_per_m: number;
  cache_write_price_per_m: number;
  cache_enabled: number;
  cache_ttl: number;
  peak_pricing_enabled: number;
  billing_unit?: BillingUnit;
  price_per_call?: number;
  search_price_per_call?: number;
  config_json: string | null;
  created_at: number | null;
  updated_at: number | null;
}

export interface ModelGroupWithHint extends ModelGroupRow {
  first_member_type?: ProviderType | null;
  member_count?: number;
}

export type ModelGroupMemberRow = ModelWithProvider & { position: number };

export interface ModelGroupEdgeRow {
  group_id: string;
  model_id: string;
  model_name: string | null;
  display_name: string | null;
  provider_type: string | null;
  provider_name: string | null;
  position: number;
  enabled: number;
}

export interface DeviceTemplateRow {
  id: string;
  name: string;
  description: string | null;
  model_scope: ModelScope;
  created_at: number | null;
  updated_at: number | null;
}

export interface DeviceTemplateModelRow {
  model_id: string;
  model_name: string | null;
  display_name: string | null;
  provider_name: string | null;
  provider_type: string | null;
  rpm: number;
  enabled: number;
}

export interface DeviceTemplateGroupRow {
  group_id: string;
  name: string | null;
  display_name: string | null;
  enabled: number;
  rpm: number;
}

export interface DeviceTemplateWithGrants extends DeviceTemplateRow {
  models: DeviceTemplateModelRow[];
  groups: DeviceTemplateGroupRow[];
  device_count?: number;
}

export type ResolvedModelTarget =
  | { kind: "model"; candidates: ModelWithProvider[] }
  | { kind: "group"; group: ModelGroupRow; members: ModelGroupMemberRow[] }
  | { kind: "none" };

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cache_read_included_in_input?: boolean;
  reasoning_tokens?: number;
  search_calls?: number;
}

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

export interface AuditLogRow {
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

export interface ConfigSnapshotRow {
  id: string;
  name: string;
  description: string | null;
  snapshot_json: string;
  created_at: number;
}

export interface IpWhitelistConfig {
  enabled: boolean;
  allowed_ips: string[];
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

export interface KeyRotationReport {
  recommended_rotation_days: number;
  fresh_count: number;
  expiring_soon_count: number;
  expired_count: number;
  items: KeyRotationItem[];
}


