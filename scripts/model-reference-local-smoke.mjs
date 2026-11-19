import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(realpathSync(fileURLToPath(new URL('../worker/node_modules/wrangler/package.json', import.meta.url))));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
const path = name => fileURLToPath(new URL('../worker/src/' + name + '.ts', import.meta.url));
async function main() {
  const contents = ['export * as schema from ' + JSON.stringify(path('db/schema')) + ';', 'export * as refs from ' + JSON.stringify(path('db/model_references')) + ';', 'export {modelsApp} from ' + JSON.stringify(path('admin/models')) + ';', 'export {modelGroupsApp} from ' + JSON.stringify(path('admin/model-groups')) + ';'].join(String.fromCharCode(10));
  const bundle = await build({stdin:{contents,loader:'ts',resolveDir:fileURLToPath(new URL('.',import.meta.url))},bundle:true,format:'esm',platform:'browser',write:false});
  const {schema,refs,modelsApp,modelGroupsApp} = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("local-only")}}',compatibilityDate:'2024-11-01',d1Databases:['DB'],d1Persist:false,telemetry:{enabled:false}}));
  try {
    const DB = await mf.getD1Database('DB'), env = {DB};
    await schema.ensureSchema(env);
    const run = (sql,...values) => DB.prepare(sql).bind(...values).run();
    const row = (sql,...values) => DB.prepare(sql).bind(...values).first();
    let cases = 0;
    const check = (name) => {cases++;console.log('PASS',name);};
    const seed = async () => {
      for (const table of ['price_windows','model_group_members','device_models','device_template_models','device_model_groups','device_template_groups','token_routing_policies','service_group_models','service_groups','model_groups','models']) await run('DELETE FROM '+table);
      await run("INSERT INTO models(id,provider_id,model_name) VALUES ('a','provider','model-a'),('b','provider','model-b')");
      await run("INSERT INTO model_groups(id,name) VALUES ('g','group')");
      await run("INSERT INTO service_groups(id,name) VALUES ('sg','Service')");
      await run("INSERT INTO price_windows(id,model_id,day_type,start_minute,end_minute) VALUES ('pa','a','workday',0,60),('pg','g','workday',0,60)");
    };
    await seed();
    let response = await modelsApp.request('https://local.test/a',{method:'DELETE'},env);
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
    assert.equal(await row("SELECT id FROM models WHERE id='a'"),null);
    assert.equal(await row("SELECT id FROM price_windows WHERE model_id='a'"),null);
    assert.equal((await modelsApp.request('https://local.test/a',{method:'DELETE'},env)).status,404);
    check('native single deletion, owned prices and missing target');
    const blockers = [
      ['service_mapping',`INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id) VALUES ('map','sg','public','model','a')`],
      ['token_model_scope',`INSERT INTO token_routing_policies(device_id,token_id,policy_json,updated_at) VALUES ('d','t','{"model_scope":["model:a"]}',1)`],
      ['token_model_override',`INSERT INTO token_routing_policies(device_id,token_id,policy_json,updated_at) VALUES ('d','t','{"model_overrides":{"model:a":"sg"}}',1)`],
      ['invalid_token_policy',`INSERT INTO token_routing_policies(device_id,token_id,policy_json,updated_at) VALUES ('d','t','[bad',1)`],
      ['service_member',`INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id,member_ids_json) VALUES ('map','sg','public','group','g','["a"]')`],
      ['invalid_service_members',`INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id,member_ids_json) VALUES ('map','sg','public','group','g','[bad')`],
      ['group_member',`INSERT INTO model_group_members(group_id,model_id) VALUES ('g','a')`],
      ['fallback',`UPDATE models SET fallback_model_id='a' WHERE id='b'`],
      ['device_model',`INSERT INTO device_models(device_id,model_id) VALUES ('d','a')`],
      ['template_model',`INSERT INTO device_template_models(template_id,model_id) VALUES ('t','a')`],
    ];
    for (const [kind,sql] of blockers) {
      await seed();await run(sql);
      response=await modelsApp.request('https://local.test/a',{method:'DELETE'},env);
      assert.equal(response.status,409,kind);
      assert.ok((await response.json()).references.some(ref=>ref.kind===kind),kind);
      assert.ok(await row("SELECT id FROM models WHERE id='a'"));assert.ok(await row("SELECT id FROM price_windows WHERE model_id='a'"));
      const batch=await refs.deleteUnreferencedTargets(env,'model',['a','b']);
      assert.equal(batch.deleted,0);assert.equal((await row('SELECT COUNT(*) n FROM models')).n,2);
      check('blocked single and entire batch: '+kind);
    }
    await seed();
    const batch=await refs.deleteUnreferencedTargets(env,'model',['a','b','a','missing']);
    assert.deepEqual(batch,{references:[],deleted:2});check('deduplicated unreferenced model batch');
    await seed();await run("INSERT INTO model_group_members(group_id,model_id) VALUES ('g','a')");
    response=await modelGroupsApp.request('https://local.test/g',{method:'DELETE'},env);
    assert.equal(response.status,200);assert.equal((await row('SELECT COUNT(*) n FROM model_group_members')).n,0);
    assert.ok(await row("SELECT id FROM models WHERE id='a'"));check('group owned members cleaned without deleting models');
    await seed();await run("INSERT INTO device_model_groups(device_id,group_id) VALUES ('d','g')");
    response=await modelGroupsApp.request('https://local.test/g',{method:'DELETE'},env);
    assert.equal(response.status,409);assert.ok((await response.json()).references.some(r=>r.kind==='device_group'));check('group second query chunk remains guarded');
    await seed();await run("CREATE TRIGGER fail_price_cleanup BEFORE DELETE ON price_windows BEGIN SELECT RAISE(ABORT,'injected_cleanup_failure'); END");
    await assert.rejects(()=>refs.deleteUnreferencedTargets(env,'model',['a']),/injected_cleanup_failure/);
    assert.ok(await row("SELECT id FROM models WHERE id='a'"));assert.ok(await row("SELECT id FROM price_windows WHERE model_id='a'"));check('cleanup failure rolls model deletion back');
    console.log('NATIVE_MODEL_REFERENCE_SMOKE='+JSON.stringify({passed:cases,failed:0,localOnly:true}));
  } finally {await mf.dispose();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
