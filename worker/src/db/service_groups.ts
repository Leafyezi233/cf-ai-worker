import type {
  AuthedDevice,
  DeviceServiceGroupRow,
  Env,
  ServiceGroupModelRow,
  ServiceGroupRow,
} from "../types";
import { newId } from "../utils/crypto";
import { ensureSchema } from "./schema";
import { resolvePublicModelKey, publicModelIdentityStatement, reserveDeletedMappingStatement } from "./public_model_identity";

export type {
  DeviceServiceGroupRow,
  ServiceGroupModelRow,
  ServiceGroupRow,
  ServiceGroupTargetType,
} from "../types";

export type ServiceGroupInput = Pick<ServiceGroupRow, "name"> & Partial<Pick<
  ServiceGroupRow, "description" | "public_selectable" | "selectable" | "enabled" | "multiplier"
>>;
export type ServiceGroupModelInput = Pick<ServiceGroupModelRow, "model_key" | "target_type" | "target_id"> &
  Partial<Pick<ServiceGroupModelRow, "pricing_json" | "member_ids_json">>;

export async function getServiceGroup(env: Env, id: string): Promise<ServiceGroupRow | null> {
  await ensureSchema(env);
  return env.DB.prepare("SELECT * FROM service_groups WHERE id = ?").bind(id).first<ServiceGroupRow>();
}

export async function listServiceGroups(env: Env): Promise<ServiceGroupRow[]> {
  await ensureSchema(env);
  const result = await env.DB.prepare("SELECT * FROM service_groups ORDER BY name, id").all<ServiceGroupRow>();
  return result.results || [];
}

export async function getServiceGroupModel(env: Env, groupId: string, modelKey: string): Promise<ServiceGroupModelRow | null> {
  await ensureSchema(env);
  return (await resolvePublicModelKey(env, groupId, modelKey)).mapping;
}

export async function listServiceGroupModels(env: Env, groupId: string): Promise<ServiceGroupModelRow[]> {
  await ensureSchema(env);
  const result = await env.DB.prepare(
    "SELECT * FROM service_group_models WHERE service_group_id = ? ORDER BY model_key, id"
  ).bind(groupId).all<ServiceGroupModelRow>();
  return result.results || [];
}

export async function canUseServiceGroup(env: Env, deviceId: string, groupId: string): Promise<boolean> {
  await ensureSchema(env);
  const row = await env.DB.prepare(
    "SELECT g.id FROM service_groups g WHERE g.id = ? AND g.enabled = 1 " +
    "AND (g.public_selectable = 1 OR EXISTS (SELECT 1 FROM device_service_groups d " +
    "WHERE d.device_id = ? AND d.service_group_id = g.id))"
  ).bind(groupId, deviceId).first<{ id: string }>();
  return row !== null;
}

export async function listSelectableServiceGroups(env: Env, deviceId: string): Promise<ServiceGroupRow[]> {
  await ensureSchema(env);
  const result = await env.DB.prepare(
    "SELECT g.* FROM service_groups g WHERE g.enabled = 1 AND g.selectable = 1 " +
    "AND (g.public_selectable = 1 OR EXISTS (SELECT 1 FROM device_service_groups d " +
    "WHERE d.device_id = ? AND d.service_group_id = g.id)) ORDER BY g.name, g.id"
  ).bind(deviceId).all<ServiceGroupRow>();
  return result.results || [];
}

export async function resolveEffectiveServiceGroup(env: Env, device: AuthedDevice): Promise<ServiceGroupRow | null> {
  await ensureSchema(env);
  const id = device.service_group_id ?? device.default_service_group_id;
  if (id == null || id === "auto" || id === "legacy") return null;
  if (!(await canUseServiceGroup(env, device.id, id))) throw new Error("Service group is not available to this device");
  const group = await getServiceGroup(env, id);
  if (!group || group.enabled !== 1) throw new Error("Service group is not available to this device");
  return group;
}

