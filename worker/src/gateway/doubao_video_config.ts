import { videoApiEndpoint, videoUpstreamModel } from "./video_endpoint";
import type { SecureVideoQuote } from "./secure_skill_video_config";

export interface DoubaoVideoConfig {
  adapter:"doubao";
  upstream_model:string;
  ratios:string[]; resolutions:string[]; default_resolution:string; default_ratio:string; default_duration:number;
  seconds_min:number; seconds_max:number;
  min_images:number; max_images:number; max_videos:number; max_audios:number; max_total_refs:number;
  support_first_last:boolean; support_video_urls:boolean; support_audio_urls:boolean;
  support_audio_only:boolean; max_audio_only:number; use_asset_library:boolean;
  poll_interval_ms:number; quotes:SecureVideoQuote[];
  sizes:string[]; task_id_path:"id"; failed_statuses:string[];
}

const keys = ["adapter","upstream_model","ratios","resolutions","default_resolution","default_ratio","default_duration",
  "seconds_min","seconds_max","min_images","max_images","max_videos","max_audios","max_total_refs","support_first_last",
  "support_video_urls","support_audio_urls","support_audio_only","max_audio_only","use_asset_library","poll_interval_ms","quotes"];
const integer = (value:unknown,min:number,max:number):value is number => Number.isInteger(value)&&Number(value)>=min&&Number(value)<=max;

export function parseDoubaoVideoConfig(value:unknown):DoubaoVideoConfig|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const v=value as Record<string,unknown>;
  if(v.adapter!=="doubao"||!videoUpstreamModel(v.upstream_model)||Object.keys(v).some(k=>!keys.includes(k)))return null;
  const strings=(x:unknown,valid:(s:string)=>boolean):x is string[]=>Array.isArray(x)&&x.length>0&&x.length<=20
    &&x.every(s=>typeof s==="string"&&valid(s))&&new Set(x).size===x.length;
  if(!strings(v.ratios,s=>/^[1-9][0-9]?:[1-9][0-9]?$/.test(s))
    ||!strings(v.resolutions,s=>/^[A-Za-z0-9_-]{1,32}$/.test(s))
    ||typeof v.default_resolution!=="string"||!v.resolutions.includes(v.default_resolution))return null;
  const defaultRatio=v.default_ratio;
  const defaultDuration=v.default_duration;
  const maxDuration=30;
  if(!integer(v.seconds_min,4,maxDuration)||!integer(v.seconds_max,v.seconds_min,maxDuration)
    ||!integer(defaultDuration,v.seconds_min,v.seconds_max)||typeof defaultRatio!=="string"||!v.ratios.includes(defaultRatio))return null;
  if(!integer(v.max_images,0,30)||!integer(v.max_videos,0,10)||!integer(v.max_audios,0,10)||!integer(v.max_total_refs,0,50)
    ||typeof v.support_first_last!=="boolean")return null;
  const minImages=v.min_images===undefined?0:v.min_images,maxAudioOnly=v.max_audio_only===undefined?0:v.max_audio_only;
  if(!integer(minImages,0,v.max_images)||minImages>v.max_total_refs||!integer(maxAudioOnly,0,v.max_audios))return null;
  for(const key of ["support_video_urls","support_audio_urls","support_audio_only","use_asset_library"])
    if(v[key]!==undefined&&typeof v[key]!=="boolean")return null;
  if(v.support_audio_only===true&&(v.support_audio_urls!==true||maxAudioOnly<1)
    ||v.support_audio_only!==true&&maxAudioOnly!==0)return null;
  const poll=v.poll_interval_ms===undefined?15000:v.poll_interval_ms;
  if(!integer(poll,15000,300000))return null;
  if(!Array.isArray(v.quotes)||!v.quotes.length||v.quotes.length>40)return null;
  const seen=new Set<string>(),quotes:SecureVideoQuote[]=[];
  for(const item of v.quotes){
    if(!item||typeof item!=="object"||Array.isArray(item))return null;
    const q=item as Record<string,unknown>;
    if(Object.keys(q).some(k=>!["resolution","has_reference_video","unit","price"].includes(k))
      ||typeof q.resolution!=="string"||!v.resolutions.includes(q.resolution)||typeof q.has_reference_video!=="boolean"
      ||q.unit!=="call"&&q.unit!=="second"||typeof q.price!=="number"||!Number.isFinite(q.price)||q.price<0||q.price>10000)return null;
    const key=JSON.stringify([q.resolution,q.has_reference_video]);
    if(seen.has(key))return null;seen.add(key);
    quotes.push({resolution:q.resolution,has_reference_video:q.has_reference_video,unit:q.unit,price:q.price});
  }
  return {adapter:"doubao",upstream_model:v.upstream_model as DoubaoVideoConfig["upstream_model"],ratios:[...v.ratios],
    resolutions:[...v.resolutions],default_resolution:v.default_resolution,default_ratio:defaultRatio,default_duration:defaultDuration,
    seconds_min:v.seconds_min,seconds_max:v.seconds_max,min_images:minImages,max_images:v.max_images,max_videos:v.max_videos,
    max_audios:v.max_audios,max_total_refs:v.max_total_refs,support_first_last:v.support_first_last,
    support_video_urls:v.support_video_urls===true,support_audio_urls:v.support_audio_urls===true,
    support_audio_only:v.support_audio_only===true,max_audio_only:maxAudioOnly,use_asset_library:v.use_asset_library===true,
    poll_interval_ms:poll,quotes,sizes:[],task_id_path:"id",failed_statuses:["failed"]};
}

export function doubaoVideoEndpoint(base:unknown):string|null {
  return videoApiEndpoint(base,"/contents/generations/tasks");
}
