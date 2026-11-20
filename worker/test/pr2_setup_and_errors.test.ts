import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { attentionApp, setupSteps } from "../src/admin/attention";
import { ensureSchema } from "../src/db/schema";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedDevice, seedModel, seedProvider } from "./helpers/realGatewayEnv";
import { explainGatewayError, gatewayErrorHelp, GATEWAY_ERROR_HELP } from "../../web/src/utils/gatewayErrors";

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
vi.doMock((requireWeb as any).resolve("react-router-dom"), () => ({ Link: ({ children, to }: any) => requireWeb("react").createElement("a", { href: to }, children) }));
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const attentionPath = "../../web/src/components/AttentionPanel";
const modelsPath = "../../web/src/pages/ModelsPage.tsx";
const { SetupChecklist } = await import(attentionPath);
const { savesAsUnpriced } = await import(modelsPath);

const open: RealD1[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });
async function setup() { const db = createRealD1(); open.push(db); const env = makeEnv(db); await ensureSchema(env); return { db, env }; }

describe("first-run setup checklist", () => {
  it("starts with every step open on an empty gateway", async () => {
    const { env } = await setup();
    const steps = await setupSteps(env);
    expect(steps.map(s => s.key)).toEqual(["provider", "model", "price", "account", "first_call"]);
    expect(steps.every(s => !s.done)).toBe(true);
  });

  it("marks steps done as the operator configures the gateway, using the unpriced rule", async () => {
    const { db, env } = await setup();
    seedProvider(db);
    seedModel(db, { id: "m_free_text", model_name: "unpriced", input_price_per_m: 0, output_price_per_m: 0, pricing_mode: "unset" });
    let done = Object.fromEntries((await setupSteps(env)).map(s => [s.key, s.done]));
    expect(done).toEqual({ provider: true, model: true, price: false, account: false, first_call: false });

    seedModel(db, { id: "m_priced", model_name: "priced", input_price_per_m: 1, output_price_per_m: 2 });
    await seedDevice(db, { id: "acct", token_hash: "h1", balance_usd: 1 });
    db.sql("INSERT INTO usage (id, device_id, model, cost_usd, created_at) VALUES (1, 'acct', 'priced', 0.1, ?)", Date.now());
    done = Object.fromEntries((await setupSteps(env)).map(s => [s.key, s.done]));
    expect(done).toEqual({ provider: true, model: true, price: true, account: true, first_call: true });
  });

  it("is returned next to the attention items", async () => {
    const { env } = await setup();
    const body = await (await attentionApp.request("http://local/", {}, env)).json() as any;
    expect(body.items).toEqual([]);
    expect(body.setup).toHaveLength(5);
  });

  it("renders open steps with links and hides itself once complete", () => {
    const steps = [
      { key: "provider", done: true, text: "添加上游接口", hint: "h", link: "/providers" },
      { key: "model", done: false, text: "启用模型", hint: "h", link: "/models" },
    ];
    const html = renderToStaticMarkup(React.createElement(SetupChecklist, { steps }));
    expect(html).toContain("开站清单");
    expect(html).toContain("已完成 1 / 2");
    expect(html).toContain('href="/models"');
    expect(html).toContain("启用模型<span class=\"sr-only\">（未完成）");
    expect(renderToStaticMarkup(React.createElement(SetupChecklist, { steps: steps.map(s => ({ ...s, done: true })) }))).toBe("");
  });
});

describe("model form: saving an enabled model without a price", () => {
  const form = (extra: Record<string, unknown> = {}) => ({ provider_id: "p", model_name: "m", display_name: "", description: "", alias: "", fallback_model_id: "",
    input_price_per_m: "", output_price_per_m: "", cache_read_price_per_m: "", cache_write_price_per_m: "",
    billing_unit: "token", price_per_call: "", search_price_per_call: "", pricing_mode: "auto",
    cache_enabled: false, cache_ttl: "3600", model_public: false, enabled: true, config_json: "",
    capabilities: [], routing_strategy: "priority", weight: 10, system_prompt: "", system_prompt_mode: "prepend",
    max_tokens_limit: "", model_rewrite: "", supports_search_tool: false, ...extra });

  it("detects the auto mode with all prices at zero", () => {
    expect(savesAsUnpriced(form())).toBe(true);
    expect(savesAsUnpriced(form({ input_price_per_m: "0" , output_price_per_m: "0" }))).toBe(true);
  });

  it("does not ask when the model is priced, free, explicitly priced or billed per call", () => {
    expect(savesAsUnpriced(form({ output_price_per_m: "2" }))).toBe(false);
    expect(savesAsUnpriced(form({ pricing_mode: "free" }))).toBe(false);
    expect(savesAsUnpriced(form({ pricing_mode: "priced" }))).toBe(false);
    expect(savesAsUnpriced(form({ billing_unit: "call", price_per_call: "0.2", config_json: JSON.stringify({ model_type: "image" }) }))).toBe(false);
  });
});

describe("plain-language gateway errors", () => {
  it("explains known codes and keeps the code visible", () => {
    expect(explainGatewayError("insufficient_balance", "insufficient_balance")).toBe("可用余额不足。联系管理员充值后再试。（错误码 insufficient_balance）");
    expect(explainGatewayError("something_new", "Upstream said no")).toBe("Upstream said no");
    expect(explainGatewayError(undefined, "请求失败")).toBe("请求失败");
  });

  it("has one entry per code with both a meaning and a next step", () => {
    const codes = GATEWAY_ERROR_HELP.map(item => item.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const item of GATEWAY_ERROR_HELP) { expect(item.what).not.toBe(""); expect(item.fix).not.toBe(""); }
    expect(gatewayErrorHelp("model_pricing_missing")?.what).toContain("价格");
  });
});
