import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const mocks=vi.hoisted(()=>({post:vi.fn(async()=>({})),put:vi.fn(async()=>({})),refresh:vi.fn(async()=>{})}));
vi.mock("../../web/src/api/client",()=>({api:{post:mocks.post,put:mocks.put},ApiError:class extends Error{}}));
vi.mock("../../web/src/hooks/useQuery",()=>({useQuery:()=>({data:{items:[],providers:[]},loading:false,error:null,refresh:mocks.refresh}),invalidateCache:vi.fn()}));
vi.mock("../../web/src/components/Toast",()=>({useToast:()=>({success:vi.fn(),error:vi.fn()})}));
const requireWeb=createRequire(new URL("../../web/package.json",import.meta.url)),React=requireWeb("react");
vi.doMock((requireWeb as any).resolve("react-router-dom"), () => ({
  useLocation: () => ({ pathname: "/admin/models", search: "", hash: "" }),
  useNavigate: () => vi.fn(),
}));
const pagePath="../../web/src/pages/ModelsPage.tsx";
const {default:ModelsPage}=await import(pagePath);
const video={adapter:"doubao",upstream_model:"doubao-seedance-2-5-260628",ratios:["16:9"],resolutions:["720p"],default_resolution:"720p",default_ratio:"16:9",default_duration:4,seconds_min:4,seconds_max:30,min_images:0,max_images:0,max_videos:0,max_audios:0,max_total_refs:0,support_first_last:false,support_video_urls:false,support_audio_urls:false,support_audio_only:false,max_audio_only:0,use_asset_library:true,poll_interval_ms:15000,quotes:[{resolution:"720p",has_reference_video:false,unit:"second",price:0.18}]};
const raw=JSON.stringify({model_type:"video",custom:{keep:true},video});
const form=(extra:Record<string,unknown>={})=>({provider_id:"p",model_name:"public-video",display_name:"",description:"",alias:"",fallback_model_id:"",input_price_per_m:"",output_price_per_m:"",cache_read_price_per_m:"",cache_write_price_per_m:"",billing_unit:"call",price_per_call:"",search_price_per_call:"",pricing_mode:"auto",cache_enabled:false,cache_ttl:"3600",model_public:false,enabled:true,config_json:raw,capabilities:[],routing_strategy:"priority",weight:10,system_prompt:"",system_prompt_mode:"prepend",max_tokens_limit:"",model_rewrite:"",supports_search_tool:false,...extra});
type Element={type?:any;props?:Record<string,any>};
function nodes(node:unknown):Element[]{if(Array.isArray(node))return node.flatMap(nodes);if(!node||typeof node!=="object")return [];const e=node as Element;return [e,...nodes(e.props?.children)];}
function harness(seed=form()){
  vi.stubGlobal("window",{location:{origin:"https://gateway.test"}});
  const slots:any[]=[],internal=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  let index=0,tree:unknown;
  const dispatcher={useState(initial:any){const i=index++;if(!(i in slots))slots[i]=i===0?true:i===3?seed:typeof initial==="function"?initial():initial;return [slots[i],(value:any)=>{slots[i]=typeof value==="function"?value(slots[i]):value;}];},useMemo:(factory:()=>unknown)=>factory(),useCallback:(callback:unknown)=>callback,useEffect:()=>{},useRef:(initial:unknown)=>({current:initial})};
  function render(){index=0;const prev=internal.current;internal.current=dispatcher;try{tree=ModelsPage();}finally{internal.current=prev;}return nodes(tree);}
  return {render,get form(){return slots[3];},async submit(){const target=render().find(n=>n.type==="form"&&n.props?.onSubmit);expect(target).toBeDefined();await target!.props!.onSubmit({preventDefault:vi.fn()});}};
}
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();});
describe("video settings parent save and deliberate mode selection",()=>{
  it("cancels auto-mode warning before a model write and leaves its quote untouched",async()=>{
    const confirm=vi.fn((_message:string)=>false);vi.stubGlobal("confirm",confirm);const h=harness();await h.submit();
    expect(confirm.mock.calls[0]?.[0]).toContain("确认保留自动模式并保存");expect(mocks.post).not.toHaveBeenCalled();expect(h.form.config_json).toBe(raw);
  });
  it("explicitly preserving auto keeps inference undefined and exact per-second price",async()=>{
    vi.stubGlobal("confirm",vi.fn((_message:string)=>true));const h=harness();await h.submit();
    expect(mocks.post).toHaveBeenCalledTimes(1);const [path,body]=mocks.post.mock.calls[0] as unknown as [string,any];
    expect(path).toBe("/api/models");expect(body.pricing_mode).toBeUndefined();expect(JSON.parse(body.config_json)).toMatchObject({custom:{keep:true},video:{quotes:[{unit:"second",price:0.18}]}});
  });
  it("priced mode saves only after the existing capability confirmation, without auto warning",async()=>{
    const confirm=vi.fn((_message:string)=>true);vi.stubGlobal("confirm",confirm);await harness(form({pricing_mode:"priced"})).submit();
    expect(confirm).toHaveBeenCalledTimes(1);expect(confirm.mock.calls[0]?.[0]).not.toContain("确认保留自动模式");
    const body=(mocks.post.mock.calls[0] as unknown as [string,any])[1];expect(body.pricing_mode).toBe("priced");expect(body.price_per_call).toBe(0);
  });
  it("parent explicit-mode callback changes only pricing_mode, not price, unit or draft",()=>{
    const h=harness(),notice=h.render().find(n=>n.type?.name==="VideoPricingModeNotice");expect(notice).toBeDefined();
    notice!.props!.onChoosePriced();expect(h.form.pricing_mode).toBe("priced");expect(h.form.config_json).toBe(raw);expect(h.form.price_per_call).toBe("");
  });
  it("invalid default specs still fail strict saving before any confirmation or write",async()=>{
    const confirm=vi.fn((_message:string)=>true);vi.stubGlobal("confirm",confirm);const h=harness(form({config_json:JSON.stringify({model_type:"video",video:{...video,default_resolution:""}})}));await h.submit();
    expect(confirm).not.toHaveBeenCalled();expect(mocks.post).not.toHaveBeenCalled();
  });
});
