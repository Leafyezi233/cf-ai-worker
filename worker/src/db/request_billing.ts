import type { Env, TokenUsage } from "../types";
import { dailyStatsUpsertStatement, usageInsertStatement, type UsageInsertData } from "./repo";
import { ensureSchema } from "./schema";

type BillingRequest = {
  request_id: string; device_id: string; sub_token_id: string | null; model: string;
  pricing_snapshot_json: string; reserved_usd: number; billing_state: string; monthly_groups_json: string | null;
  terminal_snapshot_json: string | null; known_cost_usd: number | null;
  settled_at: number | null; lease_until: number;
};
type TerminalInput = UsageInsertData & {
  outcome?: string; usage_source?: string; usage_provenance_json?: string | null;
  attempt_id?: string | null; billing_state?: "pending" | "needs_reconciliation";
};
export type BillingTerminalReceipt = Readonly<{ requestId: string }>;
type SettlementSnapshot = Readonly<Pick<BillingRequest, "request_id" | "device_id" | "sub_token_id" | "terminal_snapshot_json" | "known_cost_usd" | "settled_at">>;
const terminalReceipts = new WeakMap<BillingTerminalReceipt, { db: Env["DB"]; row: SettlementSnapshot }>();
function terminalReceipt(env: Env, row: BillingRequest): BillingTerminalReceipt {
  const receipt = Object.freeze({ requestId: row.request_id });
  const snapshot: SettlementSnapshot = Object.freeze({
    request_id: row.request_id, device_id: row.device_id, sub_token_id: row.sub_token_id,
    terminal_snapshot_json: row.terminal_snapshot_json, known_cost_usd: row.known_cost_usd, settled_at: row.settled_at,
  });
  terminalReceipts.set(receipt, { db: env.DB, row: snapshot });
  return receipt;
}
const DEFAULT_LEASE_MS = 5 * 60 * 1000;

