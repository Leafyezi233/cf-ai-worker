import { z } from "zod";
import type { Env } from "../types";
import { ensureSchema } from "./schema";
import { parseTokenRoutingPolicy } from "./token_policies";
import { publicModelIdentityStatement } from "./public_model_identity";

const Id = z.string().min(1).max(200);
const Flag = z.union([z.literal(0), z.literal(1)]);
const Price = z.number().finite().nonnegative();
const Integer = z.number().int().nonnegative();
const Timestamp = Integer.nullable();
const Prices = {
  input_price_per_m: Price, output_price_per_m: Price,
  cache_read_price_per_m: Price, cache_write_price_per_m: Price,
  price_per_call: Price, search_price_per_call: Price,
};
const Pricing = z.object(Prices).strict();
const MemberIds = z.array(Id).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, "Duplicate member IDs");
function jsonString<T extends z.ZodTypeAny>(schema: T) {
  return z.string().superRefine((value, ctx) => {
    try {
      if (!schema.safeParse(JSON.parse(value)).success) throw new Error("Invalid shape");
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid JSON value" });
    }
  });
}
const Group = z.object({
  id: Id, name: Id, display_name: z.string().nullable(), description: z.string().nullable(),
  enabled: Flag, model_public: Flag, pricing_mode: z.enum(["unset", "free", "priced"]),
  ...Prices, cache_enabled: Flag, cache_ttl: Integer, peak_pricing_enabled: Flag,
  config_json: z.string().nullable(), created_at: Timestamp, updated_at: Timestamp,
  billing_unit: z.enum(["token", "call"]),
}).strict();
const Member = z.object({ group_id: Id, model_id: Id, position: Integer, enabled: Flag }).strict();
const Window = z.object({
  id: Id, model_id: Id, day_type: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun", "weekday", "weekend"]),
  start_minute: Integer.max(1439), end_minute: Integer.max(1440), multiplier: Price,
  enabled: Flag, created_at: Timestamp, updated_at: Timestamp,
}).strict();
const GroupGrant = z.object({ device_id: Id, group_id: Id, rpm: Integer }).strict();
const ServiceGroup = z.object({
  id: Id, name: Id, description: z.string().nullable(), public_selectable: Flag,
  selectable: Flag, enabled: Flag, multiplier: Price, revision: Integer.min(1),
}).strict();
const Mapping = z.object({
  id: Id, service_group_id: Id, model_key: Id, target_type: z.enum(["model", "group"]), target_id: Id,
  pricing_json: jsonString(Pricing).nullable(), member_ids_json: jsonString(MemberIds).nullable(),
}).strict();
const ServiceGrant = z.object({ device_id: Id, service_group_id: Id }).strict();
const DeviceSelection = z.object({ id: Id, default_service_group_id: Id.nullable(), service_group_id: Id.nullable() }).strict();
const SubSelection = z.object({ id: Id, device_id: Id, service_group_id: Id.nullable() }).strict();
const Identity = z.object({id:Id,name:Id,enabled:Flag}).strict();
const Alias = z.object({service_group_id:Id,name:Id,mapping_id:Id,enabled:Flag}).strict();
const Policy = z.object({device_id:Id,token_id:Id,policy_json:z.string().nullable().superRefine((v,ctx)=>{try{parseTokenRoutingPolicy(v===null?null:JSON.parse(v));}catch{ctx.addIssue({code:z.ZodIssueCode.custom,message:"Invalid routing policy"});}}),revision:Integer.min(1),updated_at:Integer}).strict();
const RoutingMetadata = z.object({identities:z.array(Identity),aliases:z.array(Alias),policies:z.array(Policy)}).strict();
const Snapshot = z.object({
  routing_metadata: RoutingMetadata.optional(),
  model_groups: z.array(Group), model_group_members: z.array(Member), model_price_windows: z.array(Window),
  device_model_groups: z.array(GroupGrant), service_groups: z.array(ServiceGroup),
  service_group_models: z.array(Mapping), device_service_groups: z.array(ServiceGrant),
  device_service_group_selections: z.array(DeviceSelection), sub_token_service_group_selections: z.array(SubSelection),
}).strict();
export type ServiceGroupsSnapshot = z.infer<typeof Snapshot>;

