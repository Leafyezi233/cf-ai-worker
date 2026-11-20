import { Hono } from "hono";
import { previewTokenRouting } from "./routing_preview";
import type { Context } from "hono";
import type { AuthedDevice, Env } from "../types";
import { resolveDevice, resolveToken } from "../gateway/auth";
import { resolveModelType } from "../gateway/model_type";
import {
  checkDeviceRateLimit,
  createSubToken,
  recordAuditLog,
  getLoginAttempt,
  getSubTokenById,
  listSubTokens,
  listModelProjectionsForDevice,
  recordLoginFailure,
  clearLoginAttempt,
  resetDevicePassword,
  revokeSubToken,
  setDevicePassword,
  setSubTokenEnabled,
  updateDevice,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_LOCK_MS,
  LOGIN_ATTEMPT_WINDOW_MS,
  SUB_TOKEN_LIMIT,
  getWallet,
} from "../db/repo";
import { listSelectableServiceGroups } from "../db/service_groups";
import { getTokenRoutingPolicy, putTokenRoutingPolicy, parseTokenRoutingPolicy, resolveTokenRoutingPolicy, ensureTokenPoliciesSchema, tokenPolicyWriteStatements, singleSelectionPolicy } from "../db/token_policies";
import { projectServiceModelsForGroups } from "../gateway/service_groups";
import type { DeviceRow, TokenRoutingPolicy } from "../types";
import { extractClientIp } from "../middleware/adminAuth";
import {
  buildUserSessionCookie,
  clearUserSessionCookie,
  generateDeviceToken,
  hashPassword,
  hashToken,
  passwordPolicyError,
  signUserSession,
  verifyPassword,
  verifyUserSession,
  verifyUserSessionValue,
} from "../utils/crypto";
import type { UserSessionPayload } from "../utils/crypto";

export const accountApp = new Hono<{ Bindings: Env }>();

function sessionSecret(env: Env): string | null {
  const secret = env.SESSION_SECRET || env.ADMIN_SECRET;
  return secret && secret.length > 0 ? secret : null;
}

interface MasterAuth {
  device: AuthedDevice;
}

async function auditOwner(
  c: Context<{ Bindings: Env }>,
  device: AuthedDevice,
  params: {
    action: string;
    target_type: string;
    target_id?: string | null;
    summary: string;
    details?: Record<string, unknown> | null;
  }
): Promise<void> {
  await recordAuditLog(c.env, {
    actor_type: "console",
    ip: extractClientIp(c, c.env),
    action: params.action,
    target_type: params.target_type,
    target_id: params.target_id ?? device.id,
    summary: params.summary,
    details: params.details ?? null,
  });
}
interface AuthFailure {
  response: Response;
}

export const CONSOLE_RATE_LIMIT_RPM = 120;

export async function consoleRateLimit(
  env: Env,
  device: AuthedDevice
): Promise<Response | null> {
  const allowed = await checkDeviceRateLimit(env, "console::" + device.id, CONSOLE_RATE_LIMIT_RPM);
  if (allowed) return null;
  return new Response(
    JSON.stringify({
      error: "console_rate_limited",
      message: `Console rate limit of ${CONSOLE_RATE_LIMIT_RPM} RPM exceeded`,
    }),
    {
      status: 429,
      headers: { "content-type": "application/json", "Retry-After": "60" },
    }
  );
}

async function requireMaster(c: Context<{ Bindings: Env }>): Promise<MasterAuth | AuthFailure> {
  const device = await resolveDevice(c);
  if (!device) {
    return { response: c.json({ error: "unauthorized", message: "valid device token required" }, 401) };
  }
  if (device.auth_via === "sub") {
    return {
      response: c.json(
        {
          error: "sub_token_not_allowed",
          message: "A sub-token cannot sign in to the console. Use the master token.",
        },
        403
      ),
    };
  }
  const limited = await consoleRateLimit(c.env, device);
  if (limited) return { response: limited };
  return { device };
}

