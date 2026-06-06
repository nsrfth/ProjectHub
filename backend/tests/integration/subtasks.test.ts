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
  // Subtask cascades from Task; clearing tasks also clears subtasks. Being
  // explicit so a future schema change can't silently change behavior.
  await prisma.subtask.deleteMany();
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

async function setup(slug = 'team-s') {
  const { token } = await bootstrapUser(app, { email: 'a@example.com', name: 'Alice', password: PASSWORD });
  const team = (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'T', slug },
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
      payload: { title: 'T' },
    })
  ).json();
  return { token, teamId: team.id, projectId: project.id, taskId: task.id };
}

describe('POST /api/.../tasks/:taskId/subtasks', () => {
  it('creates a subtask with done=false by default', async () => {
    const s = await setup();
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'spec it' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.title).toBe('spec it');
    expect(body.done).toBe(false);
    expect(body.position).toBeGreaterThan(0);
  });

  it('appends with monotonically increasing positions', async () => {
    const s = await setup();
    const a = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'A' },
    });
    const b = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'B' },
    });
    expect(b.json().position).toBeGreaterThan(a.json().position);
  });

  it('returns 404 when the task belongs to a different project', async () => {
    const s = await setup();
    const otherProject = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'P2' },
      })
    ).json();
    // Use s.taskId (project P) under otherProject's URL — should 404.
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${otherProject.id}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'misplaced' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/.../subtasks/:subtaskId', () => {
  it('toggles done', async () => {
    const s = await setup();
    const sub = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'toggle me' },
      })
    ).json();
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks/${sub.id}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { done: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().done).toBe(true);
  });

  it('returns 404 when the subtask belongs to a different task', async () => {
    const s = await setup();
    // Make a second task and a subtask on it.
    const otherTask = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'other' },
      })
    ).json();
    const otherSub = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${otherTask.id}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'belongs to other' },
      })
    ).json();
    // Patch otherSub's id but under s.taskId's URL — should 404.
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks/${otherSub.id}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { done: true },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('task response carries subtasks[] ordered by position', () => {
  it('lists tasks with their subtasks attached in position order', async () => {
    const s = await setup();
    // Add three subtasks; the third is marked done at create.
    const titles = ['first', 'second', 'third'];
    for (let i = 0; i < titles.length; i++) {
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: titles[i], done: i === 2 },
      });
    }
    const list = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    const t = list.json().find((x: { id: string }) => x.id === s.taskId);
    expect(t.subtasks).toHaveLength(3);
    expect(t.subtasks.map((sub: { title: string }) => sub.title)).toEqual(['first', 'second', 'third']);
    expect(t.subtasks[2].done).toBe(true);
  });
});

describe('DELETE /api/.../subtasks/:subtaskId', () => {
  it('removes the subtask', async () => {
    const s = await setup();
    const sub = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'remove me' },
      })
    ).json();
    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks/${sub.id}`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(del.statusCode).toBe(204);

    const list = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    const t = list.json().find((x: { id: string }) => x.id === s.taskId);
    expect(t.subtasks).toHaveLength(0);
  });
});
