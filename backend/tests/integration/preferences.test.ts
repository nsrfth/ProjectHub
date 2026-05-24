import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';

// v1.10 per-user preferences. Covers the default value, the PATCH path,
// and that the value survives a logout/login round-trip (i.e. it's
// surfaced in the user response of /auth/login).

let app: FastifyInstance;

beforeAll(async () => {
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
});

async function register(): Promise<{ token: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'pref@example.com', name: 'Pref', password: 'CorrectHorseBattery9' },
  });
  return { token: res.json().accessToken, userId: res.json().user.id };
}

describe('PATCH /api/auth/me/preferences', () => {
  it('defaults to SHAMSI and surfaces in the login response', async () => {
    await register();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'pref@example.com', password: 'CorrectHorseBattery9' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.calendarPreference).toBe('SHAMSI');
  });

  it('updates the preference and persists across a fresh login', async () => {
    const { token } = await register();
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { calendar: 'GREGORIAN' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ calendar: 'GREGORIAN' });

    // Fresh login sees the persisted value.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'pref@example.com', password: 'CorrectHorseBattery9' },
    });
    expect(login.json().user.calendarPreference).toBe('GREGORIAN');
  });

  it('rejects an unknown calendar value with 400', async () => {
    const { token } = await register();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { calendar: 'PLAID' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('omitted fields leave the preference unchanged (no-op PATCH)', async () => {
    const { token } = await register();
    // Set to GREGORIAN first.
    await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { calendar: 'GREGORIAN' },
    });
    // Empty PATCH — should leave it at GREGORIAN, not reset to SHAMSI.
    const noop = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(noop.statusCode).toBe(200);
    expect(noop.json().calendar).toBe('GREGORIAN');
  });
});