async function requireAccount(c: Context<{ Bindings: Env }>): Promise<MasterAuth | AuthFailure> {
  const master = await requireMaster(c);
  if ("response" in master) return master;
  const secret = sessionSecret(c.env);
  if (!secret) {
    return { response: c.json({ error: "server_misconfigured", message: "SESSION_SECRET is not set" }, 500) };
  }
  const session = await sessionFromRequest(secret, c, master.device);
  if (!session) {
    return {
      response: c.json(
        { error: "password_required", message: "Sign in with your console password first." },
        401
      ),
    };
  }
  return master;
}

async function sessionFromRequest(
  secret: string,
  c: Context<{ Bindings: Env }>,
  device: AuthedDevice
): Promise<UserSessionPayload | null> {
  if (!device.password_hash) return null;
  const matchesAccount = (session: UserSessionPayload | null): session is UserSessionPayload => Boolean(
    session && session.sub === device.id && (session.pv ?? null) === (device.password_updated_at ?? null)
  );
  const fromCookie = await verifyUserSession(secret, c.req.header("cookie"));
  if (matchesAccount(fromCookie)) return fromCookie;
  const fromHeader = await verifyUserSessionValue(secret, c.req.header("x-console-session"));
  return matchesAccount(fromHeader) ? fromHeader : null;
}

async function readJson(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}


accountApp.get("/auth/session", async (c) => {
  const master = await requireMaster(c);
  if ("response" in master) return master.response;
  const device = master.device;
  const secret = sessionSecret(c.env);
  const session = secret ? await sessionFromRequest(secret, c, device) : null;
  const authenticated = Boolean(session);
  return c.json({
    password_setup_required: !device.password_hash,
    authenticated,
    device_id: device.id,
    device_name: device.name,
  });
});

accountApp.post("/auth/setup", async (c) => {
  const master = await requireMaster(c);
  if ("response" in master) return master.response;
  const device = master.device;
  const secret = sessionSecret(c.env);
  if (!secret) return c.json({ error: "server_misconfigured" }, 500);
  if (device.password_hash) return c.json({ error: "password_already_set" }, 409);
  const body = await readJson(c);
  const password = body?.password;
  const policyError = passwordPolicyError(password);
  if (policyError) return c.json({ error: "weak_password", message: policyError }, 400);
  const hash = await hashPassword(String(password));
  const setup = await setDevicePassword(c.env, device.id, hash, device.password_updated_at ?? null);
  if (setup.status === "not_found") return c.json({ error: "not_found" }, 404);
  if (setup.status === "conflict") {
    return c.json({ error: "password_setup_conflict", message: "密码状态已变化，请重新验证。" }, 409);
  }
  const stamped = setup.password_updated_at;
  await auditOwner(c, device, {
    action: "console.password_setup",
    target_type: "device",
    summary: "首次设置控制台密码",
  });
  const value = await signUserSession(secret, device.id, stamped);
  c.header("Set-Cookie", buildUserSessionCookie(value));
  return c.json({ ok: true, password_updated_at: stamped, session: value });
});

