ALTER TABLE devices ADD COLUMN model_scope TEXT NOT NULL DEFAULT 'all';
CREATE TABLE IF NOT EXISTS device_models (
  device_id TEXT NOT NULL,
  model_id  TEXT NOT NULL,
  PRIMARY KEY (device_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_device_models_model ON device_models (model_id);
