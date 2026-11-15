import { deleteUnreferencedTargets } from "../db/model_references";
import { Hono } from "hono";
import { videoModelError, videoPoolError } from "../gateway/video_config";
import { resolveModelType, type ModelTypeInput } from "../gateway/model_type";
import { embeddingPoolError, readEmbeddingProfile } from "../gateway/embeddings";
import type { Env, ModelGroupEdgeRow, ModelGroupRow } from "../types";
import {
  createModelGroup,
  getModelGroup,
  isModelKeyTaken,
  listAllModelGroupMembers,
  listModelGroupMembers,
  listModelProviderTypes,
  listModelGroups,
  listPriceWindows,
  replaceModelGroupMembers,
  replacePriceWindows,
  updateModelGroup,
  PEAK_PRICING_DAY_TYPES,
  PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES,
  PEAK_PRICING_GROUPS,
  PEAK_PRICING_WEEKEND_DAYS,
} from "../db/repo";
import { resolveGroupReasoningSupport } from "../gateway/reasoning";
import {
  CreateModelGroupSchema,
  ModelGroupMembersSchema,
  PriceWindowsSchema,
  UpdateModelGroupSchema,
  priceWindowMinutes,
  zValidator,
} from "./schemas";

type GroupAdminRow = ModelTypeInput & {
  input_price_per_m?: number; output_price_per_m?: number; cache_read_price_per_m?: number; cache_write_price_per_m?: number;
  price_per_call?: number; search_price_per_call?: number; cache_enabled?: boolean | number;
};
type GroupAdminMember = GroupAdminRow & { id: string; provider_type: string };

function groupEmbeddingError(group: GroupAdminRow, members: readonly GroupAdminMember[] = []): string | null {
  const type = resolveModelType(group);
  if (members.some(member => resolveModelType(member) !== type)) return "mixed_model_types";
  if (type === "video") {
    const error = videoModelError(group);
    return error || (members.length ? videoPoolError(group, [...members]) : null);
  }
  if (type !== "embedding") return null;
  if ((group.billing_unit ?? "token") !== "token") return "embedding_token_billing_required";
  if ([group.output_price_per_m, group.cache_read_price_per_m, group.cache_write_price_per_m,
    group.price_per_call, group.search_price_per_call].some(price => (price ?? 0) !== 0)) return "embedding_input_only_pricing_required";
  if (group.cache_enabled) return "embedding_response_cache_not_supported";
  if (members.length > 1 && [group, ...members].some(row => readEmbeddingProfile(row)?.dimensions === undefined)) return "embedding_compatibility_required";
  return embeddingPoolError(group, members);
}

export const modelGroupsApp = new Hono<{ Bindings: Env }>();

async function listGroupsWithMembers(env: Env) {
  const [groups, edges] = await Promise.all([listModelGroups(env), listAllModelGroupMembers(env)]);
  const byGroup = new Map<string, typeof edges>();
  for (const e of edges) {
    const list = byGroup.get(e.group_id) ?? [];
    list.push(e);
    byGroup.set(e.group_id, list);
  }
  return (groups as ModelGroupRow[]).map((group) => ({
    ...group,
    reasoning: resolveGroupReasoningSupport(group.config_json),
    members: (byGroup.get(group.id) ?? []).map((m) => ({
      model_id: m.model_id,
      model_name: m.model_name,
      display_name: m.display_name,
      provider_type: m.provider_type,
      provider_name: m.provider_name,
      position: m.position,
      enabled: m.enabled,
    })),
  }));
}

modelGroupsApp.get("/", async (c) => {
  const items = await listGroupsWithMembers(c.env);
  return c.json({ items });
});

