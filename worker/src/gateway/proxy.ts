import type { Context } from "hono";
import type { DeviceRow, Env, ModelWithProvider, TokenUsage } from "../types";
import { authenticateGateway } from "./auth";
import { tokenScopeAllows } from "../db/token_policies";
import { assertLegacyTokenScope, isAutoServiceSelection, resolveAutoServiceRoutes, resolveServiceRoute, type ServiceRoute } from "./service_groups";
import { waitUntil, completeBilling, GatewayKind, ProxyContext } from "./proxy_context";
import { isImageModel, resolveModelType } from "./model_type";
import { embeddingPoolError, embeddingDimensionsError, embeddingProviderCompatible, validateEmbeddingRequest, MAX_EMBEDDING_REQUEST_BYTES, readBoundedBody, compatibleEmbeddingSpace } from "./embeddings";
import { relayEmbeddingAnswer } from "./embedding_relay";
import { resolveRowPricingMode, resolveRowPeakPricing, resolveRowBillingUnit, chatBodyHasImage, billableSearchCalls, computeCostUsd, estimatePromptTokens, estimateRequestCostUsd } from "./pricing";
import { record, buildBillingSnapshot } from "./usage_record";
import { upstreamIdentityTerms, passthroughStream, watchForStall } from "./stream_relay";
import { relayImageAnswer } from "./image_relay";
import { consumeModelQuota } from "./quota";
import { openModelKey, getModelWithProviderById, checkDeviceRateLimit, recordUsageSafe, randomRequestId, getSetting, getCurrentMonthSpend, getRecentProviderAvgLatencies, getRecentProviderFailureStats, getDeviceMonthlyCost, filterCandidatesForDevice, isModelInScope, getDeviceModelRateLimits, resolveModelKey, openGroupMemberKey, groupBillingRow, getDeviceGroupIds, getDeviceGroupRateLimits, reserveBalance, releaseReserve, chargeBalanceIfAffordable, getWallet, resolvePriceSnapshot } from "../db/repo";
import { sendWebhookNotification } from "../utils/webhook";
import { parseUsage, parseJsonUsage } from "./usage";
import { buildUpstreamHeaders, buildProtocolHeaders, cleanResponseHeaders } from "../utils/http";
import { readEnvSecret } from "../utils/env-secret";
import { routeNeedsLatencies, selectCandidateRoute } from "./routing";
import { parseRewriteRules, applyRequestRewriteRules } from "./rewrite";
import { applyReasoningEffort, degradeGroupReasoningEffort, dropUnsupportedReasoningEffort, resolveGroupReasoningSupport, type ReasoningSupport } from "./reasoning";
import { resolveProviderBase } from "./endpoints";
import type { ChatToResponsesFinishMetadata } from "./responses_adapter";
import { convertResponsesRequest, convertChatToResponsesJson, createChatToResponsesTransform, unsupportedResponsesFields } from "./responses_adapter";
import { computeCacheKey, shouldBypassCache, getCachedEntry, setCachedEntry, createCachedResponse } from "./cache";
import { maskJsonText, modelMaskingTransform, redactUpstreamIdentity } from "./caller_identity";
import { prepareJsonResponse } from "./json_response";
import type { JsonDecodeResult } from "./json_decode";
import { classifyUpstreamFailure, readErrorSnippet, readFailoverPolicy, rememberCooldown, demoteCoolingDown, demoteUnhealthy, isRetryableFailureReason, readGroupMemberRetries } from "./failover";
import { canServeResponses, readResponsesMode, requiresNativeResponses, unsupportedNativeRequestFields } from "./responses_mode";
import { relayNativeResponsesJson, relayNativeResponsesStream } from "./responses_native";
import { planProtocolRoute, readProtocolCapabilities, hasOpaqueProtocolState } from "./protocol_capabilities";
import { convertChatRequestToResponses, convertResponsesToChatJson, createResponsesToChatTransform, unsupportedChatToResponsesFields, validateResponsesChatOutput, createResponsesChatEventValidator } from "./chat_responses_bridge";
import { issueProtocolAffinity, verifyProtocolAffinity, matchProtocolAffinity, type AffinityClaim } from "./protocol_affinity";
import { unsupportedResponsesBridgeFields } from "./protocol_loss";
import { dropOpaqueProtocolState } from "./protocol_state_reset";
import { protocolTargetUrl, protocolUpstreamKey, protocolModelName, usageProviderType, readConnectionSet, resolveProtocolConnection } from "./protocol_connections";

import { admitBillingRequest, abandonUndispatchedBillingRequest, persistBillingTerminal, settleBillingRequest } from "../db/request_billing";
import { manageBillingRequest, managedBillingRequest, BILLING_LEASE_MS } from "./billing_lifecycle";

const protocolState = new WeakMap<object, { claim: AffinityClaim | null; opaque: boolean; reset: boolean; modelKey: string; selection: string }>();

export { splitPromptTokens, computeCostUsd, estimatePromptTokens, estimateSearchCalls, estimateRequestCostUsd, resolveRowBillingUnit } from "./pricing";
export { extractTextFromSse, appendCapped, UPSTREAM_FIRST_CHUNK_TIMEOUT_MS, UPSTREAM_STREAM_STALL_TIMEOUT_MS } from "./stream_relay";
export type { GatewayKind } from "./proxy_context";
export { listModelsHandler, getModelHandler, listOllamaTagsHandler } from "./models_endpoints";
export { MAX_RESERVED_SEARCHES } from "./pricing";
export const MAX_IMAGES_PER_REQUEST = 4;

function buildTargetUrl(row: ModelWithProvider, kind: GatewayKind): string {
  if (kind === "messages" || kind === "responses" || kind === "chat/completions") return protocolTargetUrl(row, kind) || "";
  const base = resolveProviderBase(row.provider_endpoint, row.provider_type);
  const suffix = kind === "images/generations" ? "/images/generations" : "/embeddings";
  return base + suffix;
}

export const TRUSTED_BALANCE_MULTIPLIER = 15;

export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

const RAW_BODY_REUSE_MIN_UNITS = 256 * 1024;

export const UPSTREAM_FETCH_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_PROXY_ATTEMPTS = 8;
export const PROXY_ATTEMPT_BUDGET_MS = UPSTREAM_FETCH_TIMEOUT_MS;
interface ProxyAttemptBudget { attempts: number; deadline: number }
function newAttemptBudget(): ProxyAttemptBudget { return { attempts: 0, deadline: Date.now() + PROXY_ATTEMPT_BUDGET_MS }; }
function attemptBudgetAvailable(budget: ProxyAttemptBudget): boolean {
  return budget.attempts < MAX_PROXY_ATTEMPTS && Date.now() < budget.deadline;
}