function requireRef(ids: Set<string>, id: string, kind: string): void {
  if (!ids.has(id)) throw new Error("Missing " + kind + " reference: " + id);
}
function unique<T>(rows: T[], key: (row: T) => string, kind: string): void {
  const keys = rows.map(key);
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate " + kind);
}
const pair = (...ids: string[]) => JSON.stringify(ids);

export function validateServiceGroupsSnapshot(payload: unknown): ServiceGroupsSnapshot {
  const data = Snapshot.parse(payload);
  const groups = new Set(data.model_groups.map((row) => row.id));
  const services = new Set(data.service_groups.map((row) => row.id));
  unique(data.model_groups, (r) => r.id, "model group IDs");
  unique(data.model_groups, (r) => r.name, "model group names");
  unique(data.model_group_members, (r) => pair(r.group_id, r.model_id), "model group members");
  unique(data.model_price_windows, (r) => r.id, "price window IDs");
  unique(data.device_model_groups, (r) => pair(r.device_id, r.group_id), "model group grants");
  unique(data.service_groups, (r) => r.id, "service group IDs");
  unique(data.service_group_models, (r) => r.id, "mapping IDs");
  unique(data.service_group_models, (r) => pair(r.service_group_id, r.model_key), "mapping keys");
  unique(data.device_service_groups, (r) => pair(r.device_id, r.service_group_id), "service group grants");
  unique(data.device_service_group_selections, (r) => r.id, "device selections");
  unique(data.sub_token_service_group_selections, (r) => r.id, "sub-token selections");
  for (const row of data.model_group_members) requireRef(groups, row.group_id, "model group");
  for (const row of data.device_model_groups) requireRef(groups, row.group_id, "model group grant");
  for (const row of data.service_group_models) {
    requireRef(services, row.service_group_id, "mapping service group");
    if (row.target_type === "group") requireRef(groups, row.target_id, "mapping model group");
  }
  for (const row of data.device_service_groups) requireRef(services, row.service_group_id, "service group grant");
  for (const row of [...data.device_service_group_selections, ...data.sub_token_service_group_selections]) {
    if (row.service_group_id !== null && row.service_group_id !== "auto" && row.service_group_id !== "legacy") requireRef(services, row.service_group_id, "credential selection");
  }
  for (const row of data.device_service_group_selections) {
    if (row.default_service_group_id !== null && row.default_service_group_id !== "auto" && row.default_service_group_id !== "legacy") requireRef(services, row.default_service_group_id, "device default");
  }
  if(data.routing_metadata){
    const {identities,aliases,policies}=data.routing_metadata;
    unique(identities,r=>r.id,"public identity IDs"); unique(identities,r=>r.name,"public identity names");
    unique(aliases,r=>pair(r.service_group_id,r.name),"aliases"); unique(policies,r=>pair(r.device_id,r.token_id),"token policies");
    const mappingIds=new Map(data.service_group_models.map(m=>[m.id,m]));
    for(const a of aliases){
      requireRef(services,a.service_group_id,"alias service group");
      if(a.enabled && mappingIds.get(a.mapping_id)?.service_group_id!==a.service_group_id)throw new Error("Missing alias mapping reference");
      if(data.service_group_models.some(m=>m.service_group_id===a.service_group_id&&m.model_key===a.name&&m.id!==a.mapping_id))throw new Error("Alias conflicts with canonical name");
    }
    for(const row of policies){const policy=parseTokenRoutingPolicy(row.policy_json===null?null:JSON.parse(row.policy_json));for(const id of policy?.group_ids??[])requireRef(services,id,"token policy group");}
  }
  return data;
}

