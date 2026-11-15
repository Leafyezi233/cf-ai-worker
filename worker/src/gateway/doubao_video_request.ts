import type { DoubaoVideoConfig } from "./doubao_video_config";
import { publicReferenceUrl } from "./secure_skill_video_request";

export interface DoubaoContentPart {
  type:"text"|"image_url"|"video_url"|"audio_url";
  text?:string; image_url?:{url:string}; video_url?:{url:string}; audio_url?:{url:string};
  role?:"reference_image"|"first_frame"|"last_frame"|"reference_video"|"reference_audio";
}
export interface DoubaoVideoRequest {
  model:string; content:DoubaoContentPart[]; duration?:number; ratio?:string; resolution?:string;
  use_asset_library?:boolean; generate_audio?:boolean; watermark?:boolean; return_last_frame?:boolean; seed?:number;
}
const shorthand=["prompt","images","videos","audios","image_urls","video_urls","audio_urls","first_frame","last_frame",
  "reference_image_ids","reference_video_ids","first_frame_id","last_frame_id"];
const options=["use_asset_library","generate_audio","watermark","return_last_frame"] as const;
const keys=["model","content","duration","seconds","ratio","aspect_ratio","resolution","stream","seed",...shorthand,...options];
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const privateId=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{32}$/.test(v);

function contentParts(value:unknown,internal:boolean):DoubaoContentPart[]|null {
  if(!Array.isArray(value)||value.length>8050)return null;
  const out:DoubaoContentPart[]=[],seen=new Set<string>();
  let textLength=0,texts=0,images=0,videos=0,audios=0,first=0,last=0,referenceImages=0;
  for(const item of value){
    if(!object(item))return null;
    if(item.type==="text"){
      if(Object.keys(item).some(k=>!["type","text"].includes(k))||typeof item.text!=="string")return null;
      textLength+=item.text.length;if(item.text.trim())texts++;out.push({type:"text",text:item.text});continue;
    }
    const type=item.type;
    if(type!=="image_url"&&type!=="video_url"&&type!=="audio_url")return null;
    if(Object.keys(item).some(k=>!["type",type,"role"].includes(k)))return null;
    const ref=item[type];
    if(!object(ref)||Object.keys(ref).some(k=>k!=="url")||typeof ref.url!=="string")return null;
    const sentinel=internal&&(type==="image_url"?/^cpg-image:[a-f0-9]{32}$/:type==="video_url"?/^cpg-video:[a-f0-9]{32}$/:/a^/).test(ref.url);
    if(!sentinel&&!publicReferenceUrl(ref.url))return null;
    const identity=sentinel?"id:"+ref.url.split(":")[1]:new URL(ref.url).href;
    if(seen.has(identity))return null;seen.add(identity);
    const role=item.role===undefined?(type==="image_url"?"reference_image":type==="video_url"?"reference_video":"reference_audio"):item.role;
    if(type==="image_url"){
      if(role!=="reference_image"&&role!=="first_frame"&&role!=="last_frame")return null;
      images++;if(role==="first_frame")first++;else if(role==="last_frame")last++;else referenceImages++;
    }else if(type==="video_url"){if(role!=="reference_video")return null;videos++;}
    else {if(role!=="reference_audio")return null;audios++;}
    out.push({type,[type]:{url:ref.url},role} as DoubaoContentPart);
  }
  if(!texts||textLength>8000||images>30||videos>10||audios>10||images+videos+audios>50||first>1||last>1
    ||(first+last>0&&(images>2||videos>0||referenceImages>0)))return null;
  return out;
}

