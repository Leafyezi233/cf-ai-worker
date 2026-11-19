import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const fixture = vi.hoisted(() => ({ authenticated:true, queries:[] as {key:string|null,enabled:boolean}[] }));
vi.mock("../../web/src/hooks/useQuery", () => ({invalidateCache:vi.fn(),useQuery:(key:string|null,_fn:unknown,options:{enabled?:boolean}={}) => {fixture.queries.push({key,enabled:options.enabled!==false});return {data:key?.endsWith(":session")?{authenticated:fixture.authenticated,password_setup_required:false}:key?.endsWith(":me")?{device:{name:"Local",enabled:true}}:undefined,loading:false,error:null,refresh:async()=>{},mutate:()=>{}};}}));
vi.mock("../../web/src/components/ConsoleAccount",()=>({AccountPanel:()=>null,PasswordScreen:()=>null}));
vi.mock("../../web/src/components/ConsoleChatCard",()=>({ConsoleChatCard:()=>null}));
vi.mock("../../web/src/components/ConsoleModelsSquare",()=>({ConsoleModelsSquare:()=>null}));
vi.mock("../../web/src/components/ConsoleGuide",()=>({ConsoleGuide:()=>null}));
vi.mock("../../web/src/components/ConsoleVideoCard",()=>({ConsoleVideoCard:()=>null}));
vi.mock("../../web/src/components/ConsoleStandardVideoCard",()=>({ConsoleStandardVideoCard:()=>null}));
vi.mock("../../web/src/components/ConsoleMonthlyPass",()=>({default:()=>null}));
const requireWeb=createRequire(new URL("../../web/package.json",import.meta.url));const React=requireWeb("react"),{renderToStaticMarkup}=requireWeb("react-dom/server");
const navPath="../../web/src/components/ConsoleNavigation.tsx", pagePath="../../web/src/pages/ConsolePage.tsx";
const {readConsoleSection}=await import(navPath);const {default:ConsolePage}=await import(pagePath);
function render(section:string){fixture.queries=[];vi.stubGlobal("window",{location:{search:"?section="+section}});vi.stubGlobal("sessionStorage",{getItem:(k:string)=>k==="cpg.console.token"?"local-secret":null});return renderToStaticMarkup(React.createElement(ConsolePage));}
afterEach(()=>{vi.unstubAllGlobals();fixture.authenticated=true;fixture.queries=[];});
describe("user workspace section and demand data contract",()=>{
 it.each(["overview","models","video","guide","keys","usage","security"])("restores supported section %s",section=>expect(readConsoleSection("?section="+section)).toBe(section));
 it.each(["", "?section=__admin", "?section=https://evil.invalid", "?section=token"])("rejects unknown sections %s",s=>expect(readConsoleSection(s)).toBe("overview"));
 it.each(["overview","models","video","guide","keys","usage","security"])("only enables page data for %s",section=>{render(section);const enabled=(suffix:string)=>fixture.queries.find(q=>q.key?.endsWith(suffix))?.enabled;expect(enabled(":session")).toBe(true);expect(enabled(":models")).toBe(section==="guide"||section==="video");expect(enabled(":model-marketplace")).toBe(section==="models");expect(fixture.queries.find(q=>q.key?.includes(":usage:"))?.enabled).toBe(section==="usage");});
 it("does not start protected feature reads before authenticated session",()=>{fixture.authenticated=false;render("models");for(const q of fixture.queries.filter(q=>q.key?.includes(":usage:")||q.key?.endsWith(":models")||q.key?.endsWith(":model-marketplace")||q.key?.endsWith(":quota")))expect(q.enabled).toBe(false);});
 it("overview offers safe next steps without account editor or usage table",()=>{const html=render("overview");expect(html).toContain("快速开始");expect(html).toContain("配置客户端");expect(html).toContain("请求预占金额");expect(html).not.toContain("按模型用量");expect(html).not.toContain("local-secret");});
});
