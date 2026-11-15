import { Hono } from "hono";
import { z } from "zod";
import type { Env, ServiceGroupModelRow } from "../types";
import { ensureSchema } from "../db/schema";
import { publicModelIdentityStatement } from "../db/public_model_identity";
import { recordAuditLog } from "../db/repo";
import { extractClientIp } from "../middleware/adminAuth";
import { ensureModelCategoriesSchema, renameModelCategoryKeyStatements } from "../db/model_categories";

export const serviceModelNamesApp = new Hono<{Bindings:Env}>();
const Name = z.string().trim().min(1).max(200);
const Alias = z.object({name:Name,mapping_id:Name,enabled:z.union([z.literal(0),z.literal(1)]).default(1)}).strict();
const Aliases = z.object({aliases:z.array(Alias).max(100),allow_legacy_shadow:z.boolean().default(false)}).strict();
const Rename = z.object({new_name:Name,keep_old_alias:z.boolean().default(true),allow_legacy_shadow:z.boolean().default(false)}).strict();
const legacyCollision = "EXISTS(SELECT 1 FROM models WHERE model_name = ? OR alias = ?) OR EXISTS(SELECT 1 FROM model_groups WHERE name = ?)";
serviceModelNamesApp.get("/:id/aliases", async c => {
  await ensureSchema(c.env);
  const id=c.req.param("id");
  const [aliases,identities]=await Promise.all([
    c.env.DB.prepare("SELECT a.*,m.model_key AS canonical_name FROM service_model_aliases a LEFT JOIN service_group_models m ON m.id=a.mapping_id AND m.service_group_id=a.service_group_id WHERE a.service_group_id=? ORDER BY a.name").bind(id).all(),
    c.env.DB.prepare("SELECT i.* FROM public_model_identities i JOIN service_group_models m ON m.model_key=i.name WHERE m.service_group_id=? ORDER BY i.name").bind(id).all(),
  ]);
  return c.json({items:aliases.results??[],identities:identities.results??[]});
});
serviceModelNamesApp.put("/:id/aliases", async c=>{
  await ensureSchema(c.env);
  const parsed=Aliases.safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return c.json({error:"validation_error"},400);
  const id=c.req.param("id"), data=parsed.data;
  const group=await c.env.DB.prepare("SELECT revision FROM service_groups WHERE id=?").bind(id).first<{revision:number}>();
  if(!group)return c.json({error:"not_found"},404);
  if(new Set(data.aliases.map(a=>a.name)).size!==data.aliases.length)return c.json({error:"duplicate_aliases"},400);
  for(const alias of data.aliases){
    const target=await c.env.DB.prepare("SELECT id FROM service_group_models WHERE id=? AND service_group_id=?").bind(alias.mapping_id,id).first();
    if(!target && alias.enabled)return c.json({error:"alias_target_missing",name:alias.name},400);
    const direct=await c.env.DB.prepare("SELECT id FROM service_group_models WHERE service_group_id=? AND model_key=?").bind(id,alias.name).first();
    if(direct)return c.json({error:"alias_name_conflict",name:alias.name},409);
    const previous=await c.env.DB.prepare("SELECT mapping_id FROM service_model_aliases WHERE service_group_id=? AND name=?").bind(id,alias.name).first<{mapping_id:string}>();
    if(previous && previous.mapping_id!==alias.mapping_id)return c.json({error:"alias_identity_conflict",name:alias.name},409);
    if(!previous && !data.allow_legacy_shadow && await c.env.DB.prepare("SELECT 1 AS found WHERE "+legacyCollision).bind(alias.name,alias.name,alias.name).first())return c.json({error:"legacy_name_conflict",name:alias.name,confirmation_required:true},409);
  }
  const guard=crypto.randomUUID();
  try{
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO public_model_write_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM service_groups WHERE id=? AND revision=?) THEN 1 ELSE 0 END").bind(guard,id,group.revision),
      ...data.aliases.map((a,n)=>c.env.DB.prepare("INSERT INTO public_model_write_guards(id,valid) SELECT ?,CASE WHEN (?=0 OR EXISTS(SELECT 1 FROM service_group_models WHERE id=? AND service_group_id=?)) AND NOT EXISTS(SELECT 1 FROM service_group_models WHERE service_group_id=? AND model_key=?) AND NOT EXISTS(SELECT 1 FROM service_model_aliases WHERE service_group_id=? AND name=? AND mapping_id!=?)"+(data.allow_legacy_shadow?"":" AND (EXISTS(SELECT 1 FROM service_model_aliases WHERE service_group_id=? AND name=?) OR NOT ("+legacyCollision+"))")+" THEN 1 ELSE 0 END").bind(guard+":"+n,a.enabled,a.mapping_id,id,id,a.name,id,a.name,a.mapping_id,...(data.allow_legacy_shadow?[]:[id,a.name,a.name,a.name,a.name]))),
      c.env.DB.prepare("UPDATE service_model_aliases SET enabled=0 WHERE service_group_id=?").bind(id),
      ...data.aliases.map(a=>c.env.DB.prepare("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES(?,?,?,?) ON CONFLICT(service_group_id,name) DO UPDATE SET enabled=excluded.enabled").bind(id,a.name,a.mapping_id,a.enabled)),
      c.env.DB.prepare("UPDATE service_groups SET revision=revision+1 WHERE id=?").bind(id),
      c.env.DB.prepare("DELETE FROM public_model_write_guards WHERE id LIKE ?").bind(guard+"%"),
    ]);
  }catch{return c.json({error:"configuration_changed",message:"配置已变化，请刷新后重试"},409);}
  await recordAuditLog(c.env,{ip:extractClientIp(c,c.env),action:"service_group.aliases",target_type:"service_group",target_id:id,summary:"更新单层兼容名",details:{count:data.aliases.length}});
  return c.json({ok:true});
});

