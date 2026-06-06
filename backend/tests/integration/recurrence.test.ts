import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { TaskTemplatesService } from '../../src/services/taskTemplatesService.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// Phase 4 coverage: PUT/GET the rule, spawnDue idempotency, label/subtask
// copy, WEEKLY byWeekday math, endsOn + maxCount termination.

let app: FastifyInstance;

beforeAll(async () => {
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.taskTemplate.deleteMany();
  await prisma.task.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function setup(): Promise<{ token: string; userId: string; teamId: string; projectId: string }> {
  const reg = await bootstrapUser(app, { email: 'rec@example.com', name: 'Rec', password: PASSWORD });
  const token: string = reg.token;
  const userId: string = reg.userId;
  const team = await app.inject({
    method: 'POST', url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'rec-team', slug: 'rec-team' },
  });
  const teamId: string = team.json().id;
  const proj = await app.inject({
    method: 'POST', url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'P' },
  });
  return { token, userId, teamId, projectId: proj.json().id as string };
}

async function createTask(token: string, teamId: string, projectId: string, title: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title },
  });
  return res.json().id as string;
}

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

describe('Recurrence CRUD', () => {
  it('PUT then GET returns the same rule, with nextRunAt computed', async () => {
    const { token, teamId, projectId } = await setup();
    const taskId = await createTask(token, teamId, projectId, 'weekly standup');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/recurrence`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        frequency: 'DAILY',
        interval: 1,
        startsOn: new Date().toISOString(),
        active: true,
      },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json();
    expect(body.sourceTaskId).toBe(taskId);
    expect(body.frequency).toBe('DAILY');
    expect(body.nextRunAt).toBeTruthy();

    const get = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/recurrence`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().id).toBe(body.id);
  });

  it('GET returns 204 when no rule exists', async () => {
    const { token, teamId, projectId } = await setup();
    const taskId = await createTask(token, teamId, projectId, 'no-rule');
    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/recurrence`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('DELETE removes the rule but leaves spawned tasks', async () => {
    const { token, teamId, projectId } = await setup();
    const taskId = await createTask(token, teamId, projectId, 'recurring');
    // Set rule + manually spawn once by backdating nextRunAt.
    await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/recurrence`,
      headers: { authorization: `Bearer ${token}` },
      payload: { frequency: 'DAILY', interval: 1, startsOn: new Date().toISOString() },
    });
    await prisma.taskTemplate.updateMany({
      data: { nextRunAt: utcDate(2026, 1, 1) },
    });
    const svc = new TaskTemplatesService();
    expect(await svc.spawnDue(new Date())).toBe(1);

    // Delete the rule.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/recurrence`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
    expect(await prisma.taskTemplate.count()).toBe(0);
    // Spawned task survives (spawnedFromTemplateId is now null via SetNull).
    const remaining = await prisma.task.count();
    expect(remaining).toBe(2); // source + one spawn
  });
});