function parseRequest(value:unknown,internal:boolean):DoubaoVideoRequest|null {
  if(!object(value))return null;
  const b=value;
  if(Object.keys(b).some(k=>!keys.includes(k))||b.stream!==undefined&&b.stream!==false
    ||typeof b.model!=="string"||!b.model.trim()||b.model.length>256)return null;
  for(const k of options)if(b[k]!==undefined&&typeof b[k]!=="boolean")return null;
  if(b.seed!==undefined&&(!Number.isInteger(b.seed)||Number(b.seed)<-1||Number(b.seed)>4294967295))return null;
  if(b.duration!==undefined&&b.seconds!==undefined&&b.duration!==b.seconds
    ||b.ratio!==undefined&&b.aspect_ratio!==undefined&&b.ratio!==b.aspect_ratio)return null;
  if(["duration","seconds","ratio","aspect_ratio"].some(k=>b[k]===null))return null;
  const duration=b.duration??b.seconds,ratio=b.ratio??b.aspect_ratio;
  if(duration!==undefined&&(!Number.isInteger(duration)||Number(duration)<4||Number(duration)>30)
    ||ratio!==undefined&&(typeof ratio!=="string"||!/^[1-9][0-9]?:[1-9][0-9]?$/.test(ratio))
    ||b.resolution!==undefined&&(typeof b.resolution!=="string"||!/^[A-Za-z0-9_-]{1,32}$/.test(b.resolution)))return null;
  let content:DoubaoContentPart[]|null;
  if(Object.prototype.hasOwnProperty.call(b,"content")){
    if(shorthand.some(k=>Object.prototype.hasOwnProperty.call(b,k)))return null;
    content=contentParts(b.content,internal);
  }else{
    if(typeof b.prompt!=="string"||!b.prompt.trim()||b.prompt.length>8000)return null;
    const parts:DoubaoContentPart[]=[{type:"text",text:b.prompt}];
    for(const [plural,alias,type,role,idKey,prefix,max] of [
      ["images","image_urls","image_url","reference_image","reference_image_ids","cpg-image:",30],
      ["videos","video_urls","video_url","reference_video","reference_video_ids","cpg-video:",10],
      ["audios","audio_urls","audio_url","reference_audio",null,null,10],
    ] as const){
      if(b[plural]!==undefined&&b[alias]!==undefined)return null;
      const urls=b[plural]??b[alias];
      if(b[plural]===null||b[alias]===null)return null;
      if(idKey&&b[idKey]!==undefined&&(b[plural]!==undefined||b[alias]!==undefined))return null;
      if(urls!==undefined){
        if(!Array.isArray(urls)||urls.length>max||!urls.every(publicReferenceUrl))return null;
        for(const url of urls)parts.push({type,[type]:{url},role} as DoubaoContentPart);
      }
      if(idKey&&b[idKey]!==undefined){
        const ids=b[idKey];if(!Array.isArray(ids)||ids.length>max||!ids.every(privateId))return null;
        for(const id of ids)parts.push({type,[type]:{url:prefix+id},role} as DoubaoContentPart);
      }
    }
    for(const role of ["first_frame","last_frame"] as const){
      const url=b[role],id=b[role+"_id"];
      if(url!==undefined&&id!==undefined||url!==undefined&&!publicReferenceUrl(url)||id!==undefined&&!privateId(id))return null;
      if(url!==undefined||id!==undefined)parts.push({type:"image_url",image_url:{url:url as string??"cpg-image:"+id},role});
    }
    content=contentParts(parts,true);
  }
  if(!content)return null;
  const result:DoubaoVideoRequest={model:b.model,content};
  if(duration!==undefined)result.duration=duration as number;
  if(ratio!==undefined)result.ratio=ratio as string;
  if(b.resolution!==undefined)result.resolution=b.resolution as string;
  for(const key of options)if(b[key]!==undefined)result[key]=b[key] as boolean;
  if(b.seed!==undefined)result.seed=b.seed as number;
  return result;
}

export function parseDoubaoVideoRequest(value:unknown):DoubaoVideoRequest|null { return parseRequest(value,false); }

export function normalizeDoubaoRequest(config:DoubaoVideoConfig,request:DoubaoVideoRequest):DoubaoVideoRequest|null {
  const b=parseRequest(request,true);if(!b)return null;
  const duration=b.duration??config.default_duration,ratio=b.ratio??config.default_ratio,resolution=b.resolution??config.default_resolution;
  if(duration<config.seconds_min||duration>config.seconds_max||!config.ratios.includes(ratio)||!config.resolutions.includes(resolution))return null;
  const images=b.content.filter(p=>p.type==="image_url").length,videos=b.content.filter(p=>p.type==="video_url").length,
    audios=b.content.filter(p=>p.type==="audio_url").length,frames=b.content.some(p=>p.role==="first_frame"||p.role==="last_frame");
  if(images<config.min_images||images>config.max_images||videos>config.max_videos||audios>config.max_audios
    ||images+videos+audios>config.max_total_refs||frames&&!config.support_first_last||videos>0&&!config.support_video_urls
    ||audios>0&&!config.support_audio_urls||!images&&!videos&&audios>0&&(!config.support_audio_only||audios>config.max_audio_only)
    ||b.use_asset_library===true&&!config.use_asset_library
    ||!config.quotes.some(q=>q.resolution===resolution&&q.has_reference_video===(videos>0)))return null;
  return {...b,duration,ratio,resolution,use_asset_library:b.use_asset_library??config.use_asset_library};
}
