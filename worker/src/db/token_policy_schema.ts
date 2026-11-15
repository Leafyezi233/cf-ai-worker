export const TOKEN_POLICY_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS token_routing_policies (device_id TEXT NOT NULL, token_id TEXT NOT NULL, policy_json TEXT, revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY (device_id, token_id))",
  "CREATE TABLE IF NOT EXISTS token_routing_policy_groups (device_id TEXT NOT NULL, token_id TEXT NOT NULL, service_group_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (device_id, token_id, service_group_id), UNIQUE (device_id, token_id, position))",
  "CREATE INDEX IF NOT EXISTS idx_token_policy_group_refs ON token_routing_policy_groups(service_group_id)",
];
