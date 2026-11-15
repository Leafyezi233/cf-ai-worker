import { Badge } from "./ui";

const CONFIG_ERROR = "config_json 必须是合法的 JSON 对象；请先修正高级配置，列表显示设置不会覆盖无效内容。";

function readConfig(configJson: string | null | undefined): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(configJson?.trim() || "{}"); }
  catch { throw new Error(CONFIG_ERROR); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(CONFIG_ERROR);
  return value as Record<string, unknown>;
}

export function readCatalogVisibility(configJson: string | null | undefined): { visible: boolean; error: string | null } {
  try { return { visible: readConfig(configJson).catalog_visible !== false, error: null }; }
  catch (error) { return { visible: true, error: error instanceof Error ? error.message : CONFIG_ERROR }; }
}

export function setCatalogVisible(configJson: string, visible: boolean): string {
  const config = readConfig(configJson);
  if (visible) delete config.catalog_visible;
  else config.catalog_visible = false;
  return Object.keys(config).length ? JSON.stringify(config, null, 2) : "";
}

export const CATALOG_VISIBILITY_HELP = "取消勾选仅从用户模型列表隐藏原始模型名、原始别名或原始模型组名；不会禁用模型或分组，不改变启用状态、公开权限或调用权限，也不会隐藏服务分组中显式映射的规范名（canonical name）。未设置 catalog_visible 时默认显示。";

export function ModelCatalogVisibility({ configJson, onChange }: {
  configJson: string;
  onChange: (visible: boolean) => void;
}) {
  const { visible, error } = readCatalogVisibility(configJson);
  return <div className="rounded-xl border border-slate-200 p-3.5 space-y-2 dark:border-slate-800">
    <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
      <input type="checkbox" aria-label="在用户模型列表中显示" checked={visible} disabled={!!error}
        onChange={event => onChange(event.target.checked)} />
      在用户模型列表中显示
    </label>
    <p className="text-xs text-slate-500 dark:text-slate-400">{CATALOG_VISIBILITY_HELP}</p>
    {error ? <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}
  </div>;
}

export function ModelCatalogVisibilityBadge({ configJson, visible }: { configJson?: string | null; visible?: boolean }) {
  return (visible ?? readCatalogVisibility(configJson).visible) ? null : <Badge tone="slate" title={CATALOG_VISIBILITY_HELP}>列表隐藏</Badge>;
}
