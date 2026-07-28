import { describe, expect, it, beforeEach } from 'vitest';
import { loadEnv, resetEnvCache } from '@vibe1099/core';

// Production env interlocks (packages/core/src/env.ts superRefine).
//
// The https-only rule guards two very different things and the split must
// never regress:
//   - IRS/provider endpoints carry TINs across the public internet — https
//     is unconditional, no opt-out may ever apply to them.
//   - APP_BASE_URL / PORTAL_BASE_URL are the app's OWN addresses. The Vibe
//     Appliance's LAN and Tailscale modes serve them over plain HTTP with no
//     public hop, so ALLOW_HTTP_BASE_URLS=1 exists for exactly that shape —
//     without it the appliance cannot enable this app outside domain mode.

const PROD_BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://vibe1099user:strongpass@postgres:5432/vibe_1099_db',
  REDIS_URL: 'redis://:pass@redis:6379/7',
  MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
};

beforeEach(() => resetEnvCache());

describe('production https interlock — base URLs', () => {
  it('rejects http:// base URLs by default (the internet-facing default)', () => {
    expect(() =>
      loadEnv({ ...PROD_BASE, APP_BASE_URL: 'http://192.168.1.10:5176', PORTAL_BASE_URL: 'http://192.168.1.10:5176' }),
    ).toThrow(/APP_BASE_URL must be https/);
  });

  it('ALLOW_HTTP_BASE_URLS=1 admits http:// base URLs (appliance LAN/Tailscale modes)', () => {
    const env = loadEnv({
      ...PROD_BASE,
      ALLOW_HTTP_BASE_URLS: '1',
      APP_BASE_URL: 'http://192.168.1.10:5176',
      PORTAL_BASE_URL: 'http://192.168.1.10:5176',
    });
    expect(env.APP_BASE_URL).toBe('http://192.168.1.10:5176');
  });

  it('https base URLs pass with the flag unset (domain mode unchanged)', () => {
    const env = loadEnv({ ...PROD_BASE, APP_BASE_URL: 'https://1099.firm.com', PORTAL_BASE_URL: 'https://1099.firm.com' });
    expect(env.ALLOW_HTTP_BASE_URLS).toBe('0');
  });
});

describe('production https interlock — provider endpoints are NOT opt-out-able', () => {
  it('ALLOW_HTTP_BASE_URLS=1 must not relax the IRS endpoint check', () => {
    expect(() =>
      loadEnv({
        ...PROD_BASE,
        ALLOW_HTTP_BASE_URLS: '1',
        APP_BASE_URL: 'https://1099.firm.com',
        PORTAL_BASE_URL: 'https://1099.firm.com',
        IRIS_PROD_BASE_URL: 'http://evil.example.com/iris',
      }),
    ).toThrow(/IRIS_PROD_BASE_URL must be https/);
  });

  it('ALLOW_HTTP_BASE_URLS=1 must not relax the TaxBandits endpoint check', () => {
    expect(() =>
      loadEnv({
        ...PROD_BASE,
        ALLOW_HTTP_BASE_URLS: '1',
        TAXBANDITS_PROD_BASE_URL: 'http://testapi.taxbandits.com',
      }),
    ).toThrow(/TAXBANDITS_PROD_BASE_URL must be https/);
  });
});

describe('unrelated production interlocks unaffected by the flag', () => {
  it('weak default DB password still refuses to boot', () => {
    expect(() =>
      loadEnv({ ...PROD_BASE, ALLOW_HTTP_BASE_URLS: '1', DATABASE_URL: 'postgresql://u:vibe1099@postgres:5432/db' }),
    ).toThrow(/weak default password/);
  });

  it('mock provider URLs still refuse to boot', () => {
    expect(() =>
      loadEnv({ ...PROD_BASE, ALLOW_HTTP_BASE_URLS: '1', IRIS_MOCK_BASE_URL: 'http://mock:9999' }),
    ).toThrow(/must be empty in production/);
  });
});
