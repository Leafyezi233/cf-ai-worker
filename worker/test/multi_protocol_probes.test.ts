import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { createRealD1, makeEnv, seedModel, seedProvider, type RealD1 } from "./helpers/realGatewayEnv";

let db: RealD1;
let env: ReturnType<typeof makeEnv>;
let cookie: string;

beforeEach(async () => {
  db = createRealD1();
  env = makeEnv(db);
  env.SESSION_SECRET = "multi-probe-test-secret";
  env.PROBE_CHAT_KEY = "private-chat-key";
  env.PROBE_RESPONSES_KEY = "private-responses-key";
  env.PROBE_MESSAGES_KEY = "private-messages-key";
  seedProvider(db);
  seedModel(db);
  cookie = buildSessionCookie(await signSession(env.SESSION_SECRET, 0)).split(";")[0];
  vi.spyOn(globalThis, "fetch").mockImplementation(async url => answer(String(url)));
});

afterEach(() => { vi.restoreAllMocks(); db.close(); });

async function call(path: string, body: Record<string, unknown> = {}, auth = true) {
  const response = await adminApp.request("http://local/models/protocol-probes/" + path, {
    method: "POST", headers: { "content-type": "application/json", ...(auth ? { cookie } : {}) }, body: JSON.stringify(body),
  }, env);
  return { status: response.status, body: await response.json() as any };
}
async function preview() { const result = await call("preview"); expect(result.status).toBe(200); return result.body; }
function run(item: any) { return call("run", { model_id: item.model_id, fingerprint: item.fingerprint, confirm_cost: true }); }
function apply(item: any) { return call("apply", { model_id: item.model_id, fingerprint: item.fingerprint }); }
function answer(url: string) {
  return Response.json(url.includes("response") ? { object: "response", status: "completed", output: [] }
    : url.includes("message") ? { type: "message", role: "assistant", content: [] }
    : { object: "chat.completion", choices: [{ message: { role: "assistant", content: "OK" } }] });
}
function connections() {
  return {
    chat_completions: { enabled: true, base_url: "https://private-chat.example/root/", path: "/run-chat", auth: "x-api-key", secret_name: "PROBE_CHAT_KEY" },
    responses: { enabled: true, base_url: "https://private-responses.example/v2", path: "/run-response", auth: "x-goog-api-key", secret_name: "PROBE_RESPONSES_KEY" },
    messages: { enabled: true, base_url: "https://private-messages.example/v3", path: "/run-message", auth: "bearer", secret_name: "PROBE_MESSAGES_KEY", version: "2025-01-01", headers: { "anthropic-beta": "private-beta" } },
  };
}
function providerConfig(value: unknown) { db.sql("UPDATE providers SET config_json=? WHERE id='prov_a'", JSON.stringify({ protocol_connections: value })); }
function multi() {
  providerConfig(connections());
  db.sql("UPDATE models SET config_json=?", JSON.stringify({ description: "keep", protocol_models: { chat_completions: "wire-chat", responses: "wire-responses", messages: "wire-messages" } }));
}
function modelConfig() { return JSON.parse(db.row<any>("SELECT config_json FROM models WHERE id='model_a'")!.config_json); }
function expectPrivate(value: unknown) {
  const json = JSON.stringify(value);
  for (const marker of ["private-chat", "private-responses", "private-messages", "private-beta", "PROBE_CHAT_KEY", "PROBE_RESPONSES_KEY", "PROBE_MESSAGES_KEY", "wire-chat", "wire-responses", "wire-messages", "sk-a"]) expect(json).not.toContain(marker);
}

