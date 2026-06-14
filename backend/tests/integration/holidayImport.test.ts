import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { jalaliToUtcMidnight } from '../../src/lib/shamsiCalendar.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

let app: FastifyInstance;
const PASSWORD = 'CorrectHorseBattery9';
const JALALI_YEAR = 1405;
const NOWRUZ_ISO = '2026-03-21T00:00:00.000Z';

beforeAll(async () => {
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.activity.deleteMany();
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

describe('Iranian holiday dataset import (v1.66)', () => {
  it('1) import adds Nowruz at correct UTC midnight', async () => {
    const token = await adminToken();
    const res = await app.inject({
      method: 'POST',
      url: '/api/holidays/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { jalaliYear: JALALI_YEAR },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.inserted).toBeGreaterThan(0);
    expect(body.added.some((r: { date: string }) => r.date === NOWRUZ_ISO)).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: '/api/holidays/range?from=2026-03-01T00:00:00.000Z&to=2026-03-31T00:00:00.000Z',
      headers: { authorization: `Bearer ${token}` },
    });
    const nowruz = list.json().find((h: { date: string }) => h.date === NOWRUZ_ISO);
    expect(nowruz).toBeDefined();
    expect(nowruz.source).toBe('IMPORT');
    expect(jalaliToUtcMidnight(1405, 1, 1).toISOString()).toBe(NOWRUZ_ISO);
  });

  it('2) re-import same year is idempotent', async () => {
    const token = await adminToken();
    const first = await app.inject({
      method: 'POST',
      url: '/api/holidays/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { jalaliYear: JALALI_YEAR },
    });
    const insertedFirst = first.json().inserted as number;
    expect(insertedFirst).toBeGreaterThan(0);

    const second = await app.inject({
      method: 'POST',
      url: '/api/holidays/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { jalaliYear: JALALI_YEAR },
    });
    expect(second.json().inserted).toBe(0);
    expect(second.json().skipped.length).toBe(insertedFirst);

    const count = await prisma.holiday.count();
    expect(count).toBe(insertedFirst);
  });

  it('3) MANUAL holiday on dataset date is preserved as conflict', async () => {
    const token = await adminToken();
    await app.inject({
      method: 'POST',
      url: '/api/holidays',
      headers: { authorization: `Bearer ${token}` },
      payload: { date: NOWRUZ_ISO, name: 'Admin Nowruz' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/holidays/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { jalaliYear: JALALI_YEAR },
    });
    const body = res.json();
    expect(body.conflicts.some((c: { date: string }) => c.date === NOWRUZ_ISO)).toBe(true);
    const row = await prisma.holiday.findFirst({ where: { date: new Date(NOWRUZ_ISO) } });
    expect(row?.name).toBe('Admin Nowruz');
    expect(row?.source).toBe('MANUAL');
  });

  it('4) imported holidays are editable and deletable', async () => {
    const token = await adminToken();
    await app.inject({
      method: 'POST',
      url: '/api/holidays/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { jalaliYear: JALALI_YEAR },
    });
    const row = await prisma.holiday.findFirst({ where: { date: new Date(NOWRUZ_ISO) } });
    expect(row).toBeTruthy();

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/holidays/${row!.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Updated Nowruz' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().name).toBe('Updated Nowruz');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/holidays/${row!.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
  });

  it('5) preview returns diff without writing', async () => {
    const token = await adminToken();
    const before = await prisma.holiday.count();
    const preview = await app.inject({
      method: 'GET',
      url: `/api/holidays/import/preview?jalaliYear=${JALALI_YEAR}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().added.length).toBeGreaterThan(0);
    expect(await prisma.holiday.count()).toBe(before);
  });

  it('6) import makes no network requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network blocked'));
    const token = await adminToken();
    const res = await app.inject({
      method: 'POST',
      url: '/api/holidays/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { jalaliYear: JALALI_YEAR },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('7) non-admin cannot import or preview', async () => {
    await adminToken();
    const member = await memberToken();
    const preview = await app.inject({
      method: 'GET',
      url: `/api/holidays/import/preview?jalaliYear=${JALALI_YEAR}`,
      headers: { authorization: `Bearer ${member}` },
    });
    expect(preview.statusCode).toBe(403);
    const imp = await app.inject({
      method: 'POST',
      url: '/api/holidays/import',
      headers: { authorization: `Bearer ${member}` },
      payload: { jalaliYear: JALALI_YEAR },
    });
    expect(imp.statusCode).toBe(403);
  });

  it('8) imported holidays appear in system bootstrap', async () => {
    const token = await adminToken();
    await app.inject({
      method: 'POST',
      url: '/api/holidays/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { jalaliYear: JALALI_YEAR },
    });
    const info = await app.inject({ method: 'GET', url: '/api/system/info' });
    expect(info.json().calendarHolidays.some((h: { date: string }) => h.date === NOWRUZ_ISO)).toBe(true);
  });

  it('logs holiday.imported activity on import', async () => {
    const token = await adminToken();
    await app.inject({
      method: 'POST',
      url: '/api/holidays/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { jalaliYear: JALALI_YEAR },
    });
    const log = await prisma.activity.findFirst({ where: { action: 'holiday.imported' } });
    expect(log).toBeTruthy();
    expect(log?.meta).toMatchObject({ jalaliYear: JALALI_YEAR });
  });
});
