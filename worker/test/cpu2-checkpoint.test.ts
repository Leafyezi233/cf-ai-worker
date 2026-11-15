import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
const db = vi.hoisted(() => ({ observe: vi.fn(), heartbeat: vi.fn() }));
vi.mock("../src/db/request_billing", () => ({ observeBillingAttempt: db.observe, heartbeatBillingRequest: db.heartbeat, beginBillingAttempt: vi.fn() }));
import { BillingObservation, ManagedBillingRequest, BILLING_HEARTBEAT_MS } from "../src/gateway/billing_lifecycle";
const enc = new TextEncoder();
const active: BillingObservation[] = [];
function observation() { const o = new BillingObservation(new ManagedBillingRequest({} as Env, "r"), "a", "chat/completions"); active.push(o); return o; }
function report(o: BillingObservation, n: number) { o.meter.observeJson({ usage: { prompt_tokens: 1, completion_tokens: n } }); }
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { db.observe.mockReset().mockResolvedValue(undefined); db.heartbeat.mockReset().mockResolvedValue(undefined); });
afterEach(() => { active.splice(0).forEach(o => o.stop()); vi.restoreAllMocks(); vi.useRealTimers(); });
it("does no snapshots/stringify on text-only or unchanged semantic checkpoints", async () => {
  const o = observation(); const snapshot = vi.spyOn(o.meter, "snapshot"), stringify = vi.spyOn(JSON, "stringify");
  const bytes = enc.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
  for (let i = 0; i < 500; i++) { o.meter.push(bytes); await o.checkpoint(); }
  const counts = [snapshot.mock.calls.length, stringify.mock.calls.length];
  expect(counts).toEqual([0, 0]); expect(db.observe).not.toHaveBeenCalled();
  report(o, 0); await o.checkpoint(); snapshot.mockClear(); stringify.mockClear();
  for (let i = 0; i < 100; i++) { report(o, 0); await o.checkpoint(); }
  expect([snapshot.mock.calls.length, stringify.mock.calls.length]).toEqual([0, 0]);
  expect(db.observe).toHaveBeenCalledTimes(1);
});
it("acknowledges only the captured revision after a concurrent successful write", async () => {
  const o = observation(), g = gate(); report(o, 1); db.observe.mockReturnValueOnce(g.promise);
  const a = o.checkpoint(); await vi.waitFor(() => expect(db.observe).toHaveBeenCalledTimes(1));
  report(o, 2); g.resolve(); await a; await o.checkpoint(); await o.checkpoint();
  expect(db.observe.mock.calls.map(c => c[2].usage.output_tokens)).toEqual([1, 2]);
});
it("does not acknowledge a meter replacement made during an in-flight write", async () => {
  const o = observation(), g = gate(); report(o, 1); db.observe.mockReturnValueOnce(g.promise);
  const a = o.checkpoint(); await vi.waitFor(() => expect(db.observe).toHaveBeenCalledTimes(1));
  o.observeJson({ usage: { prompt_tokens: 1, completion_tokens: 2 } });
  g.resolve(); await a; await o.checkpoint(); await o.checkpoint();
  expect(db.observe.mock.calls.map(c => c[2].usage.output_tokens)).toEqual([1, 2]);
});
it("tracks replaced meter identity even when replacement revision is equal", async () => {
  const o = observation(); o.observeJson({ usage: { prompt_tokens: 1, completion_tokens: 1 } }); await o.checkpoint();
  o.observeJson({ usage: { prompt_tokens: 1, completion_tokens: 2 } }); await o.checkpoint();
  expect(db.observe.mock.calls.map(c => c[2].usage.output_tokens)).toEqual([1, 2]);
  o.observeJson({ usage: { prompt_tokens: 1, completion_tokens: 2 } }); await o.checkpoint();
  expect(db.observe).toHaveBeenCalledTimes(2);
});
it("captures outcome/header ID before waiting for a heartbeat and retries the new facts", async () => {
  vi.useFakeTimers(); const o = observation(), g = gate(); db.heartbeat.mockReturnValueOnce(g.promise);
  o.start(new AbortController()); await vi.advanceTimersByTimeAsync(BILLING_HEARTBEAT_MS); report(o, 1);
  const a = o.checkpoint(); await vi.advanceTimersByTimeAsync(0);
  o.mark("cancelled"); o.response(new Response(null, { headers: { "request-id": "later" } }), true, new AbortController().signal);
  g.resolve(); await a; await o.checkpoint();
  expect(db.observe.mock.calls.map(c => [c[2].outcome, c[2].upstream_request_id])).toEqual([["unknown", null], ["cancelled", "later"]]);
});
it("retries failed writes without acknowledging their semantic version", async () => {
  const o = observation(); report(o, 0); db.observe.mockRejectedValueOnce(new Error("offline failure"));
  await expect(o.checkpoint()).rejects.toThrow("offline failure"); await o.checkpoint(); await o.checkpoint();
  expect(db.observe).toHaveBeenCalledTimes(2);
});
