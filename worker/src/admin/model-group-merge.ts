import { Hono } from "hono";
import type { Env, ModelWithProvider } from "../types";
import { sha256Hex } from "../utils/crypto";
import { resolveModelType } from "../gateway/model_type";
import { resolveRowBillingUnit, resolveRowPricingMode } from "../gateway/pricing";
import { embeddingPoolError } from "../gateway/embeddings";
import { videoPoolError } from "../gateway/video_config";
import { aggregateModelMetadata, resolveModelMetadata } from "../gateway/model_metadata";
import { aggregateProtocolMetadata, resolveProtocolMetadata } from "../gateway/protocol_metadata";
import { parseTokenRoutingPolicy } from "../db/token_policies";

export const modelGroupMergeApp = new Hono<{ Bindings: Env }>();
type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;
type Choice = { source_id: string; target_id: string; legacy_action: "retain" | "disable" };
type Blocker = { code: string; message: string };
const rates = ["input_price_per_m", "output_price_per_m", "cache_read_price_per_m", "cache_write_price_per_m", "price_per_call", "search_price_per_call"] as const;
const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"';
function object(value: unknown): Row {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected JSON object");
  return parsed as Row;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
function choice(body: Row): Choice | null {
  if (typeof body.source_id !== "string" || !body.source_id.trim() || typeof body.target_id !== "string" || !body.target_id.trim()
    || body.source_id === body.target_id || (body.legacy_action !== "retain" && body.legacy_action !== "disable")) return null;
  return { source_id: body.source_id, target_id: body.target_id, legacy_action: body.legacy_action };
}

async function snapshot(env: Env, c: Choice) {
  const inGroups = "IN (SELECT id FROM merge_ids)";
  const specs: [string, string][] = [
    ["model_groups", "id " + inGroups], ["model_group_members", "group_id " + inGroups],
    ["models", "id IN (SELECT model_id FROM merge_model_ids)"],
    ["providers", "id IN (SELECT provider_id FROM models WHERE id IN (SELECT model_id FROM merge_model_ids))"],
    ["price_windows", "model_id " + inGroups],
    ["service_group_models", "target_type = 'group' AND target_id " + inGroups],
    ["service_groups", "id IN (SELECT service_group_id FROM merge_mappings)"],
    ["service_model_aliases", "mapping_id IN (SELECT id FROM merge_mappings) OR service_group_id IN (SELECT service_group_id FROM merge_mappings)"],
    ["public_model_identities", "name IN (SELECT model_key FROM merge_mappings)"],
    ["device_model_groups", "group_id " + inGroups], ["device_template_groups", "group_id " + inGroups],
    ["device_templates", "1"], ["device_template_bindings", "1"],
    ["devices", "1"], ["device_sub_tokens", "1"],
    ["device_service_groups", "1"], ["token_routing_policies", "1"], ["token_routing_policy_groups", "1"],
    ["settings", "1"],
  ];
  const parts = await Promise.all(specs.map(async ([table, where]) => {
    const info = await env.DB.prepare("PRAGMA table_info(" + quote(table) + ")").all<{ name: string }>();
    const columns = (info.results || []).map(r => r.name).filter(name => !(["devices", "device_sub_tokens"].includes(table) && ["last_used_at", "balance_usd", "reserved_usd"].includes(name)));
    if (!columns.length) throw new Error("Merge schema unavailable: " + table);
    const row = "json_object(" + columns.map(name => "'" + name.replace(/'/g, "''") + "'," + quote(name)).join(",") + ")";
    const order = columns.map(quote).join(",");
    return "'" + table + "',json((SELECT json_group_array(json(" + quote("merge_row") + ")) FROM (SELECT " + row + " AS merge_row FROM " + quote(table) + " WHERE " + where + " ORDER BY " + order + ")))";
  }));
  const sql = "WITH merge_ids(id) AS (SELECT value FROM json_each(?)), "
    + "merge_mappings AS (SELECT * FROM service_group_models WHERE target_type='group' AND target_id IN (SELECT id FROM merge_ids)), "
    + "merge_model_ids(model_id) AS (SELECT model_id FROM model_group_members WHERE group_id IN (SELECT id FROM merge_ids) UNION SELECT value FROM merge_mappings, json_each(CASE WHEN json_valid(member_ids_json) THEN member_ids_json ELSE '[]' END)) "
    + "SELECT json_object(" + parts.join(",") + ") AS snapshot";
  const ids = JSON.stringify([c.source_id, c.target_id]);
  const result = await env.DB.prepare(sql).bind(ids).first<{ snapshot: string }>();
  if (!result) throw new Error("Merge snapshot unavailable");
  return { sql, ids, raw: result.snapshot, data: JSON.parse(result.snapshot) as Snapshot };
}
function billing(group: Row, type: string): ModelWithProvider {
  return { ...group, model_name: group.name, provider_type: type } as unknown as ModelWithProvider;
}
function prices(group: Row): Record<string, number> {
  return Object.fromEntries(rates.map(key => [key, Number(group[key] ?? 0)]));
}
function effectivePrice(group: Row, service: Row, mapping: Row): { full: Row; rates: Record<string, number> } {
  const parsed: unknown = mapping.pricing_json == null ? {} : JSON.parse(String(mapping.pricing_json));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid mapping price object");
  const overrides = parsed as Row;
  const result = prices(group);
  if (resolveRowPricingMode(billing(group, "openai")) === "priced") {
    if (mapping.pricing_json == null) {
      const multiplier = service.multiplier;
      if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier < 0) throw new Error("Invalid service multiplier");
      for (const key of rates) if (key !== "search_price_per_call") result[key] *= multiplier;
    } else {
      for (const key of rates) if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        const value = overrides[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid explicit mapping price");
        result[key] = value;
      }
    }
  }
  if (Object.values(result).some(value => !Number.isFinite(value) || value < 0)) throw new Error("Invalid group price");
  return { full: { ...overrides, ...result }, rates: result };
}
function publicMember(row: ModelWithProvider & { edge_enabled?: unknown; position?: unknown }) {
  return { id: row.id, model_name: row.model_name, provider_type: row.provider_type, enabled: row.enabled,
    edge_enabled: row.edge_enabled, position: row.position, unit: resolveRowBillingUnit(row), model_type: resolveModelType(row),
    config_json: row.config_json, capabilities: resolveModelMetadata(row), protocols: resolveProtocolMetadata(row) };
}
function safetyCapability(row: ModelWithProvider) {
  const metadata = resolveModelMetadata(row);
  const protocol = resolveProtocolMetadata(row);
  return { context_window: metadata.context_window, max_output_tokens: metadata.max_output_tokens,
    supports_reasoning: metadata.supports_reasoning, supported_reasoning_levels: metadata.supported_reasoning_levels,
    default_reasoning_level: metadata.default_reasoning_level, protocols: { chat_completions: protocol.chat_completions,
      responses: protocol.responses, messages: protocol.messages, chat_route: protocol.chat_route, responses_route: protocol.responses_route,
      loss_policy: protocol.loss_policy, supported_endpoints: protocol.supported_endpoints, upstream_endpoints: protocol.upstream_endpoints } };
}

function plan(data: Snapshot, c: Choice) {
  const blockers: Blocker[] = [];
  const block = (code: string, message: string) => blockers.push({ code, message });
  const source = data.model_groups.find(row => row.id === c.source_id);
  const target = data.model_groups.find(row => row.id === c.target_id);
  if (!source || !target) return { can_commit: false, blockers: [{ code: "missing_group", message: "源组或目标组不存在" }] };
  if (source.enabled !== 1 || target.enabled !== 1) block("disabled_group", "仅允许合并两个启用的组；不能借合并重新启用停用入口");
  const byModel = new Map(data.models.map(row => [row.id, row]));
  const byProvider = new Map(data.providers.map(row => [row.id, row]));
  const hydrate = (id: unknown, edge?: Row): ModelWithProvider => {
    const model = byModel.get(id);
    const provider = model && byProvider.get(model.provider_id);
    if (!model || !provider) throw new Error("成员或供应商不存在: " + String(id));
    return { ...model, provider_type: provider.type, provider_name: provider.name, provider_enabled: provider.enabled,
      provider_config_json: provider.config_json, provider_endpoint: provider.endpoint,
      edge_enabled: edge?.enabled, position: edge?.position } as unknown as ModelWithProvider;
  };
  const edges = (id: string) => data.model_group_members.filter(row => row.group_id === id).sort((a, b) => Number(a.position) - Number(b.position) || String(a.model_id).localeCompare(String(b.model_id)));
  const sourceEdges = edges(c.source_id), targetEdges = edges(c.target_id);
  const union = targetEdges.map(row => ({ ...row }));
  for (const edge of sourceEdges) {
    const existing = union.find(row => row.model_id === edge.model_id);
    if (!existing) union.push({ ...edge });
    else if (existing.enabled !== edge.enabled) block("member_enabled_conflict", "重复成员启用状态不同: " + String(edge.model_id));
  }
  const merged = union.map((row, position) => ({ model_id: String(row.model_id), enabled: Number(row.enabled), position }));
  let members: ModelWithProvider[] = [], sourceMembers: ModelWithProvider[] = [], targetMembers: ModelWithProvider[] = [];
  try {
    members = merged.map(row => hydrate(row.model_id, row));
    sourceMembers = sourceEdges.map(row => hydrate(row.model_id, row));
    targetMembers = targetEdges.map(row => hydrate(row.model_id, row));
    members.forEach(row => object(row.config_json));
  } catch (error) { block("invalid_member", String(error)); }
  if (!sourceMembers.length || !targetMembers.length) block("empty_pool", "源组和目标组必须各有可验证的成员");
  const type = members[0]?.provider_type || "openai";
  const sourceBilling = billing(source, type), targetBilling = billing(target, type);
  if (resolveRowBillingUnit(sourceBilling) !== resolveRowBillingUnit(targetBilling)) block("unit_mismatch", "计费单位不同，拒绝合并");
  if (resolveModelType(sourceBilling) !== resolveModelType(targetBilling)) block("type_mismatch", "模型类型不同，拒绝合并");
  if (resolveRowPricingMode(sourceBilling) !== resolveRowPricingMode(targetBilling)) block("mode_mismatch", "定价模式不同，独立 pricing_json 无法冻结此差异");
  for (const key of ["cache_enabled", "cache_ttl", "peak_pricing_enabled", "model_public"]) {
    if (source[key] !== target[key]) block("configuration_mismatch", "组配置不同且不会静默覆盖: " + key);
  }
  try {
    if (canonical(object(source.config_json)) !== canonical(object(target.config_json))) block("configuration_mismatch", "能力/请求配置或 model_rewrite 不同，必须先独立审查配置，向导拒绝直接迁移");
  } catch { block("invalid_config", "组 config_json 无效"); }
  const windowShape = (id: string) => data.price_windows.filter(row => row.model_id === id).map(({ id: _id, model_id: _model, ...rest }) => rest).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  if (canonical(windowShape(c.source_id)) !== canonical(windowShape(c.target_id))) block("peak_windows_mismatch", "高峰价格窗口不同，无法用 mapping pricing_json 保持原报价");
  for (const member of members) {
    if (resolveRowBillingUnit(member) !== resolveRowBillingUnit(targetBilling)) block("unit_mismatch", "成员计费单位不兼容: " + member.id);
    if (resolveModelType(member) !== resolveModelType(targetBilling)) block("type_mismatch", "成员类型不兼容: " + member.id);
  }
  if (members.length) {
    if (members.some(row => canonical(safetyCapability(row)) !== canonical(safetyCapability(members[0])))) block("capability_mismatch", "成员上下文/输出/推理/协议能力不同；不能通过合并静默改变入口能力");
    for (const group of [sourceBilling, targetBilling]) {
      const err = resolveModelType(group) === "embedding" ? embeddingPoolError(group, members)
        : resolveModelType(group) === "video" ? videoPoolError(group, members) : null;
      if (err) block("incompatible_pool", err);
    }
  }
  const groupKeys = new Set(["group:" + c.source_id, "group:" + c.target_id]);
  const referencedPolicies: Row[] = [];
  for (const row of data.token_routing_policies) {
    try {
      const parsed = parseTokenRoutingPolicy(JSON.parse(String(row.policy_json)));
      const direct = (parsed?.model_scope || []).some(key => groupKeys.has(key)) || Object.keys(parsed?.model_overrides || {}).some(key => groupKeys.has(key));
      referencedPolicies.push({ ...row, policy: parsed, direct_group_reference: direct });
      if (direct) block("policy_group_reference", "Token 策略绑定源/目标内部组，需单独审查权限，拒绝自动改写: " + String(row.token_id));
    } catch { block("invalid_policy", "存在无法解释的 Token 策略，不能证明迁移不扩大权限: " + String(row.token_id)); }
  }
  if (data.device_model_groups.length) block("device_group_reference", "源或目标存在账户组授权（含停用/孤立授权）；改变池可能扩大权限，必须先独立处理，拒绝直迁");
  if (data.device_template_groups.length) block("template_group_reference", "源或目标存在模板组引用；不能自动改变未来账户授权，拒绝直迁");
  const mappingChanges: Row[] = [];
  for (const mapping of data.service_group_models) {
    const owner = data.service_groups.find(row => row.id === mapping.service_group_id);
    const original = mapping.target_id === c.source_id ? source : target;
    if (!owner) { block("orphan_mapping", "公开报价所属服务组不存在: " + String(mapping.id)); continue; }
    try {
      const price = effectivePrice(original, owner, mapping);
      if (mapping.member_ids_json != null) {
        const ids: unknown = JSON.parse(String(mapping.member_ids_json));
        if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !id.trim())) throw new Error("显式成员列表无效");
        const selected = ids.map(id => hydrate(id));
        if (selected.some(row => resolveRowBillingUnit(row) !== resolveRowBillingUnit(targetBilling) || resolveModelType(row) !== resolveModelType(targetBilling))) throw new Error("显式成员类型/协议/单位不兼容");
        const err = resolveModelType(targetBilling) === "embedding" ? embeddingPoolError(targetBilling, selected)
          : resolveModelType(targetBilling) === "video" ? videoPoolError(targetBilling, selected) : null;
        if (err) throw new Error(err);
      }
      mappingChanges.push({ id: mapping.id, service_group_id: mapping.service_group_id, model_key: mapping.model_key,
        from_target: mapping.target_id, to_target: c.target_id, old_pricing_json: mapping.pricing_json,
        new_pricing_json: mapping.target_id === c.source_id ? JSON.stringify(price.full) : mapping.pricing_json,
        effective_prices: price.rates, member_ids_json: mapping.member_ids_json });
    } catch (error) { block("invalid_mapping", String(mapping.id) + ": " + String(error)); }
  }
  const compare = (group: Row, list: ModelWithProvider[]) => ({ unit: resolveRowBillingUnit(billing(group, type)), model_type: resolveModelType(billing(group, type)),
    pricing_mode: resolveRowPricingMode(billing(group, type)), prices: prices(group), config_json: group.config_json,
    cache_enabled: group.cache_enabled, cache_ttl: group.cache_ttl, model_public: group.model_public, peak_pricing_enabled: group.peak_pricing_enabled,
    windows: windowShape(String(group.id)), capabilities: aggregateModelMetadata({ ...billing(group, type), is_group: true }, list),
    protocols: aggregateProtocolMetadata(list), members: list.map(publicMember) });
  return { can_commit: !blockers.length, blockers, source: { id: source.id, name: source.name }, target: { id: target.id, name: target.name },
    comparison: { source: compare(source, sourceMembers), target: compare(target, targetMembers), merged_members: merged },
    references: { mappings: data.service_group_models, aliases: data.service_model_aliases, identities: data.public_model_identities,
      policies: referencedPolicies, device_grants: data.device_model_groups, template_grants: data.device_template_groups,
      devices: data.devices.map(row => ({ id: row.id, name: row.name, enabled: row.enabled, model_scope: row.model_scope, default_service_group_id: row.default_service_group_id })),
      templates: data.device_templates, template_bindings: data.device_template_bindings, service_grants: data.device_service_groups,
      tokens: data.device_sub_tokens.map(row => ({ id: row.id, device_id: row.device_id, enabled: row.enabled, revoked_at: row.revoked_at, service_group_id: row.service_group_id })),
      policy_groups: data.token_routing_policy_groups }, mapping_changes: mappingChanges,
    legacy: { action: c.legacy_action, source_remains: true, pool_changes: c.legacy_action === "retain",
      description: c.legacy_action === "retain" ? "保留源组壳及旧名、原完整定价；其内部池将变成合并后的成员池" : "源组成为 disabled tombstone，旧 legacy 名称停止服务；保留源成员、所有历史引用，绝不删除" },
    warnings: ["仅合并内部池，不合并公开模型身份、公开报价、账户授权，也不取最低价。每个 mapping_id/model_key/别名和显式成员列表保持独立。",
      "源 mapping 冻结迁移前完整六项有效价格（包含服务倍率；搜索附加价不乘倍率），目标 mapping 原 pricing_json 保持原样。",
      "默认成员入口会使用合并后的池；成员原配置与上游 rewrite 不变。公开路由 quotaId 改为目标内部组，内部组限流桶可能合并；账户钱包/授权不变。",
      "所有列出的引用（包含停用配置）进入快照守卫；权限/报价/引用变化会 409 并全批回滚。"] };
}

