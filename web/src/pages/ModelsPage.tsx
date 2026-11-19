import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { useAdminFilters } from "../hooks/useAdminFilters";
import { AdminListToolbar } from "../components/AdminListToolbar";
import { VideoPricingModeNotice, videoPricingModeNotice } from "../components/VideoPricingModeNotice";
import { ModelCatalogVisibility, ModelCatalogVisibilityBadge, setCatalogVisible } from "../components/ModelCatalogVisibility";
import { useModelCategories, ModelCategoryManager, ModelCategoryAssignment, ModelCategoryBadges, ModelCategoryFilter, categoryModelName, matchesModelCategory, CATEGORY_RENAME_HELP } from "../components/ModelCategories";
import { ProtocolProbePanel } from "../components/ProtocolProbePanel";
import { CONNECTION_PROTOCOLS, isProtocolObject, readProtocolConfig, providerConnectionState, updateModelProtocolValue, validateModelProtocolDeclarations } from "../components/ProtocolConnectionsControls";
import type { ModelItem, Provider } from "../types";
import { Badge, Button, Card, Empty, Input, Modal, Select, Spinner, Textarea, CopyButton } from "../components/ui";
import { IconPlus, IconEdit, IconTrash, IconModels, IconRefresh, IconCheck, IconTerminal, IconDownload, IconZap } from "../components/icons";
import { useToast } from "../components/Toast";
import { useQuery, invalidateCache } from "../hooks/useQuery";
import { buildDshProfile, buildPiModelsConfig, DSH_PROFILE_HELP, type ModelConfigMetadata } from "../utils/modelConfigExport";
import { videoObject, videoStrings, videoSettingsDiagnostics, videoBasePrice } from "../utils/videoSettings";
import { parseModelTypeConfig, resolvedModelType, validateModelBilling, videoReferenceConfirmation, EMBEDDING_HELP, VIDEO_HELP } from "../utils/modelType";

export function inferClientCapabilities(modelName: string): string[] {
  const name = (modelName || "").toLowerCase();
  const caps: string[] = [];
  if (name.includes("4o") || name.includes("vision") || name.includes("vl") || name.includes("gemini") || name.includes("claude-3") || name.includes("pixtral") || name.includes("omni")) {
    caps.push("vision");
  }
  if (name.includes("gpt-4") || name.includes("gpt-3.5") || name.includes("claude-3") || name.includes("gemini") || name.includes("deepseek") || name.includes("qwen")) {
    caps.push("tool_call");
  }
  if (name.includes("r1") || name.includes("reason") || name.includes("thinking") || name.includes("qwq") || name.startsWith("o1") || name.startsWith("o3") || name.includes("claude-3-7") || name.includes("claude-3.7")) {
    caps.push("reasoning");
  }
  if (name.includes("gemini") || name.includes("claude-3") || name.includes("4o") || name.includes("deepseek") || name.includes("qwen") || name.includes("llama-3")) {
    caps.push("long_context");
  }
  if (name.includes("audio") || name.includes("realtime") || name.includes("voice") || name.includes("tts") || name.includes("whisper")) {
    caps.push("audio");
  }
  if (name.includes("code") || name.includes("coder") || name.includes("starcoder") || name.includes("codestral")) {
    caps.push("code");
  }
  return caps;
}

type PricingModeOption = "auto" | "free" | "priced";

interface FormState {
  id?: string;
  provider_id: string;
  model_name: string;
  display_name: string;
  description: string;
  alias: string;
  fallback_model_id: string;
  input_price_per_m: string;
  output_price_per_m: string;
  cache_read_price_per_m: string;
  cache_write_price_per_m: string;
  billing_unit: "token" | "call";
  price_per_call: string;
  search_price_per_call: string;
  pricing_mode: PricingModeOption;
  cache_enabled: boolean;
  cache_ttl: string;
  model_public: boolean;
  enabled: boolean;
  config_json: string;
  capabilities: string[];
  routing_strategy: "priority" | "lowest_latency" | "weighted";
  weight: number;
  system_prompt: string;
  system_prompt_mode: "prepend" | "override" | "append";
  max_tokens_limit: string;
  model_rewrite: string;
  supports_search_tool: boolean;
}

interface ModelsPageData {
  items: ModelItem[];
  providers: Provider[];
}

const PROBE_SOURCE_LABELS: Record<string, string> = {
  probe: "实测结果",
  config_levels: "config_json 里的等级列表",
  config_off: "config_json 明确关闭",
  config_default: "config_json 的默认等级",
  capability: "推理能力勾选",
  model_name: "模型名推断",
  provider: "服务商类型推断",
  none: "无",
};

