import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { Button, Card, Select } from "./ui";
type Result = {fingerprint:string;checked_at:number;expires_at:number;results:{endpoint:string;status:"supported"|"unsupported"|"unknown";http_status:number;latency_ms:number;reason:string}[]};
type Item={model_id:string;model_ids:string[];model_name:string;provider_name:string;fingerprint:string;endpoints:string[];cached:Result|null;needs_probe:boolean;manual_locked:boolean};
type Preview={items:Item[];request_count:number;skipped:number;ttl_ms:number};
export function ProtocolProbePanel({modelIds=[],providerId,onApplied}:{modelIds?:string[];providerId?:string;onApplied?:()=>void}) {
 const [open,setOpen]=useState(false),[scope,setScope]=useState("selected"),[force,setForce]=useState(false),[preview,setPreview]=useState<Preview|null>(null),[ack,setAck]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[completed,setCompleted]=useState(0);
 const stopped=useRef(false),mounted=useRef(true),working=useRef(false),generation=useRef(0);
 const signature=scope+":"+providerId+":"+modelIds.join("|")+":"+force;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;stopped.current=true;generation.current++;};},[]);
 useEffect(()=>{generation.current++;setPreview(null);setAck(false);stopped.current=true;},[signature]);
 async function showPreview(){if(working.current)return;const g=generation.current;setError("");setBusy(true);working.current=true;try{
  if(scope==="selected"&&!modelIds.length)throw Error("请先在列表勾选模型");if(scope==="provider"&&!providerId)throw Error("请先筛选服务商");
  const p=await api.post<Preview>("/api/models/protocol-probes/preview",{...(scope==="selected"?{model_ids:modelIds}:scope==="provider"?{provider_id:providerId}:{}),force});
  if(mounted.current&&g===generation.current){setPreview(p);setAck(false);setCompleted(0);}
 }catch(e){if(mounted.current)setError(e instanceof Error?e.message:"预览失败");}finally{working.current=false;if(mounted.current)setBusy(false);}}
 async function start(){if(working.current||!preview||!ack)return;working.current=true;stopped.current=false;setBusy(true);setError("");setCompleted(0);const g=generation.current;const queue=preview.items.filter(i=>i.needs_probe);let cursor=0;
  const worker=async()=>{while(!stopped.current&&mounted.current&&g===generation.current){const i=queue[cursor++];if(!i)return;try{const {result}=await api.post<{result:Result}>("/api/models/protocol-probes/run",{model_id:i.model_id,fingerprint:i.fingerprint,confirm_cost:true});if(mounted.current&&g===generation.current)setPreview(p=>p?{...p,items:p.items.map(x=>x.fingerprint===i.fingerprint?{...x,cached:result,needs_probe:result.results.some(r=>r.status==="unknown")}:x)}:p);}catch(e){if(mounted.current&&g===generation.current)setError(e instanceof Error?e.message:"探测失败，结果未知");}finally{if(mounted.current&&g===generation.current)setCompleted(n=>n+1);}}};
  try{await Promise.all([worker(),worker()]);}finally{working.current=false;if(mounted.current){setBusy(false);setAck(false);}}
 }
 async function apply(i:Item){if(working.current||!i.cached||!confirm("仅将建议应用到模型「"+i.model_name+"」？不修改同组其他模型。"))return;working.current=true;setBusy(true);try{await api.post("/api/models/protocol-probes/apply",{model_id:i.model_id,fingerprint:i.fingerprint});setPreview(p=>p?{...p,items:p.items.map(x=>x===i?{...x,manual_locked:true}:x)}:p);onApplied?.();}catch(e){setError(e instanceof Error?e.message:"应用失败");}finally{working.current=false;if(mounted.current)setBusy(false);}}
 return <Card title="批量协议探测（管理员主动操作）" action={<Button variant="outline" size="sm" onClick={()=>setOpen(!open)}>{open?"收起":"展开探测"}</Button>}>
 {open?<div className="space-y-3 text-sm"><p>普通调用不探测上游。预览不发送模型请求；开始后每目标最多 2 次真实请求、输出上限 16 token，仍可能产生费用。只验证基础非流式接口，不证明工具、推理、上下文或流式能力。</p>
 <div className="flex flex-wrap gap-3 items-center"><Select aria-label="探测范围" value={scope} disabled={busy} onChange={e=>setScope(e.target.value)}><option value="selected">已勾选模型</option><option value="provider">当前服务商筛选</option><option value="all">所有启用模型</option></Select><label><input type="checkbox" checked={force} disabled={busy} onChange={e=>setForce(e.target.checked)}/> 强制重测（否则仅未知／过期）</label><Button disabled={busy} onClick={showPreview}>预览范围与请求数</Button></div>
 {error?<p role="alert" className="text-red-600">{error}</p>:null}
 {preview?<><p>去重目标 {preview.items.length}，预计最多 {preview.request_count} 次请求，跳过 {preview.skipped} 项。有效期 24 小时；同凭据、入口、实际模型复用结果。已完成 {completed} 项。</p><label className="block"><input type="checkbox" checked={ack} disabled={busy} onChange={e=>setAck(e.target.checked)}/> 我确认可能产生上游费用，且不会自动修改协议配置</label><div className="flex gap-2"><Button disabled={busy||!ack||!preview.items.some(i=>i.needs_probe)} onClick={start}>开始探测</Button><Button variant="outline" disabled={!busy} onClick={()=>{stopped.current=true;}}>停止后续任务（已发请求等待结束）</Button></div>
 <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr><th>模型／来源</th><th>实测结果</th><th>手动应用</th></tr></thead><tbody>{preview.items.map(i=><tr key={i.fingerprint} className="border-t"><td className="p-2">{i.model_name}<br/>{i.provider_name}<br/>共享结果的配置数：{i.model_ids.length}</td><td className="p-2">{i.cached?<>{new Date(i.cached.checked_at).toLocaleString()}{i.cached.results.map(r=><div key={r.endpoint}>{r.endpoint}：{r.status==="supported"?"基础接口可用":r.status==="unsupported"?"明确不支持":"未知（不可判否）"} · HTTP {r.http_status} · {r.reason}</div>)}</>:"未探测"}</td><td className="p-2"><Button size="sm" disabled={busy||i.manual_locked||!i.cached||i.cached.expires_at<=Date.now()||i.cached.results.some(r=>r.status==="unknown")||!i.cached.results.some(r=>r.status==="supported")||i.endpoints.includes("messages")} onClick={()=>apply(i)}>仅应用该模型建议</Button>{i.manual_locked?<p>已有人工协议配置，受保护</p>:null}</td></tr>)}</tbody></table></div></>:null}</div>:<p className="text-xs text-slate-500">先预览，再确认费用执行；保存观察结果与手动应用配置分离。</p>}
 </Card>;
}
