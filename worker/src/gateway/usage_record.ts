
import type { ModelWithProvider, TokenUsage } from "../types";
import { ProxyContext } from "./proxy_context";
import { resolveRowPricingMode, resolveRowBillingUnit, billableSearchCalls, computeCostUsd } from "./pricing";
import { recordUsageSafe, settleBalance } from "../db/repo";
import { type CacheBillingSnapshot } from "./cache";
import { persistBillingTerminal, settleBillingRequest } from "../db/request_billing";
import { managedBillingRequest } from "./billing_lifecycle";

export async function record(
  ctx: ProxyContext,
  usage: TokenUsage | null,
  statusCode: number
): Promise<{ costUsd: number }> {
  const managed = managedBillingRequest(ctx.c);
  if (!managed) return recordOnce(ctx, usage, statusCode);
  if (managed.settlement) return managed.settlement;
  const pending = recordOnce(ctx, usage, statusCode);
  managed.settlement = pending;
  try { return await pending; } catch (error) { managed.settlement = undefined; throw error; }
}

async function recordOnce(ctx: ProxyContext, usage: TokenUsage | null, statusCode: number): Promise<{ costUsd: number }> {
  const managed = managedBillingRequest(ctx.c);
  const observed = ctx.billingAttempt?.meter.snapshot();
  if (observed?.usage) usage = observed.usage;
  const outcome = ctx.billingAttempt?.outcome;
  if (outcome === "cancelled") statusCode = 499;
  else if (outcome === "timeout") statusCode = 504;
  else if (statusCode < 400 && (outcome === "upstream_error" || observed?.failed || (ctx.billingAttempt?.streaming && !observed?.completed && outcome === "unknown"))) statusCode = 502;
  const billingRow = ctx.billingRow ?? ctx.row;
  const pricingMode = resolveRowPricingMode(billingRow);
  const priceMultiplier = ctx.priceMultiplier ?? 1;
  const billedCalls = statusCode < 200 || statusCode >= 300 || ctx.billableCall === false ? 0 : 1;
  const costUsd = computeCostUsd(
    billingRow,
    usage,
    priceMultiplier,
    billedCalls,
    statusCode >= 400 ? 0 : undefined
  );
  const pricingMissing = pricingMode === "unset";

  const data = {
    device_id: ctx.device.id,
    sub_token_id: ctx.device.sub_token_id ?? null,
    service_group_id: ctx.serviceGroupId ?? null,
    service_group_revision: ctx.serviceGroupRevision ?? null,
    pricing_snapshot_json: ctx.pricingSnapshotJson ?? null,
    provider_id: ctx.row.provider_id,
    provider_name: ctx.row.provider_name,
    model: billingRow.model_name,
    usage,
    image_count: 0,
    search_calls: statusCode >= 400 ? 0 : billableSearchCalls(usage),
    cost_usd: costUsd,
    cache_hit: 0,
    pricing_missing: pricingMissing,
    price_multiplier: priceMultiplier,
    price_window_id: ctx.priceWindowId ?? null,
    status_code: statusCode,
    latency_ms: ctx.latencyMs,
    request_id: ctx.requestId,
    created_at: ctx.createdAt,
  };
  if (managed) {
    ctx.billingAttempt?.stop();
    const source = observed?.usage ? observed.source : usage ? "estimated" : "unknown";
    const knownZero = !ctx.billingAttempt || (ctx.upstreamStatus >= 400 && !observed?.usage && outcome !== "timeout" && outcome !== "cancelled");
    const knownCall = resolveRowBillingUnit(billingRow) === "call" && (observed?.completed === true
      || (observed?.failed === true && outcome !== "cancelled" && outcome !== "timeout")
      || (!ctx.billingAttempt?.streaming && ctx.billableCall === true && ctx.upstreamStatus >= 200 && ctx.upstreamStatus < 300));
    const reconciled = source === "reported_final" || knownZero || knownCall;
    const terminal: Parameters<typeof persistBillingTerminal>[1] = {
      ...data, outcome: knownZero ? "upstream_error" : outcome === "unknown" && observed?.completed ? "completed" : outcome ?? "unknown",
      usage_source: source, usage_provenance_json: JSON.stringify(observed?.provenance ?? {}),
      attempt_id: ctx.billingAttempt?.attemptId ?? null, billing_state: reconciled ? "pending" : "needs_reconciliation",
    };
    if ((!usage || resolveRowBillingUnit(billingRow) === "call") && !knownZero && !knownCall && resolveRowPricingMode(billingRow) !== "free") delete terminal.cost_usd;
    const receipt = await persistBillingTerminal(ctx.c.env, terminal);
    if (terminal.cost_usd !== undefined) await settleBillingRequest(ctx.c.env, ctx.requestId, receipt);
    return { costUsd: terminal.cost_usd ?? 0 };
  }
  await recordUsageSafe(ctx.c.env, data);

  const held = ctx.reservedUsd ?? 0;
  if (costUsd > 0 || held > 0) {
    await settleBalance(ctx.c.env, ctx.device.id, held, costUsd, ctx.requestId);
  }

  return { costUsd };
}

export function buildBillingSnapshot(
  row: ModelWithProvider,
  costUsd: number,
  ctx: ProxyContext
): CacheBillingSnapshot {
  return {
    cost_usd: Number.isFinite(costUsd) ? costUsd : 0,
    price_multiplier: ctx.priceMultiplier ?? 1,
    price_window_id: ctx.priceWindowId ?? null,
    input_price_per_m: row.input_price_per_m || 0,
    output_price_per_m: row.output_price_per_m || 0,
    cache_read_price_per_m: row.cache_read_price_per_m || 0,
    cache_write_price_per_m: row.cache_write_price_per_m || 0,
    pricing_mode: resolveRowPricingMode(row),
    billed_at: ctx.createdAt,
  };
}

