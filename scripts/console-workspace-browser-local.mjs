import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
const root=fileURLToPath(new URL("../",import.meta.url));
const require=createRequire(realpathSync(path.join(root,"worker/node_modules/wrangler/package.json")));
const {Miniflare,convertV4MiniflareOptions}=require("miniflare");
const {build}=require("esbuild");
const bundle=process.env.CPG_FROZEN_DIR ? {outputFiles:[{text:readFileSync(path.join(process.env.CPG_FROZEN_DIR,"index.js"),"utf8")}]} : await build({entryPoints:[path.join(root,"worker/src/index.ts")],bundle:true,format:"esm",platform:"browser",write:false});
const assetsDirectory=process.env.CPG_FROZEN_DIR ? path.join(process.env.CPG_FROZEN_DIR,"assets") : path.join(root,"web/dist");
const mf=new Miniflare(convertV4MiniflareOptions({host:"127.0.0.1",port:0,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2024-11-01",d1Databases:["DB"],d1Persist:false,serviceBindings:{VIDEO_REFERENCE_IMAGES:async(request)=>{assert.equal(new URL(request.url).pathname,"/v1/video-assets/limits");return new Response(JSON.stringify({enabled:false}),{headers:{"Content-Type":"application/json"}});}},bindings:{ADMIN_SECRET:"local-browser-only",ADMIN_PATH_PREFIX:"admin-prefix-example",ENCRYPTION_KEY:"local-browser-encryption-only",IP_RATE_LIMIT_RPM:"0"},assets:{directory:assetsDirectory,binding:"ASSETS",routerConfig:{has_user_worker:true},run_worker_first:["/*","!/assets/*","!/favicon.svg","!/theme-boot.js"],assetConfig:{html_handling:"auto-trailing-slash",not_found_handling:"single-page-application"}},telemetry:{enabled:false}}));
const profile=await mkdtemp(path.join(tmpdir(),"cpg-admin-browser-"));
let browser,socket;const checks=[],errors=[],responses=[],requests=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const origin=(await mf.ready).origin;assert(origin.startsWith("http://127.0.0.1:"));
 const check=(name)=>{checks.push({name,ok:true});console.log("PASS "+name);};
 for(const p of ["/login","/settings","/__admin/admin.html","/wrong-prefix/login"]){const r=await fetch(origin+p,{redirect:"manual",headers:{Accept:"text/html"}});assert.equal(r.status,404,p+":"+(await r.text()).slice(0,1500));assert(!r.headers.has("location"));check("HTTP hidden "+p);}
 browser=spawn(process.env.EDGE_PATH || path.join(process.env["PROGRAMFILES(X86)"] || process.env.PROGRAMFILES || "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check","--disable-background-networking","--remote-debugging-address=127.0.0.1","--remote-debugging-port=0","--user-data-dir="+profile,"about:blank"],{stdio:"ignore"});
 let port;for(let i=0;i<100;i++){try{port=(await readFile(path.join(profile,"DevToolsActivePort"),"utf8")).split(String.fromCharCode(10))[0].trim();break;}catch{await delay(50);}}
 assert(port,"Browser debugging port unavailable");
 const pages=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();socket=new WebSocket(pages.find(p=>p.type==="page").webSocketDebuggerUrl);
 await once(socket,"open");let seq=0;const pending=new Map();
 socket.addEventListener("message",e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Error(JSON.stringify(m.error))):p?.resolve(m.result);}else if(m.method==="Runtime.exceptionThrown")errors.push(m.params.exceptionDetails.text+":"+(m.params.exceptionDetails.exception?.description??""));else if(m.method==="Network.requestWillBeSent"){const r=m.params.request;if(r.url.startsWith(origin))requests.push({path:new URL(r.url).pathname,method:r.method});}else if(m.method==="Network.responseReceived"){const r=m.params.response;if(r.url.startsWith(origin))responses.push({path:new URL(r.url).pathname,status:r.status});}});
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const ev=async(expression)=>{const r=await cdp("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const wait=async(expression)=>{for(let i=0;i<150;i++){if(await ev("Boolean("+expression+")"))return;await delay(50);}throw Error("Wait failed: "+expression+"; body="+await ev("document.body.innerText"));};
 await cdp("Runtime.enable");await cdp("Network.enable");await cdp("Page.enable");await cdp("Emulation.setDeviceMetricsOverride",{width:1280,height:960,deviceScaleFactor:1,mobile:false});
 await cdp("Page.navigate",{url:origin+"/admin-prefix-example/login"});await wait('!!document.querySelector("input[type=password]")');check("real browser login shell renders");
 await ev('(()=>{const e=document.querySelector("input[type=password]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"local-browser-only");e.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await ev('document.querySelector("form").requestSubmit()');await wait('location.pathname==="/admin-prefix-example/dashboard" && !!document.querySelector("aside")');check("form login and secure cookie session");
 const pagesToTest=["dashboard","providers","models","model-groups","service-groups","peak-pricing","devices","device-templates","monthly-passes","usage","playground","settings"];
 const api=async(p,method="GET",body)=>ev('(async()=>{const r=await fetch('+JSON.stringify("/admin-prefix-example/api"+p)+',{method:'+JSON.stringify(method)+',headers:{"X-Admin-Request":"1","Content-Type":"application/json"},'+(body===undefined?'':'body:JSON.stringify('+JSON.stringify(body)+'),')+'});return {status:r.status,text:await r.text()}})()');
 const db=await mf.getD1Database("DB");
 await db.prepare("INSERT INTO providers(id,name,type,endpoint,enabled,created_at,updated_at) VALUES ('local-p','Local','openai','https://no-upstream.invalid/v1',1,1,1)").run();
 await db.prepare("INSERT INTO models(id,provider_id,model_name,enabled,config_json,created_at,updated_at) VALUES ('local-m','local-p','local-chat',1,?,1,1)").bind(JSON.stringify({model_type:"text",input_modalities:["text"],context_window:64000,max_output_tokens:4096,chat_endpoint:"/v1/chat/completions"})).run();
 const created=await api("/devices","POST",{name:"Workspace local account",balance_usd:10});assert.equal(created.status,201);const credential=JSON.parse(created.text).token;
 await cdp("Page.navigate",{url:origin+"/console?section=overview"});await wait('!!document.querySelector("#console-token")');
 const setInput=async(selector,value)=>ev('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)throw Error("missing input "+'+JSON.stringify(selector)+');Object.getOwnPropertyDescriptor(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await setInput("#console-token",credential);await ev('document.querySelector("form").requestSubmit()');await wait('!!document.querySelector("#console-password-confirm")');
 await setInput("#console-password","LocalPassword123!");await setInput("#console-password-confirm","LocalPassword123!");await ev('document.querySelector("form").requestSubmit()');
 await wait('!!document.querySelector("nav[aria-label=控制台导航]")');check("native user account password setup and authenticated workspace");
 requests.length=0;await cdp("Page.reload");await wait('!!document.querySelector("nav[aria-label=控制台导航]")');await delay(700);
 const initial=requests.filter(r=>r.path.startsWith("/console/")&&r.method==="GET");const requestMetrics={initial:initial.map(r=>r.path)};
 if(process.env.CPG_WORKSPACE_BASELINE){await writeFile(path.join(root,"preview/console-workspace-baseline.json"),JSON.stringify({producer:"local-benchmark",timestamp:new Date().toISOString(),localOnly:true,requests:initial.map(r=>r.path)},null,2));console.log("BASELINE_REQUESTS="+JSON.stringify(initial.map(r=>r.path)));}
 else {
 assert(!initial.some(r=>["/console/models","/console/model-marketplace","/console/usage","/console/tokens","/console/calls"].includes(r.path)));check("overview does not eagerly fetch models, marketplace, usage, tokens or calls");
 assert(await ev('document.body.innerText.includes("快速开始") && !document.body.innerText.includes("按模型用量")'));check("overview shows next steps without billing tables");
 const screenshot=await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});await writeFile(path.join(root,"preview/console-workspace-overview-local.png"),Buffer.from(screenshot.data,"base64"));
 const nav=async(label,section)=>{await ev('Array.from(document.querySelectorAll("nav[aria-label=控制台导航] button")).find(b=>b.textContent.includes('+JSON.stringify(label)+')).click()');await wait('location.search.includes('+JSON.stringify("section="+section)+')');await delay(220);};
 await nav("API 密钥","keys");await wait('!!document.querySelector("input[placeholder*=ci-runner]")');await delay(400);check("independent API keys and original routing policy editor mount");
 await setInput("input[placeholder*=ci-runner]","Local app");await ev('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="新建").click()');await wait('document.body.innerText.includes("的明文如下")');
 const fresh=await ev('Array.from(document.querySelectorAll("code")).find(e=>e.textContent.startsWith("ccs_")||e.textContent.startsWith("csk_")||e.textContent.startsWith("cpg_")||e.textContent.startsWith("cps_")||e.textContent.length>35)?.textContent');assert(fresh);check("new sub-token secret appears exactly at successful creation");
 await nav("模型广场","models");await wait('document.body.innerText.includes("模型广场")');assert(!(await ev('document.documentElement.textContent')).includes(fresh));check("leaving keys clears plaintext even in hidden DOM");
 await nav("API 密钥","keys");assert(!(await ev('document.documentElement.textContent')).includes(fresh));check("returning keys cannot recover once-only secret");
 await nav("账户与安全","security");await wait('document.body.innerText.includes("主 Token 调用")');assert(!(await ev('document.querySelector("main").innerText')).includes("用途备注"));check("security view separates calls control from key editor");
 await nav("接入指南","guide");await wait('!!document.querySelector("[aria-label=接入客户端]")');assert((await ev('document.querySelector("main").innerText')).includes("$CPG_API_KEY"));assert(!(await ev('document.querySelector("main").innerText')).includes(credential));check("client wizard renders placeholder only, never master or generated token");
 const beforeWizard=requests.length;await ev('(()=>{const e=document.querySelector("[aria-label=接入客户端]");Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(e,"anthropic");e.dispatchEvent(new Event("change",{bubbles:true}));})()');await delay(250);assert.equal(requests.length,beforeWizard);check("wizard client change makes zero network requests");
 await ev('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("创建子 Token →")).click()');await wait('location.search.includes("section=keys")');check("wizard returns to keys without placing a credential in URL");
 await nav("用量与账单","usage");await wait('document.querySelector("main").innerText.includes("按模型用量")');check("usage gets own summary and request tables");
 await cdp("Page.reload");await wait('!!document.querySelector("nav[aria-label=控制台导航]") && document.querySelector("main").innerText.includes("按模型用量")');check("reload restores usage section from URL");
 await nav("视频任务","video");await wait('document.querySelector("main").innerText.includes("视频生成")');await ev('window.__videoIdentity=Array.from(document.querySelectorAll("main *")).find(e=>e.textContent==="视频生成");if(!window.__videoIdentity)throw Error("missing video root")');
 await nav("账户概览","overview");assert(await ev("window.__videoIdentity.isConnected"));await nav("视频任务","video");assert(await ev("window.__videoIdentity.isConnected"));check("video workspace stays mounted across navigation without paid submission");
 await cdp("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth+1'),true);check("390px workspace navigation does not overflow viewport");
 assert(!(await ev('location.href')).includes(credential));check("credentials absent from navigation URLs");
 assert(!requests.some(r=>r.method==="POST"&&(r.path.startsWith("/v1/")||r.path.includes("generations"))));check("no paid model or video generation request");
 const failures=responses.filter(r=>r.status>=500);assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);check("no browser runtime exceptions or HTTP 5xx");
 await writeFile(path.join(root,"preview/console-workspace-browser-local.json"),JSON.stringify({producer:"local-benchmark",timestamp:new Date().toISOString(),localOnly:true,realBrowser:true,nativeWorker:true,nativeD1:true,total:checks.length,passed:checks.length,checks,requestMetrics,localReferenceService:"Read-only limits fixture: uploads disabled. No production binding or paid calls.",http5xx:failures,errors},null,2));console.log("WORKSPACE_RESULT="+checks.length+"/"+checks.length);
 }

}catch(error){console.error(error.message);process.exitCode=1;}finally{
 if(socket?.readyState===1)socket.send(JSON.stringify({id:2147483647,method:"Browser.close"}));
 if(browser){await Promise.race([once(browser,"exit"),delay(2500)]);if(browser.exitCode===null){const killer=spawn("taskkill",["/PID",String(browser.pid),"/T","/F"],{stdio:"ignore"});await once(killer,"exit");}}
 socket?.close();await mf.dispose();await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}