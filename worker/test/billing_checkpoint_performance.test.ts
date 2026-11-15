import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
const db = vi.hoisted(() => ({ observe: vi.fn(), heartbeat: vi.fn(), begin: vi.fn() }));
vi.mock("../src/db/request_billing", () => ({
  observeBillingAttempt: db.observe, heartbeatBillingRequest: db.heartbeat, beginBillingAttempt: db.begin,
}));
import { BillingObservation, ManagedBillingRequest, BILLING_HEARTBEAT_MS } from "../src/gateway/billing_lifecycle";

const enc = new TextEncoder();
const NL = String.fromCharCode(10).repeat(2);
const active: BillingObservation[] = [];
function observation(protocol: "chat/completions" | "messages" | "responses" = "chat/completions") {
  const request = new ManagedBillingRequest({} as Env, "request-one");
  const value = new BillingObservation(request, "attempt-one", protocol);
  active.push(value); return value;
}
function event(o: BillingObservation, value: unknown) {
  o.meter.push(enc.encode("data: " + JSON.stringify(value) + NL));
}
function usage(o: BillingObservation, output = 2) {
  event(o, { choices: [], usage: { prompt_tokens: 10, completion_tokens: output, total_tokens: 10 + output } });
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => { db.observe.mockReset().mockResolvedValue(undefined); db.heartbeat.mockReset().mockResolvedValue(undefined); });
afterEach(() => { active.splice(0).forEach(o => o.stop()); vi.useRealTimers(); });

describe("lossless checkpoint deduplication", () => {
  it("does not write empty or text-only snapshots already represented by the attempt", async () => {
    const o = observation(); await o.checkpoint();
    event(o, { choices: [{ delta: { content: "hello" } }] }); await o.checkpoint();
    expect(db.observe).not.toHaveBeenCalled();
  });
  it("records real zeros, changed usage and partial-to-final without summing or dropping information", async () => {
    const o = observation(); usage(o, 0); await o.checkpoint(); await o.checkpoint();
    usage(o, 3); await o.checkpoint();
    o.meter.push(enc.encode("data: [DONE]" + NL)); await o.checkpoint(); await o.checkpoint(); o.meter.finish(); await o.checkpoint();
    expect(db.observe).toHaveBeenCalledTimes(3);
    expect(db.observe.mock.calls[0][2].usage.output_tokens).toBe(0);
    expect(db.observe.mock.calls[2][2].usage_source).toBe("reported_final");
    expect(db.observe.mock.calls[2][2].usage.output_tokens).toBe(3);
  });
  it("persists zero-token terminal and failure markers even when there is no numeric usage", async () => {
    const o = observation("messages");
    event(o, { type: "message_stop" }); await o.checkpoint(); await o.checkpoint();
    expect(db.observe).toHaveBeenCalledTimes(1);
    const failed = observation("responses"); event(failed, { type: "response.failed", response: { status: "failed" } });
    await failed.checkpoint(); await failed.checkpoint();
    expect(db.observe).toHaveBeenCalledTimes(2);
  });
  it("tracks effective header request ID and outcome, not just parsed usage", async () => {
    const o = observation();
    const response = o.response(new Response(null, { headers: { "x-request-id": "header-id" } }), true, new AbortController().signal);
    await response.text(); await o.checkpoint(); await o.checkpoint();
    expect(db.observe).toHaveBeenCalledTimes(1);
    expect(db.observe.mock.calls[0][2].upstream_request_id).toBe("header-id");
    o.mark("upstream_error"); await o.checkpoint(); await o.checkpoint();
    expect(db.observe).toHaveBeenCalledTimes(2);
    expect(db.observe.mock.calls[1][2].outcome).toBe("upstream_error");
  });
  it("records a parsed request ID-only transition without changing usage or provenance", async () => {
    const o = observation(); usage(o); await o.checkpoint();
    event(o, { request_id: "request-new", choices: [] });
    await o.checkpoint(); await o.checkpoint();
    expect(db.observe).toHaveBeenCalledTimes(2);
    const before = db.observe.mock.calls[0][2], after = db.observe.mock.calls[1][2];
    expect(after.usage).toEqual(before.usage);
    expect(after.usage_source).toBe(before.usage_source);
    expect(after.provenance_json).toBe(before.provenance_json);
    expect(before.upstream_request_id).toBeNull();
    expect(after.upstream_request_id).toBe("request-new");
  });
  it("records provenance-only transitions with identical numeric usage, source and request ID", async () => {
    const o = observation(); usage(o); await o.checkpoint();
    event(o, { choices: [], usage: { input_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    await o.checkpoint(); await o.checkpoint();
    expect(db.observe).toHaveBeenCalledTimes(2);
    const before = db.observe.mock.calls[0][2], after = db.observe.mock.calls[1][2];
    expect(after.usage).toEqual(before.usage);
    expect(after.usage_source).toBe(before.usage_source);
    expect(after.upstream_request_id).toBe(before.upstream_request_id);
    expect(JSON.parse(before.provenance_json).input_tokens).toBe("usage.prompt_tokens");
    expect(JSON.parse(after.provenance_json).input_tokens).toBe("usage.input_tokens");
  });
  it("serializes concurrent identical checkpoints and retries failed persistence", async () => {
    const o = observation(); usage(o); const gate = deferred(); db.observe.mockReturnValueOnce(gate.promise);
    const a = o.checkpoint(), b = o.checkpoint(); await vi.waitFor(() => expect(db.observe).toHaveBeenCalledTimes(1));
    gate.resolve(); await Promise.all([a,b]); expect(db.observe).toHaveBeenCalledTimes(1);
    usage(o, 4); db.observe.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(o.checkpoint()).rejects.toThrow("storage unavailable");
    await o.checkpoint(); expect(db.observe).toHaveBeenCalledTimes(3);
  });
  it("does not suppress retrying a failed completion callback after the observation is committed", async () => {
    const o = observation(); usage(o); o.meter.push(enc.encode("data: [DONE]" + NL));
    const complete = vi.fn().mockRejectedValueOnce(new Error("settlement unavailable")).mockResolvedValue(undefined); o.onComplete = complete;
    await expect(o.checkpoint()).rejects.toThrow("settlement unavailable"); await o.checkpoint(); await o.checkpoint();
    expect(db.observe).toHaveBeenCalledTimes(1); expect(complete).toHaveBeenCalledTimes(2);
  });
  it("does not forward usage-bearing bytes before a successful observation write", async () => {
    const o = observation(); const gate = deferred(); db.observe.mockReturnValueOnce(gate.promise);
    const bytes = enc.encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}' + NL);
    const wrapped = o.response(new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } })), true, new AbortController().signal);
    const reader = wrapped.body!.getReader(); let received = false;
    const read = reader.read().then(result => { received = true; return result; });
    await vi.waitFor(() => expect(db.observe).toHaveBeenCalledTimes(1)); expect(received).toBe(false);
    gate.resolve(); expect((await read).value).toEqual(bytes); await reader.cancel();
  });
});

