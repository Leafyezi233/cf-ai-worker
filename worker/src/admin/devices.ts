import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { generateDeviceToken, hashToken } from "../utils/crypto";
import {
  createDevice,
  listDevices,
  revokeDevice,
  updateDevice,
  adjustBalance,
  getWallet,
  getDeviceById,
  getDeviceModelIds,
  getDeviceModelRateLimits,
  getDeviceGroupIds,
  getDeviceGroupRateLimits,
  listLedger,
  listModelGroups,
  listModels,
  listSubTokens,
  replaceDeviceModelGroups,
  replaceDeviceModels,
  resetDevicePassword,
} from "../db/repo";

import {
  CreateDeviceSchema,
  ModelScopeSchema,
  UpdateDeviceSchema,
  TopupSchema,
  zValidator,
} from "./schemas";
import { deviceAccessReport } from "./device_access";

export const devicesApp = new Hono<{ Bindings: Env }>();

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

async function auditDevice(
  c: Context<{ Bindings: Env }>,
  params: {
    action: string;
    target_id?: string | null;
    summary: string;
    details?: Record<string, unknown> | null;
  }
): Promise<void> {
  const { recordAuditLog } = await import("../db/repo");
  const { extractClientIp } = await import("../middleware/adminAuth");
  await recordAuditLog(c.env, {
    ip: extractClientIp(c, c.env),
    action: params.action,
    target_type: "device",
    target_id: params.target_id ?? null,
    summary: params.summary,
    details: params.details ?? null,
  });
}

function publicDevice<T extends Record<string, any>>(row: T) {
  const { token_hash: _tokenHash, password_hash: _passwordHash, ...rest } = row;
  return rest;
}

devicesApp.get("/", async (c) => {
  const includeRevoked = c.req.query("include_revoked") === "1";
  const items = await listDevices(c.env, { includeRevoked });
  if (c.req.query("include_routing") !== "1") return c.json({ items });
  const routing = await c.env.DB.prepare("SELECT d.id, d.service_group_id, d.default_service_group_id, p.policy_json, g.name AS selected_service_group_name FROM devices d LEFT JOIN token_routing_policies p ON p.device_id = d.id AND p.token_id = 'master' LEFT JOIN service_groups g ON g.id = COALESCE(d.service_group_id, d.default_service_group_id) " + (includeRevoked ? "" : "WHERE d.revoked_at IS NULL"))
    .all<{ id: string; service_group_id: string | null; default_service_group_id: string | null; policy_json: string | null; selected_service_group_name: string | null }>();
  const byId = new Map((routing.results ?? []).map(row => {
    const selected = row.service_group_id ?? row.default_service_group_id;
    let mode = selected === "auto" ? "auto" : selected == null || selected === "legacy" ? "legacy" : "fixed";
    let groupIds = mode === "fixed" ? [selected!] : [];
    if (row.policy_json !== null) {
      try {
        const policy = JSON.parse(row.policy_json);
        mode = ["auto", "legacy", "fixed", "multi"].includes(policy?.mode) ? policy.mode : "unknown";
        groupIds = Array.isArray(policy?.group_ids) ? policy.group_ids.filter((id: unknown): id is string => typeof id === "string") : [];
      } catch { mode = "unknown"; groupIds = []; }
    }
    return [row.id, { routing_policy_mode: mode, routing_group_ids: groupIds, selected_service_group_id: selected, selected_service_group_name: row.selected_service_group_name }] as const;
  }));
  return c.json({ items: items.map(item => ({ ...item, ...byId.get(item.id) })) });
});

devicesApp.get("/choices", async (c) => {
  const result = await c.env.DB.prepare("SELECT id, name, enabled FROM devices WHERE revoked_at IS NULL ORDER BY created_at DESC, id").all<{ id: string; name: string; enabled: number }>();
  return c.json({ items: result.results ?? [] });
});

