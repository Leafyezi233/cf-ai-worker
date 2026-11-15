import { beforeEach, describe, expect, it, vi } from "vitest";
import { readProtocolCapabilities as read, planProtocolRoute as plan, resetProtocolCapabilityCache, protocolCapabilityCacheStats as stats, hasOpaqueProtocolState } from "../src/gateway/protocol_capabilities";
const row = (pc?:any) => ({provider_type:"openai",billing_unit:"token",config_json:JSON.stringify(pc ? {protocol_capabilities:pc}: {})});
beforeEach(resetProtocolCapabilityCache);
describe("local capability planner and bounded cache",()=>{
 it("preserves legacy Chat-backed, native and disabled modes",()=>{
  expect(plan(row(),"chat/completions")).toBe("chat/completions");expect(plan(row(),"responses")).toBe("chat/completions");
  expect(plan({...row(),config_json:'{"responses_mode":"native"}'},"responses")).toBe("responses");
  expect(plan({...row(),config_json:'{"responses_mode":"disabled"}'},"responses")).toBeNull();
  expect(plan(row(),"responses",true)).toBeNull();
 });
 it("supports bidirectional plans, native overrides and strict refusal",()=>{
  const r=row({chat_completions:false,responses:true,chat_route:"responses"});
  expect(plan(r,"chat/completions")).toBe("responses"); expect(plan(r,"responses")).toBe("responses");
  expect(plan(row({chat_completions:false,responses:true,loss_policy:"strict"}),"chat/completions")).toBeNull();
  expect(plan(row({chat_route:"native",chat_completions:false,responses:true}),"chat/completions")).toBeNull();
 });
 it.each([null,[],{unknown:true},{responses:"yes"},{loss_policy:"bad"}])("fails closed invalid explicit declaration %j",pc=>{
  const r={...row(),config_json:JSON.stringify({protocol_capabilities:pc})};expect(read(r).source).toBe("invalid");expect(plan(r,"responses")).toBeNull();expect(plan(r,"chat/completions")).toBeNull();
 });
 it("does not pretend Anthropic, Gemini or images speak Responses natively",()=>{
  expect(read({...row(),provider_type:"anthropic"}).supported_endpoints).toEqual(["/v1/messages"]);
  expect(read({...row(),billing_unit:"call"}).supported_endpoints).toEqual(["/v1/images/generations"]);
  expect(plan({...row({responses:true}),provider_type:"gemini"},"responses",true)).toBeNull();
 });
 it("hits row and content caches, immediately invalidates local config changes and resets both tiers",()=>{
  const r=row(); const a=read(r);expect(read(r)).toBe(a);expect(read({...r})).toBe(a);expect(stats()).toMatchObject({hits:2,misses:1});
  r.config_json='{"responses_mode":"native"}';expect(plan(r,"responses")).toBe("responses");expect(stats().misses).toBe(2);
  resetProtocolCapabilityCache();read(r);expect(stats()).toMatchObject({hits:0,misses:1,entries:1});
 });
 it("bounds retained entries and bytes without retaining sensitive config",()=>{
  for(let i=0;i<800;i++)read({...row(),config_json:JSON.stringify({label:i})});
  expect(stats().entries).toBeLessThanOrEqual(512);expect(stats().bytes).toBeLessThanOrEqual(2*1024*1024);
  resetProtocolCapabilityCache();read({...row(),config_json:'{"api_key":"private","responses_mode":"native"}'});expect(stats().entries).toBe(0);
 });
 it("is immutable and uses no network or storage even across repeated rows",()=>{
  const fetch=vi.spyOn(globalThis,"fetch");const c=read(row());expect(Object.isFrozen(c)).toBe(true);expect(Object.isFrozen(c.supported_endpoints)).toBe(true);
  for(let i=0;i<100;i++)plan(row(),"responses");expect(fetch).not.toHaveBeenCalled();fetch.mockRestore();
 });
 it("scans only designated opaque state positions",()=>{
  expect(hasOpaqueProtocolState({input:[{type:"reasoning",encrypted_content:"x"}]},"responses")).toBe(true);
  expect(hasOpaqueProtocolState({messages:[{role:"assistant",reasoning_details:[{type:"reasoning",encrypted_content:"x"}]}]},"chat/completions")).toBe(true);
  expect(hasOpaqueProtocolState({messages:[{role:"user",content:'{"signature":"text"}'}]},"chat/completions")).toBe(false);
 });
});
