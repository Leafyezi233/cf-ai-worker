import type { Env } from "../types";
import { ensureVersionedSchema, migrateVersionedSchema, resetSchemaCache as resetVersionedSchemaCache } from "./schema_versions";
import { PUBLIC_MODEL_IDENTITY_SCHEMA, PUBLIC_MODEL_IDENTITY_BACKFILL } from "./public_model_identity_schema";
import { TOKEN_POLICY_SCHEMA } from "./token_policy_schema";
import { MONTHLY_PASS_TABLES, MONTHLY_PASS_TRIGGERS } from "./monthly_pass_schema";
import { MONTHLY_PASS_OPERATIONS_SCHEMA } from "./monthly_pass_operations_schema";
import { MONTHLY_PASS_RETENTION_SCHEMA_SQL } from "./monthly_pass_retention";
import { USAGE_ROLLUP_TABLES, USAGE_ROLLUP_TRIGGERS } from "./usage_rollup_schema";

export const VIDEO_REFERENCE_SCHEDULE_SQL =
  "CASE WHEN a.state = 'uploading' THEN a.upload_lease_until " +
  "WHEN a.state IN ('lost','deleting') THEN 0 " +
  "WHEN a.task_id IS NULL THEN MIN(a.expires_at,a.created_at + 604800000) " +
  "ELSE MIN(a.created_at + 604800000,COALESCE((SELECT t.updated_at + 86400000 FROM video_tasks t " +
  "WHERE t.id = a.task_id AND t.status IN ('succeeded','failed')),a.created_at + 604800000)) END";
const referenceNewSchedule = VIDEO_REFERENCE_SCHEDULE_SQL.replace(/\ba\./g,"NEW.");

