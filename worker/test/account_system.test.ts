import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatewayApp } from '../src/gateway/index';
import { consoleApp } from '../src/console';
import { devicesApp } from '../src/admin/devices';
import { resetRateLimitMemory } from '../src/gateway/ratelimit';
import { clearMemoryCacheForTest } from '../src/gateway/cache';
import { hashPassword, hashToken, passwordPolicyError } from '../src/utils/crypto';
import {
  CollectingExecutionContext,
  chatBody,
  createRealD1,
  makeEnv,
  openAiAnswer,
  seedDevice,
  seedModel,
  seedProvider,
  DEVICE_ID,
  TOKEN,
} from './helpers/realGatewayEnv';
import type { Env } from '../src/types';


const SESSION_SECRET = 'test-console-session-secret';
const SUB_TOKEN = 'ccs_sub_token_one';
const PASSWORD = 'password123';

type D1 = ReturnType<typeof createRealD1>;

function envFor(d1: D1): Env {
  const env = makeEnv(d1);
  (env as unknown as Record<string, unknown>).SESSION_SECRET = SESSION_SECRET;
  return env;
}

interface SeedOpts {
  callsEnabled?: number;
  balanceUsd?: number;
}

async function seed(d1: D1, opts: SeedOpts = {}) {
  seedProvider(d1);
  seedModel(d1);
  await seedDevice(d1, { balance_usd: opts.balanceUsd ?? 5 });
  if (opts.callsEnabled !== undefined) {
    d1.sql('UPDATE devices SET calls_enabled = ? WHERE id = ?', opts.callsEnabled, DEVICE_ID);
  }
}

async function seedSubToken(
  d1: D1,
  opts: { id?: string; token?: string; enabled?: number; deviceId?: string } = {}
): Promise<string> {
  const id = opts.id ?? 'sub_1';
  const tokenHash = await hashToken(opts.token ?? SUB_TOKEN);
  d1.sql(
    'INSERT OR REPLACE INTO device_sub_tokens (id, device_id, name, token_hash, enabled, last_used_at, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)',
    id,
    opts.deviceId ?? DEVICE_ID,
    'script',
    tokenHash,
    opts.enabled ?? 1,
    1
  );
  return id;
}

function cookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0] || '';
}

function getConsole(env: Env, path: string, token = TOKEN, cookie?: string) {
  const headers: Record<string, string> = { authorization: 'Bearer ' + token };
  if (cookie) headers.cookie = cookie;
  return consoleApp.request('http://gw.test' + path, { method: 'GET', headers }, env);
}

function postConsole(env: Env, path: string, body: unknown, token = TOKEN, cookie?: string) {
  const headers: Record<string, string> = {
    authorization: 'Bearer ' + token,
    'content-type': 'application/json',
  };
  if (cookie) headers.cookie = cookie;
  return consoleApp.request(
    'http://gw.test' + path,
    { method: 'POST', headers, body: JSON.stringify(body) },
    env
  );
}

async function postChat(env: Env, token = TOKEN) {
  const exec = new CollectingExecutionContext();
  const res = await gatewayApp.request(
    'http://gw.test/chat/completions',
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    },
    env,
    exec as never
  );
  await Promise.all(exec.pending);
  return res;
}