async function shouldFailoverAfterFailure(
  row: ModelWithProvider,
  upstreamRes: Response,
  canFailover: boolean,
  requestId: string,
  failure?: { reason?: string },
  retryableOnly = false
): Promise<boolean> {
  const status = upstreamRes.status;
  const policy = readFailoverPolicy(row.config_json);
  const textCanDecide =
    policy.failoverOnClientError && (status === 400 || status === 422 || status === 405 || status === 415);
  const snippet = textCanDecide ? await readErrorSnippet(upstreamRes) : "";
  const verdict = classifyUpstreamFailure(status, snippet, policy.failoverOnClientError);
  if (verdict.cooldownMs) rememberCooldown(row.provider_id, verdict.cooldownMs);
  if (failure) failure.reason = verdict.reason;
  if (!verdict.failover) return false;
  if (retryableOnly && !isRetryableFailureReason(verdict.reason)) canFailover = false;
  const relayable = status < 500 && status !== 408 && status !== 429 && status !== 401 && status !== 403;
  if (!canFailover && relayable) {
    console.warn(
      `gateway: ${status} ${verdict.reason} from provider ${row.provider_id}; no candidate is left, relaying it (request ${requestId})`
    );
    return false;
  }
  const outcome = canFailover ? "trying the next candidate" : "no candidate is left";
  console.warn(
    `gateway: ${status} ${verdict.reason} from provider ${row.provider_id}; ${outcome} (request ${requestId})`
  );
  return true;
}
async function executeProxyAttempt(
  c: Context<{ Bindings: Env }>,
  kind: GatewayKind,
  device: DeviceRow,
  row: ModelWithProvider,
  body: any,
  requestId: string,
  cacheKey?: string,
  reservedUsd?: number,
  snapshot?: { multiplier: number; window_id: string | null; serviceGroupId?: string; serviceGroupRevision?: number; pricingSnapshotJson?: string },
  identity?: { billing: ModelWithProvider; visible: string },
  upstreamModelName?: string,
  dropUnsupportedReasoning?: boolean,
  groupReasoning?: ReasoningSupport,
  canFailover?: boolean,
  rawBytes?: number,
  rawBody?: string,
  failure?: { reason?: string },
  retryableOnly = false,
  attemptBudget?: ProxyAttemptBudget
): Promise<Response | null> {
  if (attemptBudget) {
    if (!attemptBudgetAvailable(attemptBudget) || c.req.raw.signal.aborted) {
      if (failure) failure.reason = "attempt_budget_exhausted";
      return null;
    }
    attemptBudget.attempts++;
  }
  const visibleModel = identity?.visible ?? row.model_name;
  const billingRow = identity?.billing ?? row;
  const plannedPath = kind === "embeddings" ? (embeddingProviderCompatible(row) ? "embeddings" : null) : isImageModel(row) ? kind : kind === "responses" || kind === "chat/completions" || kind === "messages" ? planProtocolRoute(row, kind, kind === "responses" && requiresNativeResponses(body)) : kind;
  if (!plannedPath) return null;
  const tokenProtocol = plannedPath === "messages" || plannedPath === "responses" || plannedPath === "chat/completions";
  const upstreamKey = tokenProtocol ? protocolUpstreamKey(row, plannedPath, c.env as Record<string, unknown>) : row.provider_api_key || readEnvSecret(c.env as Record<string, unknown>, row.provider_secret_name);
  if (typeof upstreamKey !== "string" || !upstreamKey) {
    if (failure) failure.reason = "credential_unavailable";
    return null;
  }
  const state = protocolState.get(c);
  const ownRewrite = parseRewriteRules(row.config_json).model_rewrite;
  const sentModel = upstreamModelName || ownRewrite || (tokenProtocol ? protocolModelName(row, plannedPath) : row.model_name);
  const connection = tokenProtocol ? resolveProtocolConnection(row, plannedPath) : null;
  const wireIdentity = tokenProtocol && readConnectionSet(row).explicit ? JSON.stringify([plannedPath, protocolTargetUrl(row, plannedPath), connection?.auth ?? null, connection?.secret_name ?? null]) : undefined;
  if (state?.claim && !(await matchProtocolAffinity(state.claim, { serviceGroupId: snapshot?.serviceGroupId ?? null, row, upstreamKey, upstreamModelName: sentModel, wireIdentity }))) {
    state.claim = null;
    state.opaque = false;
    state.reset = true;
    c.header("x-cpg-state-reset", "opaque-state-dropped");
  }
  if (state?.reset && tokenProtocol) {
    body = dropOpaqueProtocolState(body, kind as "messages" | "responses" | "chat/completions");
    rawBody = undefined;  
    cacheKey = undefined;
    if (!(kind === "responses" ? body.input : body.messages)?.length) {
      const managed = managedBillingRequest(c);
      if (managed?.attempt) { if (failure) failure.reason = "client_error"; return null; }
      if (managed) await abandonUndispatchedBillingRequest(c.env, requestId);
      return c.json({ error: "invalid_request_body", message: "No conversation remains after removing incompatible reasoning state." }, 400);
    }
  }
  const nativeResponses = kind === "responses" && plannedPath === "responses";
  const reverseBridge = kind === "chat/completions" && plannedPath === "responses";
  const affinity = (kind === "responses" || kind === "chat/completions" || kind === "messages") && state
    ? await issueProtocolAffinity(c.env, { deviceId: device.id, selection: state.selection, modelKey: state.modelKey, serviceGroupId: snapshot?.serviceGroupId ?? null, row, upstreamKey, upstreamModelName: sentModel, wireIdentity }) : null;
  const withProtocolHeaders = (response: Response): Response => {
    response.headers.delete("x-cpg-affinity");
    response.headers.delete("x-cpg-state-reset");
    if (state?.reset) response.headers.set("x-cpg-state-reset", "opaque-state-dropped");
    if (affinity && response.ok) response.headers.set("x-cpg-affinity", affinity);
    response.headers.set("x-cpg-protocol-route", `${kind}->${plannedPath}`);
    return response;
  };

  const reqBody = { ...body, model: sentModel };
  if (kind === "embeddings") { delete reqBody.stream; cacheKey = undefined; }
  if (kind === "messages") cacheKey = undefined;
  if (nativeResponses) {
    reqBody.store = false;
    cacheKey = undefined;
  }
  if (reqBody.reasoning && typeof reqBody.reasoning === "object") reqBody.reasoning = { ...reqBody.reasoning };
  if (reqBody.output_config && typeof reqBody.output_config === "object") reqBody.output_config = { ...reqBody.output_config };
  const droppedReasoning = kind === "messages" ? false : groupReasoning
    ? degradeGroupReasoningEffort(reqBody, groupReasoning, row).changed
    : dropUnsupportedReasoning
      ? dropUnsupportedReasoningEffort(reqBody, row)
      : false;
  if (droppedReasoning) cacheKey = undefined;
  const effortRewrite = applyReasoningEffort(reqBody, usageProviderType(plannedPath), kind);
  const isStream = reqBody.stream === true;

  const billingRules = parseRewriteRules(billingRow.config_json);
  const bodyAffectingRules =
    billingRules.system_prompt !== undefined ||
    billingRules.temperature !== undefined ||
    billingRules.temperature_max !== undefined ||
    billingRules.max_tokens !== undefined ||
    billingRules.max_tokens_limit !== undefined ||
    billingRules.top_p !== undefined;
  const EFFORT_NOOP_REASONS = new Set(["not_anthropic", "not_messages_endpoint", "no_effort"]);
  const canReuseRawBody =
    rawBody !== undefined &&
    kind !== "embeddings" && !reverseBridge && (kind !== "responses" || (nativeResponses && body.store === false)) &&
    rawBody.length > RAW_BODY_REUSE_MIN_UNITS &&
    !droppedReasoning &&
    !bodyAffectingRules &&
    !billingRules.model_rewrite &&
    !ownRewrite &&
    sentModel === body.model &&
    !effortRewrite.applied &&
    EFFORT_NOOP_REASONS.has(effortRewrite.reason ?? "");
  const startedAt = Date.now();
  const headers = tokenProtocol ? buildProtocolHeaders(c.req.raw.headers, row, plannedPath, upstreamKey) : buildUpstreamHeaders(c.req.raw.headers, row.provider_type, upstreamKey);
  let billingAttempt: Awaited<ReturnType<NonNullable<ReturnType<typeof managedBillingRequest>>["begin"]>> | undefined;
  try { billingAttempt = tokenProtocol ? await managedBillingRequest(c)?.begin(row, sentModel, plannedPath) : undefined; }
  catch {
    if (failure) failure.reason = "attempt_budget_exhausted";
    return null;
  }

  if (kind === "responses" && !nativeResponses) {
    const target = buildTargetUrl(row, "chat/completions");
    let modelConfig: Record<string, any> | undefined;
    if (row.config_json) {
      try { modelConfig = JSON.parse(row.config_json); } catch {}
    }
    const chatBody = convertResponsesRequest(reqBody, modelConfig);
    headers.set("Content-Type", "application/json");

    const approxInputTokens = Math.max(1, Math.ceil(JSON.stringify(chatBody.messages).length / 4));

    let upstreamRes: Response;
    const upstreamController = new AbortController();
    billingAttempt?.start(upstreamController);
    const callerAbort = () => upstreamController.abort();
    c.req.raw.signal.addEventListener("abort", callerAbort, { once: true });
    if (c.req.raw.signal.aborted) callerAbort();
    const upstreamTimer = setTimeout(() => upstreamController.abort(), Math.max(1, Math.min(UPSTREAM_FETCH_TIMEOUT_MS, (attemptBudget?.deadline ?? Infinity) - Date.now())));
    try {
      upstreamRes = await fetch(target, {
        method: "POST",
        headers,
        body: JSON.stringify(chatBody),
        redirect: "follow",
        signal: upstreamController.signal,
      });
    } catch {
      if (failure) failure.reason = "network_error";
      billingAttempt?.mark(c.req.raw.signal.aborted ? "cancelled" : "unknown");
      billingAttempt?.stop();
      return null;
    } finally {
      clearTimeout(upstreamTimer);
      c.req.raw.signal.removeEventListener("abort", callerAbort);
    }

    billingAttempt?.headers(upstreamRes.status);
  if (!upstreamRes.ok && (await shouldFailoverAfterFailure(row, upstreamRes, canFailover === true, requestId, failure, retryableOnly))) {
      billingAttempt?.mark("upstream_error");
      billingAttempt?.stop();
      if (billingAttempt) await billingAttempt.checkpoint();
      void upstreamRes.body?.cancel().catch(() => {});
      return null;
    }

    let streamStalled = false;
    const stallWatch =
      isStream && upstreamRes.ok && upstreamRes.body
        ? watchForStall(upstreamRes, upstreamController, () => {
            streamStalled = true;
            billingAttempt?.mark("timeout");
          })
        : null;
    if (stallWatch) upstreamRes = stallWatch.response;
    const stallGuard = stallWatch ? stallWatch.stop : () => {};

    const pctx: ProxyContext = {
      c,
      kind,
      upstreamKind: plannedPath,
      billingAttempt,
      startedAt,
      device,
      row,
      billingRow,
      visibleModel,
      upstreamStatus: upstreamRes.status,
      latencyMs: Date.now() - startedAt,
      requestId,
      createdAt: startedAt,
      cacheKey,
      reservedUsd,
      priceMultiplier: snapshot?.multiplier,
      priceWindowId: snapshot?.window_id ?? null,
      serviceGroupId: snapshot?.serviceGroupId,
      serviceGroupRevision: snapshot?.serviceGroupRevision,
      pricingSnapshotJson: snapshot?.pricingSnapshotJson,
      estimatedInputTokens: estimatePromptTokens(body, rawBytes),
      sentModel: reqBody.model,
    };


    if (billingAttempt) {
      billingAttempt.onFailure = async (status) => { pctx.latencyMs = Date.now() - startedAt; return record(pctx, billingAttempt.meter.snapshot().usage, status); };
      if (isStream && resolveRowBillingUnit(billingRow) !== "call") billingAttempt.onComplete = () => { pctx.latencyMs = Date.now() - startedAt; return record(pctx, billingAttempt.meter.snapshot().usage, upstreamRes.status); };
      upstreamRes = billingAttempt.response(upstreamRes, isStream, c.req.raw.signal);
    }
    if (upstreamRes.ok) {
      if (isStream && upstreamRes.body) {
        let resolveDone: () => void = () => {};
        const donePromise = new Promise<void>((resolve) => { resolveDone = resolve; });
        let fullOutput = "";
        let fullMetadata: ChatToResponsesFinishMetadata | undefined;
        let settled = false;
        let clientCancelled = false;

        const transform = createChatToResponsesTransform(
          requestId,
          visibleModel,
          (text, meta) => {
            fullOutput = text;
            fullMetadata = meta;
            pctx.billableCall = meta?.billableCall === true;
            resolveDone();
          },
          approxInputTokens,
          () => streamStalled,
          billingAttempt ? () => billingAttempt.meter.snapshot() : undefined
        );

        const cancelAware = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
          cancel() {
            clientCancelled = true;
            stallGuard();
            resolveDone();
          },
        });

        const readable = upstreamRes.body
          .pipeThrough(transform)
          .pipeThrough(modelMaskingTransform(visibleModel))
          .pipeThrough(cancelAware);
        const outHeaders = cleanResponseHeaders(upstreamRes.headers);
        outHeaders.set("content-type", "text/event-stream; charset=utf-8");
        outHeaders.set("cache-control", "no-cache");

        waitUntil(
          c,
          donePromise.then(async () => {
            if (settled) return;
            settled = true;
            stallGuard();
            pctx.latencyMs = Date.now() - startedAt;
            const approxOutputTokens = Math.max(1, Math.ceil((fullOutput.length + (fullMetadata?.reasoning?.length ?? 0)) / 4));
            const usageObj = fullMetadata?.usage ?? {
              input_tokens: approxInputTokens,
              output_tokens: approxOutputTokens,
              total_tokens: approxInputTokens + approxOutputTokens,
            };
            pctx.billableCall = pctx.billableCall === true && !clientCancelled && !streamStalled;
            const { costUsd } = await record(pctx, usageObj, upstreamRes.status);

            if (billingRow.cache_enabled && cacheKey && !clientCancelled && !streamStalled) {
              const respJson = {
                id: `resp_${requestId}`,
                object: "response",
                status: "completed",
                model: visibleModel,
                output: fullMetadata?.outputItems || [
                  {
                    id: `item_${requestId}`,
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: fullOutput }],
                  },
                ],
                usage: usageObj,
              };
              await setCachedEntry(
                c.env,
                cacheKey,
                {
                  kind,
                  model: visibleModel,
                  jsonBody: respJson,
                  usage: usageObj,
                  reasoning: fullMetadata?.reasoning,
                  createdAt: startedAt,
                  billing: buildBillingSnapshot(billingRow, costUsd, pctx),
                },
                billingRow.cache_ttl
              );
            }
          })
        );

        return withProtocolHeaders(new Response(readable, { status: 200, headers: outHeaders }));
      } else {
        const chatJson: any = await upstreamRes.json();
        billingAttempt?.observeJson(chatJson);
        if (resolveRowBillingUnit(billingRow) === "call" && !isImageModel(billingRow)) {
          pctx.billableCall = Array.isArray(chatJson?.choices) && chatJson.choices.length > 0 && chatJson.choices.every((choice: any) => choice?.message && typeof choice.finish_reason === "string") && !chatJson.error;
        }
        pctx.latencyMs = Date.now() - startedAt;
        const responsesJson = convertChatToResponsesJson(chatJson, requestId, visibleModel);
        const parsedUsage = parseJsonUsage(usageProviderType(plannedPath), chatJson);
        const approxOutputTokens = Math.max(
          1,
          Math.ceil((responsesJson.output?.[0]?.content?.[0]?.text || "").length / 4)
        );
        const usage: TokenUsage = parsedUsage ?? {
          input_tokens: approxInputTokens,
          output_tokens: approxOutputTokens,
          total_tokens: approxInputTokens + approxOutputTokens,
        };
        await completeBilling(
          c,
          record(pctx, usage, upstreamRes.status).then(async ({ costUsd }) => {
            if (billingRow.cache_enabled && cacheKey) {
              const reasoning = chatJson.choices?.[0]?.message?.reasoning_content || undefined;
              await setCachedEntry(
                c.env,
                cacheKey,
                {
                  kind,
                  model: visibleModel,
                  jsonBody: responsesJson,
                  usage,
                  reasoning,
                  createdAt: startedAt,
                  billing: buildBillingSnapshot(billingRow, costUsd, pctx),
                },
                billingRow.cache_ttl
              );
            }
          })
        );
        return withProtocolHeaders(c.json(responsesJson, 200));
      }
    }

    const text = await upstreamRes.text();
    pctx.latencyMs = Date.now() - startedAt;
    const usage = parseUsage(usageProviderType(plannedPath), text);
    const res = new Response(
      upstreamRes.ok ? maskJsonText(text, visibleModel) : redactUpstreamIdentity(maskJsonText(text, visibleModel), upstreamIdentityTerms(pctx)),
      {
        status: upstreamRes.status,
        headers: cleanResponseHeaders(upstreamRes.headers),
      }
    );
    await completeBilling(pctx.c, record(pctx, usage, upstreamRes.status));
    return withProtocolHeaders(res);
  }

  const target = buildTargetUrl(row, plannedPath);
  const outboundBody = reverseBridge ? convertChatRequestToResponses(reqBody) : reqBody;
  let upstreamRes: Response;
  const upstreamController = new AbortController();
  billingAttempt?.start(upstreamController);
  const callerAbort = () => upstreamController.abort();
  c.req.raw.signal.addEventListener("abort", callerAbort, { once: true });
  if (c.req.raw.signal.aborted) callerAbort();
  const upstreamTimer = setTimeout(() => upstreamController.abort(), Math.max(1, Math.min(UPSTREAM_FETCH_TIMEOUT_MS, (attemptBudget?.deadline ?? Infinity) - Date.now())));
  try {
    upstreamRes = await fetch(target, {
      method: "POST",
      headers,
      body: canReuseRawBody ? rawBody : JSON.stringify(outboundBody),
      redirect: "follow",
      signal: upstreamController.signal,
    });
  } catch {
    if (failure) failure.reason = "network_error";
    billingAttempt?.mark(c.req.raw.signal.aborted ? "cancelled" : "unknown");
    billingAttempt?.stop();
    return null;
  } finally {
    clearTimeout(upstreamTimer);
    c.req.raw.signal.removeEventListener("abort", callerAbort);
  }

  billingAttempt?.headers(upstreamRes.status);
  if (!upstreamRes.ok && (await shouldFailoverAfterFailure(row, upstreamRes, canFailover === true, requestId, failure, retryableOnly))) {
    billingAttempt?.mark("upstream_error");
    billingAttempt?.stop();
    if (billingAttempt) await billingAttempt.checkpoint();
    void upstreamRes.body?.cancel().catch(() => {});
    return null;
  }

  let streamStalled = false;
  const stallWatch =
    (isStream || nativeResponses || reverseBridge) && upstreamRes.ok && upstreamRes.body && kind !== "images/generations"
      ? watchForStall(upstreamRes, upstreamController, () => {
          streamStalled = true;
          billingAttempt?.mark("timeout");
        })
      : null;
  if (stallWatch) upstreamRes = stallWatch.response;
  const stallGuard = stallWatch ? stallWatch.stop : () => {};

  const pctx: ProxyContext = {
    c,
    kind,
    upstreamKind: plannedPath,
    billingAttempt,
    startedAt,
    device,
    row,
    billingRow,
    visibleModel,
    upstreamStatus: upstreamRes.status,
    latencyMs: Date.now() - startedAt,
    requestId,
    createdAt: startedAt,
    cacheKey,
    reservedUsd,
    priceMultiplier: snapshot?.multiplier,
    priceWindowId: snapshot?.window_id ?? null,
      serviceGroupId: snapshot?.serviceGroupId,
      serviceGroupRevision: snapshot?.serviceGroupRevision,
      pricingSnapshotJson: snapshot?.pricingSnapshotJson,
    estimatedInputTokens: estimatePromptTokens(body, rawBytes),
    sentModel: reqBody.model,
  };

  let decodedJson: JsonDecodeResult | undefined;
  if (billingAttempt) {
    billingAttempt.onFailure = async (status) => { pctx.latencyMs = Date.now() - startedAt; return record(pctx, billingAttempt.meter.snapshot().usage, status); };
    if (isStream && !nativeResponses && !reverseBridge && resolveRowBillingUnit(billingRow) !== "call") billingAttempt.onComplete = () => { pctx.latencyMs = Date.now() - startedAt; return record(pctx, billingAttempt.meter.snapshot().usage, upstreamRes.status); };
    if (isStream && (nativeResponses || reverseBridge)) billingAttempt.onFailure = undefined;
    const captureJson = !isStream && !nativeResponses && !reverseBridge && kind !== "embeddings" && kind !== "images/generations";
    upstreamRes = billingAttempt.response(upstreamRes, isStream, c.req.raw.signal,
      captureJson ? (result) => { decodedJson = result; } : undefined);
  }
  if (kind === "embeddings") return relayEmbeddingAnswer(pctx, upstreamRes, body);

  if (nativeResponses || reverseBridge) {
    if (upstreamRes.ok && isStream && upstreamRes.headers.get("content-type")?.includes("text/event-stream")) {
      const relayed = relayNativeResponsesStream(pctx, upstreamRes, stallGuard, reverseBridge ? createResponsesChatEventValidator() : undefined);
      if (!reverseBridge) return withProtocolHeaders(relayed);
      const converted = relayed.body!.pipeThrough(createResponsesToChatTransform(visibleModel));
      return withProtocolHeaders(new Response(converted, { status: relayed.status, headers: relayed.headers }));
    }
    const relayed = await relayNativeResponsesJson(pctx, upstreamRes, stallGuard, isStream, reverseBridge ? validateResponsesChatOutput : undefined);
    if (!reverseBridge || !relayed.ok) return withProtocolHeaders(relayed);
    try {
      const answer = convertResponsesToChatJson(await relayed.json(), visibleModel);
      return withProtocolHeaders(new Response(JSON.stringify(answer), { status: relayed.status, headers: relayed.headers }));
    } catch {
      return c.json({ error: "invalid_upstream_response", message: "Responses output could not be represented as Chat." }, 502);
    }
  }

  if (isStream) return withProtocolHeaders(passthroughStream(pctx, upstreamRes, stallGuard, () => streamStalled));

  if (kind === "images/generations") {
    return relayImageAnswer(pctx, upstreamRes);
  }

  const text = await upstreamRes.text();
  const preparedJson = prepareJsonResponse(text, usageProviderType(plannedPath), visibleModel,
    upstreamRes.ok && kind === "chat/completions",
    billingAttempt ? (value) => billingAttempt.observeJson(value) : undefined, decodedJson);
  decodedJson = undefined;
  if (resolveRowBillingUnit(billingRow) === "call" && !isImageModel(billingRow) && upstreamRes.ok) {
    const obj = preparedJson.decoded.ok ? preparedJson.decoded.value : undefined;
    pctx.billableCall = kind === "messages" ? obj?.type === "message" && Array.isArray(obj.content) && !obj.error : Array.isArray(obj?.choices) && obj.choices.length > 0 && obj.choices.every((choice: any) => choice?.message && typeof choice.finish_reason === "string") && !obj.error;
  }
  pctx.latencyMs = Date.now() - startedAt;
  const usage = preparedJson.usage;
  const maskedText = preparedJson.text;
  const normalisedText = maskedText;
  const normalisedReasoning = preparedJson.reasoning;
  const outText = upstreamRes.ok ? normalisedText : redactUpstreamIdentity(maskedText, upstreamIdentityTerms(pctx));
  const res = new Response(outText, {
    status: upstreamRes.status,
    headers: cleanResponseHeaders(upstreamRes.headers),
  });

  await completeBilling(
    pctx.c,
    record(pctx, usage, upstreamRes.status).then(async ({ costUsd }) => {
      if (upstreamRes.ok && billingRow.cache_enabled && cacheKey) {
        try {
          if (!preparedJson.decoded.ok) return;
          const jsonBody = preparedJson.decoded.value;
          await setCachedEntry(
            c.env,
            cacheKey,
            {
              kind,
              model: visibleModel,
              jsonBody,
              usage: usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
              reasoning: normalisedReasoning,
              createdAt: startedAt,
              billing: buildBillingSnapshot(billingRow, costUsd, pctx),
            },
            billingRow.cache_ttl
          );
        } catch {}
      }
    })
  );
  return withProtocolHeaders(res);
}

