CREATE TABLE IF NOT EXISTS reserve_holds (
  request_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reserve_holds_created ON reserve_holds (created_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_updated ON login_attempts (updated_at);