async function setUpPassword(env: Env, password = PASSWORD): Promise<string> {
  const res = await postConsole(env, '/auth/setup', { password });
  expect(res.status).toBe(200);
  return cookieOf(res);
}

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => openAiAnswer()) as unknown as typeof globalThis.fetch;
  resetRateLimitMemory();
  clearMemoryCacheForTest();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('the calls switch pauses the master token and nothing else', () => {
  it('refuses a new master call with 403 calls_disabled', async () => {
    const d1 = createRealD1();
    await seed(d1, { callsEnabled: 0 });
    const res = await postChat(envFor(d1));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('calls_disabled');
  });

  it('lets a sub-token answer normally while the master is paused', async () => {
    const d1 = createRealD1();
    await seed(d1, { callsEnabled: 0 });
    await seedSubToken(d1);
    const res = await postChat(envFor(d1), SUB_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toBe('pong');
  });

  it('still lets the owner open the console to switch it back on', async () => {
    const d1 = createRealD1();
    await seed(d1, { callsEnabled: 0 });
    const res = await getConsole(envFor(d1), '/me');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { device: { calls_enabled: boolean } };
    expect(body.device.calls_enabled).toBe(false);
  });

  it('leaves model discovery answering, because the gate is not in resolveDevice', async () => {
    const d1 = createRealD1();
    await seed(d1, { callsEnabled: 0 });
    const env = envFor(d1);
    const res = await gatewayApp.request(
      'http://gw.test/models',
      { method: 'GET', headers: { authorization: 'Bearer ' + TOKEN } },
      env
    );
    expect(res.status).toBe(200);
  });

  it('lets the owner flip the switch back on from the console', async () => {
    const d1 = createRealD1();
    await seed(d1, { callsEnabled: 0 });
    const env = envFor(d1);
    const cookie = await setUpPassword(env);
    const res = await postConsole(env, '/calls', { enabled: true }, TOKEN, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { calls_enabled: boolean };
    expect(body.calls_enabled).toBe(true);
    expect((await postChat(env)).status).toBe(200);
  });
});

describe('first sign-in sets the password instead of asking for one', () => {
  it('reports password_setup_required for a device that has none', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const res = await getConsole(envFor(d1), '/auth/session');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { password_setup_required: boolean; authenticated: boolean };
    expect(body.password_setup_required).toBe(true);
    expect(body.authenticated).toBe(false);
  });

  it('refuses to log in before a password exists', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const res = await postConsole(envFor(d1), '/auth/login', { password: PASSWORD });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('password_setup_required');
  });

  it('rejects 7 characters and accepts 8, with no complexity rule', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    const short = await postConsole(env, '/auth/setup', { password: '1234567' });
    expect(short.status).toBe(400);
    expect(((await short.json()) as { error: string }).error).toBe('weak_password');
    const plainDigits = await postConsole(env, '/auth/setup', { password: '12345678' });
    expect(plainDigits.status).toBe(200);
  });

  it('caps the length at 20 and lets exactly 20 through', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    const tooLong = await postConsole(env, '/auth/setup', { password: 'a'.repeat(21) });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toBe('weak_password');
    const atLimit = await postConsole(env, '/auth/setup', { password: 'a'.repeat(20) });
    expect(atLimit.status).toBe(200);
  });

  it('keeps the password to the ASCII symbol set it can survive every transport with', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    for (const bad of ['abc def ghi', '密码密码密码', 'abc\\ndefgh']) {
      const res = await postConsole(env, '/auth/setup', { password: bad });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('weak_password');
    }
    const good = await postConsole(env, '/auth/setup', { password: 'Ab!@#$%^&*()_-=:?' });
    expect(good.status).toBe(200);
  });

  it('still logs in a password that the current policy would refuse, because the rule is setup-only', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    const legacy = 'legacy password with spaces 123456';
    expect(passwordPolicyError(legacy)).not.toBeNull();
    d1.sql('UPDATE devices SET password_hash = ?, password_updated_at = ? WHERE id = ?', await hashPassword(legacy), 1, DEVICE_ID);
    const login = await postConsole(env, '/auth/login', { password: legacy });
    expect(login.status).toBe(200);
  });

  it('refuses to overwrite an existing password, so a stolen token cannot take the account', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    await setUpPassword(env);
    const again = await postConsole(env, '/auth/setup', { password: 'another-password' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('password_already_set');
  });

  it('signs in with the password and marks the session authenticated', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    await setUpPassword(env);
    const login = await postConsole(env, '/auth/login', { password: PASSWORD });
    expect(login.status).toBe(200);
    const session = await getConsole(env, '/auth/session', TOKEN, cookieOf(login));
    const body = (await session.json()) as { authenticated: boolean };
    expect(body.authenticated).toBe(true);
  });

  it('counts a wrong password and tells the caller how many tries are left', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    await setUpPassword(env);
    const res = await postConsole(env, '/auth/login', { password: 'wrong-password' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; remaining_attempts: number };
    expect(body.error).toBe('invalid_password');
    expect(body.remaining_attempts).toBe(4);
  });

  it('has no self-service password change endpoint', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    const cookie = await setUpPassword(env);
    const res = await postConsole(env, '/auth/change-password', { password: 'x' }, TOKEN, cookie);
    expect(res.status).toBe(404);
  });

  it('revokes every browser when an admin clears the password', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    const cookie = await setUpPassword(env);
    const before = (await (await getConsole(env, '/auth/session', TOKEN, cookie)).json()) as {
      authenticated: boolean;
    };
    expect(before.authenticated).toBe(true);

    const admin = await devicesApp.request(
      'http://gw.test/' + DEVICE_ID + '/reset-password',
      { method: 'POST' },
      env
    );
    expect(admin.status).toBe(200);

    const after = (await (await getConsole(env, '/auth/session', TOKEN, cookie)).json()) as {
      authenticated: boolean;
      password_setup_required: boolean;
    };
    expect(after.authenticated).toBe(false);
    expect(after.password_setup_required).toBe(true);
  });
});

