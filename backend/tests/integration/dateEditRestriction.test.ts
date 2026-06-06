import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.18: instance-wide `tasks.dateEditRestriction` setting. When "manager-only":
//   - members can ADD a date to a task that has none (allowed)
//   - members CANNOT modify or clear an existing non-null date (403)
//   - team MANAGERS and global ADMINS bypass the rule
//   - non-date PATCHes (title, priority, …) are unaffected

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
  await prisma.instanceSetting.deleteMany();
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

async function setup() {
  // First bootstrapped user is auto-promoted to ADMIN.
  const adminReg = await bootstrapUser(app, { email: 'admin@example.com', name: 'Admin', password: PASSWORD });
  const adminToken = adminReg.token;

  // Second user is a plain MEMBER.
  const memberReg = await bootstrapUser(app, { email: 'member@example.com', name: 'Member', password: PASSWORD });
  const memberToken = memberReg.token;

  const team = await inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'T', slug: 'team-de' },
  });
  const teamId = team.json().id as string;

  await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { email: 'member@example.com', role: 'MEMBER' },
  });

  const project = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'P' },
  });
  const projectId = project.json().id as string;

  return { adminToken, memberToken, teamId, projectId };
}

async function enableManagerOnly(adminToken: string) {
  const res = await inject({
    method: 'PUT',
    url: '/api/settings/instance/tasks.dateEditRestriction',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { value: 'manager-only' },
  });
  expect(res.statusCode).toBe(200);
}

describe('tasks.dateEditRestriction', () => {
  it('default ("open") lets a MEMBER modify an existing dueDate', async () => {
    const { adminToken, memberToken, teamId, projectId } = await setup();
    const task = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'T1', dueDate: '2026-06-01T00:00:00.000Z' },
    });
    const taskId = task.json().id as string;

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { dueDate: '2026-06-10T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('manager-only: MEMBER can ADD a dueDate to a task that had none', async () => {
    const { adminToken, memberToken, teamId, projectId } = await setup();
    await enableManagerOnly(adminToken);

    const task = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'T1' }, // no dueDate
    });
    const taskId = task.json().id as string;

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { dueDate: '2026-06-01T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('manager-only: MEMBER CANNOT modify an existing dueDate (403)', async () => {
    const { adminToken, memberToken, teamId, projectId } = await setup();
    await enableManagerOnly(adminToken);

    const task = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'T1', dueDate: '2026-06-01T00:00:00.000Z' },
    });
    const taskId = task.json().id as string;

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { dueDate: '2026-06-10T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/dueDate/);
  });

  it('manager-only: MEMBER CANNOT clear an existing dueDate (403)', async () => {
    const { adminToken, memberToken, teamId, projectId } = await setup();
    await enableManagerOnly(adminToken);

    const task = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'T1', dueDate: '2026-06-01T00:00:00.000Z' },
    });
    const taskId = task.json().id as string;

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { dueDate: null },
    });
    expect(res.statusCode).toBe(403);
  });

  it('manager-only: global ADMIN can modify any date freely', async () => {
    const { adminToken, teamId, projectId } = await setup();
    await enableManagerOnly(adminToken);

    const task = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'T1', dueDate: '2026-06-01T00:00:00.000Z' },
    });
    const taskId = task.json().id as string;

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { dueDate: '2026-06-30T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('manager-only: non-date PATCHes (title, priority) still work for members', async () => {
    const { adminToken, memberToken, teamId, projectId } = await setup();
    await enableManagerOnly(adminToken);

    const task = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'T1', dueDate: '2026-06-01T00:00:00.000Z' },
    });
    const taskId = task.json().id as string;

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { title: 'Renamed', priority: 'HIGH' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Renamed');
  });
});

describe('/api/system/info dateEditRestriction', () => {
  it('returns "open" by default (no instance setting written)', async () => {
    const res = await inject({ method: 'GET', url: '/api/system/info' });
    expect(res.statusCode).toBe(200);
    expect(res.json().dateEditRestriction).toBe('open');
  });

  it('returns "manager-only" once the admin opted in', async () => {
    const reg = await bootstrapUser(app, { email: 'a@example.com', name: 'A', password: PASSWORD });
    await enableManagerOnly(reg.token);
    const res = await inject({ method: 'GET', url: '/api/system/info' });
    expect(res.json().dateEditRestriction).toBe('manager-only');
  });
});
