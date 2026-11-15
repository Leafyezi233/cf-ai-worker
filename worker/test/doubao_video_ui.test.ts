import { describe, expect, it, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { parseModelTypeConfig } from "../../web/src/utils/modelType";
import { validateStandardVideoInput, newStandardVideoAttempt, saveStandardVideoAttempt, loadStandardVideoAttempt, parseStandardVideoTask, standardAttemptFinished, type StandardVideoLimits } from "../../web/src/utils/standardVideoTask";
const adminPath="../../web/src/pages/ModelsPage.tsx", componentPath="../../web/src/components/ConsoleStandardVideoCard.tsx";
const {blankDoubaoVideoConfig,DoubaoVideoConfigControls}=await import(adminPath);
const {StandardVideoTaskCard}=await import(componentPath);
const clientPath="../../web/src/api/standardVideoClient";
const {standardVideoApi}=await import(clientPath);
const requireWeb=createRequire(new URL("../../web/package.json",import.meta.url));
const {createElement}=requireWeb("react"),{renderToStaticMarkup}=requireWeb("react-dom/server");
const render=(component:unknown,props:unknown)=>renderToStaticMarkup(createElement(component,props));
const input={model:"public-video",prompt:"Sea",duration:30,ratio:"16:9",resolution:"4K"};
const limits:StandardVideoLimits={request_format:"doubao_content",resolutions:["4K"],ratios:["16:9"],seconds_min:4,seconds_max:30,max_images:30,max_videos:10,max_audios:10,max_total_refs:50,min_images:0,support_first_last:true,support_audio_urls:true,support_video_urls:true,support_audio_only:true,max_audio_only:10,allow_tail_only:true};
const id="a".repeat(32), url=(n:number)=>"https://media.realhost.net/"+n;
afterEach(()=>vi.unstubAllGlobals());
describe("independent Doubao UI contract",()=>{
 it("starts blank, disabled and unpriced; strict backend parser gates saving",()=>{
  const v=blankDoubaoVideoConfig();expect(v).toMatchObject({adapter:"doubao",upstream_model:"",resolutions:[],ratios:[],default_resolution:"",default_duration:null,default_ratio:"",seconds_min:null,seconds_max:null,max_images:0,max_videos:0,max_audios:0,max_total_refs:0,use_asset_library:false,quotes:[]});
  expect(()=>parseModelTypeConfig(JSON.stringify({model_type:"video",video:v}))).toThrow();
  const configured={...v,upstream_model:"vendor/video-model-v1",default_duration:4,default_ratio:"16:9",seconds_min:4,seconds_max:30,resolutions:["4K"],ratios:["16:9"],default_resolution:"4K",quotes:[{resolution:"4K",has_reference_video:false,unit:"call",price:1.23}]};
  expect(()=>parseModelTypeConfig(JSON.stringify({model_type:"video",video:configured}))).not.toThrow();
  expect(()=>parseModelTypeConfig(JSON.stringify({model_type:"video",video:{...configured,upstream_model:"vendor/custom-fast-v2"}}))).not.toThrow();
 });
 it("renders a blank model input and independent per-quote units",()=>{
  const html=render(DoubaoVideoConfigControls,{configJson:JSON.stringify({video:blankDoubaoVideoConfig()}),onChange:()=>{},onError:()=>{}});
  expect(html).toContain('aria-label="上游模型"');expect(html).not.toContain("<option value=\"doubao-");expect(html).toContain("空价格不代表免费");
  const source=readFileSync(new URL(adminPath,import.meta.url),"utf8");expect(source).toContain("将完整替换原 video 对象");expect(source).toContain("确认改变报价单位并保留此数字");expect(source).toContain("!isDoubaoVideoDraft(form.config_json) ? <SecureVideoConfigControls");
 });
 it("allows only Doubao tail-alone/frame+audio and retains Minimax restrictions",()=>{
  expect(()=>validateStandardVideoInput({...input,last_frame_id:id,audio_urls:[url(1)]},limits)).not.toThrow();
  const old={...limits,request_format:undefined,seconds_max:15};
  expect(()=>validateStandardVideoInput({...input,duration:4,last_frame_id:id},old)).toThrow();
  expect(()=>validateStandardVideoInput({...input,duration:4,first_frame_id:id,audio_urls:[url(1)]},old)).toThrow();
  expect(()=>validateStandardVideoInput({...input,last_frame_id:id,video_urls:[url(1)]},limits)).toThrow();
 });
 it("counts external group caps independently from private upload ceilings",()=>{
  expect(()=>validateStandardVideoInput({...input,image_urls:Array.from({length:30},(_,i)=>url(i)),video_urls:Array.from({length:10},(_,i)=>url(i+30)),audio_urls:Array.from({length:10},(_,i)=>url(i+40))},limits)).not.toThrow();
  expect(()=>validateStandardVideoInput({...input,image_urls:[url(1),url(2)]},{...limits,max_total_refs:1})).toThrow();
  expect(()=>validateStandardVideoInput({...input,reference_image_ids:Array.from({length:10},(_,i)=>i.toString(16).padStart(32,"0"))},limits)).toThrow();
  expect(()=>validateStandardVideoInput({...input,image_urls:[url(1)],reference_image_ids:[id]},limits)).toThrow();
 });
 it("journals exact Doubao input and makes a single paid POST without protocol marker in body",async()=>{
  const body={...input,last_frame_id:id,audio_urls:[url(1)]},a=newStandardVideoAttempt(body,limits),data=new Map<string,string>();
  const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};
  await saveStandardVideoAttempt("credential",a,storage);expect(await loadStandardVideoAttempt("credential",storage)).toEqual(a);
  vi.stubGlobal("sessionStorage",{getItem:()=>"credential"});const fetch=vi.fn(async()=>{throw Error("unknown");});vi.stubGlobal("fetch",fetch);
  await expect(standardVideoApi.create("credential",a)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
  const [,init]=fetch.mock.calls[0] as unknown as [string,RequestInit];expect(JSON.parse(String(init.body))).toEqual(body);expect(init.headers).toHaveProperty("Idempotency-Key",a.key);expect(standardAttemptFinished(a)).toBe(false);
 });
 it("shows completed/download unconfigured, never supplier or play button",()=>{
  const task=parseStandardVideoTask({...input,id:"local_task",status:"completed",content_available:false,result_url:"/v1/videos/local_task/content",url:"https://supplier.net/private"});
  expect(task.result_url).toBeUndefined();const html=render(StandardVideoTaskCard,{task,token:""});expect(html).toContain("生成完成，下载未配置，请联系管理员获取帮助");expect(html).toContain("请勿重复付费提交");expect(html).not.toContain("播放 / 下载");expect(html).not.toContain("supplier");expect(standardAttemptFinished({...newStandardVideoAttempt(input,limits),task})).toBe(true);
 });
 it("source verifies model-switch reset and server-defined defaults (not browser E2E)",()=>{
  const source=readFileSync(new URL(componentPath,import.meta.url),"utf8");expect(source).toContain("limits?.default_duration??limits?.seconds_min");expect(source).toContain("limits?.default_ratio||limits?.ratios");expect(source).toContain('operation.current?.abort();operation.current=null;generation.current++;setBusy(false);setModel');expect(source).toContain('setImageUrls("");setVideoUrls("");setMode("text");setRefs([])');
 });
});
