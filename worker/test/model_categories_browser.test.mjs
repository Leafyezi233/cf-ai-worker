import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { modelCategoriesApp } from "../src/admin/model-categories";
import { ensureModelCategoriesSchema, restoreModelCategoriesStatements } from "../src/db/model_categories";
import { createRealD1 } from "./helpers/realD1";
const browserPath = process.env.CATEGORY_TEST_BROWSER;
const browserTest = browserPath && existsSync(browserPath) ? it : it.skip;
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const esbuild = createRequire(requireWeb.resolve("vite"))("esbuild");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
browserTest("real browser: category CRUD, confirmed batch operations and public filters against SQLite", async () => {
  const db = createRealD1({ init: [], alters: [] });
  const env = { DB: db.DB };
  await ensureModelCategoriesSchema(env);
  const categories = ["code", "art", "research"].map((id, i) => ({ id, name: "分类-" + id, description: "用途-" + id, color: "blue", enabled: 1, sort_order: i }));
  await env.DB.batch(restoreModelCategoriesStatements(env, { model_categories: categories, model_category_bindings: categories.map((c) => ({ model_name: "shared", category_id: c.id })) }));
  const offer = (group, input, output) => ({ id: group, model_name: "shared", service_group_id: group, service_group_name: group, model_type: "text", pricing_mode: "priced", billing_unit: "token", chat_endpoint: "/v1/chat/completions", supports_reasoning: true, input_price_per_m: input, output_price_per_m: output, categories });
  const items = [offer("cheap-input", 1, 9), offer("cheap-output", 5, 2), { ...offer("plain", 7, 8), model_name: "plain", supports_reasoning: false, categories: [] }];
  const fixtureSource = 'import React from "react"; import {createRoot} from "react-dom/client";import {ModelCategoryManager,ModelCategoryAssignment,useModelCategories} from "./src/components/ModelCategories";import {ConsoleModelsSquare} from "./src/components/ConsoleModelsSquare";window.__confirmCalls=[];window.__confirmResult=true;window.confirm=(s)=>{window.__confirmCalls.push(s);return window.__confirmResult};function App(){const state=useModelCategories();return <><section id="admin"><ModelCategoryManager state={state}/><ModelCategoryAssignment state={state} modelNames={["shared","second"]} label="批量测试"/></section><section id="square"><ConsoleModelsSquare models={{items:' + JSON.stringify(items) + '}} loading={false} error={null}/></section></>};createRoot(document.getElementById("root")).render(<App/>);';
  const bundle = await esbuild.build({ stdin: { contents: fixtureSource, loader: "tsx", resolveDir: fileURLToPath(new URL("../../web", import.meta.url)) }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  const writes = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.url?.startsWith("/api/model-categories")) {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        if (req.method !== "GET") writes.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : void 0 });
        const response = await modelCategoriesApp.request("http://test" + (req.url.slice("/api/model-categories".length) || "/"), { method: req.method, headers: { "content-type": "application/json" }, ...body ? { body } : {} }, env);
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(await response.text());
      } else if (req.url === "/fixture.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(bundle.outputFiles[0].text);
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end('<!doctype html><html><body><div id="root"></div><script src="/fixture.js"><\/script></body></html>');
      }
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const profile = await mkdtemp(join(tmpdir(), "cpg-category-browser-"));
  const browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
  let socket;
  try {
    const { readFile } = await import("node:fs/promises");
    let debuggingPort = "";
    for (let i = 0; i < 100; i++) {
      try {
        debuggingPort = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
        break;
      } catch {
        await delay(50);
      }
    }
    if (!debuggingPort) throw new Error("browser did not publish DevToolsActivePort");
    const pages = await (await fetch("http://127.0.0.1:" + debuggingPort + "/json/list")).json();
    socket = new globalThis.WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let seq = 0;
    const pending =   new Map();
    const browserErrors = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const p = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) p?.reject(new Error(JSON.stringify(message.error)));
        else p?.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") browserErrors.push(JSON.stringify(message.params));
    });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const waitFor = async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await delay(30);
      }
      throw new Error("browser wait failed: " + expression + "\n" + await evaluate("document.body.innerText"));
    };
    const click = async (text, scope = "document") => {
      await evaluate("(()=>{const b=Array.from(" + scope + '.querySelectorAll("button")).find(b=>b.textContent.trim()===' + JSON.stringify(text) + ');if(!b)throw new Error("button missing: "+' + JSON.stringify(text) + ");b.click()})()");
      await delay(30);
    };
    const input = async (selector, value) => {
      await evaluate("(()=>{const e=document.querySelector(" + JSON.stringify(selector) + ');Object.getOwnPropertyDescriptor(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value").set.call(e,' + JSON.stringify(value) + ');e.dispatchEvent(new Event("input",{bubbles:true}))})()');
      await delay(30);
    };
    await cdp("Runtime.enable");
    await cdp("Page.enable");
    await cdp("Page.navigate", { url: "http://127.0.0.1:" + port });
    await waitFor('document.querySelectorAll("#admin tbody tr").length===3');
    expect(await evaluate('document.querySelector("#square").innerText')).toContain("全部分类 (2)");
    expect(await evaluate('document.querySelector("#square").innerText')).toContain("分类-code (1)");
    expect(await evaluate('Array.from(document.querySelectorAll("#square [role=button]")).find(e=>e.textContent.includes("shared")).innerText')).toContain("+1");
    await click("分类-code (1)", 'document.querySelector("#square")');
    await waitFor('document.querySelectorAll("#square [role=button]").length===1');
    const selectedText = await evaluate('document.querySelector("#square").innerText');
    expect(selectedText).toContain("输入最低");
    expect(selectedText).toContain("¥1");
    expect(selectedText).toContain("¥2");
    expect(selectedText).toContain("2 个授权组报价");
    expect(await evaluate(`document.querySelectorAll('#square [aria-label="分类筛选"] [aria-pressed="true"]').length`)).toBe(1);
    await evaluate('document.querySelector("#square details summary").click()');
    await click("推理", 'document.querySelector("#square")');
    await click("按次", 'document.querySelector("#square")');
    await waitFor('document.querySelector("#square").innerText.includes("没有符合筛选条件的模型")');
    await click("清除筛选", 'document.querySelector("#square")');
    await waitFor('document.querySelectorAll("#square [role=button]").length===2');
    await input("#square input", "用途-code");
    await waitFor('document.querySelectorAll("#square [role=button]").length===1');
    await evaluate('document.querySelector("#square [role=button]").click()');
    await waitFor('Array.from(document.querySelectorAll("h3")).some(e=>e.textContent==="shared")');
    expect(await evaluate(`Array.from(document.querySelectorAll('#square [aria-label="模型分类"]')).at(-1).innerText`)).toContain("分类-research");
    await click("✕", 'document.querySelector("#square")');
    await click("清除筛选", 'document.querySelector("#square")');
    await evaluate('document.querySelector("#admin details summary").click()');
    await input('#admin input[maxlength="80"]', "browser-created");
    await click("创建分类");
    await waitFor('document.querySelectorAll("#admin tbody tr").length===4');
    expect(db.row("SELECT name FROM model_categories WHERE name='browser-created'")).toEqual({ name: "browser-created" });
    await evaluate('Array.from(document.querySelectorAll("#admin tbody tr")).find(r=>r.textContent.includes("browser-created")).querySelector("button").click()');
    await input('#admin input[maxlength="80"]', "browser-edited");
    await click("保存分类");
    await waitFor('document.querySelector("#admin tbody").textContent.includes("browser-edited")');
    await click("批量测试（2 个公开名）");
    await evaluate(`document.querySelector('select[aria-label="分类操作"]').value="replace";document.querySelector('select[aria-label="分类操作"]').dispatchEvent(new Event("change",{bubbles:true}));window.__confirmResult=false`);
    const before = writes.length;
    await click("确认并保存分类");
    expect(writes.length).toBe(before);
    expect(await evaluate("window.__confirmCalls.at(-1)")).toContain("清空全部关联");
    await evaluate("window.__confirmResult=true");
    await click("确认并保存分类");
    await waitFor('!document.body.textContent.includes("确认并保存分类")');
    expect(db.rows("SELECT * FROM model_category_bindings WHERE model_name IN ('shared','second')")).toEqual([]);
    for (const operation of ["add", "remove"]) {
      await click("批量测试（2 个公开名）");
      await evaluate(`document.querySelector('select[aria-label="分类操作"]').value=${JSON.stringify(operation)};document.querySelector('select[aria-label="分类操作"]').dispatchEvent(new Event("change",{bubbles:true}));Array.from(document.querySelectorAll("fieldset label")).find(e=>e.textContent.includes("分类-code")).querySelector("input").click()`);
      await click("确认并保存分类");
      await waitFor('!document.body.textContent.includes("确认并保存分类")');
      expect(db.rows("SELECT * FROM model_category_bindings WHERE category_id='code'")).toHaveLength(operation === "add" ? 2 : 0);
    }
    await evaluate('Array.from(document.querySelectorAll("#admin tbody tr")).find(r=>r.textContent.includes("browser-edited")).querySelectorAll("button")[1].click()');
    await waitFor('document.querySelectorAll("#admin tbody tr").length===3');
    expect(db.rows("SELECT * FROM model_categories WHERE name='browser-edited'")).toEqual([]);
    expect(writes.filter((w) => w.path.endsWith("/bindings")).map((w) => w.body.operation)).toEqual(["replace", "add", "remove"]);
    expect(browserErrors).toEqual([]);
    console.log("REAL_BROWSER_CATEGORIES_OK: create/edit/delete, confirmed cancel/replace/add/remove, SQLite persistence, category/search/capability/billing intersections, distinct-name counts, 2+N/detail labels and quote minima");
  } finally {
    const exited = browser.exitCode === null ? once(browser, "exit") : Promise.resolve();
    if (socket?.readyState === 1) socket.send(JSON.stringify({ id: 2147483647, method: "Browser.close" }));
    await Promise.race([exited, delay(3e3)]);
    if (browser.exitCode === null) {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
        await once(killer, "exit");
      } else browser.kill();
      await Promise.race([exited, delay(3e3)]);
    }
    socket?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    db.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 6e4);
