import { describe, expect, it } from "vitest";
import {
  anthropicThinkingBudget,
  applyReasoningEffort,
  degradeGroupReasoningEffort,
  dropReasoningEffort,
  dropUnsupportedReasoningEffort,
  isReasoningModel,
  resolveGroupReasoningSupport,
  resolveReasoningSupport,
  REASONING_LEVELS,
} from "../src/gateway/reasoning";

const cfg = (obj: Record<string, unknown>) => JSON.stringify(obj);

describe("resolveReasoningSupport", () => {
  it("reads a probe result before anything else", () => {
    const yes = resolveReasoningSupport({
      model_name: "codebuddy_gpt-5",
      config_json: cfg({ probe: { reasoning_supported: true }, capabilities: [] }),
      provider_type: "openai",
    });
    expect(yes.supported).toBe(true);
    expect(yes.source).toBe("probe");
    expect(yes.levels).toEqual(REASONING_LEVELS);

    const no = resolveReasoningSupport({
      model_name: "deepseek-r1",
      config_json: cfg({ probe: { reasoning_supported: false }, capabilities: ["reasoning"] }),
      provider_type: "anthropic",
    });
    expect(no.supported).toBe(false);
    expect(no.levels).toEqual([]);
    expect(no.source).toBe("probe");
  });

  it("takes an explicit ladder, including bare effort strings", () => {
    const res = resolveReasoningSupport({
      model_name: "some-relay-id",
      config_json: cfg({ supported_reasoning_levels: ["low", "high"] }),
      provider_type: "openai",
    });
    expect(res.supported).toBe(true);
    expect(res.levels.map((l) => l.effort)).toEqual(["low", "high"]);
    expect(res.levels[0].description).toBe(REASONING_LEVELS[0].description);
    expect(res.default_level).toBe("low");
    expect(res.source).toBe("config_levels");
  });

  it("lets an explicit false override the capability tick", () => {
    const res = resolveReasoningSupport({
      model_name: "gpt-4o",
      config_json: cfg({ supports_reasoning: false, capabilities: ["reasoning"] }),
      provider_type: "openai",
    });
    expect(res.supported).toBe(false);
    expect(res.source).toBe("config_off");
  });

  it("trusts the admin capability tick for a model whose name says nothing", () => {
    const res = resolveReasoningSupport({
      model_name: "codebuddy_glm-5.2",
      config_json: cfg({ capabilities: ["tool_call", "reasoning"] }),
      provider_type: "openai",
    });
    expect(res.supported).toBe(true);
    expect(res.default_level).toBe("medium");
    expect(res.source).toBe("capability");
  });

  it("falls back to the name, then to the provider", () => {
    expect(resolveReasoningSupport({ model_name: "deepseek-r1" }).source).toBe("model_name");
    expect(resolveReasoningSupport({ model_name: "x", alias: "qwq-32b" }).source).toBe("model_name");
    expect(resolveReasoningSupport({ model_name: "claude-sonnet-4.6", provider_type: "anthropic" }).source).toBe(
      "provider"
    );
  });

  it("says no for a plain model on a non-Anthropic provider", () => {
    const res = resolveReasoningSupport({ model_name: "gpt-4o", provider_type: "openai" });
    expect(res.supported).toBe(false);
    expect(res.levels).toEqual([]);
    expect(res.default_level).toBeNull();
    expect(res.source).toBe("none");
  });

  it("ignores a probe taken against a different provider", () => {
    const stale = cfg({ probe: { reasoning_supported: false, provider_type: "openai" } });
    const moved = resolveReasoningSupport({ model_name: "claude-x", config_json: stale, provider_type: "anthropic" });
    expect(moved.source).toBe("provider");
    expect(moved.supported).toBe(true);

    const same = resolveReasoningSupport({ model_name: "claude-x", config_json: stale, provider_type: "openai" });
    expect(same.source).toBe("probe");
    expect(same.supported).toBe(false);
  });

  it("survives malformed config_json", () => {
    const res = resolveReasoningSupport({ model_name: "gpt-4o", config_json: "{not json" });
    expect(res.supported).toBe(false);
  });
});

