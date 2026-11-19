import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { VideoReadLifecycle } from "../src/gateway/video_read_lifecycle";
import { openReferenceBody, reserveReferenceRead } from "../src/gateway/video_reference_stream";

const nodeRequire = createRequire(import.meta.url);
const { execFileSync } = nodeRequire("node:child_process") as { execFileSync: (file: string, args: string[], options: object) => string };
const nodeProcess = nodeRequire("node:process") as { execPath: string; env: Record<string,string|undefined> };

const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
function setup(signal = new AbortController().signal) {
  const release=vi.fn();
  const lifetime=new VideoReadLifecycle({signal,release,error:"interrupted",totalMs:1000,idleMs:100});
  return {lifetime,release};
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

describe("disposable read lifecycle",()=>{
  it.each(["cancel-first","read-first"])("allows one pending read and retains both physical operations: %s",async order=>{
    vi.useFakeTimers();const {lifetime,release}=setup();
    let complete!:(part:ReadableStreamReadResult<Uint8Array>)=>void, ack!:()=>void;
    const reader={read:vi.fn(()=>new Promise<ReadableStreamReadResult<Uint8Array>>(resolve=>{complete=resolve;})),
      cancel:vi.fn(()=>new Promise<void>(resolve=>{ack=resolve;})),releaseLock:vi.fn()};
    const body={getReader:()=>reader} as unknown as ReadableStream<Uint8Array>;
    await lifetime.open(async()=>body,value=>value);
    const pending=lifetime.read();const failure=expect(pending).rejects.toThrow("interrupted");
    await expect(lifetime.read()).rejects.toThrow("video_read_already_pending");expect(reader.read).toHaveBeenCalledTimes(1);
    lifetime.stop();lifetime.stop();await failure;
    expect(vi.getTimerCount()).toBe(0);expect(reader.cancel).toHaveBeenCalledTimes(1);expect(release).not.toHaveBeenCalled();
    const lateRead=()=>complete({done:false,value:new Uint8Array(64)});
    if(order==="cancel-first")ack();else lateRead();
    await flush();expect(release).not.toHaveBeenCalled();expect(reader.releaseLock).not.toHaveBeenCalled();
    if(order==="cancel-first")lateRead();else ack();await flush();
    expect(release).toHaveBeenCalledTimes(1);expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });
  it.each(["success","failure"])("keeps stalled load capacity through late %s and cancellation",async outcome=>{
    vi.useFakeTimers();const {lifetime,release}=setup();let resolve!:(body:ReadableStream<Uint8Array>)=>void,reject!:(e:Error)=>void,ack!:()=>void;
    const pending=lifetime.open(()=>new Promise<ReadableStream<Uint8Array>>((yes,no)=>{resolve=yes;reject=no;}),value=>value);
    const failure=expect(pending).rejects.toThrow("interrupted");await vi.advanceTimersByTimeAsync(101);await failure;
    expect(release).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    if(outcome==="failure")reject(new Error("late"));
    else {resolve(new ReadableStream({cancel(){return new Promise<void>(yes=>{ack=yes;});}},{highWaterMark:0}));await flush();expect(release).not.toHaveBeenCalled();ack();}
    await flush();expect(release).toHaveBeenCalledTimes(1);
  });
  it("does not start I/O when already aborted and removes its listener",async()=>{
    vi.useFakeTimers();const abort=new AbortController();abort.abort();const remove=vi.spyOn(abort.signal,"removeEventListener");
    const {lifetime,release}=setup(abort.signal),load=vi.fn();
    await expect(lifetime.open(load,()=>null)).rejects.toThrow("interrupted");
    expect(load).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);expect(remove).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });
  it("disposes listeners/timers at EOF without cancelling a completed reader",async()=>{
    vi.useFakeTimers();const abort=new AbortController(),remove=vi.spyOn(abort.signal,"removeEventListener");const {lifetime,release}=setup(abort.signal);
    const cancel=vi.fn(),body=new ReadableStream<Uint8Array>({start(c){c.close();},cancel});
    await lifetime.open(async()=>body,value=>value);expect((await lifetime.read()).done).toBe(true);lifetime.finish();lifetime.finish();abort.abort();
    expect(cancel).not.toHaveBeenCalled();expect(body.locked).toBe(false);expect(release).toHaveBeenCalledTimes(1);expect(remove).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps sixteen actual get slots occupied after frontend timeout until I/O settles",async()=>{
    vi.useFakeTimers();const pending:Promise<unknown>[]=[],finish:((value:null)=>void)[]=[];
    for(let i=0;i<16;i++) {
      const release=reserveReferenceRead("stalled-"+Math.floor(i/4))!;expect(release).toBeTypeOf("function");
      pending.push(openReferenceBody(()=>new Promise(resolve=>{finish.push(resolve);}),64,new AbortController().signal,release).catch(error=>error));
    }
    await vi.advanceTimersByTimeAsync(15001);expect((await Promise.all(pending)).every(value=>value instanceof Error)).toBe(true);
    expect(reserveReferenceRead("replacement")).toBeNull();
    for(const done of finish)done(null);await flush();const release=reserveReferenceRead("replacement");expect(release).not.toBeNull();release!();expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps sixteen actual cancel slots occupied after consumer cancellation",async()=>{
    const ack:(()=>void)[]=[];
    for(let i=0;i<16;i++){
      const release=reserveReferenceRead("cancel-"+Math.floor(i/4))!;expect(release).toBeTypeOf("function");
      const body=new ReadableStream<Uint8Array>({cancel(){return new Promise<void>(yes=>{ack.push(yes);});}},{highWaterMark:0});
      const stream=await openReferenceBody(async()=>({body,size:64}),64,new AbortController().signal,release);await stream.cancel();
    }
    expect(reserveReferenceRead("replacement")).toBeNull();for(const done of ack)done();await flush();
    const release=reserveReferenceRead("replacement");expect(release).not.toBeNull();release!();
  });
  it("never enqueues a late read after client abort and retains its cancel reservation",async()=>{
    const abort=new AbortController(),release=vi.fn();let complete!:(part:ReadableStreamReadResult<Uint8Array>)=>void,ack!:()=>void;
    const raw={read:vi.fn(()=>new Promise<ReadableStreamReadResult<Uint8Array>>(yes=>{complete=yes;})),cancel:vi.fn(()=>new Promise<void>(yes=>{ack=yes;})),releaseLock:vi.fn()};
    const body={getReader:()=>raw} as unknown as ReadableStream<Uint8Array>;
    const stream=await openReferenceBody(async()=>({body,size:64}),64,abort.signal,release),reader=stream.getReader();
    const pending=reader.read(),failure=expect(pending).rejects.toThrow("reference_content_interrupted");abort.abort();await failure;
    complete({done:false,value:new Uint8Array(64)});await flush();expect(release).not.toHaveBeenCalled();
    await expect(reader.read()).rejects.toThrow("reference_content_interrupted");expect(raw.read).toHaveBeenCalledTimes(1);
    ack();await flush();expect(release).toHaveBeenCalledTimes(1);
  });
  it("enforces reference total deadline despite slow continuing progress without prefetch",async()=>{
    vi.useFakeTimers();let produced=0;const release=vi.fn(),cancel=vi.fn();
    const body=new ReadableStream<Uint8Array>({pull(c){produced++;c.enqueue(new Uint8Array(64));},cancel},{highWaterMark:0});
    const stream=await openReferenceBody(async()=>({body,size:1024}),1024,new AbortController().signal,release),reader=stream.getReader();
    expect(produced).toBe(0);for(let i=0;i<4;i++){await vi.advanceTimersByTimeAsync(14000);await reader.read();expect(produced).toBe(i+1);}
    await vi.advanceTimersByTimeAsync(4001);await expect(reader.read()).rejects.toThrow("reference_content_interrupted");
    expect(cancel).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });
});

