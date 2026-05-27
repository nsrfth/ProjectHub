import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// S-1 regression: when UPDATER_URL is configured, UPDATER_TOKEN must be
// present and at least 24 characters. The check lives in the Zod schema
// (`superRefine`) so the backend refuses to start with a non-functional
// upgrade configuration rather than silently letting the privileged
// sidecar accept anonymous /upgrade calls.

// env.ts caches the parsed result module-locally. vi.resetModules busts
// the registry so each case re-evaluates env.ts against the current
// process.env. dynamic import after the reset returns the fresh module.
async function loadEnvFresh(): Promise<{
  loadEnv: () => unknown;
}> {
  vi.resetModules();
  return await import('../../src/config/env.js');
}

const REQUIRED_BASE: Record<string, string> = {
  JWT_ACCESS_SECRET: 'test_access_secret_at_least_32_chars_long_xx',
  JWT_REFRESH_SECRET: 'test_refresh_secret_at_least_32_chars_long_x',
  DATABASE_URL: 'postgresql://taskhub:taskhub@taskhub-postgres-test-1:5432/taskhub_test?schema=public',
  NODE_ENV: 'test',
};

// Snapshot every env key we touch so we can restore it after the test
// (other test files in the suite call loadEnv() with the production-ish
// env). We always wipe UPDATER_* before each case.
const PRESERVE_KEYS = ['UPDATER_URL', 'UPDATER_TOKEN', ...Object.keys(REQUIRED_BASE)];
const snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of PRESERVE_KEYS) snapshot[k] = process.env[k];
  for (const k of PRESERVE_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(REQUIRED_BASE)) process.env[k] = v;
});

afterEach(() => {
  for (const k of PRESERVE_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k]!;
  }
});

describe('env validation: UPDATER_TOKEN (S-1)', () => {
  it('passes when UPDATER_URL is unset (the default / opt-out config)', async () => {
    delete process.env.UPDATER_URL;
    delete process.env.UPDATER_TOKEN;
    const { loadEnv } = await loadEnvFresh();
    expect(() => loadEnv()).not.toThrow();
  });

  it('throws when UPDATER_URL is set but UPDATER_TOKEN is missing', async () => {
    process.env.UPDATER_URL = 'http://updater:9000';
    delete process.env.UPDATER_TOKEN;
    const { loadEnv } = await loadEnvFresh();
    expect(() => loadEnv()).toThrow(/UPDATER_TOKEN/);
  });

  it('throws when UPDATER_URL is set and UPDATER_TOKEN is shorter than 24 chars', async () => {
    process.env.UPDATER_URL = 'http://updater:9000';
    process.env.UPDATER_TOKEN = 'tooshort';
    const { loadEnv } = await loadEnvFresh();
    expect(() => loadEnv()).toThrow(/UPDATER_TOKEN/);
    process.env.UPDATER_TOKEN = 'a'.repeat(23);
    const { loadEnv: loadEnv2 } = await loadEnvFresh();
    expect(() => loadEnv2()).toThrow(/UPDATER_TOKEN/);
  });

  it('passes when UPDATER_URL is set and UPDATER_TOKEN is exactly 24 chars', async () => {
    process.env.UPDATER_URL = 'http://updater:9000';
    process.env.UPDATER_TOKEN = 'a'.repeat(24);
    const { loadEnv } = await loadEnvFresh();
    expect(() => loadEnv()).not.toThrow();
  });

  it('passes when UPDATER_URL is set and UPDATER_TOKEN is longer', async () => {
    process.env.UPDATER_URL = 'http://updater:9000';
    process.env.UPDATER_TOKEN = 'a'.repeat(64);
    const { loadEnv } = await loadEnvFresh();
    expect(() => loadEnv()).not.toThrow();
  });
});
