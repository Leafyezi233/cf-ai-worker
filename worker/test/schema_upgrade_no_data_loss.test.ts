import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealD1 } from './helpers/realD1';
import { makeEnv } from './helpers/realGatewayEnv';
import type { Env } from '../src/types';


type D1 = ReturnType<typeof createRealD1>;

function preAccountDatabase(): D1 {
  const d1 = createRealD1();
  d1.sql('DROP INDEX IF EXISTS idx_usage_device_sub_token');
  d1.sql('DROP TABLE IF EXISTS device_sub_tokens');
  d1.sql('ALTER TABLE usage DROP COLUMN sub_token_id');
  d1.sql('ALTER TABLE devices DROP COLUMN calls_enabled');
  d1.sql('ALTER TABLE devices DROP COLUMN password_updated_at');
  d1.sql('ALTER TABLE devices DROP COLUMN password_hash');
  return d1;
}

function seedLegacyRows(d1: D1) {
  d1.sql("INSERT INTO providers (id, name, type, endpoint, api_key, secret_name, enabled, config_json, created_at, updated_at) VALUES ('prov_old', 'Old Provider', 'openai', 'https://old.example/v1', 'sk-old', NULL, 1, NULL, 100, 100)");
  d1.sql("INSERT INTO models (id, provider_id, model_name, display_name, alias, fallback_model_id, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, cache_enabled, cache_ttl, enabled, model_public, pricing_mode, peak_pricing_enabled, billing_unit, price_per_call, search_price_per_call, config_json, created_at, updated_at) VALUES ('model_old', 'prov_old', 'legacy-model', 'Legacy', NULL, NULL, 3, 15, 0, 0, 0, 3600, 1, 1, 'priced', 0, 'token', 0, 0, NULL, 100, 100)");
  d1.sql("INSERT INTO devices (id, name, token_hash, enabled, rate_limit_rpm, cost_limit_monthly, last_used_at, created_at, revoked_at, model_scope) VALUES ('dev_old', 'Old Laptop', 'hash_old', 1, 60, 25, 500, 100, NULL, 'all')");
  d1.sql("INSERT INTO devices (id, name, token_hash, enabled, rate_limit_rpm, cost_limit_monthly, last_used_at, created_at, revoked_at, model_scope) VALUES ('dev_revoked', 'Gone', 'hash_gone', 0, 0, 0, NULL, 120, 900, 'all')");
  d1.sql("INSERT INTO device_wallets (device_id, balance_usd, reserved_usd, created_at, updated_at) VALUES ('dev_old', 17.5, 0.25, 100, 500)");
  d1.sql("INSERT INTO device_wallets (device_id, balance_usd, reserved_usd, created_at, updated_at) VALUES ('dev_revoked', 3.125, 0, 120, 120)");
  d1.sql("INSERT INTO usage (device_id, provider_id, provider_name, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit, status_code, request_id, created_at) VALUES ('dev_old', 'prov_old', 'Old Provider', 'legacy-model', 100, 50, 150, 0.375, 0, 200, 'req_1', 400)");
  d1.sql("INSERT INTO usage (device_id, provider_id, provider_name, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit, status_code, request_id, created_at) VALUES ('dev_old', 'prov_old', 'Old Provider', 'legacy-model', 200, 80, 280, 0.625, 1, 200, 'req_2', 500)");
  d1.sql("INSERT INTO wallet_ledger (device_id, delta_usd, balance_after, reason, request_id, note, created_at) VALUES ('dev_old', 25, 25, 'topup', NULL, 'initial balance', 100)");
  d1.sql("INSERT INTO wallet_ledger (device_id, delta_usd, balance_after, reason, request_id, note, created_at) VALUES ('dev_old', -7.5, 17.5, 'charge', 'req_1', NULL, 400)");
  d1.sql("INSERT INTO reserve_holds (request_id, device_id, amount_usd, created_at) VALUES ('hold_1', 'dev_old', 0.25, 500)");
  d1.sql("INSERT INTO daily_stats (date, device_id, provider_id, provider_name, model, request_count, input_tokens, output_tokens, cost_usd) VALUES ('2025-01-01', 'dev_old', 'prov_old', 'Old Provider', 'legacy-model', 2, 300, 130, 1)");
  d1.sql("INSERT INTO settings (key, value_json, updated_at) VALUES ('global_budget', '{\"monthly_usd\":100}', 300)");
}

