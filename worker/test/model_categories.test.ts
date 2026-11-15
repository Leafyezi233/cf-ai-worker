import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { modelCategoriesApp } from "../src/admin/model-categories";
import { adminApp } from "../src/admin";
import { attachModelCategories,ensureModelCategoriesSchema,exportModelCategories,renameModelCategoryKeyStatements,restoreModelCategoriesStatements,validateModelCategoriesBackup,type CategoryRow } from "../src/db/model_categories";
import type { Env } from "../src/types";
import { createRealD1,type RealD1 } from "./helpers/realD1";
let db:RealD1,env:Env;
beforeEach(async()=>{db=createRealD1({init:[],alters:[]});env={DB:db.DB} as Env;await ensureModelCategoriesSchema(env);});
afterEach(()=>db.close());
const cat=(id:string,extra:Partial<CategoryRow>={}):CategoryRow=>({id,name:id,description:"",sort_order:0,color:"blue",enabled:1,...extra});
async function seed(){await env.DB.batch(restoreModelCategoriesStatements(env,{model_categories:[cat("code"),cat("hidden"),cat("off",{enabled:0})],model_category_bindings:[{model_name:"shared",category_id:"code"},{model_name:"secret-model",category_id:"hidden"},{model_name:"shared",category_id:"off"}]}));}
function request(path:string,method="GET",body?:unknown){return modelCategoriesApp.request("http://test"+path,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)},env);}
describe("model categories real SQLite",()=>{
 it("schema is isolated, idempotent and per database",async()=>{await ensureModelCategoriesSchema(env);const second=createRealD1({init:[],alters:[]});try{await ensureModelCategoriesSchema({DB:second.DB} as Env);expect(second.rows("SELECT name FROM sqlite_master WHERE name='model_categories'")).toHaveLength(1);}finally{second.close();}expect(db.row("SELECT name FROM sqlite_master WHERE name='models'")).toBeNull();});
 it("creates, edits, orders, counts distinct public names, disables and deletes only metadata",async()=>{
 const a=await request("/","POST",{name:"Programming",color:"green"});expect(a.status).toBe(201);const {item}=await a.json() as any;
 expect((await request("/","POST",{name:"Programming"})).status).toBe(409);
 expect((await request("/"+item.id,"PUT",{sort_order:-2,description:"safe",enabled:0})).status).toBe(200);
 expect((await request("/bindings","POST",{model_names:["same","same","other"],category_ids:[item.id,item.id],operation:"add"})).status).toBe(200);
 const data=await (await request("/")).json() as any;expect(data.items).toMatchObject([{name:"Programming",model_count:2,enabled:0}]);expect(data.bindings).toHaveLength(2);
 db.sql("CREATE TABLE prices(name TEXT,price REAL)");db.sql("INSERT INTO prices VALUES('same',0.7)");
 expect((await request("/"+item.id,"DELETE")).status).toBe(200);expect(db.rows("SELECT * FROM model_category_bindings")).toEqual([]);expect(db.rows("SELECT * FROM prices")).toMatchObject([{price:0.7}]);
 });
 it("batch add remove replace handles empty clearing and rejects unknown categories without damage",async()=>{
 await seed();expect((await request("/bindings","POST",{model_names:["shared"],category_ids:["hidden"],operation:"add"})).status).toBe(200);
 expect((await request("/bindings","POST",{model_names:["shared"],category_ids:["off"],operation:"remove"})).status).toBe(200);
 expect(db.rows("SELECT category_id FROM model_category_bindings WHERE model_name='shared' ORDER BY category_id")).toEqual([{category_id:"code"},{category_id:"hidden"}]);
 expect((await request("/bindings","POST",{model_names:["shared"],category_ids:["missing"],operation:"replace"})).status).toBe(400);expect(db.rows("SELECT * FROM model_category_bindings WHERE model_name='shared'")).toHaveLength(2);
 await request("/bindings","POST",{model_names:["shared"],category_ids:[],operation:"replace"});expect(db.rows("SELECT * FROM model_category_bindings WHERE model_name='shared'")).toEqual([]);
 });
 it("validates malformed requests, preset colors, strict fields and limits",async()=>{
 for(const body of [{name:""},{name:"x",color:"url(javascript:x)"},{name:"x",enabled:2},{name:"x",model_type:"embedding"}]) expect((await request("/","POST",body)).status).toBe(400);
 expect((await request("/bindings","POST",{model_names:[],category_ids:[],operation:"replace"})).status).toBe(400);
 const res=await modelCategoriesApp.request("http://test/",{method:"POST",body:"{"},env);expect(res.status).toBe(400);
 });
 it("admin mount is behind authentication",async()=>{const authDb=createRealD1();try {const res=await adminApp.request("http://test/model-categories",{}, {DB:authDb.DB,ADMIN_PASSWORD:"test-password",SESSION_SECRET:"test-secret"} as unknown as Env);expect([401,403]).toContain(res.status);}finally{authDb.close();}});
 it("attaches only enabled categories of authorized names, keeps quotes and avoids N+1",async()=>{
 await seed();const spy=vi.spyOn(env.DB,"prepare");const items=await attachModelCategories(env,[{model_name:"shared",price:9},{model_name:"shared",price:1},{model_name:"uncategorized",price:3}]);
 expect(items.map(x=>x.price)).toEqual([9,1,3]);expect(items.map(x=>x.categories.map(c=>c.id))).toEqual([["code"],["code"],[]]);expect(JSON.stringify(items)).not.toContain("secret-model");expect(JSON.stringify(items)).not.toContain("hidden");expect(spy).toHaveBeenCalledTimes(1);spy.mockRestore();
 });
 it("backup round trips and absent old fields never clear existing data",async()=>{
 await seed();const backup=await exportModelCategories(env);expect(validateModelCategoriesBackup({other:1})).toBeUndefined();expect(restoreModelCategoriesStatements(env,{other:1})).toEqual([]);
 expect(()=>validateModelCategoriesBackup({model_categories:[]})).toThrow("incomplete_model_categories_backup");expect(()=>validateModelCategoriesBackup({model_category_bindings:[]})).toThrow("incomplete_model_categories_backup");
 await env.DB.batch(restoreModelCategoriesStatements(env,{model_categories:[],model_category_bindings:[]}));expect((await exportModelCategories(env)).model_categories).toEqual([]);
 await env.DB.batch(restoreModelCategoriesStatements(env,backup));expect(await exportModelCategories(env)).toEqual(backup);
 for(const invalid of [{model_categories:[cat("x"),cat("x")],model_category_bindings:[]},{model_categories:[],model_category_bindings:[{model_name:"x",category_id:"orphan"}]},{...backup,model_category_bindings:[...backup.model_category_bindings,backup.model_category_bindings[0]]}]) expect(()=>validateModelCategoriesBackup(invalid)).toThrow();
 });
 it("merge preserves unrelated rows and name conflicts roll back entire caller batch",async()=>{
 await seed();await env.DB.batch(restoreModelCategoriesStatements(env,{model_categories:[cat("new")],model_category_bindings:[]},"merge"));expect((await exportModelCategories(env)).model_categories).toHaveLength(4);
 await expect(env.DB.batch(restoreModelCategoriesStatements(env,{model_categories:[cat("new",{description:"changed"}),cat("collision",{name:"code"})],model_category_bindings:[]},"merge"))).rejects.toThrow();expect(db.row("SELECT description FROM model_categories WHERE id='new'")).toEqual({description:""});
 });
 it("rename is synchronous, moves old bindings, rejects occupied target atomically, old-empty no-op",async()=>{
 await seed();db.sql("CREATE TABLE identities(name TEXT)");db.sql("INSERT INTO identities VALUES('shared')");
 const stmts=renameModelCategoryKeyStatements(env,"shared","new");expect(Array.isArray(stmts)).toBe(true);await env.DB.batch([db.DB.prepare("UPDATE identities SET name='new'"),...stmts]);expect(db.rows("SELECT * FROM model_category_bindings WHERE model_name='new'")).toHaveLength(2);
 await expect(env.DB.batch([db.DB.prepare("UPDATE identities SET name='secret-model'"),...renameModelCategoryKeyStatements(env,"new","secret-model")])).rejects.toThrow(/CHECK/);expect(db.row("SELECT name FROM identities")).toEqual({name:"new"});expect(db.rows("SELECT * FROM model_category_bindings WHERE model_name='new'")).toHaveLength(2);
 await env.DB.batch(renameModelCategoryKeyStatements(env,"empty","secret-model"));expect(db.rows("SELECT * FROM model_category_bindings WHERE model_name='secret-model'")).toHaveLength(1);expect(renameModelCategoryKeyStatements(env,"new","new")).toEqual([]);
 });
});