it.skipIf(nodeProcess.env.VIDEO_READ_MEMORY!=="1")("bounds live GC retention slope with a leaking legacy control",()=>{
  const result=execFileSync(nodeProcess.execPath,["--expose-gc","--input-type=module","-e",memoryBenchmark],{cwd:nodeRequire("node:url").fileURLToPath(new URL("../..",import.meta.url)),encoding:"utf8",timeout:120000,maxBuffer:2*1024*1024});
  const rows=JSON.parse(result) as {kind:string;totalMiB:number;count:number;arrayBufferSlope:number;maxArrayBufferDelta:number;maxHeapDelta:number;maxExternalDelta:number;samples:unknown[]}[];
  console.log(JSON.stringify(rows.map(({samples,...summary})=>({...summary,sampleCount:samples.length}))));
  for(const row of rows.filter(row=>row.kind!=="legacy-control")){
    expect(row.arrayBufferSlope).toBeLessThan(0.05);expect(row.maxArrayBufferDelta).toBeLessThan(4*1024*1024);
  }
  expect(rows.find(row=>row.kind==="legacy-control")!.arrayBufferSlope).toBeGreaterThan(0.8);
},120000);
const memoryBenchmark = String.raw`import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require=createRequire(resolve('worker/package.json'));
const viteRequire=createRequire(createRequire(require.resolve('vitest/package.json')).resolve('vite/package.json'));
const {build}=viteRequire('esbuild');
const imports="export {openReferenceBody} from './src/gateway/video_reference_stream.ts';export {videoContentHandler,resetVideoContentLimits} from './src/gateway/video_content.ts';export {createRealD1} from './test/helpers/realD1.ts';export {sealSecret,sha256Hex} from './src/utils/crypto.ts';export {Hono} from 'hono';";
const bundle=await build({stdin:{contents:imports,resolveDir:resolve('worker'),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',define:{'import.meta.url':JSON.stringify(pathToFileURL(resolve('worker/test/helpers/realD1.ts')).href)}});
const {openReferenceBody,videoContentHandler,resetVideoContentLimits,createRealD1,sealSecret,sha256Hex,Hono}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const db=createRealD1(),env={DB:db.DB,ENCRYPTION_KEY:'memory-test'};
db.sql('INSERT INTO devices (id,name,token_hash,enabled,created_at) VALUES (?,?,?,1,1)','dev_1','dev_1',await sha256Hex('master'));
const route={endpoint:'https://legacy-video.test/v1/video/generations',credential:await sealSecret('key',env.ENCRYPTION_KEY),video:{adapter:'generic'}};
db.sql("INSERT INTO video_tasks (id,device_id,idempotency_key,request_hash,status,upstream_task_id,route_json,price_usd,pricing_snapshot_json,result_url,created_at,updated_at) VALUES ('vid_1','dev_1','key','hash','succeeded','task_safe',?,1,'{}','https://example.test/video',1,1)",JSON.stringify(route));
const app=new Hono();app.get('/v1/video/generations/:id/content',videoContentHandler);
const MiB=1024*1024,chunk=65536,rows=[];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function sample(){for(let i=0;i<3;i++){await tick();globalThis.gc();}return process.memoryUsage();}
function source(total){let produced=0;return new ReadableStream({pull(c){if(produced===total){c.close();return;}const value=new Uint8Array(Math.min(chunk,total-produced));if(!produced)value.set([0,0,0,24,102,116,121,112,105,115,111,109]);produced+=value.length;c.enqueue(value);}},{highWaterMark:0});}
async function run(kind,total,count=1){
  resetVideoContentLimits();const readers=[],stops=[];let stopLegacy;
  const sharedStop=new Promise((_,reject)=>{stopLegacy=reject;});sharedStop.catch(()=>{});
  const baseline=await sample();
  for(let i=0;i<count;i++){
    const body=source(total);let stream;
    if(kind==='video') {globalThis.fetch=async()=>new Response(body,{headers:{'content-type':'video/mp4','content-length':String(total)}});const response=await app.request('https://gw.test/v1/video/generations/vid_1/content',{headers:{authorization:'Bearer master'}},env);if(response.status!==200)throw new Error('unexpected '+response.status);stream=response.body;}
    else if(kind==='reference')stream=await openReferenceBody(async()=>({body,size:total}),total,new AbortController().signal,()=>{});
    else {const reader=body.getReader();stops.push(()=>reader.cancel());stream=new ReadableStream({async pull(c){const part=await Promise.race([reader.read(),sharedStop]);if(part.done)c.close();else c.enqueue(part.value);}},{highWaterMark:0});}
    readers.push(stream.getReader());
  }
  const samples=[];let transferred=0;
  for(let offset=0;offset<total;offset+=chunk){for(const reader of readers){const part=await reader.read();if(part.done)throw new Error('early EOF');transferred+=part.value.length;}if((offset+chunk)%MiB===0||offset+chunk===total){const usage=await sample();samples.push({transferred,heapUsed:usage.heapUsed-baseline.heapUsed,external:usage.external-baseline.external,arrayBuffers:usage.arrayBuffers-baseline.arrayBuffers});}}
  const xs=samples.map(s=>s.transferred),ys=samples.map(s=>s.arrayBuffers),mean=a=>a.reduce((x,y)=>x+y,0)/a.length,mx=mean(xs),my=mean(ys);
  const slope=xs.reduce((sum,x,i)=>sum+(x-mx)*(ys[i]-my),0)/xs.reduce((sum,x)=>sum+(x-mx)**2,0);
  rows.push({kind,totalMiB:total/MiB,count,arrayBufferSlope:slope,maxArrayBufferDelta:Math.max(...ys),maxHeapDelta:Math.max(...samples.map(s=>s.heapUsed)),maxExternalDelta:Math.max(...samples.map(s=>s.external)),samples});
  for(const reader of readers)await reader.cancel();for(const stop of stops)await stop();if(kind==='legacy-control')stopLegacy(new Error('done'));await tick();
}
await run('legacy-control',32*MiB);
for(const size of [10,32,100,256])await run('video',size*MiB);
await run('reference',5*MiB);await run('reference',5*MiB,16);
db.close();console.log(JSON.stringify(rows));`;
