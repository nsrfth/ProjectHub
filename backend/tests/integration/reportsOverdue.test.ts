import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v2.20.3 regression: the Dashboard "Overdue" KPI (GET /reports/summary) and
// its drill-down list (GET /reports/overdue) must agree with the task lists the
// SPA renders. Two ways they used to disagree:
//   1. dueDate is a UTC-midnight *calendar date*, so `dueDate < now` counted
//      everything due TODAY as late — the card said 1, the modal said 0.
//   2. soft-deleted (trashed) tasks were counted; every task list filters them.

let app: FastifyInstance;

beforeAll(async () => {
  const env = loadEnv();
  app = await buildApp(env);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';
const MS_DAY = 86_400_000;

function utcMidnight(offsetDays = 0): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + offsetDays * MS_DAY);
}

async function setupTeam(): Promise<{ token: string; teamId: string; projectId: string; userId: string }> {
  const reg = await bootstrapUser(app, { email: 'owner@example.com', name: 'Owner', password: PASSWORD });
  const team = (
    await app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${reg.token}` },
      payload: { name: 'OverdueTeam', slug: 'overdue-team' },
    })
  ).json();
  const project = (
    await app.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${reg.token}` },
      payload: { name: 'P' },
    })
  ).json();
  return { token: reg.token, teamId: team.id, projectId: project.id, userId: reg.userId };
}

async function makeTask(
  ctx: { teamId: string; projectId: string; userId: string },
  title: string,
  data: { dueDate?: Date | null; deletedAt?: Date | null; status?: 'TODO' | 'DONE' } = {},
) {
  return prisma.task.create({
    data: {
      projectId: ctx.projectId,
      teamId: ctx.teamId,
      creatorId: ctx.userId,
      title,
      status: data.status ?? 'TODO',
      dueDate: data.dueDate ?? null,
      deletedAt: data.deletedAt ?? null,
    },
  });
}

async function readSummary(token: string, teamId: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/teams/${teamId}/reports/summary`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function readOverdue(token: string, teamId: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/teams/${teamId}/reports/overdue`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json().items as Array<{ taskTitle: string }>;
}

describe('overdue reporting — calendar-date boundary', () => {
  it('does not count a task due today as overdue', async () => {
    const ctx = await setupTeam();
    await makeTask(ctx, 'due today', { dueDate: utcMidnight(0) });

    expect((await readSummary(ctx.token, ctx.teamId)).overdueCount).toBe(0);
    expect(await readOverdue(ctx.token, ctx.teamId)).toHaveLength(0);
  });

  it('counts a task due yesterday, and the card agrees with the list', async () => {
    const ctx = await setupTeam();
    await makeTask(ctx, 'due yesterday', { dueDate: utcMidnight(-1) });
    await makeTask(ctx, 'due today', { dueDate: utcMidnight(0) });
    await makeTask(ctx, 'due tomorrow', { dueDate: utcMidnight(1) });
    await makeTask(ctx, 'no due date');

    const summary = await readSummary(ctx.token, ctx.teamId);
    const items = await readOverdue(ctx.token, ctx.teamId);
    expect(summary.overdueCount).toBe(1);
    expect(items.map((i) => i.taskTitle)).toEqual(['due yesterday']);
    expect(summary.overdueCount).toBe(items.length);
  });

  it('ignores a past-due task that is already DONE', async () => {
    const ctx = await setupTeam();
    await makeTask(ctx, 'late but done', { dueDate: utcMidnight(-3), status: 'DONE' });

    expect((await readSummary(ctx.token, ctx.teamId)).overdueCount).toBe(0);
    expect(await readOverdue(ctx.token, ctx.teamId)).toHaveLength(0);
  });
});

describe('overdue reporting — trashed tasks', () => {
  it('excludes soft-deleted tasks from the overdue count, the list and openCount', async () => {
    const ctx = await setupTeam();
    await makeTask(ctx, 'trashed and late', { dueDate: utcMidnight(-2), deletedAt: new Date() });
    await makeTask(ctx, 'live and late', { dueDate: utcMidnight(-2) });

    const summary = await readSummary(ctx.token, ctx.teamId);
    const items = await readOverdue(ctx.token, ctx.teamId);
    expect(summary.overdueCount).toBe(1);
    expect(summary.openCount).toBe(1);
    expect(summary.byStatus.TODO).toBe(1);
    expect(items.map((i) => i.taskTitle)).toEqual(['live and late']);
  });
});
