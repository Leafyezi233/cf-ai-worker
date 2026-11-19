import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require=createRequire(realpathSync(fileURLToPath(new URL('../worker/node_modules/wrangler/package.json',import.meta.url))));
const {build}=require('esbuild');const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const helper=fileURLToPath(new URL('../worker/src/gateway/video_reference_service.ts',import.meta.url));
const image=fileURLToPath(new URL('../../video-reference-worker/src/index.mjs',import.meta.url));
const bridge=await build({stdin:{contents:
  'import {referenceServiceOwner,validateServiceImageIds,bindServiceImageIds} from '+JSON.stringify(helper)+';'+
  'const device={id:"synthetic-account",auth_via:"master",sub_token_id:null};'+
  'export default {async fetch(req,env){const u=new URL(req.url);if(u.pathname==="/upload"){return env.VIDEO_REFERENCE_IMAGES.fetch(new Request("https://reference-images.internal/v1/assets",{method:"POST",headers:{"content-type":"image/png","content-length":req.headers.get("content-length"),"x-cpg-owner":referenceServiceOwner(device),"x-cpg-account":"synthetic-account"},body:req.body}));}'+
  'const id=u.searchParams.get("id");const d=u.searchParams.has("sub")?{...device,auth_via:"sub",sub_token_id:"synthetic-sub"}:device;'+
  'try {if(u.pathname==="/validate"){await validateServiceImageIds(env,d,[id]);return Response.json({ok:true});}'+
  'if(u.pathname==="/bind"){const urls=await bindServiceImageIds(env,d,[id],"vid_00000000-0000-4000-8000-000000000001");return Response.json({urls});}return new Response("not found",{status:404});}catch(e){return Response.json({error:e.message},{status:e.status||500});}}};',
  loader:'ts',resolveDir:fileURLToPath(new URL('.',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'});
const worker=await build({entryPoints:[image],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:workers']});
const options={workers:[
 {name:'bridge',modules:true,compatibilityDate:'2024-11-01',script:bridge.outputFiles[0].text,serviceBindings:{VIDEO_REFERENCE_IMAGES:{name:'images',entrypoint:'ReferenceImageService'}},bindings:{VIDEO_REFERENCE_IMAGE_ORIGIN:'https://images.example'}},
 {name:'images',modules:true,compatibilityDate:'2026-07-01',script:worker.outputFiles[0].text,durableObjects:{GATE:{className:'ImageGate',useSQLite:true}},r2Buckets:['IMAGES'],bindings:{SIGNING_KEY:'synthetic-key',UPLOAD_KEY:'synthetic-admin',LEGACY_STORAGE_BYTES:'0',PUBLIC_IMAGE_ORIGIN:'https://images.example'}}
]};
const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);
try{
 const parent=await mf.getWorker('bridge'),media=await mf.getWorker('images');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64');
 const up=await parent.fetch('https://bridge.test/upload',{method:'POST',headers:{'content-length':String(png.length)},body:png});assert.equal(up.status,201,await up.clone().text());const asset=await up.json();assert.equal(asset.url,undefined);
 const valid=await parent.fetch('https://bridge.test/validate?id='+asset.id);assert.equal(valid.status,200,await valid.clone().text());
 const wrong=await parent.fetch('https://bridge.test/validate?id='+asset.id+'&sub=1');assert.equal(wrong.status,404);
 const bind=await parent.fetch('https://bridge.test/bind?id='+asset.id);assert.equal(bind.status,200,await bind.clone().text());const {urls}=await bind.json();assert.equal(new URL(urls[0]).pathname,'/assets/'+asset.id);
 const rendered=await media.fetch(urls[0]);assert.equal(rendered.status,200,await rendered.clone().text());assert.deepEqual(Buffer.from(await rendered.arrayBuffer()),png);
 for(const host of ['reference-images.internal','images.example']){const spoof=await media.fetch('https://'+host+'/v1/assets',{method:'POST',body:png});assert.equal(spoof.status,404);}
 console.log('PASS native actual CPG bridge -> named image Worker -> DO/R2: metadata-only upload, exact principal validate, cross-sub404, signed /assets binding and bytes, public internal spoof404.');
}finally{await mf.dispose();}