accountApp.post("/auth/login", async (c) => {
  const master = await requireMaster(c);
  if ("response" in master) return master.response;
  const device = master.device;
  const secret = sessionSecret(c.env);
  if (!secret) return c.json({ error: "server_misconfigured" }, 500);
  if (!device.password_hash) return c.json({ error: "password_setup_required" }, 409);

  const deviceKey = "console:dev:" + device.id;
  const ipKey = "console:ip:" + (c.req.header("cf-connecting-ip") || "unknown");
  const nowMs = Date.now();
  const [deviceAttempt, ipAttempt] = await Promise.all([
    getLoginAttempt(c.env, deviceKey),
    getLoginAttempt(c.env, ipKey),
  ]);
  const lockedUntil = Math.max(
    deviceAttempt && deviceAttempt.locked_until > nowMs ? deviceAttempt.locked_until : 0,
    ipAttempt && ipAttempt.locked_until > nowMs ? ipAttempt.locked_until : 0
  );
  if (lockedUntil > 0) {
    const retryAfter = Math.max(1, Math.ceil((lockedUntil - nowMs) / 1000));
    c.header("Retry-After", String(retryAfter));
    return c.json(
      { error: "locked", message: "Too many attempts. Try again later.", retry_after_sec: retryAfter },
      429
    );
  }

  const body = await readJson(c);
  const password = typeof body?.password === "string" ? body.password : "";
  const ok = await verifyPassword(password, device.password_hash);
  if (!ok) {
    const opts = { maxAttempts: LOGIN_MAX_ATTEMPTS, lockMs: LOGIN_LOCK_MS, windowMs: LOGIN_ATTEMPT_WINDOW_MS };
    const [row] = await Promise.all([
      recordLoginFailure(c.env, deviceKey, opts),
      recordLoginFailure(c.env, ipKey, opts),
    ]);
    const remaining = Math.max(0, LOGIN_MAX_ATTEMPTS - row.count);
    if (row.locked_until > 0) {
      c.header("Retry-After", String(Math.ceil(LOGIN_LOCK_MS / 1000)));
      return c.json({ error: "locked", remaining_attempts: 0 }, 429);
    }
    return c.json({ error: "invalid_password", remaining_attempts: remaining }, 401);
  }

  await Promise.all([clearLoginAttempt(c.env, deviceKey), clearLoginAttempt(c.env, ipKey)]);
  await auditOwner(c, device, {
    action: "console.login",
    target_type: "device",
    summary: "控制台密码登录成功",
  });
  const stamped = device.password_updated_at ?? null;
  const value = await signUserSession(secret, device.id, stamped);
  c.header("Set-Cookie", buildUserSessionCookie(value));
  return c.json({ ok: true, session: value });
});

accountApp.post("/auth/logout", async (c) => {
  const master = await requireMaster(c);
  if ("response" in master) return master.response;
  await auditOwner(c, master.device, {
    action: "console.logout",
    target_type: "device",
    summary: "退出控制台登录",
  });
  c.header("Set-Cookie", clearUserSessionCookie());
  return c.json({ ok: true });
});


function validGroupSelectionBody(
  body: Record<string, unknown> | null,
  keys: readonly string[]
): body is Record<string, string | null> {
  return body !== null && !Array.isArray(body) && Object.keys(body).length > 0 &&
    Object.keys(body).every((key) => keys.includes(key) &&
      (body[key] === null || (typeof body[key] === "string" && body[key].trim().length > 0)));
}

async function allowedGroupSelection(env: Env, deviceId: string, groupId: string | null): Promise<boolean> {
  return groupId === null || groupId === "auto" || groupId === "legacy" || (await listSelectableServiceGroups(env, deviceId)).some((group) => group.id === groupId);
}

accountApp.get("/service-groups", async (c) => {
  const master = await requireMaster(c);
  if ("response" in master) return master.response;
  const device = master.device;
  const [items, tokens] = await Promise.all([
    listSelectableServiceGroups(c.env, device.id),
    listSubTokens(c.env, device.id),
  ]);
  return c.json({
    items,
    default_service_group_id: device.default_service_group_id ?? null,
    service_group_id: device.service_group_id ?? null,
    sub_tokens: tokens.map((token) => ({ id: token.id, service_group_id: token.service_group_id ?? null })),
  });
});