const tables = [
  ["model_groups", "model_groups", Group],
  ["model_group_members", "model_group_members", Member],
  ["model_price_windows", "price_windows", Window],
  ["device_model_groups", "device_model_groups", GroupGrant],
  ["service_groups", "service_groups", ServiceGroup],
  ["service_group_models", "service_group_models", Mapping],
  ["device_service_groups", "device_service_groups", ServiceGrant],
  ["device_service_group_selections", "devices", DeviceSelection],
  ["sub_token_service_group_selections", "device_sub_tokens", SubSelection],
] as const;

export async function snapshotServiceGroups(env: Env): Promise<ServiceGroupsSnapshot> {
  await ensureSchema(env);
  const results = await env.DB.batch([...tables.map(([, table, schema]) =>
    env.DB.prepare("SELECT " + Object.keys(schema.shape).join(", ") + " FROM " + table + " ORDER BY " + Object.keys(schema.shape)[0])),
    env.DB.prepare("SELECT id,name,enabled FROM public_model_identities ORDER BY name"),
    env.DB.prepare("SELECT service_group_id,name,mapping_id,enabled FROM service_model_aliases ORDER BY service_group_id,name"),
    env.DB.prepare("SELECT device_id,token_id,policy_json,revision,updated_at FROM token_routing_policies ORDER BY device_id,token_id")]);
  const payload = {...Object.fromEntries(tables.map(([key], i) => [key, results[i].results ?? []])),routing_metadata:{identities:results[tables.length].results??[],aliases:results[tables.length+1].results??[],policies:results[tables.length+2].results??[]}};
  return validateServiceGroupsSnapshot(payload);
}

