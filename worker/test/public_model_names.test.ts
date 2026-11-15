import {afterEach,describe,expect,it} from "vitest";
import {serviceModelNamesApp} from "../src/admin/service-model-names";
import {getPublicModelIdentity,resolvePublicModelKey,resolvePublicModelKeys} from "../src/db/public_model_identity";
import {upsertServiceGroupModel} from "../src/db/service_groups";
import {ensureSchema} from "../src/db/schema";
import {ensureModelCategoriesSchema} from "../src/db/model_categories";
import {createRealD1,type RealD1} from "./helpers/realD1";
import type {Env} from "../src/types";
const dbs:RealD1[]=[];
afterEach(()=>dbs.splice(0).forEach(db=>db.close()));
async function setup(){
 const db=createRealD1();dbs.push(db);const env={DB:db.DB} as Env;await ensureSchema(env);await ensureModelCategoriesSchema(env);
 db.sql("INSERT INTO providers(id,name,type) VALUES('p','provider','openai')");
 db.sql("INSERT INTO models(id,provider_id,model_name,alias) VALUES('m','p','actual','direct-alias')");
 db.sql("INSERT INTO model_groups(id,name,created_at,updated_at) VALUES('pool','internal',1,1)");
 db.sql("INSERT INTO model_group_members(group_id,model_id,position,enabled) VALUES('pool','m',0,1)");
 for(const id of ['s1','s2']){
 db.sql("INSERT INTO service_groups(id,name,enabled,selectable,public_selectable,multiplier,revision) VALUES(?,?,1,1,1,1,1)",id,id);
 await upsertServiceGroupModel(env,id,{model_key:'public-name',target_type:'group',target_id:'pool',member_ids_json:null,pricing_json:null});
 db.sql("UPDATE service_group_models SET id=? WHERE service_group_id=?",'map-'+id,id);
 }
 return {db,env};
}
async function request(env:Env,path:string,body:unknown,method='POST'){
 return serviceModelNamesApp.request(path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)},env);
}
describe('stable public identities and group-scoped one-level aliases',()=>{
 it('renames all quotes atomically, preserving identity, prices, mapping IDs and categories',async()=>{
 const {db,env}=await setup();const id=await getPublicModelIdentity(env,'public-name');
 db.sql("INSERT INTO model_categories(id,name) VALUES('c','category')");db.sql("INSERT INTO model_category_bindings(model_name,category_id) VALUES('public-name','c')");
 const before=db.rows("SELECT id,service_group_id,target_id,pricing_json FROM service_group_models ORDER BY id");
 const res=await request(env,'/s1/models/map-s1/rename',{new_name:'new-public'});expect(res.status).toBe(200);
 expect(await getPublicModelIdentity(env,'new-public')).toBe(id);expect(await getPublicModelIdentity(env,'public-name')).toBeNull();
 expect(db.rows("SELECT id,service_group_id,target_id,pricing_json FROM service_group_models ORDER BY id")).toEqual(before);
 expect(db.rows("SELECT model_name,category_id FROM model_category_bindings")).toEqual([{model_name:'new-public',category_id:'c'}]);
 for(const group of ['s1','s2'])expect((await resolvePublicModelKey(env,group,'public-name')).mapping?.model_key).toBe('new-public');
 expect(db.rows("SELECT * FROM public_model_write_guards")).toEqual([]);
 });
 it('allows old spelling to be disabled without deleting the reservation',async()=>{
 const {db,env}=await setup();expect((await request(env,'/s1/models/map-s1/rename',{new_name:'new-public',keep_old_alias:false})).status).toBe(200);
 expect(await resolvePublicModelKey(env,'s1','public-name')).toEqual({mapping:null,reserved:true});
 expect((await resolvePublicModelKey(env,'s1','new-public')).mapping?.id).toBe('map-s1');
 expect(db.rows("SELECT enabled FROM service_model_aliases")).toEqual([{enabled:0},{enabled:0}]);
 });
 it('requires explicit confirmation to shadow legacy and does not merge legacy authorization',async()=>{
 const {db,env}=await setup();const alias={name:'actual',mapping_id:'map-s1',enabled:1};
 expect((await request(env,'/s1/aliases',{aliases:[alias]},'PUT')).status).toBe(409);
 expect(db.rows("SELECT * FROM service_model_aliases")).toEqual([]);
 expect((await request(env,'/s1/aliases',{aliases:[alias],allow_legacy_shadow:true},'PUT')).status).toBe(200);
 expect((await resolvePublicModelKey(env,'s1','actual')).mapping?.id).toBe('map-s1');
 expect(await resolvePublicModelKey(env,'s2','actual')).toEqual({mapping:null,reserved:false});
 expect(db.rows("SELECT * FROM device_models")).toEqual([]);
 });
 it('rejects alias chains, duplicate names and canonical collisions',async()=>{
 const {env}=await setup();
 expect((await request(env,'/s1/aliases',{aliases:[{name:'nested',mapping_id:'another-alias',enabled:1}]},'PUT')).status).toBe(400);
 expect((await request(env,'/s1/aliases',{aliases:[{name:'public-name',mapping_id:'map-s1',enabled:1}]},'PUT')).status).toBe(409);
 expect((await request(env,'/s1/aliases',{aliases:[{name:'old',mapping_id:'map-s1'},{name:'old',mapping_id:'map-s1'}]},'PUT')).status).toBe(400);
 });
 it('omitted aliases stay reserved and cannot be reassigned to another identity',async()=>{
 const {db,env}=await setup();
 expect((await request(env,'/s1/aliases',{aliases:[{name:'old',mapping_id:'map-s1',enabled:1}]},'PUT')).status).toBe(200);
 expect((await request(env,'/s1/aliases',{aliases:[]},'PUT')).status).toBe(200);
 expect(await resolvePublicModelKey(env,'s1','old')).toEqual({mapping:null,reserved:true});
 db.sql("INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id) VALUES('other','s1','other-key','group','pool')");
 expect((await request(env,'/s1/aliases',{aliases:[{name:'old',mapping_id:'other',enabled:1}]},'PUT')).status).toBe(409);
 });
 it('preserves dangling disabled aliases in batch results without a null left join hiding their reservation',async()=>{
 const {db,env}=await setup();db.sql("INSERT INTO service_model_aliases(service_group_id,name,mapping_id,enabled) VALUES('s1','retired','missing',0)");
 expect(await resolvePublicModelKeys(env,['s1','s2'],'retired')).toEqual([{service_group_id:'s1',mapping:null,reserved:true},{service_group_id:'s2',mapping:null,reserved:false}]);
 });
 it('disabled public identities reserve both canonical names and aliases',async()=>{
 const {db,env}=await setup();
 expect((await request(env,'/s1/aliases',{aliases:[{name:'old',mapping_id:'map-s1',enabled:1}]},'PUT')).status).toBe(200);
 db.sql("UPDATE public_model_identities SET enabled=0 WHERE name='public-name'");
 for(const key of ['public-name','old']){expect(await resolvePublicModelKey(env,'s1',key)).toEqual({mapping:null,reserved:true});expect((await resolvePublicModelKeys(env,['s1'],key))[0]).toEqual({service_group_id:'s1',mapping:null,reserved:true});}
 });
 it('rejects direct-model public renames outside the actual name or explicit model alias',async()=>{
 const {db,env}=await setup();db.sql("UPDATE service_group_models SET target_type='model',target_id='m',model_key='actual' WHERE id='map-s1'");
 expect((await request(env,'/s1/models/map-s1/rename',{new_name:'arbitrary'})).status).toBe(409);
 expect(db.row("SELECT model_key FROM service_group_models WHERE id='map-s1'")).toEqual({model_key:'actual'});
 });
 it('rolls back global rename if category target is occupied',async()=>{
 const {db,env}=await setup();db.sql("INSERT INTO model_categories(id,name) VALUES('c','category')");
 for(const name of ['public-name','occupied'])db.sql("INSERT INTO model_category_bindings(model_name,category_id) VALUES(?,'c')",name);
 const before=db.rows("SELECT * FROM service_group_models ORDER BY id");
 expect((await request(env,'/s1/models/map-s1/rename',{new_name:'occupied'})).status).toBe(409);
 expect(db.rows("SELECT * FROM service_group_models ORDER BY id")).toEqual(before);expect(db.rows("SELECT * FROM service_model_aliases")).toEqual([]);
 });
 it.each(['alias','rename'])('rechecks configuration revisions inside the %s transaction',async(kind)=>{
 const {db,env}=await setup();const batch=db.DB.batch;let armed=true;
 db.DB.batch=async(statements:any[])=>{if(armed&&statements.some(s=>s.sql.includes('INSERT INTO public_model_write_guards'))){armed=false;db.sql("UPDATE service_groups SET revision=revision+1 WHERE id='s1'");}return batch(statements);};
 const res=kind==='alias'?await request(env,'/s1/aliases',{aliases:[{name:'old',mapping_id:'map-s1',enabled:1}]},'PUT'):await request(env,'/s1/models/map-s1/rename',{new_name:'new-public'});
 expect(res.status).toBe(409);expect(db.rows("SELECT * FROM service_model_aliases")).toEqual([]);expect(db.row("SELECT model_key FROM service_group_models WHERE id='map-s1'")).toEqual({model_key:'public-name'});
 });
});