accountApp.put("/service-group", async (c) => {
  const master = await requireAccount(c);
  if ("response" in master) return master.response;
  const device = master.device;
  const body = await readJson(c);
  const keys = ["default_service_group_id", "service_group_id"] as const;
  if (!validGroupSelectionBody(body, keys)) {
    return c.json({ error: "invalid_body", message: "仅接受 default_service_group_id 和 service_group_id（分组 ID、auto、legacy 或 null）" }, 400);
  }
  const changed = keys.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  const selectable = await listSelectableServiceGroups(c.env, device.id);
  if (changed.some((key) => body[key] !== null && body[key] !== "auto" && body[key] !== "legacy" && !selectable.some((group) => group.id === body[key]))) {
    return c.json({ error: "service_group_not_allowed" }, 403);
  }
  await ensureTokenPoliciesSchema(c.env);
  const policyWrites: D1PreparedStatement[] = [];
  for (const key of changed) {
    const tokenId = key === "default_service_group_id" ? "account" : "master";
    const stored = await getTokenRoutingPolicy(c.env, device.id, tokenId);
    const previous = stored?.policy_json ? parseTokenRoutingPolicy(JSON.parse(stored.policy_json)) : null;
    policyWrites.push(...tokenPolicyWriteStatements(c.env, device.id, tokenId, singleSelectionPolicy(body[key], previous)));
  }
  const [updated] = await c.env.DB.batch([c.env.DB.prepare(
    "UPDATE devices SET " + changed.map((key) => key + " = ?").join(", ") + " WHERE id = ? AND revoked_at IS NULL"
  ).bind(...changed.map((key) => body[key]), device.id), ...policyWrites]);
  if (Number(updated.meta.changes ?? 0) === 0) return c.json({ error: "not_found" }, 404);
  await auditOwner(c, device, {
    action: "console.service_group_selection",
    target_type: "device",
    summary: "更新账户服务分组",
    details: body,
  });
  return c.json({
    ok: true,
    default_service_group_id: changed.includes("default_service_group_id") ? body.default_service_group_id : device.default_service_group_id ?? null,
    service_group_id: changed.includes("service_group_id") ? body.service_group_id : device.service_group_id ?? null,
  });
});

accountApp.get("/service-groups/:id/models", async (c) => {
  const master = await requireMaster(c);
  if ("response" in master) return master.response;
  const groupId = c.req.param("id");
  if (!await allowedGroupSelection(c.env, master.device.id, groupId)) {
    return c.json({ error: "service_group_not_allowed" }, 403);
  }
  const device = { ...master.device, service_group_id: groupId, token_routing_policy: undefined };
  const models = await listModelProjectionsForDevice(c.env, device);
  return c.json({
    service_group_id: groupId,
    model_scope: device.model_scope || "all",
    model_count: models.length,
    items: models.map((model) => ({
      id: model.id,
      model_name: model.model_name,
      display_name: model.display_name || null,
      alias: model.alias || null,
      pricing_mode: model.pricing_mode || "unset",
      model_type: resolveModelType(model),
      billing_unit: model.billing_unit === "call" ? "call" : "token",
      input_price_per_m: model.input_price_per_m || 0,
      output_price_per_m: model.output_price_per_m || 0,
      cache_read_price_per_m: model.cache_read_price_per_m || 0,
      cache_write_price_per_m: model.cache_write_price_per_m || 0,
      price_per_call: model.price_per_call || 0,
      search_price_per_call: model.search_price_per_call || 0,
    })),
  });
});