modelGroupMergeApp.post("/preview", async c => {
  let body: Row;
  try { body = object(await c.req.json()); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const input = choice(body);
  if (!input) return c.json({ error: "请选择不同的源/目标组，并显式选择 retain 或 disable 旧名" }, 400);
  const state = await snapshot(c.env, input);
  const fingerprint = await sha256Hex(canonical({ ...input, snapshot: state.raw }));
  return c.json({ fingerprint, ...plan(state.data, input) });
});

modelGroupMergeApp.post("/commit", async c => {
  let body: Row;
  try { body = object(await c.req.json()); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const input = choice(body);
  if (!input || typeof body.fingerprint !== "string" || body.confirm_prices !== true || body.confirm_permissions !== true)
    return c.json({ error: "必须提交有效预览，并分别确认完整价格、权限及成员池/限流变化" }, 400);
  const state = await snapshot(c.env, input);
  const fingerprint = await sha256Hex(canonical({ ...input, snapshot: state.raw }));
  if (fingerprint !== body.fingerprint) return c.json({ error: "预览快照已失效，请重新预览" }, 409);
  const preview = plan(state.data, input);
  const mergedMembers = preview.comparison?.merged_members;
  const mappingChanges = preview.mapping_changes;
  if (!preview.can_commit || !mergedMembers || !mappingChanges) return c.json({ error: "存在不能安全迁移的引用或配置", blockers: preview.blockers }, 409);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [c.env.DB.prepare(
    "INSERT INTO public_model_write_guards(id,valid) SELECT ?,CASE WHEN ((" + state.sql + ")) = ? THEN 1 ELSE 0 END"
  ).bind(id, state.ids, state.raw)];
  const replacePool = (groupId: string) => {
    statements.push(c.env.DB.prepare("DELETE FROM model_group_members WHERE group_id=?").bind(groupId));
    statements.push(c.env.DB.prepare("INSERT INTO model_group_members(group_id,model_id,position,enabled) SELECT ?,json_extract(value,'$.model_id'),json_extract(value,'$.position'),json_extract(value,'$.enabled') FROM json_each(?)")
      .bind(groupId, JSON.stringify(mergedMembers)));
  };
  replacePool(input.target_id);
  if (input.legacy_action === "retain") replacePool(input.source_id);
  else statements.push(c.env.DB.prepare("UPDATE model_groups SET enabled=0,updated_at=? WHERE id=?").bind(now, input.source_id));
  const changes = mappingChanges.filter(row => row.from_target === input.source_id);
  statements.push(c.env.DB.prepare("UPDATE service_group_models SET target_id=?,pricing_json=(SELECT json_extract(value,'$.new_pricing_json') FROM json_each(?) WHERE json_extract(value,'$.id')=service_group_models.id) WHERE target_type='group' AND target_id=?")
    .bind(input.target_id, JSON.stringify(changes), input.source_id));
  const serviceIds = state.data.service_groups.map(row => row.id);
  statements.push(c.env.DB.prepare("UPDATE service_groups SET revision=revision+1 WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(serviceIds)));
  statements.push(c.env.DB.prepare("UPDATE model_groups SET updated_at=? WHERE id IN (?,?)").bind(now, input.source_id, input.target_id));
  statements.push(c.env.DB.prepare("DELETE FROM public_model_write_guards WHERE id=?").bind(id));
  try { await c.env.DB.batch(statements); }
  catch { return c.json({ error: "快照守卫或迁移写入失败，整个批次已回滚；请重新预览" }, 409); }
  return c.json({ ok: true, source_id: input.source_id, target_id: input.target_id, legacy_action: input.legacy_action, source_deleted: false });
});
