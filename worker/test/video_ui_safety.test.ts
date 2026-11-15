import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  createVideoAttempt, canReleaseUnsentVideoAttempt, canReleaseRejectedVideoAttempt, prepareVideoAttemptForPost,
  loadVideoAttempt, saveVideoAttempt, validateVideoInput, parseVideoTaskView,
  mergeVideoTaskHistory, VIDEO_TASK_HISTORY_CAP, videoTaskPollDue, videoTaskReadDue,
  type VideoTaskView,
} from "../../web/src/utils/videoTask";
const clientPath = "../../web/src/api/videoClient";
const { videoApi, VideoApiError, videoDefinitelyNotDispatched, videoErrorStatus } = await import(clientPath);
const input = { model: "video-only", prompt: "A calm sea", seconds: 5, size: "1280x720" };
const task = (extra: Partial<VideoTaskView> = {}): VideoTaskView => ({
  id: "task-1", model: input.model, status: "pending", seconds: 5, size: input.size,
  price_per_call: 0.25, cost_usd: 0, created_at: 1700000000000, updated_at: 1700000000000, ...extra,
});
const login = (token = "safety-token") => vi.stubGlobal("sessionStorage", { getItem: () => token });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("video create validates the actual serialized gateway body", () => {
  it("accepts the length and dimension boundaries and rejects mismatched server limits", () => {
    for (const value of [
      { ...input, model: "m".repeat(256), prompt: "p".repeat(8000), seconds: 3, size: "100x9999" },
      { ...input, seconds: 15, size: "9999x100" },
    ]) expect(() => validateVideoInput(value)).not.toThrow();
    for (const value of [
      { ...input, model: "m".repeat(257) }, { ...input, prompt: "p".repeat(8001) },
      { ...input, seconds: 2 }, { ...input, seconds: 16 }, { ...input, seconds: 3.5 },
      ...["99x720", "10000x720", "0128x720", "1280x0720", "0x720", "1280X720", "1280x720\n"].map(size => ({ ...input, size })),
    ]) expect(() => validateVideoInput(value)).toThrow();
  });
  it("measures escaped JSON UTF-8 bytes, not characters, including the exact 32KiB boundary", async () => {
    const escaped = "\u0001".repeat(5400);
    const base = { ...input, prompt: escaped };
    const bytes = (value: typeof input) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const exact = { ...input, prompt: escaped + "a".repeat(32768 - bytes(base)) };
    expect(exact.prompt.length).toBeLessThan(8000);
    expect(bytes(exact)).toBe(32768);
    expect(() => validateVideoInput(exact)).not.toThrow();
    const oversized = { ...exact, prompt: exact.prompt + "a" };
    expect(() => validateVideoInput(oversized)).toThrow("UTF-8");
    login();
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(videoApi.create({ key: "stable-key", body: oversized, possible_sent: true })).rejects.toThrow("32 KiB");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("durable possible_sent transitions", () => {
  it("waits for uncertainty to be durable before a caller may POST", async () => {
    const intent = createVideoAttempt(input, () => "new-intent-key");
    let release!: () => void;
    const write = new Promise<void>(resolve => { release = resolve; });
    const persist = vi.fn(() => write);
    let postAllowed = false;
    const preparing = prepareVideoAttemptForPost(intent, persist).then(value => { postAllowed = true; return value; });
    expect(persist).toHaveBeenCalledWith({ ...intent, possible_sent: true });
    await Promise.resolve();
    expect(postAllowed).toBe(false);
    release();
    const uncertain = await preparing;
    expect(uncertain.possible_sent).toBe(true);
    expect(intent.possible_sent).toBe(false);
    expect(uncertain.key).toBe(intent.key);
    expect(uncertain.body).toBe(intent.body);
  });
  it("only unlocks a never-sent intent after a pre-POST storage failure", async () => {
    const fresh = createVideoAttempt(input, () => "new-intent-key");
    const uncertain = await prepareVideoAttemptForPost(fresh, async () => {});
    const persist = vi.fn().mockRejectedValue(new Error("quota exceeded"));
    await expect(prepareVideoAttemptForPost(fresh, persist)).rejects.toThrow("quota exceeded");
    expect(canReleaseUnsentVideoAttempt(fresh)).toBe(true);
    await expect(prepareVideoAttemptForPost(uncertain, persist)).rejects.toThrow("quota exceeded");
    expect(canReleaseUnsentVideoAttempt(uncertain)).toBe(false);
  });
  it("treats a legacy persisted attempt with no flag as possibly sent, including failed retry writes", async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const fresh = createVideoAttempt(input, () => "legacy-intent-key");
    await saveVideoAttempt("legacy-token", fresh, storage);
    const key = [...values.keys()][0];
    const legacy = JSON.parse(values.get(key)!); delete legacy.possible_sent;
    values.set(key, JSON.stringify(legacy));
    const restored = (await loadVideoAttempt("legacy-token", storage))!;
    expect(restored.possible_sent).toBe(true);
    expect(canReleaseUnsentVideoAttempt(restored)).toBe(false);
    await expect(prepareVideoAttemptForPost(restored, async () => { throw new Error("write failure"); })).rejects.toThrow();
    expect(canReleaseUnsentVideoAttempt(restored)).toBe(false);
  });
});

describe("only explicit pre-dispatch 4xx unlocks", () => {
  it("never clears a previously possible-sent key when a retry is rejected before dispatch", async () => {
    const fresh = createVideoAttempt(input, () => "same-stable-key");
    const inFlight = await prepareVideoAttemptForPost(fresh, async () => {});
    const rejected = new VideoApiError("retry rate limited", 429, "not_started");
    expect(canReleaseRejectedVideoAttempt(fresh, videoDefinitelyNotDispatched(rejected))).toBe(true);
    expect(canReleaseRejectedVideoAttempt(inFlight, videoDefinitelyNotDispatched(rejected))).toBe(false);
    expect(canReleaseRejectedVideoAttempt(fresh, false)).toBe(false);
    const code = readFileSync(new URL("../../web/src/components/ConsoleVideoCard.tsx", import.meta.url), "utf8");
    expect(code).toContain("canReleaseRejectedVideoAttempt(before, true)");
  });
  it.each([400, 401, 403, 404, 413, 422, 429])("trusts explicit not_started on HTTP %s", async status => {
    login();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "rejected", dispatch: "not_started" } }), { status })));
    const error = await videoApi.create(createVideoAttempt(input, () => "stable-key")).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(VideoApiError);
    expect(error.response.status).toBe(status);
    expect(videoDefinitelyNotDispatched(error)).toBe(true);
  });
  it("accepts the server top-level dispatch contract, never an unstructured lookalike", async () => {
    login();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ dispatch: "not_started", error: "video_spec_not_allowed" }), { status: 400 })));
    const error = await videoApi.create(createVideoAttempt(input, () => "stable-key")).catch((error: unknown) => error);
    expect(videoDefinitelyNotDispatched(error)).toBe(true);
    expect(videoDefinitelyNotDispatched({ dispatch: "not_started", status: 400 })).toBe(false);
  });
  it.each([409, 500, 502, 503])("never unlocks HTTP %s even with a misleading dispatch field", async status => {
    login();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ dispatch: "not_started", error: { message: "ambiguous" } }), { status })));
    const error = await videoApi.create(createVideoAttempt(input, () => "stable-key")).catch((error: unknown) => error);
    expect(videoDefinitelyNotDispatched(error)).toBe(false);
  });
  it("does not infer dispatch from 4xx text, non-JSON responses or network errors", async () => {
    login();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "not_started" } }), { status: 400 }))
      .mockResolvedValueOnce(new Response("not_started", { status: 400 }))
      .mockRejectedValueOnce(new Error("network error"));
    vi.stubGlobal("fetch", fetcher);
    const attempt = createVideoAttempt(input, () => "stable-key");
    for (let i = 0; i < 3; i++) expect(videoDefinitelyNotDispatched(await videoApi.create(attempt).catch((error: unknown) => error))).toBe(false);
    expect(videoErrorStatus({ response: { status: 429 } })).toBe(429);
    expect(videoErrorStatus({ response: { status: "429" } })).toBeUndefined();
  });
});

