import { HTTPException } from "hono/http-exception";
import type { DeviceRow, Env, ModelWithProvider, TokenRoutingPolicy } from "../types";
import { resolveTokenRoutingPolicy, tokenScopeAllows } from "../db/token_policies";
import { getPublicModelIdentity } from "../db/public_model_identity";
import { filterCandidatesForDevice, getDeviceGroupIds, getRecentProviderAvgLatencies, groupBillingRow,
  isModelInScope, resolveModelKey, resolvePriceSnapshot } from "../db/repo";
import { assertLegacyTokenScope, planServiceRoutes } from "../gateway/service_groups";
import { resolveRowBillingUnit, resolveRowPeakPricing, resolveRowPricingMode } from "../gateway/pricing";
import { routeNeedsLatencies, selectCandidateRoute } from "../gateway/routing";
import { resolveModelType } from "../gateway/model_type";
import { embeddingPoolError } from "../gateway/embeddings";
import { videoPoolError } from "../gateway/video_config";

export interface RoutingPreviewPrice {
  pricing_mode: "free" | "priced";
  billing_unit: "token" | "call";
  input_price_per_m: number;
  output_price_per_m: number;
  cache_read_price_per_m: number;
  cache_write_price_per_m: number;
  price_per_call: number;
  search_price_per_call: number;
  multiplier: number;
}
export interface RoutingPreviewRoute {
  order: number;
  service_group: { id: string; name: string } | null;
  public_name: string;
  identity: string;
  price: RoutingPreviewPrice;
}
export interface TokenRoutingPreview {
  available: boolean;
  model: string;
  public_name: string | null;
  identity: string | null;
  source: string | null;
  version: string | null;
  effective_policy: TokenRoutingPolicy | null;
  routes: RoutingPreviewRoute[];
  legacy_fallback: boolean;
  explanation: string;
  error?: string;
  checked_at: number;
  notice: string;
}

function unavailable(): never { throw new HTTPException(503); }
function publicPrice(row: ModelWithProvider, multiplier: number): RoutingPreviewPrice {
  const mode = resolveRowPricingMode(row);
  if (mode === "unset" || !Number.isFinite(multiplier) || multiplier < 0) unavailable();
  const read = (key: "input_price_per_m" | "output_price_per_m" | "cache_read_price_per_m" | "cache_write_price_per_m" | "price_per_call" | "search_price_per_call") => {
    const value = row[key] ?? 0;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) unavailable();
    const effective = mode === "free" ? 0 : value * (key === "search_price_per_call" ? 1 : multiplier);
    if (!Number.isFinite(effective)) unavailable();
    return effective;
  };
  const input = read("input_price_per_m"), cacheRead = read("cache_read_price_per_m"), cacheWrite = read("cache_write_price_per_m");
  return { pricing_mode: mode, billing_unit: resolveRowBillingUnit(row), input_price_per_m: input,
    output_price_per_m: read("output_price_per_m"), cache_read_price_per_m: cacheRead > 0 ? cacheRead : input,
    cache_write_price_per_m: cacheWrite > 0 ? cacheWrite : input, price_per_call: read("price_per_call"),
    search_price_per_call: read("search_price_per_call"), multiplier };
}
function policySnapshot(policy: TokenRoutingPolicy): TokenRoutingPolicy {
  return { mode: policy.mode, group_ids: [...policy.group_ids], selection: policy.selection,
    failure_fallback: policy.failure_fallback, model_overrides: { ...policy.model_overrides },
    model_scope: policy.model_scope === null ? null : [...policy.model_scope] };
}

