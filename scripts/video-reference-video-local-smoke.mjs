import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {mp4} from '../../video-reference-worker/test/video-fixture.mjs';
const require=createRequire(realpathSync(fileURLToPath(new URL('../worker/node_modules/wrangler/package.json',import.meta.url))));
const {build}=require('esbuild');const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const helper=fileURLToPath(new URL('../worker/src/gateway/video_reference_video_service.ts',import.meta.url));
const source=
 'import {uploadServiceReferenceVideo,getReferenceVideoLimits,validateServiceVideoIds,bindServiceVideoIds} from '+JSON.stringify(helper)+';'+
 'export default {async fetch(req,env){const u=new URL(req.url),headers=new Headers(),ctx={env,req:{raw:req,header:k=>req.headers.get(k)},header:(k,v)=>headers.set(k,v),json:(v,status=200)=>new Response(JSON.stringify(v),{status,headers})};'+
 'try {if(u.pathname==="/upload")return await uploadServiceReferenceVideo(ctx);if(u.pathname==="/limits")return await getReferenceVideoLimits(ctx);const device={id:"synthetic-account",auth_via:u.searchParams.has("sub")?"sub":"master",sub_token_id:u.searchParams.has("sub")?"other-sub":null},id=u.searchParams.get("id");'+
 'if(u.pathname==="/validate"){await validateServiceVideoIds(env,device,[id]);return Response.json({ok:true});}if(u.pathname==="/bind")return Response.json({urls:await bindServiceVideoIds(env,device,[id],"vid_00000000-0000-4000-8000-000000000001")});return new Response(null,{status:404});}catch(e){return Response.json({error:e.message},{status:e.status||500});}}};';
const bridge=await build({stdin:{contents:source,loader:'ts',resolveDir:fileURLToPath(new URL('.',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'synthetic-auth-only',setup(b){b.onLoad({filter:/auth[.]ts$/},()=>({contents:'export async function authenticateGateway(){return {id:"synthetic-account",auth_via:"master",sub_token_id:null}}',loader:'ts'}));}}]});
const worker=await build({entryPoints:[fileURLToPath(new URL('../../video-reference-worker/src/index.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:workers']});
const options={workers:[{name:'bridge',modules:true,compatibilityDate:'2024-11-01',script:bridge.outputFiles[0].text,serviceBindings:{VIDEO_REFERENCE_IMAGES:{name:'media',entrypoint:'ReferenceImageService'}},bindings:{VIDEO_REFERENCE_IMAGE_ORIGIN:'https://images.example'}},{name:'media',modules:true,compatibilityDate:'2026-07-01',script:worker.outputFiles[0].text,durableObjects:{GATE:{className:'ImageGate',useSQLite:true}},r2Buckets:['IMAGES'],bindings:{SIGNING_KEY:'synthetic-key',LEGACY_STORAGE_BYTES:'0',PUBLIC_IMAGE_ORIGIN:'https://images.example',REFERENCE_VIDEO_FORMATS:'["video/mp4"]',REFERENCE_VIDEO_MAX_BYTES:'104857600',REFERENCE_VIDEO_MAX_DURATION_MS:'10000'}}]};
const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);
try {
 const parent=await mf.getWorker('bridge'),media=await mf.getWorker('media');
 const policy=await parent.fetch('https://cpg.test/limits');assert.equal(policy.status,200);assert.equal((await policy.json()).item.enabled,true);
 const bytes=mp4({version:1,mdatFirst:true,payload:256*1024});
 const upload=await parent.fetch('https://cpg.test/upload',{method:'POST',headers:{'content-type':'video/mp4','content-length':String(bytes.length)},body:bytes});assert.equal(upload.status,201,await upload.clone().text());const asset=await upload.json();assert.equal(asset.bytes,bytes.length);assert.equal(asset.duration_ms,2500);assert.equal(asset.url,undefined);
 assert.equal((await parent.fetch('https://cpg.test/validate?id='+asset.id)).status,200);assert.equal((await parent.fetch('https://cpg.test/validate?id='+asset.id+'&sub=1')).status,404);
 const bound=await parent.fetch('https://cpg.test/bind?id='+asset.id);assert.equal(bound.status,200,await bound.clone().text());const {urls}=await bound.json();assert.equal(new URL(urls[0]).pathname,'/video-assets/'+asset.id);const content=await media.fetch(urls[0]);assert.equal(content.status,200);assert.deepEqual(Buffer.from(await content.arrayBuffer()),bytes);
 for(const bad of [mp4({trackTicks:3600000}),mp4({mediaTicks:3600000}),mp4({sampleTicks:3600000})]){const denied=await parent.fetch('https://cpg.test/upload',{method:'POST',headers:{'content-type':'video/mp4','content-length':String(bad.length)},body:bad});assert.ok([413,415].includes(denied.status),await denied.text());}
 console.log('PASS native actual CPG video upload/helper -> named Worker -> DO/R2: backpressured body/known length, metadata-only response, principal validate/cross-sub404, task-bound video URL/exact bytes, conflicting track/media/sample duration rejected. Authentication resolution synthetic in this smoke; real auth and financial semantics covered by Vitest.');
}finally{await mf.dispose();}
