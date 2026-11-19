import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  createVideoAttempt, loadVideoAttempt, saveVideoAttempt, prepareVideoAttemptForPost,
  canReleaseRejectedVideoAttempt, canStartNewVideoAttempt, safeVideoResultUrl, validateVideoInput,
} from "../../web/src/utils/videoTask";
import {
  validateVideoReferenceFiles, videoReferenceLimit, parseVideoReferenceUpload,
  parseVideoContentTicket, safeVideoContentTicketUrl, VIDEO_REFERENCE_MAX_BYTES,
} from "../../web/src/utils/videoReferences";
import { parseModelTypeConfig, videoReferenceConfirmation } from "../../web/src/utils/modelType";
const clientPath = "../../web/src/api/videoClient";
const { videoApi, VideoApiError, videoDefinitelyNotDispatched } = await import(clientPath);
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const cardPath = "../../web/src/components/ConsoleVideoCard.tsx";
const pickerPath = "../../web/src/components/VideoReferencePicker.tsx";
const { ConsoleVideoCard, VideoTaskCard, VideoTicketMedia } = await import(cardPath);
const { VideoReferencePicker } = await import(pickerPath);
const render = (component: unknown, props: unknown) => renderToStaticMarkup(createElement(component, props));
const input = { model: "video", prompt: "calm sea", seconds: 5, size: "1280x720" };
const content = "/v1/video/generations/task-1/content";
const expiry = () => new Date(Date.now() + 60000).toISOString();
const storage = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
const file = (type = "image/png", size = 128) => ({ type, size });
const login = () => vi.stubGlobal("sessionStorage", { getItem: () => "reference-ui-token" });
const config = (refs?: unknown) => JSON.stringify({ model_type: "video", video: { adapter: "generic", task_id_path: "data.id", sizes: [input.size], ...(refs !== undefined ? { reference_images: refs } : {}) } });
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("bounded video reference files and declared capabilities", () => {
  it("requires explicit valid max_images and never infers capability", () => {
    for (const value of [undefined, {}, { reference_images: { max_images: 0 } }, { reference_images: { max_images: 4 } }, { reference_images: { max_images: 1.5 } }]) expect(videoReferenceLimit(value)).toBe(0);
    expect(videoReferenceLimit({ reference_images: { max_images: 2 } })).toBe(2);
    expect(() => validateVideoReferenceFiles([file()], 0)).toThrow();
  });
  it("accepts exactly 3 x 5 MiB and rejects MIME, count, per-file limits", () => {
    expect(() => validateVideoReferenceFiles([file("image/jpeg", VIDEO_REFERENCE_MAX_BYTES), file("image/png", VIDEO_REFERENCE_MAX_BYTES), file("image/webp", VIDEO_REFERENCE_MAX_BYTES)], 3)).not.toThrow();
    for (const files of [[file("image/gif")], [file("image/svg+xml")], [file("image/png", 0)], [file("image/png", VIDEO_REFERENCE_MAX_BYTES + 1)], Array(4).fill(file())]) expect(() => validateVideoReferenceFiles(files, 3)).toThrow();
    expect(() => validateVideoReferenceFiles([file(), file()], 1)).toThrow();
  });
  it("validates upload shape and expiry, without trusting server-provided preview URLs", () => {
    const response = { id: "ref_1", content_type: "image/png", size_bytes: 128, expires_at: expiry(), upstream_url: "https://private.invalid/image" };
    expect(parseVideoReferenceUpload(response, file())).toEqual({ id: response.id, content_type: response.content_type, size_bytes: 128, expires_at: response.expires_at });
    for (const extra of [{ id: "../bad" }, { content_type: "image/jpeg" }, { size_bytes: 129 }, { expires_at: "bad" }, { expires_at: "2000-01-01T00:00:00Z" }]) expect(() => parseVideoReferenceUpload({ ...response, ...extra }, file())).toThrow();
  });
  it("shared admin parser allows only explicitly configured mapping, defaults absent", () => {
    expect((parseModelTypeConfig(config()).video as object)).not.toHaveProperty("reference_images");
    expect(videoReferenceConfirmation(config())).toBeNull();
    const refs = { mapping: "image_images_url", max_images: 3 };
    expect((parseModelTypeConfig(config(refs)).video as { reference_images: unknown }).reference_images).toEqual(refs);
    expect(videoReferenceConfirmation(config(refs))).toContain("确认");
    for (const value of [null, {}, { max_images: 1 }, { mapping: "default", max_images: 1 }, { ...refs, max_images: 4 }, { ...refs, max_images: 1.1 }, { ...refs, enabled: true }]) expect(() => parseModelTypeConfig(config(value))).toThrow();
    for (const page of ["../../web/src/pages/ModelsPage.tsx", "../../web/src/pages/ModelGroupsPage.tsx"]) expect(source(page)).toContain("referenceConfirmation && !confirm(referenceConfirmation)");
  });
});