function validateBillingRequest(c: Context<{ Bindings: Env }>, kind: GatewayKind, body: any, modelKey: string, billingRow: ModelWithProvider): Response | undefined {
  if (kind === "embeddings") {
    const error = validateEmbeddingRequest(body);
    if (error) return c.json({ error }, 400);
    if (resolveModelType(billingRow) !== "embedding" || resolveRowBillingUnit(billingRow) !== "token") return c.json({ error: "model_not_embedding", model: modelKey }, 400);
    if ((billingRow.search_price_per_call || 0) !== 0) return c.json({ error: "embedding_search_pricing_unsupported" }, 400);
  }
  if (kind !== "embeddings" && resolveModelType(billingRow) === "embedding") return c.json({ error: "embedding_endpoint_required" }, 400);
  if (
    kind !== "images/generations" &&
    isImageModel(billingRow)
  ) {
    if (kind === "chat/completions" && chatBodyHasImage(body)) {
    } else {
      return c.json(
        {
          error: "per_call_text_only",
          message: `Model "${modelKey}" is billed per request and only processes image requests. Attach an image_url part in messages (image-to-image), or call /v1/images/generations.`,
          model: modelKey,
        },
        400
      );
    }
  }

  if (kind === "images/generations") {
    if (body?.stream === true) {
      return c.json(
        { error: "images_do_not_stream", message: "Image generation does not support stream: true. Remove it and retry." },
        400
      );
    }
    if (resolveRowBillingUnit(billingRow) !== "call") {
      return c.json(
        {
          error: "model_not_billed_per_call",
          message:
            `Model "${modelKey}" is billed per token but was called on the image path. An administrator must switch it to per-call pricing (billing_unit "call" with a price_per_call) before it can generate pictures.`,
          model: modelKey,
        },
        400
      );
    }
    if (resolveRowPricingMode(billingRow) !== "free" && (billingRow.price_per_call || 0) <= 0) {
      return c.json(
        {
          error: "model_pricing_missing",
          message:
            `Model "${modelKey}" is billed per request but has no price_per_call. Set one before it can generate pictures.`,
          model: modelKey,
        },
        400
      );
    }
    if (!isImageModel(billingRow)) return c.json({ error: "model_not_image", model: modelKey }, 400);
    const requested = Number(body?.n ?? 1);
    if (Number.isFinite(requested) && requested > MAX_IMAGES_PER_REQUEST) {
      return c.json(
        {
          error: "too_many_images",
          message: `This gateway generates at most ${MAX_IMAGES_PER_REQUEST} pictures per request (asked for ${requested}).`,
          max_images: MAX_IMAGES_PER_REQUEST,
        },
        400
      );
    }
  }
  return undefined;
}

