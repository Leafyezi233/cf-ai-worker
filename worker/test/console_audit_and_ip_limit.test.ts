import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleApp } from '../src/console';
import { devicesApp } from '../src/admin/devices';
import { auditApp } from '../src/admin/audit';
import { app } from '../src/index';
import { resetRateLimitMemory } from '../src/gateway/ratelimit';
import { resetIpRateLimitMemory, recordIpHit, ipRateLimitRpm, DEFAULT_IP_RATE_LIMIT_RPM } from '../src/middleware/ipRateLimit';
import { clearMemoryCacheForTest } from '../src/gateway/cache';
import { hashToken } from '../src/utils/crypto';
import {
  createRealD1,
  makeEnv,
  seedDevice,
  DEVICE_ID,
  TOKEN,
} from './helpers/realGatewayEnv';
import type { Env } from '../src/types';


const SESSION_SECRET = 'test-console-session-secret';
const PASSWORD = 'console-pw-1';

type D1 = ReturnType<typeof createRealD1>;

function envFor(d1: D1): Env {
  const env = makeEnv(d1);
  (env as unknown as Record<string, unknown>).SESSION_SECRET = SESSION_SECRET;
  return env;
}

function cookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0] || '';
}

function postConsole(env: Env, path: string, body: unknown, cookie?: string, ip?: string) {
  const headers: Record<string, string> = {
    authorization: 'Bearer ' + TOKEN,
    'content-type': 'application/json',
  };
  if (cookie) headers.cookie = cookie;
  if (ip) headers['cf-connecting-ip'] = ip;
  return consoleApp.request('http://gw.test' + path, { method: 'POST', headers, body: JSON.stringify(body) }, env);
}