async function policyChoices(env: Env, device: AuthedDevice) {
  const accountDevice = { ...device, token_routing_policy: undefined, service_group_id: "legacy", default_service_group_id: "legacy" };
  const groups = await listSelectableServiceGroups(env, device.id);
  const [legacy, projected] = await Promise.all([
    listModelProjectionsForDevice(env, accountDevice, { includeHidden: true }), projectServiceModelsForGroups(env, accountDevice, groups),
  ]);
  const identities = new Map<string, string>();
  const names = [...new Set(projected.flatMap(g => g.models.map(m => m.model_name)))];
  for (let i = 0; i < names.length; i += 80) {
    const chunk = names.slice(i, i + 80);
    const rows = await env.DB.prepare("SELECT id, name FROM public_model_identities WHERE enabled = 1 AND name IN (" + chunk.map(() => "?").join(",") + ")")
      .bind(...chunk).all<{ id: string; name: string }>();
    for (const row of rows.results || []) identities.set(row.name, row.id);
  }
  const models = new Map<string, { scope_key: string; model_name: string; display_name: string | null; model_type: string; group_ids: string[] }>();
  for (const model of legacy) {
    const scope_key = (model.is_group ? "group:" : "model:") + model.id;
    models.set(scope_key, { scope_key, model_name: model.model_name, display_name: model.display_name || null, model_type: resolveModelType(model), group_ids: [] });
  }
  for (const group of projected) for (const model of group.models) {
    const identity = identities.get(model.model_name);
    const scope_key = identity ? "public:" + identity : (model.is_group ? "group:" : "model:") + model.id;
    const existing = models.get(scope_key);
    if (existing) { if (!existing.group_ids.includes(group.group.id)) existing.group_ids.push(group.group.id); }
    else models.set(scope_key, { scope_key, model_name: model.model_name, display_name: model.display_name || null, model_type: resolveModelType(model), group_ids: [group.group.id] });
  }
  return { groups: groups.map(g => ({ id: g.id, name: g.name })), models: [...models.values()] };
}
async function policyTarget(c: Context<{ Bindings: Env }>, device: AuthedDevice, tokenId: string): Promise<DeviceRow | Response> {
  if (tokenId === "account" || tokenId === "master") return device;
  const sub = await getSubTokenById(c.env, device.id, tokenId);
  if (!sub) return c.json({ error: "not_found" }, 404);
  if (sub.revoked_at) return c.json({ error: "token_revoked" }, 409);
  return { ...device, service_group_id: sub.service_group_id ?? null };
}
async function policyResponse(c: Context<{ Bindings: Env }>, device: AuthedDevice, tokenId: string, target: DeviceRow) {
  const [stored, effective, choices, tokens, policies] = await Promise.all([
    getTokenRoutingPolicy(c.env, device.id, tokenId),
    resolveTokenRoutingPolicy(c.env, tokenId === "account" ? { ...device, service_group_id: null } : target, tokenId),
    policyChoices(c.env, device), listSubTokens(c.env, device.id),
    c.env.DB.prepare("SELECT token_id, policy_json FROM token_routing_policies WHERE device_id = ?").bind(device.id).all<{ token_id: string; policy_json: string | null }>(),
  ]);
  const byId = new Map((policies.results || []).map(r => [r.token_id, r]));
  const follows = (id: string, old: string | null | undefined) => byId.has(id) ? byId.get(id)!.policy_json === null : old == null;
  const following = tokens.filter(t => !t.revoked_at && follows(t.id, t.service_group_id)).length + Number(follows("master", device.service_group_id));
  return c.json({ policy: stored?.policy_json ? parseTokenRoutingPolicy(JSON.parse(stored.policy_json)) : null,
    effective_policy: effective.policy, source: effective.source, version: effective.version,
    following_token_count: following, ...choices });
}
async function routingPolicyGet(c: Context<{ Bindings: Env }>, tokenId: string) {
  const master = await requireAccount(c);
  if ("response" in master) return master.response;
  const target = await policyTarget(c, master.device, tokenId);
  if (target instanceof Response) return target;
  return policyResponse(c, master.device, tokenId, target);
}
async function routingPolicyPut(c: Context<{ Bindings: Env }>, tokenId: string) {
  const master = await requireAccount(c);
  if ("response" in master) return master.response;
  const device = master.device;
  const target = await policyTarget(c, device, tokenId);
  if (target instanceof Response) return target;
  const body = await readJson(c);
  if (!body || Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, "policy")) return c.json({ error: "invalid_body" }, 400);
  let policy: TokenRoutingPolicy | null;
  try { policy = parseTokenRoutingPolicy(body.policy); } catch (error) {
    return c.json({ error: "invalid_routing_policy", message: error instanceof Error ? error.message : "Invalid routing policy" }, 400);
  }
  const choices = await policyChoices(c.env, device);
  if (policy && policy.group_ids.some(id => !choices.groups.some(g => g.id === id))) return c.json({ error: "service_group_not_allowed" }, 403);
  const allowed = new Set(choices.models.map(m => m.scope_key));
  if (policy && (policy.model_scope?.some(key => !allowed.has(key)) || Object.keys(policy.model_overrides).some(key => !allowed.has(key)))) {
    return c.json({ error: "model_scope_not_allowed" }, 403);
  }
  if (policy && Object.entries(policy.model_overrides).some(([key, id]) => !choices.models.find(m => m.scope_key === key)?.group_ids.includes(id))) {
    return c.json({ error: "model_override_not_available" }, 400);
  }
  await putTokenRoutingPolicy(c.env, device.id, tokenId, policy);
  await auditOwner(c, device, { action: "console.routing_policy", target_type: tokenId === "account" ? "device" : "token", target_id: tokenId,
    summary: "更新调用策略与模型范围", details: { token_id: tokenId, policy } });
  return policyResponse(c, device, tokenId, target);
}
accountApp.post("/routing-preview", async c => {
  const master = await requireAccount(c);
  if ("response" in master) return master.response;
  const body = await readJson(c);
  if (!body || Object.keys(body).some(key => !["token_id", "model"].includes(key))
      || typeof body.token_id !== "string" || !body.token_id || body.token_id.length > 200
      || typeof body.model !== "string" || !body.model.trim() || body.model.length > 300) {
    return c.json({ error: "invalid_body" }, 400);
  }
  const target = await policyTarget(c, master.device, body.token_id);
  if (target instanceof Response) return target;
  return c.json(await previewTokenRouting(c.env, target, body.token_id, body.model));
});
accountApp.get("/routing-policy", c => routingPolicyGet(c, "account"));
accountApp.put("/routing-policy", c => routingPolicyPut(c, "account"));
accountApp.get("/tokens/:id/routing-policy", c => routingPolicyGet(c, c.req.param("id")));
accountApp.put("/tokens/:id/routing-policy", c => routingPolicyPut(c, c.req.param("id")));


