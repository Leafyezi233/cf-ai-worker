import { useEffect, useMemo, useRef, useState } from "react";
import { getConsoleToken, type ConsoleModels } from "../api/consoleClient";
import { standardVideoApi, StandardVideoApiError } from "../api/standardVideoClient";
import { loadStandardVideoAttempt, saveStandardVideoAttempt, newStandardVideoAttempt, standardAttemptFinished, standardVideoResultUrl, standardVideoTicketUrl, validateStandardVideoInput, precheckStandardReference, type StandardVideoLimits, type StandardVideoAttempt, type StandardVideoTask, type ReferenceUploadLimits, type StandardReference } from "../utils/standardVideoTask";
import { videoExpiryTime, type VideoContentTicket } from "../utils/videoReferences";
import { Button, Card, Input, Select, Textarea } from "./ui";
const EMPTY_LIMITS_BY_MODEL: Record<string,StandardVideoLimits> = Object.freeze({});
const IMAGE_LIMITS: ReferenceUploadLimits = {enabled:true, formats:["image/jpeg","image/png","image/webp"], max_bytes:5*1024*1024, max_duration_ms:0};
const LABELS = {queued:"排队中", in_progress:"生成中", completed:"已完成", failed:"失败", submission_unknown:"提交结果未知"};
const message = (e: unknown) => e instanceof StandardVideoApiError ? e.message : "请求未获确认，请手动查询或检查输入；不会自动创建或重试视频";
type Reference = {kind:"images"|"videos"; role:"reference"|"first"|"last"; name:string; asset:StandardReference};
export function StandardVideoTicketMedia({ticket, path}: {ticket:VideoContentTicket; path:string}) {
  const url = standardVideoTicketUrl(ticket.url,path);
  if (!url || videoExpiryTime(ticket.expires_at) <= Date.now() || !Number.isFinite(videoExpiryTime(ticket.expires_at))) return null;
  return <div><video src={url} controls preload="none" className="w-full max-h-96"/><a href={url} download target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">保存视频（短时本地链接）</a></div>;
}
export function StandardVideoTaskCard({task, token, onRefresh, disabled=false}: {task:StandardVideoTask; token:string; onRefresh?:()=>void; disabled?:boolean}) {
  const [ticket,setTicket] = useState<VideoContentTicket|null>(null), [error,setError] = useState("");
  const request = useRef<AbortController|null>(null);
  const path = task.content_available === false ? null : standardVideoResultUrl(task.result_url,task.id);
  useEffect(()=>{setTicket(null);setError("");return ()=>{request.current?.abort();request.current=null;};},[task.id,task.status,token]);
  useEffect(()=>{if(!ticket)return;const timer=setTimeout(()=>setTicket(null),Math.max(0,Math.min(2147483647,videoExpiryTime(ticket.expires_at)-Date.now())));return()=>clearTimeout(timer);},[ticket]);
  async function open() {
    if(!path || request.current || token!==getConsoleToken())return;
    const c=new AbortController();request.current=c;setTicket(null);setError("");
    try{const t=await standardVideoApi.ticket(token,task.id,path,c.signal);if(!c.signal.aborted&&token===getConsoleToken())setTicket(t);}
    catch(e){if(!c.signal.aborted&&token===getConsoleToken())setError(message(e));}
    finally{if(request.current===c)request.current=null;}
  }
  return <article className="border rounded-lg p-4 space-y-3 text-sm">
    <header className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">视频任务</h3><span className="rounded-full border px-2 py-1 font-medium">{LABELS[task.status]}</span></header>
    <p className="break-all text-xs text-slate-500">任务编号：<strong className="font-mono font-normal">{task.id}</strong></p>
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4"><div><dt className="text-xs text-slate-500">模型</dt><dd className="break-all font-medium">{task.model}</dd></div><div><dt className="text-xs text-slate-500">时长</dt><dd>{task.duration} 秒</dd></div><div><dt className="text-xs text-slate-500">画面比例</dt><dd>{task.ratio}</dd></div><div><dt className="text-xs text-slate-500">分辨率</dt><dd>{task.resolution}</dd></div></dl>
    {task.cost!==undefined?<p className="font-medium">已结算 ¥{task.cost.toFixed(4)}</p>:null}
    {task.status==="completed"&&!path?<p className="rounded border border-amber-200 bg-amber-50 p-3 leading-relaxed text-amber-900">生成完成，下载未配置，请联系管理员获取帮助；无需重新生成，请勿重复付费提交。</p>:null}
    {task.requires_review?<p className="rounded border border-amber-200 bg-amber-50 p-3 font-medium text-amber-900">需要人工复核；禁止重新付费提交。</p>:null}
    <Button disabled={disabled} onClick={onRefresh} variant="secondary">手动查询任务</Button>
    {task.status==="completed"&&path?<Button disabled={disabled} onClick={()=>void open()}>播放 / 下载（不重新生成）</Button>:null}
    {ticket&&path?<StandardVideoTicketMedia ticket={ticket} path={path}/>:null}{error?<p role="alert">{error}</p>:null}</article>;
}
export function ConsoleStandardVideoCard({models, token="", active=false, limitsByModel=EMPTY_LIMITS_BY_MODEL}: {models:ConsoleModels|null;token?:string;active?:boolean;limitsByModel?:Record<string,StandardVideoLimits>}) {
  const items=useMemo(()=>(models?.items||[]).filter(m=>m.model_type==="video"&&((limitsByModel[m.model_name] || m.video) as StandardVideoLimits|undefined)?.resolutions?.length),[models,limitsByModel]);
  const [model,setModel]=useState(""),[prompt,setPrompt]=useState(""),[duration,setDuration]=useState(""),[ratio,setRatio]=useState(""),[resolution,setResolution]=useState("");
  const [mode,setMode]=useState("text"),[audio,setAudio]=useState(""),[imageUrls,setImageUrls]=useState(""),[videoUrls,setVideoUrls]=useState("");
  const [refs,setRefs]=useState<Reference[]>([]),[attempt,setAttempt]=useState<StandardVideoAttempt|null>(null),[history,setHistory]=useState<StandardVideoTask[]>([]);
  const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[uploadError,setUploadError]=useState(false),[videoLimits,setVideoLimits]=useState<ReferenceUploadLimits|null>(null);
  const operation=useRef<AbortController|null>(null), generation=useRef(0), scope=useRef("");
  const selected=items.find(m=>m.model_name===model)||items[0];
  const limits=selected ? (limitsByModel[selected.model_name]||selected.video) as StandardVideoLimits : undefined;
  useEffect(()=>{
    generation.current++;const g=generation.current;scope.current=token;operation.current?.abort();operation.current=null;
    setReady(false);setBusy(false);setAttempt(null);setHistory([]);setRefs([]);setError("");setUploadError(false);setVideoLimits(null);
    setPrompt("");setModel("");setDuration("");setRatio("");setResolution("");setAudio("");setImageUrls("");setVideoUrls("");setMode("text");
    if(token)void loadStandardVideoAttempt(token,localStorage).then(a=>{if(generation.current===g&&token===getConsoleToken()){setAttempt(a);setReady(true);}}).catch(()=>{if(generation.current===g)setError("提交记录无法读取；请管理员复核，不可重新付费提交");});
    return()=>{generation.current++;operation.current?.abort();operation.current=null;};
  },[token]);
  useEffect(()=>{if(!active||!token)return;const c=new AbortController();void standardVideoApi.limits(token,"videos",c.signal).then(v=>{if(!c.signal.aborted&&token===getConsoleToken())setVideoLimits(v);}).catch(()=>{if(!c.signal.aborted&&token===getConsoleToken())setVideoLimits({enabled:false,formats:[],max_bytes:0,max_duration_ms:0});});return()=>c.abort();},[active,token]);
  const chosenRatio=ratio||limits?.default_ratio||limits?.ratios?.[0]||"",chosenResolution=resolution||limits?.default_resolution||"",chosenDuration=duration||String(limits?.default_duration??limits?.seconds_min??"");
  const locked=!!attempt, unavailable=!active||!ready||busy||!token||token!==scope.current;
  function start(){if(operation.current||unavailable||token!==getConsoleToken())return null;const c=new AbortController();operation.current=c;setBusy(true);setError("");return c;}
  function valid(c:AbortController){return !c.signal.aborted&&token===getConsoleToken()&&token===scope.current;}
  function finish(c:AbortController){if(operation.current===c){operation.current=null;if(valid(c))setBusy(false);}}
  async function upload(files:File[],kind:"images"|"videos",role:Reference["role"]="reference"){
    const c=start();if(!c)return;
    try{
      const policy=kind==="videos"?videoLimits:IMAGE_LIMITS;if(!policy)throw Error();
      const max=kind==="videos"?Math.min(3,limits?.max_videos??0):Math.min(9,limits?.max_images??0);
      if(!files.length||files.length+refs.filter(r=>r.kind===kind).length>max||role!=="reference"&&files.length!==1)throw Error();
      for(const file of files)precheckStandardReference(file,policy);
      for(const file of files){const asset=await standardVideoApi.upload(token,kind,file,policy,c.signal);if(!valid(c))return;setRefs(old=>[...old,{kind,role,name:file.name,asset}]);}
      if(valid(c))setUploadError(false);
    }catch(e){if(valid(c)){setUploadError(true);setError(message(e)+"；上传失败不会生成视频，请修正文件后手动上传。");}}finally{finish(c);}
  }
  async function remove(ref:Reference){const c=start();if(!c)return;try{await standardVideoApi.remove(token,ref.kind,ref.asset.id,c.signal);if(valid(c)){setRefs(old=>old.filter(r=>r.asset.id!==ref.asset.id));setUploadError(false);}}catch(e){if(valid(c))setError(message(e));}finally{finish(c);}}
  async function submit(retry=false){
    const c=start();if(!c)return;let frozen=attempt;
    try{
      if(retry){if(!frozen||frozen.task||frozen.conflict)throw Error();}
      else{
        if(frozen||uploadError||!selected)throw Error();
        if(refs.some(r=>videoExpiryTime(r.asset.expires_at)<=Date.now()))throw Error();
        const images=refs.filter(r=>r.kind==="images"&&r.role==="reference").map(r=>r.asset.id), videos=refs.filter(r=>r.kind==="videos").map(r=>r.asset.id);
        const body={model:selected.model_name,prompt,duration:Number(chosenDuration),ratio:chosenRatio,resolution:chosenResolution,
          ...(images.length?{reference_image_ids:images}:{}),...(videos.length?{reference_video_ids:videos}:{}),
          ...(refs.find(r=>r.role==="first")?{first_frame_id:refs.find(r=>r.role==="first")!.asset.id}:{}),...(refs.find(r=>r.role==="last")?{last_frame_id:refs.find(r=>r.role==="last")!.asset.id}:{}),
          ...(audio.trim()?{audio_urls:audio.trim().split(/\s+/)}:{})};
        validateStandardVideoInput(body,limits);frozen=newStandardVideoAttempt(body,limits);
      }
      await saveStandardVideoAttempt(token,frozen!,localStorage);if(!valid(c))return;setAttempt(frozen);
      const task=await standardVideoApi.create(token,frozen!,c.signal);
      const confirmed={...frozen!,task};await saveStandardVideoAttempt(token,confirmed,localStorage);if(valid(c)){setAttempt(confirmed);setHistory(old=>[task,...old.filter(t=>t.id!==task.id)].slice(0,30));}
    }catch(e){
      if(e instanceof StandardVideoApiError&&e.notDispatched&&frozen){const rejected={...frozen,rejected:true};try{await saveStandardVideoAttempt(token,rejected,localStorage);if(valid(c))setAttempt(rejected);}catch{if(valid(c))setError("提交记录无法保存；请管理员复核");}}
      if(e instanceof StandardVideoApiError&&e.status===409&&frozen){const conflict={...frozen,conflict:true};await saveStandardVideoAttempt(token,conflict,localStorage).catch(()=>{});if(valid(c))setAttempt(conflict);}
      if(valid(c))setError(message(e)+"；提交结果未知时保留原 key 和参数，勿创建新提交。");
    }finally{finish(c);}
  }
  async function refresh(id?:string){const c=start();if(!c)return;try{const tasks=id?[await standardVideoApi.get(token,id,c.signal)]:await standardVideoApi.list(token,c.signal);if(!valid(c))return;
    setHistory(old=>[...tasks,...old.filter(t=>!tasks.some(n=>n.id===t.id))].slice(0,30));
    if(attempt?.task){const task=tasks.find(t=>t.id===attempt.task!.id);if(task){const next={...attempt,task};await saveStandardVideoAttempt(token,next,localStorage);if(valid(c))setAttempt(next);}}
  }catch(e){if(valid(c))setError(message(e));}finally{finish(c);}}
  async function newIntent(){if(!attempt||!standardAttemptFinished(attempt))return;const c=start();if(!c)return;try{await saveStandardVideoAttempt(token,null,localStorage);if(valid(c)){setAttempt(null);setRefs([]);setUploadError(false);}}catch(e){if(valid(c))setError(message(e));}finally{finish(c);}}
  if(!items.length)return null;
  if(token!==scope.current)return <section hidden={!active}><Card title="标准视频生成">正在切换设备身份与私有提交记录…</Card></section>;
  return <section hidden={!active}><Card title="标准视频生成"><div className="space-y-3">
    <div className="rounded-lg border p-3 text-sm leading-relaxed"><p className="font-medium">先选模型与规格，再提交生成</p><p className="text-slate-500">价格由管理员设置，未定价不等于免费。</p><details className="mt-2"><summary className="cursor-pointer font-medium">查看计费与报价说明</summary><ul className="mt-2 list-disc space-y-1 pl-5"><li>¥/秒：单价乘以生成秒数。</li><li>¥/次：按一次成功任务计费。</li><li>具体规格与含参考视频的报价以服务端为准。</li></ul></details></div>
    <fieldset disabled={unavailable||locked} className="space-y-3">
      <legend className="mb-2 font-semibold">1. 描述视频</legend>
      <label>模型<Select value={selected?.model_name||""} onChange={e=>{operation.current?.abort();operation.current=null;generation.current++;setBusy(false);setModel(e.target.value);setRatio("");setResolution("");setDuration("");setPrompt("");setAudio("");setImageUrls("");setVideoUrls("");setMode("text");setRefs([]);setError("");setUploadError(false);}}><option value="" disabled>选择模型</option>{items.map(m=><option key={m.id} value={m.model_name}>{m.display_name||m.model_name}</option>)}</Select></label>
      <label className="block space-y-1">提示词<Textarea value={prompt} maxLength={8000} onChange={e=>setPrompt(e.target.value)}/></label>
      <h3 className="border-t pt-3 font-semibold">2. 设置生成规格</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><label>时长（秒）<Input type="number" min={limits?.seconds_min} max={limits?.seconds_max} value={chosenDuration} onChange={e=>setDuration(e.target.value)}/></label><label>比例<Select value={chosenRatio} onChange={e=>setRatio(e.target.value)}>{limits?.ratios?.map(v=><option key={v}>{v}</option>)}</Select></label><label>分辨率<Select value={chosenResolution} onChange={e=>setResolution(e.target.value)}><option value="" disabled>管理员未配置</option>{limits?.resolutions?.map(v=><option key={v}>{v}</option>)}</Select></label></div>
      <h3 className="border-t pt-3 font-semibold">3. 选择参考方式</h3>
      <label>生成模式<Select value={mode} disabled={refs.length>0} onChange={e=>{setMode(e.target.value);setAudio("");setUploadError(false);}}><option value="text">文生视频</option><option value="references">多模态参考</option>{limits?.support_first_last?<option value="first-last">首尾帧</option>:null}</Select></label>
      {mode!=="text"&&(limits?.max_images??0)>0?<div><div className="space-y-1 text-sm leading-relaxed"><p className="font-medium">私有参考图上传</p><p>JPEG / PNG / WebP，每张 ≤ 5 MiB。</p><p className="text-slate-500">服务端验证可用性，禁止浏览器直连供应商。</p></div>{(mode==="first-last"?["first","last"] as const:["reference"] as const).map(role=><label key={role}>{role==="first"?"首帧":role==="last"?(limits?.allow_tail_only?"尾帧（可单独）":"尾帧（需首帧）"):"参考图片"}<Input type="file" accept={IMAGE_LIMITS.formats.join(",")} multiple={role==="reference"} disabled={refs.some(r=>r.role===role)&&role!=="reference"} onChange={e=>{const files=Array.from(e.target.files||[]);e.target.value="";void upload(files,"images",role);}}/></label>)}</div>:null}
      {mode==="references"&&limits?.request_format==="doubao_content"?<div><label>外部 HTTPS 图片（与私有参考图 ID 二选一，最多 {limits.max_images}）<Textarea value={imageUrls} onChange={e=>setImageUrls(e.target.value)}/></label>{limits.support_video_urls?<label>外部 HTTPS 视频（与私有视频 ID 二选一，最多 {limits.max_videos}）<Textarea value={videoUrls} onChange={e=>setVideoUrls(e.target.value)}/></label>:null}</div>:null}
      {mode==="references"?<div><label>参考视频文件（最多 {Math.min(3,limits?.max_videos??0)} 个）<Input type="file" multiple accept={videoLimits?.formats.join(",")} disabled={!videoLimits?.enabled||!limits?.support_video_urls||!(limits?.max_videos??0)} onChange={e=>{const files=Array.from(e.target.files||[]);e.target.value="";void upload(files,"videos");}}/></label>
        {!videoLimits?.enabled?<div className="space-y-1 text-sm leading-relaxed"><p className="font-medium">参考视频上传暂不可用</p><p>参考视频上传尚未配置或限制不可用，已禁用；请联系管理员配置私有上传服务。</p></div>:<p>允许 {videoLimits.formats.join("、")}；单文件 ≤ {videoLimits.max_bytes} 字节，最长 {videoLimits.max_duration_ms/1000} 秒；时长由服务器权威验证。</p>}
        {limits?.support_audio_urls&&(limits.max_audios??0)>0?<label>可选外部 HTTPS 音频地址（每行一个，最多 {limits.max_audios}）<Textarea value={audio} onChange={e=>setAudio(e.target.value)}/><p>{limits.support_audio_only?"允许音频单独参考，最多 "+limits.max_audio_only+" 个":"音频必须搭配参考图或视频"}；只提交网关，浏览器不会访问音频来源。</p></label>:null}</div>:null}
      {mode==="first-last"&&limits?.request_format==="doubao_content"&&limits.support_audio_urls?<label>搭配首尾帧的 HTTPS 音频（最多 {limits.max_audios}）<Textarea value={audio} onChange={e=>setAudio(e.target.value)}/></label>:null}
    </fieldset>
    {refs.map(r=><p key={r.asset.id}>{r.name} · {r.kind==="videos"?"参考视频":r.role==="first"?"首帧":r.role==="last"?"尾帧":"参考图片"} · {r.asset.bytes} 字节 <Button disabled={unavailable||locked} variant="ghost" onClick={()=>void remove(r)}>删除</Button></p>)}
    {uploadError?<p>上传失败已阻止生成。请手动重新上传或删除失败前的素材；不会自动生成。</p>:null}
    <h3 className="border-t pt-3 font-semibold">4. 提交与查询</h3>
    <p className="text-sm leading-relaxed text-slate-500">创建视频会提交生成任务；查询与刷新不会生成新视频。</p>
    <Button disabled={unavailable||locked||uploadError||!selected} onClick={()=>void submit()}>创建视频（按所选规格报价）</Button>
    <Button disabled={unavailable} variant="secondary" onClick={()=>void refresh()}>手动刷新任务列表（不生成）</Button>
    {attempt?<div className="rounded-lg border p-3 space-y-3 text-sm leading-relaxed"><h3 className="font-semibold">当前提交记录</h3><p>原始参数已冻结；请先确认当前任务结果，不要重复付费提交。</p><details><summary className="cursor-pointer font-medium">查看提交标识（技术详情）</summary><p className="mt-2 break-all font-mono">持久提交 Key：{attempt.key}。原始参数已冻结。</p></details>{attempt.conflict||attempt.task?.requires_review?<p className="font-medium text-amber-800">需管理员人工复核，不可换 key 重新提交。</p>:attempt.rejected===true?<p>网关已明确拒绝且尚未派发；可结束此记录后修改参数，未知结果不得清除。</p>:!attempt.task?<><p className="font-semibold text-amber-800">提交确认未知，请勿创建新提交。</p><p>仅可主动用原 key + 原参数查询式重发；不会自动付费重试。</p><Button disabled={unavailable} variant="warning" onClick={()=>void submit(true)}>手动重发原提交（同 Key / 参数）</Button></>:null}{standardAttemptFinished(attempt)?<Button disabled={unavailable} onClick={()=>void newIntent()}>结束此记录，开始新的付费意图</Button>:null}</div>:null}
    {error?<p role="alert">{error}</p>:null}
    {history.map(task=><StandardVideoTaskCard key={task.id+token} task={task} token={token} disabled={unavailable} onRefresh={()=>void refresh(task.id)}/>)}
    {attempt?.task&&!history.some(t=>t.id===attempt.task!.id)?<StandardVideoTaskCard key={attempt.task.id+token} task={attempt.task} token={token} disabled={unavailable} onRefresh={()=>void refresh(attempt.task!.id)}/>:null}
  </div></Card></section>;
}