async function handleAutoServiceProxy(
  c: Context<{ Bindings: Env }>, kind: GatewayKind, device: DeviceRow & { sub_token_id?: string | null }, originalBody: any,
  rawBody: string, modelKey: string, routes: ServiceRoute[], compatible: (row: ModelWithProvider) => boolean
): Promise<Response> {
  const allowGroupFallback = device.token_routing_policy?.policy.failure_fallback ?? true;
  const safeReplay = (reason: string | undefined) => Boolean(reason) && !["network_error", "client_error", "attempt_budget_exhausted"].includes(reason!);
  const safeRetry = (reason: string | undefined) => safeReplay(reason) && isRetryableFailureReason(reason);
  const protocolRoutes = routes.map((route) => ({ ...route, members: route.members.filter(compatible) }))
    .filter((route) => route.members.length > 0);
  if (!protocolRoutes.length) return c.json({ error: "unsupported_provider_for_path" }, 400);
  const primaryUnit = resolveRowBillingUnit(protocolRoutes[0].billingRow);
  const usableRoutes = protocolRoutes.filter((route) => resolveRowBillingUnit(route.billingRow) === primaryUnit);
  if (kind === "embeddings") {
    const first = usableRoutes[0].billingRow;
    for (const route of usableRoutes) {
      const error = embeddingPoolError(route.billingRow, route.members, true);
      if (error || !compatibleEmbeddingSpace(first, route.billingRow)) return c.json({ error: error || "embedding_compatibility_required" }, 400);
      if (embeddingDimensionsError(originalBody, [route.billingRow, ...route.members])) return c.json({ error: "embedding_dimensions_mismatch" }, 400);
    }
  }
  for (const route of usableRoutes) {
    const guard = validateBillingRequest(c, kind, originalBody, modelKey, route.billingRow);
    if (guard) return guard;
  }
  const [modelLimits, groupLimits] = await Promise.all([
    getDeviceModelRateLimits(c.env, device.id), getDeviceGroupRateLimits(c.env, device.id),
  ]);
  const units = rawBody.length;
  const declared = Number(c.req.header("content-length") ?? "");
  const promptBytes = Math.max(units, Number.isFinite(declared) && declared > 0 ? Math.min(Math.floor(declared), units * 3) : 0);
  const snapshotReplacer = (key: string, value: unknown) => /api_key|secret|config_json|model_metadata|protocol_metadata/.test(key) ? undefined : value;
  const candidateGroupsJson = JSON.stringify(usableRoutes.map(r => ({ id: r.group.id, revision: r.group.revision,
    mapping_id: r.mapping.id, billing: r.billingRow, peak: r.autoPriceSnapshot })), snapshotReplacer);
  const prepared = await Promise.all(usableRoutes.map(async (route) => {
    const billing = route.billingRow;
    const peak = route.autoPriceSnapshot ?? await resolvePriceSnapshot(c.env, billing.id, resolveRowPeakPricing(billing));
    const invoiceJson = JSON.stringify({ billing, multiplier: peak.multiplier, window_id: peak.window_id,
      policy_version: device.token_routing_policy?.version }, snapshotReplacer);
    const snapshot = { ...peak, serviceGroupId: route.group.id, serviceGroupRevision: route.group.revision,
      pricingSnapshotJson: invoiceJson.slice(0, -1) + ",\"candidate_groups\":" + candidateGroupsJson + "}" };
    const body = applyRequestRewriteRules(originalBody, parseRewriteRules(billing.config_json), kind);
    return { route, billing, body, snapshot,
      estimate: estimateRequestCostUsd(billing, body, peak.multiplier, promptBytes),
      retries: primaryUnit === "call" ? 0 : readGroupMemberRetries(billing.config_json),
      reasoning: route.targetKind === "group" ? resolveGroupReasoningSupport(billing.config_json) : undefined };
  }));
  const requestId = randomRequestId();
  const estimatedCostUsd = Math.max(0, ...prepared.map((entry) => entry.estimate));
  let reservedUsd = 0;
  let responseOwnsReserve = false;
  const managedText = !isImageModel(prepared[0].billing) && ["messages", "chat/completions", "responses"].includes(kind);
  let lastInvoice = prepared[0];
  let lastRow = prepared[0].route.members[0];
  let attempts = 0;
  const attemptBudget = newAttemptBudget();
  const quotas = new Map<string, Awaited<ReturnType<typeof consumeModelQuota>>>();
  try {
    if (managedText) {
      const admitted = await admitBillingRequest(c.env, { request_id: requestId, device_id: device.id, sub_token_id: device.sub_token_id ?? null,
        model: modelKey, reserved_usd: estimatedCostUsd, lease_ms: BILLING_LEASE_MS, monthly_service_group_ids: prepared.map(p => p.route.group.id), pricing_snapshot_json: prepared[0].snapshot.pricingSnapshotJson });
      if (!admitted) return c.json({ error: "insufficient_balance", estimated_cost_usd: estimatedCostUsd }, 429);
      reservedUsd = estimatedCostUsd; manageBillingRequest(c, c.env, requestId);
    } else if (estimatedCostUsd > 0) {
      const wallet = await getWallet(c.env, device.id);
      const availableUsd = Number((wallet.balance_usd - wallet.reserved_usd).toFixed(4));
      if ((device.token_routing_policy && device.token_routing_policy.source !== "compatibility") || availableUsd < estimatedCostUsd * TRUSTED_BALANCE_MULTIPLIER) {
        if (!(await reserveBalance(c.env, device.id, estimatedCostUsd, requestId))) {
          return c.json({ error: "insufficient_balance", available_usd: availableUsd, estimated_cost_usd: estimatedCostUsd }, 429);
        }
        reservedUsd = estimatedCostUsd;
      }
    }
    for (let routeIndex = 0; routeIndex < prepared.length; routeIndex++) {
      const { route, billing, body, snapshot, retries, reasoning } = prepared[routeIndex];
      const quotaKey = route.targetKind + ":" + route.quotaId;
      let quota = quotas.get(quotaKey);
      if (!quota) {
        quota = await consumeModelQuota(c.env, device, route.quotaId, route.targetKind === "group" ? groupLimits : modelLimits);
        quotas.set(quotaKey, quota);
      }
      if (quota.limited) {
        if (attempts === 0) {
          c.header("Retry-After", "60");
          return c.json({ error: "rate_limit_exceeded", model: modelKey, message: "Model rate limit of " + quota.limit + " RPM exceeded" }, 429);
        }
        continue;
      }
      let lastReason: string | undefined;
      const members = primaryUnit === "call" ? route.members.slice(0, 1) : route.members;
      for (let memberIndex = 0; memberIndex < members.length; memberIndex++) {
        const row = await openGroupMemberKey(c.env, members[memberIndex]);
        const failure: { reason?: string } = {};
        for (let retry = 0; retry <= retries; retry++) {
          const withinGroup = memberIndex + 1 < members.length || retry < retries;
          const canUpgrade = allowGroupFallback && primaryUnit !== "call" && routeIndex + 1 < prepared.length;
          failure.reason = undefined;
          if (!attemptBudgetAvailable(attemptBudget) || c.req.raw.signal.aborted) { lastReason = "attempt_budget_exhausted"; break; }
          attempts++;
          lastInvoice = prepared[routeIndex]; lastRow = row;
          const response = await executeProxyAttempt(c, kind, device, row, body, requestId, undefined, reservedUsd,
            snapshot, { billing, visible: modelKey }, undefined, true, reasoning, withinGroup || canUpgrade,
            promptBytes, rawBody, failure, memberIndex + 1 === members.length, attemptBudget);
          if (response) {
            responseOwnsReserve = true;  
            if (attempts > 1) {
              try { response.headers.set("x-gateway-attempts", String(attempts)); } catch {   }
            }
            return response;  
          }
          lastReason = failure.reason;
          if (!safeRetry(lastReason)) break;
        }
        if (!safeReplay(lastReason)) break;
      }
      const safeGroupReplay = device.token_routing_policy?.source === "compatibility"
        ? safeRetry(lastReason) : safeReplay(lastReason);
      if (!allowGroupFallback || primaryUnit === "call" || !safeGroupReplay) break;
    }
    const response = c.json({ error: "upstream_service_unavailable", message: "Failed to fetch response from available service groups" }, 502);
    if (attempts > 1) response.headers.set("x-gateway-attempts", String(attempts));
    return response;
  } finally {
    if (!responseOwnsReserve) {
      const managed = managedBillingRequest(c);
      if (managed && !managed.attempt) await abandonUndispatchedBillingRequest(c.env, requestId);
      else if (managed) await record({ c, kind, device, row: lastRow, billingRow: lastInvoice.billing, visibleModel: modelKey,
        requestId, reservedUsd, billingAttempt: managed.attempt, upstreamStatus: managed.attempt?.httpStatus ?? 0,
        startedAt: managed.startedAt, createdAt: managed.startedAt, latencyMs: Date.now() - managed.startedAt,
        priceMultiplier: lastInvoice.snapshot.multiplier, priceWindowId: lastInvoice.snapshot.window_id,
        serviceGroupId: lastInvoice.snapshot.serviceGroupId, serviceGroupRevision: lastInvoice.snapshot.serviceGroupRevision,
        pricingSnapshotJson: lastInvoice.snapshot.pricingSnapshotJson, billableCall: false }, null, 502);
      else if (reservedUsd > 0) await releaseReserve(c.env, device.id, requestId);
    }
  }
}

