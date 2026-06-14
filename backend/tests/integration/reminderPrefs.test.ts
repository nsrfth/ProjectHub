import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { createDueDateScheduler } from '../../src/scheduler/dueDateScheduler.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.instanceSetting.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

function fakeLogger() {
  return {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    silent: () => {},
    level: 'silent',
    child: () => fakeLogger(),
  } as unknown as Parameters<typeof createDueDateScheduler>[0]['logger'];
}

async function setupTask(dueDate: Date, leadHours = 24) {
  const { token, userId } = await bootstrapUser(app, {
    email: 'rem@example.com',
    name: 'Rem',
    password: PASSWORD,
  });
  await prisma.user.update({ where: { id: userId }, data: { reminderLeadHours: leadHours } });
  const team = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'T', slug: 'rem-team' },
  });
  const teamId = team.json().id as string;
  const project = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'P' },
  });
  const projectId = project.json().id as string;
  await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'Due', dueDate: dueDate.toISOString() },
  });
  return { token };
}

describe('TASK_DUE per-user lead + skipOffDays (v1.65)', () => {
  it('48h user lead fires ~2 days before due, once', async () => {
    const now = new Date();
    const due = new Date(now.getTime() + 36 * 60 * 60 * 1000);
    await setupTask(due, 48);
    const scheduler = createDueDateScheduler({
      defaultLeadHours: 24,
      intervalMin: 9999,
      logger: fakeLogger(),
    });
    expect(await scheduler.runOnce(now)).toBe(1);
    expect(await scheduler.runOnce(now)).toBe(0);
  });

  it('default 24h lead matches legacy window for unchanged users', async () => {
    const now = new Date();
    const due = new Date(now.getTime() + 12 * 60 * 60 * 1000);
    await setupTask(due, 24);
    const scheduler = createDueDateScheduler({
      defaultLeadHours: 24,
      intervalMin: 9999,
      logger: fakeLogger(),
    });
    expect(await scheduler.runOnce(now)).toBe(1);
  });

  it('skipOffDays ON: notify shifted off Friday, fires once when due', async () => {
    await prisma.instanceSetting.createMany({
      data: [
        { key: 'calendar.weekend', value: [4, 5] },
        { key: 'reminders.skipOffDays', value: true },
      ],
    });
    const due = new Date(Date.UTC(2026, 5, 6));
    const now = new Date(Date.UTC(2026, 5, 4, 12));
    const { token } = await setupTask(due, 24);
    const scheduler = createDueDateScheduler({
      defaultLeadHours: 24,
      intervalMin: 9999,
      logger: fakeLogger(),
    });
    expect(await scheduler.runOnce(now)).toBe(1);
    expect(await scheduler.runOnce(now)).toBe(0);
    const inbox = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((inbox.json() as Array<{ type: string }>).some((n) => n.type === 'TASK_DUE')).toBe(true);
  });

  it('does not fire before shifted notify moment', async () => {
    await prisma.instanceSetting.createMany({
      data: [
        { key: 'calendar.weekend', value: [4, 5] },
        { key: 'reminders.skipOffDays', value: true },
      ],
    });
    const due = new Date(Date.UTC(2026, 5, 6));
    const tooEarly = new Date(Date.UTC(2026, 5, 2, 12));
    await setupTask(due, 24);
    const scheduler = createDueDateScheduler({
      defaultLeadHours: 24,
      intervalMin: 9999,
      logger: fakeLogger(),
    });
    expect(await scheduler.runOnce(tooEarly)).toBe(0);
  });

  it('preferences PATCH persists reminderLeadHours', async () => {
    const { token } = await bootstrapUser(app, {
      email: 'pref-rem@example.com',
      name: 'Pref',
      password: PASSWORD,
    });
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { reminderLeadHours: 72 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().reminderLeadHours).toBe(72);
  });
});