devicesApp.post("/", zValidator("json", CreateDeviceSchema), async (c) => {
  const data = c.req.valid("json");
  const rateLimitRpm = typeof data.rate_limit_rpm === "number" ? Math.max(0, data.rate_limit_rpm) : 0;
  const costLimitMonthly = typeof data.cost_limit_monthly === "number" ? Math.max(0, data.cost_limit_monthly) : 0;
  const token = generateDeviceToken();
  const tokenHash = await hashToken(token);
  const device = await createDevice(
    c.env,
    data.name.trim(),
    tokenHash,
    rateLimitRpm,
    costLimitMonthly,
    typeof data.balance_usd === "number" ? data.balance_usd : undefined
  );
  await auditDevice(c, {
    action: "device.create",
    target_id: device.id,
    summary: "创建设备「" + data.name.trim() + "」",
    details: { rate_limit_rpm: rateLimitRpm, cost_limit_monthly: costLimitMonthly, balance_usd: device.balance_usd ?? null },
  });
  return c.json({ item: device, token }, 201);
});

devicesApp.put("/:id", zValidator("json", UpdateDeviceSchema), async (c) => {
  const data = c.req.valid("json");
  const row = await updateDevice(c.env, c.req.param("id"), {
    name: data.name !== undefined ? data.name.trim() : undefined,
    enabled: data.enabled,
    rate_limit_rpm: typeof data.rate_limit_rpm === "number" ? Math.max(0, data.rate_limit_rpm) : undefined,
    cost_limit_monthly: typeof data.cost_limit_monthly === "number" ? Math.max(0, data.cost_limit_monthly) : undefined,
    calls_enabled: data.calls_enabled,
  });
  if (!row) return c.json({ error: "not_found" }, 404);
  await auditDevice(c, {
    action: "device.update",
    target_id: row.id,
    summary: "更新设备「" + row.name + "」",
    details: {
      name: data.name !== undefined ? data.name.trim() : undefined,
      enabled: data.enabled,
      rate_limit_rpm: data.rate_limit_rpm,
      cost_limit_monthly: data.cost_limit_monthly,
      calls_enabled: data.calls_enabled,
    },
  });
  return c.json({ item: publicDevice(row) });
});



devicesApp.get("/:id/model-scope", async (c) => {
  const device = await getDeviceById(c.env, c.req.param("id"));
  if (!device) return c.json({ error: "not_found" }, 404);
  const [modelIds, allModels, rpmLimits, groupIds, groupRpmLimits, allGroups] = await Promise.all([
    getDeviceModelIds(c.env, device.id),
    listModels(c.env, { includeSecrets: false }),
    getDeviceModelRateLimits(c.env, device.id),
    getDeviceGroupIds(c.env, device.id),
    getDeviceGroupRateLimits(c.env, device.id),
    listModelGroups(c.env),
  ]);
  return c.json({
    item: {
      device_id: device.id,
      model_scope: device.model_scope || "all",
      model_ids: modelIds,
      model_count: modelIds.length,
      rpm_limits: Object.fromEntries(rpmLimits),
      group_ids: groupIds,
      group_rpms: Object.fromEntries(groupRpmLimits),
    },
    models: allModels.map((m) => ({ id: m.id, model_name: m.model_name, display_name: m.display_name })),
    groups: (allGroups as any[]).map((g) => ({
      id: g.id,
      name: g.name,
      display_name: g.display_name,
      enabled: g.enabled,
    })),
  });
});

