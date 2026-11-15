import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { devicesApp } from '../src/admin/devices';
import { resetRateLimitMemory } from '../src/gateway/ratelimit';
import { clearMemoryCacheForTest } from '../src/gateway/cache';
import { createRealD1, makeEnv, seedDevice, DEVICE_ID } from './helpers/realGatewayEnv';
import type { Env } from '../src/types';


const PASSWORD = 'correct-horse-battery';

type D1 = ReturnType<typeof createRealD1>;

function envFor(d1: D1): Env {
  const env = makeEnv(d1);
  (env as unknown as Record<string, unknown>).SESSION_SECRET = 'test-console-session-secret';
  return env;
}

async function seedWithPassword(d1: D1): Promise<Env> {
  const env = envFor(d1);
  await seedDevice(d1);
  const { hashPassword } = await import('../src/utils/crypto');
  const hash = await hashPassword(PASSWORD);
  d1.sql('UPDATE devices SET password_hash = ?, password_updated_at = ? WHERE id = ?', hash, Date.now(), DEVICE_ID);
  return env;
}

function adminRequest(env: Env, path: string, init?: RequestInit) {
  return devicesApp.request('http://gw.test' + path, init, env);
}

function assertNoCredentials(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toContain('token_hash');
  expect(text).not.toContain('password_hash');
  expect(text).not.toContain('pbkdf2$');
}

beforeEach(() => {
  resetRateLimitMemory();
  clearMemoryCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('admin device endpoints do not echo credentials', () => {
  it('strips token_hash and password_hash from PUT /:id', async () => {
    const d1 = createRealD1();
    const env = await seedWithPassword(d1);
    const res = await adminRequest(env, '/' + DEVICE_ID, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: Record<string, unknown> };
    assertNoCredentials(body);
    expect(body.item.id).toBe(DEVICE_ID);
    expect(body.item.name).toBe('renamed');
    d1.close();
  });

  it('strips them from POST /:id/calls', async () => {
    const d1 = createRealD1();
    const env = await seedWithPassword(d1);
    const res = await adminRequest(env, '/' + DEVICE_ID + '/calls', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: Record<string, unknown>; calls_enabled: boolean };
    assertNoCredentials(body);
    expect(body.item.calls_enabled).toBe(0);
    expect(body.calls_enabled).toBe(false);
    d1.close();
  });

  it('strips them from POST /:id/revoke', async () => {
    const d1 = createRealD1();
    const env = await seedWithPassword(d1);
    const res = await adminRequest(env, '/' + DEVICE_ID + '/revoke', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: Record<string, unknown> };
    assertNoCredentials(body);
    expect(body.item.enabled).toBe(0);
    d1.close();
  });
});