export const PUBLIC_MODEL_IDENTITY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS public_model_identities (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)))`,
  `CREATE TABLE IF NOT EXISTS service_model_aliases (service_group_id TEXT NOT NULL, name TEXT NOT NULL, mapping_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), PRIMARY KEY(service_group_id,name))`,
  `CREATE INDEX IF NOT EXISTS idx_service_model_aliases_mapping ON service_model_aliases(mapping_id)`,
  `CREATE TABLE IF NOT EXISTS public_model_write_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid = 1))`,
];

export const PUBLIC_MODEL_IDENTITY_BACKFILL =
  "INSERT OR IGNORE INTO public_model_identities(id,name,enabled) SELECT 'public_' || lower(hex(randomblob(16))), model_key, 1 FROM service_group_models GROUP BY model_key";
