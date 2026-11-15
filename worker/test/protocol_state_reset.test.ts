import { describe, expect, it } from "vitest";
import { dropOpaqueProtocolState } from "../src/gateway/protocol_state_reset";
import { hasOpaqueProtocolState } from "../src/gateway/protocol_capabilities";
import { addGatewayCorsHeaders, cleanResponseHeaders } from "../src/utils/http";
import { gatewayApp } from "../src/gateway";

const signed = { type: "thinking", thinking: "secret", signature: "sig" };
const encrypted = { type: "reasoning", encrypted_content: "cipher", id: "rs" };
function freeze(value: any): any {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
describe("bounded opaque-state reset", () => {
  it("preserves Messages tools, results, media, cache controls and structured output without mutation", () => {
    const tool = { type: "tool_use", id: "c1", name: "f", input: { signature: "argument-not-state", nested: encrypted } };
    const result = { type: "tool_result", tool_use_id: "c1", content: JSON.stringify(encrypted) };
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const text = { type: "text", text: "answer", cache_control: { type: "ephemeral" } };
    const body = freeze({ model: "m", system: [text], thinking: { type: "adaptive" }, reasoning_effort: "high",
      output_config: { effort: "high", format: { type: "json_schema", schema: { type: "object" } } },
      messages: [{ role: "user", content: [image] }, { role: "assistant", content: [signed, { type: "redacted_thinking", data: "redacted" }, text, tool] }, { role: "user", content: [result] }] });
    const before = JSON.stringify(body);
    const clean = dropOpaqueProtocolState(body, "messages");
    expect(clean.messages).toEqual([{ role: "user", content: [image] }, { role: "assistant", content: [text, tool] }, { role: "user", content: [result] }]);
    expect(clean.messages[1].content[1]).toBe(tool);
    expect(clean.messages[2].content[0]).toBe(result);
    expect(clean.system).toBe(body.system);
    expect(clean.thinking).toEqual({ type: "disabled" });
    expect(clean).not.toHaveProperty("reasoning_effort");
    expect(clean.output_config).toEqual({ format: body.output_config.format });
    expect(hasOpaqueProtocolState(clean, "messages")).toBe(false);
    expect(JSON.stringify(body)).toBe(before);
  });
  it("keeps functional content carrying state fields and never traverses its payload", () => {
    const tool = { type: "tool_use", id: "c1", name: "f", input: { signature: "payload" }, signature: "state" };
    const body = { messages: [{ role: "assistant", content: [signed, tool, { type: "text", text: "keep", encrypted_content: "cipher" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }] }] };
    expect(dropOpaqueProtocolState(body, "messages").messages).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: tool.input }, { type: "text", text: "keep" }] }, body.messages[1],
    ]);
  });
  it("preserves Responses function calls/results and removes whole reasoning items", () => {
    const call = { type: "function_call", call_id: "c1", name: "f", arguments: '{"signature":"keep"}' };
    const result = { type: "function_call_output", call_id: "c1", output: "cipher" };
    const body = freeze({ input: [encrypted, { type: "reasoning", summary: [{ type: "summary_text", text: "old thought" }] }, call, result, { role: "user", content: "continue" }] });
    expect(dropOpaqueProtocolState(body, "responses").input).toEqual([call, result, { role: "user", content: "continue" }]);
  });
  it("preserves Chat tool-only messages and removes orphaned state-only messages", () => {
    const call = { id: "c1", type: "function", function: { name: "f", arguments: "{}" } };
    const body = freeze({ messages: [{ role: "assistant", content: null, reasoning_details: [encrypted] },
      { role: "assistant", content: null, tool_calls: [call], reasoning_content: "companion", reasoning_details: [encrypted] },
      { role: "tool", tool_call_id: "c1", content: "done" }, { role: "user", content: "continue" }] });
    expect(dropOpaqueProtocolState(body, "chat/completions").messages).toEqual([
      { role: "assistant", content: null, tool_calls: [call] }, body.messages[2], body.messages[3],
    ]);
  });
  it("keeps legacy Chat function calls and empty function results while dropping state", () => {
    const call = { name: "f", arguments: "{}" };
    const body = freeze({ messages: [
      { role: "assistant", content: null, function_call: call, reasoning_details: [encrypted] },
      { role: "function", name: "f", content: "", signature: "state" },
    ] });
    expect(dropOpaqueProtocolState(body, "chat/completions").messages).toEqual([
      { role: "assistant", content: null, function_call: call },
      { role: "function", name: "f", content: "" },
    ]);
  });
  it("does not fabricate conversation when all state was removed", () => {
    expect(dropOpaqueProtocolState({ input: [encrypted] }, "responses").input).toEqual([]);
    expect(dropOpaqueProtocolState({ messages: [{ role: "assistant", content: [signed] }] }, "messages").messages).toEqual([]);
  });
  it("exposes reset and affinity receipts through the actual gateway middleware", async () => {
    const response = await gatewayApp.request("http://gw.test/messages", { method: "OPTIONS" }, {} as never);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-expose-headers")).toContain("X-Cpg-State-Reset");
    expect(response.headers.get("access-control-expose-headers")).toContain("X-Cpg-Affinity");
  });
  it("exposes gateway-minted reset notices but strips upstream spoofing", () => {
    expect(cleanResponseHeaders(new Headers({ "x-cpg-state-reset": "fake" })).has("x-cpg-state-reset")).toBe(false);
    const headers = new Headers(); addGatewayCorsHeaders(headers);
    expect(headers.get("access-control-expose-headers")).toContain("X-Cpg-State-Reset");
  });
});
