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
  await prisma.projectLabel.deleteMany();
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

async function setupTeam(slug = 'pl-team') {
  const { token, userId } = await bootstrapUser(app, {
    email: 'owner@example.com',
    name: 'Owner',
    password: PASSWORD,
  });
  const team = (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Team', slug },
    })
  ).json();
  return { token, teamId: team.id as string, userId };
}

async function createLabel(token: string, teamId: string, name: string, color = '#ff0000') {
  return (
    await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/labels`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name, color },
    })
  ).json() as { id: string; name: string; color: string };
}

describe('project labels', () => {
  it('creates a project with labels and returns them on list', async () => {
    const { token, teamId } = await setupTeam();
    const bug = await createLabel(token, teamId, 'bug', '#ff0000');
    const feat = await createLabel(token, teamId, 'feature', '#00aa00');

    const created = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Labeled', labelIds: [bug.id, feat.id] },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { labels: Array<{ name: string }> };
    expect(body.labels.map((l) => l.name).sort()).toEqual(['bug', 'feature']);

    const list = await inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${token}` },
    });
    const row = (list.json() as Array<{ name: string; labels: Array<{ name: string }> }>).find(
      (p) => p.name === 'Labeled',
    )!;
    expect(row.labels).toHaveLength(2);
  });

  it('PATCH replaces the label set (add/remove)', async () => {
    const { token, teamId } = await setupTeam('pl-replace');
    const a = await createLabel(token, teamId, 'a');
    const b = await createLabel(token, teamId, 'b');
    const c = await createLabel(token, teamId, 'c');

    const proj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${teamId}/projects`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Swap', labelIds: [a.id, b.id] },
      })
    ).json() as { id: string };

    const patch = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { labelIds: [b.id, c.id] },
    });
    expect(patch.statusCode).toBe(200);
    const names = (patch.json() as { labels: Array<{ name: string }> }).labels.map((l) => l.name).sort();
    expect(names).toEqual(['b', 'c']);
  });

  it('rejects labels from another team with 400', async () => {
    const a = await setupTeam('pl-team-a');
    const regB = await bootstrapUser(app, {
      email: 'pl-other@example.com',
      name: 'Other',
      password: PASSWORD,
    });
    const teamB = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${regB.token}` },
        payload: { name: 'B', slug: 'pl-team-b' },
      })
    ).json();
    const foreign = await createLabel(regB.token, teamB.id as string, 'foreign');

    const res = await inject({
      method: 'POST',
      url: `/api/teams/${a.teamId}/projects`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { name: 'Bad labels', labelIds: [foreign.id] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('existing projects without labels return an empty array', async () => {
    const { token, teamId } = await setupTeam('pl-empty');
    await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Plain' },
    });

    const list = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json()[0].labels).toEqual([]);
  });

  it('deleting a label removes it from projects but keeps the project', async () => {
    const { token, teamId } = await setupTeam('pl-cascade');
    const tag = await createLabel(token, teamId, 'temp');
    const proj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${teamId}/projects`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Keep me', labelIds: [tag.id] },
      })
    ).json() as { id: string };

    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/labels/${tag.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);

    const get = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().labels).toHaveLength(0);
    expect(get.json().name).toBe('Keep me');
  });

  it('task labels are unaffected by project label assignment', async () => {
    const { token, teamId } = await setupTeam('pl-task-ok');
    const tag = await createLabel(token, teamId, 'shared');
    const project = (
      await inject({
        method: 'POST',
        url: `/api/teams/${teamId}/projects`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'P', labelIds: [tag.id] },
      })
    ).json() as { id: string };
    const task = (
      await inject({
        method: 'POST',
        url: `/api/teams/${teamId}/projects/${project.id}/tasks`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'T' },
      })
    ).json() as { id: string };

    await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${project.id}/tasks/${task.id}/labels`,
      headers: { authorization: `Bearer ${token}` },
      payload: { labelId: tag.id },
    });

    const tasks = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(tasks.json()[0].labels).toHaveLength(1);
    expect(tasks.json()[0].labels[0].name).toBe('shared');
  });
});
