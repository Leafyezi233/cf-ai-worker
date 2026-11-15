import { beforeEach, describe, expect, it } from "vitest";
import {
  CREDENTIAL_COOLDOWN_MS,
  FAILURE_RATE_THRESHOLD,
  MAX_ERROR_SNIPPET_BYTES,
  MIN_FAILURE_SAMPLES,
  classifyUpstreamFailure,
  demoteCoolingDown,
  demoteUnhealthy,
  isCoolingDown,
  readErrorSnippet,
  readFailoverPolicy,
  rememberCooldown,
  resetCooldowns,
} from "../src/gateway/failover";


interface Case {
  name: string;
  status: number;
  text?: string;
  policy?: boolean;
  failover: boolean;
  reason: string;
  cooldown?: number;
}

const CASES: Case[] = [
  { name: "a dead provider is retried elsewhere", status: 500, failover: true, reason: "upstream_error" },
  { name: "a 502 is a dead provider too", status: 502, failover: true, reason: "upstream_error" },
  { name: "a 503 is a dead provider too", status: 503, failover: true, reason: "upstream_error" },
  { name: "rate limiting is per provider", status: 429, failover: true, reason: "rate_limited" },
  { name: "a gateway timeout is per provider", status: 408, failover: true, reason: "request_timeout" },
  {
    name: "a rejected credential is ours, so the next provider is tried and this one cooled down",
    status: 401,
    failover: true,
    reason: "credential_rejected",
    cooldown: CREDENTIAL_COOLDOWN_MS,
  },
  {
    name: "a 403 is the same story as a 401",
    status: 403,
    failover: true,
    reason: "credential_rejected",
    cooldown: CREDENTIAL_COOLDOWN_MS,
  },
  {
    name: "a rejected credential fails over even when client errors are pinned in place",
    status: 401,
    policy: false,
    failover: true,
    reason: "credential_rejected",
    cooldown: CREDENTIAL_COOLDOWN_MS,
  },
  { name: "a missing endpoint is per provider", status: 404, failover: true, reason: "endpoint_not_found" },
  {
    name: "a 404 with client errors pinned stays put",
    status: 404,
    policy: false,
    failover: false,
    reason: "client_error",
  },
  {
    name: "a model this provider does not carry is carried by another",
    status: 400,
    text: JSON.stringify({
      error: {
        message: "The model gpt-4 does not exist or you do not have access to it",
        type: "invalid_request_error",
        code: "model_not_found",
      },
    }),
    failover: true,
    reason: "model_not_found",
  },
  {
    name: "the other common wording for a missing model",
    status: 400,
    text: "no such model: anthropic/claude-3",
    failover: true,
    reason: "model_not_found",
  },
  {
    name: "an unsupported parameter is a fact about that provider",
    status: 400,
    text: JSON.stringify({ error: { message: "unsupported parameter: top_k" } }),
    failover: true,
    reason: "unsupported_parameter",
  },
  {
    name: "a context window too small is a fact about that provider",
    status: 400,
    text: "This model has a maximum context of 8192 tokens",
    failover: true,
    reason: "context_length_exceeded",
  },
  {
    name: "a provider that rejects the reasoning level is not the only provider",
    status: 400,
    text: "unsupported reasoning effort for this model",
    failover: true,
    reason: "unsupported_reasoning",
  },
  {
    name: "a provider without vision is a fact about that provider",
    status: 400,
    text: "vision is unavailable for this deployment",
    failover: true,
    reason: "unsupported_modality",
  },
  {
    name: "a 422 naming the provider is retried too",
    status: 422,
    text: "unknown parameter: seed",
    failover: true,
    reason: "unsupported_parameter",
  },
  {
    name: "a caller\u2019s broken JSON is not retried anywhere",
    status: 400,
    text: "Unexpected token < in JSON at position 0",
    failover: false,
    reason: "client_error",
  },
  {
    name: "a schema complaint is about the request",
    status: 400,
    text: JSON.stringify({ error: { message: "Invalid schema: additional properties are not allowed" } }),
    failover: false,
    reason: "client_error",
  },
  {
    name: "an out-of-range value is about the request",
    status: 400,
    text: "invalid value for temperature: must be at most 2",
    failover: false,
    reason: "client_error",
  },
  {
    name: "a content policy refusal would be refused by every provider",
    status: 400,
    text: JSON.stringify({ error: { message: "Your request was rejected by the content policy" } }),
    failover: false,
    reason: "client_error",
  },
  {
    name: "a request-scoped complaint wins over a provider-shaped word in the same body",
    status: 400,
    text: JSON.stringify({ error: { message: "invalid value: image size must be one of 256, 512" } }),
    failover: false,
    reason: "client_error",
  },
  {
    name: "an unclassifiable 400 keeps the old behaviour",
    status: 400,
    text: "nope",
    failover: false,
    reason: "client_error",
  },
  {
    name: "an unclassifiable 422 keeps the old behaviour",
    status: 422,
    failover: false,
    reason: "client_error",
  },
  { name: "a 405 is not retried", status: 405, failover: false, reason: "client_error" },
  { name: "a 415 is not retried", status: 415, text: "unsupported media type", failover: false, reason: "client_error" },
  {
    name: "an administrator can pin every client error back to no failover",
    status: 400,
    text: "no such model: gone",
    policy: false,
    failover: false,
    reason: "client_error",
  },
];

