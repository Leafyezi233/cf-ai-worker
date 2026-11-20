import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, TOKEN, makeEnv, seedDevice, seedModel, seedProvider } from "./helpers/realGatewayEnv";
import { ensureSchema } from "../src/db/schema";
import { ensureTokenPoliciesSchema } from "../src/db/token_policies";
import { consoleApp } from "../src/console/index";
import { buildUserSessionCookie, hashPassword, sha256Hex, signUserSession } from "../src/utils/crypto";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import type { Env } from "../src/types";
import { relativeTime } from "../../web/src/utils/relativeTime";

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const codePath = "../../web/src/components/CodeBlock.tsx";
const guidePath = "../../web/src/components/ConsoleGuide.tsx";
const trendPath = "../../web/src/components/UsageTrend.tsx";
const squarePath = "../../web/src/components/ConsoleModelsSquare.tsx";
const { highlight } = await import(codePath);
const { ConsoleConnectionWizard, ConsoleGuide, appSettings, agentSnippets, connectionApp, keyCheckFindings, CONNECTION_APPS } = await import(guidePath);
const { fillDailyUsage, niceCeiling } = await import(trendPath);
const { connectableModelId, modelMonogram } = await import(squarePath);

const secret = "pr3-console-session";
let d: RealD1, env: Env;

