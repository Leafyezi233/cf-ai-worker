import { z } from "zod";
import type { Env } from "../types";

export const CATEGORY_COLORS = ["slate", "blue", "green", "amber", "red", "purple"] as const;
export const CategorySchema = z.object({
  id: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(100),
  description: z.string().max(1000), sort_order: z.number().int().min(-1000000).max(1000000),
  color: z.enum(CATEGORY_COLORS), enabled: z.union([z.literal(0), z.literal(1)]),
}).strict();
export type CategoryRow = z.infer<typeof CategorySchema>;
const BindingSchema = z.object({ model_name: z.string().trim().min(1).max(200), category_id: CategorySchema.shape.id }).strict();
export type CategoryBinding = z.infer<typeof BindingSchema>;
export type ModelCategoriesBackup = { model_categories: CategoryRow[]; model_category_bindings: CategoryBinding[] };
export const MODEL_CATEGORIES_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS model_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL DEFAULT 'slate' CHECK(color IN ('slate','blue','green','amber','red','purple')), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)))",
  "CREATE TABLE IF NOT EXISTS model_category_bindings (model_name TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES model_categories(id) ON DELETE CASCADE, PRIMARY KEY(model_name,category_id))",
  "CREATE INDEX IF NOT EXISTS idx_model_category_bindings_category ON model_category_bindings(category_id,model_name)",
  "CREATE TABLE IF NOT EXISTS model_category_write_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1))",
];
const ready = new WeakMap<object, Promise<void>>();
export async function ensureModelCategoriesSchema(env: Env): Promise<void> {
  let promise = ready.get(env.DB);
  if (!promise) {
    promise = (async () => { for (const sql of MODEL_CATEGORIES_SCHEMA) await env.DB.prepare(sql).run(); })();
    ready.set(env.DB, promise);
    promise.catch(() => { if (ready.get(env.DB) === promise) ready.delete(env.DB); });
  }
  await promise;
}
export async function exportModelCategories(env: Env): Promise<ModelCategoriesBackup> {
  await ensureModelCategoriesSchema(env);
  const [categories, bindings] = await Promise.all([
    env.DB.prepare("SELECT id,name,description,sort_order,color,enabled FROM model_categories ORDER BY sort_order,name,id").all<CategoryRow>(),
    env.DB.prepare("SELECT model_name,category_id FROM model_category_bindings ORDER BY model_name,category_id").all<CategoryBinding>(),
  ]);
  return { model_categories: categories.results ?? [], model_category_bindings: bindings.results ?? [] };
}
export function validateModelCategoriesBackup(input: unknown): ModelCategoriesBackup | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_model_categories_backup");
  const obj = input as Record<string, unknown>;
  const hasCategories = Object.prototype.hasOwnProperty.call(obj, "model_categories");
  const hasBindings = Object.prototype.hasOwnProperty.call(obj, "model_category_bindings");
  if (!hasCategories && !hasBindings) return undefined;
  if (!hasCategories || !hasBindings) throw new Error("incomplete_model_categories_backup");
  const data = z.object({ model_categories: z.array(CategorySchema).max(10000), model_category_bindings: z.array(BindingSchema).max(100000) }).parse(obj);
  const ids = new Set<string>(), names = new Set<string>(), pairs = new Set<string>();
  for (const c of data.model_categories) {
    if (ids.has(c.id) || names.has(c.name)) throw new Error("duplicate_model_category");
    ids.add(c.id); names.add(c.name);
  }
  for (const b of data.model_category_bindings) {
    const pair = JSON.stringify([b.model_name,b.category_id]);
    if (!ids.has(b.category_id) || pairs.has(pair)) throw new Error("invalid_model_category_binding");
    pairs.add(pair);
  }
  return data;
}
export function restoreModelCategoriesStatements(env: Env, input: unknown, mode: "replace" | "merge" = "replace"): D1PreparedStatement[] {
  const data = validateModelCategoriesBackup(input);
  if (!data) return [];
  if (mode !== "replace" && mode !== "merge") throw new Error("invalid_model_categories_restore_mode");
  const out: D1PreparedStatement[] = [];
  if (mode === "replace") out.push(env.DB.prepare("DELETE FROM model_category_bindings"),env.DB.prepare("DELETE FROM model_categories"));
  for (const c of data.model_categories) out.push(env.DB.prepare("INSERT INTO model_categories(id,name,description,sort_order,color,enabled) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,sort_order=excluded.sort_order,color=excluded.color,enabled=excluded.enabled").bind(c.id,c.name,c.description,c.sort_order,c.color,c.enabled));
  for (const b of data.model_category_bindings) out.push(env.DB.prepare("INSERT OR IGNORE INTO model_category_bindings(model_name,category_id) VALUES(?,?)").bind(b.model_name,b.category_id));
  return out;
}
export function renameModelCategoryKeyStatements(env: Env, oldName: string, newName: string): D1PreparedStatement[] {
  const key = BindingSchema.shape.model_name;
  oldName = key.parse(oldName); newName = key.parse(newName);
  if (oldName === newName) return [];
  const guard = "category_rename_" + crypto.randomUUID();
  return [
    env.DB.prepare("INSERT INTO model_category_write_guards(id,valid) SELECT ?,0 WHERE EXISTS(SELECT 1 FROM model_category_bindings WHERE model_name=?) AND EXISTS(SELECT 1 FROM model_category_bindings WHERE model_name=?)").bind(guard,oldName,newName),
    env.DB.prepare("UPDATE model_category_bindings SET model_name=? WHERE model_name=?").bind(newName,oldName),
  ];
}
export type PublicCategory = Pick<CategoryRow,"id"|"name"|"description"|"sort_order"|"color">;
export async function attachModelCategories<T extends {model_name: string}>(env: Env, items: T[]): Promise<(T & {categories: PublicCategory[]})[]> {
  if (!items.length) return [];
  await ensureModelCategoriesSchema(env);
  const names = [...new Set(items.map(m => m.model_name))];
  const byName = new Map<string, PublicCategory[]>();
  for (let i = 0; i < names.length; i += 80) {
    const chunk = names.slice(i,i+80);
    const rows = await env.DB.prepare("SELECT b.model_name,c.id,c.name,c.description,c.sort_order,c.color FROM model_category_bindings b JOIN model_categories c ON c.id=b.category_id WHERE c.enabled=1 AND b.model_name IN (" + chunk.map(() => "?").join(",") + ") ORDER BY c.sort_order,c.name,c.id").bind(...chunk).all<PublicCategory & {model_name:string}>();
    for (const {model_name,...category} of rows.results ?? []) {
      const list = byName.get(model_name) ?? []; list.push(category); byName.set(model_name,list);
    }
  }
  return items.map(item => ({...item,categories: byName.get(item.model_name) ?? []}));
}
