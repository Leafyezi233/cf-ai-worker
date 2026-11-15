import { videoApiEndpoint, videoUpstreamModel } from "./video_endpoint";

export interface SecureVideoQuote { resolution:string; has_reference_video:boolean; unit:"call"|"second"; price:number }
export interface SecureVideoConfig {
  adapter:"secure_skill"; upstream_model:string; default_ratio:string; default_duration:number; ratios:string[]; resolutions:string[]; default_resolution:string;
  seconds_min:number; seconds_max:number; max_images:number; min_images:number; max_videos:number; max_audios:number; support_audio_only:boolean; max_audio_only:number; support_first_last:boolean;
  support_video_urls:boolean; support_audio_urls:boolean; poll_interval_ms:number; quotes:SecureVideoQuote[];
  sizes:string[]; task_id_path:string; failed_statuses:string[]; reference_images?:{mapping:"image_images_url";max_images:number};
}
export function parseSecureVideoConfig(value:unknown):SecureVideoConfig|null {
  if (!value || typeof value!=="object" || Array.isArray(value)) return null;
  const v=value as Record<string,unknown>;
  const keys=["upstream_model","default_ratio","default_duration","adapter","ratios","resolutions","default_resolution","seconds_min","seconds_max","max_images","support_first_last","support_video_urls","support_audio_urls","min_images","max_videos","max_audios","support_audio_only","max_audio_only","poll_interval_ms","quotes"];
  if(v.adapter!=="secure_skill" || !videoUpstreamModel(v.upstream_model) || Object.keys(v).some(k=>!keys.includes(k)))return null;
  const strings=(x:unknown,re:RegExp):x is string[]=>Array.isArray(x)&&x.length>0&&x.length<=20&&x.every(s=>typeof s==="string"&&re.test(s))&&new Set(x).size===x.length;
  if(!strings(v.ratios,/^[1-9][0-9]?:[1-9][0-9]?$/)||!strings(v.resolutions,/^[A-Za-z0-9_-]{1,32}$/)
    ||typeof v.default_resolution!=="string"||!v.resolutions.includes(v.default_resolution))return null;
  if(!Number.isInteger(v.seconds_min)||!Number.isInteger(v.seconds_max)||Number(v.seconds_min)<4||Number(v.seconds_max)>15||Number(v.seconds_min)>Number(v.seconds_max)
    ||!Number.isInteger(v.max_images)||Number(v.max_images)<0||Number(v.max_images)>9||typeof v.support_first_last!=="boolean")return null;
  if([v.support_video_urls,v.support_audio_urls].some(x=>x!==undefined&&typeof x!=="boolean"))return null;
  if(typeof v.default_ratio!=="string"||!v.ratios.includes(v.default_ratio)||!Number.isInteger(v.default_duration)||Number(v.default_duration)<Number(v.seconds_min)||Number(v.default_duration)>Number(v.seconds_max))return null;
  const minImages=v.min_images??0,maxVideos=v.max_videos??0,maxAudios=v.max_audios??0;
  if(!Number.isInteger(minImages)||Number(minImages)<0||Number(minImages)>Number(v.max_images)
    ||!Number.isInteger(maxVideos)||Number(maxVideos)<0||Number(maxVideos)>3
    ||!Number.isInteger(maxAudios)||Number(maxAudios)<0||Number(maxAudios)>3
    ||v.support_audio_only!==undefined&&typeof v.support_audio_only!=="boolean")return null;
  const maxAudioOnly=v.max_audio_only??0;
  if(!Number.isInteger(maxAudioOnly)||Number(maxAudioOnly)<0||Number(maxAudioOnly)>Number(maxAudios)
    ||v.support_audio_only===true&&(v.support_audio_urls!==true||Number(maxAudioOnly)<1)
    ||v.support_audio_only!==true&&Number(maxAudioOnly)!==0)return null;
  const poll=v.poll_interval_ms??15000;
  if(!Number.isInteger(poll)||Number(poll)<15000||Number(poll)>300000)return null;
  if(!Array.isArray(v.quotes)||!v.quotes.length||v.quotes.length>40)return null;
  const seen=new Set<string>();
  for(const q of v.quotes){
    if(!q||typeof q!=="object"||Array.isArray(q)||Object.keys(q).some(k=>!["resolution","has_reference_video","unit","price"].includes(k))
      ||!v.resolutions.includes(q.resolution)||typeof q.has_reference_video!=="boolean"||!["call","second"].includes(q.unit)
      ||typeof q.price!=="number"||!Number.isFinite(q.price)||q.price<0||q.price>10000)return null;
    const key=JSON.stringify([q.resolution,q.has_reference_video]);if(seen.has(key))return null;seen.add(key);
  }
  return {adapter:"secure_skill",upstream_model:v.upstream_model,default_ratio:v.default_ratio,default_duration:Number(v.default_duration),ratios:[...v.ratios],resolutions:[...v.resolutions],default_resolution:v.default_resolution,
    seconds_min:Number(v.seconds_min),seconds_max:Number(v.seconds_max),max_images:Number(v.max_images),min_images:Number(minImages),max_videos:Number(maxVideos),max_audios:Number(maxAudios),support_audio_only:v.support_audio_only===true,max_audio_only:Number(maxAudioOnly),support_first_last:v.support_first_last,
    support_video_urls:v.support_video_urls===true,support_audio_urls:v.support_audio_urls===true,poll_interval_ms:Number(poll),
    quotes:v.quotes.map(q=>({...q})),sizes:[],task_id_path:"task_id",failed_statuses:["failed"]};
}
export function secureVideoEndpoint(base:unknown):string|null {
  return videoApiEndpoint(base,"/videos");
}