async function addKey(id: string, owner = DEVICE_ID, extra: { enabled?: number; revoked_at?: number | null } = {}) {
  const key = "ccs_key_" + id;
  d.sql("INSERT INTO device_sub_tokens(id,device_id,name,token_hash,enabled,created_at,revoked_at) VALUES(?,?,?,?,?,1,?)",
    id, owner, "key " + id, await sha256Hex(key), extra.enabled ?? 1, extra.revoked_at ?? null);
  return key;
}
async function call(path: string, body?: unknown, session = true) {
  const cookie = session ? buildUserSessionCookie(await signUserSession(secret, DEVICE_ID, 1)).split(";")[0] : "";
  return consoleApp.request("http://test" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + TOKEN, cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
}
const check = async (key: unknown) => (await call("/api-key-check", { key })).json() as Promise<any>;

beforeEach(async () => {
  resetRateLimitMemory(); clearMemoryCacheForTest();
  d = createRealD1(); env = { ...makeEnv(d), SESSION_SECRET: secret };
  await seedDevice(d, { balance_usd: 12.5 }); await ensureSchema(env); await ensureTokenPoliciesSchema(env);
  d.sql("UPDATE devices SET password_hash = ?, password_updated_at = 1 WHERE id = ?", await hashPassword("fixture-password"), DEVICE_ID);
  seedProvider(d); seedModel(d, { id: "m1", model_name: "chat-model", input_price_per_m: 1, output_price_per_m: 2 });
});
afterEach(() => { vi.unstubAllGlobals(); d.close(); });

describe("API key check (real SQLite)", () => {
  it("needs a console session and a key", async () => {
    expect((await call("/api-key-check", { key: "x" }, false)).status).toBe(401);
    expect((await call("/api-key-check", { key: "  " })).status).toBe(400);
    expect((await call("/api-key-check", { key: "x".repeat(1025) })).status).toBe(400);
  });

  it("describes an active key of this account with balance and models", async () => {
    const key = await addKey("app");
    const result = await check(key);
    expect(result).toMatchObject({ kind: "api_key", name: "key app", status: "active", cleaned: false, available_usd: 12.5 });
    expect(result.models).toContain("chat-model");
    expect(result.model_count).toBe(result.models.length);
  });

  it("tolerates a pasted Bearer prefix, quotes and spaces, and says so", async () => {
    const key = await addKey("app");
    expect(await check('  Bearer "' + key + '" ')).toMatchObject({ kind: "api_key", status: "active", cleaned: true });
  });

  it("recognises the login token, and revoked or disabled keys", async () => {
    expect(await check(TOKEN)).toMatchObject({ kind: "login_token", status: "active", calls_enabled: true });
    const revoked = await addKey("old", DEVICE_ID, { revoked_at: 5 });
    const disabled = await addKey("off", DEVICE_ID, { enabled: 0 });
    expect(await check(revoked)).toMatchObject({ kind: "api_key", name: "key old", status: "revoked", models: [] });
    expect(await check(disabled)).toMatchObject({ kind: "api_key", name: "key off", status: "disabled", models: [] });
  });

  it("never describes another account's key or unknown text", async () => {
    await seedDevice(d, { id: "other", token_hash: await sha256Hex("ccs_other_master") });
    const foreign = await addKey("theirs", "other");
    for (const key of [foreign, "ccs_other_master", "ccs_not_a_key"]) {
      expect(await check(key)).toMatchObject({ kind: "unknown", name: null, status: null, model_count: null, models: [] });
    }
  });

  it("reports the number of usable keys on /me", async () => {
    expect((await (await call("/me")).json() as any).device.api_key_count).toBe(0);
    await addKey("a"); await addKey("b", DEVICE_ID, { enabled: 0 }); await addKey("c", DEVICE_ID, { revoked_at: 9 });
    expect((await (await call("/me")).json() as any).device.api_key_count).toBe(2);
  });
});

describe("key check findings", () => {
  const base = { kind: "api_key", name: "app", status: "active", cleaned: false, calls_enabled: true, available_usd: 3, model_count: 2, models: ["a", "b"] };
  it("lists what works and what to fix, in plain words", () => {
    expect(keyCheckFindings(base).map((f: any) => f.tone)).toEqual(["ok", "ok", "ok"]);
    const low = keyCheckFindings({ ...base, cleaned: true, available_usd: 0, model_count: 0, models: [] });
    expect(low.map((f: any) => f.tone)).toEqual(["warn", "ok", "warn", "bad"]);
    expect(keyCheckFindings({ ...base, kind: "unknown", name: null, status: null }).map((f: any) => f.tone)).toEqual(["bad"]);
    expect(keyCheckFindings({ ...base, status: "revoked" })[0].text).toContain("已撤销");
    const login = keyCheckFindings({ ...base, kind: "login_token", name: null, calls_enabled: false });
    expect(login[0].text).toContain("主 Token"); expect(login.some((f: any) => f.text.includes("禁止调用"))).toBe(true);
  });
});

describe("code highlighting", () => {
  const strip = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  it.each(["bash", "powershell", "python", "js", "json", "toml", "text"])("keeps the exact text for %s", (lang) => {
    const code = '# note\nexport A="$CPG_API_KEY" --flag\n$env:B = "x"\n[section]\nkey = "v" # c\n{"k": 1, "t": true}\nimport os; print(\'hi\')\n// done';
    const nodes = highlight(code, lang);
    expect(strip(renderToStaticMarkup(React.createElement("code", null, nodes)))).toBe(code);
  });
  it("keeps the key placeholder in one token", () => {
    const html = renderToStaticMarkup(React.createElement("code", null, highlight('curl x -H "Authorization: Bearer $CPG_API_KEY"', "bash")));
    expect(html).toContain("$CPG_API_KEY");
  });
});

describe("app-specific connection settings", () => {
  const base = "https://gw.example.test";
  it("gives each app the address form it expects", () => {
    const value = (app: string, label: string) => appSettings(app, "m", base).rows.find((r: any) => r.label === label)?.value;
    expect(value("cherry", "API 地址")).toBe(base);
    expect(value("chatbox", "API 主机")).toBe(base);
    expect(value("chatbox", "API 路径")).toBe("/v1/chat/completions");
    expect(value("immersive", "自定义 API 接口地址")).toBe(base + "/v1/chat/completions");
    expect(appSettings("openai", "m", base)).toBeNull();
    for (const app of ["cherry", "chatbox", "immersive"]) expect(JSON.stringify(appSettings(app, "m", base))).not.toMatch(/ccs_[A-Za-z0-9]/);
  });
  it("sets up Claude Code on the root address and Codex on /v1 with the Responses wire API", () => {
    const claude = agentSnippets("claude-code", "m", base).map((s: any) => s.code).join("\n");
    expect(claude).toContain('ANTHROPIC_BASE_URL="' + base + '"');
    expect(claude).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(claude).toContain('"ANTHROPIC_MODEL": "m"');
    const codex = agentSnippets("codex", "m", base);
    expect(codex[0].code).toContain('base_url = "' + base + '/v1"');
    expect(codex[0].code).toContain('wire_api = "responses"');
    expect(codex[0].code).toContain('env_key = "CPG_API_KEY"');
    for (const s of [...codex, ...agentSnippets("claude-code", "m", base)]) expect(s.code).not.toMatch(/ccs_[A-Za-z0-9]/);
  });
  it("maps apps to protocols and falls back to the plain SDK entry for a mismatched choice", () => {
    expect(connectionApp("openai", "codex").protocol).toBe("/v1/responses");
    expect(connectionApp("anthropic", "claude-code").key).toBe("claude-code");
    expect(connectionApp("anthropic", "cherry").key).toBe("anthropic");
    expect(connectionApp("dsh").key).toBe("dsh");
    expect(CONNECTION_APPS.map((a: any) => a.key)).toEqual(["openai", "anthropic", "cherry", "chatbox", "immersive", "claude-code", "codex", "dsh"]);
  });
});

describe("connection wizard app panels (SSR)", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"');
  const model = (extra = {}) => ({ model_name: "allowed", alias: null, display_name: "授权模型", model_type: "text", billing_unit: "token",
    chat_endpoint: "/v1/chat/completions", protocol_capabilities: { supported_endpoints: ["/v1/chat/completions", "/v1/responses"] },
    context_window: 64000, max_output_tokens: 4096, input_modalities: ["text"], ...extra });
  function wizard(values: unknown[], props = {}) {
    function Seeded() {
      const dispatcher = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current;
      const original = dispatcher.useState; let i = 0;
      dispatcher.useState = (initial: unknown) => original(i < values.length ? values[i++] : initial);
      try { return ConsoleConnectionWizard({ models: { items: [model()] }, ...props }); } finally { dispatcher.useState = original; }
    }
    return renderToStaticMarkup(React.createElement(Seeded));
  }
  it("renders every app in the gallery and the Cherry Studio settings form", () => {
    const html = wizard(["openai", "/v1/chat/completions", "", "cherry"]);
    for (const app of CONNECTION_APPS) expect(html).toContain(">" + app.title + "<");
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*><span[^>]*>Cherry Studio</);
    expect(text(html)).toContain("提供商类型选 OpenAI");
    expect(html).not.toContain('aria-label="接入协议"');
  });
  it("renders the Codex config with the selected model", () => {
    const html = text(wizard(["openai", "/v1/chat/completions", "", "codex"]));
    expect(html).toContain('model = "allowed"');
    expect(html).toContain('wire_api = "responses"');
  });
  it("tells how many keys exist and stays silent when unknown", () => {
    expect(wizard([], { apiKeyCount: 0 })).toContain("你还没有 API 密钥");
    expect(wizard([], { apiKeyCount: 3 })).toContain("你已有 3 个可用的 API 密钥");
    expect(wizard([])).not.toContain("API 密钥。找不到");
  });
  it("puts the access card, key check and troubleshooting next to the guide", () => {
    const html = renderToStaticMarkup(React.createElement(ConsoleGuide, { models: { items: [model()] } }));
    for (const label of ["接入地址", "检查 API 密钥", "接不通？", "完整对话地址"]) expect(html).toContain(label);
    expect(html.indexOf("准备 API 密钥")).toBeLessThan(html.indexOf("接入地址"));
  });
});