describe("immutable ordered reference IDs and failclosed recovery", () => {
  it("clones/freezes ordered IDs and preserves exact serialized body after reload", async () => {
    const ids = ["ref_b", "ref_a"];
    const attempt = createVideoAttempt({ ...input, reference_image_ids: ids }, () => "reference-key-01");
    const original = JSON.stringify(attempt.body);
    ids.reverse(); ids.push("ref_c");
    expect(attempt.body.reference_image_ids).toEqual(["ref_b", "ref_a"]);
    expect(Object.isFrozen(attempt.body.reference_image_ids)).toBe(true);
    const store = storage();
    const uncertain = await prepareVideoAttemptForPost(attempt, async next => { await saveVideoAttempt("secret", next, store); });
    const restored = (await loadVideoAttempt("secret", store))!;
    expect(restored.key).toBe(attempt.key);
    expect(JSON.stringify(restored.body)).toBe(original);
    expect(Object.isFrozen(restored.body.reference_image_ids)).toBe(true);
    expect(restored.possible_sent).toBe(true);
    expect(JSON.stringify([...store.values.values()])).not.toMatch(/base64|blob:|secret|request_hash/);
    expect(canStartNewVideoAttempt(restored)).toBe(false);
    const rejected = new VideoApiError("reference expired", 410, "not_started");
    expect(canReleaseRejectedVideoAttempt(uncertain, videoDefinitelyNotDispatched(rejected))).toBe(false);
  });
  it("rejects invalid IDs and missing public capability without dropping recovery state", async () => {
    for (const ids of [[], ["same", "same"], ["https://upstream/image"], ["ref1", "ref2", "ref3", "ref4"]]) expect(() => createVideoAttempt({ ...input, reference_image_ids: ids })).toThrow();
    expect(() => validateVideoInput({ ...input, reference_image_ids: ["ref1"] }, { sizes: [input.size] })).toThrow();
    expect(() => validateVideoInput({ ...input, reference_image_ids: ["ref1"] }, { sizes: [input.size], reference_images: { max_images: 1 } })).not.toThrow();
    const store = storage();
    await saveVideoAttempt("secret", createVideoAttempt({ ...input, reference_image_ids: ["ref1"] }, () => "reference-key-01"), store);
    const key = [...store.values.keys()][0];
    const invalid = JSON.parse(store.values.get(key)!); invalid.body.reference_image_ids = ["../bad"];
    store.values.set(key, JSON.stringify(invalid));
    await expect(loadVideoAttempt("secret", store)).rejects.toThrow();
    expect(store.values.has(key)).toBe(true);
  });
  it("SSR hides picker unless declared and renders selection/preview/order controls", () => {
    const props = { items: [{ key: "local1", file: { name: "sea.png", type: "image/png", size: 128 }, preview: "blob:local-preview" }], onSelect: () => {}, onUpload: () => {}, onRemove: () => {}, onMove: () => {} };
    expect(render(VideoReferencePicker, { ...props, maxImages: 0 })).toBe("");
    const html = render(VideoReferencePicker, { ...props, maxImages: 3 });
    for (const value of ["image/jpeg,image/png,image/webp", "blob:local-preview", "删除参考图", "上移", "下移", "不创建任务"]) expect(html).toContain(value);
    const models = { items: [{ id: "video", model_name: "video", model_type: "video", video: { sizes: [input.size], seconds_min: 3, seconds_max: 15 } }] };
    expect(render(ConsoleVideoCard, { models, active: true })).not.toContain('type="file"');
    models.items[0].video = { ...models.items[0].video, reference_images: { max_images: 2 } } as (typeof models.items)[number]["video"];
    expect(render(ConsoleVideoCard, { models, active: true })).toContain('type="file"');
    const cardSource = source(cardPath);
    expect(cardSource).toContain("URL.revokeObjectURL");
    expect(cardSource).toContain("createInFlight.current || uploadInFlight.current");
    expect(cardSource).toContain("reference_image_ids: refs.map(item => item.uploaded!.id)");
    expect(cardSource).not.toContain("readAsDataURL");
  });
});

