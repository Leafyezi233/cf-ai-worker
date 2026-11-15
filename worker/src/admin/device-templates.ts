import { Hono } from "hono";
import type { Env, DeviceRow, ModelScope } from "../types";
import {
  MAX_TEMPLATE_APPLY_STATEMENTS,
  applyDeviceTemplate,
  createDeviceTemplate,
  deleteDeviceTemplate,
  getDeviceTemplate,
  getDeviceTemplateByName,
  listDeviceTemplates,
  listDevices,
  listModelGroups,
  listModels,
  recordAuditLog,
  templateApplyStatementCount,
  updateDeviceTemplate,
} from "../db/repo";
import {
  ApplyDeviceTemplateSchema,
  CreateDeviceTemplateSchema,
  UpdateDeviceTemplateSchema,
  zValidator,
} from "./schemas";

export const deviceTemplatesApp = new Hono<{ Bindings: Env }>();

function toGrants<T extends "model_id" | "group_id">(
  ids: string[],
  rpms: Record<string, number>,
  idKey: T
): Array<{ [K in T]: string } & { rpm: number }> {
  const seen = new Set<string>();
  const out: Array<Record<string, string | number>> = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ [idKey]: id, rpm: rpms[id] ?? 0 });
  }
  return out as Array<{ [K in T]: string } & { rpm: number }>;
}

async function validateGrants(
  env: Env,
  scope: ModelScope,
  modelIds: string[],
  groupIds: string[]
): Promise<{ error: string; body: Record<string, unknown> } | null> {
  const [known, knownGroups] = await Promise.all([
    listModels(env, { includeSecrets: false }),
    listModelGroups(env),
  ]);
  const knownIds = new Set(known.map((m) => m.id));
  const unknownModels = modelIds.filter((id) => !knownIds.has(id));
  if (unknownModels.length) {
    return { error: "unknown_model_ids", body: { error: "unknown_model_ids", model_ids: unknownModels } };
  }
  const knownGroupIds = new Set(knownGroups.map((g) => g.id));
  const unknownGroups = groupIds.filter((id) => !knownGroupIds.has(id));
  if (unknownGroups.length) {
    return { error: "unknown_group_ids", body: { error: "unknown_group_ids", group_ids: unknownGroups } };
  }
  if (scope !== "all" && modelIds.length === 0 && groupIds.length === 0) {
    return {
      error: "empty_whitelist",
      body: {
        error: "empty_whitelist",
        message: "受限模式下至少需要选择一个模型或一个组，或把 model_scope 设为 all",
      },
    };
  }
  return null;
}

deviceTemplatesApp.get("/", async (c) => {
  const items = await listDeviceTemplates(c.env);
  return c.json({ items });
});

deviceTemplatesApp.get("/:id", async (c) => {
  const item = await getDeviceTemplate(c.env, c.req.param("id"));
  if (!item) return c.json({ error: "not_found" }, 404);
  return c.json({ item });
});

deviceTemplatesApp.post("/", zValidator("json", CreateDeviceTemplateSchema), async (c) => {
  const data = c.req.valid("json");
  const modelIds = Array.from(new Set(data.model_ids.map((id) => id.trim()).filter(Boolean)));
  const groupIds = Array.from(new Set(data.group_ids.map((id) => id.trim()).filter(Boolean)));

  const existing = await getDeviceTemplateByName(c.env, data.name.trim());
  if (existing) {
    return c.json({ error: "name_taken", message: "已存在同名模板" }, 400);
  }
  const invalid = await validateGrants(c.env, data.model_scope, modelIds, groupIds);
  if (invalid) return c.json(invalid.body, 400);

  const item = await createDeviceTemplate(c.env, {
    name: data.name,
    description: data.description ?? null,
    model_scope: data.model_scope,
    models: data.model_scope === "all" ? [] : toGrants(modelIds, data.model_rpms, "model_id"),
    groups: data.model_scope === "all" ? [] : toGrants(groupIds, data.group_rpms, "group_id"),
  });
  await recordAuditLog(c.env, {
    actor_type: "admin",
    action: "device_template.create",
    target_type: "device_template",
    target_id: item.id,
    summary: `创建设备模板 ${item.name}（${item.model_scope}，${item.models.length} 个模型 / ${item.groups.length} 个组）`,
  });
  return c.json({ item }, 201);
});