function adminRequest(env: Env, path: string, method = 'GET', body?: unknown) {
  return devicesApp.request('http://gw.test' + path, {
    method,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
}

function auditRows(d1: D1, where = '1=1'): { actor_type: string; action: string; target_id: string | null; summary: string; details_json: string | null; ip: string | null }[] {
  return d1.rows(
    'SELECT actor_type, action, target_id, summary, details_json, ip FROM audit_logs WHERE ' + where + ' ORDER BY id ASC'
  );
}

beforeEach(() => {
  resetRateLimitMemory();
  resetIpRateLimitMemory();
  clearMemoryCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the console records what the owner did on their own account', () => {
  it('writes console rows for setup, login, token lifecycle and the calls switch', async () => {
    const d1 = createRealD1();
    const env = envFor(d1);
    await seedDevice(d1);

    const setup = await postConsole(env, '/auth/setup', { password: PASSWORD }, undefined, '198.51.100.9');
    expect(setup.status).toBe(200);
    const cookie = cookieOf(setup);

    await postConsole(env, '/auth/logout', {}, cookie);
    expect((await postConsole(env, '/auth/login', { password: PASSWORD }, undefined, '198.51.100.9')).status).toBe(200);

    const created = await postConsole(env, '/tokens', { name: 'script' }, cookie);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { item: { id: string }; token: string };
    const tokenId = createdBody.item.id;

    expect((await postConsole(env, '/tokens/' + tokenId + '/enable', { enabled: false }, cookie)).status).toBe(200);
    expect((await postConsole(env, '/tokens/' + tokenId + '/enable', { enabled: true }, cookie)).status).toBe(200);
    expect((await postConsole(env, '/tokens/' + tokenId + '/revoke', {}, cookie)).status).toBe(200);
    expect((await postConsole(env, '/calls', { enabled: false }, cookie)).status).toBe(200);
    expect((await postConsole(env, '/calls', { enabled: true }, cookie)).status).toBe(200);

    const rows = auditRows(d1, "actor_type = 'console'");
    expect(rows.map((r) => r.action)).toEqual([
      'console.password_setup',
      'console.logout',
      'console.login',
      'console.sub_token_create',
      'console.sub_token_disable',
      'console.sub_token_enable',
      'console.sub_token_revoke',
      'console.calls_disable',
      'console.calls_enable',
    ]);
    expect(rows.every((r) => r.target_id === DEVICE_ID || r.target_id === tokenId)).toBe(true);
    expect(rows[0].ip).toBe('198.51.100.9');

    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(createdBody.token);
    expect(dump).not.toContain('pbkdf2$');
    expect(dump).not.toContain(await hashToken(TOKEN));

    expect(auditRows(d1, "actor_type = 'admin'").length).toBe(0);
    d1.close();
  });

  it('records a failed password attempt nowhere, because nothing changed', async () => {
    const d1 = createRealD1();
    const env = envFor(d1);
    await seedDevice(d1);
    await postConsole(env, '/auth/setup', { password: PASSWORD });
    const before = auditRows(d1).length;
    const res = await postConsole(env, '/auth/login', { password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(auditRows(d1).length).toBe(before);
    d1.close();
  });
});

describe('the admin device routes record the four writes they used to skip', () => {
  it('audits create, update, topup and revoke with the default admin actor type', async () => {
    const d1 = createRealD1();
    const env = envFor(d1);
    await seedDevice(d1);

    const created = await adminRequest(env, '/', 'POST', { name: 'new device', balance_usd: 2 });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { item: { id: string }; token: string };

    expect((await adminRequest(env, '/' + createdBody.item.id, 'PUT', { name: 'renamed' })).status).toBe(200);
    expect((await adminRequest(env, '/' + DEVICE_ID + '/topup', 'POST', { amount_usd: 3.5 })).status).toBe(200);
    expect((await adminRequest(env, '/' + createdBody.item.id + '/revoke', 'POST')).status).toBe(200);

    const rows = auditRows(d1, "actor_type = 'admin'");
    expect(rows.map((r) => r.action)).toEqual(['device.create', 'device.update', 'device.topup', 'device.revoke']);
    expect(rows[0].summary).toContain('new device');
    expect(rows[1].summary).toContain('renamed');
    expect(rows[2].summary).toContain('3.5000');
    expect(rows[3].summary).toContain('全部子 Token');
    expect(rows.every((r) => r.ip === '203.0.113.7')).toBe(true);

    expect(JSON.stringify(rows)).not.toContain(createdBody.token);
    d1.close();
  });
});

describe('audit rows can be filtered by who acted', () => {
  it('separates console actions from admin actions through the read endpoint', async () => {
    const d1 = createRealD1();
    const env = envFor(d1);
    await seedDevice(d1);
    await postConsole(env, '/auth/setup', { password: PASSWORD }, undefined, '198.51.100.9');
    await adminRequest(env, '/' + DEVICE_ID + '/topup', 'POST', { amount_usd: 1 });

    const all = (await (await auditApp.request('http://gw.test/', {}, env)).json()) as { total: number };
    expect(all.total).toBe(2);

    const consoleOnly = (await (
      await auditApp.request('http://gw.test/?actor_type=console', {}, env)
    ).json()) as { total: number; items: { actor_type: string; action: string }[] };
    expect(consoleOnly.total).toBe(1);
    expect(consoleOnly.items[0].action).toBe('console.password_setup');

    const adminOnly = (await (
      await auditApp.request('http://gw.test/?actor_type=admin', {}, env)
    ).json()) as { total: number; items: { action: string }[] };
    expect(adminOnly.total).toBe(1);
    expect(adminOnly.items[0].action).toBe('device.topup');
    d1.close();
  });
});

describe('a flood of unusable tokens is stopped before it reaches the database', () => {
  it('answers 429 once one address is over budget, where the request used to be a 401', async () => {
    const d1 = createRealD1();
    const env = envFor(d1);
    (env as unknown as Record<string, unknown>).IP_RATE_LIMIT_RPM = '2';
    const fire = () =>
      app.request('http://gw.test/console/me', {
        headers: { authorization: 'Bearer ccs_does_not_exist', 'cf-connecting-ip': '192.0.2.44' },
      }, env);

    expect((await fire()).status).toBe(401);
    expect((await fire()).status).toBe(401);
    const blocked = await fire();
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: string }).error).toBe('ip_rate_limited');
    expect(blocked.headers.get('retry-after')).toBe('60');

    const other = await app.request('http://gw.test/console/me', {
      headers: { authorization: 'Bearer ccs_does_not_exist', 'cf-connecting-ip': '192.0.2.45' },
    }, env);
    expect(other.status).toBe(401);
    d1.close();
  });

  it('does not count callers whose address cannot be trusted', async () => {
    const d1 = createRealD1();
    const env = envFor(d1);
    (env as unknown as Record<string, unknown>).IP_RATE_LIMIT_RPM = '1';
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('http://gw.test/console/me', {
        headers: { authorization: 'Bearer ccs_does_not_exist' },
      }, env);
      expect(res.status).toBe(401);
    }
    d1.close();
  });

  it('treats rpm 0 as "off" and leaves the default alone when the override is junk', () => {
    expect(DEFAULT_IP_RATE_LIMIT_RPM).toBe(600);
    expect(ipRateLimitRpm({} as Env)).toBe(DEFAULT_IP_RATE_LIMIT_RPM);
    expect(ipRateLimitRpm({ IP_RATE_LIMIT_RPM: 'abc' } as unknown as Env)).toBe(DEFAULT_IP_RATE_LIMIT_RPM);
    expect(ipRateLimitRpm({ IP_RATE_LIMIT_RPM: '-5' } as unknown as Env)).toBe(DEFAULT_IP_RATE_LIMIT_RPM);
    expect(ipRateLimitRpm({ IP_RATE_LIMIT_RPM: '0' } as unknown as Env)).toBe(0);
    expect(ipRateLimitRpm({ IP_RATE_LIMIT_RPM: '12' } as unknown as Env)).toBe(12);

    const now = Date.now();
    for (let i = 0; i < 10; i += 1) expect(recordIpHit('10.0.0.1', 0, now)).toBe(true);
    for (let i = 0; i < 10; i += 1) expect(recordIpHit('unknown', 1, now)).toBe(true);
    expect(recordIpHit('10.0.0.2', 1, now)).toBe(true);
    expect(recordIpHit('10.0.0.2', 1, now)).toBe(false);
    expect(recordIpHit('10.0.0.2', 1, now + 61_000)).toBe(true);
  });
});