export const REQUEST_BILLING_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS billing_requests (
    request_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    sub_token_id TEXT,
    model TEXT NOT NULL,
    pricing_snapshot_json TEXT NOT NULL,
    reserved_usd REAL NOT NULL CHECK (reserved_usd >= 0),
    billing_state TEXT NOT NULL DEFAULT 'active' CHECK (billing_state IN ('active','pending','needs_reconciliation','settled')),
    outcome TEXT,
    usage_source TEXT,
    usage_provenance_json TEXT,
    terminal_snapshot_json TEXT,
    known_cost_usd REAL,
    hold_released_at INTEGER,
    terminal_attempt_id TEXT,
    terminal_at INTEGER,
    settled_at INTEGER,
    admission_nonce TEXT NOT NULL,
    settlement_nonce TEXT,
    lease_until INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_billing_requests_pending ON billing_requests(billing_state, settled_at, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_billing_requests_lease ON billing_requests(billing_state, lease_until)",
  `CREATE TABLE IF NOT EXISTS billing_attempts (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    protocol TEXT NOT NULL,
    usage_json TEXT,
    usage_source TEXT,
    provenance_json TEXT,
    outcome TEXT NOT NULL DEFAULT 'started',
    upstream_request_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(request_id, attempt_number)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_billing_attempts_request ON billing_attempts(request_id, created_at)",
];

export const INIT_STATEMENTS = [
  ...REQUEST_BILLING_SCHEMA,
  ...PUBLIC_MODEL_IDENTITY_SCHEMA,
  ...TOKEN_POLICY_SCHEMA,
  `CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    endpoint TEXT,
    api_key TEXT,
    secret_name TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    config_json TEXT,
    created_at INTEGER,
    updated_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    display_name TEXT,
    alias TEXT,
    fallback_model_id TEXT,
    input_price_per_m REAL NOT NULL DEFAULT 0,
    output_price_per_m REAL NOT NULL DEFAULT 0,
    cache_read_price_per_m REAL NOT NULL DEFAULT 0,
    cache_write_price_per_m REAL NOT NULL DEFAULT 0,
    cache_enabled INTEGER NOT NULL DEFAULT 0,
    cache_ttl INTEGER NOT NULL DEFAULT 3600,
    enabled INTEGER NOT NULL DEFAULT 1,
    model_public INTEGER NOT NULL DEFAULT 0,
    pricing_mode TEXT NOT NULL DEFAULT 'unset',
    peak_pricing_enabled INTEGER NOT NULL DEFAULT 0,
    config_json TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    billing_unit TEXT NOT NULL DEFAULT 'token',
    price_per_call REAL NOT NULL DEFAULT 0,
    search_price_per_call REAL NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    rate_limit_rpm INTEGER NOT NULL DEFAULT 0,
    cost_limit_monthly REAL NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    created_at INTEGER,
    revoked_at INTEGER,
    model_scope TEXT NOT NULL DEFAULT 'all',
    -- Account layer. The password is the SECOND factor for the few console writes that mint or
    -- disable credentials; the device token stays the login.
    password_hash TEXT,
    password_updated_at INTEGER,
    -- Separate from enabled on purpose: disabling a device kills the credential, while this only
    -- stops NEW gateway calls and keeps the console (and its re-enable button) reachable.
    calls_enabled INTEGER NOT NULL DEFAULT 1,
    default_service_group_id TEXT,
    service_group_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    provider_id TEXT,
    provider_name TEXT,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    cache_hit INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    pricing_missing INTEGER NOT NULL DEFAULT 0,
    price_multiplier REAL NOT NULL DEFAULT 1,
    price_window_id TEXT,
    status_code INTEGER,
    latency_ms INTEGER,
    request_id TEXT,
    created_at INTEGER,
    image_count INTEGER NOT NULL DEFAULT 0,
    search_calls INTEGER NOT NULL DEFAULT 0,
    -- Which sub token spent this row. NULL means the master token spent it, which is also the
    -- honest reading of every row written before this column existed.
    sub_token_id TEXT,
    service_group_id TEXT,
    service_group_revision INTEGER,
    pricing_snapshot_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_provider_id ON usage (provider_id)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_model ON usage (model)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_request_id ON usage (request_id)`,
  `DROP INDEX IF EXISTS idx_usage_device_id`,
  `CREATE INDEX IF NOT EXISTS idx_usage_device_created ON usage (device_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS device_sub_tokens (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    service_group_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT,
    updated_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_models_model_lookup ON models (model_name, enabled)`,
  `CREATE INDEX IF NOT EXISTS idx_models_alias_lookup ON models (alias, enabled)`,
  `CREATE INDEX IF NOT EXISTS idx_models_provider_id ON models (provider_id)`,
  `CREATE TABLE IF NOT EXISTS daily_stats (
    date TEXT NOT NULL,
    device_id TEXT,
    provider_id TEXT,
    provider_name TEXT NOT NULL DEFAULT '',
    model TEXT,
    request_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    cache_hit_count INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_saved_usd REAL NOT NULL DEFAULT 0,
    pricing_missing_count INTEGER NOT NULL DEFAULT 0,
    search_calls INTEGER NOT NULL DEFAULT 0,
    avg_latency_ms REAL NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, device_id, provider_id, model)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats (date)`,
  `CREATE INDEX IF NOT EXISTS idx_daily_stats_device_date ON daily_stats (device_id, date)`,
  `CREATE TABLE IF NOT EXISTS device_wallets (
    device_id TEXT PRIMARY KEY,
    balance_usd REAL NOT NULL DEFAULT 0,
    reserved_usd REAL NOT NULL DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS wallet_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    delta_usd REAL NOT NULL,
    balance_after REAL NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    request_id TEXT,
    note TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_ledger_idem ON wallet_ledger (device_id, reason, request_id) WHERE request_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_ledger_device ON wallet_ledger (device_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_ledger_request_reason ON wallet_ledger (request_id, reason)`,
  `CREATE TABLE IF NOT EXISTS price_windows (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    day_type TEXT NOT NULL,
    start_minute INTEGER NOT NULL,
    end_minute INTEGER NOT NULL,
    multiplier REAL NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_price_windows_model ON price_windows (model_id, enabled)`,
  `CREATE TABLE IF NOT EXISTS device_models (
    device_id TEXT NOT NULL,
    model_id  TEXT NOT NULL,
    rpm INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, model_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_device_models_model ON device_models (model_id)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_type TEXT NOT NULL DEFAULT 'admin',
    ip TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    summary TEXT NOT NULL,
    details_json TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at)`,
  `CREATE TABLE IF NOT EXISTS config_snapshots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    snapshot_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_config_snapshots_created_at ON config_snapshots (created_at)`,
  `CREATE TABLE IF NOT EXISTS reserve_holds (
    request_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reserve_holds_created ON reserve_holds (created_at)`,
  `CREATE TABLE IF NOT EXISTS video_tasks (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    sub_token_id TEXT,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('submitting', 'submission_unknown', 'pending', 'succeeded', 'failed')),
    upstream_task_id TEXT,
    route_json TEXT NOT NULL,
    price_usd REAL NOT NULL CHECK (price_usd >= 0),
    pricing_snapshot_json TEXT NOT NULL,
    result_url TEXT,
    error_code TEXT,
    poll_after INTEGER,
    poll_lease_until INTEGER,
    poll_claim TEXT,
    poll_attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    settlement_claim TEXT,
    UNIQUE (device_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_video_tasks_device_created ON video_tasks (device_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_video_tasks_status_poll ON video_tasks (status, poll_after)`,
  `CREATE INDEX IF NOT EXISTS idx_video_tasks_device_created_id ON video_tasks (device_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_video_tasks_device_sub_created_id ON video_tasks (device_id, sub_token_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_video_tasks_status_created ON video_tasks (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_video_tasks_active_global ON video_tasks (price_usd) WHERE status IN ('submitting', 'submission_unknown', 'pending')`,
  `CREATE INDEX IF NOT EXISTS idx_video_tasks_active_device ON video_tasks (device_id, price_usd) WHERE status IN ('submitting', 'submission_unknown', 'pending')`,
  `CREATE TABLE IF NOT EXISTS video_diagnostic_arms (
    device_id TEXT PRIMARY KEY,
    arm_id TEXT NOT NULL UNIQUE,
    task_id TEXT UNIQUE,
    armed_at INTEGER NOT NULL,
    task_rowid_floor INTEGER NOT NULL,
    enabled_until INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_video_diagnostic_arms_expiry ON video_diagnostic_arms (enabled_until)`,
  `CREATE TABLE IF NOT EXISTS video_diagnostic_grants (
    task_id TEXT PRIMARY KEY,
    arm_id TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    consumed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_video_diagnostic_grants_expiry ON video_diagnostic_grants (expires_at)`,
  `CREATE TABLE IF NOT EXISTS video_diagnostics (
    task_id TEXT NOT NULL,
    slot TEXT NOT NULL CHECK (slot IN ('create', 'processing', 'terminal', 'error')),
    http_status INTEGER,
    content_type TEXT,
    body_sealed TEXT NOT NULL CHECK (length(body_sealed) <= 100000),
    truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
    captured_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, slot)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_video_diagnostics_expiry ON video_diagnostics (expires_at)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_login_attempts_updated ON login_attempts (updated_at)`,
  `CREATE TABLE IF NOT EXISTS model_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_name TEXT,
    description TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    model_public INTEGER NOT NULL DEFAULT 0,
    pricing_mode TEXT NOT NULL DEFAULT 'unset',
    input_price_per_m REAL NOT NULL DEFAULT 0,
    output_price_per_m REAL NOT NULL DEFAULT 0,
    cache_read_price_per_m REAL NOT NULL DEFAULT 0,
    cache_write_price_per_m REAL NOT NULL DEFAULT 0,
    cache_enabled INTEGER NOT NULL DEFAULT 0,
    cache_ttl INTEGER NOT NULL DEFAULT 3600,
    peak_pricing_enabled INTEGER NOT NULL DEFAULT 0,
    config_json TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    billing_unit TEXT NOT NULL DEFAULT 'token',
    price_per_call REAL NOT NULL DEFAULT 0,
    search_price_per_call REAL NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_model_groups_name ON model_groups (name)`,
  `CREATE TABLE IF NOT EXISTS model_group_members (
    group_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (group_id, model_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_model_group_members_position ON model_group_members (group_id, position)`,
  `CREATE TABLE IF NOT EXISTS device_model_groups (
    device_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    rpm INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, group_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_device_model_groups_group ON device_model_groups (group_id)`,
  `CREATE TABLE IF NOT EXISTS video_reference_r2_budget (
    period TEXT PRIMARY KEY CHECK (length(period) = 7),
    put_attempts INTEGER NOT NULL DEFAULT 0 CHECK (put_attempts BETWEEN 0 AND 10000),
    get_attempts INTEGER NOT NULL DEFAULT 0 CHECK (get_attempts BETWEEN 0 AND 100000)
  )`,
  `CREATE TABLE IF NOT EXISTS video_reference_assets (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, sub_token_id TEXT,
    object_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    width INTEGER, height INTEGER, checksum_sha256 TEXT,
    state TEXT NOT NULL CHECK(state IN ('uploading','ready','deleting','lost','deleted')),
    task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    upload_lease_until INTEGER NOT NULL,
    upload_token TEXT, write_outcome TEXT NOT NULL DEFAULT 'unknown', cancelled_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS video_reference_cleanup (
    asset_id TEXT PRIMARY KEY, object_key TEXT NOT NULL UNIQUE,
    next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT, lease_until INTEGER, reason TEXT NOT NULL DEFAULT 'expiry'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_video_reference_due ON video_reference_cleanup(next_attempt_at,asset_id)`,
  `CREATE TABLE IF NOT EXISTS video_reference_cleanup_backfill (
    id INTEGER PRIMARY KEY CHECK(id = 1), cursor_rowid INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0
  )`,
  `INSERT OR IGNORE INTO video_reference_cleanup_backfill(id) VALUES (1)`,
  `CREATE INDEX IF NOT EXISTS idx_video_reference_owner_created ON video_reference_assets(device_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_video_reference_cleanup ON video_reference_assets(state, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_video_reference_task ON video_reference_assets(task_id)`,
  `CREATE TRIGGER IF NOT EXISTS video_reference_bind_task AFTER INSERT ON video_tasks
    WHEN json_type(NEW.route_json, '$.reference_image_ids') IS NOT NULL
    BEGIN
      SELECT CASE WHEN json_type(NEW.route_json, '$.reference_image_ids') <> 'array'
        OR json_array_length(NEW.route_json, '$.reference_image_ids') > 3
        OR (SELECT COUNT(*) FROM json_each(NEW.route_json, '$.reference_image_ids')) <>
           (SELECT COUNT(DISTINCT value) FROM json_each(NEW.route_json, '$.reference_image_ids'))
        OR EXISTS (SELECT 1 FROM json_each(NEW.route_json, '$.reference_image_ids') j
          WHERE j.type <> 'text' OR NOT EXISTS (SELECT 1 FROM video_reference_assets a WHERE a.id = j.value
            AND a.device_id = NEW.device_id AND a.sub_token_id IS NEW.sub_token_id
            AND a.state = 'ready' AND a.task_id IS NULL AND a.expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)))
        OR (SELECT COALESCE(SUM(size_bytes),0) FROM video_reference_assets WHERE id IN
          (SELECT value FROM json_each(NEW.route_json, '$.reference_image_ids'))) > 15728640
        THEN RAISE(ABORT, 'invalid_video_references') END;
      UPDATE video_reference_assets SET task_id = NEW.id, updated_at = unixepoch('now') * 1000,
        expires_at = created_at + 604800000
        WHERE id IN (SELECT value FROM json_each(NEW.route_json, '$.reference_image_ids'));
    END`,
  `CREATE TABLE IF NOT EXISTS service_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    public_selectable INTEGER NOT NULL DEFAULT 0,
    selectable INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    multiplier REAL NOT NULL DEFAULT 1 CHECK (multiplier >= 0),
    revision INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS service_group_models (
    id TEXT PRIMARY KEY,
    service_group_id TEXT NOT NULL,
    model_key TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('model', 'group')),
    target_id TEXT NOT NULL,
    pricing_json TEXT,
    member_ids_json TEXT,
    UNIQUE (service_group_id, model_key)
  )`,
  `CREATE TABLE IF NOT EXISTS device_service_groups (
    device_id TEXT NOT NULL,
    service_group_id TEXT NOT NULL,
    PRIMARY KEY (device_id, service_group_id)
  )`,
  `CREATE TABLE IF NOT EXISTS device_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    model_scope TEXT NOT NULL DEFAULT 'list',
    created_at INTEGER,
    updated_at INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_device_templates_name ON device_templates (name)`,
  `CREATE TABLE IF NOT EXISTS device_template_models (
    template_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    rpm INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (template_id, model_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_device_template_models_model ON device_template_models (model_id)`,
  `CREATE TABLE IF NOT EXISTS device_template_groups (
    template_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    rpm INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (template_id, group_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_device_template_groups_group ON device_template_groups (group_id)`,
  `CREATE TABLE IF NOT EXISTS device_template_bindings (
    device_id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_device_template_bindings_template ON device_template_bindings (template_id)`
];

export const MIGRATION_ALTERS = [
  "ALTER TABLE video_reference_assets ADD COLUMN upload_token TEXT",
  "ALTER TABLE video_reference_assets ADD COLUMN write_outcome TEXT NOT NULL DEFAULT 'unknown'",
  "ALTER TABLE video_reference_assets ADD COLUMN cancelled_at INTEGER",
  "CREATE INDEX IF NOT EXISTS idx_video_reference_settled_tombstone ON video_reference_assets(updated_at,id) " +
    "WHERE state = 'deleted' AND write_outcome IN ('confirmed','absent')",
  `CREATE TRIGGER IF NOT EXISTS video_reference_schedule_insert AFTER INSERT ON video_reference_assets
    WHEN NEW.state <> 'deleted' BEGIN
      INSERT INTO video_reference_cleanup(asset_id,object_key,next_attempt_at)
      VALUES (NEW.id,NEW.object_key,${referenceNewSchedule});
    END`,
  `CREATE TRIGGER IF NOT EXISTS video_reference_schedule_update
    AFTER UPDATE OF state,task_id,expires_at,created_at,upload_lease_until ON video_reference_assets BEGIN
      DELETE FROM video_reference_cleanup WHERE asset_id = NEW.id AND NEW.state = 'deleted';
      INSERT INTO video_reference_cleanup(asset_id,object_key,next_attempt_at)
        SELECT NEW.id,NEW.object_key,${referenceNewSchedule} WHERE NEW.state <> 'deleted'
        ON CONFLICT(asset_id) DO UPDATE SET next_attempt_at = excluded.next_attempt_at
        WHERE video_reference_cleanup.lease_token IS NULL;
    END`,
  `CREATE TRIGGER IF NOT EXISTS video_reference_schedule_terminal AFTER UPDATE OF status,updated_at ON video_tasks
    WHEN NEW.status IN ('succeeded','failed') AND (OLD.status <> NEW.status OR OLD.updated_at <> NEW.updated_at)
    BEGIN
      UPDATE video_reference_assets SET expires_at = MIN(created_at + 604800000,NEW.updated_at + 86400000)
        WHERE task_id = NEW.id AND state = 'ready';
    END`,
  `CREATE TRIGGER IF NOT EXISTS video_reference_bind_write_guard AFTER INSERT ON video_tasks
    WHEN json_type(NEW.route_json,'$.reference_image_ids') = 'array' BEGIN
      -- Legacy ready already proved a successful PUT; lazily normalize only those referenced rows.
      UPDATE video_reference_assets SET write_outcome = 'confirmed', upload_token = 'legacy:' || id
        WHERE id IN (SELECT value FROM json_each(NEW.route_json,'$.reference_image_ids'))
          AND state = 'ready' AND upload_token IS NULL AND write_outcome = 'unknown' AND cancelled_at IS NULL;
      SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.route_json,'$.reference_image_ids') j
        JOIN video_reference_assets a ON a.id = j.value
        WHERE a.cancelled_at IS NOT NULL OR a.write_outcome <> 'confirmed'
          OR EXISTS (SELECT 1 FROM video_reference_cleanup q WHERE q.asset_id = a.id AND q.lease_token IS NOT NULL))
        THEN RAISE(ABORT,'invalid_video_references') END;
    END`,
  "ALTER TABLE models ADD COLUMN peak_pricing_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE usage ADD COLUMN price_multiplier REAL NOT NULL DEFAULT 1",
  "ALTER TABLE usage ADD COLUMN price_window_id TEXT",
  "ALTER TABLE providers ADD COLUMN api_key TEXT",
  "ALTER TABLE models ADD COLUMN fallback_model_id TEXT",
  "ALTER TABLE models ADD COLUMN input_price_per_m REAL NOT NULL DEFAULT 0",
  "ALTER TABLE models ADD COLUMN output_price_per_m REAL NOT NULL DEFAULT 0",
  "ALTER TABLE models ADD COLUMN cache_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE models ADD COLUMN cache_ttl INTEGER NOT NULL DEFAULT 3600",
  "ALTER TABLE models ADD COLUMN model_public INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE models ADD COLUMN pricing_mode TEXT NOT NULL DEFAULT 'unset'",
  "ALTER TABLE usage ADD COLUMN pricing_missing INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN rate_limit_rpm INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN cost_limit_monthly REAL NOT NULL DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN model_scope TEXT NOT NULL DEFAULT 'all'",
  `CREATE TABLE IF NOT EXISTS device_models (
    device_id TEXT NOT NULL,
    model_id  TEXT NOT NULL,
    rpm INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, model_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_device_models_model ON device_models (model_id)",
  "ALTER TABLE device_models ADD COLUMN rpm INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE usage ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0",
  "ALTER TABLE models ADD COLUMN cache_read_price_per_m REAL NOT NULL DEFAULT 0",
  "ALTER TABLE models ADD COLUMN cache_write_price_per_m REAL NOT NULL DEFAULT 0",
  "ALTER TABLE usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE daily_stats ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE daily_stats ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE usage ADD COLUMN cache_hit INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE daily_stats ADD COLUMN cache_hit_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE daily_stats ADD COLUMN cost_saved_usd REAL NOT NULL DEFAULT 0",
  "ALTER TABLE daily_stats ADD COLUMN provider_name TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE daily_stats ADD COLUMN pricing_missing_count INTEGER NOT NULL DEFAULT 0",
  "CREATE INDEX IF NOT EXISTS idx_models_model_lookup ON models (model_name, enabled)",
  "CREATE INDEX IF NOT EXISTS idx_models_alias_lookup ON models (alias, enabled)",
  "CREATE INDEX IF NOT EXISTS idx_models_provider_id ON models (provider_id)",
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_type TEXT NOT NULL DEFAULT 'admin',
    ip TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    summary TEXT NOT NULL,
    details_json TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS config_snapshots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    snapshot_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS device_wallets (
    device_id TEXT PRIMARY KEY,
    balance_usd REAL NOT NULL DEFAULT 0,
    reserved_usd REAL NOT NULL DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS wallet_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    delta_usd REAL NOT NULL,
    balance_after REAL NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    request_id TEXT,
    note TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_ledger_idem ON wallet_ledger (device_id, reason, request_id) WHERE request_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_ledger_device ON wallet_ledger (device_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_ledger_request_reason ON wallet_ledger (request_id, reason)`,
  "UPDATE models SET pricing_mode = 'priced' WHERE pricing_mode = 'unset' AND (input_price_per_m > 0 OR output_price_per_m > 0)",
  `INSERT OR IGNORE INTO device_wallets (device_id, balance_usd, reserved_usd, created_at, updated_at)
   SELECT id, MAX(COALESCE(cost_limit_monthly, 0), 0), 0, created_at, created_at FROM devices`,
  "ALTER TABLE models ADD COLUMN billing_unit TEXT NOT NULL DEFAULT 'token'",
  "ALTER TABLE models ADD COLUMN price_per_call REAL NOT NULL DEFAULT 0",
  "ALTER TABLE model_groups ADD COLUMN billing_unit TEXT NOT NULL DEFAULT 'token'",
  "ALTER TABLE model_groups ADD COLUMN price_per_call REAL NOT NULL DEFAULT 0",
  "ALTER TABLE usage ADD COLUMN image_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE models ADD COLUMN search_price_per_call REAL NOT NULL DEFAULT 0",
  "ALTER TABLE model_groups ADD COLUMN search_price_per_call REAL NOT NULL DEFAULT 0",
  "ALTER TABLE usage ADD COLUMN search_calls INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE daily_stats ADD COLUMN search_calls INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN password_hash TEXT",
  "ALTER TABLE devices ADD COLUMN password_updated_at INTEGER",
  "ALTER TABLE devices ADD COLUMN calls_enabled INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE usage ADD COLUMN sub_token_id TEXT",
  PUBLIC_MODEL_IDENTITY_BACKFILL,
  "ALTER TABLE devices ADD COLUMN default_service_group_id TEXT",
  "ALTER TABLE devices ADD COLUMN service_group_id TEXT",
  "ALTER TABLE device_sub_tokens ADD COLUMN service_group_id TEXT",
  "ALTER TABLE usage ADD COLUMN service_group_id TEXT",
  "ALTER TABLE usage ADD COLUMN service_group_revision INTEGER",
  "ALTER TABLE usage ADD COLUMN pricing_snapshot_json TEXT",
  "ALTER TABLE video_tasks ADD COLUMN settlement_claim TEXT",
  "ALTER TABLE video_tasks ADD COLUMN poll_claim TEXT",
  "ALTER TABLE video_tasks ADD COLUMN poll_attempts INTEGER NOT NULL DEFAULT 0",
  "CREATE INDEX IF NOT EXISTS idx_device_service_groups_group ON device_service_groups (service_group_id)",
  "CREATE INDEX IF NOT EXISTS idx_usage_device_sub_token ON usage (device_id, sub_token_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_device_sub_tokens_device ON device_sub_tokens (device_id, revoked_at)",
];

export const COLUMN_PROBE_SQL =
  "SELECT json_group_array(m.name || '.' || p.name) AS cols FROM sqlite_master m " +
  "JOIN pragma_table_info(m.name) p WHERE m.type = 'table' " +
  "AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '\\_%' ESCAPE '\\'";

const ADD_COLUMN_RE = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i;

export function pendingMigrations(columns: Set<string>, statements: string[] = MIGRATION_ALTERS): string[] {
  return statements.filter((sql) => {
    const match = ADD_COLUMN_RE.exec(sql.trim());
    if (!match) return true;
    return !columns.has(`${match[1]}.${match[2]}`.toLowerCase());
  });
}

const CREATE_INDEX_RE = /^CREATE\s+(UNIQUE\s+)?INDEX/i;

export function splitPendingForIndexes(statements: string[]): { schema: string[]; indexes: string[] } {
  const schema: string[] = [];
  const indexes: string[] = [];
  for (const sql of statements) {
    if (CREATE_INDEX_RE.test(sql.trim())) indexes.push(sql);
    else schema.push(sql);
  }
  return { schema, indexes };
}

export const SCHEMA_DEFINITION = { init: INIT_STATEMENTS, migrations: MIGRATION_ALTERS, extensions: [
  { id: "monthly/0001-tables", sql: MONTHLY_PASS_TABLES },
  { id: "monthly/0002-funding", sql: MONTHLY_PASS_TRIGGERS },
  { id: "monthly/0003-operations", sql: MONTHLY_PASS_OPERATIONS_SCHEMA.slice(0, 1) },
  { id: "monthly/0004-operation-apply", sql: MONTHLY_PASS_OPERATIONS_SCHEMA.slice(1) },
  { id: "monthly/0005-retention", sql: MONTHLY_PASS_RETENTION_SCHEMA_SQL },
  { id: "usage/0001-tables", sql: USAGE_ROLLUP_TABLES },
  { id: "usage/0002-rollups", sql: USAGE_ROLLUP_TRIGGERS },
  { id: "video/0001-upstream-usage", sql: ["ALTER TABLE video_tasks ADD COLUMN upstream_usage_json TEXT"] },
] };

export function ensureSchema(env: Env): Promise<void> {
  return ensureVersionedSchema(env?.DB, SCHEMA_DEFINITION);
}

export function migrateSchema(env: Env): Promise<void> {
  return migrateVersionedSchema(env?.DB, SCHEMA_DEFINITION);
}

export function resetSchemaCache(db?: D1Database): void {
  resetVersionedSchemaCache(db);
}

