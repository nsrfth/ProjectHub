import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { TaskTemplatesService } from '../../src/services/taskTemplatesService.js';
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
  await prisma.activity.deleteMany();
  await prisma.taskTemplate.deleteMany();
  await prisma.task.deleteMany();
  await prisma.holiday.deleteMany();
  await prisma.instanceSetting.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function setupAdmin(): Promise<{ token: string; teamId: string; projectId: string }> {
  const reg = await bootstrapUser(app, {
    email: 'sched@example.com',
    name: 'Sched',
    password: PASSWORD,
  });
  const team = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${reg.token}` },
    payload: { name: 'sched-team', slug: 'sched-team' },
  });
  const teamId = team.json().id as string;
  const proj = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${reg.token}` },
    payload: { name: 'P' },
  });
  return { token: reg.token, teamId, projectId: proj.json().id as string };
}

function utcIso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString();
}

describe('scheduling integration', () => {
  it('settings OFF: due date on Friday stays Friday (Thu+Fri weekend)', async () => {
    await prisma.instanceSetting.create({
      data: { key: 'calendar.weekend', value: [4, 5] },
    });
    const { token, teamId, projectId } = await setupAdmin();
    const fri = utcIso(2026, 6, 5);
    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Fri due', dueDate: fri },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().dueDate).toBe(fri);
  });

  it('rollOffdayDueDates ON: Friday due rolls to Saturday', async () => {
    await prisma.instanceSetting.createMany({
      data: [
        { key: 'calendar.weekend', value: [4, 5] },
        { key: 'scheduling.rollOffdayDueDates', value: true },
      ],
    });
    const { token, teamId, projectId } = await setupAdmin();
    const fri = utcIso(2026, 6, 5);
    const sat = utcIso(2026, 6, 6);
    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Rolled', dueDate: fri },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().dueDate).toBe(sat);

    const acts = await prisma.activity.findMany({
      where: { action: 'task.dueDate_rolled_offday' },
    });
    expect(acts.length).toBe(1);
  });

  it('toggling settings does not retroactively change existing due dates', async () => {
    await prisma.instanceSetting.create({
      data: { key: 'calendar.weekend', value: [4, 5] },
    });
    const { token, teamId, projectId } = await setupAdmin();
    const fri = utcIso(2026, 6, 5);
    const created = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Keep fri', dueDate: fri },
    });
    const taskId = created.json().id as string;

    await prisma.instanceSetting.create({
      data: { key: 'scheduling.rollOffdayDueDates', value: true },
    });

    const noop = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Keep fri renamed' },
    });
    expect(noop.statusCode).toBe(200);
    expect(noop.json().dueDate).toBe(fri);
  });

  it('recurrence spawn rolls due when rollOffdayDueDates ON', async () => {
    await prisma.instanceSetting.createMany({
      data: [
        { key: 'calendar.weekend', value: [4, 5] },
        { key: 'scheduling.rollOffdayDueDates', value: true },
      ],
    });
    const { token, teamId, projectId } = await setupAdmin();
    const task = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Recurring' },
    });
    const taskId = task.json().id as string;
    // Spawn on Thu Jun 4 2026 with due offset 1 → Fri Jun 5 (off) → Sat Jun 6
    await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/recurrence`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        frequency: 'DAILY',
        interval: 1,
        startsOn: utcIso(2026, 6, 4),
        dueOffsetDays: 1,
        active: true,
      },
    });

    const svc = new TaskTemplatesService();
    await prisma.taskTemplate.updateMany({
      data: { nextRunAt: new Date(Date.UTC(2026, 5, 4)) },
    });
    await svc.spawnDue(new Date(Date.UTC(2026, 5, 5)));

    const spawned = await prisma.task.findMany({
      where: { spawnedFromTemplateId: { not: null } },
    });
    expect(spawned.length).toBe(1);
    expect(spawned[0]!.dueDate!.toISOString()).toBe(utcIso(2026, 6, 6));
    expect(spawned[0]!.spawnedForPeriod).toBe('2026-06-04');
  });

  it('workingDaysOnly ON: gantt row reports working-day count', async () => {
    await prisma.instanceSetting.createMany({
      data: [
        { key: 'calendar.weekend', value: [0, 6] },
        { key: 'scheduling.workingDaysOnly', value: true },
      ],
    });
    const { token, teamId, projectId } = await setupAdmin();
    const task = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Gantt task' },
    });
    const taskId = task.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/subtasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'Sub',
        startDate: utcIso(2026, 6, 8),
        endDate: utcIso(2026, 6, 12),
      },
    });

    const gantt = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${projectId}/reports/gantt`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(gantt.statusCode).toBe(200);
    expect(gantt.json().workingDaysOnly).toBe(true);
    expect(gantt.json().rows[0].workingDayCount).toBe(5);
  });

  it('system/info exposes scheduling flags (default false)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/info' });
    expect(res.statusCode).toBe(200);
    expect(res.json().schedulingRollOffdayDueDates).toBe(false);
    expect(res.json().schedulingWorkingDaysOnly).toBe(false);
  });
});
