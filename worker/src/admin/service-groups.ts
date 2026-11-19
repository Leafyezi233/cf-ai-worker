import { videoPoolError } from "../gateway/video_config";
import { resolveModelType } from "../gateway/model_type";
import { embeddingPoolError } from "../gateway/embeddings";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { ensureSchema } from "../db/schema";
import { recordAuditLog } from "../db/repo";
import { serviceModelNamesApp } from "./service-model-names";
import { publicModelIdentityStatement, reserveDeletedMappingStatement } from "../db/public_model_identity";
import { extractClientIp } from "../middleware/adminAuth";

export const serviceGroupsApp = new Hono<{ Bindings: Env }>();
serviceGroupsApp.route("/", serviceModelNamesApp);
const Id = z.string().trim().min(1).max(200);
const Flag = z.union([z.literal(0), z.literal(1)]);
const Price = z.number().finite().nonnegative();
const Fields = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).nullable(),
  public_selectable: Flag, selectable: Flag, enabled: Flag, multiplier: Price,
}).strict();
const Create = Fields.extend({
  description: Fields.shape.description.optional().default(null),
  public_selectable: Flag.optional().default(0), selectable: Flag.optional().default(1),
  enabled: Flag.optional().default(1), multiplier: Price.optional().default(1),
});
const Update = Fields.partial().refine((v) => Object.keys(v).length > 0, "No changes supplied");
const Pricing = z.object({
  input_price_per_m: Price, output_price_per_m: Price,
  cache_read_price_per_m: Price, cache_write_price_per_m: Price,
  price_per_call: Price, search_price_per_call: Price,
}).strict();
const Mapping = z.object({
  id: Id.optional(), model_key: Id, target_type: z.enum(["model", "group"]), target_id: Id,
  pricing_json: Pricing.nullable().optional(),
  member_ids_json: z.array(Id).min(1).max(100).nullable().optional(),
}).strict();
const Models = z.object({ models: z.array(Mapping).max(100) }).strict();
const Accounts = z.object({ device_ids: z.array(Id).max(100) }).strict();
type GroupRow = {
  id: string; name: string; description: string | null; public_selectable: number;
  selectable: number; enabled: number; multiplier: number; revision: number;
};
type MappingRow = {
  id: string; service_group_id: string; model_key: string; target_type: "model" | "group";
  target_id: string; pricing_json: string | null; member_ids_json: string | null;
};
type MemberRow = { id: string; billing_unit: string; provider_type: string; config_json?: string | null };
const GROUP_COLUMNS = "id, name, description, public_selectable, selectable, enabled, multiplier, revision";
const MAPPING_COLUMNS = "id, service_group_id, model_key, target_type, target_id, pricing_json, member_ids_json";