describe("classifyUpstreamFailure decides whose failure it was", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const verdict = classifyUpstreamFailure(c.status, c.text ?? "", c.policy ?? true);
      expect(verdict.failover).toBe(c.failover);
      expect(verdict.reason).toBe(c.reason);
      expect(verdict.cooldownMs).toBe(c.cooldown);
    });
  }
});

describe("the error snippet is bounded and does not eat the answer", () => {
  it("reads a short body whole", async () => {
    const text = await readErrorSnippet(new Response("model not found"));
    expect(text).toBe("model not found");
  });

  it("stops at the documented budget", async () => {
    const huge = "x".repeat(MAX_ERROR_SNIPPET_BYTES * 3);
    const text = await readErrorSnippet(new Response(huge));
    expect(text.length).toBeLessThanOrEqual(MAX_ERROR_SNIPPET_BYTES);
    expect(text.length).toBeGreaterThan(0);
  });

  it("leaves the original body readable for the caller who gets it relayed", async () => {
    const res = new Response(JSON.stringify({ error: { message: "model not found" } }));
    const snippet = await readErrorSnippet(res);
    expect(snippet).toContain("model not found");
    expect(await res.text()).toContain("model not found");
  });

  it("says nothing about a body it cannot read", async () => {
    const broken = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("connection reset"));
        },
      })
    );
    await expect(readErrorSnippet(broken)).resolves.toBe("");
  });

  it("handles an answer with no body at all", async () => {
    await expect(readErrorSnippet(new Response(null))).resolves.toBe("");
  });
});

describe("the per-model failover policy", () => {
  it("defaults to retrying provider-scoped client errors", () => {
    expect(readFailoverPolicy(null)).toEqual({ failoverOnClientError: true });
    expect(readFailoverPolicy(undefined)).toEqual({ failoverOnClientError: true });
    expect(readFailoverPolicy("")).toEqual({ failoverOnClientError: true });
    expect(readFailoverPolicy("{}")).toEqual({ failoverOnClientError: true });
  });

  it("honours an explicit switch in either direction", () => {
    expect(readFailoverPolicy(JSON.stringify({ failover_on_client_error: false }))).toEqual({
      failoverOnClientError: false,
    });
    expect(readFailoverPolicy(JSON.stringify({ failover_on_client_error: true }))).toEqual({
      failoverOnClientError: true,
    });
  });

  it("never lets a config it cannot read disable the retry", () => {
    expect(readFailoverPolicy("{not json")).toEqual({ failoverOnClientError: true });
    expect(readFailoverPolicy(JSON.stringify({ failover_on_client_error: "no" }))).toEqual({
      failoverOnClientError: true,
    });
    expect(readFailoverPolicy(JSON.stringify({ failover_on_client_error: 0 }))).toEqual({
      failoverOnClientError: true,
    });
  });
});

describe("a provider that rejected our credential is passed over for a while", () => {
  beforeEach(() => {
    resetCooldowns();
  });

  it("is cold only inside its window", () => {
    rememberCooldown("prov_a", CREDENTIAL_COOLDOWN_MS, 1000);
    expect(isCoolingDown("prov_a", 1000)).toBe(true);
    expect(isCoolingDown("prov_a", 1000 + CREDENTIAL_COOLDOWN_MS - 1)).toBe(true);
    expect(isCoolingDown("prov_a", 1000 + CREDENTIAL_COOLDOWN_MS)).toBe(false);
  });

  it("forgets a provider nobody asked about", () => {
    expect(isCoolingDown("prov_never_seen")).toBe(false);
    rememberCooldown("", 60_000);
    rememberCooldown("prov_zero", 0);
    expect(isCoolingDown("prov_zero")).toBe(false);
  });

  it("moves a cold provider to the end and keeps everyone else in order", () => {
    rememberCooldown("b", 60_000);
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const ordered = demoteCoolingDown(items, (item) => item.id);
    expect(ordered.map((i) => i.id)).toEqual(["a", "c", "b"]);
    expect(ordered).toHaveLength(items.length);
  });

  it("changes nothing when no provider is cold", () => {
    const items = [{ id: "a" }, { id: "b" }];
    expect(demoteCoolingDown(items, (item) => item.id)).toBe(items);
  });
});

describe("recently failing providers are ordered last, not dropped", () => {
  const stats = (failureRate: number, samples: number) => ({ failureRate, samples });

  it("moves a struggling provider to the end", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const ordered = demoteUnhealthy(items, (item) => item.id, {
      a: stats(FAILURE_RATE_THRESHOLD, MIN_FAILURE_SAMPLES),
    });
    expect(ordered.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("ignores a rate that rests on too few attempts", () => {
    const items = [{ id: "a" }, { id: "b" }];
    const ordered = demoteUnhealthy(items, (item) => item.id, { a: stats(1, MIN_FAILURE_SAMPLES - 1) });
    expect(ordered).toBe(items);
  });

  it("ignores a rate below the threshold", () => {
    const items = [{ id: "a" }, { id: "b" }];
    const ordered = demoteUnhealthy(items, (item) => item.id, { a: stats(0.2, 100) });
    expect(ordered).toBe(items);
  });

  it("ignores a provider with no recent traffic", () => {
    const items = [{ id: "a" }, { id: "b" }];
    expect(demoteUnhealthy(items, (item) => item.id, {})).toBe(items);
  });
});
