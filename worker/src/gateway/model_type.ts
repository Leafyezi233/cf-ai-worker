export type ModelTypeInput = { config_json?: string | null; billing_unit?: string };
export function resolveModelType(row: ModelTypeInput): "text" | "image" | "embedding" | "video" {
  try { const cfg = JSON.parse(row.config_json || "{}");
    if (cfg?.model_type === "text" || cfg?.model_type === "image" || cfg?.model_type === "embedding" || cfg?.model_type === "video") return cfg.model_type;
  } catch {   }
  return row.billing_unit === "call" ? "image" : "text";
}
export function isImageModel(row: ModelTypeInput): boolean { return resolveModelType(row) === "image"; }