async function parseBody<T extends z.ZodTypeAny>(c: Context<{ Bindings: Env }>, schema: T) {
  let body: unknown;
  try { body = await c.req.json(); } catch { return { error: "invalid_json" } as const; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { error: "validation_error", message: parsed.error.issues[0]?.message } as const;
  return { data: parsed.data as z.infer<T> } as const;
}
async function getGroup(env: Env, id: string) {
  return env.DB.prepare("SELECT " + GROUP_COLUMNS + " FROM service_groups WHERE id = ?").bind(id).first<GroupRow>();
}
async function audit(c: Context<{ Bindings: Env }>, id: string, action: string, details?: Record<string, unknown>) {
  await recordAuditLog(c.env, {
    ip: extractClientIp(c, c.env), action: "service_group." + action,
    target_type: "service_group", target_id: id, summary: "Service group " + action, details,
  });
}
serviceGroupsApp.use("*", async (c, next) => { await ensureSchema(c.env); await next(); });

serviceGroupsApp.get("/", async (c) => {
  const [groups, mappings, grants] = await Promise.all([
    c.env.DB.prepare("SELECT " + GROUP_COLUMNS + " FROM service_groups ORDER BY name, id").all<GroupRow>(),
    c.env.DB.prepare("SELECT " + MAPPING_COLUMNS + " FROM service_group_models ORDER BY model_key, id").all<MappingRow>(),
    c.env.DB.prepare("SELECT device_id, service_group_id FROM device_service_groups ORDER BY device_id")
      .all<{ device_id: string; service_group_id: string }>(),
  ]);
  const modelsByGroup = new Map<string, MappingRow[]>();
  const accountsByGroup = new Map<string, string[]>();
  for (const mapping of mappings.results ?? []) {
    const rows = modelsByGroup.get(mapping.service_group_id) ?? [];
    rows.push(mapping); modelsByGroup.set(mapping.service_group_id, rows);
  }
  for (const grant of grants.results ?? []) {
    const rows = accountsByGroup.get(grant.service_group_id) ?? [];
    rows.push(grant.device_id); accountsByGroup.set(grant.service_group_id, rows);
  }
  return c.json({ items: (groups.results ?? []).map((group) => ({
    ...group, models: modelsByGroup.get(group.id) ?? [], device_ids: accountsByGroup.get(group.id) ?? [],
  })) });
});
serviceGroupsApp.post("/", async (c) => {
  const body = await parseBody(c, Create);
  if ("error" in body) return c.json(body, 400);
  const data = body.data;
  const duplicate = await c.env.DB.prepare("SELECT id FROM service_groups WHERE name = ?").bind(data.name).first();
  if (duplicate) return c.json({ error: "name_conflict" }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO service_groups (id, name, description, public_selectable, selectable, enabled, multiplier, revision) VALUES (?, ?, ?, ?, ?, ?, ?, 1)")
    .bind(id, data.name, data.description, data.public_selectable, data.selectable, data.enabled, data.multiplier).run();
  await audit(c, id, "create");
  return c.json({ item: await getGroup(c.env, id) }, 201);
});
serviceGroupsApp.put("/:id", async (c) => {
  const body = await parseBody(c, Update);
  if ("error" in body) return c.json(body, 400);
  const id = c.req.param("id");
  if (!await getGroup(c.env, id)) return c.json({ error: "not_found" }, 404);
  const data = body.data;
  if (data.name !== undefined) {
    const duplicate = await c.env.DB.prepare("SELECT id FROM service_groups WHERE name = ? AND id != ?").bind(data.name, id).first();
    if (duplicate) return c.json({ error: "name_conflict" }, 400);
  }
  const fields = Object.keys(Fields.shape) as Array<keyof z.infer<typeof Fields>>;
  const changed = fields.filter((key) => data[key] !== undefined);
  await c.env.DB.prepare("UPDATE service_groups SET " + changed.map((key) => key + " = ?").join(", ") + ", revision = revision + 1 WHERE id = ?")
    .bind(...changed.map((key) => data[key]!), id).run();
  await audit(c, id, "update", { fields: changed });
  return c.json({ item: await getGroup(c.env, id) });
});

const UNBOUND = "NOT EXISTS (SELECT 1 FROM devices WHERE default_service_group_id = ? OR service_group_id = ?) AND NOT EXISTS (SELECT 1 FROM device_sub_tokens WHERE service_group_id = ?) AND NOT EXISTS (SELECT 1 FROM token_routing_policy_groups WHERE service_group_id = ?)";
serviceGroupsApp.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!await getGroup(c.env, id)) return c.json({ error: "not_found" }, 404);
  const bound = await c.env.DB.prepare("SELECT id FROM service_groups WHERE id = ? AND NOT (" + UNBOUND + ")")
    .bind(id, id, id, id, id).first();
  if (bound) return c.json({ error: "service_group_in_use" }, 400);
  const results = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM service_group_models WHERE service_group_id = ? AND " + UNBOUND).bind(id, id, id, id, id),
    c.env.DB.prepare("DELETE FROM device_service_groups WHERE service_group_id = ? AND " + UNBOUND).bind(id, id, id, id, id),
    c.env.DB.prepare("DELETE FROM service_groups WHERE id = ? AND " + UNBOUND).bind(id, id, id, id, id),
  ]);
  if (!results[2].meta.changes) return c.json({ error: "service_group_in_use" }, 400);
  await audit(c, id, "delete");
  return c.json({ ok: true });
});

