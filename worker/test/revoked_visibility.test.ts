import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { devicesApp } from '../src/admin/devices';
import { deviceTemplatesApp } from '../src/admin/device-templates';
import { consoleApp } from '../src/console';
import { resetRateLimitMemory } from '../src/gateway/ratelimit';
import { clearMemoryCacheForTest } from '../src/gateway/cache';
import { hashToken } from '../src/utils/crypto';
import {
  createRealD1,
  makeEnv,
  openAiAnswer,
  seedDevice,
  DEVICE_ID,
  TOKEN,
} from './helpers/realGatewayEnv';
import type { Env } from '../src/types';


const SESSION_SECRET = 'test-console-session-secret';
const PASSWORD = 'horse-battery-1';

type D1 = ReturnType<typeof createRealD1>;

function envFor(d1: D1): Env {
  const env = makeEnv(d1);
  (env as unknown as Record<string, unknown>).SESSION_SECRET = SESSION_SECRET;
  return env;
}

async function seedSubToken(d1: D1, opts: { id?: string; token?: string; revoked?: boolean } = {}): Promise<string> {
  const id = opts.id ?? 'sub_1';
  d1.sql(
    'INSERT OR REPLACE INTO device_sub_tokens (id, device_id, name, token_hash, enabled, last_used_at, created_at, revoked_at) VALUES (?, ?, ?, ?, 1, NULL, ?, ?)',
    id,
    DEVICE_ID,
    'script',
    await hashToken(opts.token ?? 'ccs_sub_token_one'),
    1,
    opts.revoked ? 2 : null
  );
  return id;
}

function cookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0] || '';
}

async function consoleSession(env: Env): Promise<string> {
  const res = await consoleApp.request(
    'http://gw.test/auth/setup',
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    },
    env
  );
  expect(res.status).toBe(200);
  return cookieOf(res);
}

function getConsole(env: Env, path: string, cookie: string) {
  return consoleApp.request(
    'http://gw.test' + path,
    { method: 'GET', headers: { authorization: 'Bearer ' + TOKEN, cookie } },
    env
  );
}

beforeEach(() => {
  resetRateLimitMemory();
  clearMemoryCacheForTest();
  globalThis.fetch = vi.fn(async () => openAiAnswer()) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the admin device list hides revoked devices', () => {
  it('omits a revoked device unless include_revoked=1 asks for it', async () => {
    const d1 = createRealD1();
    const env = envFor(d1);
    await seedDevice(d1);
    await seedDevice(d1, { id: 'dev_gone', token_hash: await hashToken('ccs_gone_token') });
    d1.sql('UPDATE devices SET enabled = 0, revoked_at = ? WHERE id = ?', 99, 'dev_gone');

    const hidden = (await (await devicesApp.request('http://gw.test/', {}, env)).json()) as {
      items: { id: string }[];
    };
    expect(hidden.items.map((d) => d.id)).toEqual([DEVICE_ID]);

    const shown = (await (
      await devicesApp.request('http://gw.test/?include_revoked=1', {}, env)
    ).json()) as { items: { id: string; revoked_at: number | null }[] };
    expect(shown.items.map((d) => d.id).sort()).toEqual([DEVICE_ID, 'dev_gone']);
    expect(shown.items.find((d) => d.id === 'dev_gone')?.revoked_at).toBe(99);
    d1.close();
  });
});

describe('the sub-token list hides revoked tokens', () => {
  it('omits a revoked sub-token in both the admin and the owner view', async () => {
    const d1 = createRealD1();
    const env = envFor(d1);
    await seedDevice(d1);
    await seedSubToken(d1, { id: 'sub_live' });
    await seedSubToken(d1, { id: 'sub_gone', token: 'ccs_sub_gone', revoked: true });

    const admin = (await (
      await devicesApp.request('http://gw.test/' + DEVICE_ID + '/sub-tokens', {}, env)
    ).json()) as { items: { id: string }[] };
    expect(admin.items.map((t) => t.id)).toEqual(['sub_live']);

    const adminAll = (await (
      await devicesApp.request('http://gw.test/' + DEVICE_ID + '/sub-tokens?include_revoked=1', {}, env)
    ).json()) as { items: { id: string; revoked: boolean }[] };
    expect(adminAll.items.map((t) => t.id).sort()).toEqual(['sub_gone', 'sub_live']);
    expect(adminAll.items.find((t) => t.id === 'sub_gone')?.revoked).toBe(true);
    d1.close();
  });

  it('keeps the remaining quota counted on live rows, with or without the revoked ones', async () => {
    const d1 = createRealD1();
    const env = envFor(d1);
    await seedDevice(d1);
    const cookie = await consoleSession(env);
    for (let i = 0; i < 3; i += 1) {
      await seedSubToken(d1, { id: 'sub_live_' + i, token: 'ccs_live_' + i });
    }
    await seedSubToken(d1, { id: 'sub_gone', token: 'ccs_gone', revoked: true });

    const plain = (await (await getConsole(env, '/tokens', cookie)).json()) as {
      items: { id: string }[];
      remaining: number;
      limit: number;
    };
    expect(plain.items.map((t) => t.id).sort()).toEqual(['sub_live_0', 'sub_live_1', 'sub_live_2']);
    expect(plain.remaining).toBe(2);
    expect(plain.limit).toBe(5);

    const full = (await (await getConsole(env, '/tokens?include_revoked=1', cookie)).json()) as {
      items: { id: string; revoked: boolean }[];
      remaining: number;
    };
    expect(full.items.map((t) => t.id).sort()).toEqual(['sub_gone', 'sub_live_0', 'sub_live_1', 'sub_live_2']);
    expect(full.items.find((t) => t.id === 'sub_gone')?.revoked).toBe(true);
    expect(full.remaining).toBe(2);
    d1.close();
  });
});

describe('hiding revoked rows does not change what the quota counts', () => {
  it('still allows five live tokens after a revoked one exists', async () => {
    const d1 = createRealD1();
    const env = envFor(d1);
    await seedDevice(d1);
    const cookie = await consoleSession(env);
    await seedSubToken(d1, { id: 'sub_gone', token: 'ccs_gone', revoked: true });
    for (let i = 0; i < 5; i += 1) {
      const res = await consoleApp.request(
        'http://gw.test/tokens',
        {
          method: 'POST',
          headers: { authorization: 'Bearer ' + TOKEN, cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'k' + i }),
        },
        env
      );
      expect(res.status).toBe(201);
    }
    const sixth = await consoleApp.request(
      'http://gw.test/tokens',
      {
        method: 'POST',
        headers: { authorization: 'Bearer ' + TOKEN, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'k6' }),
      },
      env
    );
    expect(sixth.status).toBe(409);
    d1.close();
  });
});

describe('template targets still see revoked devices', () => {
  it('answers device_revoked, not unknown_device_ids, for an explicitly named revoked device', async () => {
    const d1 = createRealD1();
    const env = envFor(d1);
    await seedDevice(d1);
    await seedDevice(d1, { id: 'dev_gone', token_hash: await hashToken('ccs_gone_token') });
    d1.sql('UPDATE devices SET enabled = 0, revoked_at = ? WHERE id = ?', 99, 'dev_gone');
    d1.sql(
      'INSERT INTO device_templates (id, name, description, model_scope, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)',
      'tpl_1',
      'tpl',
      'all',
      1,
      1
    );

    const res = await deviceTemplatesApp.request(
      'http://gw.test/tpl_1/apply',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_ids: ['dev_gone'], mode: 'merge' }),
      },
      env
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('device_revoked');
    d1.close();
  });
});