export async function createServiceGroup(env: Env, data: ServiceGroupInput): Promise<ServiceGroupRow> {
  await ensureSchema(env);
  const row: ServiceGroupRow = {
    id: newId("sg"), name: data.name, description: data.description ?? null,
    public_selectable: data.public_selectable ?? 0, selectable: data.selectable ?? 1,
    enabled: data.enabled ?? 1, multiplier: data.multiplier ?? 1, revision: 1,
  };
  await env.DB.prepare(
    "INSERT INTO service_groups (id, name, description, public_selectable, selectable, enabled, multiplier, revision) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(row.id, row.name, row.description, row.public_selectable, row.selectable, row.enabled, row.multiplier, row.revision).run();
  return row;
}

export async function updateServiceGroup(env: Env, id: string, data: Partial<ServiceGroupInput>): Promise<ServiceGroupRow | null> {
  await ensureSchema(env);
  const columns = ["name", "description", "public_selectable", "selectable", "enabled", "multiplier"] as const;
  const changed = columns.filter((column) => data[column] !== undefined);
  if (changed.length > 0) {
    await env.DB.prepare(
      "UPDATE service_groups SET " + changed.map((column) => column + " = ?").join(", ") +
      ", revision = revision + 1 WHERE id = ?"
    ).bind(...changed.map((column) => data[column]), id).run();
  }
  return getServiceGroup(env, id);
}

export async function deleteServiceGroup(env: Env, id: string): Promise<boolean> {
  await ensureSchema(env);
  const assigned = await env.DB.prepare(
    "SELECT id FROM devices WHERE default_service_group_id = ? OR service_group_id = ? " +
    "UNION ALL SELECT id FROM device_sub_tokens WHERE service_group_id = ? LIMIT 1"
  ).bind(id, id, id).first<{ id: string }>();
  if (assigned) throw new Error("Service group is assigned to a credential");
  const unassigned = "NOT EXISTS (SELECT 1 FROM devices WHERE default_service_group_id = ? OR service_group_id = ?) " +
    "AND NOT EXISTS (SELECT 1 FROM device_sub_tokens WHERE service_group_id = ?) AND NOT EXISTS (SELECT 1 FROM token_routing_policy_groups WHERE service_group_id = ?)";
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM service_group_models WHERE service_group_id = ? AND " + unassigned).bind(id, id, id, id, id),
    env.DB.prepare("DELETE FROM device_service_groups WHERE service_group_id = ? AND " + unassigned).bind(id, id, id, id, id),
    env.DB.prepare("DELETE FROM service_groups WHERE id = ? AND " + unassigned).bind(id, id, id, id, id),
  ]);
  return (results[2].meta.changes ?? 0) > 0;
}

export async function upsertServiceGroupModel(env: Env, groupId: string, data: ServiceGroupModelInput): Promise<ServiceGroupModelRow> {
  await ensureSchema(env);
  if (!(await getServiceGroup(env, groupId))) throw new Error("Service group not found");
  const guard=newId("sgguard");
  const memberIds:unknown=data.member_ids_json==null?null:JSON.parse(data.member_ids_json);
  if(memberIds!==null&&(!Array.isArray(memberIds)||memberIds.some(id=>typeof id!=="string")))throw new Error("Invalid member IDs");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO public_model_write_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM service_groups WHERE id=?) AND EXISTS(SELECT 1 FROM "+(data.target_type==="model"?"models":"model_groups")+" WHERE id=?) THEN 1 ELSE 0 END").bind(guard,groupId,data.target_id),
    ...(Array.isArray(memberIds)?memberIds.map((id,n)=>env.DB.prepare("INSERT INTO public_model_write_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM models WHERE id=?) THEN 1 ELSE 0 END").bind(guard+":"+n,id)):[]),
    publicModelIdentityStatement(env, data.model_key),
    env.DB.prepare(
      "INSERT INTO service_group_models (id, service_group_id, model_key, target_type, target_id, pricing_json, member_ids_json) " +
      "SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM service_groups WHERE id = ?) " +
      "ON CONFLICT(service_group_id, model_key) DO UPDATE SET target_type = excluded.target_type, " +
      "target_id = excluded.target_id, pricing_json = excluded.pricing_json, member_ids_json = excluded.member_ids_json"
    ).bind(newId("sgm"), groupId, data.model_key, data.target_type, data.target_id, data.pricing_json ?? null, data.member_ids_json ?? null, groupId),
    env.DB.prepare("UPDATE service_groups SET revision = revision + 1 WHERE id = ?").bind(groupId),
    env.DB.prepare("DELETE FROM public_model_write_guards WHERE id LIKE ?").bind(guard+"%"),
  ]);
  const row = await env.DB.prepare(
    "SELECT * FROM service_group_models WHERE service_group_id = ? AND model_key = ?"
  ).bind(groupId, data.model_key).first<ServiceGroupModelRow>();
  if (!row) throw new Error("Service group mapping not found after upsert");
  return row;
}

export async function deleteServiceGroupModel(env: Env, groupId: string, modelKey: string): Promise<void> {
  await ensureSchema(env);
  const existing = await getServiceGroupModel(env, groupId, modelKey);
  if (!existing) return;
  await env.DB.batch([
    reserveDeletedMappingStatement(env, groupId, existing.id, existing.model_key),
    env.DB.prepare("UPDATE service_model_aliases SET enabled = 0 WHERE mapping_id = ?").bind(existing.id),
    env.DB.prepare("DELETE FROM service_group_models WHERE service_group_id = ? AND id = ?").bind(groupId, existing.id),
    env.DB.prepare("UPDATE service_groups SET revision = revision + 1 WHERE id = ?").bind(groupId),
  ]);
}

export async function listDeviceServiceGroups(env: Env, deviceId: string): Promise<DeviceServiceGroupRow[]> {
  await ensureSchema(env);
  const result = await env.DB.prepare(
    "SELECT device_id, service_group_id FROM device_service_groups WHERE device_id = ? ORDER BY service_group_id"
  ).bind(deviceId).all<DeviceServiceGroupRow>();
  return result.results || [];
}

export async function setDeviceServiceGroups(env: Env, deviceId: string, groupIds: string[]): Promise<void> {
  await ensureSchema(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM device_service_groups WHERE device_id = ?").bind(deviceId),
    ...[...new Set(groupIds)].map((id) => env.DB.prepare(
      "INSERT INTO device_service_groups (device_id, service_group_id) VALUES (?, ?)"
    ).bind(deviceId, id)),
  ]);
}
