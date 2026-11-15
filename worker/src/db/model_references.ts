import type { Env } from "../types";
import { ensureSchema } from "./schema";
import { getModel, updateModel } from "./repo";

export type ModelReference = {
  target_id: string;
  kind: string;
  source_id: string;
  source_name: string | null;
  model_key: string | null;
};
type TargetType = "model" | "group";

function referenceQuery(type: TargetType): string {
  const mapping = "SELECT t.id AS target_id, 'service_mapping' AS kind, s.id AS source_id, g.name AS source_name, s.model_key " +
    "FROM targets t JOIN service_group_models s ON s.target_type = '" + type + "' AND s.target_id = t.id " +
    "LEFT JOIN service_groups g ON g.id = s.service_group_id";
  const policyJson = "CASE WHEN json_valid(p.policy_json) THEN p.policy_json ELSE '{}' END";
  const policies = " UNION ALL SELECT t.id, 'token_model_scope', p.device_id || '/' || p.token_id, NULL, NULL FROM targets t JOIN token_routing_policies p ON EXISTS (SELECT 1 FROM json_each(" + policyJson + ", '$.model_scope') j WHERE j.type = 'text' AND j.value = '" + type + ":' || t.id)" +
    " UNION ALL SELECT t.id, 'token_model_override', p.device_id || '/' || p.token_id, NULL, NULL FROM targets t JOIN token_routing_policies p ON EXISTS (SELECT 1 FROM json_each(" + policyJson + ", '$.model_overrides') j WHERE j.key = '" + type + ":' || t.id)" +
    " UNION ALL SELECT t.id, 'invalid_token_policy', p.device_id || '/' || p.token_id, NULL, NULL FROM targets t JOIN token_routing_policies p ON p.policy_json IS NOT NULL AND NOT json_valid(p.policy_json)";
  if (type === "group") return mapping + policies +
    " UNION ALL SELECT t.id, 'device_group', d.device_id, NULL, NULL FROM targets t JOIN device_model_groups d ON d.group_id = t.id" +
    " UNION ALL SELECT t.id, 'template_group', d.template_id, NULL, NULL FROM targets t JOIN device_template_groups d ON d.group_id = t.id";
  return mapping + policies +
    " UNION ALL SELECT t.id, 'service_member', s.id, g.name, s.model_key FROM targets t " +
    "JOIN service_group_models s ON EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(s.member_ids_json) THEN s.member_ids_json ELSE '[]' END) j WHERE j.type = 'text' AND j.value = t.id) " +
    "LEFT JOIN service_groups g ON g.id = s.service_group_id" +
    " UNION ALL SELECT t.id, 'invalid_service_members', s.id, g.name, s.model_key FROM targets t " +
    "JOIN service_group_models s ON s.member_ids_json IS NOT NULL AND NOT json_valid(s.member_ids_json) " +
    "LEFT JOIN service_groups g ON g.id = s.service_group_id" +
    " UNION ALL SELECT t.id, 'group_member', m.group_id, g.name, NULL FROM targets t JOIN model_group_members m ON m.model_id = t.id LEFT JOIN model_groups g ON g.id = m.group_id" +
    " UNION ALL SELECT t.id, 'fallback', m.id, m.model_name, NULL FROM targets t JOIN models m ON m.fallback_model_id = t.id" +
    " UNION ALL SELECT t.id, 'device_model', d.device_id, NULL, NULL FROM targets t JOIN device_models d ON d.model_id = t.id" +
    " UNION ALL SELECT t.id, 'template_model', d.template_id, NULL, NULL FROM targets t JOIN device_template_models d ON d.model_id = t.id";
}
const TARGETS = "WITH targets(id) AS (SELECT value FROM json_each(?)) ";

export async function deleteUnreferencedTargets(env: Env, type: TargetType, ids: string[]) {
  await ensureSchema(env);
  const targets = JSON.stringify([...new Set(ids)]);
  const table = type === "model" ? "models" : "model_groups";
  const terms = referenceQuery(type).split(" UNION ALL ");
  const queries: string[] = [];
  for (let i = 0; i < terms.length; i += 5) queries.push(terms.slice(i, i + 5).join(" UNION ALL "));
  const guard = queries.map(query => "NOT EXISTS (" + query + ")").join(" AND ");
  const statements = [
    ...queries.map(query => env.DB.prepare("SELECT * FROM (" + TARGETS +
      ", reference_rows(target_id, kind, source_id, source_name, model_key) AS (" + query +
      ") SELECT * FROM reference_rows)").bind(targets)),
    env.DB.prepare(TARGETS + "DELETE FROM " + table + " WHERE id IN (SELECT id FROM targets) AND " + guard).bind(targets),
    env.DB.prepare(TARGETS + "DELETE FROM price_windows WHERE model_id IN (SELECT id FROM targets) AND NOT EXISTS (SELECT 1 FROM " + table + " WHERE id = price_windows.model_id) AND " + guard).bind(targets),
  ];
  if (type === "group") statements.push(env.DB.prepare(TARGETS +
    "DELETE FROM model_group_members WHERE group_id IN (SELECT id FROM targets) AND NOT EXISTS (SELECT 1 FROM model_groups WHERE id = model_group_members.group_id) AND " + guard).bind(targets));
  const results = await env.DB.batch<ModelReference>(statements);
  return { references: results.slice(0, queries.length).flatMap(result => result.results ?? []), deleted: Number(results[queries.length].meta.changes ?? 0) };
}

const BROKEN_DIRECT_MAPPING = "SELECT s.target_id, 'service_mapping' AS kind, s.id AS source_id, g.name AS source_name, s.model_key " +
  "FROM service_group_models s LEFT JOIN service_groups g ON g.id = s.service_group_id " +
  "WHERE s.target_type = 'model' AND s.target_id = ? AND NOT (s.model_key IS ? OR s.model_key IS ?)";

export class ModelRenameReferenceError extends Error {
  constructor(readonly references: ModelReference[]) {
    super("model_rename_breaks_service_mapping");
  }
}

export async function updateModelPreservingReferences(env: Env, id: string, data: Parameters<typeof updateModel>[2]) {
  let missing = false;
  const DB = new Proxy(env.DB, {
    get(target, key) {
      if (key !== "prepare") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        if (!/^UPDATE models SET /i.test(sql)) return target.prepare(sql);
        const match = /^UPDATE models SET (.+) WHERE id = \?$/i.exec(sql);
        if (!match) throw new Error("Unsupported model update statement");
        const columns = match[1].split(", ");
        const nameIndex = columns.indexOf("model_name = ?");
        const aliasIndex = columns.indexOf("alias = ?");
        if (nameIndex < 0 || aliasIndex < 0 || columns.some(column => !/^\w+ = \?$/.test(column))) {
          throw new Error("Unsupported model update bindings");
        }
        return { bind: (...values: unknown[]) => {
          const name = values[nameIndex];
          const alias = values[aliasIndex];
          const statement = target.prepare(sql + " AND ((model_name IS ? AND alias IS ?) OR NOT EXISTS (" + BROKEN_DIRECT_MAPPING + "))")
            .bind(...values, name, alias, id, name, alias);
          return { run: async () => {
            const result = await statement.run();
            if (!result.meta.changes) {
              if (!await getModel(env, id)) missing = true;
              else {
                const refs = await env.DB.prepare(BROKEN_DIRECT_MAPPING).bind(id, name, alias).all<ModelReference>();
                throw new ModelRenameReferenceError(refs.results ?? []);
              }
            }
            return result;
          } };
        } };
      };
    },
  });
  const updated = await updateModel({ ...env, DB }, id, data);
  return missing ? null : updated;
}
