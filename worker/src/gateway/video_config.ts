import type { ModelTypeInput } from "./model_type";
import { resolveModelType } from "./model_type";

import { parseSecureVideoConfig, type SecureVideoConfig } from "./secure_skill_video_config";
export type { SecureVideoConfig } from "./secure_skill_video_config";
import { parseDoubaoVideoConfig, type DoubaoVideoConfig } from "./doubao_video_config";
export type VideoConfig = GenericVideoConfig | SecureVideoConfig | DoubaoVideoConfig;
export interface GenericVideoConfig { adapter: "generic"; task_id_path: string; failed_statuses: string[]; sizes: string[]; seconds_min: number; seconds_max: number; reference_images?: {mapping:"image_images_url"; max_images:number} }
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export function safeVideoPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && value.length > 0
    && value.split(".").every(p => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p) && !forbidden.has(p));
}
export function readVideoConfig(row: ModelTypeInput): VideoConfig | null {
  try {
    const v = JSON.parse(row.config_json || "{}").video;
    if (v?.adapter === "secure_skill") return parseSecureVideoConfig(v);
    if (v?.adapter === "doubao") return parseDoubaoVideoConfig(v);
    if (!v || typeof v !== "object" || Array.isArray(v) || v.adapter !== "generic" || !safeVideoPath(v.task_id_path)
      || Object.keys(v).some(k => !["adapter","task_id_path","failed_statuses","sizes","seconds_min","seconds_max","reference_images"].includes(k))) return null;
    if (v.seconds_min === null || v.seconds_max === null || v.failed_statuses === null) return null;
    const lo = v.seconds_min ?? 3, hi = v.seconds_max ?? 15;
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 3 || hi > 15 || lo > hi) return null;
    if (!Array.isArray(v.sizes) || !v.sizes.length || v.sizes.length > 20 || v.sizes.some((s: unknown) => {
      if (typeof s !== "string" || !/^[1-9][0-9]{2,3}x[1-9][0-9]{2,3}$/.test(s)) return true;
      return s.split("x").some(n => Number(n) > 4096);
    }) || new Set(v.sizes).size !== v.sizes.length) return null;
    const failures = v.failed_statuses ?? [];
    if (!Array.isArray(failures) || failures.length > 20 || failures.some((s: unknown) => typeof s !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(s) || s === "SUCCESS")) return null;
    const refs = v.reference_images;
    if (refs !== undefined && (!refs || typeof refs !== "object" || Array.isArray(refs) || refs.mapping !== "image_images_url"
      || !Number.isInteger(refs.max_images) || refs.max_images < 1 || refs.max_images > 3
      || Object.keys(refs).some(k => !["mapping","max_images"].includes(k)))) return null;
    return {adapter:"generic", task_id_path:v.task_id_path, failed_statuses:[...failures], sizes:[...v.sizes], seconds_min:lo, seconds_max:hi,
      ...(refs ? {reference_images:{mapping:"image_images_url" as const,max_images:refs.max_images}} : {})};
  } catch { return null; }
}
export interface PublicVideoPricing {
  endpoint: "/v1/videos" | "/v1/video/generations";
  settlement: "success";
  quotes: Array<{resolution:string | null; has_reference_video:boolean | null; unit:"call"|"second"; price:number}>;
}
export function publicVideoPricing(row: ModelTypeInput & {pricing_mode?:string;price_per_call?:number}, serviceMultiplier = 1, peakMultiplier = 1, scalarOverride = false): PublicVideoPricing | undefined {
  if (resolveModelType(row) !== "video") return undefined;
  let standard = false;
  try { standard = ["secure_skill","doubao"].includes(JSON.parse(row.config_json || "{}").video?.adapter); } catch {}
  const result: PublicVideoPricing = {endpoint:standard ? "/v1/videos" : "/v1/video/generations",settlement:"success",quotes:[]};
  const cfg = readVideoConfig(row);
  if (!cfg || !["priced","free"].includes(row.pricing_mode || "")) return result;
  if (![serviceMultiplier,peakMultiplier].every(n=>Number.isFinite(n)&&n>=0)) return result;
  if (cfg.adapter === "secure_skill" || cfg.adapter === "doubao") {
    if (scalarOverride || (row.pricing_mode === "free" && cfg.quotes.some(q=>q.price!==0))) return result;
    result.quotes = cfg.quotes.map(q=>({resolution:q.resolution,has_reference_video:q.has_reference_video,unit:q.unit,price:q.price*serviceMultiplier*peakMultiplier}));
  } else {
    const price = row.pricing_mode === "free" ? 0 : (row.price_per_call ?? 0)*peakMultiplier;
    result.quotes = [{resolution:null,has_reference_video:null,unit:"call",price}];
  }
  if (result.quotes.some(q=>!Number.isFinite(q.price)||q.price<0)) result.quotes=[];
  return result;
}

