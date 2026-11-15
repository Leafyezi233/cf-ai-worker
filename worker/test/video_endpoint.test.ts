import { describe, expect, it } from "vitest";
import { videoApiEndpoint, videoUpstreamModel } from "../src/gateway/video_endpoint";
import { secureVideoEndpoint, parseSecureVideoConfig } from "../src/gateway/secure_skill_video_config";
import { doubaoVideoEndpoint } from "../src/gateway/doubao_video_config";
import { normalizeSecureVideoRequest, parseSecureVideoRequest } from "../src/gateway/secure_skill_video_request";
import { videoPoolError } from "../src/gateway/video_config";
const raw={adapter:"secure_skill",upstream_model:"vendor/video-v3",ratios:["16:9","9:16"],resolutions:["custom_HD"],default_ratio:"9:16",default_duration:7,default_resolution:"custom_HD",seconds_min:4,seconds_max:12,max_images:0,support_first_last:false,quotes:[{resolution:"custom_HD",has_reference_video:false,unit:"second",price:0.2}]};
describe("configurable video upstreams",()=>{
 it.each(["https://video.vendor.example","https://video.vendor.example/","https://api.other.example/custom/v2","https://api.other.example/custom/v2/"])("appends independent protocol paths to %s",base=>{
  const canonical=base.replace(/\/$/,"");
  expect(secureVideoEndpoint(base)).toBe(canonical+"/videos");
  expect(doubaoVideoEndpoint(base)).toBe(canonical+"/contents/generations/tasks");
 });
 it.each([undefined,null,0,"","http://api.vendor.example/v1","https://localhost/v1","https://api.local/v1","https://api.internal/v1","https://api.home/v1","https://api.lan/v1","https://api.onion/v1","https://api.arpa/v1","https://127.0.0.1/v1","https://169.254.169.254/v1","https://[::1]/v1","https://2130706433/v1","https://user:pass@api.vendor.example/v1","https://api.vendor.example:8443/v1","https://api.vendor.example/v1?key=x","https://api.vendor.example/v1#x","https://api.vendor.example/v1/../v2","https://api.vendor.example/v1/%2e%2e/v2","https://api.vendor.example/v1//","https://api.vendor.example/v1/a b"," https://api.vendor.example/v1","https://API.vendor.example/v1","https://api.vendor.example:443/v1","https://api.vendor.example/v1\\secret"])("rejects unsafe or noncanonical API base %j",base=>{
  expect(videoApiEndpoint(base,"/videos")).toBeNull();expect(doubaoVideoEndpoint(base)).toBeNull();
 });
 it.each(["video-v1","vendor/model-fast-v2","video:custom/v3","a".repeat(256)])("accepts explicit model identifier %s",model=>expect(videoUpstreamModel(model)).toBe(true));
 it.each([undefined,null,""," model","bad model","bad\nmodel","a".repeat(257),"<script>"])("rejects malformed model identifier %j",model=>expect(videoUpstreamModel(model)).toBe(false));
 it.each(["upstream_model","default_ratio","default_duration"])("requires explicit secure default %s",key=>{const v:Record<string,unknown>={...raw};delete v[key];expect(parseSecureVideoConfig(v)).toBeNull();});
 it.each([{upstream_model:"bad model"},{default_ratio:"1:1"},{default_duration:3},{default_duration:13},{default_duration:4.5},{default_duration:null}])("rejects inconsistent secure defaults %j",fields=>expect(parseSecureVideoConfig({...raw,...fields})).toBeNull());
 it("normalizes only configured defaults without mutating or reparsing canonical arrays",()=>{
  const config=parseSecureVideoConfig(raw)!,request=parseSecureVideoRequest({model:"public-video",prompt:"River"})!,before=JSON.stringify(request);
  expect(request.duration).toBeUndefined();expect(request.ratio).toBeUndefined();
  expect(normalizeSecureVideoRequest(config,request)).toMatchObject({duration:7,ratio:"9:16",resolution:"custom_HD",reference_image_ids:[],image_urls:[]});
  expect(JSON.stringify(request)).toBe(before);
  expect(normalizeSecureVideoRequest(config,parseSecureVideoRequest({model:"public-video",prompt:"River",duration:8,ratio:"16:9"})!)).toMatchObject({duration:8,ratio:"16:9"});
 });
 it("does not infer enabled reference counts from a capability flag",()=>{expect(parseSecureVideoConfig({...raw,support_video_urls:true,support_audio_urls:true})).toMatchObject({max_videos:0,max_audios:0});});
 it("requires compatible pool models and defaults before routing",()=>{
  const row=(video:Record<string,unknown>)=>({billing_unit:"call",provider_type:"openai",config_json:JSON.stringify({model_type:"video",video})});
  expect(videoPoolError(row(raw),[row(raw)])).toBeNull();
  for(const fields of [{upstream_model:"other-model"},{default_ratio:"16:9"},{default_duration:8}])expect(videoPoolError(row(raw),[row({...raw,...fields})])).toBe("incompatible_video_member");
 });
});