accountApp.get("/tokens", async (c) => {
  const master = await requireAccount(c);
  if ("response" in master) return master.response;
  const device = master.device;
  const rows = await listSubTokens(c.env, device.id, {
    includeRevoked: c.req.query("include_revoked") === "1",
  });
  const live = rows.filter((r) => !r.revoked_at).length;
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
    limit: SUB_TOKEN_LIMIT,
    remaining: Math.max(0, SUB_TOKEN_LIMIT - live),
  });
});

accountApp.post("/tokens", async (c) => {
  const master = await requireAccount(c);
  if ("response" in master) return master.response;
  const device = master.device;
  const body = await readJson(c);
  const rawName = typeof body?.name === "string" ? body.name.trim() : "";
  if (rawName.length === 0 || rawName.length > 100) {
    return c.json({ error: "invalid_name", message: "名称不能为空且不超过 100 字" }, 400);
  }
  if (body && Object.prototype.hasOwnProperty.call(body, "service_group_id")) {
    if (!validGroupSelectionBody({ service_group_id: body.service_group_id }, ["service_group_id"])) {
      return c.json({ error: "invalid_body", message: "service_group_id 必须是分组 ID、auto、legacy 或 null" }, 400);
    }
    if (!await allowedGroupSelection(c.env, device.id, body.service_group_id as string | null)) {
      return c.json({ error: "service_group_not_allowed" }, 403);
    }
  }
  const serviceGroupId = (body?.service_group_id ?? null) as string | null;
  const token = generateDeviceToken();
  const tokenHash = await hashToken(token);
  const created = await createSubToken(c.env, device.id, rawName, tokenHash);
  if (!created.ok) {
    if (created.reason === "limit") {
      return c.json(
        { error: "sub_token_limit_reached", message: "最多只能有 " + SUB_TOKEN_LIMIT + " 个可用子 Token", limit: SUB_TOKEN_LIMIT },
        409
      );
    }
    return c.json({ error: "not_found" }, 404);
  }
  const row = created.row;
  if (serviceGroupId !== null) {
    const selected = await c.env.DB.prepare(
      "UPDATE device_sub_tokens SET service_group_id = ? WHERE id = ? AND device_id = ? AND revoked_at IS NULL"
    ).bind(serviceGroupId, row.id, device.id).run();
    if (Number(selected.meta.changes ?? 0) === 0) return c.json({ error: "not_found" }, 404);
  }
  await auditOwner(c, device, {
    action: "console.sub_token_create",
    target_type: "sub_token",
    target_id: row.id,
    summary: "新建子 Token「" + row.name + "」",
    details: { service_group_id: serviceGroupId },
  });
  return c.json(
    {
      item: {
        id: row.id,
        name: row.name,
        enabled: true,
        revoked: false,
        last_used_at: null,
        created_at: row.created_at,
        service_group_id: serviceGroupId,
      },
      token,
    },
    201
  );
});

