import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { createDueDateScheduler } from '../../src/scheduler/dueDateScheduler.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';
  const env = loadEnv();
  app = await buildApp(env);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.passwordReset.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

async function setupDueTask(dueDate: Date) {
  const { token } = await bootstrapUser(app, { email: 'a@example.com', name: 'Alice', password: PASSWORD });
  const team = (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'T', slug: 'team-due' },
    })
  ).json();
  const project = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'P' },
    })
  ).json();
  const task = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Due soon', dueDate: dueDate.toISOString() },
    })
  ).json();
  return { token, teamId: team.id, projectId: project.id, taskId: task.id };
}

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

describe('TASK_DUE scheduler', () => {
  it('emits TASK_DUE for tasks due within the lead window', async () => {
    const inTwelveHours = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const s = await setupDueTask(inTwelveHours);

    const scheduler = createDueDateScheduler({
      defaultLeadHours: 24,
      intervalMin: 9999,
      logger: fakeLogger(),
    });
    const emitted = await scheduler.runOnce();
    expect(emitted).toBe(1);

    const inbox = await inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${s.token}` },
    });
    const items = inbox.json() as Array<{ type: string; payload: Record<string, unknown> }>;
    const dueRow = items.find((n) => n.type === 'TASK_DUE');
    expect(dueRow).toBeTruthy();
    expect(dueRow!.payload.taskId).toBe(s.taskId);
  });

  it('does not emit a second TASK_DUE on a follow-up tick (idempotent)', async () => {
    await setupDueTask(new Date(Date.now() + 6 * 60 * 60 * 1000));
    const scheduler = createDueDateScheduler({
      defaultLeadHours: 24,
      intervalMin: 9999,
      logger: fakeLogger(),
    });
    expect(await scheduler.runOnce()).toBe(1);
    expect(await scheduler.runOnce()).toBe(0);
  });

  it('does not emit for tasks beyond the lead window', async () => {
    await setupDueTask(new Date(Date.now() + 48 * 60 * 60 * 1000));
    const scheduler = createDueDateScheduler({
      defaultLeadHours: 24,
      intervalMin: 9999,
      logger: fakeLogger(),
    });
    expect(await scheduler.runOnce()).toBe(0);
  });

  it('emits for already-overdue tasks (dueDate in the past) as long as they are still open', async () => {
    // 3 days ago — well past dueDate, still inside the 30-day floor.
    const s = await setupDueTask(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    const scheduler = createDueDateScheduler({
      defaultLeadHours: 24,
      intervalMin: 9999,
      logger: fakeLogger(),
    });
    expect(await scheduler.runOnce()).toBe(1);
    const inbox = await inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${s.token}` },
    });
    const items = inbox.json() as Array<{ type: string }>;
    expect(items.some((n) => n.type === 'TASK_DUE')).toBe(true);
  });

  it('does NOT emit for ancient overdue tasks beyond the 30-day floor', async () => {
    await setupDueTask(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000));
    const scheduler = createDueDateScheduler({
      defaultLeadHours: 24,
      intervalMin: 9999,
      logger: fakeLogger(),
    });
    expect(await scheduler.runOnce()).toBe(0);
  });

  it('re-emits after dueDate is rescheduled', async () => {
    const s = await setupDueTask(new Date(Date.now() + 6 * 60 * 60 * 1000));
    const scheduler = createDueDateScheduler({
      defaultLeadHours: 24,
      intervalMin: 9999,
      logger: fakeLogger(),
    });
    expect(await scheduler.runOnce()).toBe(1);
    // Reschedule. The service clears dueNotifiedAt so the scheduler treats it
    // as a fresh due date.
    const newDue = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { dueDate: newDue.toISOString() },
    });
    expect(await scheduler.runOnce()).toBe(1);
  });
});
