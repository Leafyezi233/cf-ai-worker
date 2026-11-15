
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

const PRIVATE_V4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "198.18.0.0/15",
];

function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = parseInt(part, 10);
    if (octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value >>> 0;
}

function isIpv4InCidr(ipLong: number, cidr: string): boolean {
  const parts = cidr.split("/");
  const rangeLong = parseIpv4(parts[0]);
  const bits = parseInt(parts[1], 10);
  if (rangeLong === null || isNaN(bits)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipLong & mask) === (rangeLong & mask);
}

function leadingIpv6Group(host: string): number | null {
  if (!host.includes(":")) return null;
  const first = host.split(":")[0];
  if (first === "") return 0;
  if (!/^[0-9a-f]{1,4}$/.test(first)) return null;
  return parseInt(first, 16);
}

export function validateWebhookUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return "webhook_url_required";

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return "invalid_webhook_url";
  }
  if (parsed.protocol !== "https:") return "webhook_url_must_be_https";

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "") return "invalid_webhook_url";

  if (BLOCKED_HOSTNAMES.has(host)) return "webhook_url_private_address";

  const v4 = parseIpv4(host);
  if (v4 !== null) {
    for (const cidr of PRIVATE_V4_CIDRS) {
      if (isIpv4InCidr(v4, cidr)) return "webhook_url_private_address";
    }
    return null;
  }

  const v6Group = leadingIpv6Group(host);
  if (v6Group !== null) {
    return v6Group >= 0x2000 && v6Group <= 0x3fff ? null : "webhook_url_private_address";
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return "invalid_webhook_url";
  }
  return null;
}

export function isPrivateWebhookHost(host: string): boolean {
  return validateWebhookUrl("https://" + host) === "webhook_url_private_address";
}