import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  VIDEO_POLL_INTERVAL_MS, canRetryVideoAttempt, canStartNewVideoAttempt, confirmVideoAttempt,
  createVideoAttempt, parseVideoTaskView, safeVideoResultUrl, validateVideoInput, videoNeedsPolling, saveVideoAttempt, loadVideoAttempt,
  type VideoTaskView,
} from "../../web/src/utils/videoTask";
const videoApiPath = "../../web/src/api/videoClient";
const {videoApi} = await import(videoApiPath);
import { parseModelTypeConfig, resolvedModelType, validateModelBilling, isTextModel, isVideoModel, VIDEO_HELP } from "../../web/src/utils/modelType";
import { buildDshProfile, buildPiModelsConfig } from "../../web/src/utils/modelConfigExport";

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const componentPath = "../../web/src/components/ConsoleVideoCard.tsx";
const { ConsoleVideoCard, VideoTaskCard } = await import(componentPath);
const render = (component: unknown, props: unknown) => renderToStaticMarkup(createElement(component, props));
const input = { model: "video-only", prompt: "A calm sea", seconds: 5, size: "1280x720" };
const task = (extra: Partial<VideoTaskView> = {}): VideoTaskView => ({
  id: "task-1", model: input.model, status: "pending", seconds: input.seconds, size: input.size,
  price_per_call: 0.25, cost_usd: 0, created_at: 1700000000000, updated_at: 1700000000000, ...extra,
});
const source = () => readFileSync(new URL(componentPath, import.meta.url), "utf8");
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("video attempt safety and public task contract", () => {
  it("freezes one UUID and exact body for manual unconfirmed retries", () => {
    const uuid = vi.fn(() => "uuid-once");
    const draft = { ...input };
    const attempt = createVideoAttempt(draft, uuid);
    draft.prompt = "changed";
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(attempt.key).toBe("uuid-once");
    expect(attempt.body).toEqual(input);
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(Object.isFrozen(attempt.body)).toBe(true);
    expect(canRetryVideoAttempt(attempt)).toBe(true);
    expect(canStartNewVideoAttempt(attempt)).toBe(false);
  });
  it.each(["submitting", "submission_unknown", "pending"] as const)("does not POST or start a new intent after acknowledged %s", (status) => {
    const attempt = confirmVideoAttempt(createVideoAttempt(input, () => "same-key"), task({ status }));
    expect(canRetryVideoAttempt(attempt)).toBe(false);
    expect(canStartNewVideoAttempt(attempt)).toBe(false);
    expect(attempt.key).toBe("same-key");
    expect(attempt.body).toEqual(input);
  });
  it.each(["succeeded", "failed"] as const)("allows a deliberate new intent only after %s", (status) => {
    const attempt = confirmVideoAttempt(createVideoAttempt(input, () => "same-key"), task({ status }));
    expect(canStartNewVideoAttempt(attempt)).toBe(true);
    expect(canRetryVideoAttempt(attempt)).toBe(false);
  });
  it("restores an unconfirmed exact key/body only for the same credential digest", async()=>{
    const values = new Map<string,string>();
    const storage = {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
    const intent = createVideoAttempt(input,()=>"restore-key-0001");
    await saveVideoAttempt("secret-token-a",intent,storage);
    expect([...values.keys()].join()).not.toContain("secret-token-a");
    expect(await loadVideoAttempt("secret-token-b",storage)).toBeNull();
    expect(await loadVideoAttempt("secret-token-a",storage)).toEqual(intent);
    const confirmed=confirmVideoAttempt(intent,task({status:"submission_unknown"}));
    await saveVideoAttempt("secret-token-a",confirmed,storage);
    expect(canRetryVideoAttempt((await loadVideoAttempt("secret-token-a",storage))!)).toBe(false);
    await saveVideoAttempt("secret-token-a",null,storage);
    expect(await loadVideoAttempt("secret-token-a",storage)).toBeNull();
  });
  it("does not silently discard an unreadable persisted attempt",async()=>{
    const storage={getItem:()=>"{broken",setItem:()=>{},removeItem:()=>{}};
    await expect(loadVideoAttempt("token-a",storage)).rejects.toThrow();
  });
  it("validates explicit public limits without inventing allowed sizes", () => {
    expect(() => validateVideoInput(input)).not.toThrow();
    expect(() => validateVideoInput({ ...input, seconds: 2 })).toThrow();
    expect(() => validateVideoInput({ ...input, seconds: 15.5 })).toThrow();
    expect(() => validateVideoInput({ ...input, size: "720p" })).toThrow();
    expect(() => validateVideoInput(input, { sizes: ["1920x1080"] })).toThrow("管理员");
    expect(() => validateVideoInput(input, { sizes: [input.size], seconds_min: 6 })).toThrow("管理员");
  });
  it("accepts the public shape and normalizes existing worker null metadata", () => {
    expect(parseVideoTaskView(task())).toEqual(task());
    const parsed = parseVideoTaskView({ ...task(), result_url: null, error_code: null });
    expect(parsed).not.toHaveProperty("result_url");
    expect(parsed).not.toHaveProperty("error_code");
    expect(() => parseVideoTaskView({ data: task() })).toThrow("无效任务");
    expect(() => parseVideoTaskView({ ...task(), status: "SUCCESS" })).toThrow("无效任务");
    expect(() => parseVideoTaskView({ ...task(), price_per_call: -1 })).toThrow("无效任务");
  });
  it("polls only unresolved tasks at a minimum 15 second interval", () => {
    expect(VIDEO_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(15000);
    expect(videoNeedsPolling("pending")).toBe(true);
    expect(videoNeedsPolling("submission_unknown")).toBe(false);
    expect(videoNeedsPolling("succeeded")).toBe(false);
    expect(videoNeedsPolling("failed")).toBe(false);
  });
  it.each(["http://example.com/a.mp4", "javascript:alert(1)", "https://user:secret@example.com/a.mp4", "https://example.com/a.mp4#token", "not-a-url"])("rejects unsafe result URL %s", (url) => {
    expect(safeVideoResultUrl(url)).toBeNull();
  });
});

describe("video SSR rendering", () => {
  it("shows frozen successful task pricing and safe open/download links", () => {
    const html = render(VideoTaskCard, { task: task({ status: "succeeded", cost_usd: 0.25, result_url: "/v1/video/generations/task-1/content" }) });
    expect(html).toContain("冻结单价 $0.2500/成功任务次");
    expect(html).toContain("已结算 $0.2500");
    expect(html).toContain("播放视频");
    expect(html).toContain("获取下载链接");
    expect(html).not.toContain("href=");  
  });
  it("does not expose invalid result links or retry controls for unknown submissions", () => {
    const invalid = render(VideoTaskCard, { task: task({ status: "succeeded", result_url: "javascript:alert(1)" }) });
    expect(invalid).not.toContain("href=");
    const unknown = render(VideoTaskCard, { task: task({ status: "submission_unknown" }) });
    expect(unknown).toContain("不可重新付费提交");
    expect(unknown).not.toContain("创建视频任务");
  });
  it("keeps video distinct and explains missing public specs without private adapter metadata", () => {
    const video = { id: "v", model_name: input.model, model_type: "video", chat_endpoint: "/v1/video/generations" };
    const chat = { id: "c", model_name: "chat-only", model_type: "text", chat_endpoint: "/v1/chat/completions" };
    const html = render(ConsoleVideoCard, { active: true, models: { items: [video, chat] } });
    expect(html).toContain(input.model);
    expect(html).not.toContain("chat-only");
    expect(html).toContain("目录未提供可用视频规格");
    expect(html).toContain("管理员配置的显式允许列表");
    expect(html).not.toContain("task_id_path");
    expect(render(ConsoleVideoCard, { models: null })).toContain("hidden=");
  });
  it("guards active-only fetch, aborts inactive requests, and gates double-clicks synchronously", () => {
    const text = source();
    expect(text).toContain("if (!activeRef.current || createInFlight.current) return;");
    expect(text).toContain("createInFlight.current = true;");
    expect(text).toContain("if (!active || !polling) return;");
    expect(text).toContain("controller.abort()");
    expect(text).toContain("await videoApi.get(id, controller.signal)");
    expect(text).not.toContain("setInterval(() => { void submit()");
  });
});

describe("video gateway fetch contract", () => {
  const login = (token = "device-token") => vi.stubGlobal("sessionStorage", { getItem: (key: string) => key === "cpg.console.token" ? token : null });
  it("uses gateway bearer authentication, exact body, and stable key across a manual retry", async () => {
    login();
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("network-unconfirmed")).mockResolvedValueOnce(new Response(JSON.stringify(task()), { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    const attempt = createVideoAttempt(input, () => "fixed-uuid");
    await expect(videoApi.create(attempt)).rejects.toThrow("network-unconfirmed");
    await expect(videoApi.create(attempt)).resolves.toEqual(task());
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/v1/video/generations");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", body: JSON.stringify(input), headers: { Authorization: "Bearer device-token", "Idempotency-Key": "fixed-uuid" } });
    expect(fetcher.mock.calls[1][1].body).toBe(init.body);
    expect(fetcher.mock.calls[1][1].headers["Idempotency-Key"]).toBe("fixed-uuid");
  });
  it("never fetches with a password/admin cookie or after acknowledged unknown submission", async () => {
    login("");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(videoApi.list()).rejects.toThrow("设备 Token");
    login();
    const attempt = confirmVideoAttempt(createVideoAttempt(input, () => "fixed-uuid"), task({ status: "submission_unknown" }));
    await expect(videoApi.create(attempt)).rejects.toThrow("禁止重新提交");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("accepts list envelopes and direct detail tasks without guessing upstream envelopes", async () => {
    login();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [task()] }))).mockResolvedValueOnce(new Response(JSON.stringify(task()))).mockResolvedValueOnce(new Response(JSON.stringify([task()])));
    vi.stubGlobal("fetch", fetcher);
    await expect(videoApi.list()).resolves.toEqual([task()]);
    await expect(videoApi.get("task/one")).resolves.toEqual(task());
    expect(fetcher.mock.calls[1][0]).toBe("/v1/video/generations/task%2Fone");
    await expect(videoApi.list()).rejects.toThrow("{data: VideoTaskView[]}");
  });
});

