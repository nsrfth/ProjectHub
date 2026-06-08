import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.42: per-project Gantt report. Exercises the aggregation (summary +
// rows), the visibility cascade (non-owners 404), and the cross-task
// grouping (rows carry parentTaskTitle).

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
  await prisma.subtask.deleteMany();
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

async function bootAdmin(email = 'admin@example.com'): Promise<string> {
  // First-bootstrapped user is auto-promoted to ADMIN.
  return (await bootstrapUser(app, { email, name: 'Admin', password: PASSWORD })).token;
}

async function bootMember(email: string): Promise<{ token: string; userId: string }> {
  const r = await bootstrapUser(app, {
    email,
    name: email.split('@')[0],
    password: PASSWORD,
    globalRole: 'MEMBER',
  });
  return { token: r.token, userId: r.userId };
}

async function setup() {
  const adminToken = await bootAdmin();
  const team = (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'T', slug: 'gantt-team' },
    })
  ).json();
  const project = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Gantt P' },
    })
  ).json();
  return { adminToken, teamId: team.id as string, projectId: project.id as string };
}

describe('v1.42 Project Gantt report', () => {
  it('returns 0 totals + null earliest/latest on an empty project', async () => {
    const s = await setup();
    const res = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/reports/gantt`,
      headers: { authorization: `Bearer ${s.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projectId).toBe(s.projectId);
    expect(body.summary).toEqual({
      totalTasks: 0,
      totalSubtasks: 0,
      scheduledSubtasks: 0,
      unscheduledSubtasks: 0,
      earliestStart: null,
      latestEnd: null,
    });
    expect(body.rows).toEqual([]);
  });

  it('aggregates summary across scheduled + unscheduled subtasks and emits earliest/latest', async () => {
    const s = await setup();
    // Two tasks, each with one scheduled subtask + one unscheduled.
    const t1 = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
        headers: { authorization: `Bearer ${s.adminToken}` },
        payload: { title: 'Design phase' },
      })
    ).json();
    const t2 = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
        headers: { authorization: `Bearer ${s.adminToken}` },
        payload: { title: 'Build phase' },
      })
    ).json();
    // t1 subtask: scheduled Jun 1 → Jun 5.
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${t1.id}/subtasks`,
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: {
        title: 'wireframes',
        startDate: '2026-06-01T00:00:00.000Z',
        endDate: '2026-06-05T00:00:00.000Z',
      },
    });
    // t1 subtask: unscheduled.
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${t1.id}/subtasks`,
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: { title: 'review' },
    });
    // t2 subtask: scheduled Jun 10 → Jun 20. Should drive latestEnd.
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${t2.id}/subtasks`,
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: {
        title: 'implement',
        startDate: '2026-06-10T00:00:00.000Z',
        endDate: '2026-06-20T00:00:00.000Z',
      },
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/reports/gantt`,
      headers: { authorization: `Bearer ${s.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.totalTasks).toBe(2);
    expect(body.summary.totalSubtasks).toBe(3);
    expect(body.summary.scheduledSubtasks).toBe(2);
    expect(body.summary.unscheduledSubtasks).toBe(1);
    expect(body.summary.earliestStart).toBe('2026-06-01T00:00:00.000Z');
    expect(body.summary.latestEnd).toBe('2026-06-20T00:00:00.000Z');
    // Rows carry the parent task title for grouping client-side.
    expect(body.rows).toHaveLength(3);
    const wireframes = body.rows.find((r: { title: string }) => r.title === 'wireframes');
    expect(wireframes.parentTaskTitle).toBe('Design phase');
  });

  it('includes assignee + technician on each row when set', async () => {
    const s = await setup();
    const member = await bootMember('m@example.com');
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/members`,
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: { email: 'm@example.com', role: 'MEMBER' },
    });
    const t = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
        headers: { authorization: `Bearer ${s.adminToken}` },
        payload: { title: 'T' },
      })
    ).json();
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${t.id}/subtasks`,
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: { title: 'assigned', assigneeId: member.userId },
    });
    const res = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/reports/gantt`,
      headers: { authorization: `Bearer ${s.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().rows[0];
    expect(row.assigneeId).toBe(member.userId);
    expect(row.assigneeName).toBe('m');
    expect(row.technicianName).toBe('Admin'); // default-to-creator
  });

  it('cascades v1.39 visibility — non-owner MEMBER gets 404', async () => {
    const adminToken = await bootAdmin();
    const member = await bootMember('m2@example.com');
    const team = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'T', slug: 'gantt-cascade' },
      })
    ).json();
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { email: 'm2@example.com', role: 'MEMBER' },
    });
    const project = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Admins only' },
      })
    ).json();
    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/reports/gantt`,
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
