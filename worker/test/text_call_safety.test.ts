import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import { recoverBillingRequests } from "../src/db/request_billing";
import { CollectingExecutionContext, chatBody, createRealD1, holdRows, ledgerRows, makeEnv, openAiAnswer, openAiStreamFrames, postJson, seedDevice, seedGroup, seedGroupMembers, seedModel, seedProvider, sseAnswer, usageRows, wallet, type RealD1 } from "./helpers/realGatewayEnv";
let db: RealD1;
let env: ReturnType<typeof makeEnv>;
beforeEach(async () => {
 resetRateLimitMemory();clearMemoryCacheForTest();db=createRealD1();env=makeEnv(db);
 await seedDevice(db,{balance_usd:10});seedProvider(db);seedModel(db,{model_name:"call-text",billing_unit:"call",price_per_call:0.25,cache_enabled:1,config_json:JSON.stringify({model_type:"text"})});
});
afterEach(()=>{vi.restoreAllMocks();db.close();});
async function request(path="/chat/completions",body:unknown=chatBody("call-text")){
 const exec=new CollectingExecutionContext();const res=await postJson(env,path,body,exec);const text=await res.text();await Promise.all(exec.pending);return {res,text};
}
function settled(cost:number){expect(wallet(db)?.balance_usd).toBeCloseTo(10-cost,8);expect(wallet(db)?.reserved_usd).toBeCloseTo(0,8);expect(holdRows(db)).toHaveLength(0);expect(usageRows(db)).toHaveLength(1);expect(usageRows(db)[0].cost_usd).toBeCloseTo(cost,8);}
async function unresolvedCall(){
 expect(wallet(db)?.balance_usd).toBe(10);expect(wallet(db)?.reserved_usd).toBe(.25);
 const state=db.row<any>("SELECT * FROM billing_requests");expect(state.billing_state).toBe("needs_reconciliation");expect(state.known_cost_usd).toBeNull();
 expect(usageRows(db)).toEqual([]);expect(ledgerRows(db)).toEqual([]);
 db.sql("UPDATE billing_requests SET lease_until=0");await recoverBillingRequests(env);await recoverBillingRequests(env);
 expect(holdRows(db)).toEqual([]);expect(wallet(db)?.balance_usd).toBe(10);expect(usageRows(db)).toEqual([]);
}
describe("text-call billing safety",()=>{
 it("charges one base fee independent of token volume and disables cache",async()=>{
  const fetcher=vi.spyOn(globalThis,"fetch").mockImplementation(async()=>openAiAnswer());
  for(let i=0;i<2;i++) expect((await request()).res.status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(2);expect(wallet(db)?.balance_usd).toBeCloseTo(9.5,8);expect(ledgerRows(db).filter(x=>x.reason==="usage")).toHaveLength(2);expect(holdRows(db)).toHaveLength(0);
 });
 it("charges a completed stream without usage",async()=>{
  const frames=openAiStreamFrames();frames[1]="data: "+JSON.stringify({choices:[{delta:{},finish_reason:"stop"}]})+"\n\n";
  vi.spyOn(globalThis,"fetch").mockResolvedValue(sseAnswer(frames));await request("/chat/completions",chatBody("call-text",{stream:true}));settled(.25);
 });
 it("does not charge a truncated stream",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(sseAnswer(openAiStreamFrames().slice(0,1)));await request("/chat/completions",chatBody("call-text",{stream:true}));await unresolvedCall();
 });
 it("retains an error before a long tail and does not charge",async()=>{
  const frames=['data: {"error":{"message":"failure"}}\n\n'];
  for(let i=0;i<100;i++)frames.push('data: '+JSON.stringify({choices:[{delta:{content:"x".repeat(1000)}}]})+'\n\n');
  frames.push('data: [DONE]\n\n');vi.spyOn(globalThis,"fetch").mockResolvedValue(sseAnswer(frames));await request("/chat/completions",chatBody("call-text",{stream:true}));settled(0);
 });
 it("does not charge a successful HTTP body without a completed answer",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({choices:[],usage:{prompt_tokens:1000,completion_tokens:1000}}));await request();await unresolvedCall();
 });
 it("does not charge incomplete Chat output bridged to Responses",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({choices:[{message:{role:"assistant",content:"partial"},finish_reason:null}]}));await request("/responses",{model:"call-text",input:"hi"});await unresolvedCall();
 });
 it("uses the text group's fixed price even with a token-priced member",async()=>{
  db.sql("UPDATE models SET billing_unit='token' WHERE id='model_a'");
  seedGroup(db,{name:"text-group",billing_unit:"call",price_per_call:.4,config_json:JSON.stringify({model_type:"text"})});seedGroupMembers(db,"grp_a",["model_a"]);
  vi.spyOn(globalThis,"fetch").mockImplementation(async()=>openAiAnswer());await request("/chat/completions",chatBody("text-group"));settled(.4);
 });
 it("does not call an image member from a text group",async()=>{
  db.sql("UPDATE models SET config_json=NULL WHERE id='model_a'");
  seedGroup(db,{name:"text-group",billing_unit:"call",price_per_call:.4,config_json:JSON.stringify({model_type:"text"})});seedGroupMembers(db,"grp_a",["model_a"]);
  const fetcher=vi.spyOn(globalThis,"fetch");const {res}=await request("/chat/completions",chatBody("text-group"));expect(res.status).toBe(400);expect(fetcher).not.toHaveBeenCalled();expect(wallet(db)?.balance_usd).toBe(10);expect(holdRows(db)).toHaveLength(0);
 });
 it("does not retry or fail over a rejected call",async()=>{
  seedProvider(db,{id:"p2"});seedModel(db,{id:"m2",provider_id:"p2",model_name:"call-text",billing_unit:"call",price_per_call:.25,config_json:JSON.stringify({model_type:"text"})});
  const fetcher=vi.spyOn(globalThis,"fetch").mockImplementation(async()=>Response.json({error:{message:"busy"}},{status:503}));await request();expect(fetcher).toHaveBeenCalledTimes(1);expect(wallet(db)?.balance_usd).toBe(10);expect(holdRows(db)).toHaveLength(0);
 });
});