export async function handleGatewayProxy(c: Context<{ Bindings: Env }>, kind: GatewayKind) {
  const device = await authenticateGateway(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);

  if ((device.auth_via ?? "master") === "master" && Number(device.calls_enabled ?? 1) === 0) {
    return c.json(
      {
        error: "calls_disabled",
        message: "This token's model calls are disabled. Sub-tokens are unaffected. Re-enable it in the console.",
      },
      403
    );
  }

  if (device.rate_limit_rpm && device.rate_limit_rpm > 0) {
    const allowed = await checkDeviceRateLimit(c.env, device.id, device.rate_limit_rpm);
    if (!allowed) {
      c.header("Retry-After", "60");
      return c.json(
        { error: "rate_limit_exceeded", message: `Device rate limit of ${device.rate_limit_rpm} RPM exceeded` },
        429
      );
    }
  }

  const budgetCfg = await getSetting<{ monthly_budget_usd: number; budget_action: "warn" | "block"; alert_threshold_pct: number }>(c.env, "budget_config");
  if (budgetCfg && budgetCfg.monthly_budget_usd > 0) {
    const currentSpend = await getCurrentMonthSpend(c.env);
    if (currentSpend >= budgetCfg.monthly_budget_usd) {
      if (budgetCfg.budget_action === "block") {
        waitUntil(
          c,
          sendWebhookNotification(c.env, {
            event: "budget_exceeded",
            title: "🚨【AI Gateway】月度预算已耗尽，已触发自动熔断拦截",
            message: `本月累计消耗 ¥${currentSpend.toFixed(2)}，已达到月度预算上限 ¥${budgetCfg.monthly_budget_usd.toFixed(2)}，后续代理请求已被拦截。`,
            details: {
              monthly_budget_usd: budgetCfg.monthly_budget_usd,
              current_spend_usd: currentSpend,
              action: "block",
            },
          })
        );
        return c.json(
          {
            error: "monthly_budget_exceeded",
            message: `Monthly budget limit of ¥${budgetCfg.monthly_budget_usd.toFixed(2)} has been reached (¥${currentSpend.toFixed(2)} spent). Requests are blocked.`,
            spent_usd: currentSpend,
            budget_usd: budgetCfg.monthly_budget_usd,
          },
          429
        );
      }
    }
  }

  if (device.cost_limit_monthly && device.cost_limit_monthly > 0) {
    const deviceMonthSpend = await getDeviceMonthlyCost(c.env, device.id);
    if (deviceMonthSpend >= device.cost_limit_monthly) {
      waitUntil(
        c,
        sendWebhookNotification(c.env, {
          event: "device_budget_exceeded",
          title: `🚨【AI Gateway】设备「${device.name}」月度消费限额已达上限`,
          message: `设备「${device.name}」(ID: ${device.id}) 本月已消耗 ¥${deviceMonthSpend.toFixed(2)}，达到设定的设备月度限额 ¥${device.cost_limit_monthly.toFixed(2)}，后续请求已被自动拦截。`,
          details: {
            device_id: device.id,
            device_name: device.name,
            cost_limit_monthly: device.cost_limit_monthly,
            current_month_cost: deviceMonthSpend,
          },
        })
      );
      return c.json(
        {
          error: "device_budget_exceeded",
          message: `Device monthly spending limit of ¥${device.cost_limit_monthly.toFixed(2)} exceeded (¥${deviceMonthSpend.toFixed(2)} spent). Requests are blocked.`,
          device_spent_usd: deviceMonthSpend,
          device_limit_usd: device.cost_limit_monthly,
        },
        429
      );
    }
  }

  const bodyLimit = kind === "embeddings" ? MAX_EMBEDDING_REQUEST_BYTES : MAX_REQUEST_BODY_BYTES;
  const declaredLength = Number(c.req.header("content-length") || "");
  if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
    return c.json(
      {
        error: "request_too_large",
        message: `Request body of ${declaredLength} bytes exceeds the ${bodyLimit} byte limit.`,
        limit_bytes: bodyLimit,
      },
      413
    );
  }

  let rawBody: string;
  try {
    rawBody = kind === "embeddings" ? await readBoundedBody(c.req.raw.body, bodyLimit, c.req.raw.signal) : await c.req.text();
  } catch (error) {
    return c.json({ error: error instanceof Error && error.message === "body_too_large" ? "request_too_large" : "invalid_request_body", limit_bytes: bodyLimit }, error instanceof Error && error.message === "body_too_large" ? 413 : 400);
  }
  if (rawBody.length > bodyLimit) {
    return c.json(
      {
        error: "request_too_large",
        message: `Request body exceeds the ${bodyLimit} byte limit.`,
        limit_bytes: bodyLimit,
      },
      413
    );
  }
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (kind === "embeddings") {
    const error = validateEmbeddingRequest(body);
    if (error) return c.json({ error }, 400);
  }
  const modelKey = body?.model;
  if (typeof modelKey !== "string" || !modelKey) return c.json({ error: "missing_model" }, 400);

  if (kind === "responses") {
    const unsupported = [...unsupportedResponsesFields(body), ...unsupportedNativeRequestFields(body)];
    if (unsupported.length > 0) {
      return c.json(
        {
          error: "unsupported_field",
          message:
            "This gateway supports stateless Responses requests without hosted tools. " +
            "These fields cannot be honoured and would otherwise be ignored: " +
            unsupported.join(", ") +
            ". Send the full conversation in input instead.",
          unsupported_fields: unsupported,
        },
        400
      );
    }
  }

  let nativeRequired = kind === "responses" && requiresNativeResponses(body);
  const opaque = (kind === "responses" || kind === "chat/completions" || kind === "messages") && hasOpaqueProtocolState(body, kind);
  const affinityHeader = c.req.header("x-cpg-affinity");
  const selection = device.service_group_id ?? device.default_service_group_id ?? "legacy";
  let claim = opaque && affinityHeader ? await verifyProtocolAffinity(c.env, affinityHeader, { deviceId: device.id, selection, modelKey }) : null;
  const state = { claim, opaque, reset: false, modelKey, selection };
  protocolState.set(c, state);
  const resetState = () => {
    body = dropOpaqueProtocolState(body, kind as "messages" | "responses" | "chat/completions");
    claim = null; state.claim = null; state.opaque = false; state.reset = true;
    c.header("x-cpg-state-reset", "opaque-state-dropped");
    nativeRequired = kind === "responses" && requiresNativeResponses(body);
    reverseLoss = forwardLoss = undefined;
  };
  let reverseLoss: string[] | undefined;
  let forwardLoss: string[] | undefined;
  if (opaque && !claim) resetState();
  const protocolCompatible = (candidate: ModelWithProvider) => {
    if (claim && (claim.modelId !== candidate.id || claim.providerId !== candidate.provider_id)) return false;
    if (kind === "embeddings") return embeddingProviderCompatible(candidate);
    if (["embedding", "video"].includes(resolveModelType(candidate))) return false;
    if (kind === "images/generations" || isImageModel(candidate)) return candidate.provider_type !== "anthropic";
    const planned = planProtocolRoute(candidate, kind, nativeRequired);
    if (!planned) return false;
    if (state.opaque && planned !== kind && !(kind === "chat/completions" && planned === "responses")) return false;
    if (planned === "responses" && kind === "chat/completions") return !(reverseLoss ??= unsupportedChatToResponsesFields(body)).length;
    if (planned === "chat/completions" && kind === "responses" && readProtocolCapabilities(candidate).loss_policy !== "allow") return !(forwardLoss ??= unsupportedResponsesBridgeFields(body)).length;
    return true;
  };

  const compatiblePool = (candidates: ModelWithProvider[]) => {
    const compatible = candidates.filter(protocolCompatible);
    if (claim && !compatible.length) { resetState(); return candidates.filter(protocolCompatible); }
    return compatible;
  };
  if (isAutoServiceSelection(device)) {
    const authorizedRoutes = await resolveAutoServiceRoutes(c.env, device, modelKey);
    let autoRoutes = authorizedRoutes.filter(route => !claim || route.group.id === claim.serviceGroupId);
    if (claim && !autoRoutes.some(route => route.members.some(protocolCompatible))) {
      resetState(); autoRoutes = authorizedRoutes;
    }
    if (autoRoutes.length) return handleAutoServiceProxy(c, kind, device, body, rawBody, modelKey, autoRoutes, protocolCompatible);
  }

  const serviceRoute = isAutoServiceSelection(device) ? null : await resolveServiceRoute(c.env, device, modelKey);
  if (claim && (serviceRoute?.group.id ?? null) !== claim.serviceGroupId) resetState();
  const target = serviceRoute ? { kind: "none" as const } : await resolveModelKey(c.env, modelKey, { includeSecrets: false });
  if (!serviceRoute && target.kind === "none") return c.json({ error: "model_not_found", model: modelKey }, 404);

  let row: ModelWithProvider;
  let failoverCandidates: ModelWithProvider[] = [];
  let legacyFailoverHealthPending = false;
  let quotaId: string;
  let quotaLimits: Map<string, number>;
  let billingRow: ModelWithProvider;
  let fallbackModelId: string | null = null;
  let isGroup = false;
  let attempts = 0;
  const attemptBudget = newAttemptBudget();

  const openedLegacyKeys = new Map<string, Promise<string | null>>();
  const openLegacyAttemptKey = async (candidate: ModelWithProvider): Promise<ModelWithProvider> => {
    const sealed = candidate.provider_api_key;
    if (!sealed) return candidate;
    let opened = openedLegacyKeys.get(sealed);
    if (!opened) {
      opened = openModelKey(c.env, candidate).then((value) => value.provider_api_key);
      openedLegacyKeys.set(sealed, opened);
    }
    return { ...candidate, provider_api_key: await opened };
  };

  if (serviceRoute) {
    if (kind === "embeddings") {
      const error = embeddingPoolError(serviceRoute.billingRow, serviceRoute.members);
      if (error) return c.json({ error }, 400);
    }
    const members = compatiblePool(serviceRoute.members);
    if (!members.length) return c.json({ error: "unsupported_provider_for_path" }, 400);
    billingRow = serviceRoute.billingRow;
    if (resolveRowPricingMode(billingRow) === "unset") return c.json({ error: "model_pricing_missing", model: modelKey }, 400);
    row = await openGroupMemberKey(c.env, members[0]);
    failoverCandidates = members.slice(1);
    quotaId = serviceRoute.quotaId;
    quotaLimits = device ? await (serviceRoute.targetKind === "group" ? getDeviceGroupRateLimits : getDeviceModelRateLimits)(c.env, device.id) : new Map<string, number>();
    isGroup = true;
  } else if (target.kind === "group") {
    const group = target.group;
    assertLegacyTokenScope(device, group.id, true);
    if (device) {
      const scope = device.model_scope || "all";
      const granted = scope === "all" ? new Set<string>() : new Set(await getDeviceGroupIds(c.env, device.id));
      if (!isModelInScope(scope, group.id, granted, Boolean(group.model_public))) {
        return c.json(
          {
            error: "model_not_in_scope",
            message: "This device is not allowed to use that model",
            model: modelKey,
          },
          403
        );
      }
    } else if (!group.model_public) {
      return c.json({ error: "model_not_found", model: modelKey }, 404);
    }

    if (!target.members.length) {
      return c.json(
        {
          error: "model_unavailable",
          message: `Model "${modelKey}" exists but no member can currently serve: every member, or its provider, is disabled.`,
          model: modelKey,
        },
        503
      );
    }

    const groupContractError = validateBillingRequest(c, kind, body, modelKey, groupBillingRow(group, target.members[0].provider_type));
    if (groupContractError) return groupContractError;
    if (kind === "embeddings") {
      const error = embeddingPoolError(groupBillingRow(group, target.members[0].provider_type), target.members);
      if (error) return c.json({ error }, 400);
    }
    const compatibleMembers = compatiblePool(target.members.filter(member => resolveModelType(member) === resolveModelType(group)));
    if (!compatibleMembers.length) {
      return c.json(
        {
          error: "unsupported_provider_for_path",
          message: kind === "messages"
            ? "/v1/messages requires an anthropic provider"
            : `/${kind} requires a compatible, enabled protocol mode on an openai or gemini model`,
        },
        400
      );
    }

    billingRow = groupBillingRow(group, compatibleMembers[0].provider_type);
    if (resolveRowPricingMode(billingRow) === "unset") {
      return c.json(
        {
          error: "model_pricing_missing",
          message:
            `Model "${modelKey}" has no pricing configured. An administrator must set pricing_mode to "priced" (with prices) or "free" before it can be used.`,
          model: modelKey,
        },
        400
      );
    }

    row = await openGroupMemberKey(c.env, compatibleMembers[0]);
    failoverCandidates = compatibleMembers.slice(1);
    quotaId = group.id;
    quotaLimits = device ? await getDeviceGroupRateLimits(c.env, device.id) : new Map<string, number>();
    isGroup = true;
  } else {
    if (target.kind !== "model") return c.json({ error: "model_not_found" }, 404);
    const allCandidates = target.candidates;
    const scopedCandidates = (device
      ? await filterCandidatesForDevice(c.env, device, allCandidates)
      : allCandidates).filter(candidate => tokenScopeAllows(device, ["model:" + candidate.id]));
    if (!scopedCandidates.length) {
      return c.json(
        {
          error: "model_not_in_scope",
          message: "This device is not allowed to use that model",
          model: modelKey,
        },
        403
      );
    }

    quotaLimits = device ? await getDeviceModelRateLimits(c.env, device.id) : new Map<string, number>();

    let recentLatencies: Record<string, number> | undefined;
    const latenciesFor = async (candidates: ModelWithProvider[]): Promise<Record<string, number>> => {
      if (!routeNeedsLatencies(candidates)) return {};
      if (!recentLatencies) recentLatencies = await getRecentProviderAvgLatencies(c.env);
      return recentLatencies;
    };
    const orderedCandidates = selectCandidateRoute(scopedCandidates, modelKey, await latenciesFor(scopedCandidates));

    const compatibleCandidates = compatiblePool(orderedCandidates);

    if (!compatibleCandidates.length) {
      return c.json(
        {
          error: "unsupported_provider_for_path",
          message: kind === "messages"
            ? "/v1/messages requires an anthropic provider"
            : `/${kind} requires a compatible, enabled protocol mode on an openai or gemini model`,
        },
        400
      );
    }

    const pricedCandidates = compatibleCandidates.filter((cand) => resolveRowPricingMode(cand) !== "unset");
    if (!pricedCandidates.length) {
      return c.json(
        {
          error: "model_pricing_missing",
          message:
            `Model "${modelKey}" has no pricing configured. An administrator must set pricing_mode to "priced" (with prices) or "free" before it can be used.`,
          model: modelKey,
        },
        400
      );
    }

    row = pricedCandidates[0];

    const scopedIds = new Set(scopedCandidates.map((c) => c.id));
    const everyCandidateInScope = allCandidates.every((c) => scopedIds.has(c.id));
    const poolLatencies = everyCandidateInScope ? {} : await latenciesFor(allCandidates);
    const outOfScopeFailover = everyCandidateInScope
      ? []
      : (() => {
          const ordered = selectCandidateRoute(allCandidates, modelKey, poolLatencies);
          const compatible = ordered.filter(protocolCompatible);
          return compatible.filter((c) => resolveRowPricingMode(c) !== "unset");
        })();

    const pool: ModelWithProvider[] = [];
    const attempted = new Set<string>([row.id]);
    for (const cand of [...pricedCandidates.slice(1), ...outOfScopeFailover]) {
      if (attempted.has(cand.id)) continue;
      attempted.add(cand.id);
      pool.push(cand);
    }
    legacyFailoverHealthPending = pool.length > 1;
    failoverCandidates = pool;

    billingRow = row;
    quotaId = row.id;
    fallbackModelId = row.fallback_model_id;
  }

  if (kind === "embeddings") {
    const candidates = [row, ...failoverCandidates];
    const error = embeddingPoolError(billingRow, candidates);
    if (error) return c.json({ error }, 400);
    if (embeddingDimensionsError(body, [billingRow, ...candidates])) return c.json({ error: "embedding_dimensions_mismatch" }, 400);
    fallbackModelId = null;
  }
  if (claim) fallbackModelId = null;  
  const requestGuard = validateBillingRequest(c, kind, body, modelKey, billingRow);
  if (requestGuard) return requestGuard;

  const primaryQuota = await consumeModelQuota(c.env, device, quotaId, quotaLimits);
  if (primaryQuota.limited) {
    c.header("Retry-After", "60");
    return c.json(
      {
        error: "rate_limit_exceeded",
        message: `Model rate limit of ${primaryQuota.limit} RPM exceeded`,
        model: billingRow.model_name,
      },
      429
    );
  }

  const identity = { billing: billingRow, visible: billingRow.model_name };

  const groupReasoning = isGroup && (!serviceRoute || serviceRoute.targetKind === "group") ? resolveGroupReasoningSupport(billingRow.config_json) : undefined;

  const groupRetries =
    isGroup && resolveRowBillingUnit(billingRow) !== "call"
      ? readGroupMemberRetries(billingRow.config_json)
      : 0;

  const peakSnapshot = await resolvePriceSnapshot(c.env, billingRow.id, resolveRowPeakPricing(billingRow));
  const priceSnapshot = { ...peakSnapshot, ...(serviceRoute ? { serviceGroupId: serviceRoute.group.id, serviceGroupRevision: serviceRoute.group.revision, pricingSnapshotJson: JSON.stringify({ billing: billingRow, multiplier: peakSnapshot.multiplier, window_id: peakSnapshot.window_id, policy_version: device?.token_routing_policy?.version }, (key, value) => /api_key|secret|config_json|model_metadata|protocol_metadata/.test(key) ? undefined : value) } : {}) };

  const rewriteRules = parseRewriteRules(billingRow.config_json);
  body = applyRequestRewriteRules(body, rewriteRules, kind);
  const upstreamModelName = serviceRoute ? undefined : rewriteRules.model_rewrite;

  const requestId = randomRequestId();
  const isStream = body?.stream === true;
  const bypass = shouldBypassCache(c.req.raw.headers, body);
  const cacheEnabled = kind !== "messages" && kind !== "embeddings" && resolveRowBillingUnit(billingRow) !== "call" && !serviceRoute && !opaque && !claim && kind !== "images/generations" && Boolean(billingRow.cache_enabled) &&
    !((kind === "responses" || kind === "chat/completions") && [row, ...failoverCandidates].some((candidate) => planProtocolRoute(candidate, kind, nativeRequired) === "responses"));

  let cacheKey: string | undefined;
  if (cacheEnabled) {
    cacheKey = await computeCacheKey(kind, billingRow.model_name, body, device.id);

    if (!bypass && cacheKey) {
      const cached = await getCachedEntry(c.env, cacheKey);
      if (cached) {
        const cacheStartedAt = Date.now();
        const snapshotCost = cached.billing?.cost_usd;
        const cacheCostUsd =
          cached.billing && Number.isFinite(snapshotCost)
            ? Math.max(0, snapshotCost as number)
            : computeCostUsd(billingRow, cached.usage, priceSnapshot.multiplier);
        const billingMultiplier = cached.billing?.price_multiplier ?? priceSnapshot.multiplier;
        const billingWindowId = cached.billing?.price_window_id ?? priceSnapshot.window_id;

        const charged = await admitBillingRequest(c.env, { request_id: requestId, device_id: device.id, sub_token_id: device.sub_token_id ?? null,
          model: billingRow.model_name, reserved_usd: cacheCostUsd, lease_ms: BILLING_LEASE_MS,
          monthly_service_group_ids: !isImageModel(billingRow) && (kind === "chat/completions" || kind === "responses" || kind === "messages") ? [priceSnapshot.serviceGroupId ?? null] : undefined,
          pricing_snapshot_json: JSON.stringify({cache_hit: true, cost_usd: cacheCostUsd, price_multiplier: billingMultiplier, price_window_id: billingWindowId}) });
        if (!charged) {
          const wallet = await getWallet(c.env, device.id);
          const availableUsd = Number((wallet.balance_usd - wallet.reserved_usd).toFixed(4));
          waitUntil(
            c,
            sendWebhookNotification(c.env, {
              event: "device_balance_exhausted",
              title: `⚠️【AI Gateway】设备「${device.name}」余额不足`,
              message: `设备「${device.name}」(ID: ${device.id}) 可用余额 ¥${availableUsd.toFixed(4)}，本次缓存命中需要 ¥${cacheCostUsd.toFixed(4)}，已拦截。`,
              details: {
                device_id: device.id,
                device_name: device.name,
                available_usd: availableUsd,
                estimated_cost_usd: cacheCostUsd,
                model: billingRow.model_name,
                cache_hit: true,
              },
            })
          );
          return c.json(
            {
              error: "insufficient_balance",
              message: `Device balance is too low for this request (available ¥${availableUsd.toFixed(4)}, required ¥${cacheCostUsd.toFixed(4)}). Ask the gateway owner to top it up.`,
              available_usd: availableUsd,
              estimated_cost_usd: cacheCostUsd,
            },
            429
          );
        }

        const cachedRes = createCachedResponse(cached, kind, isStream, billingRow.model_name, requestId);
        const receipt = await persistBillingTerminal(c.env, {
            outcome: "completed", usage_source: "cached_final", billing_state: "pending",
            device_id: device.id,
            sub_token_id: device.sub_token_id ?? null,
            provider_id: row.provider_id,
            provider_name: row.provider_name,
            model: billingRow.model_name,
            usage: cached.usage,
            search_calls: billableSearchCalls(cached.usage),
            cost_usd: cacheCostUsd,
            cache_hit: 1,
            pricing_missing: resolveRowPricingMode(billingRow) === "unset",
            price_multiplier: billingMultiplier,
            price_window_id: billingWindowId,
            status_code: 200,
            latency_ms: Date.now() - cacheStartedAt,
            request_id: requestId,
            created_at: cacheStartedAt,
          });
        await settleBillingRequest(c.env, requestId, receipt);
        return cachedRes;
      }
    }
  }

  const units = rawBody.length;
  const declared = Number(c.req.header("content-length") ?? "");
  const declaredBytes = Number.isFinite(declared) && declared > 0 ? Math.min(Math.floor(declared), units * 3) : 0;
  const promptBytes = Math.max(declaredBytes, units);
  const estimatedCostUsd = estimateRequestCostUsd(billingRow, body, priceSnapshot.multiplier, promptBytes);
  let reservedUsd = 0;
  const managedTextBilling = !isImageModel(billingRow) && (kind === "messages" || kind === "chat/completions" || kind === "responses");
  if (managedTextBilling) {
    const admitted = await admitBillingRequest(c.env, {
      request_id: requestId, device_id: device.id, sub_token_id: device.sub_token_id ?? null,
      model: billingRow.model_name, reserved_usd: estimatedCostUsd, lease_ms: BILLING_LEASE_MS,
      monthly_service_group_ids: [priceSnapshot.serviceGroupId ?? null],
      pricing_snapshot_json: priceSnapshot.pricingSnapshotJson ?? JSON.stringify({
        input_price_per_m: billingRow.input_price_per_m, output_price_per_m: billingRow.output_price_per_m,
        cache_read_price_per_m: billingRow.cache_read_price_per_m, cache_write_price_per_m: billingRow.cache_write_price_per_m,
        pricing_mode: billingRow.pricing_mode, billing_unit: billingRow.billing_unit,
        price_per_call: billingRow.price_per_call, search_price_per_call: billingRow.search_price_per_call,
        multiplier: priceSnapshot.multiplier, window_id: priceSnapshot.window_id,
      }),
    });
    if (!admitted) return c.json({ error: "insufficient_balance", message: "Insufficient available balance for this request." }, 429);
    reservedUsd = estimatedCostUsd;
    manageBillingRequest(c, c.env, requestId);
  } else if (estimatedCostUsd > 0) {
    const wallet = await getWallet(c.env, device.id);
    const availableUsd = Number((wallet.balance_usd - wallet.reserved_usd).toFixed(4));
    const trusted = (!device.token_routing_policy || device.token_routing_policy.source === "compatibility") && availableUsd >= estimatedCostUsd * TRUSTED_BALANCE_MULTIPLIER;
    if (!trusted) {
      const ok = await reserveBalance(c.env, device.id, estimatedCostUsd, requestId);
      if (!ok) {
        waitUntil(
          c,
          sendWebhookNotification(c.env, {
            event: "device_balance_exhausted",
            title: `⚠️【AI Gateway】设备「${device.name}」余额不足`,
            message: `设备「${device.name}」(ID: ${device.id}) 可用余额 ¥${availableUsd.toFixed(4)}，本次请求预估需要 ¥${estimatedCostUsd.toFixed(4)}，已拦截。`,
            details: {
              device_id: device.id,
              device_name: device.name,
              available_usd: availableUsd,
              estimated_cost_usd: estimatedCostUsd,
              model: billingRow.model_name,
            },
          })
        );
        return c.json(
          {
            error: "insufficient_balance",
            message: `Device balance is too low for this request (available ¥${availableUsd.toFixed(4)}, estimated ¥${estimatedCostUsd.toFixed(4)}). Ask the gateway owner to top it up.`,
            available_usd: availableUsd,
            estimated_cost_usd: estimatedCostUsd,
          },
          429
        );
      }
      reservedUsd = estimatedCostUsd;
    }
  }

  const finishUnserved = async (status: number) => {
    const managed = managedBillingRequest(c);
    if (!managed) { if (reservedUsd > 0) await releaseReserve(c.env, device.id, requestId); return; }
    if (!managed.attempt) { await abandonUndispatchedBillingRequest(c.env, requestId); return; }
    await record({ c, kind, device, row, billingRow, visibleModel: billingRow.model_name,
      upstreamStatus: managed.attempt?.httpStatus ?? 0, latencyMs: Date.now() - managed.startedAt, startedAt: managed.startedAt,
      createdAt: managed.startedAt, requestId, reservedUsd, billingAttempt: managed.attempt,
      priceMultiplier: priceSnapshot.multiplier, priceWindowId: priceSnapshot.window_id,
      serviceGroupId: priceSnapshot.serviceGroupId, serviceGroupRevision: priceSnapshot.serviceGroupRevision,
      pricingSnapshotJson: priceSnapshot.pricingSnapshotJson, billableCall: false,
    }, null, status);
  };
  try {
  if (!isGroup) row = await openLegacyAttemptKey(row);

  attempts++;
  const failure: { reason?: string } = {};
  const safeReplay = (reason: string | undefined) => Boolean(reason) && !["network_error", "client_error", "attempt_budget_exhausted"].includes(reason!);
  const safeSameMemberRetry = (reason: string | undefined) => safeReplay(reason) && isRetryableFailureReason(reason);
  const hasSuccessor = resolveRowBillingUnit(billingRow) !== "call" && (failoverCandidates.length > 0 || Boolean(fallbackModelId) || groupRetries > 0);
  let response = await executeProxyAttempt(c, kind, device, row, body, requestId, cacheKey, reservedUsd, priceSnapshot, identity, upstreamModelName, isGroup, groupReasoning, hasSuccessor, promptBytes, rawBody, failure, false, attemptBudget);
  for (let retry = 0; !response && retry < groupRetries && resolveRowBillingUnit(billingRow) !== "call" && safeSameMemberRetry(failure.reason) && attemptBudgetAvailable(attemptBudget) && !c.req.raw.signal.aborted; retry++) {
    attempts++;
    const moreAfter = failoverCandidates.length > 0 || Boolean(fallbackModelId) || retry + 1 < groupRetries;
    failure.reason = undefined;
    response = await executeProxyAttempt(c, kind, device, row, body, requestId, cacheKey, reservedUsd, priceSnapshot, identity, upstreamModelName, isGroup, groupReasoning, moreAfter, promptBytes, rawBody, failure, false, attemptBudget);
  }

  if (!response && failoverCandidates.length) {
    const perCallBilling = resolveRowBillingUnit(billingRow) === "call";
    if (legacyFailoverHealthPending && !perCallBilling && safeReplay(failure.reason) &&
        attemptBudgetAvailable(attemptBudget) && !c.req.raw.signal.aborted) {
      legacyFailoverHealthPending = false;
      failoverCandidates = demoteCoolingDown(failoverCandidates, (cand) => cand.provider_id);
      try {
        const failureStats = await getRecentProviderFailureStats(c.env);
        failoverCandidates = demoteUnhealthy(failoverCandidates, (cand) => cand.provider_id, failureStats);
      } catch {   }
    }
    for (let candidateIndex = 0; candidateIndex < failoverCandidates.length; candidateIndex++) {
      if (perCallBilling || !safeReplay(failure.reason) || !attemptBudgetAvailable(attemptBudget) || c.req.raw.signal.aborted) break;
      const nextCandidate = failoverCandidates[candidateIndex];
      let attemptRow = nextCandidate;
      if (isGroup) {
        attemptRow = await openGroupMemberKey(c.env, nextCandidate);
      } else {
        const nextQuota = await consumeModelQuota(c.env, device, nextCandidate.id, quotaLimits);
        if (nextQuota.limited) continue;
        attemptRow = await openLegacyAttemptKey(nextCandidate);
      }

      const nextCacheKey = isGroup
        ? cacheEnabled
          ? await computeCacheKey(kind, billingRow.model_name, body, device.id)
          : undefined
        : cacheEnabled && attemptRow.cache_enabled
          ? await computeCacheKey(kind, attemptRow.model_name, body, device.id)
          : undefined;
      attempts++;
      const candidateFailure: { reason?: string } = {};
      const moreAfterThis =
        candidateIndex + 1 < failoverCandidates.length || Boolean(fallbackModelId) || groupRetries > 0;
      response = await executeProxyAttempt(c, kind, device, attemptRow, body, requestId, nextCacheKey, reservedUsd, priceSnapshot, identity, isGroup ? upstreamModelName : undefined, true, groupReasoning, moreAfterThis, promptBytes, rawBody, candidateFailure, false, attemptBudget);
      for (let retry = 0; !response && retry < groupRetries && safeSameMemberRetry(candidateFailure.reason) && attemptBudgetAvailable(attemptBudget) && !c.req.raw.signal.aborted; retry++) {
        attempts++;
        const moreAfterRetry =
          candidateIndex + 1 < failoverCandidates.length || Boolean(fallbackModelId) || retry + 1 < groupRetries;
        candidateFailure.reason = undefined;
        response = await executeProxyAttempt(c, kind, device, attemptRow, body, requestId, nextCacheKey, reservedUsd, priceSnapshot, identity, isGroup ? upstreamModelName : undefined, true, groupReasoning, moreAfterRetry, promptBytes, rawBody, candidateFailure, false, attemptBudget);
      }
      failure.reason = candidateFailure.reason;
      if (response) {
        row = attemptRow;  
        break;
      }
    }
  }

  if (!response && fallbackModelId && safeReplay(failure.reason) && attemptBudgetAvailable(attemptBudget) && !c.req.raw.signal.aborted) {
    if (resolveRowBillingUnit(billingRow) !== "call") {
    const fallbackRow = await getModelWithProviderById(c.env, fallbackModelId, { includeSecrets: false });
    if (fallbackRow) {
      const isCompatible = protocolCompatible(fallbackRow);
      const isPriced = resolveRowPricingMode(fallbackRow) !== "unset";
      if (isCompatible && isPriced) {
        const fallbackQuota = await consumeModelQuota(c.env, device, fallbackRow.id, quotaLimits);
        if (fallbackQuota.limited) {
          await finishUnserved(429);
          return c.json(
            {
              error: "rate_limit_exceeded",
              message: `Model rate limit of ${fallbackQuota.limit} RPM exceeded`,
              model: fallbackRow.model_name,
            },
            429
          );
        }
        const fallbackCacheKey = cacheEnabled && fallbackRow.cache_enabled && (kind !== "chat/completions" || planProtocolRoute(fallbackRow, kind) !== "responses")
          ? await computeCacheKey(kind, fallbackRow.model_name, body, device.id)
          : undefined;
        attempts++;
        response = await executeProxyAttempt(c, kind, device, await openLegacyAttemptKey(fallbackRow), body, requestId, fallbackCacheKey, reservedUsd, priceSnapshot, identity, undefined, true, groupReasoning, false, promptBytes, rawBody, undefined, false, attemptBudget);
      }
    }
    }
  }

  if (!response) {
    waitUntil(
      c,
      sendWebhookNotification(c.env, {
        event: "provider_error",
        title: `⚠️【AI Gateway】服务商请求异常 (${row.provider_name})`,
        message: `模型「${identity.visible}」主上游服务商 (${row.provider_name}) 请求失败且无法通过故障转移恢复。`,
        details: {
          model: identity.visible,
          provider: row.provider_name,
          requestId,
        },
      })
    );
    await finishUnserved(502);
    return c.json({ error: "upstream_service_unavailable", message: "Failed to fetch response from primary and fallback upstream" }, 502);
  }

  if (attempts > 1) {
    try {
      response.headers.set("x-gateway-attempts", String(attempts));
    } catch {
    }
  }
  if (managedTextBilling && !managedBillingRequest(c)?.attempt) await finishUnserved(response.status);
  return response;
  } catch (error) {
    await finishUnserved(502);
    throw error;
  }
}

