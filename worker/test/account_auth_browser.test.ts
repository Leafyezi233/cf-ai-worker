import { expect, it } from "vitest";
import { createRequire } from "node:module";
const nodeRequire = createRequire(import.meta.url);
const { createServer } = nodeRequire("node:http");
const { spawn } = nodeRequire("node:child_process");
const { mkdtemp, readFile, rm } = nodeRequire("node:fs/promises");
const { existsSync } = nodeRequire("node:fs");
const { tmpdir } = nodeRequire("node:os");
const { basename, dirname, join, resolve } = nodeRequire("node:path");
const { fileURLToPath } = nodeRequire("node:url");
const { once } = nodeRequire("node:events");
const { Buffer } = nodeRequire("node:buffer");
const nodeProcess = nodeRequire("node:process") as { env: Record<string, string | undefined>; platform: string };

const browserPath = nodeProcess.env.AUTH_TEST_BROWSER;
const browserTest = browserPath && existsSync(browserPath) ? it : it.skip;
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url)) as ((id: string) => any) & { resolve(id: string): string };
const esbuild = createRequire(requireWeb.resolve("vite"))("esbuild");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

browserTest("real browser: conflicting setup clears credentials, refreshes the actual step and never logs in automatically", async () => {
  const source = 'import React from "react";import {createRoot} from "react-dom/client";import ConsolePage from "./src/pages/ConsolePage";import {ToastProvider} from "./src/components/Toast";sessionStorage.clear();sessionStorage.setItem("cpg.console.token","local-browser-token");createRoot(document.getElementById("root")).render(<ToastProvider><ConsolePage/></ToastProvider>);';
  const bundle = await esbuild.build({ stdin: { contents: source, loader: "tsx", resolveDir: fileURLToPath(new URL("../../web", import.meta.url)) }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  let scenario = "conflict";
  let hasPassword = false;
  const requests: Array<{ path: string; session: string | string[] | undefined; body?: any; pageCase: string | null }> = [];
  const server = createServer(async (req: any, res: any) => {
    try {
      const path = req.url!.split("?")[0];
      if (path === "/fixture.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundle.outputFiles[0].text); return; }
      if (!path.startsWith("/console/")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end('<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>'); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      const pageCase = req.headers.referer ? new URL(req.headers.referer).searchParams.get("case") : null;
      requests.push({ path, session: req.headers["x-console-session"], body: text ? JSON.parse(text) : undefined, pageCase });
      let status = 200;
      let value: unknown = { items: [], limit: 5, remaining: 5 };
      if (path === "/console/auth/session") value = { device_name: "Local fixture", password_setup_required: !hasPassword, authenticated: hasPassword && req.headers["x-console-session"] === "local-browser-session" };
      else if (path === "/console/auth/setup") {
        hasPassword = scenario !== "reset";
        if (scenario === "success") value = { ok: true, session: "local-browser-session", password_updated_at: 1 };
        else { status = 409; value = { error: scenario === "already" ? "password_already_set" : "password_setup_conflict", message: "密码状态已变化，请重新验证。" }; }
      } else if (path === "/console/auth/login") {
        if (JSON.parse(text).password !== "winner-password") { status = 401; value = { error: "invalid_password" }; }
        else value = { ok: true, session: "local-browser-session" };
      } else if (path === "/console/me") value = { device: { id: "local", name: "Local fixture", enabled: true } };
      else if (path === "/console/usage") value = { items: [], daily: [], by_model: [], page: { limit: 50 }, summary: {} };
      else if (path === "/console/routing-policy") { status = 503; value = { error: "fixture_policy_unavailable" }; }
      else if (path === "/console/quota") value = { available_usd: 0, reserved_usd: 0 };
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const profile = await mkdtemp(join(tmpdir(), "cpg-auth-browser-"));
  const browser = spawn(browserPath!, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
  let socket: any;
  try {
    let debuggingPort = "";
    for (let i = 0; i < 100; i++) {
      try { debuggingPort = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]; break; }
      catch { await delay(50); }
    }
    if (!debuggingPort) throw new Error("browser did not publish DevToolsActivePort");
    const pages = await (await fetch("http://127.0.0.1:" + debuggingPort + "/json/list")).json() as any[];
    socket = new (globalThis as any).WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", reject, { once: true }); });
    let sequence = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const browserErrors: string[] = [];
    socket.addEventListener("message", (event: any) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request?.reject(new Error(JSON.stringify(message.error))); else request?.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") browserErrors.push(JSON.stringify(message.params));
    });
    const cdp = (method: string, params = {}) => new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression: string) => {
      const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = async (expression: string) => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(30); }
      throw new Error("browser wait failed: " + expression + "\n" + await evaluate("document.body.innerText"));
    };
    const fillAndSubmit = async (password: string, autofill = false) => {
      await evaluate('document.querySelectorAll("input[type=password]").forEach(e=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,' + JSON.stringify(password) + ');' + (autofill ? "" : 'e.dispatchEvent(new Event("input",{bubbles:true}));') + '})');
      await evaluate('document.querySelector("form").requestSubmit()');
    };
    await cdp("Runtime.enable"); await cdp("Page.enable");
    for (const current of ["conflict", "already", "reset", "success"]) {
      scenario = current; hasPassword = false; requests.length = 0;
      const currentRequests = () => requests.filter(request => request.pageCase === current);
      await cdp("Page.navigate", { url: "http://127.0.0.1:" + port + "/?case=" + current });
      await waitFor('document.querySelectorAll("input[type=password]").length===2');
      await fillAndSubmit("losing-password", current === "reset");
      if (current === "success") {
        await waitFor('document.querySelector("h1")?.textContent==="我的用量"');
        expect(await evaluate('sessionStorage.getItem("cpg.console.session")')).toBe("local-browser-session");
        expect(currentRequests().filter(r => r.path === "/console/auth/setup")).toHaveLength(1);
        expect(currentRequests().some(r => r.path === "/console/auth/session" && r.session === "local-browser-session")).toBe(true);
      } else {
        await waitFor('document.querySelector("[role=alert]")?.textContent.includes("密码状态已变化，请重新验证。")');
        await waitFor(current === "reset" ? 'document.querySelectorAll("input[type=password]").length===2' : 'document.querySelectorAll("input[type=password]").length===1');
        expect(await evaluate('Array.from(document.querySelectorAll("input[type=password]")).map(e=>e.value)')).toEqual(current === "reset" ? ["", ""] : [""]);
        expect(await evaluate('sessionStorage.getItem("cpg.console.session")')).toBeNull();
        expect(await evaluate('document.querySelector("h1")?.textContent === "我的用量"')).toBe(false);
        expect(currentRequests().filter(r => r.path === "/console/auth/setup")).toHaveLength(1);
        expect(currentRequests().filter(r => r.path === "/console/auth/login")).toHaveLength(0);
        expect(currentRequests().filter(r => r.path === "/console/auth/session").length).toBeGreaterThanOrEqual(2);
        expect(currentRequests().some(r => r.session)).toBe(false);
        if (current === "conflict") {
          await fillAndSubmit("winner-password");
          await waitFor('document.querySelector("h1")?.textContent==="我的用量"');
          expect(currentRequests().filter(r => r.path === "/console/auth/login")).toHaveLength(1);
        }
      }
    }
    expect(browserErrors).toEqual([]);
    console.log("REAL_BROWSER_AUTH_OK: setup409/already-set/reset clear fields, session refresh selects setup/login, no automatic login, explicit winner login and Set-Cookie-less setup use header fallback");
  } finally {
    const exited = browser.exitCode === null ? once(browser, "exit") : Promise.resolve();
    if (socket?.readyState === 1) socket.send(JSON.stringify({ id: 2147483647, method: "Browser.close" }));
    await Promise.race([exited, delay(3000)]);
    if (browser.exitCode === null) {
      if (nodeProcess.platform === "win32") { const killer = spawn("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" }); await once(killer, "exit"); }
      else browser.kill();
      await Promise.race([exited, delay(3000)]);
    }
    socket?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith("cpg-auth-browser-")) throw new Error("Unexpected auth browser cleanup path: " + profile);
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 60000);