describe("native text-call protocols",()=>{
 it.each([false,true])("bills completed native Responses once (stream=%s)",async stream=>{
  db.sql("UPDATE models SET config_json=? WHERE id='model_a'",JSON.stringify({model_type:"text",responses_mode:"native"}));
  const obj={id:"resp_test",object:"response",status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"ok"}]}],usage:{input_tokens:1000,output_tokens:200}};
  vi.spyOn(globalThis,"fetch").mockResolvedValue(stream?sseAnswer(['event: response.completed\ndata: '+JSON.stringify({type:"response.completed",response:obj})+'\n\n']):Response.json(obj));
  expect((await request("/responses",{model:"call-text",input:"hi",stream})).res.status).toBe(200);settled(.25);
 });
 it("does not bill failed native Responses",async()=>{
  db.sql("UPDATE models SET config_json=? WHERE id='model_a'",JSON.stringify({model_type:"text",responses_mode:"native"}));
  vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({object:"response",status:"failed",output:[],usage:{input_tokens:1000,output_tokens:2},error:{message:"failed"}}));
  expect((await request("/responses",{model:"call-text",input:"hi"})).res.status).toBe(502);settled(0);
 });
 it.each([false,true])("bills native Messages once (stream=%s)",async stream=>{
  db.sql("UPDATE providers SET type='anthropic' WHERE id='prov_a'");
  const obj={id:"msg_test",type:"message",role:"assistant",content:[{type:"text",text:"ok"}],stop_reason:"end_turn",usage:{input_tokens:1000,output_tokens:200}};
  vi.spyOn(globalThis,"fetch").mockResolvedValue(stream?sseAnswer(['event: message_start\ndata: '+JSON.stringify({type:"message_start",message:obj})+'\n\n','event: message_stop\ndata: {"type":"message_stop"}\n\n']):Response.json(obj));
  expect((await request("/messages",{model:"call-text",messages:[{role:"user",content:"hi"}],max_tokens:8,stream})).res.status).toBe(200);settled(.25);
 });
 it("allows explicitly free text calls without charging",async()=>{
  db.sql("UPDATE models SET pricing_mode='free',price_per_call=0 WHERE id='model_a'");vi.spyOn(globalThis,"fetch").mockImplementation(async()=>openAiAnswer());await request();settled(0);
 });
});
