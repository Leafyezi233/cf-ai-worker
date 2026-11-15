export async function withVideoDiagnosticDeadline<T>(work: () => Promise<T>, fallback: T, timeoutMs = 250): Promise<T> {
  if (timeoutMs <= 0) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), Math.min(250, timeoutMs)); }),
      Promise.resolve().then(work).catch(() => fallback),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
export interface VideoDiagnosticBody { text: string; truncated: boolean; error_code?: string }
export async function readVideoDiagnosticBody(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<VideoDiagnosticBody> {
  if (!body) return {text:"",truncated:false,error_code:"empty_body"};
  const reader=body.getReader();
  const chunks: Uint8Array[]=[]; let length=0, stopped=false;
  const cancel=()=>{stopped=true;void reader.cancel().catch(()=>{});};
  signal.addEventListener("abort",cancel,{once:true});
  let truncated=false, error_code: string|undefined;
  try {
    if(signal.aborted) cancel();
    while(!stopped){
      const item=await reader.read();
      if(stopped) break;
      if(item.done) break;
      const remaining=limit-length;
      const n=Math.min(remaining,item.value.byteLength);
      if(n>0){chunks.push(item.value.slice(0,n));length+=n;}
      if(n<item.value.byteLength){truncated=true;error_code="body_too_large";void reader.cancel().catch(()=>{});break;}
    }
    if(stopped) error_code="aborted";
  } catch {error_code="body_read_failed";} finally {
    signal.removeEventListener("abort",cancel);reader.releaseLock();
  }
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return {text:new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes),truncated,error_code};}
  catch{return {text:"",truncated,error_code:error_code || "invalid_utf8"};}
}
