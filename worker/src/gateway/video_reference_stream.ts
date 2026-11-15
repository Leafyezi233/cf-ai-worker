import { VideoReadLifecycle } from "./video_read_lifecycle";

export const REFERENCE_STREAM_LIMITS = Object.freeze({ concurrent: 16, perAccount: 4, maxChunkBytes: 1024 * 1024, totalMs: 60_000, idleMs: 15_000 });
let active = 0;
const owners = new Map<string,number>();
export function reserveReferenceRead(owner: string): (() => void) | null {
  const n = owners.get(owner) || 0;
  if (active >= REFERENCE_STREAM_LIMITS.concurrent || n >= REFERENCE_STREAM_LIMITS.perAccount) return null;
  active++; owners.set(owner,n+1); let released = false;
  return () => { if (released) return; released = true; active--; const left = (owners.get(owner) || 1)-1; if (left) owners.set(owner,left); else owners.delete(owner); };
}
interface ReferenceObject { size: number; body: ReadableStream<Uint8Array> }
export async function openReferenceBody(load: (signal: AbortSignal) => Promise<ReferenceObject | null>, expected: number, signal: AbortSignal, release: () => void): Promise<ReadableStream<Uint8Array>> {
  const loadAbort = new AbortController();
  const lifetime = new VideoReadLifecycle({signal, release, onStop: () => loadAbort.abort(), error:"reference_content_interrupted",
    totalMs:REFERENCE_STREAM_LIMITS.totalMs, idleMs:REFERENCE_STREAM_LIMITS.idleMs});
  let bytes = 0, empty = 0;
  try {
    const object = await lifetime.open(() => load(loadAbort.signal), value => value?.body);
    if (lifetime.stopped) throw new Error("reference_content_interrupted");
    if (!object || object.size !== expected) throw new Error("reference_content_unavailable");
    lifetime.armIdle();
    return new ReadableStream<Uint8Array>({
      start(c) { lifetime.bind(c); },
      async pull(c) {
        try {
          const part = await lifetime.read();
          if (lifetime.stopped) return;
          if (part.done) {
            if (bytes !== expected) throw new Error("reference_content_interrupted");
            lifetime.finish(); c.close(); return;
          }
          if (!part.value.byteLength) { if (++empty > 16) throw new Error("reference_content_interrupted"); }
          else empty = 0;
          bytes += part.value.byteLength;
          if (part.value.byteLength > REFERENCE_STREAM_LIMITS.maxChunkBytes || bytes > expected) throw new Error("reference_content_interrupted");
          c.enqueue(part.value);
        } catch { lifetime.stop(); }
      },
      cancel() { lifetime.stop(); }
    },{highWaterMark:0});
  } catch (error) { lifetime.stop(); throw error; }
}
