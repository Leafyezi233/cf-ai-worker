import type { SecureVideoConfig } from "./secure_skill_video_config";
import { safeVideoUrl } from "./video_config";
export interface SecureVideoRequest {model:string;prompt:string;duration?:number;ratio?:string;resolution?:string;image_urls:string[];video_urls:string[];audio_urls:string[];first_frame?:string;last_frame?:string;reference_image_ids:string[];reference_video_ids:string[];first_frame_id?:string;last_frame_id?:string}
export function publicReferenceUrl(value:unknown):value is string {
  if(!safeVideoUrl(value))return false;
  try {const u=new URL(value),h=u.hostname.toLowerCase();return (!u.port||u.port==="443")
    &&/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(h)
    &&!/(?:^|\.)(?:localhost|local|internal|home|lan|onion|test|invalid|example)$/.test(h)
    &&!h.endsWith(".arpa");}catch{return false;}
}
export function parseSecureVideoRequest(value:unknown):SecureVideoRequest|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const b=value as Record<string,unknown>;
  const keys=["model","prompt","duration","seconds","ratio","aspect_ratio","resolution","image_urls","video_urls","audio_urls","first_frame","last_frame","reference_image_ids","first_frame_id","last_frame_id","reference_video_ids","stream"];
  if(Object.keys(b).some(k=>!keys.includes(k))||(b.stream!==undefined&&b.stream!==false))return null;
  if(typeof b.model!=="string"||!b.model.trim()||b.model.length>256||typeof b.prompt!=="string"||!b.prompt.trim()||b.prompt.length>8000)return null;
  if(b.duration!==undefined&&b.seconds!==undefined&&b.duration!==b.seconds)return null;
  if(b.ratio!==undefined&&b.aspect_ratio!==undefined&&b.ratio!==b.aspect_ratio)return null;
  if (["duration","seconds","ratio","aspect_ratio"].some(k=>b[k]===null))return null;
  const duration=b.duration??b.seconds,ratio=b.ratio??b.aspect_ratio;
  if(duration!==undefined&&(!Number.isInteger(duration)||Number(duration)<4||Number(duration)>15)
    ||ratio!==undefined&&(typeof ratio!=="string"||!/^[1-9][0-9]?:[1-9][0-9]?$/.test(ratio)))return null;
  if(b.resolution!==undefined&&(typeof b.resolution!=="string"||!/^[A-Za-z0-9_-]{1,32}$/.test(b.resolution)))return null;
  const urls=(v:unknown,max:number):v is string[]=>Array.isArray(v)&&v.length<=max&&v.every(publicReferenceUrl)&&new Set(v).size===v.length;
  const id=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{32}$/.test(v);
  for(const k of ["image_urls","video_urls","audio_urls"]){if(b[k]!==undefined&&!urls(b[k],k==="image_urls"?9:3))return null;}
  if([b.first_frame,b.last_frame].some(v=>v!==undefined&&!publicReferenceUrl(v)))return null;
  if([b.first_frame_id,b.last_frame_id].some(v=>v!==undefined&&!id(v)))return null;
  if(b.reference_image_ids!==undefined&&(!Array.isArray(b.reference_image_ids)||b.reference_image_ids.length>9||!b.reference_image_ids.every(id)))return null;
  if(b.reference_video_ids!==undefined&&(!Array.isArray(b.reference_video_ids)||b.reference_video_ids.length>3||!b.reference_video_ids.every(id)||new Set(b.reference_video_ids).size!==b.reference_video_ids.length))return null;
  if(b.reference_video_ids!==undefined&&b.video_urls!==undefined)return null;
  if((b.last_frame!==undefined||b.last_frame_id!==undefined)&&b.first_frame===undefined&&b.first_frame_id===undefined)return null;
  const ids=[...(b.reference_image_ids as string[]??[]),...[b.first_frame_id,b.last_frame_id].filter((x):x is string=>typeof x==="string")];
  const hasFrames=b.first_frame!==undefined||b.last_frame!==undefined||b.first_frame_id!==undefined||b.last_frame_id!==undefined;
  if(hasFrames&&([b.image_urls,b.video_urls,b.audio_urls,b.reference_image_ids,b.reference_video_ids].some(v=>Array.isArray(v)&&v.length>0)))return null;
  const allUrls=[...(b.image_urls as string[]??[]),...[b.first_frame,b.last_frame].filter((x):x is string=>typeof x==="string")];
  if(ids.length>9||new Set(ids).size!==ids.length||new Set(allUrls).size!==allUrls.length
    ||(b.image_urls!==undefined&&b.reference_image_ids!==undefined)||(b.first_frame!==undefined&&b.first_frame_id!==undefined)||(b.last_frame!==undefined&&b.last_frame_id!==undefined))return null;
  return {model:b.model,prompt:b.prompt,duration:duration as number|undefined,ratio:ratio as string|undefined,resolution:b.resolution as string|undefined,
    image_urls:b.image_urls as string[]??[],video_urls:b.video_urls as string[]??[],audio_urls:b.audio_urls as string[]??[],
    reference_image_ids:b.reference_image_ids as string[]??[],reference_video_ids:b.reference_video_ids as string[]??[],first_frame:b.first_frame as string|undefined,last_frame:b.last_frame as string|undefined,
    first_frame_id:b.first_frame_id as string|undefined,last_frame_id:b.last_frame_id as string|undefined};
}
export function secureRequestError(config:SecureVideoConfig,b:SecureVideoRequest):string|null {
  const resolution=b.resolution??config.default_resolution,duration=b.duration??config.default_duration,ratio=b.ratio??config.default_ratio;
  if(!Number.isInteger(duration)||!config.ratios.includes(ratio)||!config.resolutions.includes(resolution)||duration<config.seconds_min||duration>config.seconds_max)return "video_spec_not_allowed";
  const frames=Number(!!(b.first_frame||b.first_frame_id))+Number(!!(b.last_frame||b.last_frame_id));
  const images=b.image_urls.length+b.reference_image_ids.length+frames,videos=b.video_urls.length+b.reference_video_ids.length;
  if(images>config.max_images||images<config.min_images||videos>config.max_videos||b.audio_urls.length>config.max_audios)return "video_references_not_allowed";
  if(!images&&!videos&&b.audio_urls.length&&(!config.support_audio_only||b.audio_urls.length>config.max_audio_only))return "video_audio_only_not_allowed";
  if(frames&&!config.support_first_last||videos&&!config.support_video_urls||b.audio_urls.length&&!config.support_audio_urls)return "video_feature_not_allowed";
  if(!config.quotes.some(q=>q.resolution===resolution&&q.has_reference_video===(videos>0)))return "video_quote_missing";
  return null;
}
export type NormalizedSecureVideoRequest = SecureVideoRequest & {duration:number;ratio:string;resolution:string};
export function normalizeSecureVideoRequest(config:SecureVideoConfig,request:SecureVideoRequest):NormalizedSecureVideoRequest|null {
  const parsed=request;
  const result={...parsed,duration:parsed.duration??config.default_duration,ratio:parsed.ratio??config.default_ratio,resolution:parsed.resolution??config.default_resolution};
  return secureRequestError(config,result)?null:result;
}
export function serviceImageIds(b:SecureVideoRequest):string[]{return [...b.reference_image_ids,...(b.first_frame_id?[b.first_frame_id]:[]),...(b.last_frame_id?[b.last_frame_id]:[])];}
