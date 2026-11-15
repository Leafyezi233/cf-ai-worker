import { describe,expect,it } from "vitest";
import { doubaoVideoEndpoint,parseDoubaoVideoConfig } from "../src/gateway/doubao_video_config";
import { normalizeDoubaoRequest,parseDoubaoVideoRequest,type DoubaoContentPart,type DoubaoVideoRequest } from "../src/gateway/doubao_video_request";

const rawConfig={adapter:"doubao",upstream_model:"custom-video-v2",default_ratio:"16:9",default_duration:4,ratios:["16:9","9:16"],
  resolutions:["720p","1080p"],default_resolution:"720p",seconds_min:4,seconds_max:30,
  max_images:30,max_videos:10,max_audios:10,max_total_refs:50,support_first_last:true,
  quotes:[{resolution:"720p",has_reference_video:false,unit:"second",price:0.1},
    {resolution:"720p",has_reference_video:true,unit:"call",price:2},
    {resolution:"1080p",has_reference_video:false,unit:"second",price:0.2}]};
const text:DoubaoContentPart={type:"text",text:"A quiet river"};
const image=(url="https://cdn.org/image",role:DoubaoContentPart["role"]="reference_image"):DoubaoContentPart=>({type:"image_url",image_url:{url},role});
const video=(url="https://cdn.org/video"):DoubaoContentPart=>({type:"video_url",video_url:{url},role:"reference_video"});
const audio=(url="https://cdn.org/audio"):DoubaoContentPart=>({type:"audio_url",audio_url:{url},role:"reference_audio"});
const input={model:"public-video",prompt:"A quiet river"};
function config(extra:Record<string,unknown>={}){const c=parseDoubaoVideoConfig({...rawConfig,...extra});expect(c).not.toBeNull();return c!;}
function request(extra:Record<string,unknown>={}){const r=parseDoubaoVideoRequest({...input,...extra});expect(r).not.toBeNull();return r!;}
function normalize(extra:Record<string,unknown>={},cfg:Record<string,unknown>={}){return normalizeDoubaoRequest(config(cfg),request(extra));}