export function ProtocolCapabilityControls({ configJson, provider, modelName, onChange, onError }: {
  configJson: string; provider?: Provider; modelName: string; onChange: (json: string) => void; onError: () => void;
}) {
  let config: Record<string, unknown> = {}, valid = true;
  try { config = readProtocolConfig(configJson); } catch { valid = false; }
  const raw = config.protocol_capabilities;
  const protocols = isProtocolObject(raw) ? raw : {};
  const models = isProtocolObject(config.protocol_models) ? config.protocol_models : {};
  const fields = [
    { key: "chat_route", label: "Chat 入站路由", options: [["auto", "自动"], ["native", "原生 Chat"], ["responses", "经 Responses 转换"]] },
    { key: "responses_route", label: "Responses 入站路由", options: [["auto", "自动"], ["native", "原生 Responses"], ["chat", "经 Chat 转换"]] },
    { key: "loss_policy", label: "转换损失策略", options: [["allow", "allow · 允许兼容转换"], ["safe", "safe · 拒绝不可安全转换字段"], ["strict", "strict · 仅原生"]] },
  ];
  function update(namespace: "protocol_capabilities" | "protocol_models", key: string, value: string) {
    if (!valid) return onError();
    try { onChange(updateModelProtocolValue(configJson, namespace, key, value)); } catch { onError(); }
  }
  return <fieldset className="rounded-xl border border-slate-200 p-3.5 space-y-3 dark:border-slate-800">
    <legend className="px-1 text-xs font-semibold">协议能力与路由（管理员声明）</legend>
    <p className="text-xs text-slate-500 dark:text-slate-400">未创建协议配置时沿用旧 responses_mode。Provider 显式连接存在时，能力未填继承连接；模型声明 true 不能启用 Provider 缺失 / 禁用的连接。未启用显式连接时保留旧默认值。不会自动启用模型，不会探测上游。</p>
    {!valid || (raw !== undefined && !isProtocolObject(raw)) || (config.protocol_models !== undefined && !isProtocolObject(config.protocol_models)) ? <p role="alert" className="text-xs text-rose-600">请先将高级配置、protocol_capabilities 和 protocol_models 修正为 JSON 对象。</p> : null}
    <div className="space-y-3">{CONNECTION_PROTOCOLS.map(protocol => {
      const state = provider ? providerConnectionState(provider.config_json || "", protocol.key) : "invalid";
      const blocked = state === "disabled" || state === "invalid";
      const value = protocols[protocol.key] === undefined ? "" : String(protocols[protocol.key]);
      const label = "上游 " + protocol.label;
      return <div key={protocol.key} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-xs space-y-1"><span>{label}</span>
            <Select aria-label={label} value={value} onChange={event => update("protocol_capabilities", protocol.key, event.target.value)}>
              <option value="">继承（Provider 连接 / 旧默认）</option>
              {value && !["true", "false"].includes(value) ? <option value={value}>当前无效值：{value}</option> : null}
              <option value="true" disabled={blocked}>原生（{blocked ? "Provider 连接不可用，不会生效" : "声明支持"}）</option>
              <option value="false">禁用此上游能力</option>
            </Select>
          </label>
          <label className="block text-xs space-y-1"><span>{protocol.label} 实际上游模型 ID（可选）</span>
            <Input aria-label={protocol.label + " 上游模型 ID"} value={typeof models[protocol.key] === "string" ? models[protocol.key] as string : ""}
              placeholder={modelName || "未设置，沿用现有模型名 / 重写"} onChange={event => update("protocol_models", protocol.key, event.target.value)} />
          </label>
        </div>
        <p className={"text-xs " + (blocked ? "text-amber-600 dark:text-amber-400" : "text-slate-500 dark:text-slate-400")}>
          {state === "legacy" ? "Provider 沿用旧默认；模型未声明时保持兼容行为。" : state === "enabled" ? "Provider 连接已启用；模型可继承或关闭，不会启用 Provider / 模型总开关。" : state === "disabled" ? "Provider 未配置或禁用了此连接；即使已有模型声明 true 也不会生效。请先在 Providers 配置连接。" : "Provider 配置无效或尚未选择，不能声明新的原生能力。"}
          {protocol.key === "messages" ? " Messages 本批仅原生透传，无 Chat / Responses 桥接。" : " 上游能力禁用不等于禁用入站路由；入站仍按下方路由 / 损失策略决定是否转换。"}
        </p>
      </div>;
    })}</div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{fields.map(field => {
      const value = protocols[field.key] === undefined ? "" : String(protocols[field.key]);
      const known = field.options.some(([key]) => key === value);
      return <label key={field.key} className="block text-xs space-y-1"><span>{field.label}</span>
        <Select aria-label={field.label} value={value} onChange={event => update("protocol_capabilities", field.key, event.target.value)}>
          <option value="">未设置（兼容默认 / 旧配置）</option>
          {!known && value ? <option value={value}>当前自定义值：{value}</option> : null}
          {field.options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </Select>
      </label>;
    })}</div>
    <p className="text-xs text-slate-500 dark:text-slate-400">配置键：protocol_capabilities.chat_completions / responses / messages / chat_route / responses_route / loss_policy，protocol_models 按协议设置上游 ID。显式能力配置中的未填路由默认 auto、损失策略默认 safe。转换不提供会话历史存储；分组展示不代表所有成员路径相同。</p>
  </fieldset>;
}

export function patchSecureVideoConfig(raw: string, patch: Record<string, unknown>): string {
  const config = parseModelTypeConfig(raw, false);
  if (config.video !== undefined && (!config.video || typeof config.video !== "object" || Array.isArray(config.video))) throw Error("video 必须为对象");
  return JSON.stringify({...config, model_type:"video", video:{...(config.video as Record<string,unknown> || {}), ...patch}}, null, 2);
}
export function isSecureVideoDraft(raw: string): boolean {
  try { return (parseModelTypeConfig(raw,false).video as {adapter?:unknown}|undefined)?.adapter === "secure_skill"; } catch { return false; }
}
export function blankDoubaoVideoConfig(): Record<string,unknown> {
  return {adapter:"doubao",upstream_model:"",ratios:[],resolutions:[],default_resolution:"",default_ratio:"",default_duration:null,seconds_min:null,seconds_max:null,min_images:0,max_images:0,max_videos:0,max_audios:0,max_total_refs:0,support_first_last:false,support_video_urls:false,support_audio_urls:false,support_audio_only:false,max_audio_only:0,use_asset_library:false,poll_interval_ms:15000,quotes:[]};
}
export function isDoubaoVideoDraft(raw:string):boolean {
  try{return (parseModelTypeConfig(raw,false).video as {adapter?:unknown}|undefined)?.adapter==="doubao";}catch{return false;}
}
type VideoControlsProps = {configJson:string;onChange:(raw:string)=>void;onError:(message:string)=>void};
export function SecureVideoConfigControls({configJson,onChange,onError}: {configJson:string;onChange:(raw:string)=>void;onError:(message:string)=>void}) {
  return VideoSettingsControls({configJson,onChange,onError}, false);
}
export function DoubaoVideoConfigControls({configJson,onChange,onError}:{configJson:string;onChange:(raw:string)=>void;onError:(message:string)=>void}) {
  return VideoSettingsControls({configJson,onChange,onError}, true);
}
function VideoSettingsControls({configJson,onChange,onError}:VideoControlsProps, doubao:boolean) {
  let config:Record<string,unknown>;
  try { config=parseModelTypeConfig(configJson,false); } catch { return <p role="alert">请先修正高级 JSON；视频编辑器不会覆盖无效草稿。</p>; }
  if (config.video !== undefined && (!config.video || typeof config.video !== "object" || Array.isArray(config.video))) return <p role="alert">video 必须为对象；请在高级 JSON 人工修正，编辑器不会覆盖。</p>;
  const video=videoObject(config.video), adapter=doubao?"doubao":"secure_skill";
  function patch(p:Record<string,unknown>) { try {onChange(patchSecureVideoConfig(configJson,p));} catch {onError("无法更新视频配置，请检查高级 JSON");} }
  if(video.adapter!==adapter) return <fieldset className="border rounded-lg p-4 space-y-3"><legend>{doubao?"Doubao 独立视频配置":"标准视频配置"}</legend>
    <p>当前协议：{String(video.adapter||"未配置")}。{doubao?"与 secure_skill 分开配置；不会继承旧字段、能力或价格。":"旧视频适配器保持原样。标准协议使用 /v1/videos，价格由管理员明确设置为 ¥/秒，不推断能力或报价。"}</p>
    <Button type="button" variant="secondary" onClick={()=>{
      if(doubao) {
        if(window.confirm("切换 / 新建 Doubao 配置？将完整替换原 video 对象（包括其它协议字段及报价），其它 JSON 保留。所有能力和价格必须人工核对。")) onChange(JSON.stringify({...config,model_type:"video",video:blankDoubaoVideoConfig()},null,2));
      } else {
        if(!window.confirm("切换为标准视频配置？将移除旧适配器专用字段 task_id_path / sizes / failed_statuses / reference_images，并重置标准规格、能力、报价；其它与未知 JSON 保留。规格与价格初始为空，必须人工填写。"))return;
        const next={...video};for(const key of ["task_id_path","sizes","failed_statuses","reference_images"])delete next[key];
        onChange(JSON.stringify({...config,model_type:"video",video:{...next,adapter:"secure_skill",upstream_model:"",ratios:[],resolutions:[],default_resolution:"",default_ratio:"",default_duration:null,seconds_min:null,seconds_max:null,min_images:0,max_images:0,max_videos:0,max_audios:0,support_first_last:false,support_video_urls:false,support_audio_urls:false,support_audio_only:false,max_audio_only:0,quotes:[]}},null,2));
      }
    }}>{doubao?"显式切换 / 新建 Doubao 视频配置":"显式切换 / 新建标准视频配置"}</Button>
  </fieldset>;
  const resolutions=videoStrings(video.resolutions), issues=videoSettingsDiagnostics(video);
  const quotes=Array.isArray(video.quotes)?video.quotes:[], maxSeconds=doubao?30:15;
  const grid="grid grid-cols-1 sm:grid-cols-2 gap-4", section="border border-slate-200 dark:border-slate-700 rounded-lg p-3 sm:p-4 space-y-3 min-w-0";
  function numberField(key:string,label:string,min:number,max:number) {return <label key={key} className="block text-sm space-y-1">{label}<Input aria-label={label} type="number" min={min} max={max} step="1" value={typeof video[key]==="number"?String(video[key]):""} onChange={e=>patch({[key]:e.target.value===""?null:Number(e.target.value)})}/></label>;}
  function checkField(key:string,label:string) {return <label key={key} className="flex items-start gap-2 text-sm"><input aria-label={label} type="checkbox" checked={video[key]===true} onChange={e=>patch({[key]:e.target.checked})}/>{label}</label>;}
  function resolutionOptions(value:unknown) {return <><option value="">必须选择</option>{typeof value==="string"&&value&&!resolutions.includes(value)?<option value={value}>当前不兼容值：{value}</option>:null}{resolutions.map((v,i)=><option key={i} value={v}>{v}</option>)}</>;}
  function quote(index:number,p:Record<string,unknown>) {patch({quotes:quotes.map((q,i)=>i===index?{...videoObject(q),...p}:q)});}
  return <fieldset className="border rounded-lg p-3 sm:p-4 space-y-4 min-w-0"><legend className="font-semibold">{doubao?"Doubao · 独立分组能力与报价":"标准视频 · 管理员能力与按秒定价"}</legend>
    <section className={section}><h4 className="font-medium">协议与模型</h4><p className="text-sm">当前协议：{adapter} · /v1/videos</p>
      <p className="rounded bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200 p-2 text-sm">{doubao?"Doubao 当前版本下载未配置：只支持生成、轮询与结算，不会播放或暴露上游临时链接。":"下载未配置时：本配置只声明生成能力，不保证下载可用；未配置内容服务时不会播放或暴露上游链接。"}</p>
      <label className="block text-sm">上游模型<Input aria-label="上游模型" value={String(video.upstream_model??"")} placeholder="填写供应商实际模型标识" onChange={e=>patch({upstream_model:e.target.value})}/></label>
      <p className="text-xs text-slate-500">上游地址取供应商配置的 HTTPS API 基址；{doubao?"在基址后追加 /contents/generations/tasks（例如基址路径 /api/v3）。":"在基址后追加 /videos（例如基址路径 /v1）。"}不使用预设域名。</p>
      <p className="text-xs text-slate-500">不自动启用任何素材能力、不自动填价。{doubao?"分辨率和时长由部署方按实际上游能力填写；切换模型保留已有数据，不会推断 Fast 或其它型号特例。":"仅显式配置生效；新报价仅按秒，旧按次报价保留原单位。"}</p>
    </section>
    <div role="status" aria-live="polite" className={issues.length?"rounded-lg border border-amber-400 p-3 text-sm space-y-2":"rounded-lg border p-3 text-sm"}><h4 className="font-medium">即时检查（只读）{issues.length?" · "+issues.length+" 项待核对":" · 未发现已检查项的缺项或矛盾"}</h4>{issues.length?<ul className="list-disc pl-5">{issues.map((issue,i)=><li key={i}>{issue}</li>)}</ul>:null}<p>此提示不等于配置有效；保存仍由严格解析器及后端最终校验，不会自动修正草稿。</p></div>
    <section className={section}><h4 className="font-medium">生成规格与默认值</h4><div className={grid}>
      {([["ratios","允许比例（逗号分隔）"],["resolutions","允许分辨率（逗号分隔）"]] as const).map(([key,label])=><label key={key} className="block text-sm">{label}<Input aria-label={label} key={JSON.stringify(video[key])} defaultValue={videoStrings(video[key]).join(", ")} onBlur={e=>{const values=e.target.value.split(/[,，\s]+/).filter(Boolean);if(JSON.stringify(values)!==JSON.stringify(videoStrings(video[key])))patch({[key]:values});}}/><span className="text-xs text-slate-500">离开输入框后更新检查；不会推断或自动填入规格。</span></label>)}
      <label className="block text-sm">默认分辨率<Select aria-label="默认分辨率" value={String(video.default_resolution||"")} onChange={e=>patch({default_resolution:e.target.value})}>{resolutionOptions(video.default_resolution)}</Select></label>
      <label className="block text-sm">默认比例<Input aria-label="默认比例" value={String(video.default_ratio??"")} placeholder="必须显式填写允许列表中的比例" onChange={e=>patch({default_ratio:e.target.value})}/></label>
      {numberField("seconds_min","最短生成秒数",4,maxSeconds)}{numberField("seconds_max","最长生成秒数",4,maxSeconds)}{numberField("default_duration","默认秒数",4,maxSeconds)}
    </div></section>
    <section className={section}><h4 className="font-medium">素材能力</h4><p className="text-xs text-slate-500">勾选只修改对应开关，不自动调整数量；私有文件上传服务的格式、大小、时长限制需另行配置。</p><div className={grid}>
      {numberField("min_images","所有模式最少图片",0,doubao?30:9)}{numberField("max_images","最多图片",0,doubao?30:9)}{numberField("max_videos","最多参考视频",0,doubao?10:3)}{numberField("max_audios","最多音频",0,doubao?10:3)}{doubao?numberField("max_total_refs","最多素材总数",0,50):null}{numberField("max_audio_only","纯音频最多数量",0,doubao?10:3)}
      {checkField("support_first_last",doubao?"允许首尾帧（可尾帧单独、帧+音频）":"支持首尾帧")}{checkField("support_video_urls","支持参考视频")}{checkField("support_audio_urls","支持 HTTPS 音频")}{checkField("support_audio_only","允许纯音频参考")}
    </div></section>
    <section className={section}><h4 className="font-medium">报价</h4><p className="text-sm">空规格、空价格不代表免费。仅显式 0 表示零基础售价。报价以分辨率 + 是否含参考视频唯一匹配；¥/次与¥/秒不能互换数字含义，按成功生成结算。</p>
      {!quotes.length?<p className="font-medium text-amber-700 dark:text-amber-300">价格未完成 · 请人工添加报价</p>:null}
      {quotes.map((item,i)=>{const q=videoObject(item),unit=q.unit==="second"?"¥/秒":q.unit==="call"?"¥/次":"单位未配置";return <fieldset key={i} className={section}><legend className="text-sm font-medium">报价 {i+1} · {unit}</legend><div className={grid}>
        <label className="block text-sm">分辨率<Select aria-label={"报价 "+(i+1)+" 分辨率"} value={String(q.resolution||"")} onChange={e=>quote(i,{resolution:e.target.value})}>{resolutionOptions(q.resolution)}</Select></label>
        <label className="flex items-center gap-2 text-sm"><input aria-label={"报价 "+(i+1)+" 含参考视频"} type="checkbox" checked={q.has_reference_video===true} onChange={e=>quote(i,{has_reference_video:e.target.checked})}/>含参考视频</label>
        {doubao?<label className="block text-sm">单位<Select aria-label={"报价 "+(i+1)+" 单位"} value={String(q.unit||"")} onChange={e=>{if(e.target.value!==q.unit&&window.confirm("确认改变报价单位并保留此数字？¥/次与¥/秒代表不同实际费率；仅在已人工核对新单位售价后确认，编辑器不会换算数字。"))quote(i,{unit:e.target.value});}}><option value="">必须选择</option><option value="call">¥/次</option><option value="second">¥/秒</option></Select></label>:<p className="text-sm">当前单位：{unit}{q.unit==="call"?"（旧按次报价，编辑价格不会迁移单位）":""}</p>}
        <label className="block text-sm">基础售价（{unit}）<Input aria-label={"报价 "+(i+1)+" 基础售价（"+unit+"）"} type="number" min="0" max="10000" step="0.0001" placeholder="必须由管理员定价；空≠免费" value={typeof q.price==="number"?String(q.price):""} onChange={e=>quote(i,{price:e.target.value===""?null:Number(e.target.value)})}/></label>
      </div>
      {!doubao&&q.unit!=="second"?<Button type="button" variant="warning" onClick={()=>{if(window.confirm("确认将此报价迁移为按秒？将清空原价格，必须重新填写每秒售价；不会换算或沿用按次数字。"))quote(i,{unit:"second",price:null});}}>改为按秒并重新填写价格</Button>:null}
      <p className="text-xs">模型基础售价试算（只读）：{[4,10].map(seconds=>{const cost=videoBasePrice(q,seconds);return <span key={seconds} className="inline-block mr-3">{seconds} 秒视频：{cost===null?"价格或单位未完成，不试算":"¥"+Number(cost.toFixed(6))+(q.unit==="call"?"（1 次 × 单价）":"（"+seconds+" 秒 × 单价）")}</span>;})}不代表含服务倍率的最终价；样例秒数不代表允许的生成范围。</p>
      <Button type="button" variant="ghost" onClick={()=>patch({quotes:quotes.filter((_,n)=>n!==i)})}>删除此报价</Button></fieldset>;})}
      <Button type="button" variant="secondary" onClick={()=>patch({quotes:[...quotes,{resolution:"",has_reference_video:false,unit:doubao?"call":"second",price:null}]})}>{doubao?"添加空白报价（不默认定价）":"添加空白按秒报价"}</Button>
    </section>
    <details className={section}><summary className="cursor-pointer font-medium">高级选项</summary><div className={grid}>{numberField("poll_interval_ms","轮询间隔毫秒（未填兼容默认 15000）",15000,300000)}{doubao?checkField("use_asset_library","使用供应商素材库"):null}</div><p className="text-xs text-slate-500">所有未知 JSON 属性保留；如服务端拒绝未知字段，请在高级配置中人工核对，编辑器不会静默丢弃。高级 JSON 请使用页面原始配置编辑区。</p></details>
  </fieldset>;
}

export default function ModelsPage() {
  const toast = useToast();
  const fetchModelsData = useCallback(async (): Promise<ModelsPageData> => {
    const [m, p] = await Promise.all([
      api.get<{ items: ModelItem[] }>("/api/models"),
      api.get<{ items: Provider[] }>("/api/providers"),
    ]);
    return {
      items: m.items || [],
      providers: p.items || [],
    };
  }, []);

  const { data, loading, isRefreshing, error: queryError, updatedAt, refresh } = useQuery("models-page-data", fetchModelsData, { revalidateIfFresh: false });
  const items = useMemo(() => data?.items || [], [data?.items]);
  const parsedConfigs = useMemo(() => new Map(items.map((m) => {
    let config: Record<string, any> = {};
    try { if (m.config_json) config = JSON.parse(m.config_json); } catch {}
    return [m, config] as const;
  })), [items]);
  const modelsById = useMemo(() => {
    const byId = new Map<string, ModelItem>();
    for (const model of items) {
      if (!byId.has(model.id)) byId.set(model.id, model);
    }
    return byId;
  }, [items]);
  const providers = data?.providers || [];

  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [filters, setFilter, resetFilters] = useAdminFilters({ q: "", provider: "", capability: "", category: "", enabled: "", pricing: "", type: "", sort: "" });
  const search = filters.q;
  const filterProviderId = filters.provider;
  const filterCapability = filters.capability;
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<FormState>({
    provider_id: "",
    model_name: "",
    display_name: "",
    description: "",
    alias: "",
    fallback_model_id: "",
    input_price_per_m: "",
    output_price_per_m: "",
    cache_read_price_per_m: "",
    cache_write_price_per_m: "",
    billing_unit: "token",
    price_per_call: "",
    search_price_per_call: "",
    pricing_mode: "auto",
    cache_enabled: false,
    cache_ttl: "3600",
    model_public: false,
    enabled: true,
    config_json: "",
    capabilities: [],
    routing_strategy: "priority",
    weight: 10,
    system_prompt: "",
    system_prompt_mode: "prepend",
    max_tokens_limit: "",
    model_rewrite: "",
    supports_search_tool: false,
  });

  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<null | {
    reasoning_supported: boolean | null;
    status: number;
    latency_ms: number;
    error: string | null;
    source?: string;
  }>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchOperating, setBatchOperating] = useState(false);

  const [showExport, setShowExport] = useState(false);
  const [exportFormat, setExportFormat] = useState<"catalog" | "toml" | "pi" | "dsh" | "continue" | "list">("catalog");
  const [downloadingCatalog, setDownloadingCatalog] = useState(false);

  const [showSync, setShowSync] = useState(false);
  const [syncProviderId, setSyncProviderId] = useState("");
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [syncFilter, setSyncFilter] = useState("");
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [syncSubmitting, setSyncSubmitting] = useState(false);

  const [showBanner, setShowBanner] = useState<boolean>(() => {
    try {
      return localStorage.getItem("cpg_show_model_banner") === "true";
    } catch {
      return false;
    }
  });

  const toggleBanner = () => {
    setShowBanner((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("cpg_show_model_banner", String(next));
      } catch {}
      return next;
    });
  };

  function openCreate() {
    setForm({
      provider_id: providers[0]?.id || "",
      model_name: "",
      display_name: "",
      description: "",
      alias: "",
      fallback_model_id: "",
      input_price_per_m: "",
      output_price_per_m: "",
      cache_read_price_per_m: "",
      cache_write_price_per_m: "",
      billing_unit: "token",
      price_per_call: "",
      search_price_per_call: "",
      pricing_mode: "auto",
      cache_enabled: false,
      cache_ttl: "3600",
      model_public: false,
      enabled: true,
      config_json: "",
      capabilities: [],
      routing_strategy: "priority",
      weight: 10,
      system_prompt: "",
      system_prompt_mode: "prepend",
      max_tokens_limit: "",
      model_rewrite: "",
      supports_search_tool: false,
    });
    setShow(true);
    setError("");
    setProbeResult(null);
  }

  function openEdit(m: ModelItem) {
    const customObj = parsedConfigs.get(m)!;

    setForm({
      id: m.id,
      provider_id: m.provider_id,
      model_name: m.model_name,
      display_name: m.display_name || "",
      description: typeof customObj.description === "string" ? customObj.description : "",
      alias: m.alias || "",
      fallback_model_id: m.fallback_model_id || "",
      input_price_per_m: m.input_price_per_m ? String(m.input_price_per_m) : "",
      output_price_per_m: m.output_price_per_m ? String(m.output_price_per_m) : "",
      cache_read_price_per_m: m.cache_read_price_per_m ? String(m.cache_read_price_per_m) : "",
      cache_write_price_per_m: m.cache_write_price_per_m ? String(m.cache_write_price_per_m) : "",
      billing_unit: m.billing_unit === "call" ? "call" : "token",
      price_per_call: m.price_per_call ? String(m.price_per_call) : "",
      search_price_per_call: m.search_price_per_call ? String(m.search_price_per_call) : "",
      pricing_mode: m.pricing_mode === "free" ? "free" : m.pricing_mode === "priced" ? "priced" : "auto",
      cache_enabled: Boolean(m.cache_enabled),
      cache_ttl: m.cache_ttl ? String(m.cache_ttl) : "3600",
      model_public: Boolean(m.model_public),
      enabled: Boolean(m.enabled),
      config_json: m.config_json || "",
      capabilities: Array.isArray(customObj.capabilities) && customObj.capabilities.length
        ? customObj.capabilities
        : inferClientCapabilities(m.model_name),
      routing_strategy: customObj.routing_strategy || "priority",
      weight: typeof customObj.weight === "number" ? customObj.weight : 10,
      system_prompt: customObj.system_prompt || "",
      system_prompt_mode: customObj.system_prompt_mode || "prepend",
      max_tokens_limit: customObj.max_tokens_limit ? String(customObj.max_tokens_limit) : "",
      model_rewrite: customObj.model_rewrite || "",
      supports_search_tool: Boolean(customObj.supports_search_tool),
    });
    setShow(true);
    setError("");
    setProbeResult(null);
  }

  async function onProbeReasoning() {
    if (!form.id) {
      toast.error("请先保存模型，再探测推理支持");
      return;
    }
    setProbing(true);
    setProbeResult(null);
    try {
      const res = await api.post<{
        reasoning_supported: boolean | null;
        conclusive?: boolean;
        status: number;
        latency_ms: number;
        error: string | null;
        config_json?: string;
        resolved?: { source?: string; supported?: boolean };
      }>(`/api/models/${form.id}/probe-reasoning`, { config_json: form.config_json });
      setProbeResult({
        reasoning_supported: res.reasoning_supported,
        status: res.status,
        latency_ms: res.latency_ms,
        error: res.error,
        source: res.resolved?.source,
      });
      setForm((f) => {
        const next = { ...f };
        if (typeof res.config_json === "string") next.config_json = res.config_json;
        if (res.reasoning_supported && !next.capabilities.includes("reasoning")) {
          next.capabilities = [...next.capabilities, "reasoning"];
        }
        return next;
      });
      if (res.reasoning_supported === null) {
        toast.error(`探测无结论（HTTP ${res.status}），未写入配置`);
      } else {
        toast[res.reasoning_supported ? "success" : "error"](
          res.reasoning_supported
            ? "探测成功：该模型支持推理等级"
            : `探测完成：该模型不接受推理等级（HTTP ${res.status}）`
        );
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "探测请求失败";
      setProbeResult({ reasoning_supported: null, status: 0, latency_ms: 0, error: message });
      toast.error(message);
    } finally {
      setProbing(false);
    }
  }

  function openSync() {
    setSyncProviderId(providers[0]?.id || "");
    setFetchedModels([]);
    setSelectedModels(new Set());
    setSyncFilter("");
    setSyncError("");
    setShowSync(true);
  }

  async function handleFetchFromUpstream(provId: string) {
    if (!provId) return;
    setSyncLoading(true);
    setSyncError("");
    try {
      const res = await api.post<{ models: string[] }>(`/api/providers/${provId}/fetch-models`);
      setFetchedModels(res.models || []);
      const existingNames = new Set(items.filter((m) => m.provider_id === provId).map((m) => m.model_name));
      const nextSelected = new Set<string>();
      for (const m of res.models || []) {
        if (!existingNames.has(m)) nextSelected.add(m);
      }
      setSelectedModels(nextSelected);
    } catch (err) {
      setSyncError(err instanceof ApiError ? err.message : "获取模型失败");
      setFetchedModels([]);
    } finally {
      setSyncLoading(false);
    }
  }

  async function onBatchImport() {
    if (!syncProviderId || !selectedModels.size) return;
    setSyncSubmitting(true);
    setSyncError("");
    try {
      const modelsToImport = Array.from(selectedModels).map((name) => ({ model_name: name }));
      await api.post("/api/models/batch", {
        provider_id: syncProviderId,
        models: modelsToImport,
      });
      setShowSync(false);
      invalidateCache("dashboard-");
      invalidateCache("model-groups");
      await refresh();
    } catch (err) {
      setSyncError(err instanceof ApiError ? err.message : "批量导入失败");
    } finally {
      setSyncSubmitting(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (form.config_json && form.config_json.trim()) {
      try {
        parseModelTypeConfig(form.config_json, false);
        validateModelProtocolDeclarations(form.config_json);
      } catch (err: any) {
        setError(`高级配置不是合法的 JSON 格式: ${err.message}`);
        return;
      }
    }

    try { validateModelBilling(form.config_json, resolvedModelType(form.config_json, form.billing_unit) === "video" ? "call" : form.billing_unit); }
    catch (err) { setError(err instanceof Error ? err.message : "模型类型与计费单位不匹配"); return; }
    const pricingNotice = videoPricingModeNotice(form.config_json, form.pricing_mode);
    if (pricingNotice?.confirmation && !confirm(pricingNotice.confirmation)) return;
    const referenceConfirmation = videoReferenceConfirmation(form.config_json);
    if (referenceConfirmation && !confirm(referenceConfirmation)) return;
    setSubmitting(true);
    try {
      if (form.id) {
        await api.put(`/api/models/${form.id}`, serialize(form));
        toast.success(`模型「${form.model_name}」已更新`);
      } else {
        await api.post("/api/models", serialize(form));
        toast.success(`模型「${form.model_name}」已创建`);
      }
      setShow(false);
      invalidateCache("dashboard-");
      invalidateCache("model-groups");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(m: ModelItem) {
    if (!confirm(`确认删除模型「${m.model_name}」？`)) return;
    try {
      await api.del(`/api/models/${m.id}`);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(m.id);
        return next;
      });
      invalidateCache("dashboard-");
      invalidateCache("model-groups");
      await refresh();
      toast.success(`模型「${m.model_name}」已删除`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "删除失败");
    }
  }

  async function onToggleSingle(m: ModelItem) {
    try {
      await api.put(`/api/models/${m.id}`, { enabled: !m.enabled });
      invalidateCache("dashboard-");
      invalidateCache("model-groups");
      await refresh();
      toast.success(`模型「${m.model_name}」已${m.enabled ? "禁用" : "启用"}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "操作失败");
    }
  }

  async function onToggleCache(m: ModelItem) {
    if (!m.cache_enabled && resolvedModelType(m.config_json, m.billing_unit) === "video") { toast.error("视频模型不支持响应缓存"); return; }
    if (!m.cache_enabled && resolvedModelType(m.config_json, m.billing_unit) === "embedding") { toast.error("向量模型不支持响应缓存"); return; }
    try {
      await api.put(`/api/models/${m.id}`, {
        cache_enabled: !m.cache_enabled,
        cache_ttl: m.cache_ttl || 3600,
      });
      invalidateCache("dashboard-");
      invalidateCache("model-groups");
      await refresh();
      toast.success(`模型「${m.model_name}」缓存已${m.cache_enabled ? "关闭" : "开启"}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "操作失败");
    }
  }

  async function handleBatchEnable(enabled: boolean) {
    if (!selectedIds.size || hiddenSelectionCount > 0) return;
    setBatchOperating(true);
    try {
      await api.post("/api/models/batch-update", {
        ids: Array.from(selectedIds),
        enabled,
      });
      const count = selectedIds.size;
      setSelectedIds(new Set());
      invalidateCache("dashboard-");
      invalidateCache("model-groups");
      await refresh();
      toast.success(`已批量${enabled ? "启用" : "禁用"} ${count} 个模型`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "批量更新失败");
    } finally {
      setBatchOperating(false);
    }
  }

  async function handleBatchCache(enabled: boolean) {
    if (!selectedIds.size || hiddenSelectionCount > 0) return;
    if (enabled && items.some(m => selectedIds.has(m.id) && resolvedModelType(m.config_json, m.billing_unit) === "video")) { toast.error("选中的视频模型不支持响应缓存，请取消选择后重试"); return; }
    if (enabled && items.some(m => selectedIds.has(m.id) && resolvedModelType(m.config_json, m.billing_unit) === "embedding")) { toast.error("选中的向量模型不支持响应缓存，请取消选择后重试"); return; }
    setBatchOperating(true);
    try {
      await api.post("/api/models/batch-update", {
        ids: Array.from(selectedIds),
        cache_enabled: enabled,
        cache_ttl: 3600,
      });
      const count = selectedIds.size;
      setSelectedIds(new Set());
      invalidateCache("dashboard-");
      invalidateCache("model-groups");
      await refresh();
      toast.success(`已批量${enabled ? "开启" : "关闭"} ${count} 个模型的缓存`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "批量更新缓存失败");
    } finally {
      setBatchOperating(false);
    }
  }

  async function handleBatchPricing(mode: "free" | "priced") {
    if (!selectedIds.size || hiddenSelectionCount > 0) return;
    setBatchOperating(true);
    try {
      await api.post("/api/models/batch-update", {
        ids: Array.from(selectedIds),
        pricing_mode: mode,
      });
      const count = selectedIds.size;
      setSelectedIds(new Set());
      invalidateCache("dashboard-");
      invalidateCache("model-groups");
      await refresh();
      toast.success(`已把 ${count} 个模型设为${mode === "free" ? "免费" : "按价计费"}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "批量更新计费模式失败");
    } finally {
      setBatchOperating(false);
    }
  }

  async function handleBatchDelete() {
    if (!selectedIds.size || hiddenSelectionCount > 0) return;
    if (!confirm(`确定要永久删除选中的 ${selectedIds.size} 个模型吗？此操作无法撤销。`)) return;
    setBatchOperating(true);
    try {
      const count = selectedIds.size;
      await api.post("/api/models/batch-delete", {
        ids: Array.from(selectedIds),
      });
      setSelectedIds(new Set());
      invalidateCache("dashboard-");
      invalidateCache("model-groups");
      await refresh();
      toast.success(`已成功删除选中的 ${count} 个模型`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "批量删除失败");
    } finally {
      setBatchOperating(false);
    }
  }

  const baseUrl = window.location.origin;
  const activeModels = useMemo(() => items.filter((m) => m.enabled), [items]);

  const [serverCatalog, setServerCatalog] = useState<string | { models: ModelConfigMetadata[] }>("");

  const [catalogError, setCatalogError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const categories = useModelCategories();
  const categoryFilter = filters.category;

  const filteredItems = useMemo(() => {
    const result = items.filter((m) => {
    if (!matchesModelCategory(categories.data, categoryModelName(m), categoryFilter)) return false;
    if (filterProviderId && m.provider_id !== filterProviderId) return false;
    if ((filters.enabled === "1" && !m.enabled) || (filters.enabled === "0" && m.enabled)) return false;
    if (filters.pricing && (m.pricing_mode || "unset") !== filters.pricing) return false;
    if (filters.type) {
      const type = parsedConfigs.get(m)?.model_type;
      const resolved = type === "video" || type === "embedding" || type === "image" || type === "text" ? type : m.billing_unit === "call" ? "image" : "text";
      if (resolved !== filters.type) return false;
    }
    if (filterCapability) {
      const customObj = parsedConfigs.get(m)!;
      const caps = Array.isArray(customObj.capabilities) && customObj.capabilities.length
        ? customObj.capabilities
        : inferClientCapabilities(m.model_name);
      if (!caps.includes(filterCapability)) return false;
    }
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      m.model_name.toLowerCase().includes(q) ||
      (m.display_name && m.display_name.toLowerCase().includes(q)) ||
      (m.alias && m.alias.toLowerCase().includes(q))
    );
  });
  if (filters.sort === "name" || filters.sort === "name-desc") {
    result.sort((a, b) => (a.model_name.localeCompare(b.model_name) || a.id.localeCompare(b.id)) * (filters.sort === "name-desc" ? -1 : 1));
  }
  return result;
  }, [items, categories.data, categoryFilter, filterProviderId, filterCapability, search, filters, parsedConfigs]);
  const visibleIds = new Set(filteredItems.map(m => m.id));
  const hiddenSelectionCount = [...selectedIds].filter(id => !visibleIds.has(id)).length;

  const filteredSyncModels = fetchedModels.filter((m) =>
    m.toLowerCase().includes(syncFilter.toLowerCase())
  );

  const isAllFilteredSelected =
    filteredItems.length > 0 && filteredItems.every((m) => selectedIds.has(m.id));

  const toggleSelectAll = () => {
    if (isAllFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredItems.map((m) => m.id)));
    }
  };

  const toggleSelectRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const needsCatalog = exportFormat === "catalog" || exportFormat === "dsh" || exportFormat === "pi";
  const modelCatalogJson = useMemo(() => {
    if (!showExport || exportFormat !== "catalog" || !serverCatalog) return "";
    return typeof serverCatalog === "string" ? serverCatalog : JSON.stringify(serverCatalog, null, 2);
  }, [showExport, exportFormat, serverCatalog]);
  const catalogModels = useMemo((): ModelConfigMetadata[] => {
    if (!showExport || (exportFormat !== "dsh" && exportFormat !== "pi") || !serverCatalog) return [];
    try { return typeof serverCatalog === "string" ? JSON.parse(serverCatalog).models || [] : serverCatalog.models; } catch { return []; }
  }, [showExport, exportFormat, serverCatalog]);
  const profileExport = useMemo(() => {
    if (!showExport || !serverCatalog) return null;
    if (exportFormat === "dsh") return buildDshProfile(catalogModels, baseUrl + "/v1");
    if (exportFormat === "pi") return buildPiModelsConfig(catalogModels, baseUrl + "/v1");
    return null;
  }, [showExport, exportFormat, serverCatalog, catalogModels, baseUrl]);
  const profileJson = useMemo(() => profileExport ? JSON.stringify(profileExport.config, null, 2) : "", [profileExport]);
  const loadCatalog = useCallback(async () => {
    setServerCatalog("");
    setCatalogError("");
    setCatalogLoading(true);
    try {
      const data = await api.get<{ models: ModelConfigMetadata[] }>("/api/models/catalog");
      if (!Array.isArray(data.models)) throw new Error("服务端目录格式错误");
      setServerCatalog(data);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : "目录加载失败");
    } finally {
      setCatalogLoading(false);
    }
  }, []);
  useEffect(() => {
    if (showExport && needsCatalog) void loadCatalog();
  }, [showExport, needsCatalog, loadCatalog]);

  const defaultModelSlug = activeModels[0]?.alias || activeModels[0]?.model_name || "gpt-4o";

  const codexTomlConfig = useMemo(() => {
    if (!showExport || exportFormat !== "toml") return "";
    return `# ~/.codex/config.toml
model = "${defaultModelSlug}"
model_provider = "personal-ai-gateway"
model_catalog_json = "~/.codex/model-catalog.json"

[model_providers.personal-ai-gateway]
name = "Personal AI Gateway"
base_url = "${baseUrl}/v1"
api_key = "YOUR_DEVICE_TOKEN"
wire_specification = "openai"
`;
  }, [showExport, exportFormat, defaultModelSlug, baseUrl]);

  const piExportJson = exportFormat === "pi" ? profileJson : "";

  const continueExportJson = useMemo(() => {
    if (!showExport || exportFormat !== "continue") return "";
    return JSON.stringify(
    {
      models: activeModels.map((m) => ({
        title: m.display_name || m.alias || m.model_name,
        provider: "openai",
        model: m.alias || m.model_name,
        apiBase: `${baseUrl}/v1`,
        apiKey: "YOUR_DEVICE_TOKEN",
      })),
    },
    null,
    2
  );

  }, [showExport, exportFormat, activeModels, baseUrl]);

  const modelListText = useMemo(() =>
    showExport && exportFormat === "list"
      ? activeModels.map((m) => m.alias || m.model_name).join("\n")
      : "",
    [showExport, exportFormat, activeModels]);

  const handleDownloadCatalog = async () => {
    setDownloadingCatalog(true);
    try {
      await api.download("/api/models/catalog/export", "model-catalog.json");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "导出 model-catalog.json 失败");
    } finally {
      setDownloadingCatalog(false);
    }
  };

  const handleDownloadPrices = async () => {
    try {
      await api.download("/api/models/prices/export", "cpg-prices.json");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "只读价格导出失败");
    }
  };

  const handleDownloadPiConfig = () => {
    const blob = new Blob([piExportJson], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "models.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading && !items.length) return <Spinner text="正在加载模型列表…" />;

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">模型路由映射</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            配置允许客户端调用的模型、上游 Provider 绑定以及自定义别名（Alias）
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <Button variant="outline" size="sm" onClick={() => setShowExport(true)} className="shadow-sm flex-1 sm:flex-initial">
            <IconTerminal />
            <span>客户端导出</span>
          </Button>
          <Button variant="outline" size="sm" onClick={handleDownloadPrices} title="导出当前网关售价快照（CNY），非采购成本；仅下载，不修改配置或账户" className="shadow-sm flex-1 sm:flex-initial">
            <IconDownload />
            <span>只读价格导出</span>
          </Button>
          <Button variant="outline" size="sm" onClick={openSync} disabled={!providers.length} className="shadow-sm flex-1 sm:flex-initial">
            <IconRefresh />
            <span>从上游拉取</span>
          </Button>
          <Button size="sm" onClick={openCreate} disabled={!providers.length} className="shadow-sm w-full sm:w-auto">
            <IconPlus />
            <span>新增 Model</span>
          </Button>
        </div>
      </div>

      <ModelCategoryManager state={categories} />

      <ProtocolProbePanel modelIds={Array.from(selectedIds).filter(id => visibleIds.has(id))} providerId={filterProviderId} onApplied={refresh} />

      { }
      <div className="rounded-xl border border-blue-100 dark:border-blue-900/50 bg-gradient-to-r from-blue-50/60 via-indigo-50/40 to-purple-50/50 dark:from-blue-950/30 dark:via-indigo-950/20 dark:to-purple-950/30 px-3.5 py-2.5 transition-all shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap min-w-0 text-xs">
            <span className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5 shrink-0">
              <span>🧭</span>
              <span>路由逻辑:</span>
            </span>
            <div className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 font-medium flex-wrap">
              <span className="px-2 py-0.5 rounded bg-blue-100/80 dark:bg-blue-900/50 text-blue-900 dark:text-blue-200 font-semibold font-mono">1. 请求 Model</span>
              <span className="text-slate-400">→</span>
              <span className="px-2 py-0.5 rounded bg-indigo-100/80 dark:bg-indigo-900/50 text-indigo-900 dark:text-indigo-200 font-semibold font-mono">2. 别名优先</span>
              <span className="text-slate-400">→</span>
              <span className="px-2 py-0.5 rounded bg-purple-100/80 dark:bg-purple-900/50 text-purple-900 dark:text-purple-200 font-semibold font-mono">3. 原始直通</span>
              <span className="text-slate-400">→</span>
              <span className="px-2 py-0.5 rounded bg-amber-100/80 dark:bg-amber-900/50 text-amber-900 dark:text-amber-200 font-semibold font-mono">4. 故障降级</span>
            </div>
          </div>

          <button
            type="button"
            onClick={toggleBanner}
            className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium flex items-center gap-1 shrink-0 px-2 py-1 rounded-md hover:bg-blue-100/50 dark:hover:bg-blue-900/40 transition-colors cursor-pointer"
          >
            <span>{showBanner ? "收起说明" : "查看说明"}</span>
            <span className="text-[10px]">{showBanner ? "▲" : "▼"}</span>
          </button>
        </div>

        {showBanner ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 mt-2.5 pt-2.5 border-t border-blue-100/80 dark:border-blue-900/40 text-xs animate-in fade-in slide-in-from-top-1 duration-200">
            <div className="p-3 bg-white/90 dark:bg-slate-900/80 rounded-lg border border-blue-100/80 dark:border-blue-900/40 shadow-xs space-y-1">
              <div className="text-blue-600 dark:text-blue-400 font-bold text-xs">1. 客户端请求 (Model)</div>
              <p className="text-slate-600 dark:text-slate-300 text-xs leading-relaxed">
                提取客户端 <code className="font-semibold text-blue-900 dark:text-blue-200 bg-blue-100/70 dark:bg-blue-900/40 border-blue-200/60 dark:border-blue-800/60">model</code> 参数（如 <code>gpt-4o</code>、<code>claude</code> 或 <code>deepseek-v3</code>）。
              </p>
            </div>

            <div className="p-3 bg-white/90 dark:bg-slate-900/80 rounded-lg border border-indigo-100/80 dark:border-indigo-900/40 shadow-xs space-y-1">
              <div className="text-indigo-600 dark:text-indigo-400 font-bold text-xs">2. 别名优先匹配 (Alias)</div>
              <p className="text-slate-600 dark:text-slate-300 text-xs leading-relaxed">
                <strong>第一优先级</strong>：优先匹配 <strong>快捷别名</strong>，如将 <code className="font-semibold text-indigo-900 dark:text-indigo-200 bg-indigo-100/70 dark:bg-indigo-900/40 border-indigo-200/60 dark:border-indigo-800/60">gpt4</code> 映射转发至 <code>gpt-4o-2024-11-20</code>。
              </p>
            </div>

            <div className="p-3 bg-white/90 dark:bg-slate-900/80 rounded-lg border border-purple-100/80 dark:border-purple-900/40 shadow-xs space-y-1">
              <div className="text-purple-600 dark:text-purple-400 font-bold text-xs">3. 原始模型名直通</div>
              <p className="text-slate-600 dark:text-slate-300 text-xs leading-relaxed">
                <strong>第二优先级</strong>：若无别名则直连 <strong>上游模型名 (Model ID)</strong>，且要求模型与 Provider 均处于启用状态。
              </p>
            </div>

            <div className="p-3 bg-white/90 dark:bg-slate-900/80 rounded-lg border border-amber-100/80 dark:border-amber-900/40 shadow-xs space-y-1">
              <div className="text-amber-600 dark:text-amber-400 font-bold text-xs">4. 故障自动降级 (Fallback)</div>
              <p className="text-slate-600 dark:text-slate-300 text-xs leading-relaxed">
                上游遇 <code className="font-semibold text-amber-900 dark:text-amber-200 bg-amber-100/70 dark:bg-amber-900/40 border-amber-200/60 dark:border-amber-800/60">5xx/429/超时</code> 时，网关<strong>秒级自动重试配置的备用模型</strong>。
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {!providers.length ? (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 text-amber-800 dark:text-amber-300 text-xs flex items-center gap-2">
          <span>⚠️ 尚未创建任何 Provider，请先前往「Providers」页面创建上游服务商。</span>
        </div>
      ) : null}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <AdminListToolbar filters={filters} onChange={setFilter} onReset={resetFilters} total={items.length} count={filteredItems.length} loading={loading || isRefreshing} error={queryError ? "读取失败：" + queryError.message + "；如有旧数据仍予保留" : null} onRefresh={() => { void refresh().catch(() => {}); }} searchPlaceholder="搜索模型 / 别名…">
          <ModelCategoryFilter state={categories} value={categoryFilter} onChange={value => setFilter("category", value)} />
          <Select aria-label="Provider筛选" className="!w-auto" value={filterProviderId} onChange={e => setFilter("provider", e.target.value)}>
            <option value="">全部 Provider ({providers.length})</option>
            {providers.map(p => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
          </Select>
          <Select aria-label="计价模式" className="!w-auto" value={filters.pricing} onChange={e => setFilter("pricing", e.target.value)}>
            <option value="">全部计价模式</option><option value="free">免费</option><option value="priced">按价计费</option><option value="unset">未定价</option>
          </Select>
          <Select aria-label="模型类型" className="!w-auto" value={filters.type} onChange={e => setFilter("type", e.target.value)}>
            <option value="">全部模型类型</option><option value="text">文本</option><option value="image">图片</option><option value="embedding">向量</option><option value="video">视频</option>
          </Select>
        </AdminListToolbar>
        {updatedAt && <p className="mt-2 text-xs text-slate-500">上次成功更新：{new Date(updatedAt).toLocaleTimeString()}</p>}


        { }
        {selectedIds.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 px-3 py-1.5 rounded-xl text-xs animate-in fade-in slide-in-from-top-1 duration-200 w-full sm:w-auto">
            <span className="font-semibold text-blue-900 dark:text-blue-300">已选 {selectedIds.size} 项（隐藏 {hiddenSelectionCount} 项）</span>
            {hiddenSelectionCount > 0 ? <><span role="alert">存在隐藏选项，清理后才能批量操作。</span><Button type="button" size="sm" variant="outline" onClick={() => setSelectedIds(new Set([...selectedIds].filter(id => visibleIds.has(id))))}>清理隐藏选择</Button></> : null}
            <ModelCategoryAssignment state={categories} modelNames={items.filter(m => selectedIds.has(m.id)).map(categoryModelName)} label="批量分类" disabled={batchOperating || hiddenSelectionCount > 0} />
            <div className="h-4 w-px bg-blue-200 dark:bg-blue-800 mx-1 hidden sm:block" />
            <Button
              size="sm"
              variant="outline"
              disabled={batchOperating || hiddenSelectionCount > 0}
              onClick={() => handleBatchEnable(true)}
              className="bg-white dark:bg-slate-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700 shadow-none"
            >
              <IconCheck />
              <span>启用</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={batchOperating || hiddenSelectionCount > 0}
              onClick={() => handleBatchEnable(false)}
              className="bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 shadow-none"
            >
              <span>停用</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={batchOperating || hiddenSelectionCount > 0}
              onClick={() => handleBatchCache(true)}
              className="bg-white dark:bg-slate-800 text-purple-700 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/40 border-purple-300 dark:border-purple-700 shadow-none"
            >
              <IconZap />
              <span>开启缓存</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={batchOperating || hiddenSelectionCount > 0}
              onClick={() => handleBatchCache(false)}
              className="bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 shadow-none"
            >
              <span>关闭缓存</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={batchOperating || hiddenSelectionCount > 0}
              onClick={() => handleBatchPricing("free")}
              className="bg-white dark:bg-slate-800 text-sky-700 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/40 border-sky-300 dark:border-sky-700 shadow-none"
            >
              <span>设为免费</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={batchOperating || hiddenSelectionCount > 0}
              onClick={() => handleBatchPricing("priced")}
              className="bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 shadow-none"
            >
              <span>按价计费</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={batchOperating || hiddenSelectionCount > 0}
              onClick={handleBatchDelete}
              className="bg-white dark:bg-slate-800 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-700 dark:hover:text-rose-300 border-rose-200 dark:border-rose-800 shadow-none"
            >
              <IconTrash />
              <span>删除</span>
            </Button>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="ml-auto sm:ml-1 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 text-xs font-medium cursor-pointer"
            >
              取消
            </button>
          </div>
        ) : null}
      </div>

      { }
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
        <span className="text-slate-400 dark:text-slate-500 font-medium shrink-0 mr-1">能力筛选:</span>
        {[
          { key: "", label: "全部模型" },
          { key: "vision", label: "👁️ 视觉" },
          { key: "tool_call", label: "🛠️ 工具调用" },
          { key: "reasoning", label: "🧠 深度思考" },
          { key: "long_context", label: "⚡ 128K+ 上下文" },
          { key: "code", label: "💻 代码增强" },
          { key: "audio", label: "🔊 语音音频" },
        ].map((tag) => (
          <button
            key={tag.key}
            type="button"
            onClick={() => setFilter("capability", tag.key)}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold shrink-0 transition-all cursor-pointer ${
              filterCapability === tag.key
                ? "bg-slate-900 text-white dark:bg-blue-600 dark:text-white shadow-xs"
                : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700"
            }`}
          >
            {tag.label}
          </button>
        ))}
      </div>

      <Card>
        {filteredItems.length ? (
          <div className="overflow-x-auto -mx-4 -my-4 sm:mx-0 sm:my-0">
            <table className="w-full text-left text-xs sm:text-sm min-w-[650px]">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 dark:text-slate-500 font-medium">
                  <th className="pb-3 px-3 w-8">
                    <input
                      type="checkbox"
                      checked={isAllFilteredSelected}
                      onChange={toggleSelectAll}
                      className="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer align-middle"
                    />
                  </th>
                  <th className="pb-3 px-2 whitespace-nowrap">上游模型名 / 能力</th>
                  <th className="pb-3 px-2 whitespace-nowrap">显示名称</th>
                  <th className="pb-3 px-2 whitespace-nowrap">客户端别名</th>
                  <th className="pb-3 px-2 whitespace-nowrap">模型分类（公开名）</th>
                  <th className="pb-3 px-2 whitespace-nowrap">绑定 Provider</th>
                  <th className="pb-3 px-2 whitespace-nowrap">计费模式 / 1M 定价 (入/出)</th>
                  <th className="pb-3 px-2 whitespace-nowrap">故障备用</th>
                  <th className="pb-3 px-2 whitespace-nowrap">响应缓存</th>
                  <th className="pb-3 px-2 whitespace-nowrap">状态</th>
                  <th className="pb-3 px-3 text-right whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredItems.map((m) => {
                  const isSelected = selectedIds.has(m.id);
                  const fallbackModel = m.fallback_model_id ? modelsById.get(m.fallback_model_id) : null;
                  const customObj = parsedConfigs.get(m)!;
                  const rowModelType = customObj.model_type === "video" || customObj.model_type === "embedding" || customObj.model_type === "image" || customObj.model_type === "text"
                    ? customObj.model_type : m.billing_unit === "call" ? "image" : "text";
                  const caps = Array.isArray(customObj.capabilities) && customObj.capabilities.length
                    ? customObj.capabilities
                    : inferClientCapabilities(m.model_name);

                  return (
                    <tr
                      key={m.id}
                      className={`transition-colors ${isSelected ? "bg-blue-50/50 dark:bg-blue-950/40" : "hover:bg-slate-50/60 dark:hover:bg-slate-800/50"}`}
                    >
                      <td className="py-3 px-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelectRow(m.id)}
                          className="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer align-middle"
                        />
                      </td>
                      <td className="py-3 px-2 whitespace-nowrap">
                        <div className="font-mono font-medium text-slate-900 dark:text-slate-100">{m.model_name}</div>
                        <ModelCatalogVisibilityBadge visible={customObj?.catalog_visible !== false} />
                        {caps.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap mt-1">
                            {caps.map((c) => (
                              <span
                                key={c}
                                className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                              >
                                {c === "vision" ? "👁️ 视觉" : c === "tool_call" ? "🛠️ 工具" : c === "reasoning" ? "🧠 思考" : c === "long_context" ? "⚡ 128K+" : c === "code" ? "💻 代码" : c === "audio" ? "🔊 音频" : c}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-2 text-slate-700 dark:text-slate-300 whitespace-nowrap">{m.display_name || "-"}</td>
                      <td className="py-3 px-2 whitespace-nowrap">
                        {m.alias ? <Badge tone="blue">{m.alias}</Badge> : <span className="text-slate-400 dark:text-slate-500">-</span>}
                      </td>
                      <td className="py-3 px-2 text-slate-600 dark:text-slate-400 font-medium whitespace-nowrap">
                        <ModelCategoryBadges data={categories.data} modelName={categoryModelName(m)} />
                        <ModelCategoryAssignment state={categories} modelNames={[categoryModelName(m)]} />
                      </td>
                      <td className="py-3 px-2 text-slate-600 dark:text-slate-400 font-medium whitespace-nowrap">
                        {m.provider_name || <span className="font-mono text-xs text-slate-400 dark:text-slate-500">{m.provider_id}</span>}
                      </td>
                      <td className="py-3 px-2 font-mono text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">
                        {m.pricing_mode === "free" ? (
                          <Badge tone="blue" title="免费：调用不扣费，余额为 0 也可用">免费</Badge>
                        ) : m.pricing_mode === "unset" || !m.pricing_mode ? (
                          <Badge tone="amber" title="未配置计价：网关会以 model_pricing_missing 拒绝调用">未定价</Badge>
                        ) : rowModelType === "video" ? (
                          <span>{isDoubaoVideoDraft(m.config_json || "") ? "Doubao 独立规格报价 · ¥/次或¥/秒" : isSecureVideoDraft(m.config_json || "") ? "管理员规格报价 · ¥/秒" : <>¥{m.price_per_call || 0} / 成功任务次</>} <Badge tone="green">视频</Badge></span>
                        ) : rowModelType === "embedding" ? (
                          <span>输入 ¥{m.input_price_per_m || 0}/M · 仅输入计费</span>
                        ) : m.billing_unit === "call" ? (
                          <span className="inline-flex items-center gap-1.5">
                            ¥{m.price_per_call || 0} / 次
                            <Badge tone="green" title="每个成功 API 请求收一次基础费；错误或中断不收基础费">按次</Badge>
                            {m.search_price_per_call ? (
                              <Badge tone="amber" title="每次服务端联网搜索另收这一笔，不乘峰谷倍率">
                                +¥{m.search_price_per_call}/搜索
                              </Badge>
                            ) : null}
                          </span>
                        ) : m.input_price_per_m || m.output_price_per_m ? (
                          <span className="inline-flex items-center gap-1.5">
                            ¥{m.input_price_per_m || 0} / ¥{m.output_price_per_m || 0}
                            <Badge tone="green" title="按价计费">计价</Badge>
                            {m.search_price_per_call ? (
                              <Badge tone="amber" title="每次服务端联网搜索另收这一笔，不乘峰谷倍率">
                                +¥{m.search_price_per_call}/搜索
                              </Badge>
                            ) : null}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-slate-400 dark:text-slate-500">
                            ¥0 / ¥0
                            <Badge tone="green" title="按价计费（当前单价为 0）">计价</Badge>
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-2 whitespace-nowrap">
                        {fallbackModel ? (
                          <Badge tone="amber" className="max-w-[120px] truncate" title={`降级至: ${fallbackModel.model_name}`}>
                            {fallbackModel.alias || fallbackModel.model_name}
                          </Badge>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-500">-</span>
                        )}
                      </td>
                      <td className="py-3 px-2 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onToggleCache(m)}
                          disabled={rowModelType === "embedding" || rowModelType === "video"}
                          title="向量与视频模型不使用响应缓存；其他模型可点击切换"
                          className="cursor-pointer group"
                        >
                          {rowModelType === "embedding" || rowModelType === "video" ? (
                            <Badge tone="slate">不适用</Badge>
                          ) : m.cache_enabled ? (
                            <Badge tone="purple" className="group-hover:opacity-80 transition-opacity" title="响应缓存已开启，点击可关闭">
                              ⚡ {m.cache_ttl || 3600}s
                            </Badge>
                          ) : (
                            <Badge tone="slate" className="group-hover:opacity-80 transition-opacity" title="响应缓存未开启，点击可开启">
                              未开启
                            </Badge>
                          )}
                        </button>
                      </td>
                      <td className="py-3 px-2 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onToggleSingle(m)}
                          title="点击快速切换启用/停用状态"
                          className="cursor-pointer group"
                        >
                          <Badge
                            tone={m.enabled ? "green" : "slate"}
                            dot
                            className="group-hover:opacity-80 transition-opacity"
                          >
                            {m.enabled ? "启用" : "已停用"}
                          </Badge>
                        </button>
                      </td>
                      <td className="py-3 px-3 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(m)}>
                            <IconEdit />
                            <span>编辑</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                            onClick={() => onDelete(m)}
                          >
                            <IconTrash />
                            <span>删除</span>
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text="未找到匹配的模型" icon={<IconModels className="w-8 h-8" />} />
        )}
      </Card>

      { }
      <Modal
        open={showSync}
        onClose={() => setShowSync(false)}
        title="从上游 Provider 自动拉取模型列表"
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">选择上游 Provider</label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Select
                value={syncProviderId}
                onChange={(e) => {
                  setSyncProviderId(e.target.value);
                  setFetchedModels([]);
                  setSelectedModels(new Set());
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.type})
                  </option>
                ))}
              </Select>
              <Button
                variant="primary"
                onClick={() => handleFetchFromUpstream(syncProviderId)}
                disabled={syncLoading || !syncProviderId}
                className="shrink-0"
              >
                {syncLoading ? "正在拉取…" : "获取可用模型"}
              </Button>
            </div>
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
              网关将使用该 Provider 配置的 Secret Key 请求上游 <code>GET /models</code> 接口。
            </p>
          </div>

          {syncError ? <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 p-2.5 rounded-lg">{syncError}</div> : null}

          {fetchedModels.length ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  上游返回 {fetchedModels.length} 个模型 (已选 {selectedModels.size} 个)
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (selectedModels.size === filteredSyncModels.length) {
                        setSelectedModels(new Set());
                      } else {
                        setSelectedModels(new Set(filteredSyncModels));
                      }
                    }}
                  >
                    {selectedModels.size === filteredSyncModels.length ? "全不选" : "全选当前"}
                  </Button>
                </div>
              </div>

              <Input
                placeholder="快速筛选上游模型名…"
                value={syncFilter}
                onChange={(e) => setSyncFilter(e.target.value)}
              />

              <div className="max-h-60 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-xl p-2 divide-y divide-slate-100 dark:divide-slate-800 bg-slate-50/50 dark:bg-slate-950/50">
                {filteredSyncModels.map((name) => {
                  const isChecked = selectedModels.has(name);
                  const isExisting = items.some(
                    (m) => m.provider_id === syncProviderId && m.model_name === name
                  );
                  return (
                    <label
                      key={name}
                      className="flex items-center justify-between py-1.5 px-2 hover:bg-white dark:hover:bg-slate-800/60 rounded-lg cursor-pointer text-xs transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            const next = new Set(selectedModels);
                            if (e.target.checked) next.add(name);
                            else next.delete(name);
                            setSelectedModels(next);
                          }}
                          className="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                        />
                        <span className="font-mono font-medium text-slate-800 dark:text-slate-200">{name}</span>
                      </div>
                      {isExisting ? <Badge tone="slate">已在列表中</Badge> : <Badge tone="green">新模型</Badge>}
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button type="button" variant="secondary" onClick={() => setShowSync(false)}>
              关闭
            </Button>
            {fetchedModels.length ? (
              <Button
                variant="primary"
                onClick={onBatchImport}
                disabled={syncSubmitting || !selectedModels.size}
              >
                {syncSubmitting ? "正在导入…" : `一键导入选中的 ${selectedModels.size} 个模型`}
              </Button>
            ) : null}
          </div>
        </div>
      </Modal>

      { }
      <Modal open={show} onClose={() => setShow(false)} title={form.id ? "编辑 Model" : "新增 Model"}>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
            <p className="text-xs text-slate-500">{CATEGORY_RENAME_HELP}</p>
            <ModelCategoryBadges data={categories.data} modelName={categoryModelName(form)} />
            <ModelCategoryAssignment state={categories} modelNames={[categoryModelName(form)]} disabled={!form.id || !items.some(m => m.id === form.id && categoryModelName(m) === categoryModelName(form)) || submitting} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">上游 Provider</label>
            <Select value={form.provider_id} onChange={(e) => setForm({ ...form, provider_id: e.target.value })}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.type})
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">上游模型标识 (Model ID)</label>
            <Input
              required
              placeholder="例如 gpt-4o / claude-3-5-sonnet-20241022 / gemini-1.5-pro"
              value={form.model_name}
              onChange={(e) => setForm({ ...form, model_name: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">显示名称（可选）</label>
              <Input
                placeholder="例如 Claude 3.5 Sonnet"
                value={form.display_name}
                onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">快捷别名（可选）</label>
              <Input
                placeholder="例如 claude / gpt4"
                value={form.alias}
                onChange={(e) => setForm({ ...form, alias: e.target.value })}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              模型简介 <span className="text-slate-400 dark:text-slate-500 font-normal">（可选，展示在模型广场与 /models 目录，最长 200 字）</span>
            </label>
            <Textarea
              rows={2}
              maxLength={200}
              placeholder="例如 高性价比通用对话模型，支持 128K 上下文"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              故障降级备用模型 (Fallback Model) <span className="text-slate-400 dark:text-slate-500 font-normal">（主上游 5xx/429 时自动重试）</span>
            </label>
            <Select
              value={form.fallback_model_id}
              onChange={(e) => setForm({ ...form, fallback_model_id: e.target.value })}
            >
              <option value="">无降级备用（直接返回错误）</option>
              {items
                .filter((m) => m.id !== form.id && m.enabled)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name ? `${m.display_name} (${m.model_name})` : m.model_name} - {m.provider_name}
                  </option>
                ))}
            </Select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">模型类型</label>
            <Select value={resolvedModelType(form.config_json, form.billing_unit)} onChange={(e) => {
              try {
                const config = parseModelTypeConfig(form.config_json, false);
                const modelType = e.target.value as "text" | "image" | "embedding" | "video";
                setForm({ ...form, billing_unit: modelType === "image" || modelType === "video" ? "call" : modelType === "embedding" ? "token" : form.billing_unit,
                  ...(modelType === "video" ? { input_price_per_m: "0", output_price_per_m: "0", cache_read_price_per_m: "0", cache_write_price_per_m: "0", search_price_per_call: "0", cache_enabled: false } : {}),
                  ...(modelType === "embedding" ? { cache_enabled: false, output_price_per_m: "0", cache_read_price_per_m: "0", cache_write_price_per_m: "0", price_per_call: "0", search_price_per_call: "0" } : {}),
                  config_json: JSON.stringify({ ...config, model_type: modelType, ...(modelType === "video" && !config.video ? { video: { adapter: "moyuu", task_id_path: "", sizes: [], seconds_min: 3, seconds_max: 15, failed_statuses: [] } } : {}) }, null, 2) });
              } catch (err) { setError(err instanceof Error ? err.message : "高级配置不是合法的 JSON 对象"); }
            }}>
              <option value="text">文本 / 推理模型</option>
              <option value="image">图片模型</option>
              <option value="embedding">向量 / Embedding 模型</option>
              <option value="video">视频模型（标准按秒 / 旧版按成功任务次）</option>
            </Select>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">未声明类型的旧配置沿用原规则：按次为图片，其余为文本。文本类型与计费单位独立；图片仅按次，向量仅按输入 Token，视频仅按成功任务次数计费。</p>
            {resolvedModelType(form.config_json, form.billing_unit) === "embedding" ? <p className="mt-2 text-xs text-blue-600 dark:text-blue-400">{EMBEDDING_HELP}</p> : null}
            {resolvedModelType(form.config_json, form.billing_unit) === "video" ? <p className="mt-2 text-xs text-blue-600 dark:text-blue-400">{VIDEO_HELP}</p> : null}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              计费单位
            </label>
            <Select
              value={form.billing_unit}
              onChange={(e) => {
                try {
                  const config = parseModelTypeConfig(form.config_json, false);
                  setForm({ ...form, billing_unit: e.target.value as "token" | "call",
                    config_json: JSON.stringify({ ...config, model_type: resolvedModelType(form.config_json, form.billing_unit) }, null, 2) });
                } catch (err) { setError(err instanceof Error ? err.message : "高级配置不是合法的 JSON 对象"); }
              }}
            >
              <option value="token" disabled={["image", "video"].includes(resolvedModelType(form.config_json, form.billing_unit))}>按 Token 计费</option>
              <option value="call" disabled={resolvedModelType(form.config_json, form.billing_unit) === "embedding"}>{isDoubaoVideoDraft(form.config_json) ? "Doubao 规格报价（逐项按次 / 按秒）" : isSecureVideoDraft(form.config_json) ? "标准视频规格报价（成功后按生成秒数结算）" : "按请求次数计费（文本 / 推理、图片或视频）"}</option>
            </Select>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              {resolvedModelType(form.config_json, form.billing_unit) === "video"
                ? isDoubaoVideoDraft(form.config_json) ? "Doubao 采用独立分组报价：¥/次按成功任务、¥/秒按生成秒数结算；不继承 Minimax 价格或能力。" : isSecureVideoDraft(form.config_json) ? "标准视频使用管理员按分辨率与参考视频设置的 ¥/秒报价；未知、等待和失败任务不结算。旧按次报价兼容数据须在下方明确转换。" : "视频按成功任务次数计费，不按秒；未知、等待和失败任务不收费。"
                : resolvedModelType(form.config_json, form.billing_unit) === "embedding"
                ? "向量仅按输入 Token 收费，不收输出费用。"
                : form.billing_unit === "call"
                ? "每个成功 API 请求收一次基础费，错误或中断不收基础费，Token 价格忽略。工具调用后续每个新的 API 请求分别计次；单个请求内部工具续接不重复收基础费。图片仍走 /v1/images/generations。"
                : "文本 / 推理模型按输入 / 输出 Token 收费。"}
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              联网搜索单价 (¥ / 次，可选)
            </label>
            <Input
              type="number"
              step="0.0001"
              min="0"
              placeholder="留空或 0 = 搜索不额外收费"
              disabled={["embedding", "video"].includes(resolvedModelType(form.config_json, form.billing_unit))}
                value={form.search_price_per_call}
              onChange={(e) => setForm({ ...form, search_price_per_call: e.target.value })}
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              仅对调用方自带的服务端搜索工具生效（上游真的搜了几次，就收几次）。这笔费用加在 Token 或按次价之外，不受峰谷倍率影响；缓存命中仍按首次冻结价收取。
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              旧版 Responses 协议模式（显式新配置优先）
            </label>
            <Select
              value={(() => {
                try { return JSON.parse(form.config_json || "{}").responses_mode || "chat_adapter"; }
                catch { return "chat_adapter"; }
              })()}
              onChange={(e) => {
                try {
                  const config = JSON.parse(form.config_json || "{}");
                  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
                  if (e.target.value === "chat_adapter") delete config.responses_mode;
                  else config.responses_mode = e.target.value;
                  setForm({ ...form, config_json: JSON.stringify(config, null, 2) });
                } catch {
                  toast.error("请先将高级配置修正为 JSON 对象");
                }
              }}
            >
              <option value="chat_adapter">Chat 转换（兼容旧配置）</option>
              <option value="native">原生 Responses（上游需支持 /responses）</option>
              <option value="disabled">禁用 Responses</option>
            </Select>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              原生模式保留工具与推理数据，不使用网关响应缓存；不支持会话存储、后台任务或托管工具。分组按实际成员的模式选择上游。
            </p>
          </div>

          <ProtocolCapabilityControls configJson={form.config_json} provider={providers.find(provider => provider.id === form.provider_id)} modelName={form.model_name}
            onChange={config_json => setForm({ ...form, config_json })}
            onError={() => toast.error("请先将高级配置及 protocol_capabilities / protocol_models 修正为 JSON 对象")} />

          {resolvedModelType(form.config_json, form.billing_unit) === "video" ? <>{!isDoubaoVideoDraft(form.config_json) ? <SecureVideoConfigControls configJson={form.config_json} onChange={config_json => setForm({ ...form, config_json })} onError={text => toast.error(text)} /> : null}<DoubaoVideoConfigControls configJson={form.config_json} onChange={config_json => setForm({ ...form, config_json })} onError={text => toast.error(text)} /></> : null}

          {!isSecureVideoDraft(form.config_json) && !isDoubaoVideoDraft(form.config_json) && (form.billing_unit === "call" || resolvedModelType(form.config_json, form.billing_unit) === "video") ? (
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {resolvedModelType(form.config_json, form.billing_unit) === "video" ? "成功任务价格 (¥ / 成功任务次)" : "单次价格 (¥ / 次)"}
              </label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                placeholder="例如 0.05"
                value={form.price_per_call}
                onChange={(e) => setForm({ ...form, price_per_call: e.target.value })}
              />
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                {resolvedModelType(form.config_json, form.billing_unit) === "video" ? "仅 succeeded 任务结算一次单价；不按秒计费，无 Token、缓存或搜索附加费。" : "文本 / 推理或图片均按每个成功 API 请求收一次基础费；错误或中断不收基础费，Token 价格不参与计算。"}
              </p>
            </div>
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                输入定价 (¥ / 1M Tokens)
              </label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                placeholder="例如 2.50"
                disabled={form.billing_unit === "call" || resolvedModelType(form.config_json, form.billing_unit) === "video"}
                value={form.input_price_per_m}
                onChange={(e) => setForm({ ...form, input_price_per_m: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                输出定价 (¥ / 1M Tokens)
              </label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                placeholder="例如 10.00"
                disabled={form.billing_unit === "call" || ["embedding", "video"].includes(resolvedModelType(form.config_json, form.billing_unit))}
                value={form.output_price_per_m}
                onChange={(e) => setForm({ ...form, output_price_per_m: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                上游缓存读取价 (¥ / 1M)
              </label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                placeholder="留空即按输入价"
                disabled={["embedding", "video"].includes(resolvedModelType(form.config_json, form.billing_unit))}
                value={form.cache_read_price_per_m}
                onChange={(e) => setForm({ ...form, cache_read_price_per_m: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                上游缓存写入价 (¥ / 1M)
              </label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                placeholder="留空即按输入价"
                disabled={["embedding", "video"].includes(resolvedModelType(form.config_json, form.billing_unit))}
                value={form.cache_write_price_per_m}
                onChange={(e) => setForm({ ...form, cache_write_price_per_m: e.target.value })}
              />
            </div>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 -mt-1">
            {resolvedModelType(form.config_json, form.billing_unit) === "video"
              ? "视频仅收成功任务次价；输入、输出、缓存和搜索价格不适用，保存为 0，响应缓存关闭。"
              : resolvedModelType(form.config_json, form.billing_unit) === "embedding"
              ? "向量仅收输入 Token；输出、缓存读写价格不适用，保存为 0。"
              : "上游供应商自己的提示词缓存命中与写入单独计价；留空或填 0 时按普通输入价计费。"}
          </p>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              计费模式
            </label>
            <Select
              value={form.pricing_mode}
              onChange={(e) => setForm({ ...form, pricing_mode: e.target.value as PricingModeOption })}
            >
              <option value="auto">按上方价格自动判定</option>
              <option value="free">免费（调用不扣费）</option>
              <option value="priced">按价计费</option>
            </Select>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              新增模型默认「自动」：价格全为 0 时记为「未配置」，网关会以 model_pricing_missing 拒绝调用；
              想让它免费开放就选「免费」，选「按价计费」则即使价格填 0 也按 0 元计费而不是拒绝。
            </p>
            <VideoPricingModeNotice configJson={form.config_json} pricingMode={form.pricing_mode}
              onChoosePriced={() => setForm(current => ({ ...current, pricing_mode: "priced" }))} />
          </div>

          <ModelCatalogVisibility configJson={form.config_json} onChange={visible => setForm(current => {
            try { return { ...current, config_json: setCatalogVisible(current.config_json, visible) }; }
            catch { return current; }  
          })} />

          { }
          <div className="p-3.5 bg-sky-50/60 dark:bg-sky-950/30 border border-sky-100 dark:border-sky-900/50 rounded-xl">
            <div className="flex items-center justify-between">
              <div>
                <label htmlFor="model-public" className="text-xs font-semibold text-sky-900 dark:text-sky-200 cursor-pointer select-none flex items-center gap-1.5">
                  <span>🌐 公开模型 (无需 Token 即可在模型列表中看到)</span>
                </label>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  开启后该模型会出现在匿名访问的 /v1/models 与 /api/tags 中，便于朋友或客户端发现；实际调用仍需设备 Token
                </p>
              </div>
              <input
                type="checkbox"
                id="model-public"
                className="rounded border-slate-300 dark:border-slate-700 text-sky-600 focus:ring-sky-500 w-4 h-4 cursor-pointer"
                checked={form.model_public}
                onChange={(e) => setForm({ ...form, model_public: e.target.checked })}
              />
            </div>
          </div>

          { }
          <div className="p-3.5 bg-purple-50/60 dark:bg-purple-950/30 border border-purple-100 dark:border-purple-900/50 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <label htmlFor="model-cache-enabled" className="text-xs font-semibold text-purple-900 dark:text-purple-300 cursor-pointer select-none flex items-center gap-1.5">
                  <span>⚡ 启用响应缓存 (Cloudflare KV Cache)</span>
                </label>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  对相同 Prompt 和参数的请求自动边缘命中并毫秒级返回，节省 API 调用费用
                </p>
              </div>
              <input
                type="checkbox"
                id="model-cache-enabled"
                className="rounded border-slate-300 dark:border-slate-700 text-purple-600 focus:ring-purple-500 w-4 h-4 cursor-pointer"
                disabled={["embedding", "video"].includes(resolvedModelType(form.config_json, form.billing_unit))} checked={!["embedding", "video"].includes(resolvedModelType(form.config_json, form.billing_unit)) && form.cache_enabled}
                onChange={(e) => setForm({ ...form, cache_enabled: e.target.checked })}
              />
            </div>
            {!["embedding", "video"].includes(resolvedModelType(form.config_json, form.billing_unit)) && form.cache_enabled ? (
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  缓存过期时间 TTL (秒) <span className="text-slate-400 dark:text-slate-500 font-normal">（最低 60 秒，默认 3600 秒 / 1 小时）</span>
                </label>
                <Input
                  type="number"
                  min="60"
                  max="2592000"
                  placeholder="3600"
                  value={form.cache_ttl}
                  onChange={(e) => setForm({ ...form, cache_ttl: e.target.value })}
                />
              </div>
            ) : null}
          </div>

          { }
          <div className="p-3.5 bg-sky-50/60 dark:bg-sky-950/30 border border-sky-100 dark:border-sky-900/50 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-sky-900 dark:text-sky-300 flex items-center gap-1.5">
                  <span>🏷️ 模型能力标签 (Capabilities)</span>
                </span>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  用于 /v1/models、model-catalog.json 与客户端智能筛选
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs py-1 px-2.5 bg-white dark:bg-slate-900 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-800"
                onClick={() => {
                  const autoCaps = inferClientCapabilities(form.model_name);
                  setForm({ ...form, capabilities: autoCaps });
                  toast.success(`已自动识别并勾选 ${autoCaps.length} 项能力标签`);
                }}
              >
                ✨ 智能识别打标
              </Button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
              {[
                { key: "vision", label: "👁️ 视觉输入 (Vision)" },
                { key: "tool_call", label: "🛠️ 函数/工具调用" },
                { key: "reasoning", label: "🧠 深度思考/推理" },
                { key: "long_context", label: "⚡ 128K+ 上下文" },
                { key: "code", label: "💻 代码增强/优化" },
                { key: "audio", label: "🔊 音频输入/输出" },
              ].map((cap) => {
                const checked = form.capabilities.includes(cap.key);
                return (
                  <label
                    key={cap.key}
                    className={`flex items-center gap-2 p-2 rounded-lg border text-xs cursor-pointer select-none transition-colors ${
                      checked
                        ? "bg-sky-100/80 border-sky-300 text-sky-950 dark:bg-sky-900/40 dark:border-sky-700 dark:text-sky-200 font-medium"
                        : "bg-white/80 border-slate-200 text-slate-600 dark:bg-slate-900/60 dark:border-slate-800 dark:text-slate-400 hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="rounded border-slate-300 text-sky-600 focus:ring-sky-500 w-3.5 h-3.5 cursor-pointer"
                      checked={checked}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...form.capabilities, cap.key]
                          : form.capabilities.filter((c) => c !== cap.key);
                        setForm({ ...form, capabilities: next });
                      }}
                    />
                    <span>{cap.label}</span>
                  </label>
                );
              })}
            </div>

            { 


}
            <div className="p-2.5 rounded-lg border border-sky-200 dark:border-sky-800 bg-white/80 dark:bg-slate-900/60 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  🔬 探测推理支持 (Reasoning Probe)
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={probing || !form.id}
                  className="text-xs py-1 px-2.5 bg-white dark:bg-slate-900 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-800"
                  onClick={onProbeReasoning}
                >
                  {probing ? "探测中…" : "开始探测"}
                </Button>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                用一次极小的真实请求问上游「这个模型接受推理等级吗」，结果写进 config_json.probe，
                设备控制台的等级下拉框与 /v1/models 都以它为准。会消耗一次真实调用
                {form.id ? "" : "；新建的模型需先保存后才能探测"}。
              </p>
              {probeResult ? (
                <div
                  className={`text-[11px] rounded-md px-2 py-1.5 leading-relaxed ${
                    probeResult.reasoning_supported === true
                      ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
                      : probeResult.reasoning_supported === false
                        ? "bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300"
                        : "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300"
                  }`}
                >
                  {probeResult.reasoning_supported === true
                    ? `✅ 支持推理等级（HTTP ${probeResult.status}，耗时 ${probeResult.latency_ms} ms）`
                    : probeResult.reasoning_supported === false
                      ? `❌ 不支持：上游明确拒绝了推理参数（HTTP ${probeResult.status}，耗时 ${probeResult.latency_ms} ms）`
                      : `⚠️ 无结论（HTTP ${probeResult.status}，耗时 ${probeResult.latency_ms} ms）：不是模型不支持，而是这次请求本身失败了（密钥、限流、上游故障等）`}
                  {probeResult.source ? ` · 判定来源：${PROBE_SOURCE_LABELS[probeResult.source] || probeResult.source}` : ""}
                  {probeResult.error ? (
                    <span className="block mt-1 break-all opacity-80">{probeResult.error}</span>
                  ) : null}
                  <span className="block mt-1 opacity-70">
                    {probeResult.reasoning_supported === null
                      ? "本次没有写入任何配置：config_json.probe 保持原样，控制台继续按其它规则判定。可以稍后重试。"
                      : "结论已写进该模型的 config_json.probe（已存库，控制台与 /v1/models 立即按它判定）。表单里的 config_json 也已同步，其它未保存的改动仍需点「保存」。"}
                  </span>
                </div>
              ) : null}
            </div>

            { 

}
            <label className="flex items-start gap-2 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/60 cursor-pointer select-none">
              <input
                type="checkbox"
                className="mt-0.5 rounded border-slate-300 text-sky-600 focus:ring-sky-500 w-3.5 h-3.5 cursor-pointer"
                checked={form.supports_search_tool}
                onChange={(e) => setForm({ ...form, supports_search_tool: e.target.checked })}
              />
              <span className="text-xs text-slate-600 dark:text-slate-400">
                <span className="font-medium text-slate-700 dark:text-slate-300">🔎 允许联网搜索 (Web Search)</span>
                <span className="block mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                  默认关闭。网关只把搜索工具转发给上游，自己不执行搜索，是否真的能搜取决于上游模型。
                </span>
              </span>
            </label>
          </div>

          { }
          <div className="p-3.5 bg-emerald-50/60 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/50 rounded-xl space-y-3">
            <div>
              <span className="text-xs font-semibold text-emerald-900 dark:text-emerald-300 flex items-center gap-1.5">
                <span>⚖️ 智能路由与负载均衡策略 (Routing Strategy)</span>
              </span>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                当多个 Provider 均提供同名模型或别名时生效
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">分流策略</label>
                <Select
                  value={form.routing_strategy}
                  onChange={(e) => setForm({ ...form, routing_strategy: e.target.value as any })}
                >
                  <option value="priority">默认静态优先级 (Priority)</option>
                  <option value="lowest_latency">⏱️ 智能最低延迟优选 (Lowest Latency)</option>
                  <option value="weighted">⚖️ 按权重比例分流 (Weighted Random)</option>
                </Select>
              </div>
              {form.routing_strategy === "weighted" && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">分流权重 (Weight)</label>
                  <Input
                    type="number"
                    min="1"
                    max="100"
                    placeholder="10"
                    value={form.weight}
                    onChange={(e) => setForm({ ...form, weight: parseInt(e.target.value, 10) || 10 })}
                  />
                </div>
              )}
            </div>
          </div>

          { }
          <div className="p-3.5 bg-amber-50/60 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-900/50 rounded-xl space-y-3">
            <div>
              <span className="text-xs font-semibold text-amber-900 dark:text-amber-300 flex items-center gap-1.5">
                <span>✍️ 请求重写与 System Prompt 注入 (Request Rewrite)</span>
              </span>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                在转发至上游前自动修改或注入系统提示词与参数
              </p>
            </div>

            <div className="space-y-2.5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">默认系统提示词 (System Prompt)</label>
                  <Textarea
                    rows={2}
                    placeholder="例如: You are a helpful expert assistant. Always answer in concise Chinese."
                    value={form.system_prompt}
                    onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">提示词注入模式</label>
                  <Select
                    value={form.system_prompt_mode}
                    onChange={(e) => setForm({ ...form, system_prompt_mode: e.target.value as any })}
                  >
                    <option value="prepend">前置拼接 (Prepend)</option>
                    <option value="override">强制覆盖 (Override)</option>
                    <option value="append">尾部追加 (Append)</option>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">上游实际模型重命名 (Model Rewrite)</label>
                  <Input
                    placeholder="如重写为 deepseek-ai/DeepSeek-V3"
                    value={form.model_rewrite}
                    onChange={(e) => setForm({ ...form, model_rewrite: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">最大输出 Token 限制 (Max Tokens Clamp)</label>
                  <Input
                    type="number"
                    min="1"
                    placeholder="留空则不限制"
                    value={form.max_tokens_limit}
                    onChange={(e) => setForm({ ...form, max_tokens_limit: e.target.value })}
                  />
                </div>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              高级 JSON 覆盖配置 <span className="text-slate-400 dark:text-slate-500 font-normal">（可选）</span>
            </label>
            <Textarea
              rows={2}
              placeholder="{}"
              value={form.config_json}
              onChange={(e) => setForm({ ...form, config_json: e.target.value })}
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="model-enabled"
              className="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <label htmlFor="model-enabled" className="text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer select-none">
              立即启用此模型
            </label>
          </div>

          {error ? <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 p-2.5 rounded-lg">{error}</div> : null}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button type="button" variant="secondary" onClick={() => setShow(false)}>
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "正在保存…" : "保存"}
            </Button>
          </div>
        </form>
      </Modal>

      { }
      <Modal
        open={showExport}
        onClose={() => setShowExport(false)}
        title="导出 Codex / 客户端配置"
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            DSH / Pi / Codex 目录采用服务端权威数据（含分组）；管理员导出不代表某个 Token 的授权范围。用户请在控制台导出当前实际可用模型。
          </p>

          <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-3 overflow-x-auto whitespace-nowrap">
            <button
              onClick={() => setExportFormat("catalog")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 shrink-0 ${
                exportFormat === "catalog"
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400"
                  : "text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
              }`}
            >
              <span>⚡ model-catalog.json (Codex)</span>
            </button>
            <button
              onClick={() => setExportFormat("toml")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shrink-0 ${
                exportFormat === "toml"
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-400"
                  : "text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
              }`}
            >
              Codex config.toml
            </button>
            <button type="button" onClick={() => setExportFormat("dsh")} className={"px-3 py-1.5 text-xs font-semibold rounded-lg shrink-0 " + (exportFormat === "dsh" ? "bg-blue-100 text-blue-800" : "text-slate-500")}>
              DSH profile (0.2.0-rc.2)
            </button>
            <button
              onClick={() => setExportFormat("pi")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 shrink-0 ${
                exportFormat === "pi"
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400"
                  : "text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
              }`}
            >
              <span>🥧 Pi (models.json)</span>
            </button>
            <button
              onClick={() => setExportFormat("continue")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shrink-0 ${
                exportFormat === "continue"
                  ? "bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-400"
                  : "text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
              }`}
            >
              Continue / VSCode 格式
            </button>
            <button
              onClick={() => setExportFormat("list")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shrink-0 ${
                exportFormat === "list"
                  ? "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200"
                  : "text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
              }`}
            >
              纯模型列表 (Text)
            </button>
          </div>

          {needsCatalog && !serverCatalog && (
            <div role="alert" className="text-sm text-amber-700 dark:text-amber-300">
              {catalogLoading ? "正在加载服务端权威模型目录…" : catalogError ? "服务端目录加载失败：" + catalogError + "。不会使用本地配置或名称推断代替。" : "服务端权威目录尚未加载，不生成导出。"}
              <Button variant="outline" size="sm" onClick={loadCatalog} disabled={catalogLoading}>重试目录</Button>
            </div>
          )}
          {profileExport && (profileExport.warnings.length > 0 || profileExport.skipped.length > 0) && (
            <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200 space-y-1">
              {profileExport.warnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}
              {profileExport.skipped.map(({ id, reason }) => <p key={id}>已跳过 {id}：{reason}</p>)}
            </div>
          )}
          <div className="relative rounded-xl bg-slate-900 dark:bg-slate-950 border border-slate-800 p-4 text-xs font-mono text-slate-200 overflow-x-auto max-h-72">
            <div className="flex items-center justify-end gap-2 mb-3">
              {exportFormat === "catalog" && (
                <button
                  type="button"
                  onClick={handleDownloadCatalog}
                  disabled={downloadingCatalog || !serverCatalog || catalogLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white shadow-sm transition-all cursor-pointer disabled:opacity-50"
                >
                  <IconDownload className="w-3.5 h-3.5" />
                  <span>{downloadingCatalog ? "下载中…" : "下载 JSON 文件"}</span>
                </button>
              )}
              {exportFormat === "pi" && piExportJson && (
                <button
                  type="button"
                  onClick={handleDownloadPiConfig}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white shadow-sm transition-all cursor-pointer"
                >
                  <IconDownload className="w-3.5 h-3.5" />
                  <span>下载 models.json</span>
                </button>
              )}
              {(!needsCatalog || Boolean(serverCatalog)) && <CopyButton
                text={
                  exportFormat === "catalog"
                    ? modelCatalogJson
                    : exportFormat === "toml"
                    ? codexTomlConfig
                    : exportFormat === "pi"
                    ? piExportJson
                    : exportFormat === "dsh"
                    ? profileJson
                    : exportFormat === "continue"
                    ? continueExportJson
                    : modelListText
                }
                label="复制内容"
                className="bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-100 border border-slate-700/80 px-2.5 py-1.5 rounded-lg shadow-sm"
              />}
            </div>
            <pre className="whitespace-pre overflow-x-auto leading-relaxed">
              {exportFormat === "catalog"
                ? modelCatalogJson
                : exportFormat === "toml"
                ? codexTomlConfig
                : exportFormat === "pi"
                ? piExportJson
                    : exportFormat === "dsh"
                    ? profileJson
                : exportFormat === "continue"
                ? continueExportJson
                : modelListText}
            </pre>
          </div>

          {exportFormat === "catalog" ? (
            <div className="p-3 bg-blue-50/70 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900/50 rounded-xl text-xs text-blue-800 dark:text-blue-300 space-y-1.5">
              <div className="font-semibold flex items-center gap-1.5">
                <span>💡 Codex 接入指南 (model-catalog.json)：</span>
              </div>
              <p>1. 点击上方「下载 JSON 文件」保存为 <code>~/.codex/model-catalog.json</code>。</p>
              <p>2. 在 <code>~/.codex/config.toml</code> 中添加：<code>model_catalog_json = "/绝对路径/.codex/model-catalog.json"</code>。</p>
              <p>3. 重启 Codex，即可在 <code>/model</code> 选择器中直接使用网关配置的所有已启用模型。</p>
            </div>
          ) : exportFormat === "toml" ? (
            <div className="p-3 bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900/50 rounded-xl text-xs text-indigo-800 dark:text-indigo-300 space-y-1">
              <div className="font-semibold">💡 Codex config.toml 说明：</div>
              <p>1. 将配置追加到 <code>~/.codex/config.toml</code> 中，并将 <code>YOUR_DEVICE_TOKEN</code> 替换为您在「设备 Token」创建的有效 Token。</p>
              <p>2. 将 <code>model_catalog_json</code> 指向下载的 <code>model-catalog.json</code> 绝对路径。</p>
            </div>
          ) : exportFormat === "dsh" ? (
            <div className="rounded-lg border border-blue-200 p-3 text-xs"><p>{DSH_PROFILE_HELP}</p><p>仅公开模型 ID 与已声明能力；无真实密钥、上游 URL、内部 ID、价格或系统提示词。</p></div>
          ) : exportFormat === "pi" ? (
            <div className="p-3 bg-emerald-50/70 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900/50 rounded-xl text-xs text-emerald-800 dark:text-emerald-300 space-y-1.5">
              <div className="font-semibold flex items-center gap-1.5">
                <span>💡 Pi (Pi Coding Agent) 接入指南 (~/.pi/agent/models.json)：</span>
              </div>
              <p>1. 点击上方「下载 models.json」保存至 <code>~/.pi/agent/models.json</code>，或将配置内容复制并合并入已有配置文件中。</p>
              <p>2. 将 <code>YOUR_DEVICE_TOKEN</code> 替换为您在「设备 Token」创建的有效密钥（如 <code>ccs_xxx</code>）。</p>
              <p>3. 在 Pi 交互终端中输入 <code>/reload</code> 重新加载配置，即可在 <code>/model</code> 选择器中选择本次能力完整的导出模型；实际可用范围仍由 Token 权限决定。</p>
            </div>
          ) : (
            <div className="p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-700 dark:text-slate-300 space-y-1">
              <div className="font-semibold">💡 使用提示：</div>
              <p>1. 将 <code>YOUR_DEVICE_TOKEN</code> 替换为您在「设备 Token」页面创建的有效密钥（如 <code>ccs_xxx</code>）。</p>
              <p>2. 支持直接配置 Base URL：<code>{baseUrl}/v1</code>，客户端每次请求指定任意模型时，网关均会自动透明匹配至对应的上游服务商。</p>
            </div>
          )}

          <div className="flex justify-end pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button variant="secondary" onClick={() => setShowExport(false)}>
              完成
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export function serialize(f: FormState) {
  const video = resolvedModelType(f.config_json, f.billing_unit) === "video";
  validateModelBilling(f.config_json, video ? "call" : f.billing_unit);
  const embedding = resolvedModelType(f.config_json, f.billing_unit) === "embedding";
  let customObj: Record<string, any> = {};
  if (f.config_json && f.config_json.trim()) {
    customObj = parseModelTypeConfig(f.config_json);
  }

  if (f.capabilities && f.capabilities.length > 0) {
    customObj.capabilities = f.capabilities;
  } else {
    delete customObj.capabilities;
  }

  if (f.description && f.description.trim()) {
    customObj.description = f.description.trim().slice(0, 200);
  } else {
    delete customObj.description;
  }

  if (f.routing_strategy && f.routing_strategy !== "priority") {
    customObj.routing_strategy = f.routing_strategy;
  } else {
    delete customObj.routing_strategy;
  }

  if (f.weight && f.weight !== 10) {
    customObj.weight = Number(f.weight);
  } else {
    delete customObj.weight;
  }

  if (f.system_prompt && f.system_prompt.trim()) {
    customObj.system_prompt = f.system_prompt.trim();
    customObj.system_prompt_mode = f.system_prompt_mode || "prepend";
  } else {
    delete customObj.system_prompt;
    delete customObj.system_prompt_mode;
  }

  if (f.max_tokens_limit && f.max_tokens_limit.trim()) {
    customObj.max_tokens_limit = parseInt(f.max_tokens_limit, 10);
  } else {
    delete customObj.max_tokens_limit;
  }

  if (f.model_rewrite && f.model_rewrite.trim()) {
    customObj.model_rewrite = f.model_rewrite.trim();
  } else {
    delete customObj.model_rewrite;
  }

  if (f.supports_search_tool) {
    customObj.supports_search_tool = true;
    customObj.web_search_tool_type = "text_and_image";
  } else {
    delete customObj.supports_search_tool;
    delete customObj.web_search_tool_type;
  }

  const finalConfigJson = Object.keys(customObj).length > 0 ? JSON.stringify(customObj, null, 2) : null;

  return {
    provider_id: f.provider_id,
    model_name: f.model_name.trim(),
    display_name: f.display_name?.trim() || null,
    alias: f.alias?.trim() || null,
    fallback_model_id: f.fallback_model_id ? f.fallback_model_id.trim() : null,
    input_price_per_m: video ? 0 : f.input_price_per_m ? parseFloat(f.input_price_per_m) || 0 : 0,
    output_price_per_m: embedding ? 0 : video ? 0 : f.output_price_per_m ? parseFloat(f.output_price_per_m) || 0 : 0,
    cache_read_price_per_m: embedding ? 0 : video ? 0 : f.cache_read_price_per_m ? parseFloat(f.cache_read_price_per_m) || 0 : 0,
    cache_write_price_per_m: embedding ? 0 : video ? 0 : f.cache_write_price_per_m ? parseFloat(f.cache_write_price_per_m) || 0 : 0,
    billing_unit: video ? "call" : f.billing_unit,
    price_per_call: embedding ? 0 : f.price_per_call ? parseFloat(f.price_per_call) || 0 : 0,
    search_price_per_call: embedding ? 0 : video ? 0 : f.search_price_per_call ? parseFloat(f.search_price_per_call) || 0 : 0,
    pricing_mode: f.pricing_mode === "auto" ? undefined : f.pricing_mode,
    cache_enabled: !embedding && !video && f.cache_enabled,
    cache_ttl: parseInt(f.cache_ttl, 10) || 3600,
    model_public: f.model_public,
    enabled: f.enabled,
    config_json: finalConfigJson,
  };
}

