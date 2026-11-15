import {describe,it,expect} from "vitest";
import type {Env} from "../src/types";
import {validateServiceImageIds,bindServiceImageIds} from "../src/gateway/video_reference_service";
import {validateServiceVideoIds,bindServiceVideoIds} from "../src/gateway/video_reference_video_service";
describe("private video material service-call fanout (synthetic service, no R2)",()=>{
 it.each([[0,0,0],[1,1,5],[9,3,25]])("counts %i images / %i videos and no binary fetch",async(images,videos,wanted)=>{
  let calls=0,active=0,maxActive=0;
  const env={VIDEO_REFERENCE_IMAGE_ORIGIN:"https://refs.cpg.org",VIDEO_REFERENCE_IMAGES:{fetch:async(request:Request)=>{calls++;active++;maxActive=Math.max(maxActive,active);try{const url=new URL(request.url);if(url.pathname.endsWith("/limits"))return Response.json({enabled:true,formats:["video/mp4"],max_bytes:20971520,max_duration_ms:15000});const isVideo=url.pathname.includes("video-assets"),id=url.pathname.split("/")[3];if(request.method==="POST"){const b=await request.json() as any;return Response.json({id,expires_at:b.expires_at,url:"https://refs.cpg.org/"+(isVideo?"video-assets/":"assets/")+id+"?synthetic=1"});}return Response.json({id,bytes:16,content_type:isVideo?"video/mp4":"image/png",...(isVideo?{duration_ms:1000}:{}),expires_at:Math.floor(Date.now()/1000)+1000});}finally{active--;}}}} as unknown as Env;
  const device={id:"synthetic-owner",sub_token_id:null} as any,ids=Array.from({length:images},(_,i)=>i.toString(16).padStart(32,"0")),vids=Array.from({length:videos},(_,i)=>(i+100).toString(16).padStart(32,"0"));
  await validateServiceImageIds(env,device,ids);await validateServiceVideoIds(env,device,vids);const imageUrls=await bindServiceImageIds(env,device,ids,"vid_synthetic123"),videoUrls=await bindServiceVideoIds(env,device,vids,"vid_synthetic123");
  expect(imageUrls).toHaveLength(images);expect(videoUrls).toHaveLength(videos);expect(calls).toBe(wanted);expect(maxActive).toBe(wanted?1:0);
 });
});
