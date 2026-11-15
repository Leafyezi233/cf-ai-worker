import { ResponsesEventFramer } from "./responses_native";

const REQUEST_KEYS = new Set(["model","messages","tools","tool_choice","parallel_tool_calls","max_completion_tokens","max_tokens","reasoning_effort","response_format","stream","stream_options","store","temperature","top_p","metadata","user","service_tier","prompt_cache_key","prompt_cache_retention","n"]);
function parts(value: any, role: string): any {
  if (typeof value === "string") return [{ type: role === "assistant" ? "output_text" : "input_text", text: value }];
  if (value == null) return [];
  return value.map((p: any) => p.type === "text" ? { type: role === "assistant" ? "output_text" : "input_text", text: p.text }
    : { type: "input_image", image_url: typeof p.image_url === "string" ? p.image_url : p.image_url.url, ...(p.image_url?.detail ? {detail:p.image_url.detail} : {}) });
}
export function unsupportedChatToResponsesFields(body: any): string[] {
  const bad: string[] = [];
  for (const k of Object.keys(body || {})) if (!REQUEST_KEYS.has(k) && body[k] !== undefined) bad.push(k);
  if (body?.n !== undefined && body.n !== 1) bad.push("n");
  if (body?.store !== undefined && body.store !== false) bad.push("store");
  if (body?.stream_options && Object.keys(body.stream_options).some(k => k !== "include_usage")) bad.push("stream_options");
  if (!Array.isArray(body?.messages) || body.messages.length === 0) bad.push("messages");
  else body.messages.forEach((m: any, i: number) => {
    const at = "messages["+i+"]";
    if (!m || !["system","developer","user","assistant","tool"].includes(m.role)) { bad.push(at); return; }
    for (const k of Object.keys(m)) if (!["role","content","tool_calls","tool_call_id","reasoning_details","reasoning_content","refusal"].includes(k) && m[k] !== undefined) bad.push(at+"."+k);
    if (m.reasoning_content != null && (typeof m.reasoning_content !== "string" || !Array.isArray(m.reasoning_details) || m.reasoning_content !== m.reasoning_details.map(reasoningText).join(""))) bad.push(at+".reasoning_content");
    if (m.refusal != null && (m.role !== "assistant" || typeof m.refusal !== "string")) bad.push(at+".refusal");
    if (m.role === "tool" && (typeof m.tool_call_id !== "string" || !m.tool_call_id)) bad.push(at+".tool_call_id");
    if (m.content != null && typeof m.content !== "string" && !Array.isArray(m.content)) bad.push(at+".content");
    if (Array.isArray(m.content)) m.content.forEach((p: any, j: number) => {
      if (p && (Object.keys(p).some(k => !(p.type === "text" ? ["type","text"] : ["type","image_url"]).includes(k))
        || p.image_url && typeof p.image_url === "object" && Object.keys(p.image_url).some(k => !["url","detail"].includes(k)))) bad.push(at+".content["+j+"]");
      if (!p || (p.type !== "text" && p.type !== "image_url") || p.type === "text" && typeof p.text !== "string"
        || p.type === "image_url" && (m.role === "assistant" || typeof (typeof p.image_url === "string" ? p.image_url : p.image_url?.url) !== "string")) bad.push(at+".content["+j+"]");
    });
    if (m.tool_calls !== undefined && (!Array.isArray(m.tool_calls) || m.role !== "assistant")) bad.push(at+".tool_calls");
    if (Array.isArray(m.tool_calls)) m.tool_calls.forEach((t: any,j:number) => {
      if (t && (Object.keys(t).some(k=>!["id","type","function"].includes(k)) || t.function && Object.keys(t.function).some(k=>!["name","arguments"].includes(k)))) bad.push(at+".tool_calls["+j+"]");
      if (t?.type !== "function" || typeof t.id !== "string" || !t.id || typeof t.function?.name !== "string" || typeof t.function?.arguments !== "string") bad.push(at+".tool_calls["+j+"]");
    });
    if (m.reasoning_details !== undefined && (!Array.isArray(m.reasoning_details) || m.role !== "assistant"
      || m.reasoning_details.some((r:any) => r?.type !== "reasoning"))) bad.push(at+".reasoning_details");
  });
  if (body?.tools !== undefined && !Array.isArray(body.tools)) bad.push("tools");
  if (Array.isArray(body?.tools)) body.tools.forEach((t:any,i:number) => {
    if (t?.type !== "function" || typeof t.function?.name !== "string" || Object.keys(t).some(k=>!["type","function"].includes(k))
      || Object.keys(t.function || {}).some(k=>!["name","description","parameters","strict"].includes(k))) bad.push("tools["+i+"]");
  });
  if (body?.tool_choice !== undefined && !["none","auto","required"].includes(body.tool_choice)
    && !(body.tool_choice?.type === "function" && typeof body.tool_choice.function?.name === "string" && Object.keys(body.tool_choice).every(k=>["type","function"].includes(k)) && Object.keys(body.tool_choice.function).every(k=>k === "name"))) bad.push("tool_choice");
  const f = body?.response_format;
  if (f && (Object.keys(f).some(k=>!["type","json_schema"].includes(k)) || f.json_schema && Object.keys(f.json_schema).some(k=>!["name","description","schema","strict"].includes(k)))) bad.push("response_format");
  if (f && !(f.type === "text" || f.type === "json_object" || f.type === "json_schema" && typeof f.json_schema?.name === "string" && f.json_schema.schema)) bad.push("response_format");
  return [...new Set(bad)];
}
export function convertChatRequestToResponses(body: any): any {
  const bad = unsupportedChatToResponsesFields(body);
  if (bad.length) throw new Error("unsupported_chat_to_responses_fields: " + bad.join(", "));
  const input: any[] = [];
  for (const m of body.messages) {
    if (m.reasoning_details) input.push(...m.reasoning_details);
    if (m.role === "tool") input.push({type:"function_call_output",call_id:m.tool_call_id,output:typeof m.content === "string" ? m.content : parts(m.content,"user")});
    else {
      const content = parts(m.content,m.role);
      if (m.refusal) content.push({type:"refusal",refusal:m.refusal});
      if (content.length) input.push({role:m.role,content});
      if (m.tool_calls) for (const t of m.tool_calls) input.push({type:"function_call",call_id:t.id,name:t.function.name,arguments:t.function.arguments});
    }
  }
  const out: any = {model:body.model,input,store:false};
  for (const k of ["stream","temperature","top_p","parallel_tool_calls","metadata","user","service_tier","prompt_cache_key","prompt_cache_retention"]) if (body[k] !== undefined) out[k] = body[k];
  const limit = body.max_completion_tokens ?? body.max_tokens;
  if (limit !== undefined) out.max_output_tokens = limit;
  if (body.reasoning_effort !== undefined) out.reasoning = {effort:body.reasoning_effort};
  if (body.tools) out.tools = body.tools.map((t:any)=>({type:"function",...t.function}));
  if (body.tool_choice !== undefined) out.tool_choice = typeof body.tool_choice === "string" ? body.tool_choice : {type:"function",name:body.tool_choice.function.name};
  if (body.response_format) {
    const f = body.response_format;
    out.text = {format:f.type === "json_schema" ? {type:f.type,...f.json_schema} : {type:f.type}};
  }
  return out;
}
function usageOf(u:any):any {
  if (!u || typeof u !== "object") return undefined;
  const prompt = Number(u.input_tokens || 0), completion = Number(u.output_tokens || 0);
  return {prompt_tokens:prompt,completion_tokens:completion,total_tokens:Number(u.total_tokens ?? prompt+completion),
    ...(u.input_tokens_details ? {prompt_tokens_details:{...u.input_tokens_details}} : {}),
    ...(u.output_tokens_details ? {completion_tokens_details:{...u.output_tokens_details}} : {})};
}
function reason(obj:any, tools:boolean):string {
  const why = obj.incomplete_details?.reason;
  return why === "max_output_tokens" ? "length" : why === "content_filter" ? "content_filter" : tools ? "tool_calls" : "stop";
}
function contentOf(item:any):{text:string;refusal:string} {
  if (!Array.isArray(item.content)) throw Error("invalid_responses_content");
  let text = "", refusal = "";
  for (const p of item.content || []) {
    if (p?.type === "output_text" && typeof p.text === "string") text += p.text;
    else if (p?.type === "refusal" && typeof p.refusal === "string") refusal += p.refusal;
    else throw new Error("unsupported_responses_output_part");
  }
  return {text,refusal};
}
function reasoningText(item:any):string { return (item.summary || []).filter((p:any)=>typeof p.text === "string").map((p:any)=>p.text).join(""); }
export function convertResponsesToChatJson(obj:any, publicModel:string):any {
  if (!obj || obj.object !== "response" || !["completed","incomplete"].includes(obj.status)) throw new Error("invalid_responses_output");
  validateResponsesChatOutput(obj);
  const message:any = {role:"assistant",content:""};
  for (const item of obj.output || []) {
    if (item.type === "message") { const c=contentOf(item); message.content += c.text; if(c.refusal) message.refusal=(message.refusal || "")+c.refusal; }
    else if (item.type === "function_call") (message.tool_calls ??= []).push({id:item.call_id || item.id,type:"function",function:{name:item.name,arguments:item.arguments || ""}});
    else if (item.type === "reasoning") { (message.reasoning_details ??= []).push(item); const text=reasoningText(item); if(text) message.reasoning_content=(message.reasoning_content || "")+text; }
    else throw new Error("unsupported_responses_output_item");
  }
  if (!message.content && (message.tool_calls || message.refusal)) message.content = null;
  return {id:obj.id || "chatcmpl_cpg",object:"chat.completion",created:obj.created_at || Math.floor(Date.now()/1000),model:publicModel,
    choices:[{index:0,message,finish_reason:reason(obj,!!message.tool_calls?.length)}],...(obj.usage ? {usage:usageOf(obj.usage)} : {})};
}