describe('sub-token management', () => {
  it('stops at five live tokens and frees a slot when one is revoked', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    const cookie = await setUpPassword(env);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await postConsole(env, '/tokens', { name: 'k' + i }, TOKEN, cookie);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { item: { id: string }; token: string };
      expect(body.token.startsWith('ccs_')).toBe(true);
      ids.push(body.item.id);
    }
    const sixth = await postConsole(env, '/tokens', { name: 'k6' }, TOKEN, cookie);
    expect(sixth.status).toBe(409);
    expect(((await sixth.json()) as { error: string }).error).toBe('sub_token_limit_reached');

    const revoked = await postConsole(env, '/tokens/' + ids[0] + '/revoke', {}, TOKEN, cookie);
    expect(revoked.status).toBe(200);
    const reuse = await postConsole(env, '/tokens', { name: 'k7' }, TOKEN, cookie);
    expect(reuse.status).toBe(201);
  });

  it('requires the password session to mint a token', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    await setUpPassword(env);
    const res = await postConsole(env, '/tokens', { name: 'no-session' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('password_required');
  });

  it('stops working the moment it is disabled or revoked', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    const cookie = await setUpPassword(env);
    const created = await postConsole(env, '/tokens', { name: 'script' }, TOKEN, cookie);
    const body = (await created.json()) as { item: { id: string }; token: string };
    expect((await postChat(env, body.token)).status).toBe(200);

    const disabled = await postConsole(
      env,
      '/tokens/' + body.item.id + '/enable',
      { enabled: false },
      TOKEN,
      cookie
    );
    expect(disabled.status).toBe(200);
    expect((await postChat(env, body.token)).status).toBe(401);
  });
});

