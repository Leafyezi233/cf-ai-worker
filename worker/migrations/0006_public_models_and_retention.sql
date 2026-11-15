ALTER TABLE models ADD COLUMN model_public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN pricing_missing INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_models_public ON models (model_public, enabled);