const squarePath = "../../web/src/components/ConsoleModelsSquare.tsx";
const chatPath = "../../web/src/components/ConsoleChatCard.tsx";
const guidePath = "../../web/src/components/ConsoleGuide.tsx";
const modelsPath = "../../web/src/pages/ModelsPage.tsx";
const { ConsoleModelsSquare, ModelOfferCard, matchesFilter } = await import(squarePath);
const { ConsoleChatCard } = await import(chatPath);
const { ConsoleGuide } = await import(guidePath);
const { serialize } = await import(modelsPath);
const webSource = (path: string) => readFileSync(new URL("../../web/src/" + path, import.meta.url), "utf8");
const plain = (html: string) => html.replace(/<[^>]*>/g, "");
const videoConfig = (extra: Record<string, unknown> = {}) => ({ model_type: "video", video: { adapter: "generic", task_id_path: "data.task_id", sizes: ["1280x720"], ...extra }, custom: { preserved: true } });
const videoOffer = (extra: Record<string, unknown> = {}) => ({ id: "video", model_name: "video-only", model_type: "video" as const, billing_unit: "call", chat_endpoint: "/v1/video/generations", service_group_id: "g", service_group_name: "视频组", is_current: true, pricing_mode: "priced", price_per_call: 0.25, input_price_per_m: 987, output_price_per_m: 986, cache_read_price_per_m: 985, cache_write_price_per_m: 984, search_price_per_call: 983, supports_reasoning: true, config_json: JSON.stringify(videoConfig()), ...extra });
const chatOffer = { id: "chat", model_name: "chat-only", model_type: "text" as const, billing_unit: "token", chat_endpoint: "/v1/chat/completions", supports_reasoning: false, context_window: 8192, max_output_tokens: 2048 };
function modelDraft(extra: Record<string, unknown> = {}) {
  return { provider_id: "p", model_name: "video-only", display_name: "", description: "", alias: "", fallback_model_id: "", input_price_per_m: "987", output_price_per_m: "986", cache_read_price_per_m: "985", cache_write_price_per_m: "984", billing_unit: "token", price_per_call: "0.25", search_price_per_call: "983", pricing_mode: "auto", cache_enabled: true, cache_ttl: "3600", model_public: true, enabled: true, capabilities: [], routing_strategy: "priority", weight: 10, system_prompt: "", system_prompt_mode: "prepend", max_tokens_limit: "", model_rewrite: "", supports_search_tool: false, config_json: JSON.stringify(videoConfig()), ...extra };
}