export function publicVideoLimits(row: ModelTypeInput): {sizes:string[]; seconds_min:number; seconds_max:number; reference_images?:{max_images:number}; ratios?:string[];resolutions?:string[];default_resolution?:string;max_images?:number;min_images?:number;max_videos?:number;max_audios?:number;support_audio_only?:boolean;max_audio_only?:number;support_first_last?:boolean;support_video_urls?:boolean;support_audio_urls?:boolean;request_format?:"doubao_content";default_duration?:number;default_ratio?:string;max_total_refs?:number;allow_tail_only?:boolean;content_available?:boolean} | undefined {
  if (resolveModelType(row) !== "video") return undefined;
  try { const v = JSON.parse(row.config_json || "{}").video;
    if (v?.adapter === "secure_skill" || v?.adapter === "doubao") {
      const cfg = v.adapter === "doubao" ? parseDoubaoVideoConfig(v) : parseSecureVideoConfig(v);
      return cfg ? {sizes:[],seconds_min:cfg.seconds_min,seconds_max:cfg.seconds_max,ratios:cfg.ratios,resolutions:cfg.resolutions,default_resolution:cfg.default_resolution,max_images:cfg.max_images,min_images:cfg.min_images,max_videos:cfg.max_videos,max_audios:cfg.max_audios,support_audio_only:cfg.support_audio_only,max_audio_only:cfg.max_audio_only,support_first_last:cfg.support_first_last,support_video_urls:cfg.support_video_urls,support_audio_urls:cfg.support_audio_urls,default_duration:cfg.default_duration,default_ratio:cfg.default_ratio,...(cfg.adapter === "doubao" ? {request_format:"doubao_content" as const,max_total_refs:cfg.max_total_refs,allow_tail_only:true,content_available:false} : {})} : undefined;
    }
    const publicRefs = v?.reference_images;
    const reference_images = publicRefs && !Object.prototype.hasOwnProperty.call(publicRefs,"mapping")
      ? {mapping:"image_images_url",max_images:publicRefs.max_images} : publicRefs;
    const cfg = readVideoConfig({config_json:JSON.stringify({video:{...v,...(reference_images !== undefined ? {reference_images} : {}),adapter:"generic",task_id_path:"public_limits"}})});
    return cfg ? {sizes:cfg.sizes,seconds_min:cfg.seconds_min,seconds_max:cfg.seconds_max,
      ...(cfg.adapter === "generic" && cfg.reference_images ? {reference_images:{max_images:cfg.reference_images.max_images}} : {})} : undefined;
  } catch { return undefined; }
}
export function videoModelError(row: ModelTypeInput & { provider_type?: string; input_price_per_m?:number; output_price_per_m?:number; cache_read_price_per_m?:number; cache_write_price_per_m?:number; search_price_per_call?:number; cache_enabled?:number | boolean }): string | null {
  if (resolveModelType(row) !== "video") return null;
  if (row.billing_unit !== "call") return "video_requires_call_billing";
  if (row.provider_type !== undefined && row.provider_type !== "openai") return "video_requires_openai_provider";
  if (!readVideoConfig(row)) return "invalid_video_config";
  if ([row.input_price_per_m,row.output_price_per_m,row.cache_read_price_per_m,row.cache_write_price_per_m,row.search_price_per_call].some(p => Number(p ?? 0) !== 0)) return "video_call_only_pricing";
  if (row.cache_enabled) return "video_cache_not_supported";
  return null;
}
export function videoPoolError(billing: Parameters<typeof videoModelError>[0], members: Parameters<typeof videoModelError>[0][]): string | null {
  const error = videoModelError(billing); if (error) return error;
  const cfg = readVideoConfig(billing); if (!cfg || !members.length) return "invalid_video_pool";
  for (const m of members) {
    if (resolveModelType(m) !== "video" || m.billing_unit !== "call" || m.provider_type !== "openai") return "incompatible_video_member";
    const memberError = videoModelError(m); if (memberError) return memberError;
    const c = readVideoConfig(m);
    if (!c || c.adapter !== cfg.adapter) return "incompatible_video_member";
    if (cfg.adapter === "secure_skill" && c.adapter === "secure_skill" && (cfg.upstream_model !== c.upstream_model || cfg.default_duration !== c.default_duration || cfg.default_ratio !== c.default_ratio || cfg.default_resolution !== c.default_resolution || cfg.ratios.some(r=>!c.ratios.includes(r)) || cfg.resolutions.some(r=>!c.resolutions.includes(r)) || cfg.max_images > c.max_images || cfg.min_images < c.min_images || cfg.max_videos > c.max_videos || cfg.max_audios > c.max_audios || (cfg.support_audio_only && (!c.support_audio_only || cfg.max_audio_only > c.max_audio_only)) || (cfg.support_first_last && !c.support_first_last) || (cfg.support_video_urls && !c.support_video_urls) || (cfg.support_audio_urls && !c.support_audio_urls) || cfg.quotes.some(q=>!c.quotes.some(m=>m.resolution===q.resolution && m.has_reference_video===q.has_reference_video)))) return "incompatible_video_member";
    if (cfg.adapter === "doubao" && c.adapter === "doubao" && (cfg.upstream_model !== c.upstream_model || cfg.default_duration !== c.default_duration || cfg.default_ratio !== c.default_ratio || cfg.default_resolution !== c.default_resolution || cfg.use_asset_library !== c.use_asset_library || cfg.ratios.some(r=>!c.ratios.includes(r)) || cfg.resolutions.some(r=>!c.resolutions.includes(r)) || cfg.min_images < c.min_images || cfg.max_images > c.max_images || cfg.max_videos > c.max_videos || cfg.max_audios > c.max_audios || cfg.max_total_refs > c.max_total_refs || (cfg.support_first_last && !c.support_first_last) || (cfg.support_video_urls && !c.support_video_urls) || (cfg.support_audio_urls && !c.support_audio_urls) || (cfg.support_audio_only && (!c.support_audio_only || cfg.max_audio_only > c.max_audio_only)) || cfg.quotes.some(q=>!c.quotes.some(m=>m.resolution===q.resolution && m.has_reference_video===q.has_reference_video)))) return "incompatible_video_member";
    if (!c || c.seconds_min > cfg.seconds_min || c.seconds_max < cfg.seconds_max || cfg.sizes.some(s => !c.sizes.includes(s))
      || (cfg.adapter === "generic" && cfg.reference_images && (c.adapter !== "generic" || !c.reference_images || c.reference_images.max_images < cfg.reference_images.max_images))) return "incompatible_video_member";
  }
  return null;
}
export function videoCreationEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000 || /[\\\s%]/.test(value) || /\/\.{1,2}(?:\/|$)/.test(value)) return null;
  try {
    const u = new URL(value); const h = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.port && u.port !== "443")
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(h)
      || /(?:^|\.)(?:localhost|local|internal|home|lan|onion)$/.test(h)) return null;
    const path=u.pathname.replace(/\/+$/,"");
    if (path && path.split("/").slice(1).some(s => !/^[A-Za-z0-9_~-]+$/.test(s))) return null;
    return u.origin + path + "/video/generations";
  } catch { return null; }
}
export function safeVideoUpstreamId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}
export function safeVideoUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || /[\\\s]/.test(value)) return false;
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !!u.hostname && !u.hash; } catch { return false; }
}
export function readVideoPath(body: unknown, path: string): unknown {
  if (!safeVideoPath(path)) return undefined;
  let current: unknown = body;
  for (const p of path.split(".")) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current,p)) return undefined;
    current = (current as Record<string, unknown>)[p];
  }
  return current;
}
