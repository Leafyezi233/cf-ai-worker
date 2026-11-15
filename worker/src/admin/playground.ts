import { Hono } from "hono";
import type { Env, ModelWithProvider } from "../types";
import {
  groupBillingRow,
  openGroupMemberKey,
  recordUsageSafe,
  randomRequestId,
  resolveModelKey,
} from "../db/repo";
import { buildUpstreamHeaders, cleanResponseHeaders } from "../utils/http";
import { applyRequestRewriteRules } from "../gateway/rewrite";
import { parseUsage } from "../gateway/usage";
import { anthropicThinkingBudget } from "../gateway/reasoning";
import { resolveProviderBase } from "../gateway/endpoints";
import { readEnvSecret } from "../utils/env-secret";
import { readConnectionSet } from "../gateway/protocol_connections";

export const playgroundApp = new Hono<{ Bindings: Env }>();



playgroundApp.post("/chat", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
    system_prompt?: string;
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    reasoning_effort?: string;
  };

  if (!body.model || typeof body.model !== "string") {
    return c.json({ error: "model_required", message: "请选择要测试的模型" }, 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "messages_required", message: "请输入测试对话内容" }, 400);
  }

  const target = await resolveModelKey(c.env, body.model);
  if (target.kind === "none") {
    return c.json({ error: "model_not_found", message: `未找到模型「${body.model}」对应的有效 Provider` }, 404);
  }
  const isGroup = target.kind === "group";
  const firstMember = isGroup ? target.members[0] : null;
  if (isGroup && !firstMember) {
    return c.json(
      { error: "model_unavailable", message: `分组「${body.model}」当前没有可服务的成员` },
      503
    );
  }
  const candidates = isGroup ? target.members : target.candidates;
  if (candidates.some(candidate => readConnectionSet(candidate).explicit)) {
    return c.json({ error: "multi_protocol_test_requires_gateway", message: "显式多协议连接请使用协议探测或网关客户端测试；旧版 Playground 尚不支持选择协议" }, 409);
  }
  const row = isGroup ? await openGroupMemberKey(c.env, firstMember!) : target.candidates[0];
  const billingRow = isGroup ? groupBillingRow(target.group!, row.provider_type) : row;

  const isStream = Boolean(body.stream);
  const startedAt = Date.now();
  const requestId = randomRequestId();

  let targetUrl: string;
  let reqPayload: any;

  if (row.provider_type === "anthropic") {
    targetUrl = resolveProviderBase(row.provider_endpoint, "anthropic") + "/messages";
    reqPayload = {
      model: row.model_name,
      messages: body.messages.filter((m) => m.role !== "system"),
      max_tokens: body.max_tokens || 4096,
      stream: isStream,
    };
    if (body.system_prompt || body.messages.find((m) => m.role === "system")) {
      reqPayload.system = body.system_prompt || body.messages.find((m) => m.role === "system")?.content;
    }
    const requestedMax = Number(reqPayload.max_tokens) || 4096;
    const thinkingBudget =
      typeof body.reasoning_effort === "string" && body.reasoning_effort.trim()
        ? anthropicThinkingBudget(body.reasoning_effort.trim(), requestedMax)
        : null;
    if (thinkingBudget !== null) {
      reqPayload.thinking = { type: "enabled", budget_tokens: thinkingBudget };
    } else if (typeof body.temperature === "number") {
      reqPayload.temperature = body.temperature;
    }
  } else {
    targetUrl = resolveProviderBase(row.provider_endpoint, row.provider_type) + "/chat/completions";
    const messages = [...body.messages];
    if (body.system_prompt && !messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: body.system_prompt });
    }
    reqPayload = {
      model: row.model_name,
      messages,
      stream: isStream,
    };
    if (typeof body.temperature === "number") reqPayload.temperature = body.temperature;
    if (typeof body.max_tokens === "number") reqPayload.max_tokens = body.max_tokens;
    if (typeof body.reasoning_effort === "string" && body.reasoning_effort.trim()) {
      reqPayload.reasoning_effort = body.reasoning_effort.trim();
    }
  }

  const { parseRewriteRules } = await import("../gateway/rewrite");
  const rules = parseRewriteRules(billingRow.config_json);
  reqPayload = applyRequestRewriteRules(reqPayload, rules, row.provider_type);

  const apiKey = row.provider_api_key || readEnvSecret(c.env as Record<string, unknown>, row.provider_secret_name) || "";
  const headers = buildUpstreamHeaders(c.req.raw.headers, row.provider_type, apiKey as string);

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(reqPayload),
      redirect: "follow",
    });

    const latencyMs = Date.now() - startedAt;

    if (isStream && upstreamRes.ok && upstreamRes.body) {
      const outHeaders = cleanResponseHeaders(upstreamRes.headers);
      outHeaders.set("X-Gateway-Latency-Ms", String(latencyMs));
      outHeaders.set("X-Gateway-Provider", row.provider_name);
      return new Response(upstreamRes.body, { status: 200, headers: outHeaders });
    }

    const respText = await upstreamRes.text();
    let jsonBody: any = null;
    try {
      jsonBody = JSON.parse(respText);
    } catch {}

    const usage = parseUsage(row.provider_type, respText);

    return c.json({
      ok: upstreamRes.ok,
      status: upstreamRes.status,
      latency_ms: latencyMs,
      provider_name: row.provider_name,
      provider_type: row.provider_type,
      target_model: row.model_name,
      billing_model: billingRow.model_name,
      is_group: isGroup,
      usage,
      data: jsonBody || respText,
    });
  } catch (err: any) {
    return c.json(
      {
        ok: false,
        error: "upstream_fetch_error",
        message: err.message || "请求上游服务商失败",
        latency_ms: Date.now() - startedAt,
      },
      502
    );
  }
});