describe("Doubao capability configuration (offline)",()=>{
 it("requires an explicit adapter/model and returns conservative fresh defaults",()=>{
  const c=config();expect(c).toMatchObject({adapter:"doubao",default_ratio:"16:9",default_duration:4,min_images:0,
   support_video_urls:false,support_audio_urls:false,support_audio_only:false,max_audio_only:0,use_asset_library:false,
   poll_interval_ms:15000,sizes:[],task_id_path:"id",failed_statuses:["failed"]});
  c.ratios.push("1:1");c.quotes[0].price=9;expect(rawConfig.ratios).not.toContain("1:1");expect(rawConfig.quotes[0].price).toBe(0.1);
 });
 it.each(["adapter","upstream_model","ratios","resolutions","default_resolution","default_ratio","default_duration","seconds_min","seconds_max","max_images","max_videos","max_audios","max_total_refs","support_first_last","quotes"])("requires %s",key=>{
  const v:Record<string,unknown>={...rawConfig};delete v[key];expect(parseDoubaoVideoConfig(v)).toBeNull();
 });
 it.each([null,[],true,3,"{}"])("rejects non-object config %j",v=>expect(parseDoubaoVideoConfig(v)).toBeNull());
 it.each([
  {adapter:"secure_skill"},{upstream_model:"bad model"},{downloadconfig:{}},{download_config:{}},{tools:[]},{priority:"default"},
  {sizes:[]},{task_id_path:"id"},{failed_statuses:["failed"]},{ratios:[]},{ratios:["16:9","16:9"]},{ratios:["auto"]},
  {resolutions:["bad resolution"]},{resolutions:["a".repeat(33)]},{default_resolution:"480p"},{default_ratio:"4:3"},{default_duration:3},
  {default_duration:4.5},{default_duration:null},{seconds_min:3},{seconds_min:4.2},{seconds_max:31},{seconds_min:10,default_duration:4},
  {max_images:31},{max_videos:11},{max_audios:11},{max_total_refs:51},{max_images:-1},{max_videos:1.2},{max_total_refs:null},
  {min_images:31},{min_images:1,max_total_refs:0},{support_first_last:1},{support_video_urls:null},{support_audio_urls:"true"},
  {support_audio_only:true},{max_audio_only:1},{support_audio_urls:true,support_audio_only:true,max_audio_only:11},
  {use_asset_library:1},{poll_interval_ms:14999},{poll_interval_ms:15000.1},{poll_interval_ms:null},
  {quotes:[]},{quotes:[...rawConfig.quotes,rawConfig.quotes[0]]},
  {quotes:[{...rawConfig.quotes[0],resolution:"480p"}]},{quotes:[{...rawConfig.quotes[0],price:Infinity}]},
  {quotes:[{...rawConfig.quotes[0],price:-1}]},{quotes:[{...rawConfig.quotes[0],price:10001}]},
  {quotes:[{...rawConfig.quotes[0],has_reference_video:1}]},{quotes:[{...rawConfig.quotes[0],unit:"token"}]},
  {quotes:[{...rawConfig.quotes[0],extra:true}]},
 ])("fails closed for invalid configuration %j",fields=>expect(parseDoubaoVideoConfig({...rawConfig,...fields})).toBeNull());
 it.each(["vendor/model-v1","custom-fast-v2","custom-video-v3"])("uses explicit limits independent of model name %s",upstream_model=>{
  const c=config({upstream_model,seconds_max:30,resolutions:["720p","1080p","2160p"]});
  expect(c.upstream_model).toBe(upstream_model);expect(c.seconds_max).toBe(30);expect(c.resolutions).toContain("2160p");
  expect(normalizeDoubaoRequest(c,request({duration:24,resolution:"2160p"}))).toBeNull();
  const custom=config({upstream_model,resolutions:["2160p"],default_resolution:"2160p",quotes:[{...rawConfig.quotes[0],resolution:"2160p"}]});
  expect(normalizeDoubaoRequest(custom,request({duration:24}))).toMatchObject({duration:24,resolution:"2160p"});
 });
 it("accepts zero refs and explicitly enabled audio-only policy with zero-price quotes",()=>{
  expect(config({max_images:0,max_videos:0,max_audios:0,max_total_refs:0}).max_images).toBe(0);
  expect(config({support_audio_urls:true,support_audio_only:true,max_audio_only:2,use_asset_library:true,
   quotes:[{...rawConfig.quotes[0],price:0}]})).toMatchObject({support_audio_only:true,max_audio_only:2,use_asset_library:true});
 });
 it.each(["https://video.vendor.example/api/v3","https://video.vendor.example/api/v3/"])("appends the task path to configured API base %s",base=>
  expect(doubaoVideoEndpoint(base)).toBe("https://video.vendor.example/api/v3/contents/generations/tasks"));
 it.each([undefined,null,"", "http://video.vendor.example/api/v3","https://localhost/v1","https://127.0.0.1/v1",
  "https://video.internal/v1","https://video.vendor.example:8443/v1","https://video.vendor.example/v1//","https://video.vendor.example/v1?x=1",
  "https://video.vendor.example/v1#x","https://u:p@video.vendor.example/v1"," https://video.vendor.example/v1"])("rejects unsafe endpoint %j",base=>expect(doubaoVideoEndpoint(base)).toBeNull());
});