deviceTemplatesApp.put("/:id", zValidator("json", UpdateDeviceTemplateSchema), async (c) => {
  const id = c.req.param("id");
  const existing = await getDeviceTemplate(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  const data = c.req.valid("json");

  if (data.name !== undefined && data.name.trim() !== existing.name) {
    const clash = await getDeviceTemplateByName(c.env, data.name.trim());
    if (clash && clash.id !== id) {
      return c.json({ error: "name_taken", message: "已存在同名模板" }, 400);
    }
  }

  const scope = (data.model_scope ?? existing.model_scope) as ModelScope;
  const modelIds = data.model_ids
    ? Array.from(new Set(data.model_ids.map((v) => v.trim()).filter(Boolean)))
    : existing.models.map((m) => m.model_id);
  const groupIds = data.group_ids
    ? Array.from(new Set(data.group_ids.map((v) => v.trim()).filter(Boolean)))
    : existing.groups.map((g) => g.group_id);
  if (data.model_ids || data.group_ids || data.model_scope !== undefined) {
    const invalid = await validateGrants(c.env, scope, modelIds, groupIds);
    if (invalid) return c.json(invalid.body, 400);
  }

  const item = await updateDeviceTemplate(c.env, id, {
    name: data.name,
    description: data.description,
    model_scope: data.model_scope,
    models:
      data.model_ids || data.model_scope !== undefined
        ? scope === "all"
          ? []
          : toGrants(modelIds, data.model_rpms ?? Object.fromEntries(existing.models.map((m) => [m.model_id, m.rpm])), "model_id")
        : undefined,
    groups:
      data.group_ids || data.model_scope !== undefined
        ? scope === "all"
          ? []
          : toGrants(groupIds, data.group_rpms ?? Object.fromEntries(existing.groups.map((g) => [g.group_id, g.rpm])), "group_id")
        : undefined,
  });
  await recordAuditLog(c.env, {
    actor_type: "admin",
    action: "device_template.update",
    target_type: "device_template",
    target_id: id,
    summary: `修改设备模板 ${item?.name ?? id}`,
  });
  return c.json({ item });
});

deviceTemplatesApp.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getDeviceTemplate(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  const ok = await deleteDeviceTemplate(c.env, id);
  if (!ok) return c.json({ error: "not_found" }, 404);
  await recordAuditLog(c.env, {
    actor_type: "admin",
    action: "device_template.delete",
    target_type: "device_template",
    target_id: id,
    summary: `删除设备模板 ${existing.name}`,
  });
  return c.json({ ok: true });
});

deviceTemplatesApp.post("/:id/preview", zValidator("json", ApplyDeviceTemplateSchema), async (c) => {
  const template = await getDeviceTemplate(c.env, c.req.param("id"));
  if (!template) return c.json({ error: "not_found" }, 404);
  const data = c.req.valid("json");
  const targets = await resolveTargets(c.env, data.device_ids);
  if ("error" in targets) return c.json(targets.body, 400);

  const fromScope = (d: DeviceRow) => (d.model_scope || "all") as ModelScope;
  const toScope = (d: DeviceRow) =>
    data.mode === "replace" ? template.model_scope : template.model_scope === "list" ? "list" : fromScope(d);

  const items = targets.devices.map((d) => ({
    device_id: d.id,
    name: d.name,
    from_scope: fromScope(d),
    to_scope: toScope(d),
    revoked: Boolean(d.revoked_at),
  }));
  const scopeChanges = items.filter((i) => i.from_scope !== i.to_scope).length;
  const grants = template.model_scope === "all" ? 0 : template.models.length + template.groups.length;
  const planned = templateApplyStatementCount(items.length, grants, data.mode);
  return c.json({
    item: {
      template_id: template.id,
      template_name: template.name,
      mode: data.mode,
      device_count: items.length,
      scope_change_count: scopeChanges,
      model_grants: template.model_scope === "all" ? 0 : template.models.length,
      group_grants: template.model_scope === "all" ? 0 : template.groups.length,
      statements: planned,
      statement_limit: MAX_TEMPLATE_APPLY_STATEMENTS,
      items,
    },
  });
});

async function resolveTargets(
  env: Env,
  selection: string[] | "all"
): Promise<{ devices: DeviceRow[] } | { error: string; body: Record<string, unknown> }> {
  const all = await listDevices(env, { includeRevoked: true });
  if (selection === "all") {
    return { devices: all.filter((d) => !d.revoked_at) };
  }
  const wanted = Array.from(new Set(selection.map((id) => id.trim()).filter(Boolean)));
  const byId = new Map(all.map((d) => [d.id, d]));
  const unknown = wanted.filter((id) => !byId.has(id));
  if (unknown.length) return { error: "unknown_device_ids", body: { error: "unknown_device_ids", device_ids: unknown } };
  const revoked = wanted.filter((id) => byId.get(id)!.revoked_at);
  if (revoked.length) return { error: "device_revoked", body: { error: "device_revoked", device_ids: revoked } };
  return { devices: wanted.map((id) => byId.get(id)!) };
}