export async function restoreServiceGroupsSnapshot(
  env: Env, payload: unknown, modelIdMap?: Map<string, string>, additionalStatements: D1PreparedStatement[] = [],
): Promise<void> {
  let data = validateServiceGroupsSnapshot(payload);
  const groupIds = new Set(data.model_groups.map((r) => r.id));
  const remap = (id: string) => modelIdMap?.get(id) ?? id;
  data = validateServiceGroupsSnapshot({
    ...data,
    model_group_members: data.model_group_members.map((r) => ({ ...r, model_id: remap(r.model_id) })),
    model_price_windows: data.model_price_windows.map((r) => ({ ...r, model_id: groupIds.has(r.model_id) ? r.model_id : remap(r.model_id) })),
    service_group_models: data.service_group_models.map((r) => ({
      ...r, target_id: r.target_type === "model" ? remap(r.target_id) : r.target_id,
      member_ids_json: r.member_ids_json === null ? null : JSON.stringify((JSON.parse(r.member_ids_json) as string[]).map(remap)),
    })),
  });
  await ensureSchema(env);
  const [modelsResult, devicesResult, subsResult] = await env.DB.batch([
    env.DB.prepare("SELECT id FROM models"), env.DB.prepare("SELECT id FROM devices"),
    env.DB.prepare("SELECT id, device_id FROM device_sub_tokens"),
  ]);
  const models = new Set((modelsResult.results as { id: string }[]).map((r) => r.id));
  const devices = new Set((devicesResult.results as { id: string }[]).map((r) => r.id));
  const subs = new Map((subsResult.results as { id: string; device_id: string }[]).map((r) => [r.id, r.device_id]));
  for (const row of data.model_group_members) requireRef(models, row.model_id, "member model");
  for (const row of data.model_price_windows) {
    if (!groupIds.has(row.model_id)) requireRef(models, row.model_id, "price window model");
  }
  for (const row of data.service_group_models) {
    if (row.target_type === "model") requireRef(models, row.target_id, "mapping model");
    for (const id of row.member_ids_json === null ? [] : JSON.parse(row.member_ids_json) as string[]) requireRef(models, id, "mapping member");
  }
  data.device_model_groups = data.device_model_groups.filter((r) => devices.has(r.device_id));
  data.device_service_groups = data.device_service_groups.filter((r) => devices.has(r.device_id));
  data.device_service_group_selections = data.device_service_group_selections.filter((r) => devices.has(r.id));
  data.sub_token_service_group_selections = data.sub_token_service_group_selections.filter((r) => devices.has(r.device_id) && subs.get(r.id) === r.device_id);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE devices SET default_service_group_id = NULL, service_group_id = NULL"),
    env.DB.prepare("UPDATE device_sub_tokens SET service_group_id = NULL"),
    ...["device_service_groups", "service_group_models", "service_groups", "device_model_groups", "model_group_members", "price_windows", "model_groups"]
      .map((table) => env.DB.prepare("DELETE FROM " + table)),
  ];
  for (const [key, table, schema] of tables.slice(0, 7)) {
    const columns = Object.keys(schema.shape);
    for (const row of data[key]) {
      const values = row as Record<string, string | number | null>;
      statements.push(env.DB.prepare("INSERT INTO " + table + " (" + columns.join(", ") + ") VALUES (" + columns.map(() => "?").join(", ") + ")")
        .bind(...columns.map((column) => values[column])));
    }
  }
  for (const row of data.device_service_group_selections) statements.push(env.DB.prepare(
    "UPDATE devices SET default_service_group_id = ?, service_group_id = ? WHERE id = ?"
  ).bind(row.default_service_group_id, row.service_group_id, row.id));
  for (const row of data.sub_token_service_group_selections) statements.push(env.DB.prepare(
    "UPDATE device_sub_tokens SET service_group_id = ? WHERE id = ? AND device_id = ?"
  ).bind(row.service_group_id, row.id, row.device_id));
  if(data.routing_metadata){
    statements.push(...["service_model_aliases","public_model_identities","token_routing_policy_groups"].map(t=>env.DB.prepare("DELETE FROM "+t)));
    for(const r of data.routing_metadata.identities)statements.push(env.DB.prepare("INSERT INTO public_model_identities(id,name,enabled) VALUES(?,?,?)").bind(r.id,r.name,r.enabled));
    for(const r of data.routing_metadata.aliases)statements.push(env.DB.prepare("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES(?,?,?,?)").bind(r.service_group_id,r.name,r.mapping_id,r.enabled));
    for(const r of data.routing_metadata.policies){
      if(!devices.has(r.device_id)||(!["account","master"].includes(r.token_id)&&subs.get(r.token_id)!==r.device_id))continue;
      const policy=parseTokenRoutingPolicy(r.policy_json===null?null:JSON.parse(r.policy_json));
      const remapKey=(key:string)=>key.startsWith("model:")?"model:"+remap(key.slice(6)):key;
      if(policy){policy.model_scope=policy.model_scope?.map(remapKey)??null;policy.model_overrides=Object.fromEntries(Object.entries(policy.model_overrides).map(([key,value])=>[remapKey(key),value]));}
      statements.push(env.DB.prepare("INSERT INTO token_routing_policies(device_id,token_id,policy_json,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(device_id,token_id) DO UPDATE SET policy_json=excluded.policy_json,revision=MAX(token_routing_policies.revision+1,excluded.revision),updated_at=excluded.updated_at").bind(r.device_id,r.token_id,policy===null?null:JSON.stringify(policy),r.revision+1,Date.now()));
      for(const [position,id]of(policy?.group_ids??[]).entries())statements.push(env.DB.prepare("INSERT INTO token_routing_policy_groups(device_id,token_id,service_group_id,position) VALUES(?,?,?,?)").bind(r.device_id,r.token_id,id,position));
    }
    const retainedPolicies = data.routing_metadata.policies.filter(r => devices.has(r.device_id) && (["account", "master"].includes(r.token_id) || subs.get(r.token_id) === r.device_id));
    statements.push(env.DB.prepare("DELETE FROM token_routing_policies WHERE NOT EXISTS (SELECT 1 FROM json_each(?) saved WHERE json_extract(saved.value, '$.device_id')=token_routing_policies.device_id AND json_extract(saved.value, '$.token_id')=token_routing_policies.token_id)").bind(JSON.stringify(retainedPolicies.map(r => ({device_id:r.device_id,token_id:r.token_id})))));
  }
  for(const row of data.service_group_models)statements.push(publicModelIdentityStatement(env,row.model_key));
  statements.push(...additionalStatements);
  await env.DB.batch(statements);
}
