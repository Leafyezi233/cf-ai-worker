ALTER TABLE devices ADD COLUMN password_hash TEXT;
ALTER TABLE devices ADD COLUMN password_updated_at INTEGER;
ALTER TABLE devices ADD COLUMN calls_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE usage ADD COLUMN sub_token_id TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_device_sub_token ON usage (device_id, sub_token_id, created_at);
CREATE TABLE IF NOT EXISTS device_sub_tokens (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_sub_tokens_device ON device_sub_tokens (device_id, revoked_at);
