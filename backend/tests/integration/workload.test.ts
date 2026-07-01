import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';
import {
  classifyWorkloadDueBucket,
  getDueWindowBounds,
} from '../../src/lib/workloadAggregation.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';

  app = await buildApp(loadEnv());
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

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';
const MS_DAY = 24 * 60 * 60 * 1000;

async function setupWithSlug(slug: string, globalRole?: 'ADMIN' | 'MEMBER') {
  const owner = await bootstrapUser(app, {
    email: `${slug}-owner@test.local`,
    name: 'Owner',
    password: PASSWORD,
    globalRole,
  });
  const member = await bootstrapUser(app, {
    email: `${slug}-member@test.local`,
    name: 'Member',
    password: PASSWORD,
  });
  const team = (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: `Team ${slug}`, slug },
    })
  ).json() as { id: string };

  await inject({
    method: 'POST',
    url: `/api/teams/${team.id}/members`,
    headers: { authorization: `Bearer ${owner.token}` },
    payload: { email: member.email, role: 'MEMBER' },
  });

  const projectA = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'Alpha' },
    })
  ).json() as { id: string };

  const projectB = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'Beta' },
    })
  ).json() as { id: string };

  return { owner, member, teamId: team.id, projectA, projectB };
}

async function setup() {
  return setupWithSlug('wl-team');
}