describe("bounded single-flight heartbeat", () => {
  it("does not queue extra writes while renewal is in flight, then resumes on the next tick", async () => {
    vi.useFakeTimers(); const o = observation(); const gate = deferred(); db.heartbeat.mockReturnValueOnce(gate.promise);
    o.start(new AbortController()); await vi.advanceTimersByTimeAsync(BILLING_HEARTBEAT_MS * 3);
    expect(db.heartbeat).toHaveBeenCalledTimes(1); gate.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(db.heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BILLING_HEARTBEAT_MS); expect(db.heartbeat).toHaveBeenCalledTimes(2);
  });
  it("changed checkpoints wait for the in-flight renewal", async () => {
    vi.useFakeTimers(); const o = observation(); const gate = deferred(); db.heartbeat.mockReturnValueOnce(gate.promise);
    o.start(new AbortController()); await vi.advanceTimersByTimeAsync(BILLING_HEARTBEAT_MS); usage(o);
    const pending = o.checkpoint(); await vi.advanceTimersByTimeAsync(0); expect(db.observe).not.toHaveBeenCalled();
    gate.resolve(); await pending; expect(db.observe).toHaveBeenCalledTimes(1);
  });
  it("failed renewal aborts upstream, rejects changed checkpoints and stops timer submissions", async () => {
    vi.useFakeTimers(); const o = observation(), controller = new AbortController();
    db.heartbeat.mockRejectedValueOnce(new Error("lease expired")); o.start(controller);
    await vi.advanceTimersByTimeAsync(BILLING_HEARTBEAT_MS); expect(controller.signal.aborted).toBe(true);
    usage(o); await expect(o.checkpoint()).rejects.toThrow(); expect(db.observe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BILLING_HEARTBEAT_MS * 3); expect(db.heartbeat).toHaveBeenCalledTimes(1);
  });
  it("stop while renewal is pending never drains previously queued ticks", async () => {
    vi.useFakeTimers(); const o = observation(); const gate = deferred(); db.heartbeat.mockReturnValueOnce(gate.promise);
    o.start(new AbortController()); await vi.advanceTimersByTimeAsync(BILLING_HEARTBEAT_MS * 3); o.stop();
    gate.resolve(); await vi.advanceTimersByTimeAsync(BILLING_HEARTBEAT_MS * 2); expect(db.heartbeat).toHaveBeenCalledTimes(1);
  });
});