serviceGroupsApp.put("/:id/models", async (c) => {
  const body = await parseBody(c, Models);
  if ("error" in body) return c.json(body, 400);
  const id = c.req.param("id");
  const group = await getGroup(c.env, id);
  if (!group) return c.json({ error: "not_found" }, 404);
  const previous = (await c.env.DB.prepare("SELECT " + MAPPING_COLUMNS + " FROM service_group_models WHERE service_group_id = ?").bind(id).all<MappingRow>()).results ?? [];
  const mappings = body.data.models.map((m) => ({ ...m, id: m.id ?? previous.find(p => p.model_key === m.model_key)?.id ?? crypto.randomUUID() }));
  if (mappings.some(m => previous.some(p => p.id === m.id && p.model_key !== m.model_key))) return c.json({ error: "use_public_model_rename", message: "请使用公开名改名操作以保留兼容名与分类" }, 409);
  const guardId = crypto.randomUUID();
  const guards: D1PreparedStatement[] = [];
  if (new Set(mappings.map((m) => m.model_key)).size !== mappings.length) return c.json({ error: "duplicate_model_keys" }, 400);
  if (new Set(mappings.map((m) => m.id)).size !== mappings.length) return c.json({ error: "duplicate_mapping_ids" }, 400);
  for (const mapping of mappings) {
    const collision = await c.env.DB.prepare("SELECT id FROM service_group_models WHERE id = ? AND service_group_id != ?").bind(mapping.id, id).first();
    if (collision) return c.json({ error: "mapping_id_conflict", model_key: mapping.model_key }, 400);
    const reserved = await c.env.DB.prepare("SELECT mapping_id FROM service_model_aliases WHERE service_group_id = ? AND name = ?").bind(id, mapping.model_key).first<{ mapping_id: string }>();
    if (reserved && reserved.mapping_id !== mapping.id) return c.json({ error: "reserved_model_name", model_key: mapping.model_key }, 409);
    let targetUnit: string;
    let targetType: ReturnType<typeof resolveModelType>;
    let targetRow: { billing_unit: string; config_json?: string | null };
    let baseline: MemberRow[];
    if (mapping.target_type === "model") {
      const target = await c.env.DB.prepare(
        "SELECT m.*, COALESCE(m.billing_unit, 'token') AS billing_unit, p.type AS provider_type FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ? AND (m.model_name = ? OR m.alias = ?) AND m.enabled = 1 AND p.enabled = 1"
      ).bind(mapping.target_id, mapping.model_key, mapping.model_key).first<MemberRow>();
      if (!target) return c.json({ error: "invalid_model_target", model_key: mapping.model_key }, 400);
      targetRow = target; targetUnit = target.billing_unit; targetType = resolveModelType(target); baseline = [target];
    } else {
      const target = await c.env.DB.prepare("SELECT *, COALESCE(billing_unit, 'token') AS billing_unit FROM model_groups WHERE id = ? AND enabled = 1")
        .bind(mapping.target_id).first<{ billing_unit: string; config_json: string | null }>();
      if (!target) return c.json({ error: "invalid_group_target", model_key: mapping.model_key }, 400);
      targetRow = target; targetUnit = target.billing_unit; targetType = resolveModelType(target);
      const members = await c.env.DB.prepare(
        "SELECT m.*, COALESCE(m.billing_unit, 'token') AS billing_unit, p.type AS provider_type FROM model_group_members gm JOIN models m ON m.id = gm.model_id JOIN providers p ON p.id = m.provider_id WHERE gm.group_id = ? AND gm.enabled = 1 AND m.enabled = 1 AND p.enabled = 1 ORDER BY gm.position, m.id"
      ).bind(mapping.target_id).all<MemberRow>();
      baseline = members.results ?? [];
      if (!baseline.length) return c.json({ error: "empty_target_group", model_key: mapping.model_key }, 400);
    }
    if(mapping.target_type === "model") guards.push(c.env.DB.prepare("INSERT INTO public_model_write_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM models WHERE id=? AND (model_name=? OR alias=?)) THEN 1 ELSE 0 END").bind(guardId+mapping.id+":name",mapping.target_id,mapping.model_key,mapping.model_key));
    else guards.push(c.env.DB.prepare("INSERT INTO public_model_write_guards(id,valid) SELECT ?,CASE WHEN (SELECT COUNT(*) FROM model_group_members gm JOIN models m ON m.id=gm.model_id JOIN providers p ON p.id=m.provider_id WHERE gm.group_id=? AND gm.enabled=1 AND m.enabled=1 AND p.enabled=1)=? AND NOT EXISTS(SELECT 1 FROM model_group_members gm JOIN models m ON m.id=gm.model_id JOIN providers p ON p.id=m.provider_id WHERE gm.group_id=? AND gm.enabled=1 AND m.enabled=1 AND p.enabled=1 AND gm.model_id NOT IN ("+baseline.map(()=>"?").join(",")+")) THEN 1 ELSE 0 END").bind(guardId+mapping.id+":members",mapping.target_id,baseline.length,mapping.target_id,...baseline.map(m=>m.id)));
    const ids = mapping.member_ids_json;
    let selected = baseline;
    if (ids) {
      if (new Set(ids).size !== ids.length) return c.json({ error: "duplicate_member_ids", model_key: mapping.model_key }, 400);
      const members = await c.env.DB.prepare(
        "SELECT m.*, COALESCE(m.billing_unit, 'token') AS billing_unit, p.type AS provider_type FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id IN (" + ids.map(() => "?").join(",") + ") AND m.enabled = 1 AND p.enabled = 1"
      ).bind(...ids).all<MemberRow>();
      selected = members.results ?? [];
      if (selected.length !== ids.length) return c.json({ error: "invalid_member_ids", model_key: mapping.model_key }, 400);
    }
    if ([...baseline, ...selected].some((m) => m.billing_unit !== targetUnit)) return c.json({ error: "incompatible_billing_unit", model_key: mapping.model_key }, 400);
    if ([...baseline, ...selected].some(m => resolveModelType(m) !== targetType)) return c.json({ error: "incompatible_model_type", model_key: mapping.model_key }, 400);
    if (targetType === "video") {
      const error = videoPoolError(targetRow, [...baseline, ...selected]);
      if (error) return c.json({ error, model_key: mapping.model_key }, 400);
      if (mapping.pricing_json && ["input_price_per_m", "output_price_per_m", "cache_read_price_per_m", "cache_write_price_per_m", "search_price_per_call"].some(key => mapping.pricing_json![key as keyof typeof mapping.pricing_json] !== 0)) return c.json({ error: "video_call_only_pricing", model_key: mapping.model_key }, 400);
    }
    if (targetType === "embedding") {
      const error = embeddingPoolError(targetRow, selected);
      if (error) return c.json({ error, model_key: mapping.model_key }, 400);
      if (mapping.pricing_json && ["output_price_per_m", "cache_read_price_per_m", "cache_write_price_per_m", "price_per_call", "search_price_per_call"].some(key => mapping.pricing_json![key as keyof typeof mapping.pricing_json] !== 0)) return c.json({ error: "embedding_input_only_pricing", model_key: mapping.model_key }, 400);
    }
    guards.push(c.env.DB.prepare("INSERT INTO public_model_write_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM "+(mapping.target_type === "model" ? "models" : "model_groups")+" WHERE id=? AND enabled=1 AND config_json IS ? AND COALESCE(billing_unit,'token')=?) THEN 1 ELSE 0 END").bind(guardId+mapping.id,mapping.target_id,targetRow.config_json??null,targetUnit));
    for (const [n, member] of [...baseline,...selected].entries()) guards.push(c.env.DB.prepare("INSERT INTO public_model_write_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=? AND m.enabled=1 AND p.enabled=1 AND m.config_json IS ? AND COALESCE(m.billing_unit,'token')=? AND p.type=?) THEN 1 ELSE 0 END").bind(guardId+mapping.id+":"+n,member.id,member.config_json??null,member.billing_unit,member.provider_type));
  }
  try { await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO public_model_write_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM service_groups WHERE id=? AND revision=?) THEN 1 ELSE 0 END").bind(guardId,id,group.revision),
    ...guards,
    ...previous.filter(p => !mappings.some(m => m.id === p.id)).flatMap(p => [reserveDeletedMappingStatement(c.env,id,p.id,p.model_key),c.env.DB.prepare("UPDATE service_model_aliases SET enabled=0 WHERE service_group_id=? AND mapping_id=?").bind(id,p.id)]),
    ...mappings.map(m => publicModelIdentityStatement(c.env,m.model_key)),
    c.env.DB.prepare("DELETE FROM service_group_models WHERE service_group_id = ?").bind(id),
    ...mappings.map((m) => c.env.DB.prepare("INSERT INTO service_group_models (id, service_group_id, model_key, target_type, target_id, pricing_json, member_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(m.id, id, m.model_key, m.target_type, m.target_id,
        m.pricing_json == null ? null : JSON.stringify(m.pricing_json), m.member_ids_json == null ? null : JSON.stringify(m.member_ids_json))),
    c.env.DB.prepare("UPDATE service_groups SET revision = revision + 1 WHERE id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM public_model_write_guards WHERE id LIKE ?").bind(guardId+"%"),
  ]); } catch { return c.json({ error: "configuration_changed", message: "配置发生并发变化，未保存任何映射；请刷新重试" },409); }
  await audit(c, id, "replace_models", { count: mappings.length });
  const items = await c.env.DB.prepare("SELECT " + MAPPING_COLUMNS + " FROM service_group_models WHERE service_group_id = ? ORDER BY model_key, id").bind(id).all<MappingRow>();
  return c.json({ items: items.results ?? [], item: await getGroup(c.env, id) });
});

serviceGroupsApp.put("/:id/accounts", async (c) => {
  const body = await parseBody(c, Accounts);
  if ("error" in body) return c.json(body, 400);
  const id = c.req.param("id");
  if (!await getGroup(c.env, id)) return c.json({ error: "not_found" }, 404);
  const ids = body.data.device_ids;
  if (new Set(ids).size !== ids.length) return c.json({ error: "duplicate_device_ids" }, 400);
  if (ids.length) {
    const devices = await c.env.DB.prepare("SELECT id FROM devices WHERE id IN (" + ids.map(() => "?").join(",") + ")").bind(...ids).all<{ id: string }>();
    if ((devices.results ?? []).length !== ids.length) return c.json({ error: "unknown_device_ids" }, 400);
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM device_service_groups WHERE service_group_id = ?").bind(id),
    ...ids.map((deviceId) => c.env.DB.prepare("INSERT INTO device_service_groups (device_id, service_group_id) VALUES (?, ?)").bind(deviceId, id)),
    c.env.DB.prepare("UPDATE service_groups SET revision = revision + 1 WHERE id = ?").bind(id),
  ]);
  await audit(c, id, "replace_accounts", { count: ids.length });
  return c.json({ device_ids: ids, item: await getGroup(c.env, id) });
});