describe('GET /api/teams/:teamId/reports/workload/detail', () => {
  it('per-member open-task counts match raw task data', async () => {
    const { owner, member, teamId, projectA } = await setup();

    await prisma.task.createMany({
      data: [
        {
          teamId,
          projectId: projectA.id,
          title: 'T1',
          status: 'TODO',
          assigneeId: member.userId,
        },
        {
          teamId,
          projectId: projectA.id,
          title: 'T2',
          status: 'IN_PROGRESS',
          assigneeId: member.userId,
        },
        {
          teamId,
          projectId: projectA.id,
          title: 'T3',
          status: 'REVIEW',
          assigneeId: owner.userId,
        },
      ],
    });

    const rawOpen = await prisma.task.count({
      where: { teamId, status: { in: ['TODO', 'IN_PROGRESS', 'REVIEW'] }, deletedAt: null },
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/workload/detail`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { total: number }[] };
    const sum = body.items.reduce((s, r) => s + r.total, 0);
    expect(sum).toBe(rawOpen);

    const memberRow = body.items.find((r) => r.total === 2);
    expect(memberRow).toBeDefined();
  });

  it('due-bucket split is correct', async () => {
    const { owner, member, teamId, projectA } = await setup();
    const { todayStart, thisWeekEnd, nextWeekEnd } = getDueWindowBounds();

    await prisma.task.createMany({
      data: [
        {
          teamId,
          projectId: projectA.id,
          title: 'Overdue',
          status: 'TODO',
          assigneeId: member.userId,
          dueDate: new Date(todayStart.getTime() - MS_DAY),
        },
        {
          teamId,
          projectId: projectA.id,
          title: 'This week',
          status: 'TODO',
          assigneeId: member.userId,
          dueDate: new Date(todayStart.getTime() + MS_DAY),
        },
        {
          teamId,
          projectId: projectA.id,
          title: 'Next week',
          status: 'TODO',
          assigneeId: member.userId,
          dueDate: new Date(thisWeekEnd.getTime() + MS_DAY),
        },
        {
          teamId,
          projectId: projectA.id,
          title: 'Later',
          status: 'TODO',
          assigneeId: member.userId,
          dueDate: new Date(nextWeekEnd.getTime() + MS_DAY),
        },
        {
          teamId,
          projectId: projectA.id,
          title: 'No due',
          status: 'TODO',
          assigneeId: member.userId,
          dueDate: null,
        },
      ],
    });

    expect(classifyWorkloadDueBucket(new Date(todayStart.getTime() - MS_DAY))).toBe('overdue');
    expect(classifyWorkloadDueBucket(new Date(todayStart.getTime() + MS_DAY))).toBe('this_week');
    expect(classifyWorkloadDueBucket(new Date(thisWeekEnd.getTime() + MS_DAY))).toBe('next_week');
    expect(classifyWorkloadDueBucket(new Date(nextWeekEnd.getTime() + MS_DAY))).toBe('later');
    expect(classifyWorkloadDueBucket(null)).toBe('no_due');

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/workload/detail`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    const row = (res.json() as { items: { byDueBucket: Record<string, number> }[] }).items.find(
      (r) => r.byDueBucket.overdue === 1,
    );
    expect(row?.byDueBucket).toMatchObject({
      overdue: 1,
      this_week: 1,
      next_week: 1,
      later: 1,
      no_due: 1,
    });
  });

  it('project filter and window filter scope correctly', async () => {
    const { owner, member, teamId, projectA, projectB } = await setup();
    const { todayStart, thisWeekEnd } = getDueWindowBounds();

    await prisma.task.createMany({
      data: [
        {
          teamId,
          projectId: projectA.id,
          title: 'A this week',
          status: 'TODO',
          assigneeId: member.userId,
          dueDate: new Date(todayStart.getTime() + MS_DAY),
        },
        {
          teamId,
          projectId: projectB.id,
          title: 'B this week',
          status: 'TODO',
          assigneeId: member.userId,
          dueDate: new Date(todayStart.getTime() + MS_DAY),
        },
        {
          teamId,
          projectId: projectA.id,
          title: 'A next week',
          status: 'TODO',
          assigneeId: member.userId,
          dueDate: new Date(thisWeekEnd.getTime() + MS_DAY),
        },
      ],
    });

    const byProject = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/workload/detail?projectId=${projectA.id}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(
      (byProject.json() as { items: { total: number }[] }).items.reduce((s, r) => s + r.total, 0),
    ).toBe(2);

    const thisWeek = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/workload/detail?window=this_week`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(
      (thisWeek.json() as { items: { total: number }[] }).items.reduce((s, r) => s + r.total, 0),
    ).toBe(2);
  });

  it('weighted toggle changes totals by priority weight', async () => {
    const { owner, member, teamId, projectA } = await setup();

    await prisma.task.createMany({
      data: [
        {
          teamId,
          projectId: projectA.id,
          title: 'Low',
          status: 'TODO',
          priority: 'LOW',
          assigneeId: member.userId,
        },
        {
          teamId,
          projectId: projectA.id,
          title: 'Urgent',
          status: 'TODO',
          priority: 'URGENT',
          assigneeId: member.userId,
        },
      ],
    });

    const plain = (
      await inject({
        method: 'GET',
        url: `/api/teams/${teamId}/reports/workload/detail`,
        headers: { authorization: `Bearer ${owner.token}` },
      })
    ).json() as { items: { weightedTotal: number; total: number }[] };
    const weighted = (
      await inject({
        method: 'GET',
        url: `/api/teams/${teamId}/reports/workload/detail?weighted=true`,
        headers: { authorization: `Bearer ${owner.token}` },
      })
    ).json() as { items: { weightedTotal: number; total: number }[] };

    const plainRow = plain.items.find((r) => r.total === 2)!;
    const weightedRow = weighted.items.find((r) => r.total === 2)!;
    expect(plainRow.weightedTotal).toBe(2);
    expect(weightedRow.weightedTotal).toBe(5);
  });

  it('existing /reports/workload and workload.csv unchanged', async () => {
    const { owner, member, teamId, projectA } = await setup();

    await prisma.task.create({
      data: {
        teamId,
        projectId: projectA.id,
        title: 'Open',
        status: 'TODO',
        assigneeId: member.userId,
      },
    });

    const json = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/workload`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(json.statusCode).toBe(200);
    expect((json.json() as { items: unknown[] }).items).toHaveLength(1);

    const csv = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/workload.csv`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('assignee_name');
    expect(csv.body).toContain('total');
  });

  it('cross-team isolation holds', async () => {
    const a = await setupWithSlug('wl-a', 'MEMBER');
    const b = await setupWithSlug('wl-b', 'MEMBER');

    await prisma.task.create({
      data: {
        teamId: b.teamId,
        projectId: b.projectA.id,
        title: 'Secret',
        status: 'TODO',
        assigneeId: b.member.userId,
      },
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${a.teamId}/reports/workload/detail`,
      headers: { authorization: `Bearer ${a.owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toHaveLength(0);

    const forbidden = await inject({
      method: 'GET',
      url: `/api/teams/${b.teamId}/reports/workload/detail`,
      headers: { authorization: `Bearer ${a.owner.token}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe('GET /api/teams/:teamId/reports/workload/detail?loadBy=subtasks', () => {
  it('counts open vs done subtasks per responsible member', async () => {
    const { owner, member, teamId, projectA } = await setup();

    const task = await prisma.task.create({
      data: { teamId, projectId: projectA.id, title: 'Parent', status: 'IN_PROGRESS' },
    });

    await prisma.subtask.createMany({
      data: [
        { taskId: task.id, title: 'S1', status: 'NOT_STARTED', responsibleId: member.userId },
        { taskId: task.id, title: 'S2', status: 'IN_PROGRESS', responsibleId: member.userId },
        { taskId: task.id, title: 'S3', status: 'DONE', responsibleId: member.userId },
        { taskId: task.id, title: 'S4', status: 'DONE', responsibleId: owner.userId },
      ],
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/workload/detail?loadBy=subtasks`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      loadBy: string;
      items: { userId: string | null; openSubtasks: number; doneSubtasks: number; total: number }[];
    };
    expect(body.loadBy).toBe('subtasks');

    const memberRow = body.items.find((r) => r.userId === member.userId);
    expect(memberRow).toMatchObject({ openSubtasks: 2, doneSubtasks: 1, total: 3 });

    const ownerRow = body.items.find((r) => r.userId === owner.userId);
    expect(ownerRow).toMatchObject({ openSubtasks: 0, doneSubtasks: 1, total: 1 });
  });

  it('projectId filter scopes to that project only', async () => {
    const { owner, member, teamId, projectA, projectB } = await setup();

    const taskA = await prisma.task.create({
      data: { teamId, projectId: projectA.id, title: 'In A', status: 'TODO' },
    });
    const taskB = await prisma.task.create({
      data: { teamId, projectId: projectB.id, title: 'In B', status: 'TODO' },
    });

    await prisma.subtask.create({
      data: { taskId: taskA.id, title: 'Sub A', status: 'NOT_STARTED', responsibleId: member.userId },
    });
    await prisma.subtask.create({
      data: { taskId: taskB.id, title: 'Sub B', status: 'NOT_STARTED', responsibleId: member.userId },
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/workload/detail?loadBy=subtasks&projectId=${projectA.id}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { total: number }[] };
    expect(body.items.reduce((s, r) => s + r.total, 0)).toBe(1);
  });

  it('excludes subtasks whose parent task is soft-deleted', async () => {
    const { owner, member, teamId, projectA } = await setup();

    const task = await prisma.task.create({
      data: { teamId, projectId: projectA.id, title: 'Deleted parent', status: 'TODO', deletedAt: new Date() },
    });
    await prisma.subtask.create({
      data: { taskId: task.id, title: 'Sub', status: 'NOT_STARTED', responsibleId: member.userId },
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/workload/detail?loadBy=subtasks`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('cross-team isolation holds for subtask mode', async () => {
    const a = await setupWithSlug('wl-sub-a', 'MEMBER');
    const b = await setupWithSlug('wl-sub-b', 'MEMBER');

    const taskB = await prisma.task.create({
      data: { teamId: b.teamId, projectId: b.projectA.id, title: 'B task', status: 'TODO' },
    });
    await prisma.subtask.create({
      data: { taskId: taskB.id, title: 'B sub', status: 'NOT_STARTED', responsibleId: b.member.userId },
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${a.teamId}/reports/workload/detail?loadBy=subtasks`,
      headers: { authorization: `Bearer ${a.owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toHaveLength(0);
  });
});
