import { planProtocolRoute, readProtocolCapabilities } from "./protocol_capabilities";
import type { ProtocolCapabilities, ProtocolInput, ProtocolKind } from "./protocol_capabilities";

export interface ProtocolMemberSupport {
  native: number;
  bridge: number;
  unsupported: number;
  upstream_endpoints: Record<string, number>;
}
export interface AggregatedProtocolMetadata {
  chat_completions: boolean;
  responses: boolean;
  messages: boolean;
  all_members_native_endpoints: readonly string[];
  chat_route: ProtocolCapabilities["chat_route"] | "mixed";
  responses_route: ProtocolCapabilities["responses_route"] | "mixed";
  loss_policy: ProtocolCapabilities["loss_policy"] | "mixed";
  supported_endpoints: readonly string[];
  upstream_endpoints: readonly string[];
  source: "members";
  member_count: number;
  member_support: Record<string, ProtocolMemberSupport>;
}
export type ProtocolMetadata = ProtocolCapabilities | AggregatedProtocolMetadata;
export type ProtocolMetadataInput = ProtocolInput & { protocol_metadata?: ProtocolMetadata };

export function resolveProtocolMetadata(row: ProtocolMetadataInput): ProtocolMetadata {
  return row.protocol_metadata ?? readProtocolCapabilities(row);
}

const endpoints = ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/images/generations", "/v1/embeddings", "/v1/video/generations"] as const;
function singleSupport(row: ProtocolMetadataInput, endpoint: string): ProtocolMemberSupport {
  let upstream: string | null = null;
  if (endpoint === "/v1/chat/completions" || endpoint === "/v1/responses") {
    const kind = endpoint.slice(4) as ProtocolKind;
    const route = planProtocolRoute(row, kind);
    if (route) upstream = "/v1/" + route;
  } else if (readProtocolCapabilities(row).supported_endpoints.includes(endpoint)) upstream = endpoint;
  return { native: upstream === endpoint ? 1 : 0, bridge: upstream && upstream !== endpoint ? 1 : 0,
    unsupported: upstream ? 0 : 1, upstream_endpoints: upstream ? { [upstream]: 1 } : {} };
}

export function aggregateProtocolMetadata(members: readonly ProtocolMetadataInput[]): AggregatedProtocolMetadata {
  const resolved = members.map(resolveProtocolMetadata);
  const member_count = resolved.reduce((n, cap) => n + (cap.source === "members" ? cap.member_count : 1), 0);
  const supported_endpoints = endpoints.filter(endpoint => resolved.some(cap => cap.supported_endpoints.includes(endpoint)));
  const upstream_endpoints = endpoints.filter(endpoint => resolved.some(cap => cap.upstream_endpoints.includes(endpoint)));
  const member_support: Record<string, ProtocolMemberSupport> = {};
  for (const endpoint of endpoints) {
    const total: ProtocolMemberSupport = { native: 0, bridge: 0, unsupported: 0, upstream_endpoints: {} };
    resolved.forEach((cap, i) => {
      const count = cap.source === "members" ? cap.member_support[endpoint] : singleSupport(members[i], endpoint);
      if (!count) { total.unsupported += cap.source === "members" ? cap.member_count : 1; return; }
      total.native += count.native; total.bridge += count.bridge; total.unsupported += count.unsupported;
      for (const [upstream, n] of Object.entries(count.upstream_endpoints)) total.upstream_endpoints[upstream] = (total.upstream_endpoints[upstream] || 0) + n;
    });
    member_support[endpoint] = total;
  }
  function common<K extends "chat_route" | "responses_route" | "loss_policy">(key: K, fallback: ProtocolCapabilities[K]): AggregatedProtocolMetadata[K] {
    const values = new Set(resolved.map(cap => cap[key]));
    return (values.size === 1 ? resolved[0][key] : values.size ? "mixed" : fallback) as AggregatedProtocolMetadata[K];
  }
  return { messages: resolved.some(cap => cap.messages), all_members_native_endpoints: endpoints.filter(endpoint => member_count > 0 && member_support[endpoint].native === member_count), chat_completions: resolved.some(cap => cap.chat_completions), responses: resolved.some(cap => cap.responses),
    chat_route: common("chat_route", "auto"), responses_route: common("responses_route", "auto"), loss_policy: common("loss_policy", "safe"),
    supported_endpoints, upstream_endpoints, source: "members", member_count, member_support };
}