describe("bounded task history and review-safe scheduling", () => {
  it("parses optional scheduling metadata and does not automatically poll unknown/review tasks", () => {
    const now = 1700000000000;
    const backoff = parseVideoTaskView(task({ next_poll_at: now + 120000, requires_review: false }));
    expect(videoTaskPollDue(backoff, now)).toBe(false);
    expect(videoTaskReadDue(backoff, now)).toBe(false);
    expect(videoTaskPollDue(backoff, now + 120000)).toBe(true);
    expect(videoTaskPollDue(task({ next_poll_at: new Date(now + 120000).toISOString() }), now)).toBe(false);
    for (const value of [task({ status: "submission_unknown" }), task({ requires_review: true })]) {
      expect(videoTaskPollDue(value, now)).toBe(false);
      expect(videoTaskReadDue(value, now)).toBe(true);  
    }
    for (const extra of [{ next_poll_at: -1 }, { next_poll_at: "bad" }, { next_poll_at: Infinity }, { requires_review: "yes" }]) expect(() => parseVideoTaskView({ ...task(), ...extra })).toThrow();
  });
  it("hard-caps history, retaining current and active tasks before completed history", () => {
    const completed = Array.from({ length: 500 }, (_, i) => task({ id: "done-" + i, status: "succeeded" }));
    const current = task({ id: "current", status: "succeeded" });
    const active = task({ id: "active" });
    const merged = mergeVideoTaskHistory([current, active, ...completed], [task({ id: "new" })], current.id);
    expect(merged).toHaveLength(VIDEO_TASK_HISTORY_CAP);
    expect(merged[0].id).toBe("current");
    expect(merged.map(value => value.id)).toContain("active");
    expect(new Set(merged.map(value => value.id)).size).toBe(merged.length);
    let growing: VideoTaskView[] = [];
    for (let i = 0; i < 500; i++) growing = mergeVideoTaskHistory(growing, [task({ id: String(i) })], "0");
    expect(growing).toHaveLength(VIDEO_TASK_HISTORY_CAP);
    expect(growing[0].id).toBe("0");
  });
  it("wires actual helpers into UI, shares per-task GET gates, and never detaches storage writes", () => {
    const code = readFileSync(new URL("../../web/src/components/ConsoleVideoCard.tsx", import.meta.url), "utf8");
    const remember = code.slice(code.indexOf("const remember ="), code.indexOf("const persist ="));
    expect(remember).not.toContain("saveVideoAttempt");
    expect(remember).not.toContain("async");
    expect(code).toContain("writes.current.catch(() => {}).then(() => saveVideoAttempt");
    expect(code.indexOf("await prepareVideoAttemptForPost(current, persist)")).toBeLessThan(code.indexOf("await videoApi.create(current, controller.signal)"));
    expect(code).toContain("!postStarted && canReleaseUnsentVideoAttempt(before)");
    expect(code).toContain("postStarted && videoDefinitelyNotDispatched(err)");
    expect(code).toContain("taskReads.current.has(id)");
    expect(code.indexOf("taskReads.current.add(id)")).toBeLessThan(code.indexOf("await videoApi.get(id, controller.signal)"));
    expect(code.split("await videoApi.get(")).toHaveLength(2);
    expect(code).toContain(".filter((task) => videoTaskPollDue(task))");
    expect(code).toContain(".map(({ id }) => refreshTask(id))");
    expect(code).toContain("mergeVideoTaskHistory(prev, next");
    expect(code).not.toContain("void saveVideoAttempt");
  });
});