async function atomic(env: Env, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  const results = await env.DB.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length ||
      results.some(r => !r || !r.meta || r.success !== true)) {
    throw new Error("Billing transaction returned an invalid result; not replayed");
  }
  return results;
}
async function ready(env: Env): Promise<void> {
  await ensureSchema(env);
}
function lease(ms = DEFAULT_LEASE_MS): number {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("Invalid billing lease");
  return Math.min(Math.ceil(ms), 24 * 60 * 60 * 1000);
}
function label(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\r\n\x00]/.test(value)) {
    throw new Error("Invalid billing " + name);
  }
  return value;
}
function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid billing " + name);
  return value;
}
function metadata(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > 32768) throw new Error("Invalid billing metadata");
  const parsed: unknown = JSON.parse(value);
  const visit = (item: unknown, depth: number): void => {
    if (depth > 20) throw new Error("Billing metadata too deep");
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (/^(prompt|prompts|messages|input|output|content|body|request_body|response_body|api_key|apikey|authorization|headers|secret|secret_name|password|credential|credentials|access_token|refresh_token|token_hash)$/i.test(key)) {
        throw new Error("Sensitive data is forbidden in billing metadata");
      }
      visit(child, depth + 1);
    }
  };
  visit(parsed, 0);
  return JSON.stringify(parsed);
}
function tokenUsage(value: TokenUsage | null | undefined): TokenUsage | null {
  if (value == null) return null;
  const usage: TokenUsage = {
    input_tokens: nonnegative(value.input_tokens, "input tokens"),
    output_tokens: nonnegative(value.output_tokens, "output tokens"),
    total_tokens: nonnegative(value.total_tokens, "total tokens"),
  };
  for (const key of ["cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "search_calls"] as const) {
    if (value[key] !== undefined) usage[key] = nonnegative(value[key], key);
  }
  if (value.cache_read_included_in_input !== undefined) usage.cache_read_included_in_input = value.cache_read_included_in_input === true;
  return usage;
}
async function getRequest(env: Env, requestId: string): Promise<BillingRequest | null> {
  return env.DB.prepare("SELECT * FROM billing_requests WHERE request_id = ?").bind(requestId).first<BillingRequest>();
}

export async function admitBillingRequest(env: Env, input: {
  request_id: string; device_id: string; sub_token_id?: string | null; model: string;
  pricing_snapshot_json: string; reserved_usd: number; lease_ms?: number; monthly_service_group_ids?: (string | null)[];
}): Promise<boolean> {
  await ready(env);
  label(input.request_id, "request id"); label(input.device_id, "device id"); label(input.model, "model");
  const amount = nonnegative(input.reserved_usd, "reservation");
  const pricing = metadata(input.pricing_snapshot_json);
  if (pricing === null) throw new Error("Missing billing pricing snapshot");
  const monthlyGroups = input.monthly_service_group_ids === undefined ? null : JSON.stringify(input.monthly_service_group_ids);
  const t = Date.now(), until = t + lease(input.lease_ms), nonce = crypto.randomUUID();
  try { await atomic(env, [
    env.DB.prepare("INSERT INTO device_wallets (device_id, balance_usd, reserved_usd, created_at, updated_at) " +
      "SELECT ?, 0, 0, ?, ? WHERE EXISTS (SELECT 1 FROM devices WHERE id = ?) ON CONFLICT(device_id) DO NOTHING")
      .bind(input.device_id, t, t, input.device_id),
    env.DB.prepare("INSERT INTO billing_requests (request_id, device_id, sub_token_id, model, pricing_snapshot_json, reserved_usd, admission_nonce, lease_until, created_at, updated_at, monthly_groups_json) " +
      "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM device_wallets WHERE device_id = ? AND (? = 0 OR balance_usd - reserved_usd >= ? OR EXISTS (SELECT 1 FROM monthly_pass_accounts WHERE device_id = device_wallets.device_id AND ? IS NOT NULL)) " +
      "AND EXISTS (SELECT 1 FROM devices WHERE id = ?) " +
      "AND (? IS NULL OR EXISTS (SELECT 1 FROM device_sub_tokens WHERE id = ? AND device_id = ?)) " +
      "AND NOT EXISTS (SELECT 1 FROM reserve_holds WHERE request_id = ?) " +
      "AND NOT EXISTS (SELECT 1 FROM wallet_ledger WHERE request_id = ? AND reason = 'usage') " +
      "AND NOT EXISTS (SELECT 1 FROM usage WHERE request_id = ?) " +
      "AND NOT EXISTS (SELECT 1 FROM usage_rollup_receipts WHERE request_id = ?) ON CONFLICT(request_id) DO NOTHING")
      .bind(input.request_id, input.device_id, input.sub_token_id ?? null, input.model, pricing, amount, nonce, until, t, t, monthlyGroups,
        input.device_id, amount, amount, input.monthly_service_group_ids === undefined ? null : 1, input.device_id, input.sub_token_id ?? null, input.sub_token_id ?? null, input.device_id,
        input.request_id, input.request_id, input.request_id, input.request_id),
    env.DB.prepare("INSERT INTO reserve_holds (request_id, device_id, amount_usd, created_at) " +
      "SELECT request_id, device_id, COALESCE((SELECT wallet_reserved_usd FROM monthly_pass_funding f WHERE f.request_id=billing_requests.request_id),reserved_usd), ? FROM billing_requests WHERE request_id = ? AND admission_nonce = ?")
      .bind(t, input.request_id, nonce),
    env.DB.prepare("UPDATE device_wallets SET reserved_usd = reserved_usd + COALESCE((SELECT amount_usd FROM reserve_holds WHERE request_id=?),0), updated_at = ? WHERE device_id = ? AND changes() = 1")
      .bind(input.request_id, t, input.device_id),
  ]); } catch (error) {
    if (/^(?:Error: )?(?:D1_ERROR: )?monthly_pass_unavailable(?:: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)?$/.test(String(error))) return false;
    throw error;
  }
  const row = await env.DB.prepare("SELECT r.* FROM billing_requests r JOIN reserve_holds h ON h.request_id = r.request_id " +
    "AND h.device_id = r.device_id AND h.amount_usd = COALESCE((SELECT wallet_reserved_usd FROM monthly_pass_funding f WHERE f.request_id=r.request_id),r.reserved_usd) WHERE r.request_id = ?")
    .bind(input.request_id).first<BillingRequest>();
  return !!row && row.device_id === input.device_id && row.sub_token_id === (input.sub_token_id ?? null) &&
    row.model === input.model && row.pricing_snapshot_json === pricing && row.reserved_usd === amount &&
    row.monthly_groups_json === monthlyGroups &&
    row.billing_state === "active" && row.terminal_snapshot_json === null && row.lease_until > Date.now();
}

export async function beginBillingAttempt(env: Env, input: {
  request_id: string; provider_id: string; model: string; protocol: string;
}): Promise<string> {
  await ready(env);
  label(input.provider_id, "provider"); label(input.model, "model"); label(input.protocol, "protocol");
  const id = crypto.randomUUID(), t = Date.now();
  const results = await atomic(env, [env.DB.prepare(
    "INSERT INTO billing_attempts (id, request_id, attempt_number, provider_id, model, protocol, created_at, updated_at) " +
    "SELECT ?, r.request_id, COALESCE((SELECT MAX(attempt_number) FROM billing_attempts WHERE request_id = r.request_id), 0) + 1, ?, ?, ?, ?, ? " +
    "FROM billing_requests r WHERE r.request_id = ? AND r.billing_state = 'active' AND r.terminal_snapshot_json IS NULL AND r.lease_until > ?"
  ).bind(id, input.provider_id, input.model, input.protocol, t, t, input.request_id, t)]);
  if (Number(results[0].meta.changes) !== 1) throw new Error("Billing request is not active");
  return id;
}

export async function observeBillingAttempt(env: Env, attemptId: string, input: {
  usage?: TokenUsage | null; usage_source?: string; provenance_json?: string | null;
  outcome?: string; upstream_request_id?: string | null;
}): Promise<void> {
  await ready(env);
  const usage = input.usage === undefined ? null : JSON.stringify(tokenUsage(input.usage));
  const provenance = metadata(input.provenance_json);
  if (input.usage_source !== undefined) label(input.usage_source, "usage source");
  if (input.outcome !== undefined) label(input.outcome, "outcome");
  if (input.upstream_request_id != null) label(input.upstream_request_id, "upstream request id");
  const results = await atomic(env, [env.DB.prepare(
    "UPDATE billing_attempts SET usage_json = CASE WHEN ? THEN ? ELSE usage_json END, " +
    "usage_source = COALESCE(?, usage_source), provenance_json = CASE WHEN ? THEN ? ELSE provenance_json END, " +
    "outcome = COALESCE(?, outcome), upstream_request_id = CASE WHEN ? THEN ? ELSE upstream_request_id END, updated_at = ? " +
    "WHERE id = ? AND EXISTS (SELECT 1 FROM billing_requests r WHERE r.request_id = billing_attempts.request_id AND r.terminal_snapshot_json IS NULL AND r.settled_at IS NULL)"
  ).bind(input.usage !== undefined ? 1 : 0, usage, input.usage_source ?? null,
    input.provenance_json !== undefined ? 1 : 0, provenance, input.outcome ?? null,
    input.upstream_request_id !== undefined ? 1 : 0, input.upstream_request_id ?? null, Date.now(), attemptId)]);
  if (Number(results[0].meta.changes) !== 1) throw new Error("Billing attempt is missing or terminal is frozen");
}

export async function heartbeatBillingRequest(env: Env, requestId: string, leaseMs?: number): Promise<void> {
  await ready(env);
  const t = Date.now();
  const results = await atomic(env, [env.DB.prepare("UPDATE billing_requests SET lease_until = MAX(lease_until, ?), updated_at = ? " +
    "WHERE request_id = ? AND billing_state = 'active' AND terminal_snapshot_json IS NULL AND lease_until > ?")
    .bind(t + lease(leaseMs), t, requestId, t)]);
  if (Number(results[0].meta.changes) !== 1) throw new Error("Billing request lease is not active");
}

export async function persistBillingTerminal(env: Env, data: TerminalInput): Promise<BillingTerminalReceipt> {
  await ready(env);
  const row = await env.DB.prepare("SELECT r.*, EXISTS (SELECT 1 FROM billing_attempts a WHERE a.id = ? AND a.request_id = r.request_id) AS terminal_attempt_matches " +
    "FROM billing_requests r WHERE r.request_id = ?")
    .bind(data.attempt_id ?? null, data.request_id).first<BillingRequest & { terminal_attempt_matches: number }>();
  if (!row || row.device_id !== data.device_id || row.sub_token_id !== (data.sub_token_id ?? null)) {
    throw new Error("Billing terminal owner mismatch");
  }
  if (row.terminal_snapshot_json !== null) return terminalReceipt(env, row);
  if (data.billing_state !== undefined && data.billing_state !== "pending" && data.billing_state !== "needs_reconciliation") {
    throw new Error("Invalid terminal billing state");
  }
  if (data.attempt_id != null && Number(row.terminal_attempt_matches) !== 1) {
    throw new Error("Billing terminal attempt mismatch");
  }
  const knownCost = data.cost_usd === undefined ? null : nonnegative(data.cost_usd, "cost");
  const usage = tokenUsage(data.usage), provenance = metadata(data.usage_provenance_json);
  const snapshot: UsageInsertData = {
    request_id: row.request_id, device_id: row.device_id, sub_token_id: row.sub_token_id,
    provider_id: data.provider_id == null ? null : label(data.provider_id, "provider"),
    provider_name: data.provider_name == null ? null : label(data.provider_name, "provider name"),
    model: data.model == null ? row.model : label(data.model, "model"), usage,
    ...(knownCost === null ? {} : { cost_usd: knownCost }),
    cache_hit: data.cache_hit ? 1 : 0, pricing_missing: data.pricing_missing === true,
    price_multiplier: nonnegative(data.price_multiplier ?? 1, "price multiplier"),
    price_window_id: data.price_window_id == null ? null : label(data.price_window_id, "price window"),
    status_code: data.status_code == null ? null : nonnegative(data.status_code, "status code"),
    latency_ms: data.latency_ms == null ? null : nonnegative(data.latency_ms, "latency"),
    created_at: nonnegative(data.created_at, "terminal timestamp"),
    image_count: nonnegative(data.image_count ?? 0, "image count"),
    search_calls: nonnegative(data.search_calls ?? usage?.search_calls ?? 0, "search calls"),
    service_group_id: data.service_group_id == null ? null : label(data.service_group_id, "service group"),
    service_group_revision: data.service_group_revision == null ? null : nonnegative(data.service_group_revision, "service group revision"),
    pricing_snapshot_json: metadata(data.pricing_snapshot_json) ?? row.pricing_snapshot_json,
  };
  const state = knownCost === null || data.billing_state === "needs_reconciliation" || data.outcome === "unknown"
    ? "needs_reconciliation" : "pending";
  const outcome = label(data.outcome ?? "completed", "outcome"), source = label(data.usage_source ?? "unknown", "usage source");
  const snapshotJson = JSON.stringify(snapshot);
  const results = await atomic(env, [env.DB.prepare("UPDATE billing_requests SET terminal_snapshot_json = ?, known_cost_usd = ?, terminal_attempt_id = ?, " +
    "terminal_at = ?, outcome = ?, usage_source = ?, usage_provenance_json = ?, " +
    "billing_state = CASE WHEN billing_state = 'needs_reconciliation' THEN billing_state ELSE ? END, updated_at = ? " +
    "WHERE request_id = ? AND device_id = ? AND sub_token_id IS ? AND terminal_snapshot_json IS NULL AND settled_at IS NULL " +
    "AND (? IS NULL OR EXISTS (SELECT 1 FROM billing_attempts a WHERE a.id = ? AND a.request_id = billing_requests.request_id))")
    .bind(snapshotJson, knownCost, data.attempt_id ?? null, Date.now(), outcome, source, provenance, state, Date.now(),
      row.request_id, row.device_id, row.sub_token_id, data.attempt_id ?? null, data.attempt_id ?? null)]);
  if (Number(results[0].meta.changes) !== 1) {
    const current = await getRequest(env, data.request_id);
    if (!current || current.device_id !== data.device_id || current.sub_token_id !== (data.sub_token_id ?? null)) {
      throw new Error("Billing terminal owner mismatch");
    }
    if (current.terminal_snapshot_json === null) throw new Error("Billing terminal was not persisted");
    return terminalReceipt(env, current);
  }
  return terminalReceipt(env, { ...row, terminal_snapshot_json: snapshotJson, known_cost_usd: knownCost });
}

async function settle(env: Env, requestId: string, persisted?: SettlementSnapshot): Promise<boolean> {
  const row = persisted ?? await getRequest(env, requestId);
  if (!row) throw new Error("Unknown billing request");
  if (row.settled_at !== null || row.terminal_snapshot_json === null || row.known_cost_usd === null) return false;
  const data = JSON.parse(row.terminal_snapshot_json) as UsageInsertData;
  if (data.request_id !== row.request_id || data.device_id !== row.device_id ||
      (data.sub_token_id ?? null) !== row.sub_token_id || data.cost_usd !== row.known_cost_usd) {
    throw new Error("Invalid durable billing snapshot");
  }
  const charge = nonnegative(row.known_cost_usd, "durable cost"), nonce = crypto.randomUUID(), t = Date.now();
  const owned = "EXISTS (SELECT 1 FROM billing_requests WHERE request_id = ? AND settlement_nonce = ? AND settled_at IS NULL)";
  const claim = { request_id: requestId, nonce };
  const walletCharge = "CASE WHEN EXISTS(SELECT 1 FROM monthly_pass_funding WHERE request_id=? AND subscription_id IS NOT NULL) THEN 0 ELSE ? END";
  const results = await atomic(env, [
    env.DB.prepare("UPDATE billing_requests SET settlement_nonce = ? WHERE request_id = ? AND device_id = ? AND sub_token_id IS ? AND settled_at IS NULL " +
      "AND billing_state IN ('pending','needs_reconciliation') AND terminal_snapshot_json = ? AND known_cost_usd = ? " +
      "AND EXISTS (SELECT 1 FROM device_wallets WHERE device_id = billing_requests.device_id) " +
      "AND NOT EXISTS (SELECT 1 FROM reserve_holds WHERE request_id = billing_requests.request_id AND device_id <> billing_requests.device_id)")
      .bind(nonce, requestId, row.device_id, row.sub_token_id, row.terminal_snapshot_json, charge),
    env.DB.prepare("INSERT INTO wallet_ledger (device_id, delta_usd, balance_after, reason, request_id, note, created_at) " +
      "SELECT ?, -(" + walletCharge + "), balance_usd - (" + walletCharge + "), 'usage', ?, ?, ? FROM device_wallets WHERE device_id = ? AND " + owned)
      .bind(row.device_id, requestId, charge, requestId, charge, requestId, "delayed billing", t, row.device_id, requestId, nonce),
    usageInsertStatement(env, data, claim), dailyStatsUpsertStatement(env, data, claim),
    env.DB.prepare("UPDATE devices SET last_used_at = ? WHERE id = ? AND " + owned).bind(t, row.device_id, requestId, nonce),
    ...(row.sub_token_id ? [env.DB.prepare("UPDATE device_sub_tokens SET last_used_at = ? WHERE id = ? AND device_id = ? AND " + owned)
      .bind(t, row.sub_token_id, row.device_id, requestId, nonce)] : []),
    env.DB.prepare("UPDATE device_wallets SET balance_usd = balance_usd - (" + walletCharge + "), reserved_usd = MAX(0, reserved_usd - COALESCE(" +
      "(SELECT MAX(0, amount_usd) FROM reserve_holds WHERE request_id = ? AND device_id = ?), 0)), updated_at = ? WHERE device_id = ? AND " + owned)
      .bind(requestId, charge, requestId, row.device_id, t, row.device_id, requestId, nonce),
    env.DB.prepare("DELETE FROM reserve_holds WHERE request_id = ? AND device_id = ? AND " + owned)
      .bind(requestId, row.device_id, requestId, nonce),
    env.DB.prepare("UPDATE billing_requests SET settled_at = ?, hold_released_at = COALESCE(hold_released_at, ?), " +
      "billing_state = CASE WHEN billing_state = 'needs_reconciliation' THEN billing_state ELSE 'settled' END, settlement_nonce = NULL, updated_at = ? " +
      "WHERE request_id = ? AND settlement_nonce = ? AND settled_at IS NULL")
      .bind(t, t, t, requestId, nonce),
  ]);
  if (Number(results[0].meta.changes) === 0) {
    const current = await getRequest(env, requestId);
    if (!current) throw new Error("Unknown billing request");
    if (current.settled_at === null) throw new Error("Billing settlement could not claim its owner wallet");
    return false;
  }
  return true;
}
export async function settleBillingRequest(env: Env, requestId: string, receipt?: BillingTerminalReceipt): Promise<void> {
  await ready(env);
  const persisted = receipt === undefined ? undefined : terminalReceipts.get(receipt);
  if (receipt !== undefined && (!persisted || persisted.db !== env.DB || persisted.row.request_id !== requestId)) {
    throw new Error("Invalid billing terminal receipt");
  }
  await settle(env, requestId, persisted?.row);
}

export async function abandonUndispatchedBillingRequest(env: Env, requestId: string): Promise<void> {
  await ready(env);
  const t = Date.now(), nonce = crypto.randomUUID();
  const owned = "EXISTS (SELECT 1 FROM billing_requests WHERE request_id = ? AND settlement_nonce = ? AND settled_at IS NULL)";
  await atomic(env, [
    env.DB.prepare("UPDATE billing_requests SET settlement_nonce = ? WHERE request_id = ? AND billing_state = 'active' AND terminal_snapshot_json IS NULL AND settled_at IS NULL AND NOT EXISTS (SELECT 1 FROM billing_attempts WHERE request_id = billing_requests.request_id)")
      .bind(nonce, requestId),
    env.DB.prepare("UPDATE device_wallets SET reserved_usd = MAX(0, reserved_usd - COALESCE((SELECT amount_usd FROM reserve_holds WHERE request_id = ? AND device_id = device_wallets.device_id), 0)), updated_at = ? WHERE device_id = (SELECT device_id FROM billing_requests WHERE request_id = ?) AND " + owned)
      .bind(requestId, t, requestId, requestId, nonce),
    env.DB.prepare("DELETE FROM reserve_holds WHERE request_id = ? AND " + owned).bind(requestId, requestId, nonce),
    env.DB.prepare("UPDATE billing_requests SET billing_state = 'settled', outcome = 'not_dispatched', known_cost_usd = 0, settled_at = ?, hold_released_at = ?, updated_at = ?, settlement_nonce = NULL WHERE request_id = ? AND settlement_nonce = ?")
      .bind(t, t, t, requestId, nonce),
  ]);
}

export async function recoverBillingRequests(env: Env, limit = 100): Promise<{ settled: number; expired: number }> {
  await ready(env);
  if (!Number.isFinite(limit) || limit < 0) throw new Error("Invalid billing recovery limit");
  const bounded = Math.min(200, Math.floor(limit));
  if (bounded === 0) return { settled: 0, expired: 0 };
  const pendingLimit = Math.max(1, Math.ceil(bounded * .75));
  const failures: unknown[] = [];
  const pending = await env.DB.prepare("SELECT request_id FROM billing_requests WHERE billing_state IN ('pending','needs_reconciliation') " +
    "AND settled_at IS NULL AND known_cost_usd IS NOT NULL AND terminal_snapshot_json IS NOT NULL ORDER BY updated_at LIMIT ?")
    .bind(pendingLimit).all<{ request_id: string }>();
  let settled = 0, expired = 0;
  for (const row of pending.results) {
    try { if (await settle(env, row.request_id)) settled++; } catch (error) { failures.push(error); }
  }
  const remaining = bounded - pending.results.length;
  if (remaining === 0) { if (failures.length) throw failures[0]; return { settled, expired }; }
  const t = Date.now();
  const stale = await env.DB.prepare("SELECT request_id, device_id FROM billing_requests WHERE billing_state IN ('active','needs_reconciliation') " +
    "AND settled_at IS NULL AND hold_released_at IS NULL AND lease_until <= ? AND known_cost_usd IS NULL ORDER BY lease_until LIMIT ?")
    .bind(t, remaining).all<{ request_id: string; device_id: string }>();
  for (const row of stale.results) {
    try {
      const nonce = crypto.randomUUID();
      const owned = "EXISTS (SELECT 1 FROM billing_requests WHERE request_id = ? AND settlement_nonce = ? AND settled_at IS NULL)";
      const results = await atomic(env, [
        env.DB.prepare("UPDATE billing_requests SET settlement_nonce = ?, billing_state = 'needs_reconciliation', " +
          "outcome = COALESCE(outcome, 'unknown'), updated_at = ? WHERE request_id = ? AND billing_state IN ('active','needs_reconciliation') " +
          "AND settled_at IS NULL AND hold_released_at IS NULL AND lease_until <= ? AND known_cost_usd IS NULL")
          .bind(nonce, t, row.request_id, t),
        env.DB.prepare("UPDATE device_wallets SET reserved_usd = MAX(0, reserved_usd - COALESCE(" +
          "(SELECT MAX(0, amount_usd) FROM reserve_holds WHERE request_id = ? AND device_id = ?), 0)), updated_at = ? " +
          "WHERE device_id = ? AND " + owned)
          .bind(row.request_id, row.device_id, t, row.device_id, row.request_id, nonce),
        env.DB.prepare("DELETE FROM reserve_holds WHERE request_id = ? AND device_id = ? AND " + owned)
          .bind(row.request_id, row.device_id, row.request_id, nonce),
        env.DB.prepare("UPDATE billing_attempts SET outcome = 'unknown', updated_at = ? WHERE request_id = ? AND outcome = 'started' AND " + owned)
          .bind(t, row.request_id, row.request_id, nonce),
        env.DB.prepare("UPDATE billing_requests SET hold_released_at = ?, settlement_nonce = NULL WHERE request_id = ? AND settlement_nonce = ?")
          .bind(t, row.request_id, nonce),
      ]);
      if (Number(results[0].meta.changes) === 1) expired++;
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
  return { settled, expired };
}
