import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  watchForStall,
  UPSTREAM_FIRST_CHUNK_TIMEOUT_MS as FIRST,
  UPSTREAM_STREAM_STALL_TIMEOUT_MS as GAP,
} from "../src/gateway/stream_relay";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.setSystemTime(0);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const abort = new AbortController();
  const stall = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(c) { source = c; }, cancel });
  const watched = watchForStall(new Response(body), abort, stall);
  return { source, cancel, abort, stall, watched, reader: watched.response.body!.getReader() };
}

it("keeps the first-byte deadline and closes/aborts once", async () => {
  const f = fixture();
  const read = f.reader.read();
  await vi.advanceTimersByTimeAsync(FIRST - 1);
  expect(f.stall).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await read).toMatchObject({ done: true });
  expect(f.stall).toHaveBeenCalledTimes(1);
  expect(f.abort.signal.aborted).toBe(true);
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("extends gap deadlines without creating timers per chunk and never stalls early", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout");
  const f = fixture();
  for (let i = 0; i < 1000; i++) {
    const read = f.reader.read();
    f.source.enqueue(new Uint8Array([i % 256]));
    expect((await read).value).toEqual(new Uint8Array([i % 256]));
  }
  expect(timers.mock.calls.length).toBeLessThanOrEqual(2);
  await vi.advanceTimersByTimeAsync(GAP - 1);
  const read = f.reader.read();
  f.source.enqueue(new Uint8Array([99]));
  await read;
  await vi.advanceTimersByTimeAsync(GAP - 1);
  expect(f.stall).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.stall).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("switches from the first-byte window to a full gap window", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(FIRST - 1);
  const read = f.reader.read();
  f.source.enqueue(new Uint8Array([1]));
  await read;
  await vi.advanceTimersByTimeAsync(GAP - 1);
  expect(f.stall).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.stall).toHaveBeenCalledTimes(1);
});

it("uses a monotonic deadline across wall-clock changes and repeated timer re-checks", async () => {
  const live = fixture();
  for (let i = 0; i < 5; i++) {
    const read = live.reader.read();
    live.source.enqueue(new Uint8Array([i]));
    await read;
    vi.setSystemTime(-1000000 * (i + 1));
    await vi.advanceTimersByTimeAsync(GAP - 1);
    expect(live.stall).not.toHaveBeenCalled();
  }
  await vi.advanceTimersByTimeAsync(1);
  expect(live.stall).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["stop", "cancel", "end", "error"])("%s clears all pending timers", async kind => {
  const f = fixture();
  if (kind === "stop") f.watched.stop();
  else if (kind === "cancel") await f.reader.cancel("local cancel");
  else {
    const read = f.reader.read();
    if (kind === "end") { f.source.close(); await read; }
    else { f.source.error(new Error("fixture")); await expect(read).rejects.toThrow("fixture"); }
  }
  await vi.advanceTimersByTimeAsync(FIRST + GAP);
  expect(f.stall).not.toHaveBeenCalled();
  expect(f.abort.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
