import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { CategorySchema, ensureModelCategoriesSchema, exportModelCategories } from "../db/model_categories";

export const modelCategoriesApp = new Hono<{Bindings:Env}>();
const Fields = CategorySchema.omit({id:true});
const Create = Fields.extend({description:Fields.shape.description.default(""),sort_order:Fields.shape.sort_order.default(0),color:Fields.shape.color.default("slate"),enabled:Fields.shape.enabled.default(1)});
const Update = Fields.partial().refine(data => Object.keys(data).length > 0,"No changes supplied");
const Bindings = z.object({model_names:z.array(z.string().trim().min(1).max(200)).min(1).max(100),category_ids:z.array(CategorySchema.shape.id).max(100),operation:z.enum(["add","remove","replace"])}).strict();
modelCategoriesApp.use("*",async(c,next) => {await ensureModelCategoriesSchema(c.env);await next();});
modelCategoriesApp.get("/",async c => {
  const data = await exportModelCategories(c.env);
  const counts = new Map<string,Set<string>>();
  for(const b of data.model_category_bindings) {const set=counts.get(b.category_id)??new Set<string>();set.add(b.model_name);counts.set(b.category_id,set);}
  return c.json({items:data.model_categories.map(row=>({...row,model_count:counts.get(row.id)?.size??0})),bindings:data.model_category_bindings});
});
modelCategoriesApp.post("/",async c => {
  const parsed=Create.safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success) return c.json({error:"validation_error",message:parsed.error.issues[0]?.message},400);
  const data=parsed.data,id=crypto.randomUUID();
  if(await c.env.DB.prepare("SELECT id FROM model_categories WHERE name=?").bind(data.name).first()) return c.json({error:"category_name_conflict"},409);
  try {await c.env.DB.prepare("INSERT INTO model_categories(id,name,description,sort_order,color,enabled) VALUES(?,?,?,?,?,?)").bind(id,data.name,data.description,data.sort_order,data.color,data.enabled).run();}
  catch(error) {if(String(error).includes("UNIQUE")) return c.json({error:"category_name_conflict"},409);throw error;}
  return c.json({item:{id,...data}},201);
});
modelCategoriesApp.put("/:id",async c => {
  const parsed=Update.safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success) return c.json({error:"validation_error",message:parsed.error.issues[0]?.message},400);
  const id=c.req.param("id"),data=parsed.data;
  if(!await c.env.DB.prepare("SELECT id FROM model_categories WHERE id=?").bind(id).first()) return c.json({error:"not_found"},404);
  const keys=Object.keys(Fields.shape).filter(key=>data[key as keyof typeof data]!==undefined) as (keyof typeof data)[];
  try {await c.env.DB.prepare("UPDATE model_categories SET "+keys.map(key=>key+"=?").join(",")+" WHERE id=?").bind(...keys.map(key=>data[key]!),id).run();}
  catch(error) {if(String(error).includes("UNIQUE")) return c.json({error:"category_name_conflict"},409);throw error;}
  return c.json({item:await c.env.DB.prepare("SELECT * FROM model_categories WHERE id=?").bind(id).first()});
});
modelCategoriesApp.delete("/:id",async c => {
  const id=c.req.param("id");
  if(!await c.env.DB.prepare("SELECT id FROM model_categories WHERE id=?").bind(id).first()) return c.json({error:"not_found"},404);
  await c.env.DB.batch([c.env.DB.prepare("DELETE FROM model_category_bindings WHERE category_id=?").bind(id),c.env.DB.prepare("DELETE FROM model_categories WHERE id=?").bind(id)]);
  return c.json({ok:true});
});
modelCategoriesApp.post("/bindings",async c => {
  const parsed=Bindings.safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success) return c.json({error:"validation_error",message:parsed.error.issues[0]?.message},400);
  const {operation}=parsed.data,names=[...new Set(parsed.data.model_names)],ids=[...new Set(parsed.data.category_ids)];
  const idsJson=JSON.stringify(ids);
  const found=await c.env.DB.prepare("SELECT id FROM model_categories WHERE id IN (SELECT value FROM json_each(?))").bind(idsJson).all<{id:string}>();
  if((found.results??[]).length!==ids.length) return c.json({error:"category_not_found"},400);
  const statements:D1PreparedStatement[]=[];
  for(const name of names) {
    if(operation==="replace") statements.push(c.env.DB.prepare("DELETE FROM model_category_bindings WHERE model_name=?").bind(name));
    if(operation==="remove") statements.push(c.env.DB.prepare("DELETE FROM model_category_bindings WHERE model_name=? AND category_id IN (SELECT value FROM json_each(?))").bind(name,idsJson));
    else if(ids.length) statements.push(c.env.DB.prepare("INSERT OR IGNORE INTO model_category_bindings(model_name,category_id) SELECT ?,value FROM json_each(?)").bind(name,idsJson));
  }
  if(statements.length) await c.env.DB.batch(statements);
  return c.json({ok:true,model_count:names.length});
});