serviceModelNamesApp.post("/:id/models/:mappingId/rename",async c=>{
  await ensureSchema(c.env);
  const parsed=Rename.safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return c.json({error:"validation_error"},400);
  const mapping=await c.env.DB.prepare("SELECT * FROM service_group_models WHERE id=? AND service_group_id=?").bind(c.req.param("mappingId"),c.req.param("id")).first<ServiceGroupModelRow>();
  if(!mapping)return c.json({error:"not_found"},404);
  const oldName=mapping.model_key,newName=parsed.data.new_name;
  if(oldName===newName)return c.json({ok:true,name:newName});
  const invalidDirect = await c.env.DB.prepare("SELECT 1 FROM service_group_models s JOIN models m ON m.id=s.target_id WHERE s.model_key=? AND s.target_type='model' AND m.model_name!=? AND COALESCE(m.alias,'')!=? LIMIT 1").bind(oldName,newName,newName).first();
  if(invalidDirect)return c.json({error:"direct_model_name_restricted",message:"直接模型公开名须保持实际名或alias；请先迁移到模型组目标"},409);
  const conflict=await c.env.DB.prepare("SELECT 1 WHERE EXISTS(SELECT 1 FROM public_model_identities WHERE name=?) OR EXISTS(SELECT 1 FROM service_group_models WHERE model_key=?) OR EXISTS(SELECT 1 FROM service_model_aliases WHERE name=?)").bind(newName,newName,newName).first();
  if(conflict)return c.json({error:"public_name_conflict"},409);
  if(!parsed.data.allow_legacy_shadow && await c.env.DB.prepare("SELECT 1 WHERE "+legacyCollision).bind(newName,newName,newName).first())return c.json({error:"legacy_name_conflict",confirmation_required:true},409);
  await ensureModelCategoriesSchema(c.env);
  const revisions=(await c.env.DB.prepare("SELECT g.id,g.revision FROM service_groups g WHERE g.id IN(SELECT service_group_id FROM service_group_models WHERE model_key=?)").bind(oldName).all<{id:string;revision:number}>()).results??[];
  const guard=crypto.randomUUID();
  try{
    await c.env.DB.batch([
      publicModelIdentityStatement(c.env,oldName),
      ...revisions.map((r,n)=>c.env.DB.prepare("INSERT INTO public_model_write_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM service_groups WHERE id=? AND revision=?) THEN 1 ELSE 0 END").bind(guard+":"+n,r.id,r.revision)),
      c.env.DB.prepare("INSERT INTO public_model_write_guards(id,valid) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM service_group_models s JOIN models m ON m.id=s.target_id WHERE s.model_key=? AND s.target_type='model' AND m.model_name!=? AND COALESCE(m.alias,'')!=?)"+(parsed.data.allow_legacy_shadow?"":" AND NOT ("+legacyCollision+")")+" THEN 1 ELSE 0 END").bind(guard+":direct",oldName,newName,newName,...(parsed.data.allow_legacy_shadow?[]:[newName,newName,newName])),
      c.env.DB.prepare("INSERT INTO public_model_write_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM service_group_models WHERE id=? AND model_key=?) AND NOT EXISTS(SELECT 1 FROM public_model_identities WHERE name=?) AND NOT EXISTS(SELECT 1 FROM service_group_models WHERE model_key=?) AND NOT EXISTS(SELECT 1 FROM service_model_aliases WHERE name=?) THEN 1 ELSE 0 END").bind(guard,mapping.id,oldName,newName,newName,newName),
      c.env.DB.prepare("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) SELECT service_group_id,model_key,id,? FROM service_group_models WHERE model_key=? ON CONFLICT(service_group_id,name) DO UPDATE SET enabled=excluded.enabled").bind(Number(parsed.data.keep_old_alias),oldName),
      ...renameModelCategoryKeyStatements(c.env,oldName,newName),
      c.env.DB.prepare("UPDATE public_model_identities SET name=? WHERE name=?").bind(newName,oldName),
      c.env.DB.prepare("UPDATE service_groups SET revision=revision+1 WHERE id IN(SELECT service_group_id FROM service_group_models WHERE model_key=?)").bind(oldName),
      c.env.DB.prepare("UPDATE service_group_models SET model_key=? WHERE model_key=?").bind(newName,oldName),
      c.env.DB.prepare("DELETE FROM public_model_write_guards WHERE id LIKE ?").bind(guard+"%"),
    ]);
  }catch{return c.json({error:"rename_conflict",message:"名称、分类或配置已变化，未执行任何改名"},409);}
  await recordAuditLog(c.env,{ip:extractClientIp(c,c.env),action:"public_model.rename",target_type:"service_group",target_id:mapping.service_group_id,summary:"全局公开调用名改名并保留稳定身份",details:{old_name:oldName,new_name:newName,keep_old_alias:parsed.data.keep_old_alias}});
  return c.json({ok:true,name:newName,old_name:oldName});
});