describe("manual admin multi-native protocol probes", () => {
  it.each(["openai", "anthropic", "gemini"])("uses each configured wire URL/auth/key/model independently of %s label", async label => {
    multi(); db.sql("UPDATE providers SET type=?", label);
    const p = await preview(), item = p.items[0];
    expect(p.request_count).toBe(3);
    expect(item.endpoints).toEqual(["chat/completions", "responses", "messages"]);
    expect(globalThis.fetch).not.toHaveBeenCalled(); expectPrivate(p);
    const result = await run(item);
    expect(result.status).toBe(200);
    expect(result.body.result.results.map((r: any) => r.status)).toEqual(["supported", "supported", "supported"]);
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.map(([url]) => url)).toEqual(["https://private-chat.example/root/run-chat", "https://private-responses.example/v2/run-response", "https://private-messages.example/v3/run-message"]);
    const headers = calls.map(([, init]) => new Headers(init!.headers));
    expect(headers[0].get("x-api-key")).toBe("private-chat-key");
    expect(headers[0].has("authorization")).toBe(false);
    expect(headers[1].get("x-goog-api-key")).toBe("private-responses-key");
    expect(headers[1].has("authorization")).toBe(false);
    expect(headers[2].get("authorization")).toBe("Bearer private-messages-key");
    expect(headers[2].has("x-api-key")).toBe(false);
    expect(headers[2].get("anthropic-version")).toBe("2025-01-01");
    expect(headers[2].get("anthropic-beta")).toBe("private-beta");
    for (const h of headers.slice(0, 2)) { expect(h.has("anthropic-version")).toBe(false); expect(h.has("anthropic-beta")).toBe(false); }
    expect(calls.map(([, init]) => JSON.parse(String(init!.body)).model)).toEqual(["wire-chat", "wire-responses", "wire-messages"]);
    for (const [, init] of calls) {
      const payload = JSON.parse(String(init!.body));
      expect(init!.redirect).toBe("manual"); expect(payload.stream).toBe(false);
      expect(payload.max_tokens ?? payload.max_output_tokens).toBe(16); expect(payload.tools).toBeUndefined();
      if (payload.input) expect(payload.store).toBe(false);
    }
    expectPrivate(result.body); expectPrivate(db.rows("SELECT * FROM settings WHERE key LIKE 'protocol_probe:%'"));
    expect((await preview()).request_count).toBe(0);
    const applied = await apply(item);
    expect(applied.status).toBe(200);
    expect(modelConfig()).toMatchObject({ description: "keep", protocol_capabilities: { chat_completions: true, responses: true, messages: true, loss_policy: "safe" } });
    expect(calls).toHaveLength(3);  
  });

  it("does not probe disabled or absent wires even when model capabilities declare them", async () => {
    providerConfig({ responses: {}, messages: { enabled: false, secret_name: "MISSING_DISABLED_KEY" } });
    db.sql("UPDATE providers SET type='anthropic'");
    db.sql("UPDATE models SET config_json=?", JSON.stringify({ protocol_capabilities: { chat_completions: true, messages: true } }));
    const p = await preview(), item = p.items[0];
    expect(p.request_count).toBe(1); expect(item.endpoints).toEqual(["responses"]); expect(item.manual_locked).toBe(true);
    expect((await run(item)).status).toBe(200);
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls).toHaveLength(1); expect(calls[0][0]).toBe("https://a.example/v1/responses");
    const headers = new Headers(calls[0][1]!.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-a"); expect(headers.has("x-api-key")).toBe(false);
    expect((await apply(item)).body.error).toBe("manual_protocol_config_locked");
  });

  it.each([
    {}, { chat_completions: { enabled: false }, responses: { enabled: false }, messages: { enabled: false } },
    { messages: { secret_name: "MISSING_EXPLICIT_KEY" } },
    { responses: {}, messages: { secret_name: "MISSING_EXPLICIT_KEY" } },
    { messages: { secret_name: "SESSION_SECRET" } }, { responses: { auth: "cookie" } }, null,
  ])("skips and refuses empty/disabled/invalid/uncredentialed explicit targets: %j", async value => {
    providerConfig(value); env.PROVIDER_SHARED_KEY = "shared-environment-key";
    db.sql("UPDATE providers SET secret_name='PROVIDER_SHARED_KEY'");
    expect(await preview()).toMatchObject({ items: [], request_count: 0, skipped: 1 });
    expect((await run({ model_id: "model_a", fingerprint: "stale" })).status).toBe(409);
    expect((await apply({ model_id: "model_a", fingerprint: "stale" })).status).toBe(409);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("never falls back to the shared key when an explicit environment credential becomes empty", async () => {
    providerConfig({ messages: { secret_name: "PROBE_MESSAGES_KEY" } });
    const item = (await preview()).items[0]; expect((await run(item)).status).toBe(200);
    env.PROBE_MESSAGES_KEY = "";
    expect(await preview()).toMatchObject({ items: [], request_count: 0, skipped: 1 });
    expect((await run(item)).status).toBe(409); expect((await apply(item)).status).toBe(409);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("supports a shared environment key only when the enabled connection omits its own reference", async () => {
    providerConfig({ messages: {} }); env.PROVIDER_SHARED_KEY = "shared-environment-key";
    db.sql("UPDATE providers SET api_key=NULL,secret_name='PROVIDER_SHARED_KEY',type='gemini'");
    const item = (await preview()).items[0]; expect(item.endpoints).toEqual(["messages"]);
    expect((await run(item)).status).toBe(200);
    const h = new Headers(vi.mocked(globalThis.fetch).mock.calls[0][1]!.headers);
    expect(h.get("x-api-key")).toBe("shared-environment-key"); expect(h.get("anthropic-version")).toBe("2023-06-01");
    expect(h.has("authorization")).toBe(false); expect(h.has("x-goog-api-key")).toBe(false);
  });

  it.each(["base_url", "path", "auth", "version", "headers", "model", "credential", "enabled"])("invalidates observations when effective %s changes", async field => {
    multi(); const item = (await preview()).items[0]; expect((await run(item)).status).toBe(200);
    const cfg: any = connections();
    if (field === "model") db.sql("UPDATE models SET config_json=?", JSON.stringify({ protocol_models: { messages: "new-wire-model" } }));
    else if (field === "credential") env.PROBE_MESSAGES_KEY = "rotated-private-key";
    else { cfg.messages[field] = field === "base_url" ? "https://changed.example/v9" : field === "path" ? "/changed-message" : field === "auth" ? "x-api-key" : field === "version" ? "2026-02-02" : field === "headers" ? { "anthropic-beta": "changed-beta" } : false; providerConfig(cfg); }
    const p = await preview();
    expect(p.items[0].fingerprint).not.toBe(item.fingerprint); expect(p.items[0].cached).toBeNull();
    expect(p.request_count).toBe(field === "enabled" ? 2 : 3);
    expect((await apply(item)).status).toBe(409); expect((await run(item)).status).toBe(409);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("binds default Messages version-header overrides to the effective fingerprint", async () => {
    providerConfig({ messages: { headers: { "anthropic-version": "2024-04-04" } } });
    const item = (await preview()).items[0]; await run(item);
    expect(new Headers(vi.mocked(globalThis.fetch).mock.calls[0][1]!.headers).get("anthropic-version")).toBe("2024-04-04");
    providerConfig({ messages: { headers: { "anthropic-version": "2025-05-05" } } });
    expect((await preview()).items[0].fingerprint).not.toBe(item.fingerprint);
    expect((await apply(item)).status).toBe(409);
  });

  it("rejects provider configuration changes made during the paid calls without saving observations", async () => {
    multi(); const item = (await preview()).items[0];
    vi.mocked(globalThis.fetch).mockImplementation(async url => {
      providerConfig({ messages: { enabled: false } }); return answer(String(url));
    });
    expect((await run(item)).status).toBe(409);
    expect(db.rows("SELECT * FROM settings WHERE key LIKE 'protocol_probe:%'")).toEqual([]);
    expect(modelConfig().protocol_capabilities).toBeUndefined();
  });

  it("uses provider config_json in the apply CAS even for an unrelated concurrent config edit", async () => {
    multi(); const item = (await preview()).items[0]; await run(item);
    const original = db.DB.prepare.bind(db.DB);
    let raced = false;
    vi.spyOn(db.DB, "prepare").mockImplementation((sql: unknown) => {
      if (typeof sql === "string" && sql.startsWith("UPDATE models SET config_json=")) {
        raced = true; db.sql("UPDATE providers SET config_json=?", JSON.stringify({ protocol_connections: connections(), description: "concurrent-edit" }));
      }
      return original(sql);
    });
    expect((await apply(item)).status).toBe(409); expect(raced).toBe(true);
    expect(modelConfig().protocol_capabilities).toBeUndefined();
  });

  it.each(["openai", "anthropic", "gemini"])("applies a Messages-only native observation for %s without supplier-label veto", async type => {
    providerConfig({ messages: {} }); db.sql("UPDATE providers SET type=?", type);
    const item = (await preview()).items[0]; expect(item.endpoints).toEqual(["messages"]);
    expect((await run(item)).status).toBe(200);
    expect((await apply(item)).status).toBe(200);
    expect(modelConfig().protocol_capabilities).toEqual({ chat_completions: false, responses: false, messages: true, chat_route: "auto", responses_route: "auto", loss_policy: "safe" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("applies legacy Anthropic Messages support now that native Messages capabilities exist", async () => {
    db.sql("UPDATE providers SET type='anthropic'");
    const item = (await preview()).items[0]; await run(item);
    expect((await apply(item)).status).toBe(200); expect(modelConfig().protocol_capabilities.messages).toBe(true);
  });

  it.each(["responses_mode", "protocol_capabilities"])("preserves manual %s locks and unrelated model config", async field => {
    multi(); const cfg = modelConfig(); cfg[field] = field === "responses_mode" ? "disabled" : { messages: false };
    db.sql("UPDATE models SET config_json=?", JSON.stringify(cfg));
    const item = (await preview()).items[0]; expect(item.manual_locked).toBe(true); await run(item);
    expect((await apply(item)).status).toBe(409); expect(modelConfig()).toEqual(cfg);
  });

  it("keeps unknown results inconclusive and applies supported/unsupported wires explicitly", async () => {
    multi(); const item = (await preview()).items[0];
    vi.mocked(globalThis.fetch).mockImplementation(async url => String(url).includes("response") ? Response.json({ error: { code: "model_not_found", message: "private-error" } }, { status: 404 }) : answer(String(url)));
    const result = await run(item);
    expect(result.body.result.results.map((r: any) => r.status)).toEqual(["supported", "unknown", "supported"]);
    expect(JSON.stringify(result.body)).not.toContain("private-error"); expect((await apply(item)).status).toBe(409);
    expect((await preview()).request_count).toBe(3);
    vi.mocked(globalThis.fetch).mockImplementation(async url => String(url).includes("response") ? Response.json({ error: { code: "unsupported_endpoint" } }, { status: 404 }) : answer(String(url)));
    expect((await run(item)).body.result.results.map((r: any) => r.status)).toEqual(["supported", "unsupported", "supported"]);
    expect((await apply(item)).status).toBe(200);
    expect(modelConfig().protocol_capabilities).toMatchObject({ chat_completions: true, responses: false, messages: true });
  });

  it("deduplicates identical effective wire targets but separates per-wire model overrides", async () => {
    multi(); const cfg = modelConfig();
    seedModel(db, { id: "same", config_json: JSON.stringify(cfg) });
    seedModel(db, { id: "different", config_json: JSON.stringify({ ...cfg, protocol_models: { ...cfg.protocol_models, messages: "different-messages-id" } }) });
    const p = await preview(); expect(p.items).toHaveLength(2); expect(p.request_count).toBe(6);
    expect(p.items.find((i: any) => i.model_ids.includes("model_a")).model_ids.sort()).toEqual(["model_a", "same"]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps model_rewrite precedence aligned with the gateway over protocol_models", async () => {
    multi(); const cfg = { ...modelConfig(), model_rewrite: "shared-rewrite" };
    db.sql("UPDATE models SET config_json=?", JSON.stringify(cfg));
    const item = (await preview()).items[0]; await run(item);
    expect(vi.mocked(globalThis.fetch).mock.calls.map(([, init]) => JSON.parse(String(init!.body)).model)).toEqual(["shared-rewrite", "shared-rewrite", "shared-rewrite"]);
  });

  it("requires authentication and explicit cost confirmation without any preview/apply traffic", async () => {
    multi(); const item = (await preview()).items[0];
    for (const op of ["preview", "run", "apply"]) expect((await call(op, {}, false)).status).toBe(401);
    expect((await call("run", { model_id: item.model_id, fingerprint: item.fingerprint })).status).toBe(400);
    expect((await apply(item)).status).toBe(409); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