function validateOutputItem(item:any):void {
  if (!item || typeof item !== "object") throw Error("invalid_responses_item");
  if (item.type === "message") { if (item.role !== undefined && item.role !== "assistant") throw Error("invalid_responses_role"); contentOf(item); }
  else if (item.type === "function_call") { if (typeof (item.call_id || item.id) !== "string" || !(item.call_id || item.id) || typeof item.name !== "string" || !item.name || typeof item.arguments !== "string") throw Error("invalid_responses_function"); }
  else if (item.type === "reasoning") { if (item.summary !== undefined && (!Array.isArray(item.summary) || item.summary.some((p:any)=>typeof p?.text !== "string"))) throw Error("invalid_responses_reasoning"); }
  else throw Error("unsupported_responses_output_item");
}
export function validateResponsesChatOutput(obj:any):void {
  if (!Array.isArray(obj?.output)) throw Error("invalid_responses_output");
  for (const item of obj.output) validateOutputItem(item);
}
export function createResponsesChatEventValidator(): (obj:any)=>void {
  const tools=new Set<number>();
  return (obj:any)=>{
    const t=obj.type;
    const i=obj.output_index ?? 0, j=obj.content_index ?? 0;
    if(!Number.isSafeInteger(i)||i<0||i>65535||!Number.isSafeInteger(j)||j<0||j>4096)throw Error("invalid_responses_index");
    if(t.endsWith(".delta") && typeof obj.delta !== "string") throw Error("invalid_responses_delta");
    if(t==="response.output_item.added") {
      if(!["message","reasoning","function_call"].includes(obj.item?.type)) throw Error("unsupported_responses_item");
      if(obj.item.type==="function_call") { validateOutputItem(obj.item);if(tools.size>=1024)throw Error("too_many_tools");tools.add(i); }
    }
    if(t==="response.function_call_arguments.delta"&&!tools.has(i))throw Error("missing_tool_start");
    if(t==="response.output_item.done") validateOutputItem(obj.item);
    if(t==="response.completed"||t==="response.incomplete") validateResponsesChatOutput(obj.response);
  };
}

