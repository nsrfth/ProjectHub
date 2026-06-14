import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

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
  const r = await bootstrapUser(app, { email: 'pref@example.com', name: 'Pref', password: 'CorrectHorseBattery9' });
  return { token: r.token, userId: r.userId };
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
    // v1.13: PATCH returns the full preference triple so the frontend can
    // mirror it to localStorage in one round-trip. We only care that the
    // patched field landed; the other two retain their defaults.
    expect(patch.json()).toMatchObject({ calendar: 'GREGORIAN' });

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

describe('PATCH /api/auth/me/preferences — theme (v1.61)', () => {
  const ALL_THEMES = [
    'LIGHT',
    'DARK',
    'SYSTEM',
    'MIDNIGHT',
    'SOLARIZED',
    'HIGH_CONTRAST',
    'NORD',
  ] as const;

  it.each(ALL_THEMES)('persists theme=%s and survives fresh login', async (theme) => {
    const { token } = await register();
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { theme },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().theme).toBe(theme);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'pref@example.com', password: 'CorrectHorseBattery9' },
    });
    expect(login.json().user.themePreference).toBe(theme);
  });

  it('rejects an unknown theme value with 400', async () => {
    const { token } = await register();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { theme: 'PLAID' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/auth/me/preferences — datetime (v1.63)', () => {
  it('defaults timeFormat=H24, dualCalendar=false, timeZone=null on login', async () => {
    await register();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'pref@example.com', password: 'CorrectHorseBattery9' },
    });
    const u = login.json().user;
    expect(u.timeFormat).toBe('H24');
    expect(u.dualCalendar).toBe(false);
    expect(u.timeZone).toBeNull();
  });

  it('persists timezone, timeFormat, dualCalendar and survives fresh login', async () => {
    const { token } = await register();
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { timeZone: 'Asia/Tehran', timeFormat: 'H12', dualCalendar: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({
      timeZone: 'Asia/Tehran',
      timeFormat: 'H12',
      dualCalendar: true,
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'pref@example.com', password: 'CorrectHorseBattery9' },
    });
    expect(login.json().user).toMatchObject({
      timeZone: 'Asia/Tehran',
      timeFormat: 'H12',
      dualCalendar: true,
    });
  });

  it('allows clearing timeZone with null (browser fallback)', async () => {
    const { token } = await register();
    await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { timeZone: 'Europe/Berlin' },
    });
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { timeZone: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().timeZone).toBeNull();
  });

  it('rejects an invalid IANA timezone with 400', async () => {
    const { token } = await register();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { timeZone: 'Not/A/Real/Zone' },
    });
    expect(res.statusCode).toBe(400);
  });
});
