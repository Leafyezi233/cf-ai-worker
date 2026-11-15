import { describe, expect, it } from "vitest";
import { applyReasoningEffort } from "../src/gateway/reasoning";
import { applyRequestRewriteRules } from "../src/gateway/rewrite";

function nativeBody(thinking: Record<string, unknown> = { type: "adaptive" }) {
  return {
    model: "claude",
    max_tokens: 4096,
    system: Object.freeze([
      Object.freeze({ type: "text", text: "Original policy", cache_control: Object.freeze({ type: "ephemeral", ttl: "1h" }) }),
      Object.freeze({ type: "text", text: "Second policy", cache_control: Object.freeze({ type: "ephemeral" }) }),
    ]),
    thinking: Object.freeze(thinking),
    output_config: Object.freeze({ effort: "max", format: { type: "json_schema", schema: { type: "object" } } }),
    messages: Object.freeze([
      Object.freeze({ role: "assistant", content: Object.freeze([
        Object.freeze({ type: "thinking", thinking: "Native thought", signature: "signed-opaque-data" }),
        Object.freeze({ type: "redacted_thinking", data: "encrypted-opaque-data" }),
        Object.freeze({ type: "text", text: "Answer" }),
      ]) }),
      Object.freeze({ role: "user", content: "Continue" }),
    ]),
  };
}

describe("native Messages request integrity", () => {
  it.each(["prepend", "append"] as const)("%s preserves system blocks, cache controls and signed content", (mode) => {
    const original = nativeBody();
    const snapshot = JSON.stringify(original);
    const rewritten = applyRequestRewriteRules(original, { system_prompt: " Gateway policy ", system_prompt_mode: mode }, "messages");
    const injected = { type: "text", text: "Gateway policy" };
    expect(rewritten.system).toEqual(mode === "append" ? [...original.system, injected] : [injected, ...original.system]);
    const offset = mode === "prepend" ? 1 : 0;
    original.system.forEach((block, index) => expect(rewritten.system[index + offset]).toBe(block));
    expect(rewritten.messages).toBe(original.messages);
    expect(rewritten.thinking).toBe(original.thinking);
    expect(rewritten.output_config).toBe(original.output_config);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("explicit override replaces the system array without mutating it", () => {
    const original = nativeBody();
    const rewritten = applyRequestRewriteRules(original, { system_prompt: "Replacement", system_prompt_mode: "override" }, "messages");
    expect(rewritten.system).toBe("Replacement");
    expect(original.system).toHaveLength(2);
    expect(rewritten.messages).toBe(original.messages);
  });

  it.each(["prepend", "append"] as const)("%s handles empty block arrays and preserves legacy string behavior", (mode) => {
    const rules = { system_prompt: "Gateway", system_prompt_mode: mode };
    expect(applyRequestRewriteRules({ system: [] }, rules, "messages").system).toEqual([{ type: "text", text: "Gateway" }]);
    expect(applyRequestRewriteRules({ system: "Original" }, rules, "messages").system)
      .toBe(mode === "append" ? "Original\n\nGateway" : "Gateway\n\nOriginal");
    expect(applyRequestRewriteRules({}, rules, "messages").system).toBe("Gateway");
  });

  it.each([
    { type: "enabled", budget_tokens: 3000 },
    { type: "adaptive", display: "summarized" },
    { type: "disabled" },
  ])("preserves explicit native thinking $type even with a generic effort", (thinking) => {
    const original = nativeBody(thinking);
    const body = { ...original, reasoning_effort: "high", temperature: 0.7 };
    const result = applyReasoningEffort(body, "anthropic", "messages");
    expect(result.reason).toBe("client_thinking");
    expect(body.thinking).toBe(original.thinking);
    expect(body.output_config).toBe(original.output_config);
    expect(body.messages).toBe(original.messages);
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.7);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("does not reinterpret native output_config effort as a manual thinking budget", () => {
    const original = nativeBody();
    const body = { ...original };
    expect(applyReasoningEffort(body, "anthropic", "messages").reason).toBe("no_effort");
    expect(body).toEqual(original);
  });

  it.each(["reasoning_effort", "reasoning"])("still translates the %s compatibility alias when no native thinking is present", (key) => {
    const reasoning = Object.freeze({ effort: "medium" });
    const body: Record<string, any> = { max_tokens: 4096, temperature: 0.5, [key]: key === "reasoning" ? reasoning : "medium" };
    expect(applyReasoningEffort(body, "anthropic", "messages")).toMatchObject({ applied: true, budget: 2048 });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("temperature");
    expect(reasoning.effort).toBe("medium");
  });

  it("leaves non-Anthropic and non-Messages requests untouched", () => {
    for (const [provider, kind] of [["openai", "messages"], ["anthropic", "chat/completions"]]) {
      const body = { max_tokens: 4096, reasoning_effort: "high" };
      const snapshot = { ...body };
      expect(applyReasoningEffort(body, provider, kind).applied).toBe(false);
      expect(body).toEqual(snapshot);
    }
  });
});
