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
  // TaskLabel + Label cascade from Task / Team respectively; clearing tasks
  // and teams covers both — but be explicit so a future schema change can't
  // silently leak rows between tests.
  await prisma.taskLabel.deleteMany();
  await prisma.label.deleteMany();
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

async function setup(slug = 'team-l') {
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

describe('POST /api/teams/:teamId/labels', () => {
  it('creates a label and rejects duplicate names within the team', async () => {
    const s = await setup();
    const r1 = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { name: 'bug', color: '#ff0000' },
    });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().name).toBe('bug');

    const r2 = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { name: 'bug', color: '#0000ff' },
    });
    expect(r2.statusCode).toBe(409);
  });

  it('allows the same label name in a different team', async () => {
    const s = await setup('team-l-a');
    // Second team owned by the same user with a different slug.
    const teamB = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'B', slug: 'team-l-b' },
      })
    ).json();

    const r1 = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { name: 'bug', color: '#ff0000' },
    });
    const r2 = await inject({
      method: 'POST',
      url: `/api/teams/${teamB.id}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { name: 'bug', color: '#00ff00' },
    });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
  });

  it('rejects bad color', async () => {
    const s = await setup();
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { name: 'bug', color: 'red' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('attach/detach', () => {
  it('attaches a label to a task and surfaces it in task response', async () => {
    const s = await setup();
    const label = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/labels`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'urgent', color: '#ff8800' },
      })
    ).json();

    const att = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelId: label.id },
    });
    expect(att.statusCode).toBe(201);

    // Task GET (via list endpoint) should include the label.
    const list = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    const t = list.json().find((x: { id: string }) => x.id === s.taskId);
    expect(t.labels).toHaveLength(1);
    expect(t.labels[0].name).toBe('urgent');
  });

  it('attach is idempotent — second attach returns 201 with same label', async () => {
    const s = await setup();
    const label = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/labels`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'x', color: '#111111' },
      })
    ).json();
    const a1 = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelId: label.id },
    });
    const a2 = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelId: label.id },
    });
    expect(a1.statusCode).toBe(201);
    expect(a2.statusCode).toBe(201);
    expect(a2.json().id).toBe(label.id);
  });

  it('detach removes the label and the task response no longer carries it', async () => {
    const s = await setup();
    const label = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/labels`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'tmp', color: '#222222' },
      })
    ).json();
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelId: label.id },
    });

    const det = await inject({
      method: 'DELETE',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels/${label.id}`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(det.statusCode).toBe(204);

    const list = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    const t = list.json().find((x: { id: string }) => x.id === s.taskId);
    expect(t.labels).toHaveLength(0);
  });

  it('returns 404 when attaching a label that belongs to a different team', async () => {
    const s = await setup('team-l-a');
    // Second team and a label inside it.
    const teamB = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'B', slug: 'team-l-b' },
      })
    ).json();
    const labelB = (
      await inject({
        method: 'POST',
        url: `/api/teams/${teamB.id}/labels`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'b-only', color: '#abcabc' },
      })
    ).json();
    // Attempt to attach team-B's label to a task in team-A.
    const att = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelId: labelB.id },
    });
    expect(att.statusCode).toBe(404);
  });
});

describe('DELETE /api/teams/:teamId/labels/:labelId', () => {
  it('cascade-detaches the label from every task it was on', async () => {
    const s = await setup();
    const label = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/labels`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'temp', color: '#abcdef' },
      })
    ).json();
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelId: label.id },
    });
    // Deleting the label should detach it everywhere.
    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${s.teamId}/labels/${label.id}`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(del.statusCode).toBe(204);

    const list = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(list.json()[0].labels).toHaveLength(0);
  });
});
