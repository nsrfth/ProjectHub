import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// Integration coverage for the CSV exports. Asserts on the headers
// (Content-Type, Content-Disposition) and on the body shape: BOM + CRLF
// rows + the column ordering declared by the controller.

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

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

async function setupTeam(): Promise<{ token: string; teamId: string; projectId: string; userId: string }> {
  const reg = await bootstrapUser(app, { email: 'owner@example.com', name: 'Owner', password: PASSWORD });
  const token = reg.token;
  const userId = reg.userId;
  const team = (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'CsvTeam', slug: 'csv-team' },
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
  return { token, teamId: team.id, projectId: project.id, userId };
}

describe('GET /api/teams/:teamId/reports/*.csv', () => {
  it('done.csv: returns text/csv with attachment headers and the documented columns', async () => {
    const { token, teamId, projectId, userId } = await setupTeam();
    // One task completed today so it lands in the 7-day window.
    await prisma.task.create({
      data: {
        projectId,
        teamId,
        creatorId: userId,
        assigneeId: userId,
        title: 'Wrote the thing',
        status: 'DONE',
        completedAt: new Date(),
      },
    });
    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/done.csv?days=7`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(String(res.headers['content-disposition'])).toMatch(
      /^attachment; filename="tasks-done-7d-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body;
    // BOM + header row, in column order from the controller.
    expect(body.startsWith('﻿task_id,task_title,project_id,project_name,assignee_id,assignee_name,completed_at\r\n')).toBe(true);
    expect(body).toMatch(/Wrote the thing/);
  });

  it('workload.csv: emits one row per assignee bucket including (unassigned) label', async () => {
    const { token, teamId, projectId, userId } = await setupTeam();
    await prisma.task.createMany({
      data: [
        { projectId, teamId, creatorId: userId, assigneeId: userId, title: 'mine', status: 'TODO' },
        { projectId, teamId, creatorId: userId, assigneeId: null, title: 'orphan', status: 'IN_PROGRESS' },
      ],
    });
    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/workload.csv`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    const body = res.body;
    expect(body).toMatch(/assignee_id,assignee_name,todo,in_progress,review,total/);
    expect(body).toMatch(/\(unassigned\)/);
  });

  it('overdue.csv: includes days_overdue column for past-due open tasks', async () => {
    const { token, teamId, projectId, userId } = await setupTeam();
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    await prisma.task.create({
      data: {
        projectId,
        teamId,
        creatorId: userId,
        title: 'late',
        status: 'TODO',
        dueDate: threeDaysAgo,
      },
    });
    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/overdue.csv`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toMatch(/task_id,task_title,project_id,project_name,status,assignee_id,assignee_name,due_date,days_overdue/);
    expect(body).toMatch(/late/);
    // 3 days late.
    expect(body).toMatch(/,3\r\n$/);
  });

  it('timeliness.csv: returns a one-row CSV with the documented metric columns', async () => {
    const { token, teamId } = await setupTeam();
    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/timeliness.csv?days=30`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toMatch(/window_days,evaluated_count,on_time_rate,avg_variance_days,behind_plan_count/);
    // Empty fixtures → 30,0,0,0,0
    expect(body).toMatch(/30,0,0,0,0\r\n$/);
  });

  it('requires authentication — 401 without a token', async () => {
    const { teamId } = await setupTeam();
    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/workload.csv`,
    });
    expect(res.statusCode).toBe(401);
  });
});