modelGroupsApp.get("/:id", async (c) => {
  const group = await getModelGroup(c.env, c.req.param("id"));
  if (!group) return c.json({ error: "not_found" }, 404);
  const members = await listModelGroupMembers(c.env, group.id);
  return c.json({
    item: {
      ...group,
      reasoning: resolveGroupReasoningSupport(group.config_json),
      members: members.map((m) => ({
        model_id: m.id,
        model_name: m.model_name,
        display_name: m.display_name,
        provider_type: m.provider_type,
        provider_name: m.provider_name,
        position: m.position,
        enabled: 1,
      })),
    },
  });
});

modelGroupsApp.post("/", zValidator("json", CreateModelGroupSchema), async (c) => {
  const data = c.req.valid("json");
  const embeddingError = groupEmbeddingError(data);
  if (embeddingError) return c.json({ error: embeddingError }, 400);
  const name = data.name.trim();
  const taken = await isModelKeyTaken(c.env, name);
  if (taken === "model") return c.json({ error: "name_conflicts_with_model", name }, 400);
  if (taken === "group") return c.json({ error: "name_conflicts_with_group", name }, 400);
  const row = await createModelGroup(c.env, {
    name,
    display_name: data.display_name ? data.display_name.trim() : undefined,
    description: data.description ? data.description.trim() : undefined,
    input_price_per_m: data.input_price_per_m,
    output_price_per_m: data.output_price_per_m,
    cache_read_price_per_m: data.cache_read_price_per_m,
    cache_write_price_per_m: data.cache_write_price_per_m,
    pricing_mode: data.pricing_mode,
    peak_pricing_enabled: data.peak_pricing_enabled,
    billing_unit: data.billing_unit,
    price_per_call: data.price_per_call,
    search_price_per_call: data.search_price_per_call,
    cache_enabled: data.cache_enabled,
    cache_ttl: data.cache_ttl,
    enabled: data.enabled,
    model_public: data.model_public,
    config_json: data.config_json ? data.config_json.trim() : undefined,
  });
  return c.json({ item: row }, 201);
});

modelGroupsApp.put("/:id", zValidator("json", UpdateModelGroupSchema), async (c) => {
  const id = c.req.param("id");
  const data = c.req.valid("json");
  const current = await getModelGroup(c.env, id);
  if (!current) return c.json({ error: "not_found" }, 404);
  const effective = { ...current, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) };
  const configured = await c.env.DB.prepare(
    "SELECT m.*, gm.model_id AS id, p.type AS provider_type FROM model_group_members gm LEFT JOIN models m ON m.id = gm.model_id LEFT JOIN providers p ON p.id = m.provider_id WHERE gm.group_id = ?"
  ).bind(id).all<GroupAdminMember>();
  const embeddingError = groupEmbeddingError(effective, configured.results ?? []);
  if (embeddingError) return c.json({ error: embeddingError }, 400);
  if (data.name !== undefined) {
    const name = data.name.trim();
    const taken = await isModelKeyTaken(c.env, name, { groupId: id });
    if (taken === "model") return c.json({ error: "name_conflicts_with_model", name }, 400);
    if (taken === "group") return c.json({ error: "name_conflicts_with_group", name }, 400);
  }
  const row = await updateModelGroup(c.env, id, {
    name: data.name !== undefined ? data.name.trim() : undefined,
    display_name: data.display_name !== undefined ? (data.display_name ? data.display_name.trim() : null) : undefined,
    description: data.description !== undefined ? (data.description ? data.description.trim() : null) : undefined,
    input_price_per_m: data.input_price_per_m,
    output_price_per_m: data.output_price_per_m,
    cache_read_price_per_m: data.cache_read_price_per_m,
    cache_write_price_per_m: data.cache_write_price_per_m,
    pricing_mode: data.pricing_mode,
    peak_pricing_enabled: data.peak_pricing_enabled,
    billing_unit: data.billing_unit,
    price_per_call: data.price_per_call,
    search_price_per_call: data.search_price_per_call,
    cache_enabled: data.cache_enabled,
    cache_ttl: data.cache_ttl,
    enabled: data.enabled,
    model_public: data.model_public,
    config_json: data.config_json !== undefined ? (data.config_json ? data.config_json.trim() : null) : undefined,
  });
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ item: row });
});