describe("upload and explicit content-ticket requests", () => {
  it("uploads raw binary with gateway Bearer and does not create a video", async () => {
    login();
    const image = new File([new Uint8Array(128)], "sea.png", { type: "image/png" });
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "ref1", content_type: image.type, size_bytes: image.size, expires_at: expiry() })); vi.stubGlobal("fetch", fetcher);
    await expect(videoApi.uploadReference(image)).resolves.toMatchObject({ id: "ref1" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/v1/video/reference-images");
    expect(init).toMatchObject({ method: "POST", body: image, credentials: "omit", headers: { Authorization: "Bearer reference-ui-token", "Content-Type": "image/png" } });
  });
  it("does not retry upload errors including missing R2 503", async () => {
    login(); const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { message: "R2 not configured" } }, { status: 503 })); vi.stubGlobal("fetch", fetcher);
    await expect(videoApi.uploadReference(new File(["a"], "a.png", { type: "image/png" }))).rejects.toThrow("R2");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("requires exact same task relative content path and only opaque ticket query", () => {
    expect(safeVideoResultUrl(content, "task-1")).toBe(content);
    for (const url of ["https://media.invalid/video.mp4", "//media.invalid/video", content + "?token=secret", content + "#secret", content + "/../content", content.replace("task-1", "other")]) expect(safeVideoResultUrl(url, "task-1")).toBeNull();
    const valid = content + "?ticket=enc%3Av1%3Aiv_test.cipher_test";
    expect(parseVideoContentTicket({ url: valid, expires_at: expiry() }, content).url).toBe(valid);
    for (const url of ["https://app.invalid" + valid, "//app.invalid" + valid, valid + "&token=secret", valid + "#x", content + "?Bearer=secret", content.replace("task-1", "task-2") + "?ticket=abc"]) expect(safeVideoContentTicketUrl(url, content)).toBeNull();
    expect(() => parseVideoContentTicket({ url: valid, expires_at: "2000-01-01T00:00:00Z" }, content)).toThrow();
  });
  it("accepts an actual Worker-minted AES-GCM ticket and rejects altered encoding", async () => {
    const { signVideoTicket } = await import("../src/gateway/video_tickets");
    const token = await signVideoTicket({ ENCRYPTION_KEY: "integration-ticket-key" } as any, { kind: "video", id: "task-1", device_id: "dev_1", sub_token_id: null, expires_at: Date.now() + 60_000 });
    const url = content + "?ticket=" + encodeURIComponent(token);
    expect(safeVideoContentTicketUrl(url, content)).toBe(url);
    for (const bad of [content + "?ticket=" + token, url.replace(/%3A/g, "%3a"), content + "?ticket=" + encodeURIComponent(encodeURIComponent(token)), url + "&x=1"]) expect(safeVideoContentTicketUrl(bad, content)).toBeNull();
  });
  it("gets an authenticated short ticket without creating/downloading video", async () => {
    login(); const ticket = { url: content + "?ticket=enc%3Av1%3Aiv_test.cipher_test", expires_at: expiry() };
    const fetcher = vi.fn().mockResolvedValue(Response.json(ticket)); vi.stubGlobal("fetch", fetcher);
    await expect(videoApi.contentTicket("task-1", content)).resolves.toEqual(ticket);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(content + "-ticket");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "omit", headers: { Authorization: "Bearer reference-ui-token" } });
    await expect(videoApi.contentTicket("task-1", "https://upstream.invalid/v.mp4")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("renders native controls/link only for live short tickets with no autoplay or preload", () => {
    const ticket = { url: content + "?ticket=enc%3Av1%3Aiv_test.cipher_test", expires_at: expiry() };
    const html = render(VideoTicketMedia, { ticket, contentPath: content, mode: "play" });
    expect(html).toContain("<video"); expect(html).toContain('controls=""'); expect(html).toContain('preload="none"');
    expect(html).not.toContain("autoplay"); expect(html).not.toContain("Bearer");
    expect(html).toContain('href="' + ticket.url + '"');
    const download = render(VideoTicketMedia, { ticket, contentPath: content, mode: "download" });
    expect(download).not.toContain("<video"); expect(download).toContain("download");
    expect(render(VideoTicketMedia, { ticket: { ...ticket, url: "https://upstream.invalid/video" }, contentPath: content, mode: "play" })).toBe("");
    expect(render(VideoTicketMedia, { ticket: { ...ticket, expires_at: "2000-01-01T00:00:00Z" }, contentPath: content, mode: "play" })).toBe("");
  });
  it("SSR fetches nothing, offers explicit playback, and never renders upstream links", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const task = { id: "task-1", model: "video", status: "succeeded", seconds: 5, size: input.size, price_per_call: 1, cost_usd: 1, created_at: 1, updated_at: 1, result_url: content };
    const html = render(VideoTaskCard, { task });
    expect(html).toContain("播放视频"); expect(html).toContain("获取下载链接");
    expect(html).not.toContain('<video'); expect(html).not.toContain('href=');
    expect(fetcher).not.toHaveBeenCalled();
    const upstream = render(VideoTaskCard, { task: { ...task, result_url: "https://secret.invalid/video.mp4" } });
    expect(upstream).not.toContain("https://secret.invalid"); expect(upstream).toContain("结果链接无效");
    const code = source(cardPath);
    expect(code).toContain('controls preload="none"'); expect(code).not.toContain("autoPlay"); expect(code).not.toContain(".play()"); expect(code).not.toContain(".click()");
    expect(code).toContain('onClick={() => void openMedia("play")}');
  });
});