export async function previewTokenRouting(env: Env, device: DeviceRow, tokenId: string, modelKey: string): Promise<TokenRoutingPreview> {
  const checked_at = Date.now();
  const result: TokenRoutingPreview = { available: false, model: modelKey, public_name: null, identity: null,
    source: null, version: null, effective_policy: null, routes: [], legacy_fallback: false, explanation: "",
    checked_at, notice: "只读预览：不调用上游、不计费、不占生成 RPM；真实请求仍重查权限、可用性、协议、余额并冻结价格。" };
  try {
    if (!modelKey.trim() || modelKey.length > 300) {
      result.error = "invalid_model"; result.explanation = "请输入有效的公开调用名。"; return result;
    }
    const effective = await resolveTokenRoutingPolicy(env, tokenId === "account" ? { ...device, service_group_id: null } : device, tokenId);
    result.effective_policy = policySnapshot(effective.policy);
    result.source = effective.source; result.version = effective.version;
    const targetDevice = { ...device, token_routing_policy: effective };
    const planned = await planServiceRoutes(env, targetDevice, modelKey);
    if (planned.length) {
      const routes = await Promise.all(planned.map(async (route, index): Promise<RoutingPreviewRoute> => {
        const identity = await getPublicModelIdentity(env, route.mapping.model_key);
        const snapshot = route.autoPriceSnapshot ?? await resolvePriceSnapshot(env, route.billingRow.id,
          resolveRowPricingMode(route.billingRow) === "priced" && resolveRowPeakPricing(route.billingRow), checked_at);
        return { order: index + 1, service_group: { id: route.group.id, name: route.group.name },
          public_name: route.mapping.model_key, identity: identity ? "public:" + identity : route.targetKind + ":" + route.quotaId,
          price: publicPrice(route.billingRow, snapshot.multiplier) };
      }));
      result.routes = routes; result.public_name = routes[0].public_name; result.identity = routes[0].identity;
      result.available = true;
      result.explanation = "名称已解析并通过账户授权及令牌范围校验。" +
        (modelKey !== result.public_name ? "兼容名指向同一稳定公开身份。" : "") +
        (effective.policy.selection === "ordered" ? "候选按所选服务组顺序排列。" : "候选按当前输入价（按次模型按次价）、再输出价排列，不保证总费用最低。") +
        "首选落组：" + routes[0].service_group!.name + "；只有实际成功使用的组按自己的冻结报价结算。" +
        (effective.policy.failure_fallback ? "允许安全文本失败切组；其他请求能力、在途状态仍受真实请求限制。" : "失败自动切组已关闭；候选列表不代表自动重试承诺。");
      return result;
    }

    const legacy = await resolveModelKey(env, modelKey, { includeSecrets: false });
    let rows: ModelWithProvider[], identities: string[];
    if (legacy.kind === "none") throw new HTTPException(404);
    if (legacy.kind === "group") {
      assertLegacyTokenScope(targetDevice, legacy.group.id, true);
      const scope = device.model_scope || "all";
      const grants = scope === "all" ? new Set<string>() : new Set(await getDeviceGroupIds(env, device.id));
      if (!isModelInScope(scope, legacy.group.id, grants, Boolean(legacy.group.model_public))) throw new HTTPException(403);
      const members = legacy.members.filter(member => resolveModelType(member) === resolveModelType(legacy.group));
      if (!members.length) unavailable();
      const billing = groupBillingRow(legacy.group, members[0].provider_type);
      if ((resolveModelType(billing) === "embedding" && embeddingPoolError(billing, members)) ||
          (resolveModelType(billing) === "video" && videoPoolError(billing, members))) unavailable();
      rows = [billing]; identities = ["group:" + legacy.group.id];
    } else {
      const scoped = (await filterCandidatesForDevice(env, targetDevice, legacy.candidates))
        .filter(row => tokenScopeAllows(targetDevice, ["model:" + row.id]));
      if (!scoped.length) throw new HTTPException(403);
      const ranked = selectCandidateRoute(scoped, modelKey, routeNeedsLatencies(scoped) ? await getRecentProviderAvgLatencies(env) : {});
      rows = ranked.filter(row => resolveRowPricingMode(row) !== "unset").slice(0, 1);
      if (!rows.length) unavailable();
      identities = rows.map(row => "model:" + row.id);
    }
    const routes = await Promise.all(rows.map(async (row, index): Promise<RoutingPreviewRoute> => {
      const snapshot = await resolvePriceSnapshot(env, row.id, resolveRowPricingMode(row) === "priced" && resolveRowPeakPricing(row), checked_at);
      return { order: index + 1, service_group: null, public_name: row.model_name, identity: identities[index], price: publicPrice(row, snapshot.multiplier) };
    }));
    result.routes = routes; result.public_name = routes[0].public_name; result.identity = routes[0].identity;
    result.available = true; result.legacy_fallback = effective.policy.mode !== "legacy";
    result.explanation = result.legacy_fallback
      ? "无服务报价，按现有 Auto 合同回退旧版解析；已实际解析目标并通过账户权限、令牌范围及价格校验，不是仅凭广场名称判断成功。"
      : "使用显式旧版路由；已实际解析目标并通过账户权限、令牌范围及价格校验。";
    result.explanation += "这里只显示参考报价，不承诺实际调用价格；真实请求仍重查权限、协议、能力及价格，并按实际调用结算。";
    return result;
  } catch (error) {
    const status = error instanceof HTTPException ? error.status : 503;
    result.error = status === 403 ? "model_not_in_scope" : status === 404 ? "model_not_found" : status === 400 ? "routing_conflict" : "routing_unavailable";
    result.explanation = status === 403 ? "账户权限或令牌模型范围不允许此调用。" : status === 404 ? "所选路由中找不到该调用名。" : status === 400 ? "报价类型或计费单位冲突，无法解析。" : "路由、目标或报价配置不可用；不会把异常当作无报价而回退旧版。";
    result.routes = []; result.public_name = null; result.identity = null; result.legacy_fallback = false;
    return result;
  }
}