describe('spawnDue', () => {
  it('spawns once per period; re-running before nextRunAt is a no-op', async () => {
    const { token, teamId, projectId } = await setup();
    const sourceId = await createTask(token, teamId, projectId, 'cron-ish');
    await prisma.taskTemplate.create({
      data: {
        sourceTaskId: sourceId,
        frequency: 'DAILY', interval: 1, byWeekday: [],
        startsOn: utcDate(2026, 5, 20),
        nextRunAt: utcDate(2026, 5, 20),
      },
    });
    const svc = new TaskTemplatesService();
    const first = await svc.spawnDue(utcDate(2026, 5, 22));
    expect(first).toBe(1);
    const spawned = await prisma.task.findMany({ where: { spawnedFromTemplateId: { not: null } } });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.title).toBe('cron-ish');
    expect(spawned[0]!.status).toBe('TODO');
    expect(spawned[0]!.spawnedForPeriod).toBe('2026-05-20');

    // Template advanced.
    const t = (await prisma.taskTemplate.findFirst())!;
    expect(t.spawnedCount).toBe(1);
    expect(t.nextRunAt.toISOString().slice(0, 10)).toBe('2026-05-21');

    // Now tick again with a time before nextRunAt — no spawns.
    const second = await svc.spawnDue(utcDate(2026, 5, 20));
    expect(second).toBe(0);
    expect(await prisma.task.count({ where: { spawnedFromTemplateId: { not: null } } })).toBe(1);
  });

  it('copies labels and subtasks; never copies completedAt', async () => {
    const { token, teamId, projectId } = await setup();
    // Source task with a subtask + label.
    const sourceId = await createTask(token, teamId, projectId, 'with-extras');
    await prisma.subtask.create({ data: { taskId: sourceId, title: 'step 1', position: 0 } });
    const label = await prisma.label.create({ data: { teamId, name: 'priority', color: '#f00' } });
    await prisma.taskLabel.create({ data: { taskId: sourceId, labelId: label.id } });
    // Backdate the source's completedAt to test that it's not copied.
    await prisma.task.update({
      where: { id: sourceId },
      data: { completedAt: utcDate(2026, 5, 1), status: 'DONE' },
    });

    await prisma.taskTemplate.create({
      data: {
        sourceTaskId: sourceId, frequency: 'DAILY', interval: 1, byWeekday: [],
        startsOn: utcDate(2026, 5, 20), nextRunAt: utcDate(2026, 5, 20),
        dueOffsetDays: 2, plannedOffsetDays: 1,
      },
    });
    const svc = new TaskTemplatesService();
    await svc.spawnDue(utcDate(2026, 5, 22));

    const spawned = await prisma.task.findFirst({
      where: { spawnedFromTemplateId: { not: null } },
      include: { subtasks: true, labels: true },
    });
    expect(spawned).toBeTruthy();
    expect(spawned!.subtasks).toHaveLength(1);
    expect(spawned!.subtasks[0]!.title).toBe('step 1');
    expect(spawned!.subtasks[0]!.done).toBe(false);
    expect(spawned!.labels).toHaveLength(1);
    expect(spawned!.completedAt).toBeNull();
    expect(spawned!.status).toBe('TODO');
    // Offsets applied: spawn on 05-20, due +2 = 05-22, planned +1 = 05-21.
    expect(spawned!.dueDate?.toISOString().slice(0, 10)).toBe('2026-05-22');
    expect(spawned!.plannedDate?.toISOString().slice(0, 10)).toBe('2026-05-21');
  });

  it('WEEKLY byWeekday spawns only on the configured weekdays', async () => {
    const { token, teamId, projectId } = await setup();
    const sourceId = await createTask(token, teamId, projectId, 'weekday');
    // 2026-05-25 is a Monday (getUTCDay()=1). Set the rule to fire on Mon+Wed (1, 3).
    // Anchor the first nextRunAt to that Monday.
    await prisma.taskTemplate.create({
      data: {
        sourceTaskId: sourceId, frequency: 'WEEKLY', interval: 1, byWeekday: [1, 3],
        startsOn: utcDate(2026, 5, 25),
        nextRunAt: utcDate(2026, 5, 25),
      },
    });
    const svc = new TaskTemplatesService();
    // Tick well past the Wednesday — should spawn once for Monday only.
    await svc.spawnDue(utcDate(2026, 5, 26));
    let t = (await prisma.taskTemplate.findFirst())!;
    // After spawning Mon, nextRunAt advances to the next matching weekday — Wed.
    expect(t.nextRunAt.toISOString().slice(0, 10)).toBe('2026-05-27');
    expect(t.spawnedCount).toBe(1);

    // Tick past Wednesday — second spawn.
    await svc.spawnDue(utcDate(2026, 5, 28));
    t = (await prisma.taskTemplate.findFirst())!;
    expect(t.spawnedCount).toBe(2);
  });

  it('stops once maxCount is reached', async () => {
    const { token, teamId, projectId } = await setup();
    const sourceId = await createTask(token, teamId, projectId, 'capped');
    await prisma.taskTemplate.create({
      data: {
        sourceTaskId: sourceId, frequency: 'DAILY', interval: 1, byWeekday: [],
        startsOn: utcDate(2026, 5, 20), nextRunAt: utcDate(2026, 5, 20),
        maxCount: 2,
      },
    });
    const svc = new TaskTemplatesService();
    // First two ticks spawn.
    await svc.spawnDue(utcDate(2026, 5, 21));
    await svc.spawnDue(utcDate(2026, 5, 22));
    let count = await prisma.task.count({ where: { spawnedFromTemplateId: { not: null } } });
    expect(count).toBe(2);
    // Third tick: cap is hit, template gets deactivated, no new task.
    await svc.spawnDue(utcDate(2026, 5, 23));
    count = await prisma.task.count({ where: { spawnedFromTemplateId: { not: null } } });
    expect(count).toBe(2);
    const t = (await prisma.taskTemplate.findFirst())!;
    expect(t.active).toBe(false);
  });

  it('QUARTERLY advances by 3 months per occurrence', async () => {
    const { token, teamId, projectId } = await setup();
    const sourceId = await createTask(token, teamId, projectId, 'QBR');
    await prisma.taskTemplate.create({
      data: {
        sourceTaskId: sourceId, frequency: 'QUARTERLY', interval: 1, byWeekday: [],
        startsOn: utcDate(2026, 1, 1), nextRunAt: utcDate(2026, 1, 1),
      },
    });
    const svc = new TaskTemplatesService();
    await svc.spawnDue(utcDate(2026, 1, 2));
    let t = (await prisma.taskTemplate.findFirst())!;
    expect(t.spawnedCount).toBe(1);
    // Jan 1 + 3 months → Apr 1.
    expect(t.nextRunAt.toISOString().slice(0, 10)).toBe('2026-04-01');

    // Tick past Apr 1; second spawn moves to Jul 1.
    await svc.spawnDue(utcDate(2026, 4, 2));
    t = (await prisma.taskTemplate.findFirst())!;
    expect(t.spawnedCount).toBe(2);
    expect(t.nextRunAt.toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('stops at endsOn', async () => {
    const { token, teamId, projectId } = await setup();
    const sourceId = await createTask(token, teamId, projectId, 'until');
    await prisma.taskTemplate.create({
      data: {
        sourceTaskId: sourceId, frequency: 'DAILY', interval: 1, byWeekday: [],
        startsOn: utcDate(2026, 5, 20), nextRunAt: utcDate(2026, 5, 20),
        endsOn: utcDate(2026, 5, 21),
      },
    });
    const svc = new TaskTemplatesService();
    await svc.spawnDue(utcDate(2026, 5, 22));
    // Day 1 spawned (nextRunAt was 05-20 <= 05-21 endsOn).
    expect(await prisma.task.count({ where: { spawnedFromTemplateId: { not: null } } })).toBe(1);
    await svc.spawnDue(utcDate(2026, 5, 22));
    // Day 2 (nextRunAt=05-21): also within endsOn so it spawns.
    expect(await prisma.task.count({ where: { spawnedFromTemplateId: { not: null } } })).toBe(2);
    await svc.spawnDue(utcDate(2026, 5, 23));
    // Day 3: nextRunAt=05-22 > endsOn=05-21 → no spawn.
    expect(await prisma.task.count({ where: { spawnedFromTemplateId: { not: null } } })).toBe(2);
  });
});