describe("Doubao raw request parser (offline)",()=>{
 it("canonicalizes shorthand aliases without filling group-dependent defaults",()=>{
  expect(request()).toEqual({model:input.model,content:[text]});
  const r=request({seconds:8,aspect_ratio:"9:16",images:["https://cdn.org/i"],videos:["https://cdn.org/v"],audios:["https://cdn.org/a"],stream:false,
   use_asset_library:false,generate_audio:true,watermark:false,return_last_frame:true,seed:4294967295});
  expect(r).toEqual({model:input.model,content:[text,image("https://cdn.org/i"),video("https://cdn.org/v"),audio("https://cdn.org/a")],
   duration:8,ratio:"9:16",use_asset_library:false,generate_audio:true,watermark:false,return_last_frame:true,seed:4294967295});
  expect(request({image_urls:["https://cdn.org/i"],video_urls:["https://cdn.org/v"],audio_urls:["https://cdn.org/a"]}).content).toEqual(r.content);
  expect(request({duration:4,seconds:4,ratio:"16:9",aspect_ratio:"16:9",seed:-1}).duration).toBe(4);
 });
 it("preserves official content order, text, explicit roles and fresh objects",()=>{
  const content=[video(),{type:"text" as const,text:"  first  "},image(),audio(),{type:"text" as const,text:"second"}];
  const r=parseDoubaoVideoRequest({model:input.model,content})!;expect(r.content).toEqual(content);
  r.content[0].video_url!.url="https://other.org/v";expect(content[0]).toEqual(video());
 });
 it("permits empty text parts only alongside at least one nonempty text, preserving all parts",()=>{
  const content=[{type:"text",text:" "},audio(),text,{type:"text",text:""}];
  expect(parseDoubaoVideoRequest({model:input.model,content})!.content).toEqual(content);
 });
 it("assigns only type-appropriate default roles",()=>{
  expect(parseDoubaoVideoRequest({model:input.model,content:[text,{type:"image_url",image_url:{url:"https://cdn.org/i"}}]})!.content[1]).toEqual(image("https://cdn.org/i"));
 });
 it("allows tail-only frames and audio alongside first/last, not references/videos",()=>{
  expect(request({last_frame:"https://cdn.org/tail"}).content[1]).toEqual(image("https://cdn.org/tail","last_frame"));
  expect(request({first_frame:"https://cdn.org/first",last_frame:"https://cdn.org/last",audios:["https://cdn.org/a"]}).content).toHaveLength(4);
  expect(parseDoubaoVideoRequest({...input,first_frame:"https://cdn.org/first",images:["https://cdn.org/i"]})).toBeNull();
  expect(parseDoubaoVideoRequest({...input,last_frame:"https://cdn.org/last",videos:["https://cdn.org/v"]})).toBeNull();
 });
 it("encodes private IDs in trusted internal URLs but raw official content cannot inject them",()=>{
  const id="a".repeat(32),id2="b".repeat(32);
  const r=request({reference_image_ids:[id],reference_video_ids:[id2]});
  expect(r.content).toEqual([text,image("cpg-image:"+id),video("cpg-video:"+id2)]);
  expect(normalizeDoubaoRequest(config({support_video_urls:true}),r)).not.toBeNull();
  for(const content of [[text,image("cpg-image:"+id)],[text,video("cpg-video:"+id2)]])
   expect(parseDoubaoVideoRequest({model:input.model,content})).toBeNull();
  expect(request({last_frame_id:id}).content[1]).toEqual(image("cpg-image:"+id,"last_frame"));
 });
 it.each([
  {duration:3},{duration:31},{duration:4.1},{duration:"4"},{duration:null},{seconds:null},{duration:4,seconds:5},
  {ratio:null},{aspect_ratio:null},{ratio:"auto"},{ratio:"16:9",aspect_ratio:"9:16"},{resolution:"bad resolution"},
  {stream:true},{stream:null},{tools:[]},{priority:"default"},{downloadconfig:{}},{upstream_model:"x"},
  {generate_audio:1},{watermark:"false"},{return_last_frame:null},{use_asset_library:1},{seed:0.1},{seed:-2},{seed:4294967296},{seed:NaN},
  {images:[],image_urls:[]},{videos:[],video_urls:[]},{audios:[],audio_urls:[]},{images:null},
  {reference_image_ids:["a".repeat(32)],images:[]},{reference_video_ids:["a".repeat(32)],video_urls:[]},
  {first_frame:"https://cdn.org/i",first_frame_id:"a".repeat(32)},{reference_image_ids:["A".repeat(32)]},
  {reference_image_ids:["a".repeat(32),"a".repeat(32)]},{reference_image_ids:["a".repeat(32)],reference_video_ids:["a".repeat(32)]},
  {first_frame_id:"a".repeat(32),last_frame_id:"a".repeat(32)},
  {image_urls:["https://cdn.org/i"],audio_urls:["https://cdn.org/i"]},
  {image_urls:["https://cdn.org","https://cdn.org:443/"]},
 ])("rejects malformed fields/ambiguous aliases/duplicates %j",fields=>expect(parseDoubaoVideoRequest({...input,...fields})).toBeNull());
 it.each(["asset://opaque","cpg-image:"+"a".repeat(32),"http://cdn.org/a","https://127.0.0.1/a","https://[::1]/a",
  "https://cdn.internal/a","https://cdn.test/a","https://cdn.example/a","https://localhost/a","https://cdn.org:8443/a",
  "https://u:p@cdn.org/a","https://cdn.org/a#x","https://cdn.org/a b","https://cdn.org/a\\b","data:image/png;base64,x"])("rejects nonpublic reference %s",url=>{
   expect(parseDoubaoVideoRequest({...input,images:[url]})).toBeNull();
   expect(parseDoubaoVideoRequest({model:input.model,content:[text,image(url)]})).toBeNull();
 });
 it.each([
  [],[image()],[{type:"text",text:" "}],[{type:"text",text:3}],[{type:"text",text:"ok",role:"reference_image"}],
  [text,{type:"image_url",image_url:{url:"https://cdn.org/i",extra:true}}],
  [text,{type:"image_url",image_url:{url:"https://cdn.org/i"},role:"reference_video"}],
  [text,{type:"video_url",video_url:{url:"https://cdn.org/v"},role:"first_frame"}],
  [text,{type:"audio_url",audio_url:{url:"https://cdn.org/a"},role:"last_frame"}],
  [text,{type:"image_url",image_url:{url:"https://cdn.org/i"},extra:true}],
  [text,{type:"image_url",image_url:{url:"https://cdn.org/i"},video_url:{url:"https://cdn.org/v"}}],
  [text,image("https://cdn.org/a","first_frame"),image("https://cdn.org/b","first_frame")],
  [text,image("https://cdn.org/a","last_frame"),image("https://cdn.org/b","last_frame")],
  [text,image("https://cdn.org/a","last_frame"),image("https://cdn.org/b")],
  [text,image("https://cdn.org/a","first_frame"),video()],
 ].map(content=>({content})))("rejects invalid official content %j",({content})=>expect(parseDoubaoVideoRequest({model:input.model,content})).toBeNull());
 it("official content excludes even empty shorthand fields",()=>{
  for(const key of ["prompt","images","videos","audios","image_urls","video_urls","audio_urls","reference_image_ids","reference_video_ids","first_frame","last_frame","first_frame_id","last_frame_id"])
   expect(parseDoubaoVideoRequest({model:input.model,content:[text],[key]:key==="prompt"?"":[]})).toBeNull();
 });
 it("enforces total text and CPG reference safety ceilings without rounding",()=>{
  expect(parseDoubaoVideoRequest({model:input.model,content:[{type:"text",text:"x".repeat(4000)},{type:"text",text:"y".repeat(4000)}]})).not.toBeNull();
  expect(parseDoubaoVideoRequest({model:input.model,content:[{type:"text",text:"x".repeat(4000)},{type:"text",text:"y".repeat(4001)}]})).toBeNull();
  const urls=(count:number,kind:string)=>Array.from({length:count},(_,i)=>"https://cdn.org/"+kind+i);
  expect(request({images:urls(30,"i"),videos:urls(10,"v"),audios:urls(10,"a")}).content).toHaveLength(51);
  for(const fields of [{images:urls(31,"i")},{videos:urls(11,"v")},{audios:urls(11,"a")}])
   expect(parseDoubaoVideoRequest({...input,...fields})).toBeNull();
 });
});

