import { afterEach, describe, expect, it, vi } from "vitest";
import { openReferenceBody, reserveReferenceRead, REFERENCE_STREAM_LIMITS } from "../src/gateway/video_reference_stream";

afterEach(() => { vi.useRealTimers(); });
describe("bounded private reference streams", () => {
  it("caps isolate and account slots, releases idempotently", () => {
    const releases: (()=>void)[]=[];
    for(let i=0;i<16;i++) { const release=reserveReferenceRead("owner-"+Math.floor(i/4)); expect(release).not.toBeNull();releases.push(release!); }
    expect(reserveReferenceRead("extra")).toBeNull();expect(reserveReferenceRead("owner-0")).toBeNull();
    for(const release of releases){release();release();}
    const again=reserveReferenceRead("extra");expect(again).not.toBeNull();again!();
  });
  it("uses backpressure and cancels the R2 body without waiting for cancel acknowledgement", async () => {
    let pulls=0,cancels=0,ack!:()=>void;const release=vi.fn();
    const source=new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(new Uint8Array(64));},cancel(){cancels++;return new Promise<void>(resolve=>{ack=resolve;});}},{highWaterMark:0});
    const result=await openReferenceBody(async()=>({body:source,size:128}),128,new AbortController().signal,release);
    expect(pulls).toBe(0);const reader=result.getReader();expect((await reader.read()).value!.length).toBe(64);expect(pulls).toBe(1);
    await reader.cancel();expect(cancels).toBe(1);expect(release).not.toHaveBeenCalled();
    ack();for(let i=0;i<8;i++)await Promise.resolve();expect(release).toHaveBeenCalledTimes(1);
  });
  it.each(["overflow","truncated","chunk"] as const)("rejects %s with private errors and no file accumulation",async mode=>{
    const release=vi.fn();let sent=false;
    const body=new ReadableStream<Uint8Array>({pull(c){if(sent){c.close();return;}sent=true;c.enqueue(new Uint8Array(mode==="chunk"?REFERENCE_STREAM_LIMITS.maxChunkBytes+1:64));}},{highWaterMark:0});
    const size=mode==="overflow"?32:mode==="chunk"?2*1024*1024:128;
    const result=await openReferenceBody(async()=>({body,size}),size,new AbortController().signal,release);
    await expect(new Response(result).arrayBuffer()).rejects.toThrow("reference_content_interrupted");expect(release).toHaveBeenCalledTimes(1);
  });
  it("closes normally only at the declared length",async()=>{
    const release=vi.fn();const body=new Blob([new Uint8Array(64)]).stream();
    const stream=await openReferenceBody(async()=>({body,size:64}),64,new AbortController().signal,release);
    expect((await new Response(stream).arrayBuffer()).byteLength).toBe(64);expect(release).toHaveBeenCalledTimes(1);
  });
  it("bounds a stalled storage lookup and cancels its late body",async()=>{
    vi.useFakeTimers();let finish!: (value:{body:ReadableStream<Uint8Array>;size:number})=>void;const release=vi.fn(),cancel=vi.fn();
    const pending=openReferenceBody(()=>new Promise(resolve=>{finish=resolve;}),64,new AbortController().signal,release);
    const assertion=expect(pending).rejects.toThrow("reference_content_interrupted");await vi.advanceTimersByTimeAsync(15000);await assertion;
    expect(release).not.toHaveBeenCalled();
    finish({body:new ReadableStream({cancel}),size:64});for(let i=0;i<8;i++)await Promise.resolve();expect(cancel).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledTimes(1);
  });
  it("expires an unconsumed body and propagates client cancellation",async()=>{
    vi.useFakeTimers();
    for(const abort of [false,true]) {
      const release=vi.fn(),cancel=vi.fn(),controller=new AbortController();
      const body=new ReadableStream<Uint8Array>({cancel},{highWaterMark:0});
      const result=await openReferenceBody(async()=>({body,size:64}),64,controller.signal,release);
      if(abort) controller.abort();else await vi.advanceTimersByTimeAsync(15000);
      await expect(result.getReader().read()).rejects.toThrow("reference_content_interrupted");expect(release).toHaveBeenCalledTimes(1);expect(cancel).toHaveBeenCalledTimes(1);
    }
  });
  it("keeps sixteen slow 5MiB consumers demand-driven with bounded byte lead",async()=>{
    const total=5*1024*1024,chunk=65536;const states:{produced:number;read:number;reader:ReadableStreamDefaultReader<Uint8Array>}[]=[];
    try {
      for(let i=0;i<16;i++){const release=reserveReferenceRead("slow-"+Math.floor(i/4))!;let state:{produced:number;read:number;reader:ReadableStreamDefaultReader<Uint8Array>};
        const body=new ReadableStream<Uint8Array>({pull(c){if(state.produced===total){c.close();return;}state.produced+=chunk;c.enqueue(new Uint8Array(chunk));}},{highWaterMark:0});
        const stream=await openReferenceBody(async()=>({body,size:total}),total,new AbortController().signal,release);state={produced:0,read:0,reader:stream.getReader()};states.push(state);
      }
      for(const state of states)expect(state.produced).toBe(0);
      for(let round=0;round<80;round++){for(const state of states){const part=await state.reader.read();state.read+=part.value!.length;expect(state.produced-state.read).toBeLessThanOrEqual(chunk);}}
      for(const state of states){expect((await state.reader.read()).done).toBe(true);expect(state.read).toBe(total);}
    } finally {for(const state of states)await state.reader.cancel().catch(()=>{});}
  });
  it("rejects metadata size disagreement and releases the read slot",async()=>{
    const release=vi.fn(),cancel=vi.fn();const body=new ReadableStream<Uint8Array>({cancel});
    await expect(openReferenceBody(async()=>({body,size:128}),64,new AbortController().signal,release)).rejects.toThrow("reference_content_unavailable");
    expect(release).toHaveBeenCalledTimes(1);expect(cancel).toHaveBeenCalledTimes(1);
  });
});
