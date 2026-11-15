import type { Env, ModelWithProvider } from "../types";
import { beginBillingAttempt, heartbeatBillingRequest, observeBillingAttempt } from "../db/request_billing";
import { UsageAccumulator, type UsageSnapshot } from "./usage_accumulator";
import type { WireProtocol } from "./protocol_connections";
import type { JsonDecodeResult } from "./json_decode";

export const BILLING_LEASE_MS = 120_000;
export const BILLING_HEARTBEAT_MS = 30_000;
export const TEXT_BODY_DEADLINE_MS = 300_000;
export const TEXT_TOTAL_DEADLINE_MS = 1_800_000;
const requests = new WeakMap<object, ManagedBillingRequest>();
export class ManagedBillingRequest {
  attempt?: BillingObservation;
  readonly startedAt = Date.now();
  settlement?: Promise<{ costUsd: number }>;
  constructor(readonly env: Env, readonly requestId: string) {}
  async begin(row: ModelWithProvider, model: string, protocol: WireProtocol): Promise<BillingObservation> {
    this.attempt?.stop();
    const id = await beginBillingAttempt(this.env, { request_id: this.requestId, provider_id: row.provider_id, model, protocol });
    return this.attempt = new BillingObservation(this, id, protocol);
  }
}
export function manageBillingRequest(c: object, env: Env, requestId: string): ManagedBillingRequest {
  const value = new ManagedBillingRequest(env, requestId);
  requests.set(c, value);
  return value;
}
export function managedBillingRequest(c: object): ManagedBillingRequest | undefined { return requests.get(c); }

