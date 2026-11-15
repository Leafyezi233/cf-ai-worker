export function isRawCatalogVisible(row: { config_json?: string | null }): boolean {
  if (!row.config_json) return true;
  try {
    const config: unknown = JSON.parse(row.config_json);
    return !config || typeof config !== "object" || Array.isArray(config)
      || (config as Record<string, unknown>).catalog_visible !== false;
  } catch {
    return true;
  }
}