accountApp.put("/tokens/:id/service-group", async (c) => {
  const master = await requireAccount(c);
  if ("response" in master) return master.response;
  const device = master.device;
  const existing = await getSubTokenById(c.env, device.id, c.req.param("id"));
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.revoked_at) return c.json({ error: "token_revoked" }, 409);
  const body = await readJson(c);
  if (!validGroupSelectionBody(body, ["service_group_id"])) {
    return c.json({ error: "invalid_body", message: "仅接受 service_group_id（分组 ID、auto、legacy 或 null）" }, 400);
  }
  const serviceGroupId = body.service_group_id;
  if (!await allowedGroupSelection(c.env, device.id, serviceGroupId)) {
    return c.json({ error: "service_group_not_allowed" }, 403);
  }
  await ensureTokenPoliciesSchema(c.env);
  const stored = await getTokenRoutingPolicy(c.env, device.id, existing.id);
  const previous = stored?.policy_json ? parseTokenRoutingPolicy(JSON.parse(stored.policy_json)) : null;
  const [updated] = await c.env.DB.batch([c.env.DB.prepare(
    "UPDATE device_sub_tokens SET service_group_id = ? WHERE id = ? AND device_id = ? AND revoked_at IS NULL"
  ).bind(serviceGroupId, existing.id, device.id), ...tokenPolicyWriteStatements(c.env, device.id, existing.id, singleSelectionPolicy(serviceGroupId, previous))]);
  if (Number(updated.meta.changes ?? 0) === 0) return c.json({ error: "token_revoked" }, 409);
  await auditOwner(c, device, {
    action: "console.sub_token_service_group",
    target_type: "sub_token",
    target_id: existing.id,
    summary: "更新子 Token 服务分组",
    details: { service_group_id: serviceGroupId },
  });
  return c.json({ item: { id: existing.id, service_group_id: serviceGroupId } });
});

accountApp.post("/tokens/:id/enable", async (c) => {
  const master = await requireAccount(c);
  if ("response" in master) return master.response;
  const body = await readJson(c);
  if (typeof body?.enabled !== "boolean") {
    return c.json({ error: "invalid_body", message: "enabled 必须是布尔值" }, 400);
  }
  const row = await setSubTokenEnabled(c.env, master.device.id, c.req.param("id"), body.enabled);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.revoked_at) return c.json({ error: "token_revoked" }, 409);
  await auditOwner(c, master.device, {
    action: body.enabled ? "console.sub_token_enable" : "console.sub_token_disable",
    target_type: "sub_token",
    target_id: row.id,
    summary: (body.enabled ? "启用" : "禁用") + "子 Token「" + row.name + "」",
  });
  return c.json({ item: { id: row.id, name: row.name, enabled: Boolean(row.enabled), revoked: false } });
});