export class BillingObservation {
  meter: UsageAccumulator;
  outcome = "unknown";
  streaming = false;
  httpStatus = 0;
  headers(status: number): void { this.httpStatus = status; }
  onFailure?: (status: number) => Promise<unknown>;
  onComplete?: () => Promise<unknown>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private bodyDeadline?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private failure?: Error;
  private interrupt?: () => void;
  private upstreamRequestId: string | null = null;
  private stopped = false;
  private lastUsage: string;
  private acknowledged: { meter: UsageAccumulator; revision: number; outcome: string; headerId: string | null };
  private checkpointSnapshot?: UsageSnapshot;
  private completedCheckpoint = "";
  private checkpoints: Promise<void> = Promise.resolve();
  private heartbeatWrite?: Promise<void>;
  constructor(readonly request: ManagedBillingRequest, readonly attemptId: string, private readonly protocol: WireProtocol) {
    this.meter = new UsageAccumulator(protocol);
    this.lastUsage = this.checkpointKey(this.meter.snapshot());
    this.acknowledged = { meter: this.meter, revision: this.meter.revision, outcome: this.outcome, headerId: this.upstreamRequestId };
  }
  start(controller: AbortController): void {
    this.controller = controller;
    this.heartbeat = setInterval(() => {
      if (this.stopped || this.failure || this.request.settlement || this.heartbeatWrite) return;
      const pending = heartbeatBillingRequest(this.request.env, this.request.requestId, BILLING_LEASE_MS);
      this.heartbeatWrite = pending;
      void pending.then(() => {
        if (this.heartbeatWrite === pending) this.heartbeatWrite = undefined;
      }, () => {
        this.fail("billing_storage_unavailable", "upstream_error", 502);
      });
    }, BILLING_HEARTBEAT_MS);
    this.deadline = setTimeout(() => this.fail("upstream_total_timeout", "timeout", 504),
      Math.max(1, TEXT_TOTAL_DEADLINE_MS - (Date.now() - this.request.startedAt)));
  }
  mark(outcome: string): void { this.outcome = outcome; }
  observeJson(value: unknown): void {
    const parsed = new UsageAccumulator(this.protocol);
    parsed.observeJson(value);
    const snapshot = parsed.finish();
    if (snapshot.usage || snapshot.completed || snapshot.failed) this.meter = parsed;
  }
  private fail(message: string, outcome: string, status: number): void {
    if (this.failure || this.stopped) return;
    this.failure = new Error(message);
    this.outcome = outcome;
    this.controller?.abort();
    this.interrupt?.();
    void this.onFailure?.(status).catch(() => {   });
  }
  private checkpointOutcome(s: UsageSnapshot): string {
    return this.outcome !== "unknown" ? this.outcome : s.failed ? "upstream_error" : s.completed ? "completed" : "unknown";
  }
  private checkpointKey(s: UsageSnapshot): string {
    return JSON.stringify([s.usage, s.source, s.provenance, s.upstreamRequestId ?? this.upstreamRequestId,
      this.checkpointOutcome(s), s.completed, s.failed]);
  }
  checkpoint(): Promise<void> {
    const pending = this.checkpoints.then(() => this.persistCheckpoint());
    this.checkpoints = pending.catch(() => {});
    return pending;
  }
  private async persistCheckpoint(): Promise<void> {
    if (this.request.settlement) { await this.request.settlement; return; }
    const captured = { meter: this.meter, revision: this.meter.revision, outcome: this.outcome, headerId: this.upstreamRequestId };
    const ack = this.acknowledged;
    const changed = captured.meter !== ack.meter || captured.revision !== ack.revision
      || captured.outcome !== ack.outcome || captured.headerId !== ack.headerId;
    let s = this.checkpointSnapshot;
    let json = this.lastUsage;
    if (changed) {
      s = captured.meter.snapshot();
      const outcome = this.checkpointOutcome(s);
      const upstreamRequestId = s.upstreamRequestId ?? captured.headerId;
      json = this.checkpointKey(s);
      if (json !== this.lastUsage) {
        await this.heartbeatWrite;
        await observeBillingAttempt(this.request.env, this.attemptId, {
          usage: s.usage, usage_source: s.source, provenance_json: JSON.stringify(s.provenance),
          upstream_request_id: upstreamRequestId, outcome,
        });
        this.lastUsage = json;
      }
      this.acknowledged = captured;
      this.checkpointSnapshot = s;
    }
    if (!s) return;
    if (this.onComplete && this.completedCheckpoint !== json && (s.source === "reported_final" || (s.failed && s.usage))) {
      await this.onComplete();
      this.completedCheckpoint = json;
    }
  }
  response(upstream: Response, stream: boolean, signal: AbortSignal, onJson?: (result: JsonDecodeResult) => void): Response {
    this.streaming = stream;
    const cancel = () => this.fail("client_cancelled", "cancelled", 499);
    signal.addEventListener("abort", cancel, { once: true });
    const stop = this.stop.bind(this);
    this.stop = () => { signal.removeEventListener("abort", cancel); stop(); };
    if (signal.aborted) cancel();
    if (!stream) this.bodyDeadline = setTimeout(() => this.fail("upstream_body_timeout", "timeout", 504), TEXT_BODY_DEADLINE_MS);
    this.upstreamRequestId = upstream.headers.get("request-id") ?? upstream.headers.get("x-request-id");
    if (!upstream.body) { this.stop(); return upstream; }
    const reader = upstream.body.getReader();
    this.interrupt = () => { void reader.cancel(this.failure).catch(() => {}); };
    const observation = this;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          if (observation.failure) throw observation.failure;
          const result = await reader.read();
          if (observation.failure) throw observation.failure;
          if (result.done) {
            observation.meter.finish(onJson);
            const snapshot = observation.meter.snapshot();
            if (observation.outcome === "unknown") observation.outcome = snapshot.failed ? "upstream_error" : snapshot.completed ? "completed" : "unknown";
            await observation.checkpoint();
            observation.stop();
            ctrl.close();
          } else {
            observation.meter.push(result.value);
            await observation.checkpoint();
            ctrl.enqueue(result.value);
          }
        } catch (error) {
          if (observation.outcome === "unknown") observation.outcome = "upstream_error";
          observation.meter.finish();
          observation.stop();
          try { await observation.onFailure?.(observation.outcome === "timeout" ? 504 : observation.outcome === "cancelled" ? 499 : 502); } catch {}
          observation.controller?.abort();
          void reader.cancel(error).catch(() => {});
          ctrl.error(error);
        }
      },
      async cancel(reason) {
        if (observation.meter.snapshot().completed) {
          observation.outcome = "completed"; observation.meter.finish(); observation.stop();
          await reader.cancel(reason); return;
        }
        observation.outcome = "cancelled";
        observation.meter.finish();
        observation.controller?.abort();
        observation.stop();
        try { await observation.onFailure?.(499); } finally { await reader.cancel(reason); }
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    if (this.deadline !== undefined) clearTimeout(this.deadline);
    if (this.bodyDeadline !== undefined) clearTimeout(this.bodyDeadline);
  }
}