describe("Doubao pure group normalization (offline)",()=>{
 it("fills stable defaults, preserves public model/options and does not mutate the parsed request",()=>{
  const r=request({generate_audio:false,watermark:true,return_last_frame:false,seed:0}),before=JSON.stringify(r);
  expect(normalizeDoubaoRequest(config(),r)).toMatchObject({model:input.model,duration:4,ratio:"16:9",resolution:"720p",use_asset_library:false,
   generate_audio:false,watermark:true,return_last_frame:false,seed:0});expect(JSON.stringify(r)).toBe(before);
  expect(normalize({}, {default_duration:8,default_ratio:"9:16",default_resolution:"1080p",use_asset_library:true})).toMatchObject({duration:8,ratio:"9:16",resolution:"1080p",use_asset_library:true});
 });
 it.each([
  [{duration:16},{upstream_model:"doubao-seedance-2-0-260128",seconds_max:15}],
  [{duration:4},{seconds_min:5,default_duration:5}], [{ratio:"1:1"},{}],[{resolution:"4K"},{}],
  [{images:["https://cdn.org/i"]},{max_images:0}],[{},{min_images:1}],
  [{videos:["https://cdn.org/v"]},{}],[{videos:["https://cdn.org/v"]},{support_video_urls:true,max_videos:0}],
  [{audios:["https://cdn.org/a"]},{}],[{audios:["https://cdn.org/a"]},{support_audio_urls:true}],
  [{last_frame:"https://cdn.org/tail"},{support_first_last:false}],
  [{images:["https://cdn.org/i"],audios:["https://cdn.org/a"]},{support_audio_urls:true,max_total_refs:1}],
  [{images:["https://cdn.org/i"],audios:["https://cdn.org/a"]},{support_audio_urls:true,max_audios:0}],
  [{use_asset_library:true},{}],
 ])("enforces all group limits/options %j %j",(fields,cfg)=>expect(normalize(fields,cfg)).toBeNull());
 it("uses actual reference-video count, not images/audio, for exact quote selection",()=>{
  const r=request({videos:["https://cdn.org/v"]});
  expect(normalizeDoubaoRequest(config({support_video_urls:true,quotes:[rawConfig.quotes[0]]}),r)).toBeNull();
  expect(normalizeDoubaoRequest(config({support_video_urls:true,quotes:[rawConfig.quotes[1]]}),r)).not.toBeNull();
  expect(normalize({images:["https://cdn.org/i"]},{quotes:[rawConfig.quotes[1]]})).toBeNull();
  expect(normalize({resolution:"1080p",videos:["https://cdn.org/v"]},{support_video_urls:true})).toBeNull();
 });
 it("gates audio-only separately but allows audio with tail-only or video",()=>{
  const cfg={support_audio_urls:true,support_audio_only:true,max_audio_only:1};
  expect(normalize({audios:["https://cdn.org/a"]},cfg)).not.toBeNull();
  expect(normalize({audios:["https://cdn.org/a","https://cdn.org/b"]},cfg)).toBeNull();
  expect(normalize({last_frame:"https://cdn.org/tail",audios:["https://cdn.org/a"]},{support_audio_urls:true})).not.toBeNull();
  expect(normalize({videos:["https://cdn.org/v"],audios:["https://cdn.org/a"]},{support_video_urls:true,support_audio_urls:true})).not.toBeNull();
 });
 it("revalidates typed canonical requests instead of trusting casts",()=>{
  const r=request();
  expect(normalizeDoubaoRequest(config(),{...r,duration:4.5})).toBeNull();
  expect(normalizeDoubaoRequest(config(),{...r,content:[text,image("asset://opaque")]})).toBeNull();
  expect(normalizeDoubaoRequest(config(),{...r,priority:"default"} as DoubaoVideoRequest)).toBeNull();
 });
});