describe('spend is attributed to the sub-token but billed to the master', () => {
  it('records sub_token_id on the usage row and keeps the wallet on the master', async () => {
    const d1 = createRealD1();
    await seed(d1, { balanceUsd: 5 });
    const subId = await seedSubToken(d1);
    const env = envFor(d1);
    expect((await postChat(env, SUB_TOKEN)).status).toBe(200);

    const usage = d1.rows<{ device_id: string; sub_token_id: string | null; cost_usd: number }>(
      'SELECT device_id, sub_token_id, cost_usd FROM usage'
    );
    expect(usage).toHaveLength(1);
    expect(usage[0].device_id).toBe(DEVICE_ID);
    expect(usage[0].sub_token_id).toBe(subId);

    const ledger = d1.rows<{ device_id: string; delta_usd: number }>(
      'SELECT device_id, delta_usd FROM wallet_ledger'
    );
    expect(ledger.length).toBeGreaterThan(0);
    for (const row of ledger) expect(row.device_id).toBe(DEVICE_ID);
    expect(ledger.some((row) => row.delta_usd < 0)).toBe(true);

    const sub = d1.row<{ last_used_at: number | null }>(
      'SELECT last_used_at FROM device_sub_tokens WHERE id = ?',
      subId
    );
    expect(sub?.last_used_at).not.toBeNull();
  });

  it('leaves a master-token call with a null sub_token_id', async () => {
    const d1 = createRealD1();
    await seed(d1);
    expect((await postChat(envFor(d1))).status).toBe(200);
    const usage = d1.rows<{ sub_token_id: string | null }>('SELECT sub_token_id FROM usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].sub_token_id).toBeNull();
  });
});

describe('a sub-token is a model credential and never a console login', () => {
  it('answers 403 sub_token_not_allowed on every console endpoint', async () => {
    const d1 = createRealD1();
    await seed(d1);
    await seedSubToken(d1);
    const env = envFor(d1);
    const paths = ['/me', '/quota', '/usage', '/models', '/announcement'];
    for (const path of paths) {
      const res = await getConsole(env, path, SUB_TOKEN);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('sub_token_not_allowed');
    }
    const chat = await postConsole(env, '/chat', { model: 'gw-primary' }, SUB_TOKEN);
    expect(chat.status).toBe(403);
    expect(((await chat.json()) as { error: string }).error).toBe('sub_token_not_allowed');
  });

  it('cannot mint more sub-tokens', async () => {
    const d1 = createRealD1();
    await seed(d1);
    await seedSubToken(d1);
    const res = await postConsole(envFor(d1), '/tokens', { name: 'escalate' }, SUB_TOKEN);
    expect(res.status).toBe(403);
  });

  it('uses a different error code from the calls switch, so the two are never confused', async () => {
    const d1 = createRealD1();
    await seed(d1, { callsEnabled: 0 });
    await seedSubToken(d1);
    const env = envFor(d1);
    const paused = (await (await postChat(env)).json()) as { error: string };
    const console403 = (await (await getConsole(env, '/me', SUB_TOKEN)).json()) as { error: string };
    expect(paused.error).toBe('calls_disabled');
    expect(console403.error).toBe('sub_token_not_allowed');
    expect(paused.error).not.toBe(console403.error);
  });
});

describe('the X-Console-Session fallback for Set-Cookie-stripping middleboxes', () => {
  function withSession(headers: Record<string, string>, session?: string) {
    if (session) headers['x-console-session'] = session;
    return headers;
  }

  it('setup and login both answer with the session value in the body', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    const setup = await postConsole(env, '/auth/setup', { password: PASSWORD });
    expect(setup.status).toBe(200);
    const setupBody = (await setup.clone().json()) as { session?: string };
    expect(typeof setupBody.session).toBe('string');
    expect(setupBody.session).toContain('.');

    const login = await postConsole(env, '/auth/login', { password: PASSWORD });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { session?: string };
    expect(typeof loginBody.session).toBe('string');
    expect(loginBody.session).toContain('.');
    expect((loginBody.session as string).split('.').length).toBe(2);
  });

  it('accepts the header on account-gated endpoints when no cookie is present', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    await postConsole(env, '/auth/setup', { password: PASSWORD });
    const login = await postConsole(env, '/auth/login', { password: PASSWORD });
    const { session } = (await login.json()) as { session: string };

    const res = await consoleApp.request(
      'http://gw.test/tokens',
      {
        method: 'GET',
        headers: withSession({ authorization: 'Bearer ' + TOKEN }, session),
      },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('the header path still enforces the password epoch: a stale session is rejected', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    await postConsole(env, '/auth/setup', { password: PASSWORD });
    const login = await postConsole(env, '/auth/login', { password: PASSWORD });
    const { session } = (await login.json()) as { session: string };

    d1.sql('UPDATE devices SET password_updated_at = ? WHERE id = ?', Date.now() + 5_000, DEVICE_ID);

    const res = await consoleApp.request(
      'http://gw.test/tokens',
      {
        method: 'GET',
        headers: withSession({ authorization: 'Bearer ' + TOKEN }, session),
      },
      env
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('password_required');
  });

  it('rejects a session minted for another device even when the token presented is valid', async () => {
    const d1 = createRealD1();
    await seed(d1);
    const env = envFor(d1);
    await postConsole(env, '/auth/setup', { password: PASSWORD });
    const login = await postConsole(env, '/auth/login', { password: PASSWORD });
    const { session } = (await login.json()) as { session: string };

    const otherId = 'dev_someone_else';
    await seedDevice(d1, { id: otherId });

    const res = await consoleApp.request(
      'http://gw.test/tokens',
      {
        method: 'GET',
        headers: withSession({ authorization: 'Bearer ' + TOKEN }, session),
      },
      env
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('password_required');
  });
});
