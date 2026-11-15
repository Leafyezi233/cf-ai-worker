
export const MAX_ERROR_SNIPPET_BYTES = 4 * 1024;

export const CREDENTIAL_COOLDOWN_MS = 60_000;

export interface UpstreamFailureVerdict {
  failover: boolean;
  reason: string;
  cooldownMs?: number;
}

const PROVIDER_SCOPED_PATTERNS: Array<[RegExp, string]> = [
  [
    /model[ _-]?not[ _-]?found|model[ _-]?not[ _-]?exist|no such model|unknown model|does not exist or you do not have access/i,
    "model_not_found",
  ],
  [/does not support|not supported|unsupported[_ ]parameter|unrecognized request argument|unknown parameter/i, "unsupported_parameter"],
  [/context[ _-]?length|maximum context|too many tokens|prompt is too long|input is too long/i, "context_length_exceeded"],
  [/reasoning[_ ]?effort|thinking is not supported|does not allow thinking/i, "unsupported_reasoning"],
  [/image|vision|multimodal/i, "unsupported_modality"],
];

const REQUEST_SCOPED_PATTERNS: RegExp[] = [
  /invalid[ _]?json|unexpected token|json[ _]?parse|malformed|parse error/i,
  /schema|additional properties|is required|missing required|required property/i,
  /invalid[ _]?value|must be (?:one of|a|an|at least|at most|greater|less)|out of range/i,
  /content[ _]?policy|moderation|safety/i,
];

export function classifyUpstreamFailure(
  status: number,
  errorText: string,
  failoverOnClientError = true
): UpstreamFailureVerdict {
  if (status >= 500) return { failover: true, reason: "upstream_error" };
  if (status === 429) return { failover: true, reason: "rate_limited" };
  if (status === 408) return { failover: true, reason: "request_timeout" };

  if (status === 401 || status === 403) {
    return { failover: true, reason: "credential_rejected", cooldownMs: CREDENTIAL_COOLDOWN_MS };
  }

  if (!failoverOnClientError) return { failover: false, reason: "client_error" };

  if (status === 404) return { failover: true, reason: "endpoint_not_found" };

  if (status === 400 || status === 422 || status === 405 || status === 415) {
    for (const pattern of REQUEST_SCOPED_PATTERNS) {
      if (pattern.test(errorText)) return { failover: false, reason: "client_error" };
    }
    for (const [pattern, reason] of PROVIDER_SCOPED_PATTERNS) {
      if (pattern.test(errorText)) return { failover: true, reason };
    }
    return { failover: false, reason: "client_error" };
  }

  return { failover: false, reason: "client_error" };
}

export async function readErrorSnippet(
  res: Response,
  limit = MAX_ERROR_SNIPPET_BYTES
): Promise<string> {
  if (!res.body) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("upstream_error_snippet_timeout")), 5_000); });
  try {
    reader = res.clone().body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let read = 0;
    while (read < limit) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      const bytes = chunk.value as Uint8Array;
      read += bytes.byteLength;
      text += decoder.decode(bytes, { stream: true });
    }
    text += decoder.decode();
    return text.length > limit ? text.slice(0, limit) : text;
  } catch {
    return "";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader?.cancel().catch(() => {});
  }
}

export interface FailoverPolicy {
  failoverOnClientError: boolean;
}

export function readFailoverPolicy(configJson: string | null | undefined): FailoverPolicy {
  if (!configJson) return { failoverOnClientError: true };
  try {
    const parsed = JSON.parse(configJson);
    if (parsed && typeof parsed === "object" && typeof parsed.failover_on_client_error === "boolean") {
      return { failoverOnClientError: parsed.failover_on_client_error };
    }
  } catch {
  }
  return { failoverOnClientError: true };
}


const cooldowns = new Map<string, number>();

export function rememberCooldown(providerId: string, cooldownMs: number, now = Date.now()): void {
  if (!providerId || cooldownMs <= 0) return;
  if (cooldowns.size > 512) cooldowns.clear();
  cooldowns.set(providerId, now + cooldownMs);
}

export function isCoolingDown(providerId: string, now = Date.now()): boolean {
  const until = cooldowns.get(providerId);
  if (until === undefined) return false;
  if (until <= now) {
    cooldowns.delete(providerId);
    return false;
  }
  return true;
}

export function resetCooldowns(): void {
  cooldowns.clear();
}


export function demoteCoolingDown<T>(items: T[], providerOf: (item: T) => string): T[] {
  let cold = 0;
  for (const item of items) if (isCoolingDown(providerOf(item))) cold++;
  if (cold === 0) return items;
  const warm: T[] = [];
  const chilled: T[] = [];
  for (const item of items) (isCoolingDown(providerOf(item)) ? chilled : warm).push(item);
  return [...warm, ...chilled];
}

export const FAILURE_RATE_THRESHOLD = 0.5;
export const MIN_FAILURE_SAMPLES = 3;

export interface ProviderFailureStats {
  failureRate: number;
  samples: number;
}

export function demoteUnhealthy<T>(
  items: T[],
  providerOf: (item: T) => string,
  stats: Record<string, ProviderFailureStats>
): T[] {
  const sick = (id: string): boolean => {
    const entry = stats[id];
    if (!entry) return false;
    return entry.samples >= MIN_FAILURE_SAMPLES && entry.failureRate >= FAILURE_RATE_THRESHOLD;
  };
  let bad = 0;
  for (const item of items) if (sick(providerOf(item))) bad++;
  if (bad === 0) return items;
  const healthy: T[] = [];
  const struggling: T[] = [];
  for (const item of items) (sick(providerOf(item)) ? struggling : healthy).push(item);
  return [...healthy, ...struggling];
}


export const MAX_GROUP_MEMBER_RETRIES = 3;

export function readGroupMemberRetries(configJson: string | null | undefined): number {
  if (!configJson) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return 0;
  }
  const raw =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).member_retries
      : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(MAX_GROUP_MEMBER_RETRIES, Math.floor(raw)));
}

const RETRYABLE_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "upstream_error",  
  "rate_limited",  
  "request_timeout",  
  "network_error",  
]);

export function isRetryableFailureReason(reason?: string): boolean {
  return typeof reason === "string" && RETRYABLE_FAILURE_REASONS.has(reason);
}
