
import type { Context } from "hono";
import type { AuthedDevice, Env, ModelWithProvider } from "../types";
import { managedBillingRequest, type BillingObservation } from "./billing_lifecycle";

export function waitUntil(c: Context<{ Bindings: Env }>, p: Promise<any>) {
  const ctx = (c as any).executionCtx as ExecutionContext | undefined;
  if (ctx?.waitUntil) ctx.waitUntil(p);
  else void p;
}

export async function completeBilling(c: Context<{ Bindings: Env }>, p: Promise<unknown>): Promise<void> {
  if (managedBillingRequest(c)) await p;
  else waitUntil(c, p);
}

export type GatewayKind = "messages" | "chat/completions" | "responses" | "images/generations" | "embeddings";

export interface ProxyContext {
  c: Context<{ Bindings: Env }>;
  kind: GatewayKind;
  upstreamKind?: GatewayKind;
  billingAttempt?: BillingObservation;
  startedAt: number;
  device: AuthedDevice;
  row: ModelWithProvider;
  billingRow: ModelWithProvider;
  visibleModel: string;
  billableCall?: boolean;
  upstreamStatus: number;
  latencyMs: number;
  requestId: string;
  createdAt: number;
  cacheKey?: string;
  reservedUsd?: number;
  priceMultiplier?: number;
  priceWindowId?: string | null;
  serviceGroupId?: string | null;
  serviceGroupRevision?: number | null;
  pricingSnapshotJson?: string | null;
  estimatedInputTokens?: number;
  sentModel?: string;
}

