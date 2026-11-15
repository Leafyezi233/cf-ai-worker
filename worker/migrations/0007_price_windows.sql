CREATE TABLE IF NOT EXISTS price_windows (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  day_type TEXT NOT NULL,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_price_windows_model ON price_windows (model_id, enabled);
ALTER TABLE models ADD COLUMN peak_pricing_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN price_multiplier REAL NOT NULL DEFAULT 1;
ALTER TABLE usage ADD COLUMN price_window_id TEXT;
