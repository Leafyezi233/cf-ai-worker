import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { publicVideoLimits, publicVideoPricing } from "../src/gateway/video_config";
import { serializeConsoleModel } from "../src/console/model_marketplace";
import { consoleApp } from "../src/console";
import { createServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import { createRealD1, makeEnv, seedDevice, seedProvider, seedModel, TOKEN, type RealD1 } from "./helpers/realGatewayEnv";
import type { ModelProjectionRow } from "../src/db/repo";
import type { Env } from "../src/types";
const requireWeb=createRequire(new URL("../../web/package.json",import.meta.url));
const {createElement}=requireWeb("react"),{renderToStaticMarkup}=requireWeb("react-dom/server");
const componentPath="../../web/src/components/ConsoleModelsSquare.tsx";
const {ConsoleModelsSquare,ModelOfferCard,OfferPrices,ModelTable}=await import(componentPath);
const utilityPath="../../web/src/utils/videoMarketplace";
const {videoMinimums,videoQuotes,videoVariantKey,videoSortPrice}=await import(utilityPath);
const config={model_type:"video",video:{adapter:"secure_skill",upstream_model:"market-video-v1",default_ratio:"16:9",default_duration:4,ratios:["16:9"],resolutions:["720p","1080p"],default_resolution:"720p",seconds_min:4,seconds_max:15,max_images:3,support_first_last:false,quotes:[{resolution:"720p",has_reference_video:false,unit:"second",price:0.125},{resolution:"720p",has_reference_video:true,unit:"second",price:0.25},{resolution:"1080p",has_reference_video:false,unit:"call",price:2}]}};
const row={id:"model_a",model_name:"public-video",config_json:JSON.stringify(config),billing_unit:"call",pricing_mode:"priced",price_per_call:99,input_price_per_m:0,output_price_per_m:0} as ModelProjectionRow;
const render=(component:unknown,props:unknown)=>renderToStaticMarkup(createElement(component,props));
const plain=(html:string)=>html.replace(/<[^>]*>/g,"");
function offer(group:string,patch:Record<string,unknown>={}) {
  return {id:group,model_name:"public-video",display_name:null,description:null,alias:null,service_group_id:group,service_group_name:group,is_current:false,model_type:"video",billing_unit:"call",pricing_mode:"priced",price_per_call:99,input_price_per_m:0,output_price_per_m:0,cache_read_price_per_m:0,cache_write_price_per_m:0,supports_reasoning:false,chat_endpoint:"/v1/videos",video_pricing:publicVideoPricing(row),...patch};
}
describe("public video DTO and exact rate scaling",()=>{
  it("copies only explicit safe public quotes, never private config or capability pricing",()=>{
    const dto=serializeConsoleModel({...row,provider_endpoint:"https://private.invalid",provider_api_key:"PRIVATE_KEY"},new Map(),0,0);
    expect(dto).toMatchObject({chat_endpoint:"/v1/videos",protocol_capabilities:{supported_endpoints:["/v1/videos"]},video_pricing:{endpoint:"/v1/videos",settlement:"success",quotes:config.video.quotes}});
    expect(Object.keys(dto.video_pricing!)).toEqual(["endpoint","settlement","quotes"]);
    expect(Object.keys(dto.video_pricing!.quotes[0])).toEqual(["resolution","has_reference_video","unit","price"]);
    expect(JSON.stringify(dto)).not.toMatch(/PRIVATE_KEY|private.invalid|config_json|secure_skill|task_id_path|poll_interval/);
    expect(JSON.stringify(publicVideoLimits(row))).not.toMatch(/adapter|quotes|price/);
  });
  it("applies service and peak exactly once and never modifies original config",()=>{
    const original=row.config_json;
    const dto=publicVideoPricing(row,2,3)!;
    expect(dto.quotes.map(q=>q.price)).toEqual([0.75,1.5,12]);
    dto.quotes[0].price=80;
    expect(row.config_json).toBe(original);
    expect(publicVideoPricing(row)!.quotes[0].price).toBe(0.125);
    expect(publicVideoPricing(row,0,3)!.quotes.every(q=>q.price===0)).toBe(true);
    expect(publicVideoPricing(row,2,0)!.quotes.every(q=>q.price===0)).toBe(true);
  });
  it.each(["unset",undefined,"free"])("does not rescue mode %s using a nonzero ratecard",pricing_mode=>{
    expect(publicVideoPricing({...row,pricing_mode})!.quotes).toEqual([]);
  });
  it("uses the actual current peak snapshot once and disables bands for free/unset modes",()=>{
    const now=Date.UTC(2026,10,13,12),band={id:"peak",model_id:row.id,day_type:"fri",start_minute:0,end_minute:1440,multiplier:3,enabled:1,created_at:null,updated_at:null};
    const bands=new Map([[row.id,[band]]]);
    const dto=serializeConsoleModel({...row,peak_pricing_enabled:1},bands,now,0,{multiplier:2,scalarOverride:false});
    expect(dto.current_price_multiplier).toBe(3);expect(dto.video_pricing!.quotes.map(q=>q.price)).toEqual([0.75,1.5,12]);
    const off=serializeConsoleModel({...row,peak_pricing_enabled:0},bands,now,0,{multiplier:2,scalarOverride:false});
    expect(off.video_pricing!.quotes[0].price).toBe(0.25);
    const unset=serializeConsoleModel({...row,pricing_mode:"unset",peak_pricing_enabled:1},bands,now,0);
    expect(unset.video_pricing!.quotes).toEqual([]);expect(unset.peak_pricing_enabled).toBe(false);
  });
  it("requires explicit all-zero free quotes and rejects missing, malformed or scalar overrides",()=>{
    const free={...row,pricing_mode:"free",config_json:JSON.stringify({...config,video:{...config.video,quotes:config.video.quotes.map(q=>({...q,price:0}))}})};
    expect(publicVideoPricing(free)!.quotes).toHaveLength(3);
    expect(publicVideoPricing(row,1,1,true)!.quotes).toEqual([]);
    for(const quotes of [[],[{...config.video.quotes[0],price:-1}]]) expect(publicVideoPricing({...row,config_json:JSON.stringify({...config,video:{...config.video,quotes}})})!.quotes).toEqual([]);
    expect(publicVideoPricing(row,NaN)!.quotes).toEqual([]);
  });
  it("preserves generic endpoint and scalar successful-call price without applying service twice",()=>{
    const legacy={...row,price_per_call:0.5,config_json:JSON.stringify({model_type:"video",video:{adapter:"generic",task_id_path:"data.id",sizes:["1280x720"]}})};
    expect(publicVideoPricing(legacy,2,3)).toEqual({endpoint:"/v1/video/generations",settlement:"success",quotes:[{resolution:null,has_reference_video:null,unit:"call",price:1.5}]});
  });
});
describe("video marketplace SSR and same-variant comparison",()=>{
  it("renders standard second and legacy standard call rates in list, detail and table price cells",()=>{
    const m=offer("standard",{peak_pricing_enabled:true,current_price_multiplier:9});
    for(const html of [render(ConsoleModelsSquare,{models:{items:[m]},loading:false,error:null}),render(ModelOfferCard,{m}),render(OfferPrices,{m}),render(ModelTable,{groups:[{model_name:m.model_name,offers:[m]}],onOpen:()=>{}})]) {
      const text=plain(html);expect(text).toContain("720p");expect(text).toContain("无参考视频");expect(text).toContain("有参考视频");expect(text).toContain("¥0.125/秒");expect(text).toContain("¥2/成功任务次");expect(text).toContain("成功任务结算");expect(text).not.toContain("¥99");expect(text).not.toContain("¥1.125");
    }
    const detail=plain(render(ModelOfferCard,{m}));expect(detail).toContain("POST /v1/videos");expect(detail).not.toContain("POST /v1/video/generations");
    const list=plain(render(ConsoleModelsSquare,{models:{items:[m]},loading:false,error:null}));expect(list).toContain("视频同规格最低价排序");
  });
  it("compares resolution + reference + unit independently and keeps ties",()=>{
    const a=offer("a"),b=offer("b",{video_pricing:{endpoint:"/v1/videos",settlement:"success",quotes:[{resolution:"720p",has_reference_video:false,unit:"second",price:0.125},{resolution:"720p",has_reference_video:false,unit:"call",price:0.01},{resolution:"1080p",has_reference_video:true,unit:"second",price:0.001}]}});
    const minima=videoMinimums([a,b]);expect(minima).toHaveLength(5);
    const key=videoVariantKey(a,videoQuotes(a)[0]);
    expect(minima.find((v:{key:string})=>v.key===key)!.offers.map((m:ReturnType<typeof offer>)=>m.service_group_name)).toEqual(["a","b"]);
    expect(videoSortPrice([b],key)).toBe(0.125);
    expect(videoSortPrice([b],videoVariantKey(a,videoQuotes(a)[1]))).toBeUndefined();
    expect(videoSortPrice([b],videoVariantKey(a,videoQuotes(a)[2]))).toBeUndefined();
  });
  it("does not substitute a scalar or zero for missing standard specs, unset or invalid-free quotes",()=>{
    for(const m of [offer("empty",{video_pricing:{endpoint:"/v1/videos",settlement:"success",quotes:[]}}),offer("unset",{pricing_mode:"unset"}),offer("bad-free",{pricing_mode:"free"}),offer("old-standard",{video_pricing:undefined})]) {
      expect(videoQuotes(m)).toEqual([]);
      for(const component of [ModelOfferCard,OfferPrices]) { const text=plain(render(component,{m}));expect(text).toContain("未定价");expect(text).not.toContain("¥99");expect(text).not.toContain("¥0");expect(text).not.toContain("免费"); }
    }
  });
  it("retains old generic SSR, successful-call prices and endpoint without treating it as standard call",()=>{
    const m=offer("legacy",{video_pricing:undefined,chat_endpoint:"/v1/video/generations",price_per_call:0.25});
    expect(videoQuotes(m)).toEqual([{resolution:null,has_reference_video:null,unit:"call",price:0.25}]);
    const text=plain(render(ModelOfferCard,{m}));expect(text).toContain("¥0.25/成功任务次");expect(text).toContain("POST /v1/video/generations");expect(text).toContain("不按秒计费");
    expect(videoMinimums([m,offer("standard")])).toHaveLength(4);
  });
});
let db:RealD1,env:Env;
describe("marketplace standard video service projection (SQLite, no upstream)",()=>{
  beforeEach(async()=>{db=createRealD1();env=makeEnv(db);await seedDevice(db);seedProvider(db,{api_key:"PRIVATE_KEY",endpoint:"https://private.invalid/v1"});seedModel(db,{...row,config_json:JSON.stringify({...config,headers:{authorization:"PRIVATE_HEADER"}})});});
  afterEach(()=>{vi.restoreAllMocks();db.close();});
  async function market(){const response=await consoleApp.request("https://gw.test/model-marketplace",{headers:{authorization:"Bearer "+TOKEN}},env);expect(response.status).toBe(200);return await response.json() as {items:Array<ReturnType<typeof offer>>};}
  it("uses each authorized group multiplier on quotes, does not modify config or call provider",async()=>{
    for(const [name,multiplier] of [["cheap",0.5],["premium",2]] as const){const sg=await createServiceGroup(env,{name,multiplier,public_selectable:1});await upsertServiceGroupModel(env,sg.id,{model_key:"public-video",target_type:"model",target_id:"model_a"});}
    const before=db.rows("SELECT config_json FROM models"),f=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("no upstream"));
    const body=await market(),rates=new Map(body.items.map(m=>[m.service_group_name,m.video_pricing!.quotes[0].price]));
    expect(rates.get("cheap")).toBe(0.0625);expect(rates.get("premium")).toBe(0.25);expect(rates.get("旧版默认")).toBe(0.125);
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE_KEY|PRIVATE_HEADER|private.invalid|config_json|secure_skill/);
    expect(db.rows("SELECT config_json FROM models")).toEqual(before);expect(f).not.toHaveBeenCalled();
  });
  it("does not advertise a scalar service override as an applicable variant rate",async()=>{
    const sg=await createServiceGroup(env,{name:"override",public_selectable:1});await upsertServiceGroupModel(env,sg.id,{model_key:"public-video",target_type:"model",target_id:"model_a",pricing_json:JSON.stringify({price_per_call:1})});
    const item=(await market()).items.find(m=>m.service_group_id===sg.id)!;expect(item.video_pricing!.quotes).toEqual([]);
  });
});