devicesApp.put("/:id/model-scope", zValidator("json", ModelScopeSchema), async (c) => {
  const data = c.req.valid("json");
  const device = await getDeviceById(c.env, c.req.param("id"));
  if (!device) return c.json({ error: "not_found" }, 404);

  const requested = Array.from(new Set(data.model_ids.map((id) => id.trim()).filter(Boolean)));
  const [known, knownGroups] = await Promise.all([
    listModels(c.env, { includeSecrets: false }),
    listModelGroups(c.env),
  ]);
  const knownIds = new Set(known.map((m) => m.id));
  const unknown = requested.filter((id) => !knownIds.has(id));
  if (unknown.length) {
    return c.json({ error: "unknown_model_ids", model_ids: unknown }, 400);
  }
  const requestedGroups = Array.from(new Set((data.group_ids ?? []).map((id) => id.trim()).filter(Boolean)));
  const knownGroupIds = new Set((knownGroups as any[]).map((g) => g.id));
  const unknownGroups = requestedGroups.filter((id) => !knownGroupIds.has(id));
  if (unknownGroups.length) {
    return c.json({ error: "unknown_group_ids", group_ids: unknownGroups }, 400);
  }
  if (data.model_scope !== "all" && requested.length === 0 && requestedGroups.length === 0) {
    return c.json(
      { error: "empty_whitelist", message: "受限模式下至少需要选择一个模型或一个组，或把 model_scope 设为 all" },
      400
    );
  }

  const rpmLimits = data.model_rpms ?? {};
  const unknownLimits = Object.keys(rpmLimits).filter((id) => !knownIds.has(id));
  if (unknownLimits.length) {
    return c.json({ error: "unknown_model_ids", model_ids: unknownLimits }, 400);
  }
  const groupRpmLimits = data.group_rpms ?? {};
  const unknownGroupLimits = Object.keys(groupRpmLimits).filter((id) => !knownGroupIds.has(id));
  if (unknownGroupLimits.length) {
    return c.json({ error: "unknown_group_ids", group_ids: unknownGroupLimits }, 400);
  }
  const stored = await replaceDeviceModels(
    c.env,
    device.id,
    data.model_scope === "all"
      ? []
      : requested.map((id) => ({
          model_id: id,
          rpm: typeof rpmLimits[id] === "number" && Number.isFinite(rpmLimits[id]) ? Math.max(0, Math.floor(rpmLimits[id])) : 0,
        }))
  );
  const storedGroups = await replaceDeviceModelGroups(
    c.env,
    device.id,
    data.model_scope === "all"
      ? []
      : requestedGroups.map((id) => ({
          group_id: id,
          rpm:
            typeof groupRpmLimits[id] === "number" && Number.isFinite(groupRpmLimits[id])
              ? Math.max(0, Math.floor(groupRpmLimits[id]))
              : 0,
        }))
  );
  const row = await updateDevice(c.env, device.id, { model_scope: data.model_scope });
  return c.json({
    item: {
      device_id: device.id,
      model_scope: row?.model_scope || data.model_scope,
      model_ids: stored,
      model_count: stored.length,
      rpm_limits: Object.fromEntries(await getDeviceModelRateLimits(c.env, device.id)),
      group_ids: storedGroups,
      group_rpms: Object.fromEntries(await getDeviceGroupRateLimits(c.env, device.id)),
    },
  });
});

devicesApp.post("/:id/topup", zValidator("json", TopupSchema), async (c) => {
  const data = c.req.valid("json");
  const deviceId = c.req.param("id");

  let delta: number;
  if (data.mode === "set") {
    const target = data.target_balance_usd;
    if (typeof target !== "number" || !Number.isFinite(target)) {
      return c.json({ error: "invalid_amount", message: "target_balance_usd 必须是数字" }, 400);
    }
    const current = (await getWallet(c.env, deviceId)).balance_usd;
    delta = roundUsd(Number(target) - Number(current));
  } else {
    const amount = data.amount_usd;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      return c.json({ error: "invalid_amount", message: "amount_usd 必须是数字" }, 400);
    }
    delta = roundUsd(amount);
  }
  if (delta === 0) {
    return c.json({ error: "invalid_amount", message: "金额不能为零" }, 400);
  }

  const result = await adjustBalance(c.env, deviceId, delta, {
    reason: delta > 0 ? "topup" : "adjust",
    note: data.note ?? null,
    requestId: data.request_id ?? null,
  });
  if (!result) return c.json({ error: "not_found" }, 404);
  const wallet = await getWallet(c.env, deviceId);
  await auditDevice(c, {
    action: "device.topup",
    target_id: deviceId,
    summary: (delta > 0 ? "充值 " : "扣减 ") + roundUsd(Math.abs(delta)).toFixed(4) + " USD",
    details: {
      delta_usd: delta,
      mode: data.mode,
      balance_usd: wallet.balance_usd,
      note: data.note ?? null,
    },
  });
  return c.json({
    item: {
      device_id: deviceId,
      balance_usd: wallet.balance_usd,
      reserved_usd: wallet.reserved_usd,
      available_usd: Number((wallet.balance_usd - wallet.reserved_usd).toFixed(4)),
    },
  });
});