modelGroupsApp.delete("/:id", async (c) => {
  const result = await deleteUnreferencedTargets(c.env, "group", [c.req.param("id")]);
  if (result.references.length) return c.json({ error: "model_group_in_use", references: result.references, actions: ["migrate_references", "disable", "cancel"] }, 409);
  if (!result.deleted) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

modelGroupsApp.get("/:id/members", async (c) => {
  const group = await getModelGroup(c.env, c.req.param("id"));
  if (!group) return c.json({ error: "not_found" }, 404);
  const all = await listAllModelGroupMembers(c.env);
  return c.json({
    items: all
      .filter((m) => m.group_id === group.id)
      .map((m) => ({
        model_id: m.model_id,
        model_name: m.model_name,
        display_name: m.display_name,
        provider_type: m.provider_type,
        provider_name: m.provider_name,
        position: m.position,
        enabled: m.enabled,
      })),
  });
});

modelGroupsApp.put("/:id/members", zValidator("json", ModelGroupMembersSchema), async (c) => {
  const data = c.req.valid("json");
  const group = await getModelGroup(c.env, c.req.param("id"));
  if (!group) return c.json({ error: "not_found" }, 404);

  const ids = Array.from(new Set(data.members.map((m) => m.model_id.trim()).filter(Boolean)));
  if (!ids.length) {
    return c.json({ error: "empty_members", message: "组至少需要一个成员，否则任何调用都必然失败" }, 400);
  }
  const types = await listModelProviderTypes(c.env, ids);
  const unknown = ids.filter((id) => !types.has(id));
  if (unknown.length) return c.json({ error: "unknown_model_ids", model_ids: unknown }, 400);

  const configured = await c.env.DB.prepare(
    `SELECT m.*, p.type AS provider_type FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id IN (${ids.map(() => "?").join(", ")})`
  ).bind(...ids).all<GroupAdminMember>();
  const embeddingError = groupEmbeddingError(group, configured.results ?? []);
  if (embeddingError) return c.json({ error: embeddingError }, 400);

  await replaceModelGroupMembers(
    c.env,
    group.id,
    data.members.map((m, index) => ({
      model_id: m.model_id.trim(),
      position: typeof m.position === "number" ? m.position : index,
      enabled: m.enabled,
    }))
  );
  const stored = await listModelGroupMembers(c.env, group.id);
  return c.json({
    items: stored.map((m) => ({
      model_id: m.id,
      model_name: m.model_name,
      display_name: m.display_name,
      provider_type: m.provider_type,
      position: m.position,
      enabled: 1,
    })),
  });
});


modelGroupsApp.get("/:id/price-windows", async (c) => {
  const id = c.req.param("id");
  const group = await getModelGroup(c.env, id);
  if (!group) return c.json({ error: "not_found" }, 404);
  const items = await listPriceWindows(c.env, id);
  return c.json({
    peak_pricing_enabled: group.peak_pricing_enabled === 1,
    day_types: PEAK_PRICING_DAY_TYPES,
    groups: PEAK_PRICING_GROUPS,
    weekend_days: PEAK_PRICING_WEEKEND_DAYS,
    tz_offset_minutes: PEAK_PRICING_DEFAULT_TZ_OFFSET_MINUTES,
    items,
  });
});

modelGroupsApp.put("/:id/price-windows", zValidator("json", PriceWindowsSchema), async (c) => {
  const id = c.req.param("id");
  const group = await getModelGroup(c.env, id);
  if (!group) return c.json({ error: "not_found" }, 404);
  const data = c.req.valid("json");
  await replacePriceWindows(
    c.env,
    id,
    data.windows.map((w) => ({
      day_type: w.day_type,
      ...priceWindowMinutes(w),
      multiplier: w.multiplier,
      enabled: w.enabled !== false,
    }))
  );
  return c.json({ items: await listPriceWindows(c.env, id) });
});