describe("usage trend and onboarding helpers", () => {
  it("fills missing days in UTC+8 and rounds the axis", () => {
    const day = 86_400_000, from = Date.UTC(2026, 10, 1) - 8 * 3_600_000;
    const rows = fillDailyUsage([{ date: "2026-11-02", request_count: 3, total_tokens: 30, cost_usd: 0.3 }], from, from + 2 * day + 1000);
    expect(rows.map((r: any) => [r.date, r.request_count])).toEqual([["2026-11-01", 0], ["2026-11-02", 3], ["2026-11-03", 0]]);
    expect([niceCeiling(0), niceCeiling(0.3), niceCeiling(7), niceCeiling(180), niceCeiling(2400)]).toEqual([1, 0.5, 10, 200, 2500]);
  });
  it("words recent times plainly", () => {
    const now = 1_000_000_000_000;
    expect([relativeTime(now - 5_000, now), relativeTime(now - 5 * 60_000, now), relativeTime(now - 3 * 3_600_000, now), relativeTime(now - 2 * 86_400_000, now)])
      .toEqual(["刚刚", "5 分钟前", "3 小时前", "2 天前"]);
  });
  it("offers the guide only for text models and keeps model tiles stable", () => {
    expect(connectableModelId([{ model_name: "img", model_type: "image", billing_unit: "call" }])).toBeNull();
    expect(connectableModelId([{ model_name: "chat", alias: "chat-alias", model_type: "text", billing_unit: "token" }])).toBe("chat-alias");
    expect(modelMonogram("deepseek-chat")).toEqual(modelMonogram("deepseek-chat"));
    expect(modelMonogram("openai/gpt-4o").text).toBe("GP");
  });
});