export function createResponsesToChatTransform(publicModel:string):TransformStream<Uint8Array,Uint8Array> {
  const framer = new ResponsesEventFramer(), decoder = new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}), encoder = new TextEncoder();
  let terminal=false, failed=false, started=false, id="chatcmpl_cpg", created=Math.floor(Date.now()/1000), nextTool=0;
  type State = {text:Set<number>;refusal:Set<number>;summary:boolean;details:boolean;tool?:number;args:boolean;toolId?:string;name?:string};
  const validateEvent=createResponsesChatEventValidator();
  const states=new Map<number,State>();
  const state=(index:number):State=>{ if(!Number.isSafeInteger(index)||index<0||index>65535) throw Error("invalid_output_index"); let s=states.get(index); if(!s){if(states.size>=1024)throw Error("too_many_output_items");s={text:new Set(),refusal:new Set(),summary:false,details:false,args:false};states.set(index,s);}return s; };
  function send(ctrl:TransformStreamDefaultController<Uint8Array>, delta:any, finish:any=null, usage?:any) {
    ctrl.enqueue(encoder.encode("data: "+JSON.stringify({id,object:"chat.completion.chunk",created,model:publicModel,choices:delta===null?[]:[{index:0,delta,finish_reason:finish}],...(usage?{usage}: {})})+"\n\n"));
  }
  function begin(ctrl:TransformStreamDefaultController<Uint8Array>) {if(!started){started=true;send(ctrl,{role:"assistant",content:""});}}
  function done(ctrl:TransformStreamDefaultController<Uint8Array>) {ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));}
  function fail(ctrl:TransformStreamDefaultController<Uint8Array>) {if(terminal)return;failed=true;terminal=true;ctrl.enqueue(encoder.encode('data: {"error":{"type":"upstream_error","code":"invalid_responses_stream","message":"The upstream Responses stream failed or ended before completion."}}\n\n'));done(ctrl);}
  function full(item:any,index:number,ctrl:TransformStreamDefaultController<Uint8Array>) {
    const s=state(index);
    if(item.type==="message") (item.content || []).forEach((p:any,j:number)=>{if(p.type==="output_text"&&!s.text.has(j)){send(ctrl,{content:p.text || ""});s.text.add(j);}else if(p.type==="refusal"&&!s.refusal.has(j)){send(ctrl,{refusal:p.refusal || ""});s.refusal.add(j);}else if(!["output_text","refusal"].includes(p.type)) throw Error("unsupported_output");});
    else if(item.type==="function_call") { tool(item,index,ctrl); if(!s.args && item.arguments){send(ctrl,{tool_calls:[{index:s.tool,function:{arguments:item.arguments}}]});s.args=true;} }
    else if(item.type==="reasoning") {if(!s.summary){const text=reasoningText(item);if(text)send(ctrl,{reasoning_content:text});s.summary=true;}if(!s.details){send(ctrl,{reasoning_details:[item]});s.details=true;}}
    else throw Error("unsupported_output");
  }
  function tool(item:any,index:number,ctrl:TransformStreamDefaultController<Uint8Array>) {
    const s=state(index); if(s.tool===undefined){s.tool=nextTool++;s.toolId=item.call_id || item.id;s.name=item.name;
      if(typeof s.toolId!=="string"||typeof s.name!=="string")throw Error("invalid_tool");
      send(ctrl,{tool_calls:[{index:s.tool,id:s.toolId,type:"function",function:{name:s.name,arguments:""}}]});}
  }
  function event(lines:string[],ctrl:TransformStreamDefaultController<Uint8Array>):void|boolean {
    if(terminal)return false;
    const data=lines.filter(l=>l.startsWith("data:")).map(l=>l.slice(5).replace(/^ /,"")).join("\n");if(!data)return;
    if(data==="[DONE]")throw Error("missing_terminal");
    const obj=JSON.parse(data);const t=obj.type;
    if(typeof t!=="string")throw Error("invalid_event");
    const named=lines.find(l=>l.startsWith("event:"))?.slice(6).trim();if(named&&named!==t)throw Error("event_type_mismatch");
    if(obj.response?.id)id=obj.response.id;if(obj.response?.created_at)created=obj.response.created_at;
    validateEvent(obj);
    begin(ctrl);
    const i=obj.output_index ?? 0, j=obj.content_index ?? 0;
    if(!Number.isSafeInteger(j)||j<0||j>4096)throw Error("invalid_content_index");
    if(t==="response.output_text.delta"){const s=state(i);s.text.add(j);send(ctrl,{content:obj.delta || ""});}
    else if(t==="response.refusal.delta"){state(i).refusal.add(j);send(ctrl,{refusal:obj.delta || ""});}
    else if(t==="response.reasoning_summary_text.delta"||t==="response.reasoning_text.delta"){state(i).summary=true;send(ctrl,{reasoning_content:obj.delta || ""});}
    else if(t==="response.output_item.added"&&obj.item?.type==="function_call")tool(obj.item,i,ctrl);
    else if(t==="response.function_call_arguments.delta"){const s=state(i);if(s.tool===undefined)throw Error("missing_tool_start");s.args=true;send(ctrl,{tool_calls:[{index:s.tool,function:{arguments:obj.delta || ""}}]});}
    else if(t==="response.output_item.done")full(obj.item,i,ctrl);
    else if(t==="response.failed"||t==="error"){fail(ctrl);return false;}
    else if(t==="response.completed"||t==="response.incomplete") {
      const r=obj.response;if(r?.object!=="response"||r.status!==t.slice(9))throw Error("invalid_terminal");
      (r.output || []).forEach((item:any,index:number)=>full(item,index,ctrl));
      send(ctrl,{},reason(r,nextTool>0));if(r.usage)send(ctrl,null,null,usageOf(r.usage));terminal=true;done(ctrl);return false;
    }
  }
  return new TransformStream({
    transform(chunk,ctrl){if(terminal)return;try{framer.feed(decoder.decode(chunk,{stream:true}),lines=>event(lines,ctrl));}catch{fail(ctrl);}},
    flush(ctrl){if(terminal)return;try{framer.feed(decoder.decode(),lines=>event(lines,ctrl));}catch{failed=true;}if(!terminal||failed)fail(ctrl);}
  });
}