describe("video admin configuration and billing normalization", () => {
  it("retains video selection for incomplete drafts but rejects saving missing explicit upstream metadata", () => {
    expect(resolvedModelType('{"model_type":"video"}', "token")).toBe("video");
    for (const config of [{ model_type: "video" }, videoConfig({ task_id_path: "" }), videoConfig({ task_id_path: undefined }), videoConfig({ sizes: [] }), videoConfig({ sizes: undefined })]) {
      expect(() => parseModelTypeConfig(JSON.stringify(config))).toThrow();
      expect(() => serialize(modelDraft({ config_json: JSON.stringify(config) }))).toThrow();
    }
  });
  it.each(["data.__proto__.id", "constructor.id", "data.prototype", "data..id", "data[0].id", " data.id", "data.id-guess"])("rejects unsafe task path %s without guessing", (task_id_path) => {
    expect(() => parseModelTypeConfig(JSON.stringify(videoConfig({ task_id_path })))).toThrow("安全点分路径");
  });
  it("defaults only seconds to 3/15 and never invents failed statuses", () => {
    const parsed = parseModelTypeConfig(JSON.stringify(videoConfig()));
    expect(parsed.video).toEqual({ adapter: "generic", task_id_path: "data.task_id", sizes: ["1280x720"], seconds_min: 3, seconds_max: 15 });
    expect(parseModelTypeConfig(JSON.stringify(videoConfig({ failed_statuses: [] }))).video).toHaveProperty("failed_statuses", []);
    expect(() => validateModelBilling(JSON.stringify(videoConfig()), "token")).toThrow("成功任务次数");
    expect(() => validateModelBilling(JSON.stringify(videoConfig()), "call")).not.toThrow();
    for (const extra of [{ adapter: "other" }, { seconds_min: 2 }, { seconds_max: 16 }, { seconds_min: 7, seconds_max: 6 }, { seconds_min: null }, { failed_statuses: null }, { failed_statuses: ["SUCCESS"] }, { sizes: ["720p"] }, { sizes: ["1280x720", "1280x720"] }, { sizes: ["9999x720"] }, { guessed_status: "ERROR" }]) expect(() => parseModelTypeConfig(JSON.stringify(videoConfig(extra)))).toThrow();
  });
  it("forces successful-task billing and zero token/cache/search fees without silently making unset free", () => {
    const payload = serialize(modelDraft());
    expect(payload).toMatchObject({ billing_unit: "call", price_per_call: 0.25, input_price_per_m: 0, output_price_per_m: 0, cache_read_price_per_m: 0, cache_write_price_per_m: 0, search_price_per_call: 0, cache_enabled: false });
    expect(payload.pricing_mode).toBeUndefined();
    expect(serialize(modelDraft({ pricing_mode: "unset" })).pricing_mode).toBe("unset");
    expect(serialize(modelDraft({ pricing_mode: "free" })).pricing_mode).toBe("free");
    expect(JSON.parse(payload.config_json)).toMatchObject({ model_type: "video", video: { task_id_path: "data.task_id", sizes: ["1280x720"], seconds_min: 3, seconds_max: 15 }, custom: { preserved: true } });
  });
  it("supports both admin selectors, strict JSON save, and video cache exclusion", () => {
    for (const path of ["pages/ModelsPage.tsx", "pages/ModelGroupsPage.tsx"]) {
      const code = webSource(path);
      expect(code).toContain('<option value="video">');
      expect(code).toContain("VIDEO_HELP");
      expect(code).toContain('billing_unit: video ? "call"');
      expect(code).toContain("input_price_per_m: video ? 0");
      expect(code).toContain("cache_enabled: !embedding && !video &&");
      expect(code).toContain('task_id_path: "", sizes: []');
    }
    expect(VIDEO_HELP).toContain("未定价不等于免费");
    expect(VIDEO_HELP).toContain("失败状态不猜测");
  });
});