describe("anthropicThinkingBudget", () => {
  it("scales with max_tokens and clamps to the documented floor", () => {
    expect(anthropicThinkingBudget("medium", 4096)).toBe(2048);
    expect(anthropicThinkingBudget("high", 4096)).toBe(3276);
    expect(anthropicThinkingBudget("low", 4096)).toBe(1024);
  });

  it("never lets the budget reach max_tokens", () => {
    expect(anthropicThinkingBudget("xhigh", 1000)).toBeNull();
    const budget = anthropicThinkingBudget("xhigh", 2000);
    expect(budget).not.toBeNull();
    expect(budget!).toBeLessThan(2000);
  });

  it("returns null for an unknown level or a non-finite limit", () => {
    expect(anthropicThinkingBudget("ultra", 4096)).toBeNull();
    expect(anthropicThinkingBudget("high", NaN)).toBeNull();
  });
});

describe("applyReasoningEffort", () => {
  it("translates effort into a thinking block on the native messages endpoint", () => {
    const body: Record<string, any> = { model: "claude", max_tokens: 4096, reasoning_effort: "medium", temperature: 0.7 };
    const res = applyReasoningEffort(body, "anthropic", "messages");
    expect(res.applied).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect("temperature" in body).toBe(false);
    expect("reasoning_effort" in body).toBe(false);
  });

  it("leaves OpenAI-compatible providers alone", () => {
    const body: Record<string, any> = { model: "o3", reasoning_effort: "high" };
    const res = applyReasoningEffort(body, "openai", "chat/completions");
    expect(res.applied).toBe(false);
    expect(body.reasoning_effort).toBe("high");
    expect("thinking" in body).toBe(false);
  });

  it("raises max_tokens instead of dropping an effort that cannot fit", () => {
    const body: Record<string, any> = { model: "claude", max_tokens: 512, reasoning_effort: "high" };
    const res = applyReasoningEffort(body, "anthropic", "messages");
    expect(res.applied).toBe(true);
    expect(res.dropped).toBeUndefined();
    expect(res.raisedMaxTokens).toBe(1025);
    expect(body.max_tokens).toBe(1025);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect("reasoning_effort" in body).toBe(false);
  });

  it("leaves a missing max_tokens alone, because upstream requires the field anyway", () => {
    const body: Record<string, any> = { model: "claude", reasoning_effort: "low" };
    const res = applyReasoningEffort(body, "anthropic", "messages");
    expect(res.applied).toBe(false);
    expect(res.dropped).toBe(true);
    expect(res.reason).toBe("missing_max_tokens");
    expect("max_tokens" in body).toBe(false);
    expect("thinking" in body).toBe(false);
  });

  it("drops an effort name it does not recognise without touching max_tokens", () => {
    const body: Record<string, any> = { model: "claude", max_tokens: 512, reasoning_effort: "ultra" };
    const res = applyReasoningEffort(body, "anthropic", "messages");
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("unknown_effort");
    expect(body.max_tokens).toBe(512);
  });

  it("does nothing when no effort was asked for", () => {
    const body: Record<string, any> = { model: "claude", max_tokens: 4096 };
    const res = applyReasoningEffort(body, "anthropic", "messages");
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("no_effort");
    expect("thinking" in body).toBe(false);
  });

  it("honours a client that already speaks the native shape", () => {
    const body: Record<string, any> = {
      model: "claude",
      max_tokens: 4096,
      reasoning_effort: "high",
      thinking: { type: "enabled", budget_tokens: 3000 },
    };
    const res = applyReasoningEffort(body, "anthropic", "messages");
    expect(res.applied).toBe(true);
    expect(res.reason).toBe("client_thinking");
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 3000 });
  });
});

describe("isReasoningModel", () => {
  it("still recognises the legacy name families", () => {
    expect(isReasoningModel("deepseek-r1")).toBe(true);
    expect(isReasoningModel("claude-4-opus")).toBe(true);
    expect(isReasoningModel("gpt-4o")).toBe(false);
    expect(isReasoningModel("codebuddy_gpt-5")).toBe(false);
  });
});

