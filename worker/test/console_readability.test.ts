import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const fixture = vi.hoisted(() => ({ quota: null as any, usage: null as any, error: false }));
vi.mock("../../web/src/hooks/useQuery", () => ({
  useQuery: (key: string | null) => ({data: key?.endsWith(":session") ? {authenticated:true,password_setup_required:false} : key?.endsWith(":me") ? {device:{id:"device",name:"My account",enabled:true}} : key?.endsWith(":quota") ? fixture.quota : key?.includes(":usage:") ? fixture.usage : undefined,
    error: fixture.error && (key?.endsWith(":quota") || key?.includes(":usage:")) ? Error("offline") : null, loading:false, refresh:vi.fn(),mutate:vi.fn()}), invalidateCache:vi.fn(),
}));
vi.mock("../../web/src/components/ConsoleAccount", () => ({ AccountPanel:()=>null,PasswordScreen:()=>null }));
vi.mock("../../web/src/components/ConsoleChatCard", () => ({ ConsoleChatCard:()=>null }));
vi.mock("../../web/src/components/ConsoleModelsSquare", () => ({ ConsoleModelsSquare:()=>null }));
vi.mock("../../web/src/components/ConsoleGuide", () => ({ ConsoleGuide:()=>null }));
vi.mock("../../web/src/components/ConsoleVideoCard", () => ({ ConsoleVideoCard:()=>null }));
vi.mock("../../web/src/components/ConsoleStandardVideoCard", () => ({ ConsoleStandardVideoCard:()=>null }));
vi.mock("../../web/src/components/ConsoleMonthlyPass", () => ({default:()=>null}));
const requireWeb=createRequire(new URL("../../web/package.json",import.meta.url));
const {createElement}=requireWeb("react"),{renderToStaticMarkup}=requireWeb("react-dom/server");
const navPath="../../web/src/components/ConsoleNavigation.tsx",pagePath="../../web/src/pages/ConsolePage.tsx";
const {ConsoleNavigation,ConsoleSectionIntro,CONSOLE_SECTIONS}=await import(navPath);
const {default:ConsolePage}=await import(pagePath);
const render=(C:any,props:any={})=>renderToStaticMarkup(createElement(C,props));
function page(section = "overview"){vi.stubGlobal("window",{location:{search:"?section="+section}});vi.stubGlobal("sessionStorage",{getItem:(k:string)=>k==="cpg.console.token"?"private-token":null,setItem:()=>{},removeItem:()=>{}});return render(ConsolePage);}
afterEach(()=>{vi.unstubAllGlobals();fixture.quota=null;fixture.usage=null;fixture.error=false;});
describe("readable user console presentation",()=>{
 it("renders seven descriptive section buttons with one active section",()=>{const html=render(ConsoleNavigation,{active:"overview",onChange:()=>{}});expect(html.match(/<button/g)).toHaveLength(7);expect(html.match(/aria-current="page"/g)).toHaveLength(1);expect(html).toContain('aria-label="控制台导航"');for(const item of CONSOLE_SECTIONS){expect(html).toContain(item.label);expect(html).toContain(item.hint);}expect(html).toContain("overflow-x-auto");});
 it("only changes section on explicit navigation, without side effects on render",()=>{const cb=vi.fn();const tree=ConsoleNavigation({active:"overview",onChange:cb});expect(cb).not.toHaveBeenCalled();const video=tree.props.children.find((child:any)=>child.props.section==="video");video.type(video.props).props.onClick();expect(cb).toHaveBeenCalledTimes(1);expect(cb).toHaveBeenCalledWith("video");});
 it.each(["overview","models","video","guide"])("has a plain-language introduction for %s",(section)=>{const html=render(ConsoleSectionIntro,{section});expect(html).toContain("<h2");expect(html).toContain("<p");if(section==="video"){expect(html).toContain("不要重复付费提交");expect(html).toContain("联系管理员");}if(section==="guide")expect(html).toContain("请勿放进公开链接");});
 it("separates balance from selected-period usage and keeps the recharge contact",()=>{fixture.quota={available_usd:-1.25,reserved_usd:0.5,monthly_cost_usd:3,monthly_cost_limit_usd:10};const html=page();expect(html).toContain("余额与额度");expect(page("usage")).toContain("用量统计 · 近 30 天");expect(html).not.toContain("按模型用量");expect(html).toContain("-¥1.2500");expect(html).toContain("预占中");expect(html).toContain("用量花费不等同于钱包扣款");expect(html).toContain("需要充值请联系管理员");expect(html).not.toContain("mailto:");expect(html).not.toContain("private-token");});
 it("shows missing-data and retry guidance instead of reporting empty usage on errors",()=>{fixture.error=true;const html=page("usage");expect(html).toContain("无法读取不代表没有调用记录");expect(html).toContain("暂时无法显示用量，请刷新重试");expect(html).not.toContain("所选时间范围内暂无调用记录");expect(html).not.toContain("¥0.0000");});
 it("offers range selection above scoped tables with accessible horizontal scrolling",()=>{fixture.usage={summary:{request_count:1,total_tokens:10,input_tokens:4,output_tokens:6,error_count:0,cost_usd:0.1},by_model:[{model:"model",request_count:1,total_tokens:10,cost_usd:0.1,pricing_missing_count:0}],items:[{id:1,created_at:1,model:"model",total_tokens:10,cost_usd:0.1}],daily:[],page:{limit:50}};const html=page("usage");expect(html).toContain('aria-label="用量时间范围"');expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);expect(html.indexOf("用量时间范围")).toBeLessThan(html.lastIndexOf("按模型用量"));expect(html).toContain('scope="col"');expect(html).toContain('tabindex="0"');expect(html).toContain("每页最多 50 条");});
 it("keeps mobile logout, skip link, token-scoped caches and mounted video tasks",()=>{const source=readFileSync(new URL(pagePath,import.meta.url),"utf8");expect(source).toContain('href="#console-main"');expect(source).toContain('className="md:hidden" onClick={logout}');expect(source).toContain('consoleAccountApi.logout().catch');expect(source).toContain('console:${scope}:usage:');expect(source).toContain('<div hidden={tab !== "video"}>');expect(source).toContain('key={"standard:" + token}');expect(source).not.toMatch(/\x00/);});
});
