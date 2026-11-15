import { describe, expect, it } from "vitest";
import { sanitizeCsvCell } from "../src/utils/csv";
import { escapeCsvField } from "../src/admin/usage";
import { validateWebhookUrl, isPrivateWebhookHost } from "../src/utils/webhook_url";
import { buildUpstreamHeaders } from "../src/utils/http";

const APOST = String.fromCharCode(39);
const Q = String.fromCharCode(34);

describe("Five external audit findings", () => {
  describe("CSV formula injection", () => {
    it("neutralises every formula starter", () => {
      for (const v of ["=1+1", "+1", "-1", "@SUM(A1)", "~1", " =cmd|", "\tX", "\rY"]) {
        expect(sanitizeCsvCell(v).charAt(0)).toBe(APOST);
      }
    });

    it("leaves ordinary text alone", () => {
      expect(sanitizeCsvCell("创建 Provider「gw」")).toBe("创建 Provider「gw」");
      expect(sanitizeCsvCell("2026-10-12 08:00:00")).toBe("2026-10-12 08:00:00");
      expect(sanitizeCsvCell("")).toBe("");
      expect(sanitizeCsvCell(null)).toBe("");
      expect(sanitizeCsvCell(undefined)).toBe("");
    });

    it("does not mangle numbers or a negative amount", () => {
      expect(sanitizeCsvCell(42)).toBe("42");
      expect(sanitizeCsvCell(-0.02)).toBe("-0.02");
    });

    it("escapeCsvField prefixes before deciding to quote", () => {
      expect(escapeCsvField("=1+1")).toBe(APOST + "=1+1");
      expect(escapeCsvField("normal")).toBe("normal");
      expect(escapeCsvField("a,b")).toBe(Q + "a,b" + Q);
      expect(escapeCsvField(-12.5)).toBe("-12.5");
    });
  });

  describe("webhook URL validation", () => {
    it("accepts ordinary public https endpoints", () => {
      expect(validateWebhookUrl("https://open.feishu.cn/open-apis/bot/v2/hook/abc")).toBeNull();
      expect(validateWebhookUrl("https://hooks.slack.com/services/T/B/X")).toBeNull();
      expect(validateWebhookUrl("https://8.8.8.8/hook")).toBeNull();
      expect(validateWebhookUrl("https://example.com:8443/hook")).toBeNull();
    });

    it("requires https", () => {
      expect(validateWebhookUrl("http://open.feishu.cn/hook")).toBe("webhook_url_must_be_https");
      expect(validateWebhookUrl("ftp://example.com/x")).toBe("webhook_url_must_be_https");
    });

    it("rejects the literal private and metadata targets", () => {
      const bad = [
        "https://localhost/hook",
        "https://127.0.0.1/hook",
        "https://127.1.2.3/hook",
        "https://169.254.169.254/cdn-cgi/trace",
        "https://169.254.170.2/v2/credentials",
        "https://10.0.0.5/hook",
        "https://172.16.0.1/hook",
        "https://192.168.1.1/hook",
        "https://100.64.0.1/hook",
        "https://0.0.0.0/hook",
        "https://metadata.google.internal/computeMetadata/v1/",
        "https://[::1]/hook",
        "https://[fd00::1]/hook",
        "https://[fe80::1]/hook",
      ];
      for (const url of bad) {
        expect(validateWebhookUrl(url)).toBe("webhook_url_private_address");
      }
    });

    it("still accepts a public IPv6 literal", () => {
      expect(validateWebhookUrl("https://[2606:4700:4700::1111]/hook")).toBeNull();
    });

    it("rejects nonsense and empties", () => {
      expect(validateWebhookUrl("")).toBe("webhook_url_required");
      expect(validateWebhookUrl("   ")).toBe("webhook_url_required");
      expect(validateWebhookUrl(undefined)).toBe("webhook_url_required");
      expect(validateWebhookUrl("not a url")).toBe("invalid_webhook_url");
    });

    it("isPrivateWebhookHost answers only for internal spellings", () => {
      expect(isPrivateWebhookHost("127.0.0.1")).toBe(true);
      expect(isPrivateWebhookHost("hooks.slack.com")).toBe(false);
    });
  });

  describe("upstream header forwarding", () => {
    it("forwards the headers providers actually require", () => {
      const source = new Headers({
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "x-request-id": "req-9",
      });
      const headers = buildUpstreamHeaders(source, "anthropic", "ant-key");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31");
      expect(headers.get("x-request-id")).toBe("req-9");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-api-key")).toBe("ant-key");
    });

    it("drops client fingerprint headers that the wildcard used to ship upstream", () => {
      const source = new Headers({
        "x-stainless-lang": "js",
        "x-stainless-os": "Windows",
        "x-stainless-arch": "x64",
        "x-stainless-runtime-version": "node:22",
        "x-openai-organization": "org-1",
        "x-goog-api-client": "gl-node/22",
        "x-secret-tenant": "acme",
      });
      const headers = buildUpstreamHeaders(source, "openai", "sk-x");
      expect(headers.get("x-stainless-lang")).toBeNull();
      expect(headers.get("x-stainless-os")).toBeNull();
      expect(headers.get("x-stainless-arch")).toBeNull();
      expect(headers.get("x-stainless-runtime-version")).toBeNull();
      expect(headers.get("x-openai-organization")).toBeNull();
      expect(headers.get("x-goog-api-client")).toBeNull();
      expect(headers.get("x-secret-tenant")).toBeNull();
    });

    it("never forwards the gateway credentials", () => {
      const source = new Headers({
        Authorization: "Bearer ccs_device",
        "x-api-key": "ccs_device",
        "x-request-id": "req-1",
      });
      const headers = buildUpstreamHeaders(source, "openai", "sk-upstream");
      expect(headers.get("Authorization")).toBe("Bearer sk-upstream");
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("x-request-id")).toBe("req-1");
    });
  });
});