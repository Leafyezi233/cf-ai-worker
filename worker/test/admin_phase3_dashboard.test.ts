import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const f=vi.hoisted(()=>({get:vi.fn(),search:"",query:undefined as any}));
vi.mock("../../web/src/api/client",()=>({api:{get:f.get},fmtNum:String,fmtTime:String}));
vi.mock("../../web/src/hooks/useTheme",()=>({useTheme:()=>({resolvedTheme:"light"})}));
vi.mock("../../web/src/hooks/useQuery",()=>({useQuery:(key:string,fetcher:any,options:any)=>{f.query={key,fetcher,options};return {data:undefined,loading:false,refresh:vi.fn()};}}));
const requireWeb=createRequire(new URL("../../web/package.json",import.meta.url));
vi.doMock((requireWeb as any).resolve("react-router-dom"),()=>({useLocation:()=>({pathname:"/dashboard",search:f.search,hash:""}),useNavigate:()=>vi.fn(),Link:({children}:any)=>children}));
const React=requireWeb("react");const {renderToStaticMarkup}=requireWeb("react-dom/server");
const pagePath="../../web/src/pages/DashboardPage";const {default:DashboardPage}=await import(pagePath);
const stats={range:"today",since:0,summary:{request_count:1,input_tokens:0,output_tokens:0,total_tokens:0,cost_usd:0,avg_latency_ms:0,error_count:0,cache_hit_count:0},byProvider:[],byModel:[],trend:[]};
beforeEach(()=>{vi.clearAllMocks();f.search="";vi.stubGlobal("window",{location:{origin:"https://local.test"}});f.get.mockImplementation(async(path:string)=>path.includes("/stats?")?stats:path.includes("cache-stats")?{cost_saved_usd:0}:path.includes("settings")?{}:{items:[]});});
describe("dashboard bounded range and request cost",()=>{
 it("retains default 7 request ceiling and opts into 30s reuse",async()=>{renderToStaticMarkup(React.createElement(DashboardPage));await f.query.fetcher();expect(f.get).toHaveBeenCalledTimes(7);expect(f.query.options).toEqual({ttlMs:30000,revalidateIfFresh:false});});
 it.each(["7d","30d"])("deduplicates equal stats ranges for %s",async(range)=>{f.search="?list_range="+range;renderToStaticMarkup(React.createElement(DashboardPage));await f.query.fetcher();expect(f.get).toHaveBeenCalledTimes(6);expect(f.get.mock.calls.filter(([url])=>url==="/api/usage/stats?range="+range)).toHaveLength(1);expect(f.query.key).toBe("dashboard-data:"+range);expect(f.get).toHaveBeenCalledWith("/api/usage/cache-stats?range="+range);});
 it("rejects failed primary stats instead of caching successful zeros",async()=>{f.get.mockRejectedValueOnce(Error("db_unavailable"));renderToStaticMarkup(React.createElement(DashboardPage));await expect(f.query.fetcher()).rejects.toThrow("db_unavailable");});
 it("reports failed secondary areas",async()=>{f.get.mockImplementation(async(p:string)=>{if(p.includes("cache-stats"))throw Error("failed");return p.includes("/stats?")?stats:p.includes("settings")?{}:{items:[]};});renderToStaticMarkup(React.createElement(DashboardPage));expect((await f.query.fetcher()).failedSections).toContain("缓存统计");});
 it("rejects unknown URL range and displays fixed statistical scopes",()=>{f.search="?list_range=all";const html=renderToStaticMarkup(React.createElement(DashboardPage));expect(f.query.key).toBe("dashboard-data:today");expect(html).toContain("趋势固定近7日");expect(html).toContain("查看对应范围用量");});
});
