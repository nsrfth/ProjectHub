import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
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

async function setup() {
  const { token } = await bootstrapUser(app, {
    email: 'a@example.com',
    name: 'Alice',
    password: PASSWORD,
  });

  const team = (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'T', slug: 'team-t' },
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
      payload: { title: 'Original' },
    })
  ).json();
  return { token, teamId: team.id, projectId: project.id, taskId: task.id };
}

async function listActivity(token: string, teamId: string, projectId: string, taskId: string) {
  const res = await inject({
    method: 'GET',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/activity`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Array<{ action: string; meta: unknown }>;
}

describe('activity log', () => {
  it('records task.created on task creation', async () => {
    const s = await setup();
    const activity = await listActivity(s.token, s.teamId, s.projectId, s.taskId);
    const created = activity.find((a) => a.action === 'task.created');
    expect(created).toBeTruthy();
    expect((created!.meta as { title: string }).title).toBe('Original');
  });

  it('emits task.status_changed but not task.updated when only status changes', async () => {
    const s = await setup();
    await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { status: 'IN_PROGRESS' },
    });
    const activity = await listActivity(s.token, s.teamId, s.projectId, s.taskId);
    const status = activity.find((a) => a.action === 'task.status_changed');
    const updated = activity.find((a) => a.action === 'task.updated');
    expect(status).toBeTruthy();
    expect(updated).toBeUndefined();
    expect((status!.meta as { from: string; to: string }).from).toBe('TODO');
    expect((status!.meta as { from: string; to: string }).to).toBe('IN_PROGRESS');
  });

  it('emits task.updated with the list of changed fields when non-status fields change', async () => {
    const s = await setup();
    await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'New name', priority: 'HIGH' },
    });
    const activity = await listActivity(s.token, s.teamId, s.projectId, s.taskId);
    const updated = activity.find((a) => a.action === 'task.updated');
    expect(updated).toBeTruthy();
    const fields = (updated!.meta as { fields: string[] }).fields;
    expect(fields).toContain('title');
    expect(fields).toContain('priority');
  });

  it('does not emit anything for a no-op PATCH (same values)', async () => {
    const s = await setup();
    const beforeCount = (await listActivity(s.token, s.teamId, s.projectId, s.taskId)).length;
    await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'Original' }, // same as initial
    });
    const after = await listActivity(s.token, s.teamId, s.projectId, s.taskId);
    expect(after.length).toBe(beforeCount);
  });

  it('records comment.added when a comment is created', async () => {
    const s = await setup();
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/comments`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { body: 'first comment' },
    });
    const activity = await listActivity(s.token, s.teamId, s.projectId, s.taskId);
    const commented = activity.find((a) => a.action === 'comment.added');
    expect(commented).toBeTruthy();
    expect((commented!.meta as { excerpt: string }).excerpt).toBe('first comment');
  });

  it('returns newest first', async () => {
    const s = await setup();
    await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { status: 'DONE' },
    });
    const activity = await listActivity(s.token, s.teamId, s.projectId, s.taskId);
    expect(activity[0].action).toBe('task.status_changed');
    expect(activity[activity.length - 1].action).toBe('task.created');
  });
});