describe("video existing-web filters and SSR", () => {
  it("recognizes declared type and legacy video endpoint but excludes them from text/image/reasoning", () => {
    for (const offer of [videoOffer(), videoOffer({ model_type: undefined }), videoOffer({ model_type: "text", billing_unit: "token" })]) {
      expect(isVideoModel(offer)).toBe(true);
      expect(isTextModel(offer)).toBe(false);
      expect(matchesFilter(offer, "video")).toBe(true);
      expect(matchesFilter(offer, "call")).toBe(true);
      for (const filter of ["chat", "image", "reasoning", "embedding"]) expect(matchesFilter(offer, filter)).toBe(false);
    }
    expect(matchesFilter(chatOffer, "chat")).toBe(true);
  });
  it("shows success-task minimum and video endpoint without token minima or private fields", () => {
    const html = render(ConsoleModelsSquare, { models: { items: [videoOffer()] }, loading: false, error: null });
    const text = plain(html);
    expect(text).toContain("成功任务次价最低");
    expect(text).toContain("/成功任务次");
    expect(text).toContain("video/generations");
    expect(text).not.toContain("输入最低");
    expect(text).not.toContain("输出最低");
    expect(text).not.toContain("推理</");
    for (const secret of ["task_id_path", "data.task_id", "generic", "failed_statuses"]) expect(html).not.toContain(secret);
  });
  it("only displays the successful task price and excludes stale noncall fees from offer details", () => {
    const html = render(ModelOfferCard, { m: videoOffer() });
    const text = plain(html);
    expect(text).toContain("元 / 成功任务次");
    expect(text).toContain("Idempotency-Key");
    expect(text).toContain("GET /v1/video/generations/:id");
    expect(text).toContain("submission_unknown");
    for (const stale of ["987", "986", "985", "984", "983", "联网搜索", "缓存读取", "缓存写入"]) expect(text).not.toContain(stale);
    expect(html).not.toContain("task_id_path");
    expect(html).not.toContain("data.task_id");
  });
  it.each(["unset", undefined])("never renders missing pricing mode %s as free", (pricing_mode) => {
    const text = plain(render(ModelOfferCard, { m: videoOffer({ pricing_mode, price_per_call: 0 }) }));
    expect(text).toContain("未定价");
    expect(text).not.toContain("免费");
    const square = plain(render(ConsoleModelsSquare, { models: { items: [videoOffer({ pricing_mode, price_per_call: 0 })] }, loading: false, error: null }));
    expect(square).toContain("成功任务次价最低未定价");
  });
  it("excludes video from Chat and both DSH/Pi text exports even with stale text metadata", () => {
    const items = [videoOffer(), videoOffer({ model_type: "text", model_name: "stale-video", billing_unit: "token" }), chatOffer];
    const html = render(ConsoleChatCard, { models: { items } });
    expect(html).not.toContain("video-only");
    expect(html).not.toContain("stale-video");
    expect(html).toContain("chat-only");
    for (const result of [buildDshProfile(items, "https://gateway.test/v1"), buildPiModelsConfig(items, "https://gateway.test/v1")]) {
      expect(result.skipped).toEqual(expect.arrayContaining([{ id: "video-only", reason: "视频模型不属于 OpenAI 文本 profile" }, { id: "stale-video", reason: "视频模型不属于 OpenAI 文本 profile" }]));
      expect(JSON.stringify(result.config)).not.toContain("video-only");
      expect(JSON.stringify(result.config)).toContain("chat-only");
    }
  });
  it("documents mandatory idempotency and task states without guessing supported sizes", () => {
    const html = render(ConsoleGuide, { models: { items: [videoOffer(), chatOffer] } });
    const text = plain(html);
    expect(text).toContain("Idempotency-Key: example-video-job-001");
    expect(text).toContain("YOUR_SUPPORTED_SIZE");
    expect(text).toContain("submission_unknown");
    expect(text).toContain("不是按秒计费");
    expect(text).not.toContain("data.task_id");
    expect(text).not.toContain("generic");
  });
  it("keeps the video card mounted outside tab conditionals and only activates the video tab", () => {
    const code = webSource("pages/ConsolePage.tsx");
    expect(code).toContain('<div hidden={tab !== "video"}>');
    expect(code).toContain('active={tab === "video"}');
    expect(code).toContain("models={modelsQuery.data ?? null}");
    expect(code).toContain("key={token} token={token}");
    expect(source()).toContain("await prepareVideoAttemptForPost(current, persist)");
    expect(source()).toContain("saveVideoAttempt(token, next,sessionStorage)");
    expect(source()).toContain("?.video");
    expect(code.indexOf("<ConsoleVideoCard")).toBeLessThan(code.indexOf('{tab === "guide" ? ('));
    expect(code).toContain(') : tab === "video" || tab === "keys" || tab === "security" ? null : (');
    expect(code).not.toContain('key={tab}');
  });
});