describe("video GET429 backoff", () => {
  it("honors backoff for non-JSON429 and caps oversized server list snapshots at thirty", async () => {
    let now = 1700000000000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    login("non-json-rate-token");
    const many = Array.from({ length: 100 }, (_, i) => task({ id: String(i) }));
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: many })));
    vi.stubGlobal("fetch", fetcher);
    await expect(videoApi.get("limited")).rejects.toMatchObject({ response: { status: 429 }, retryAt: now + 60000 });
    await expect(videoApi.list()).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 60000;
    expect(await videoApi.list()).toHaveLength(30);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["120", "date", "missing"])("backs off list/detail reads after %s Retry-After without retrying POST", async kind => {
    let now = 1700000000000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    login("rate-limit-token-" + kind);
    const headers: Record<string, string> = kind === "missing" ? {} : { "Retry-After": kind === "date" ? new Date(now + 120000).toUTCString() : kind };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "limited" } }), { status: 429, headers }))
      .mockResolvedValueOnce(new Response(JSON.stringify(task()), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(task())));
    vi.stubGlobal("fetch", fetcher);
    const error = await videoApi.get("rate-limited").catch((error: unknown) => error);
    expect(videoErrorStatus(error)).toBe(429);
    expect(error.retryAt).toBe(now + (kind === "missing" ? 60000 : 120000));
    await expect(videoApi.list()).rejects.toMatchObject({ status: 429 });
    await expect(videoApi.get("another")).rejects.toMatchObject({ response: { status: 429 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await videoApi.create(createVideoAttempt(input, () => "new-safe-key"));  
    expect(fetcher).toHaveBeenCalledTimes(2);
    now = error.retryAt;
    await expect(videoApi.get("rate-limited")).resolves.toEqual(task());
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
