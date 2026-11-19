import { createRequire } from "node:module";
import { describe,it,expect,vi } from "vitest";

import { videoSettingsDiagnostics } from "../../web/src/utils/videoSettings";
const noticePath="../../web/src/components/VideoPricingModeNotice.tsx";
const {VideoPricingModeNotice}=await import(noticePath);
import { parseSecureVideoConfig } from "../src/gateway/secure_skill_video_config";
import { parseDoubaoVideoConfig } from "../src/gateway/doubao_video_config";
import { parseDoubaoVideoRequest,normalizeDoubaoRequest } from "../src/gateway/doubao_video_request";
import { readDoubaoVideoPoll } from "../src/gateway/doubao_video";
const componentPath="../../web/src/pages/ModelsPage.tsx";
const {SecureVideoConfigControls,DoubaoVideoConfigControls}=await import(componentPath);
const requireWeb=createRequire(new URL("../../web/package.json",import.meta.url));
const {createElement,Fragment}=requireWeb("react"),{renderToStaticMarkup}=requireWeb("react-dom/server");
const process=createRequire(new URL("../package.json",import.meta.url))("node:process") as {version:string;env:Record<string,string|undefined>;cpuUsage(start?:{user:number;system:number}):{user:number;system:number}};
const cpu=()=>process.cpuUsage();
const percentile=(v:number[],p:number)=>[...v].sort((a,b)=>a-b)[Math.floor((v.length-1)*p)];
let sink=0;
function bench(name:string,n:number,work:()=>unknown){
 for(let i=0;i<Math.min(n,200);i++)work();
 const pilot=performance.now();for(let i=0;i<n;i++)work();const pilotMs=performance.now()-pilot;
 n=Math.max(n,Math.min(2000000,Math.ceil(n*200/Math.max(pilotMs,.01))));
 const samples=[];
 for(let b=0;b<7;b++){const start=cpu(),wall=performance.now();for(let i=0;i<n;i++)work();const elapsed=performance.now()-wall,diff=process.cpuUsage(start);samples.push({cpu_ms:(diff.user+diff.system)/1000/n,wall_ms:elapsed/n});}
 return {name,iterations_per_batch:n,batches:7,cpu_p50_ms:percentile(samples.map(s=>s.cpu_ms),.5),wall_p50_ms:percentile(samples.map(s=>s.wall_ms),.5),wall_p95_ms:percentile(samples.map(s=>s.wall_ms),.95),samples};
}
function draft(adapter:string,count:number){
 const resolutions=adapter==="doubao"?["480p","720p","1080p","4K"].slice(0,Math.ceil(count/2)):Array.from({length:Math.ceil(count/2)},(_,i)=>String(720+i)+"p");
 const result:any = {model_type:"video",video:{adapter,upstream_model:"doubao-seedance-2-5-260628",ratios:["16:9"],resolutions,default_resolution:resolutions[0],default_ratio:"16:9",default_duration:4,seconds_min:4,seconds_max:adapter==="doubao"?30:15,min_images:0,max_images:30,max_videos:10,max_audios:10,max_total_refs:50,support_first_last:true,support_video_urls:true,support_audio_urls:true,support_audio_only:true,max_audio_only:10,use_asset_library:false,poll_interval_ms:15000,quotes:Array.from({length:count},(_,i)=>({resolution:resolutions[Math.floor(i/2)],has_reference_video:i%2===1,unit:"second",price:.1}))}};
 if(adapter!=="doubao"){for(const key of ["upstream_model","default_ratio","default_duration","max_total_refs","use_asset_library"])delete result.video[key];Object.assign(result.video,{max_images:9,max_videos:3,max_audios:3,max_audio_only:3});}
 return result;
}
describe.skipIf(process.env.CPG_VIDEO_PERF !== "1")("local video settings and parser performance (not browser or Workers CPU)",()=>{
 it("measures CPU/wall samples separately from structural instrumentation",()=>{
  const reports:any[]=[];
  for(const [adapter,count] of [["doubao",2],["doubao",8],["secure_skill",2],["secure_skill",40]] as const){
   const value=draft(adapter,count),raw=JSON.stringify(value),component=adapter==="doubao"?DoubaoVideoConfigControls:SecureVideoConfigControls;
   const onChange=vi.fn(),onError=vi.fn();
   const render=()=>renderToStaticMarkup(createElement(Fragment,null,createElement(component,{configJson:raw,onChange,onError}),createElement(VideoPricingModeNotice,{configJson:raw,pricingMode:"priced",onChoosePriced:onChange})));
   const before=JSON.stringify(value);expect(videoSettingsDiagnostics(value.video)).toEqual([]);expect(adapter==="doubao"?parseDoubaoVideoConfig(value.video):parseSecureVideoConfig(value.video)).not.toBeNull();
   reports.push({...bench(adapter+"-"+count+"-quotes-diagnostics",4000,()=>{sink+=videoSettingsDiagnostics(value.video).length;}),json_bytes:new TextEncoder().encode(raw).byteLength});
   reports.push({...bench(adapter+"-"+count+"-quotes-controls-plus-notice-SSR",64,()=>{sink+=render().length;}),json_bytes:new TextEncoder().encode(raw).byteLength,html_chars:render().length});
   const parse=vi.spyOn(JSON,"parse");render();const parses=parse.mock.calls.filter(([text])=>text===raw).length;parse.mockRestore();
   expect(parses).toBe(2);expect(onChange).not.toHaveBeenCalled();expect(onError).not.toHaveBeenCalled();expect(JSON.stringify(value)).toBe(before);
  }
  const cfg=parseDoubaoVideoConfig(draft("doubao",8).video)!;expect(cfg).not.toBeNull();
  for(const refs of [0,50]){
   const raw=JSON.stringify({model:"local-video",prompt:"x".repeat(refs?8000:100),...(refs?{images:Array.from({length:30},(_,i)=>"https://cdn.org/image/"+i),videos:Array.from({length:10},(_,i)=>"https://cdn.org/video/"+i),audios:Array.from({length:10},(_,i)=>"https://cdn.org/audio/"+i)}:{})});
   const run=()=>{const p=parseDoubaoVideoRequest(JSON.parse(raw));if(!p)throw Error("invalid request fixture");const n=normalizeDoubaoRequest(cfg,p);if(!n)throw Error("invalid normalized fixture");sink+=n.content.length;};run();reports.push({...bench("Doubao-JSON-parse-validate-normalize-"+refs+"-refs",refs?300:4000,run),json_bytes:new TextEncoder().encode(raw).byteLength});
  }
  const poll={id:"local-upstream",status:"succeeded",content:{video_url:"https://cdn.org/video.mp4"},usage:{completion_tokens:123,total_tokens:150}};
  reports.push(bench("Doubao-known-poll-shape-and-usage-only",10000,()=>{sink+=readDoubaoVideoPoll(poll,"local-upstream").status?.length??0;}));
  console.log("VIDEO_SETTINGS_PERF_REPORT="+JSON.stringify({runtime:process.version,producer:"local-benchmark",scope:"Node CPU including GC/threads and SSR serialization; excludes browser DOM/layout/network/D1/Workers CPU. Parser benchmark excludes gateway auth/billing. No before/after claim. SSR pair is not full modal; exact two parses verified separately.",reports,sink}));
 },60000);
});