devicesApp.get("/:id/access", async (c) => {
  const report = await deviceAccessReport(c.env, c.req.param("id"));
  if (!report) return c.json({ error: "not_found" }, 404);
  return c.json(report);
});

devicesApp.get("/:id/ledger", async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const items = await listLedger(c.env, c.req.param("id"), limit, offset);
  return c.json({ items });
});

devicesApp.post("/:id/revoke", async (c) => {
  const row = await revokeDevice(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const item = publicDevice(row) as Record<string, any>;
  await auditDevice(c, {
    action: "device.revoke",
    target_id: item.id,
    summary: "撤销设备「" + item.name + "」及其全部子 Token",
  });
  return c.json({ item });
});


devicesApp.post("/:id/calls", async (c) => {
  let enabled: boolean | null = null;
  try {
    const body = (await c.req.json()) as { enabled?: unknown };
    if (typeof body?.enabled === "boolean") enabled = body.enabled;
  } catch {
    enabled = null;
  }
  if (enabled === null) {
    return c.json({ error: "invalid_body", message: "enabled 必须是布尔值" }, 400);
  }
  const row = await updateDevice(c.env, c.req.param("id"), { calls_enabled: enabled });
  if (!row) return c.json({ error: "not_found" }, 404);
  const { recordAuditLog } = await import("../db/repo");
  const { extractClientIp } = await import("../middleware/adminAuth");
  await recordAuditLog(c.env, {
    ip: extractClientIp(c),
    action: enabled ? "device.calls_enable" : "device.calls_disable",
    target_type: "device",
    target_id: row.id,
    summary: (enabled ? "恢复" : "禁止") + "调用：" + row.name,
  });
  return c.json({
    item: publicDevice(row),
    calls_enabled: Number(row.calls_enabled ?? 1) !== 0,
  });
});

devicesApp.post("/:id/reset-password", async (c) => {
  const stamped = await resetDevicePassword(c.env, c.req.param("id"));
  if (stamped === null) return c.json({ error: "not_found" }, 404);
  const { recordAuditLog } = await import("../db/repo");
  const { extractClientIp } = await import("../middleware/adminAuth");
  await recordAuditLog(c.env, {
    ip: extractClientIp(c),
    action: "device.password_reset",
    target_type: "device",
    target_id: c.req.param("id"),
    summary: "重置控制台密码（用户下次进入需重新设置）",
  });
  return c.json({ ok: true, password_updated_at: stamped });
});

devicesApp.get("/:id/sub-tokens", async (c) => {
  const device = await getDeviceById(c.env, c.req.param("id"));
  if (!device) return c.json({ error: "not_found" }, 404);
  const rows = await listSubTokens(c.env, device.id, {
    includeRevoked: c.req.query("include_revoked") === "1",
  });
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: Boolean(r.enabled),
      revoked: Boolean(r.revoked_at),
      service_group_id: r.service_group_id ?? null,
      last_used_at: r.last_used_at ?? null,
      created_at: r.created_at,
    })),
  });
});
