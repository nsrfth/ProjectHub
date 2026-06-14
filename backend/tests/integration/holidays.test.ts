import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';
import { normalizeUtcMidnight } from '../../src/services/holidaysService.js';

// v1.62: instance holiday calendar — UTC-midnight dates, admin CRUD, public bootstrap.

let app: FastifyInstance;
const PASSWORD = 'CorrectHorseBattery9';

beforeAll(async () => {
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.holiday.deleteMany();
  await prisma.user.deleteMany();
});

async function adminToken(): Promise<string> {
  const r = await bootstrapUser(app, { email: 'admin@example.com', name: 'Admin', password: PASSWORD });
  return r.token;
}

async function memberToken(): Promise<string> {
  const r = await bootstrapUser(app, { email: 'member@example.com', name: 'Member', password: PASSWORD });
  return r.token;
}

/** Nowruz 1405 in Jalali ≈ 2026-03-21 UTC calendar date (react-date-object). */
const NOWRUZ_ISO = '2026-03-21T00:00:00.000Z';

describe('instance holidays API', () => {
  it('1) admin creates a holiday at UTC midnight and it appears in the list', async () => {
    const token = await adminToken();
    const create = await app.inject({
      method: 'POST',
      url: '/api/holidays',
      headers: { authorization: `Bearer ${token}` },
      payload: { date: NOWRUZ_ISO, name: 'Nowruz' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().name).toBe('Nowruz');
    expect(create.json().date).toBe(NOWRUZ_ISO);

    const list = await app.inject({
      method: 'GET',
      url: '/api/holidays?year=2026',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].date).toBe(NOWRUZ_ISO);
  });

  it('2) duplicate date returns 409', async () => {
    const token = await adminToken();
    await app.inject({
      method: 'POST',
      url: '/api/holidays',
      headers: { authorization: `Bearer ${token}` },
      payload: { date: NOWRUZ_ISO, name: 'Nowruz' },
    });
    const dup = await app.inject({
      method: 'POST',
      url: '/api/holidays',
      headers: { authorization: `Bearer ${token}` },
      payload: { date: NOWRUZ_ISO, name: 'Duplicate' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('8) non-admin cannot create but can list holidays', async () => {
    const admin = await adminToken();
    await app.inject({
      method: 'POST',
      url: '/api/holidays',
      headers: { authorization: `Bearer ${admin}` },
      payload: { date: NOWRUZ_ISO, name: 'Nowruz' },
    });
    const member = await memberToken();
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/holidays',
      headers: { authorization: `Bearer ${member}` },
      payload: { date: '2026-04-01T00:00:00.000Z', name: 'April' },
    });
    expect(forbidden.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET',
      url: '/api/holidays',
      headers: { authorization: `Bearer ${member}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
  });

  it('6) UTC midnight normalization — no day shift from time component', async () => {
    const token = await adminToken();
    const create = await app.inject({
      method: 'POST',
      url: '/api/holidays',
      headers: { authorization: `Bearer ${token}` },
      payload: { date: '2026-03-20T15:30:00.000Z', name: 'Nowruz' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().date).toBe('2026-03-20T00:00:00.000Z');
    const normalized = normalizeUtcMidnight('2026-03-20T15:30:00.000Z');
    expect(normalized.toISOString()).toBe('2026-03-20T00:00:00.000Z');
  });
});

describe('/api/system/info calendarHolidays', () => {
  it('bootstrap includes holidays for authenticated read via public endpoint', async () => {
    const token = await adminToken();
    await app.inject({
      method: 'POST',
      url: '/api/holidays',
      headers: { authorization: `Bearer ${token}` },
      payload: { date: NOWRUZ_ISO, name: 'Nowruz' },
    });
    const info = await app.inject({ method: 'GET', url: '/api/system/info' });
    expect(info.statusCode).toBe(200);
    expect(info.json().calendarHolidays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Nowruz', date: NOWRUZ_ISO }),
      ]),
    );
  });
});

describe('/api/holidays/range', () => {
  it('returns holidays within from/to span', async () => {
    const token = await adminToken();
    await app.inject({
      method: 'POST',
      url: '/api/holidays',
      headers: { authorization: `Bearer ${token}` },
      payload: { date: NOWRUZ_ISO, name: 'Nowruz' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/holidays/range?from=2026-03-01T00:00:00.000Z&to=2026-03-31T00:00:00.000Z',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });
});