deviceTemplatesApp.post("/:id/apply", zValidator("json", ApplyDeviceTemplateSchema), async (c) => {
  const template = await getDeviceTemplate(c.env, c.req.param("id"));
  if (!template) return c.json({ error: "not_found" }, 404);
  const data = c.req.valid("json");
  const targets = await resolveTargets(c.env, data.device_ids);
  if ("error" in targets) return c.json(targets.body, 400);
  if (!targets.devices.length) {
    return c.json({ error: "no_targets", message: "没有可套用的设备" }, 400);
  }

  const grants = template.model_scope === "all" ? 0 : template.models.length + template.groups.length;
  const planned = templateApplyStatementCount(targets.devices.length, grants, data.mode);
  if (planned > MAX_TEMPLATE_APPLY_STATEMENTS) {
    return c.json(
      {
        error: "too_many_statements",
        message: `这次套用会生成 ${planned} 条语句，超过上限 ${MAX_TEMPLATE_APPLY_STATEMENTS} 条，请分批套用`,
        statements: planned,
        limit: MAX_TEMPLATE_APPLY_STATEMENTS,
      },
      400
    );
  }

  await applyDeviceTemplate(c.env, template, targets.devices, data.mode);
  await recordAuditLog(c.env, {
    actor_type: "admin",
    action: "device_template.apply",
    target_type: "device_template",
    target_id: template.id,
    summary: `套用设备模板 ${template.name}（${data.mode}，${targets.devices.length} 台设备）`,
    details: { device_ids: targets.devices.map((d) => d.id), mode: data.mode },
  });
  return c.json({
    ok: true,
    applied: targets.devices.length,
    mode: data.mode,
    template_id: template.id,
  });
});

deviceTemplatesApp.post("/from-device/:deviceId", async (c) => {
  const deviceId = c.req.param("deviceId");
  const all = await listDevices(c.env, { includeRevoked: true });
  const device = all.find((d) => d.id === deviceId);
  if (!device) return c.json({ error: "not_found" }, 404);

  const models = await c.env.DB.prepare(
    "SELECT dm.model_id as model_id, dm.rpm as rpm, mo.id as live_id " +
      "FROM device_models dm LEFT JOIN models mo ON mo.id = dm.model_id WHERE dm.device_id = ?"
  )
    .bind(deviceId)
    .all<{ model_id: string; rpm: number; live_id: string | null }>();
  const groups = await c.env.DB.prepare(
    "SELECT dm.group_id as group_id, dm.rpm as rpm, g.id as live_id " +
      "FROM device_model_groups dm LEFT JOIN model_groups g ON g.id = dm.group_id WHERE dm.device_id = ?"
  )
    .bind(deviceId)
    .all<{ group_id: string; rpm: number; live_id: string | null }>();
  const liveModels = (models.results || []).filter((r) => r.live_id);
  const liveGroups = (groups.results || []).filter((r) => r.live_id);
  const dropped = (models.results || []).length - liveModels.length + ((groups.results || []).length - liveGroups.length);

  const name = String((c.req.query("name") || `${device.name} 的模板`).trim()).slice(0, 100);
  if (await getDeviceTemplateByName(c.env, name)) {
    return c.json({ error: "name_taken", message: "已存在同名模板" }, 400);
  }
  const item = await createDeviceTemplate(c.env, {
    name,
    description: `由设备 ${device.name} 的白名单生成`,
    model_scope: (device.model_scope || "all") as ModelScope,
    models: liveModels.map((r) => ({ model_id: r.model_id, rpm: Number(r.rpm) || 0 })),
    groups: liveGroups.map((r) => ({ group_id: r.group_id, rpm: Number(r.rpm) || 0 })),
  });
  await recordAuditLog(c.env, {
    actor_type: "admin",
    action: "device_template.create",
    target_type: "device_template",
    target_id: item.id,
    summary:
      `从设备 ${device.name} 生成设备模板 ${item.name}` +
      (dropped ? `（跳过 ${dropped} 条已删除的授权）` : ""),
    details: dropped ? { dropped_grants: dropped } : undefined,
  });
  return c.json({ item }, 201);
});