function snapshot(d1: D1, table: string, columns: string, orderBy: string) {
  return d1.rows('SELECT ' + columns + ' FROM ' + table + ' ORDER BY ' + orderBy);
}

async function freshSchemaModule() {
  vi.resetModules();
  return import('../src/db/schema');
}

function envFor(d1: D1): Env {
  return makeEnv(d1);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('upgrading a pre-service-group production database', () => {
  it('adds empty groups and nullable selections without changing existing data, including repeated cold starts', async () => {
    const d1 = createRealD1();
    seedLegacyRows(d1);
    d1.sql("INSERT INTO device_sub_tokens (id, device_id, name, token_hash, enabled, created_at) VALUES ('sub_old', 'dev_old', 'Existing sub', 'sub_hash', 1, 123)");
    for (const table of ['device_service_groups', 'service_group_models', 'service_groups']) d1.sql('DROP TABLE ' + table);
    for (const [table, column] of [
      ['devices', 'default_service_group_id'], ['devices', 'service_group_id'],
      ['device_sub_tokens', 'service_group_id'], ['usage', 'service_group_id'],
      ['usage', 'service_group_revision'], ['usage', 'pricing_snapshot_json'],
    ]) d1.sql('ALTER TABLE ' + table + ' DROP COLUMN ' + column);
    const tables = ['devices', 'device_sub_tokens', 'device_wallets', 'wallet_ledger', 'usage', 'reserve_holds', 'daily_stats', 'providers', 'models', 'settings'];
    const before = tables.map(table => ({ table, rows: d1.rows<Record<string, unknown>>('SELECT * FROM ' + table + ' ORDER BY rowid') }));
    try {
      for (let coldStart = 0; coldStart < 3; coldStart++) {
        const { ensureSchema } = await freshSchemaModule();
        await ensureSchema(envFor(d1));
        for (const { table, rows } of before) {
          const actual = d1.rows<Record<string, unknown>>('SELECT * FROM ' + table + ' ORDER BY rowid');
          expect(actual).toHaveLength(rows.length);
          for (let index = 0; index < rows.length; index++) {
            expect(actual[index]).toMatchObject(rows[index]);
            for (const key of Object.keys(actual[index])) {
              if (!(key in rows[index])) expect(actual[index][key]).toBeNull();
            }
          }
        }
        for (const table of ['service_groups', 'service_group_models', 'device_service_groups']) {
          expect(d1.rows('SELECT * FROM ' + table)).toEqual([]);
        }
      }
    } finally { d1.close(); }
  });
});

describe('upgrading a pre-account database', () => {
  it('keeps every existing row and value identical', async () => {
    const d1 = preAccountDatabase();
    seedLegacyRows(d1);

    const before = {
      devices: snapshot(d1, 'devices', 'id, name, token_hash, enabled, rate_limit_rpm, cost_limit_monthly, last_used_at, created_at, revoked_at, model_scope', 'id'),
      wallets: snapshot(d1, 'device_wallets', 'device_id, balance_usd, reserved_usd, created_at, updated_at', 'device_id'),
      usage: snapshot(d1, 'usage', 'id, device_id, provider_id, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit, status_code, request_id, created_at', 'id'),
      ledger: snapshot(d1, 'wallet_ledger', 'id, device_id, delta_usd, balance_after, reason, request_id, created_at', 'id'),
      holds: snapshot(d1, 'reserve_holds', 'request_id, device_id, amount_usd, created_at', 'request_id'),
      daily: snapshot(d1, 'daily_stats', 'date, device_id, provider_id, model, request_count, input_tokens, output_tokens, cost_usd', 'date, device_id'),
      settings: snapshot(d1, 'settings', 'key, value_json, updated_at', 'key'),
      providers: snapshot(d1, 'providers', 'id, name, endpoint, api_key, enabled', 'id'),
      models: snapshot(d1, 'models', 'id, model_name, input_price_per_m, output_price_per_m, pricing_mode', 'id'),
    };

    const { ensureSchema } = await freshSchemaModule();
    await ensureSchema(envFor(d1));

    expect(snapshot(d1, 'devices', 'id, name, token_hash, enabled, rate_limit_rpm, cost_limit_monthly, last_used_at, created_at, revoked_at, model_scope', 'id')).toEqual(before.devices);
    expect(snapshot(d1, 'device_wallets', 'device_id, balance_usd, reserved_usd, created_at, updated_at', 'device_id')).toEqual(before.wallets);
    expect(snapshot(d1, 'usage', 'id, device_id, provider_id, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_hit, status_code, request_id, created_at', 'id')).toEqual(before.usage);
    expect(snapshot(d1, 'wallet_ledger', 'id, device_id, delta_usd, balance_after, reason, request_id, created_at', 'id')).toEqual(before.ledger);
    expect(snapshot(d1, 'reserve_holds', 'request_id, device_id, amount_usd, created_at', 'request_id')).toEqual(before.holds);
    expect(snapshot(d1, 'daily_stats', 'date, device_id, provider_id, model, request_count, input_tokens, output_tokens, cost_usd', 'date, device_id')).toEqual(before.daily);
    expect(snapshot(d1, 'settings', 'key, value_json, updated_at', 'key')).toEqual(before.settings);
    expect(snapshot(d1, 'providers', 'id, name, endpoint, api_key, enabled', 'id')).toEqual(before.providers);
    expect(snapshot(d1, 'models', 'id, model_name, input_price_per_m, output_price_per_m, pricing_mode', 'id')).toEqual(before.models);

    expect(snapshot(d1, 'devices', 'id', 'id')).toHaveLength(2);
    expect(snapshot(d1, 'usage', 'id', 'id')).toHaveLength(2);
    expect(snapshot(d1, 'wallet_ledger', 'id', 'id')).toHaveLength(2);

    d1.close();
  });

  it('backfills the new columns with values that change no existing behaviour', async () => {
    const d1 = preAccountDatabase();
    seedLegacyRows(d1);

    const { ensureSchema } = await freshSchemaModule();
    await ensureSchema(envFor(d1));

    const devices = d1.rows<{
      id: string;
      password_hash: string | null;
      password_updated_at: number | null;
      calls_enabled: number;
    }>('SELECT id, password_hash, password_updated_at, calls_enabled FROM devices ORDER BY id');

    for (const device of devices) {
      expect(device.password_hash).toBeNull();
      expect(device.password_updated_at).toBeNull();
      expect(device.calls_enabled).toBe(1);
    }

    const usage = d1.rows<{ sub_token_id: string | null }>('SELECT sub_token_id FROM usage');
    expect(usage).toHaveLength(2);
    expect(usage.every((row) => row.sub_token_id === null)).toBe(true);

    const subTokens = d1.rows('SELECT id FROM device_sub_tokens');
    expect(subTokens).toHaveLength(0);

    d1.close();
  });

  it('is idempotent: a second cold start changes nothing', async () => {
    const d1 = preAccountDatabase();
    seedLegacyRows(d1);

    for (let i = 0; i < 3; i += 1) {
      const { ensureSchema } = await freshSchemaModule();
      await ensureSchema(envFor(d1));
    }

    expect(d1.rows('SELECT id FROM devices ORDER BY id')).toEqual([{ id: 'dev_old' }, { id: 'dev_revoked' }]);
    expect(d1.row<{ balance_usd: number }>("SELECT balance_usd FROM device_wallets WHERE device_id = 'dev_old'")?.balance_usd).toBe(17.5);
    expect(d1.row<{ n: number }>('SELECT COUNT(*) AS n FROM usage')?.n).toBe(2);
    expect(d1.row<{ n: number }>('SELECT COUNT(*) AS n FROM wallet_ledger')?.n).toBe(2);
    expect(d1.row<{ n: number }>('SELECT COUNT(*) AS n FROM device_sub_tokens')?.n).toBe(0);

    d1.close();
  });

  it('leaves a wallet intact when the wallet backfill re-runs', async () => {
    const d1 = preAccountDatabase();
    seedLegacyRows(d1);

    const { ensureSchema, MIGRATION_ALTERS } = await freshSchemaModule();
    await ensureSchema(envFor(d1));

    const backfill = MIGRATION_ALTERS.find((sql) => sql.includes('INSERT OR IGNORE INTO device_wallets'));
    expect(backfill).toBeTruthy();
    d1.sql(backfill as string);

    const wallet = d1.row<{ balance_usd: number; reserved_usd: number }>(
      "SELECT balance_usd, reserved_usd FROM device_wallets WHERE device_id = 'dev_old'"
    );
    expect(wallet?.balance_usd).toBe(17.5);
    expect(wallet?.reserved_usd).toBe(0.25);

    d1.close();
  });
});