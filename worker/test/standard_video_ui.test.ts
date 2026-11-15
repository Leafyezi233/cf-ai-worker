import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { loadStandardVideoAttempt, saveStandardVideoAttempt, newStandardVideoAttempt, standardAttemptFinished, parseStandardVideoTask, standardVideoResultUrl, standardVideoTicketUrl, validateStandardVideoInput, precheckStandardReference, parseStandardReference, type StandardVideoTask } from "../../web/src/utils/standardVideoTask";
const clientPath="../../web/src/api/standardVideoClient";
const {standardVideoApi,boundedStandardVideoJson}=await import(clientPath);
const componentPath="../../web/src/components/ConsoleStandardVideoCard.tsx";
const {ConsoleStandardVideoCard,StandardVideoTaskCard,StandardVideoTicketMedia}=await import(componentPath);
const adminPath="../../web/src/pages/ModelsPage.tsx";
const {patchSecureVideoConfig,SecureVideoConfigControls}=await import(adminPath);
const requireWeb=createRequire(new URL("../../web/package.json",import.meta.url));
const {createElement}=requireWeb("react"),{renderToStaticMarkup}=requireWeb("react-dom/server");
const render=(component:unknown,props:unknown)=>renderToStaticMarkup(createElement(component,props));
const input={model:"standard-video",prompt:"A calm sea",duration:5,ratio:"16:9",resolution:"720p"};
const limits={resolutions:["720p"],ratios:["16:9"],default_resolution:"720p",seconds_min:4,seconds_max:15,min_images:0,max_images:3,max_videos:3,max_audios:3,support_first_last:true,support_video_urls:true,support_audio_urls:true,support_audio_only:false,max_audio_only:0};
const id="a".repeat(32),id2="b".repeat(32);
const task=(extra:Record<string,unknown>={})=>({id:"vid_local",task_id:"vid_local",status:"queued",...input,...extra});
function storage(){const values=new Map<string,string>();return {values,getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};}
function auth(){vi.stubGlobal("sessionStorage",{getItem:()=>"credential-a"});}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe("standard video intents and capability rules",()=>{
  it("persists an unknown exact key/body across remount without storing raw credentials",async()=>{
    const s=storage(),a=newStandardVideoAttempt({...input,reference_video_ids:[id]});await saveStandardVideoAttempt("credential-a",a,s);
    expect(await loadStandardVideoAttempt("credential-a",s)).toEqual(a);expect(await loadStandardVideoAttempt("credential-b",s)).toBeNull();
    expect([...s.values.keys()].join()).not.toContain("credential-a");expect([...s.values.values()].join()).not.toContain("credential-a");
    expect(standardAttemptFinished(a)).toBe(false);
    const confirmed={...a,task:parseStandardVideoTask(task({status:"submission_unknown"}))};await saveStandardVideoAttempt("credential-a",confirmed,s);
    expect((await loadStandardVideoAttempt("credential-a",s))?.task?.requires_review).toBe(true);
  });
  it("never silently discards corrupted journal or failed storage writes",async()=>{
    await expect(loadStandardVideoAttempt("a",{getItem:()=>"{broken",setItem:()=>{},removeItem:()=>{}})).rejects.toThrow("复核");
    await expect(saveStandardVideoAttempt("a",newStandardVideoAttempt(input),{getItem:()=>null,setItem:()=>{},removeItem:()=>{}})).rejects.toThrow("禁止创建");
  });
  it.each(["queued","in_progress","submission_unknown"])("does not release acknowledged %s",status=>{
    expect(standardAttemptFinished({...newStandardVideoAttempt(input),task:parseStandardVideoTask(task({status}))})).toBe(false);
  });
  it("requires explicit terminal state without review/conflict before a new paid intent",()=>{
    const a={...newStandardVideoAttempt(input),task:parseStandardVideoTask(task({status:"completed"}))};
    expect(standardAttemptFinished(a)).toBe(true);expect(standardAttemptFinished({...a,conflict:true})).toBe(false);expect(standardAttemptFinished({...a,task:{...a.task,requires_review:true}})).toBe(false);
  });
  it("enforces advertised specs, max3 videos, reference modes and opt-in audio-only",()=>{
    expect(()=>validateStandardVideoInput(input,limits)).not.toThrow();
    expect(()=>validateStandardVideoInput(input,{...limits,min_images:1})).toThrow("管理员");
    expect(()=>validateStandardVideoInput({...input,reference_video_ids:[id]},limits)).not.toThrow();
    expect(()=>validateStandardVideoInput({...input,reference_video_ids:[id]}, {...limits,max_videos:0})).toThrow();
    expect(()=>validateStandardVideoInput({...input,first_frame_id:id,reference_video_ids:[id2]},limits)).toThrow();
    expect(()=>validateStandardVideoInput({...input,last_frame_id:id},limits)).toThrow();
    expect(()=>validateStandardVideoInput({...input,audio_urls:["https://media.realhost.net/a.wav"]},limits)).toThrow("音频单独");
    expect(()=>validateStandardVideoInput({...input,resolution:"1080p"},limits)).toThrow("管理员");
    expect(()=>validateStandardVideoInput({...input,duration:3},limits)).toThrow();
    expect(()=>validateStandardVideoInput({...input,video_urls:["https://supplier.net/x"]} as never)).toThrow();
  });
  it("bounds aliases and projects only task-local result paths",()=>{
    expect(parseStandardVideoTask(task({status:"completed",url:"https://supplier.net/private",raw:"secret"}))).not.toHaveProperty("result_url");
    expect(()=>parseStandardVideoTask(task({task_id:"different"}))).toThrow();
    expect(standardVideoResultUrl("/v1/videos/vid_local/content","vid_local")).toBeTruthy();
    expect(standardVideoResultUrl("/v1/video/generations/vid_local/content","vid_local")).toBeTruthy();
    for(const raw of ["//supplier.net/a","https://supplier.net/a","/v1/videos/other/content","/v1/videos/vid_local/content?url=secret"])expect(standardVideoResultUrl(raw,"vid_local")).toBeNull();
  });
});
describe("private upload and bounded client",()=>{
  it("prechecks disabled/type/size and metadata-only responses",()=>{
    const p={enabled:true,formats:["video/mp4"],max_bytes:100,max_duration_ms:10000},f={type:"video/mp4",size:99};
    expect(()=>precheckStandardReference(f,p)).not.toThrow();
    for(const change of [{enabled:false},{formats:[]},{max_bytes:20}])expect(()=>precheckStandardReference(f,{...p,...change})).toThrow();
    expect(parseStandardReference({id,bytes:99,content_type:f.type,expires_at:Date.now()+100000,url:"https://supplier.net/secret"},f)).not.toHaveProperty("url");
  });
  it("authenticates limits and permits release only with explicit pre-dispatch evidence",async()=>{auth();let response=Response.json({item:{enabled:false}});const fetch=vi.fn(async()=>response);vi.stubGlobal("fetch",fetch);await standardVideoApi.limits("credential-a","videos");expect((fetch.mock.calls[0] as unknown as [string,RequestInit])[1].headers).toHaveProperty("Authorization","Bearer credential-a");const a=newStandardVideoAttempt(input);for(const marked of [false,true]){response=Response.json({error:"invalid_video_request"},{status:400,headers:marked?{"X-Cpg-Video-Dispatch":"not-started"}:{}});try{await standardVideoApi.create("credential-a",a);throw Error("must reject");}catch(e){expect((e as {notDispatched:boolean}).notDispatched).toBe(marked);}}expect(standardAttemptFinished({...a,rejected:true})).toBe(true);expect(standardAttemptFinished({...a,rejected:true,conflict:true})).toBe(false);expect(standardAttemptFinished({...a,rejected:true,task:parseStandardVideoTask(task({status:"submission_unknown"}))})).toBe(false);});
  it("uploads binary to the local endpoint without generating, multipart or manual content-length",async()=>{
    auth();const f=new File([new Uint8Array(10)],"ref.mp4",{type:"video/mp4"});const fetch=vi.fn(async()=>Response.json({id,bytes:10,content_type:f.type,duration_ms:500,expires_at:Date.now()+100000}));vi.stubGlobal("fetch",fetch);
    await standardVideoApi.upload("credential-a","videos",f,{enabled:true,formats:[f.type],max_bytes:100,max_duration_ms:1000});
    expect(fetch).toHaveBeenCalledTimes(1);const [path,init]=fetch.mock.calls[0] as unknown as [string,RequestInit];expect(path).toBe("/v1/videos/reference-videos");expect(init.body).toBe(f);expect(init.headers).not.toHaveProperty("Content-Length");expect((init as {credentials?:string}).credentials).toBe("omit");
  });
  it("does not create or retry after upload failure and sanitizes remote bodies",async()=>{
    auth();const fetch=vi.fn(async()=>Response.json({error:{message:"secret https://supplier.net/provider-key"}},{status:503}));vi.stubGlobal("fetch",fetch);
    const f=new File(["a"],"a.mp4",{type:"video/mp4"});await expect(standardVideoApi.upload("credential-a","videos",f,{enabled:true,formats:[f.type],max_bytes:100,max_duration_ms:1000})).rejects.not.toThrow("supplier");expect(fetch).toHaveBeenCalledTimes(1);
    await expect(boundedStandardVideoJson(new Response("x".repeat(65537)))).rejects.toThrow("大小");
  });
  it("sends exact persistent idempotency key and never retries paid POST",async()=>{
    auth();const fetch=vi.fn(async()=>{throw Error("network");});vi.stubGlobal("fetch",fetch);const a=newStandardVideoAttempt(input);
    await expect(standardVideoApi.create("credential-a",a)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
    const [path,init]=fetch.mock.calls[0] as unknown as [string,RequestInit];expect(path).toBe("/v1/videos");expect(init.headers).toHaveProperty("Idempotency-Key",a.key);expect(JSON.parse(String(init.body))).toEqual(input);
    await expect(standardVideoApi.create("credential-a",{...a,task:parseStandardVideoTask(task())})).rejects.toThrow("禁止重发");expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects responses after credential changes",async()=>{
    let token="credential-a";vi.stubGlobal("sessionStorage",{getItem:()=>token});vi.stubGlobal("fetch",async()=>{token="credential-b";return Response.json(task());});
    await expect(standardVideoApi.get("credential-a","vid_local")).rejects.toThrow("变化");
  });
});
describe("standard card and admin SSR",()=>{
  it("keeps the default capability override stable so form edits do not invalidate model filtering",()=>{
    const source=readFileSync(new URL(componentPath,import.meta.url),"utf8");
    expect(source).toContain("limitsByModel=EMPTY_LIMITS_BY_MODEL");
    const constant=source.indexOf("const EMPTY_LIMITS_BY_MODEL: Record<string,StandardVideoLimits> = Object.freeze({})");
    expect(constant).toBeGreaterThanOrEqual(0);
    expect(constant).toBeLessThan(source.indexOf("export function ConsoleStandardVideoCard"));
    const page=readFileSync(new URL("../../web/src/pages/ConsolePage.tsx",import.meta.url),"utf8");
    const mount=page.split("\n").find(line=>line.includes("<ConsoleStandardVideoCard"));
    expect(mount).toBeDefined();expect(mount).not.toContain("limitsByModel={{}}");
  });
  it("filters legacy models and shows upload-unconfigured help without provider disclosure",()=>{
    const legacy={id:"old",model_name:"legacy",model_type:"video",video:{sizes:["1280x720"]}},standard={id:"new",model_name:input.model,model_type:"video",video:limits};
    expect(render(ConsoleStandardVideoCard,{models:{items:[legacy]},active:true})).toBe("");
    const html=render(ConsoleStandardVideoCard,{models:{items:[legacy,standard]},active:true});expect(html).toContain(input.model);expect(html).not.toContain("legacy");expect(html).toContain("¥/秒");expect(html).not.toContain("secure_skill");expect(html).not.toContain("0.08");
  });
  it("never renders upstream or expired ticket media",()=>{
    const t=parseStandardVideoTask(task({status:"completed",url:"https://supplier.net/private"}));expect(render(StandardVideoTaskCard,{task:t,token:""})).not.toContain("supplier.net");
    const path="/v1/videos/vid_local/content",url=path+"?ticket="+encodeURIComponent("enc:v1:abc.def");expect(standardVideoTicketUrl(url,path)).toBe(url);
    for(const ticket of [{url:"https://supplier.net/video",expires_at:Date.now()+10000},{url,expires_at:1}])expect(render(StandardVideoTicketMedia,{ticket,path})).toBe("");
  });
  it("patches dedicated secure fields preserving nested unknown and unrelated JSON",()=>{
    const raw=JSON.stringify({custom:{keep:true},video:{adapter:"secure_skill",unknown:{keep:true},quotes:[{resolution:"720p",has_reference_video:false,unit:"second",price:0.7}]}});
    expect(JSON.parse(patchSecureVideoConfig(raw,{ratios:["16:9"]}))).toMatchObject({custom:{keep:true},video:{unknown:{keep:true},ratios:["16:9"],quotes:[{price:0.7}]}});
    const html=render(SecureVideoConfigControls,{configJson:raw,onChange:()=>{},onError:()=>{}});expect(html).toContain("¥/秒");expect(html).toContain("最多参考视频");expect(html).toContain("最少图片");expect(html).not.toContain("0.08");
    expect(()=>patchSecureVideoConfig("{bad",{})).toThrow();
  });
  it("keeps journal-before-fetch and does not clear unknown attempts during refresh",()=>{
    const source=readFileSync(new URL(componentPath,import.meta.url),"utf8");
    expect(source.indexOf("await saveStandardVideoAttempt(token,frozen!,localStorage)")).toBeLessThan(source.indexOf("await standardVideoApi.create(token,frozen!"));
    const refresh=source.slice(source.indexOf("async function refresh"),source.indexOf("async function newIntent"));expect(refresh).not.toContain("saveStandardVideoAttempt(token,null,localStorage)");expect(refresh).not.toContain("standardVideoApi.create");
  });
});