describe("dropReasoningEffort", () => {
  it("removes every spelling of effort and reports that it did", () => {
    const body: Record<string, any> = {
      model: "x",
      reasoning_effort: "high",
      reasoning: { effort: "high", summary: "auto" },
      output_config: { effort: "high" },
      thinking: { type: "enabled", budget_tokens: 4096 },
    };
    expect(dropReasoningEffort(body)).toBe(true);
    expect("reasoning_effort" in body).toBe(false);
    expect("thinking" in body).toBe(false);
    expect(body.reasoning).toEqual({ summary: "auto" });
    expect("output_config" in body).toBe(false);
  });

  it("leaves a body without any effort alone", () => {
    const body: Record<string, any> = { model: "x", messages: [] };
    expect(dropReasoningEffort(body)).toBe(false);
    expect(body).toEqual({ model: "x", messages: [] });
  });
});

describe("dropUnsupportedReasoningEffort", () => {
  it("keeps the effort for a model the ladder says can reason", () => {
    const body: Record<string, any> = { reasoning_effort: "high" };
    const changed = dropUnsupportedReasoningEffort(body, {
      model_name: "mystery-relay-id",
      config_json: cfg({ capabilities: ["reasoning"] }),
    });
    expect(changed).toBe(false);
    expect(body.reasoning_effort).toBe("high");
  });

  it("drops the effort for a model the ladder cannot vouch for", () => {
    const body: Record<string, any> = { reasoning_effort: "high" };
    const changed = dropUnsupportedReasoningEffort(body, {
      model_name: "mystery-relay-id",
      config_json: null,
    });
    expect(changed).toBe(true);
    expect("reasoning_effort" in body).toBe(false);
  });

  it("honours an explicit negative answer from the probe", () => {
    const body: Record<string, any> = { reasoning_effort: "low" };
    const changed = dropUnsupportedReasoningEffort(body, {
      model_name: "claude-4-sonnet",
      config_json: cfg({ probe: { reasoning_supported: false, provider_type: "anthropic" } }),
      provider_type: "anthropic",
    });
    expect(changed).toBe(true);
    expect("reasoning_effort" in body).toBe(false);
  });
});