accountApp.post("/tokens/:id/revoke", async (c) => {
  const master = await requireAccount(c);
  if ("response" in master) return master.response;
  const row = await revokeSubToken(c.env, master.device.id, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  await auditOwner(c, master.device, {
    action: "console.sub_token_revoke",
    target_type: "sub_token",
    target_id: row.id,
    summary: "撤销子 Token「" + row.name + "」",
  });
  return c.json({ item: { id: row.id, name: row.name, enabled: false, revoked: true } });
});


/**
 * Lets a signed-in user paste an API key and learn whether it works for this account, without
 * spending anything. Only keys that belong to the caller's own account are described; anything
 * else is reported as "unknown", so the endpoint cannot be used to probe other accounts.
 */
accountApp.post("/api-key-check", async (c) => {
  const master = await requireAccount(c);
  if ("response" in master) return master.response;
  const device = master.device;
  const body = await readJson(c);
  const raw = typeof body?.key === "string" ? body.key : "";
  if (!raw.trim() || raw.length > 1024) return c.json({ error: "invalid_body", message: "请粘贴要检查的 API 密钥" }, 400);
  // Clients often keep a stray space, quotes or a "Bearer " prefix copied from an example.
  const key = raw.trim().replace(/^bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
  const cleaned = key !== raw;
  const wallet = await getWallet(c.env, device.id);
  const account = {
    calls_enabled: Number(device.calls_enabled ?? 1) !== 0,
    available_usd: Number((wallet.balance_usd - wallet.reserved_usd).toFixed(4)),
  };
  const usable = await resolveToken(c.env, key);
  if (usable && usable.id === device.id) {
    const rows = await listModelProjectionsForDevice(c.env, usable);
    const models = [...new Set((rows as Array<{ model_name?: string | null; alias?: string | null }>)
      .map(row => row.alias || row.model_name || "").filter(Boolean))];
    const sub = usable.sub_token_id ? await getSubTokenById(c.env, device.id, usable.sub_token_id) : null;
    return c.json({
      kind: usable.auth_via === "sub" ? "api_key" : "login_token",
      name: sub?.name ?? null,
      status: "active",
      cleaned,
      ...account,
      model_count: models.length,
      models: models.slice(0, 12),
    });
  }
  const hash = await hashToken(key);
  const own = await c.env.DB.prepare(
    "SELECT name, enabled, revoked_at FROM device_sub_tokens WHERE token_hash = ? AND device_id = ?"
  ).bind(hash, device.id).first<{ name: string; enabled: number; revoked_at: number | null }>();
  if (own) {
    return c.json({ kind: "api_key", name: own.name, status: own.revoked_at ? "revoked" : "disabled", cleaned, ...account, model_count: null, models: [] });
  }
  return c.json({ kind: "unknown", name: null, status: null, cleaned, ...account, model_count: null, models: [] });
});

accountApp.get("/calls", async (c) => {
  const master = await requireMaster(c);
  if ("response" in master) return master.response;
  return c.json({ calls_enabled: Number(master.device.calls_enabled ?? 1) !== 0 });
});

accountApp.post("/calls", async (c) => {
  const master = await requireAccount(c);
  if ("response" in master) return master.response;
  const body = await readJson(c);
  if (typeof body?.enabled !== "boolean") {
    return c.json({ error: "invalid_body", message: "enabled 必须是布尔值" }, 400);
  }
  const row = await updateDevice(c.env, master.device.id, { calls_enabled: body.enabled });
  if (!row) return c.json({ error: "not_found" }, 404);
  await auditOwner(c, master.device, {
    action: body.enabled ? "console.calls_enable" : "console.calls_disable",
    target_type: "device",
    summary: (body.enabled ? "自助恢复" : "自助禁止") + "调用",
  });
  return c.json({ calls_enabled: Number(row.calls_enabled ?? 1) !== 0 });
});

export { requireAccount, requireMaster, sessionSecret };
