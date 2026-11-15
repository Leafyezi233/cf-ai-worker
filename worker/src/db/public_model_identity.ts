import type { Env, ServiceGroupModelRow } from "../types";
import { ensureSchema } from "./schema";

export { PUBLIC_MODEL_IDENTITY_SCHEMA, PUBLIC_MODEL_IDENTITY_BACKFILL } from "./public_model_identity_schema";

export function publicModelIdentityStatement(env: Env, name: string): D1PreparedStatement {
  return env.DB.prepare("INSERT OR IGNORE INTO public_model_identities(id,name,enabled) VALUES(?,?,1)").bind("public_" + crypto.randomUUID(),name);
}

export async function getPublicModelIdentity(env: Env, canonicalKey: string): Promise<string | null> {
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT id FROM public_model_identities WHERE name = ? AND enabled = 1").bind(canonicalKey).first<{id:string}>();
  return row?.id ?? null;
}

export async function resolvePublicModelKey(env: Env, serviceGroupId: string, key: string): Promise<{mapping:ServiceGroupModelRow|null;reserved:boolean}> {
  await ensureSchema(env);
  const direct = await env.DB.prepare("SELECT m.*,i.enabled AS identity_enabled FROM service_group_models m LEFT JOIN public_model_identities i ON i.name=m.model_key WHERE service_group_id = ? AND model_key = ?").bind(serviceGroupId,key).first<ServiceGroupModelRow & {identity_enabled:number|null}>();
  if (direct) return {mapping:direct.identity_enabled===0?null:direct,reserved:true};
  const alias = await env.DB.prepare("SELECT mapping_id,enabled FROM service_model_aliases WHERE service_group_id = ? AND name = ?").bind(serviceGroupId,key).first<{mapping_id:string;enabled:number}>();
  if (!alias) return {mapping:null,reserved:false};
  if (alias.enabled !== 1) return {mapping:null,reserved:true};
  const mapping = await env.DB.prepare("SELECT m.*,i.enabled AS identity_enabled FROM service_group_models m LEFT JOIN public_model_identities i ON i.name=m.model_key WHERE service_group_id = ? AND m.id = ?").bind(serviceGroupId,alias.mapping_id).first<ServiceGroupModelRow & {identity_enabled:number|null}>();
  return {mapping:mapping?.identity_enabled===0?null:mapping,reserved:true};
}

export async function resolvePublicModelKeys(env:Env, serviceGroupIds:string[], key:string):Promise<Array<{service_group_id:string;mapping:ServiceGroupModelRow|null;reserved:boolean}>> {
  await ensureSchema(env);
  const out:Array<{service_group_id:string;mapping:ServiceGroupModelRow|null;reserved:boolean}>=[];
  for(let i=0;i<serviceGroupIds.length;i+=40){
    const ids=serviceGroupIds.slice(i,i+40), slots=ids.map(()=>"?").join(",");
    const direct=(await env.DB.prepare("SELECT m.*,i.enabled AS identity_enabled FROM service_group_models m LEFT JOIN public_model_identities i ON i.name=m.model_key WHERE model_key=? AND service_group_id IN("+slots+")").bind(key,...ids).all<ServiceGroupModelRow & {identity_enabled:number|null}>()).results??[];
    const aliases=(await env.DB.prepare("SELECT a.service_group_id AS alias_group_id,a.enabled AS alias_enabled,m.*,i.enabled AS identity_enabled FROM service_model_aliases a LEFT JOIN service_group_models m ON m.id=a.mapping_id AND m.service_group_id=a.service_group_id LEFT JOIN public_model_identities i ON i.name=m.model_key WHERE a.name=? AND a.service_group_id IN("+slots+")").bind(key,...ids).all<ServiceGroupModelRow & {alias_group_id:string;alias_enabled:number;identity_enabled:number|null}>()).results??[];
    const directByGroup=new Map(direct.map(m=>[m.service_group_id,m]));
    const aliasByGroup=new Map(aliases.map(a=>[a.alias_group_id,a]));
    for(const id of ids){
      const mapping=directByGroup.get(id);
      if(mapping){out.push({service_group_id:id,mapping:mapping.identity_enabled===0?null:mapping,reserved:true});continue;}
      const alias=aliasByGroup.get(id);
      out.push({service_group_id:id,mapping:alias?.alias_enabled===1&&alias.id&&alias.identity_enabled!==0?alias:null,reserved:!!alias});
    }
  }
  return out;
}

export function reserveDeletedMappingStatement(env:Env,groupId:string,mappingId:string,name:string):D1PreparedStatement {
  return env.DB.prepare("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES(?,?,?,0) ON CONFLICT(service_group_id,name) DO UPDATE SET enabled=0").bind(groupId,name,mappingId);
}