describe("resolveGroupReasoningSupport", () => {
  it("gives a group with no configuration the five default rungs", () => {
    const support = resolveGroupReasoningSupport(null);
    expect(support.supported).toBe(true);
    expect(support.levels.map((l) => l.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(support.default_level).toBe("medium");
    expect(support.source).toBe("group_default");
  });

  it("honours an explicit ladder and its default", () => {
    const support = resolveGroupReasoningSupport(
      cfg({ supported_reasoning_levels: ["low", "high"], default_reasoning_level: "high" })
    );
    expect(support.supported).toBe(true);
    expect(support.levels.map((l) => l.effort)).toEqual(["low", "high"]);
    expect(support.default_level).toBe("high");
    expect(support.source).toBe("group_levels");
  });

  it("falls back to the first rung when a ladder names no default", () => {
    const support = resolveGroupReasoningSupport(cfg({ supported_reasoning_levels: ["high", "max"] }));
    expect(support.default_level).toBe("high");
  });

  it("lets supports_reasoning false veto the whole group, ladder included", () => {
    const support = resolveGroupReasoningSupport(
      cfg({ supports_reasoning: false, supported_reasoning_levels: ["low", "high"] })
    );
    expect(support.supported).toBe(false);
    expect(support.levels).toEqual([]);
    expect(support.default_level).toBeNull();
    expect(support.source).toBe("config_off");
  });

  it("treats unparseable config as no configuration at all", () => {
    const support = resolveGroupReasoningSupport("{not json");
    expect(support.supported).toBe(true);
    expect(support.source).toBe("group_default");
  });
});

describe("degradeGroupReasoningEffort", () => {
  const group = resolveGroupReasoningSupport(null);

  it("changes nothing when the caller named no effort", () => {
    const body: Record<string, any> = { model: "g" };
    const outcome = degradeGroupReasoningEffort(body, group, { model_name: "claude-4-sonnet" });
    expect(outcome).toEqual({ changed: false, level: null, reason: "no_effort" });
    expect(body).toEqual({ model: "g" });
  });

  it("keeps an effort both ladders carry", () => {
    const body: Record<string, any> = { reasoning_effort: "high" };
    const outcome = degradeGroupReasoningEffort(body, group, {
      model_name: "claude-4-sonnet",
      provider_type: "anthropic",
    });
    expect(outcome).toEqual({ changed: false, level: "high", reason: "kept" });
    expect(body.reasoning_effort).toBe("high");
  });

  it("rewrites to the member's second-highest rung when the member ladder is shorter", () => {
    const body: Record<string, any> = { reasoning_effort: "xhigh" };
    const outcome = degradeGroupReasoningEffort(body, group, {
      model_name: "mystery-relay-id",
      config_json: cfg({ supported_reasoning_levels: ["low", "medium", "high"] }),
    });
    expect(outcome).toEqual({ changed: true, level: "medium", reason: "rewritten" });
    expect(body.reasoning_effort).toBe("medium");
  });

  it("rewrites every spelling of the level at once", () => {
    const body: Record<string, any> = {
      reasoning_effort: "xhigh",
      reasoning: { effort: "xhigh", summary: "auto" },
      output_config: { effort: "xhigh", verbosity: "low" },
    };
    degradeGroupReasoningEffort(body, group, {
      model_name: "mystery-relay-id",
      config_json: cfg({ supported_reasoning_levels: ["low", "high"] }),
    });
    expect(body.reasoning_effort).toBe("low");
    expect(body.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(body.output_config).toEqual({ effort: "low", verbosity: "low" });
  });

  it("treats a rung outside the group ladder as unhonourable even when the member accepts it", () => {
    const narrow = resolveGroupReasoningSupport(cfg({ supported_reasoning_levels: ["low", "medium"] }));
    const body: Record<string, any> = { reasoning_effort: "max" };
    const outcome = degradeGroupReasoningEffort(body, narrow, {
      model_name: "mystery-relay-id",
      config_json: cfg({ supported_reasoning_levels: ["low", "medium", "high", "max"] }),
    });
    expect(outcome.reason).toBe("rewritten");
    expect(body.reasoning_effort).toBe("high");
  });

  it("honours max now that the default ladder carries it", () => {
    const body: Record<string, any> = { reasoning_effort: "max" };
    const outcome = degradeGroupReasoningEffort(body, group, {
      model_name: "claude-4-sonnet",
      provider_type: "anthropic",
    });
    expect(outcome).toEqual({ changed: false, level: "max", reason: "kept" });
    expect(body.reasoning_effort).toBe("max");
  });

  it("degrades to xhigh rather than high, because the default ladder now has five rungs", () => {
    const body: Record<string, any> = { reasoning_effort: "minimal" };
    const outcome = degradeGroupReasoningEffort(body, group, {
      model_name: "claude-4-sonnet",
      provider_type: "anthropic",
    });
    expect(outcome).toEqual({ changed: true, level: "xhigh", reason: "rewritten" });
    expect(body.reasoning_effort).toBe("xhigh");
  });

  it("removes the effort entirely when the member cannot reason", () => {
    const body: Record<string, any> = {
      reasoning_effort: "high",
      reasoning: { effort: "high" },
      output_config: { effort: "high" },
    };
    const outcome = degradeGroupReasoningEffort(body, group, { model_name: "gpt-4o", config_json: null });
    expect(outcome).toEqual({ changed: true, level: null, reason: "member_off" });
    expect("reasoning_effort" in body).toBe(false);
    expect("reasoning" in body).toBe(false);
    expect("output_config" in body).toBe(false);
  });

  it("drops the effort when the group itself vetoes reasoning", () => {
    const off = resolveGroupReasoningSupport(cfg({ supports_reasoning: false }));
    const body: Record<string, any> = { reasoning_effort: "high" };
    const outcome = degradeGroupReasoningEffort(body, off, {
      model_name: "claude-4-sonnet",
      provider_type: "anthropic",
    });
    expect(outcome).toEqual({ changed: true, level: null, reason: "group_off" });
    expect("reasoning_effort" in body).toBe(false);
  });

  it("leaves the body alone when it already asks for the rung it degrades to", () => {
    const body: Record<string, any> = { reasoning_effort: "medium" };
    const outcome = degradeGroupReasoningEffort(body, group, {
      model_name: "mystery-relay-id",
      config_json: cfg({ supported_reasoning_levels: ["low", "medium", "high"] }),
    });
    expect(outcome).toEqual({ changed: false, level: "medium", reason: "kept" });
  });
});
